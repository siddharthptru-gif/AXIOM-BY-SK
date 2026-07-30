import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { rootLogger } from '@axiom/shared';
import {
  directoryNameFor,
  emptyMarketplaceState,
  planUpdates,
  resolveInstallOrder,
  resolveMarketplaceEnablement,
  sanitizeMarketplaceState,
  type DependencyGraph,
  type HostConsent,
  type InstallIntegrity,
  type InstallOutcome,
  type InstallRecord,
  type InstallSource,
  type InstalledExtensionDetail,
  type InstalledExtensionSummary,
  type MarketplaceState,
  type UpdateAllOutcome,
  type UpdatePlanEntry,
} from '../../common/marketplace';
import {
  AXIOM_VSCODE_API_VERSION,
  parseVsCodeManifest,
  reportCapabilities,
  reportCompatibility,
  type VsCodeManifest,
} from '../../common/vscodeManifest';
import { compareVersions } from '../../common/extensionRegistryIndex';
import { splitExtensionId } from '../../common/openVsx';
import { appendAudit } from './audit';
import {
  RegistryError,
  downloadPackage,
  extensionDetail,
  extensionIcon,
  latestVersions,
  resolveInstallCandidate,
} from './openVsxRegistry';
import { VsixError, discardExtraction, extractVsix, inspectVsix, readVsixFile } from './vsix';
import { revokeAllAuthGrants } from './extensionAuth';
import { clearExtensionSecrets } from './extensionSecrets';
import { forgetTerminalEnvironment } from './extensionTerminals';

/**
 * Marketplace extension installation and lifecycle.
 *
 * Installed extensions live in the same `extensions` directory AXIOM already uses, in
 * VS Code's own `<publisher>.<name>-<version>` layout. Two consequences are deliberate:
 *
 *   - The version is part of the directory name, so an upgrade writes a new directory and
 *     only swaps the record once the new one is complete. A failed or interrupted upgrade
 *     leaves the previous version installed and working, rather than a half-written one.
 *   - AXIOM's native extensions (which use `axiom-extension.json`) and marketplace
 *     extensions (which use `package.json`) coexist without either scanner seeing the
 *     other's packages, because each requires its own manifest file to be present.
 *
 * Every install is: download -> verify integrity -> validate the archive -> extract to a
 * staging directory -> rename into place. Nothing is ever extracted over a live
 * installation, so a hostile or truncated package cannot corrupt a working extension.
 *
 * Nothing here executes extension code. Declarative contributions are read as data; an
 * extension that ships an entry point is installed, reported as needing the extension
 * host, and its code is never loaded.
 */
const log = rootLogger.child('marketplace');

const MANIFEST_FILE = 'package.json';
const STATE_FILE = '.marketplace-state.json';
const STAGING_PREFIX = '.staging-';
/** Parallel installs. Enough to make a pack feel fast, few enough to stay polite. */
const INSTALL_CONCURRENCY = 3;
/** Update checks older than this are refreshed when the manager opens. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

function extensionsRoot(): string {
  return join(app.getPath('userData'), 'extensions');
}

function statePath(): string {
  return join(extensionsRoot(), STATE_FILE);
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
/**
 * All state mutations queue behind this.
 *
 * Installing a pack fires several installs at once, and each finishes by recording
 * itself. Without serialization the last writer would silently drop the others' records
 * — the extension would be on disk but unknown to AXIOM.
 */
let stateQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = stateQueue.then(operation, operation);
  stateQueue = result.catch(() => undefined);
  return result;
}

async function readState(): Promise<MarketplaceState> {
  try {
    return sanitizeMarketplaceState(JSON.parse(await readFile(statePath(), 'utf-8')));
  } catch {
    return emptyMarketplaceState();
  }
}

/** Atomic: a truncated state file would orphan every installed extension. */
async function writeState(state: MarketplaceState): Promise<void> {
  const root = extensionsRoot();
  const target = statePath();
  const temporary = join(root, `${STATE_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new MarketplaceError(
      `The extension list could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function mutateState(
  mutate: (state: MarketplaceState) => void | Promise<void>,
): Promise<MarketplaceState> {
  return serialize(async () => {
    const state = await readState();
    await mutate(state);
    await writeState(state);
    return state;
  });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
interface DiscoveredExtension {
  manifest: VsCodeManifest;
  directory: string;
  directoryName: string;
}

/**
 * Resolve a recorded directory name to a real path inside the extensions root.
 *
 * The name comes from a file on disk, so it is re-validated here: the canonical path must
 * still sit under the root. Without this, an edited state file could point AXIOM at any
 * directory on the machine.
 */
async function resolveExtensionDirectory(directoryName: string): Promise<string | null> {
  if (directoryName.includes('/') || directoryName.includes('\\') || directoryName.includes('..')) {
    return null;
  }
  const root = extensionsRoot();
  const candidate = join(root, directoryName);
  try {
    const [canonicalRoot, canonical] = await Promise.all([realpath(root), realpath(candidate)]);
    const rel = relative(canonicalRoot, canonical);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return canonical;
  } catch {
    return null;
  }
}

async function readInstalledManifest(directory: string): Promise<VsCodeManifest | null> {
  try {
    const raw = await readFile(join(directory, MANIFEST_FILE), 'utf-8');
    const parsed = parseVsCodeManifest(JSON.parse(raw.replace(/^\uFEFF/, '')));
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

/**
 * Scan the extensions root for marketplace packages.
 *
 * Disk is the source of truth: a directory with a readable `package.json` is installed,
 * whatever the state file says. State only supplies enablement and provenance, so a
 * missing or stale record degrades to sensible defaults instead of hiding a real
 * installation.
 */
async function discoverInstalled(): Promise<DiscoveredExtension[]> {
  const root = extensionsRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: DiscoveredExtension[] = [];
  for (const directoryName of names) {
    if (directoryName.startsWith(STAGING_PREFIX) || directoryName.startsWith('.')) continue;
    const directory = await resolveExtensionDirectory(directoryName);
    if (directory === null) continue;
    try {
      if (!(await stat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = await readInstalledManifest(directory);
    if (manifest === null) continue;
    found.push({ manifest, directory, directoryName });
  }
  // Two directories can briefly describe the same id during an upgrade; the newer
  // version wins so a half-finished downgrade never shadows a good install.
  const byId = new Map<string, DiscoveredExtension>();
  for (const entry of found) {
    const existing = byId.get(entry.manifest.id);
    if (!existing || compareVersions(entry.manifest.version, existing.manifest.version) > 0) {
      byId.set(entry.manifest.id, entry);
    }
  }
  return [...byId.values()];
}

function defaultRecord(entry: DiscoveredExtension): InstallRecord {
  return {
    version: entry.manifest.version,
    directoryName: entry.directoryName,
    installedAt: 0,
    source: 'vsix',
    integrity: {
      sha256: null,
      digestVerified: false,
      signatureManifestVerified: false,
      signature: 'absent',
    },
    disabledGlobally: false,
    disabledWorkspaces: [],
    autoUpdate: true,
  };
}

function summarize(
  entry: DiscoveredExtension,
  record: InstallRecord,
  workspaceRoot: string | null,
  latest: string | null,
  installedIds: ReadonlySet<string>,
  iconDataUrl: string | null,
): InstalledExtensionSummary {
  const enablement = resolveMarketplaceEnablement(record, workspaceRoot);
  const missing = entry.manifest.extensionDependencies
    .map((dependency) => dependency.toLowerCase())
    .filter((dependency) => !installedIds.has(dependency));
  return {
    id: entry.manifest.id,
    publisher: entry.manifest.publisher,
    name: entry.manifest.name,
    displayName: entry.manifest.displayName,
    description: entry.manifest.description ?? null,
    version: entry.manifest.version,
    installedAt: record.installedAt,
    source: record.source,
    integrity: record.integrity,
    enabled: enablement.enabled,
    enablementScope: enablement.scope,
    autoUpdate: record.autoUpdate,
    categories: entry.manifest.categories,
    capabilities: reportCapabilities(entry.manifest),
    compatibility: reportCompatibility(entry.manifest, AXIOM_VSCODE_API_VERSION),
    latestVersion: latest,
    missingDependencies: missing,
    deprecated: false,
    iconDataUrl,
  };
}

/** Icons are cached per install so reopening the manager does not refetch them. */
const iconCache = new Map<string, string | null>();

/**
 * List installed marketplace extensions.
 *
 * Update information is only attached when it is already known: this call must stay fast
 * and offline-safe, so it never triggers a registry request. `checkForUpdates` is the
 * explicit, awaited path for that.
 */
async function resolveInstalledIcon(entry: DiscoveredExtension): Promise<string | null> {
  const cached = iconCache.get(entry.manifest.id);
  if (cached !== undefined) return cached;
  const relativeIcon = entry.manifest.icon;
  if (relativeIcon && typeof relativeIcon === 'string') {
    try {
      const iconPath = join(entry.directory, relativeIcon);
      const bytes = await readFile(iconPath);
      const ext = extname(relativeIcon).toLowerCase();
      const mime =
        ext === '.svg'
          ? 'image/svg+xml'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : 'image/png';
      const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      iconCache.set(entry.manifest.id, dataUrl);
      return dataUrl;
    } catch {
      // Local icon read failed
    }
  }
  iconCache.set(entry.manifest.id, null);
  return null;
}

export async function listInstalledExtensions(
  workspaceRoot: string | null,
): Promise<InstalledExtensionSummary[]> {
  const [discovered, state] = await Promise.all([discoverInstalled(), readState()]);
  const installedIds = new Set(discovered.map((entry) => entry.manifest.id));
  const known = await latestVersionsFromCacheOnly(discovered.map((entry) => entry.manifest.id));
  const icons = await Promise.all(discovered.map((entry) => resolveInstalledIcon(entry)));
  return discovered
    .map((entry, index) => {
      const record = state.extensions[entry.manifest.id] ?? defaultRecord(entry);
      return summarize(
        entry,
        record,
        workspaceRoot,
        known.get(entry.manifest.id) ?? null,
        installedIds,
        icons[index] ?? null,
      );
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Enabled extensions with their manifest and directory, in one disk pass.
 *
 * The workbench needs `contributes.viewsContainers`, `views`, `viewsWelcome` and `menus` for every
 * enabled extension on every registry rebuild. Going through `installedExtensionDetail` per id would
 * rescan the extensions directory once per extension, so this does the same enablement resolution
 * `listInstalledExtensions` does and returns the manifests directly.
 */
export async function listEnabledExtensionManifests(
  workspaceRoot: string | null,
): Promise<Array<{ manifest: VsCodeManifest; directory: string }>> {
  const [discovered, state] = await Promise.all([discoverInstalled(), readState()]);
  const installedIds = new Set(discovered.map((entry) => entry.manifest.id));
  const out: Array<{ manifest: VsCodeManifest; directory: string }> = [];
  for (const entry of discovered) {
    const record = state.extensions[entry.manifest.id] ?? defaultRecord(entry);
    const summary = summarize(entry, record, workspaceRoot, null, installedIds, null);
    if (!summary.enabled) continue;
    out.push({ manifest: entry.manifest, directory: entry.directory });
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * Latest versions already on disk from a previous check.
 *
 * `latestVersions` with an empty id list performs no network work, so this reads the
 * cached catalog without ever reaching out — which is what keeps listing installed
 * extensions usable with no connection.
 */
async function latestVersionsFromCacheOnly(
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const results = await latestVersions(ids, { force: false }).catch(() => []);
  const map = new Map<string, string | null>();
  for (const result of results) {
    if (result.fromCache) map.set(result.id, result.latestVersion);
  }
  return map;
}

/**
 * Read the consent decision recorded for one extension's code.
 *
 * Exposed from here rather than kept in a second file because consent belongs with the
 * install record: it is a fact about an installed extension, it has to disappear when that
 * extension is uninstalled, and a separate store would drift the first time someone removed
 * an extension outside the manager.
 */
export async function readHostConsent(id: string): Promise<HostConsent> {
  const state = await readState();
  return state.hostConsent[id.toLowerCase()] ?? 'unset';
}

/** Record the user's decision about running one extension's code. */
export async function writeHostConsent(id: string, consent: HostConsent): Promise<void> {
  const key = id.toLowerCase();
  const state = await readState();
  if (consent === 'unset') delete state.hostConsent[key];
  else state.hostConsent[key] = consent;
  await writeState(state);
  await appendAudit('extension.host.consent', `Extension code execution ${consent} for ${key}`);
}

/** Where one extension keeps state AXIOM persists for it, inside the extensions directory. */
export function extensionStorageRoot(id: string, scope: 'global' | 'workspace' | 'logs'): string {
  return join(extensionsRoot(), '.storage', scope, id.toLowerCase());
}

export async function installedExtensionDetail(
  id: string,
  workspaceRoot: string | null,
): Promise<InstalledExtensionDetail> {
  const [discovered, state] = await Promise.all([discoverInstalled(), readState()]);
  const entry = discovered.find((candidate) => candidate.manifest.id === id.toLowerCase());
  if (!entry) throw new MarketplaceError('That extension is not installed.');
  const record = state.extensions[entry.manifest.id] ?? defaultRecord(entry);
  const installedIds = new Set(discovered.map((candidate) => candidate.manifest.id));
  const summary = summarize(
    entry,
    record,
    workspaceRoot,
    null,
    installedIds,
    iconCache.get(entry.manifest.id) ?? null,
  );
  return { ...summary, manifest: entry.manifest, directory: entry.directory };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
/**
 * Write a validated package into place.
 *
 * Extraction happens in a staging directory next to the destination — same volume, so the
 * final `rename` is atomic — and the record is written only after the rename succeeds. If
 * anything fails, staging is discarded and the previous installation is untouched.
 */
async function materialize(
  bytes: Buffer,
  manifest: VsCodeManifest,
  source: InstallSource,
  integrity: InstallIntegrity,
): Promise<{ upgraded: boolean }> {
  const root = extensionsRoot();
  await mkdir(root, { recursive: true });
  const staging = join(root, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`);
  const directoryName = directoryNameFor(manifest.id, manifest.version);
  const destination = join(root, directoryName);

  try {
    await extractVsix(bytes, staging);
    // A package whose manifest disagrees with what was extracted is not installable.
    const extracted = await readInstalledManifest(staging);
    if (
      extracted === null ||
      extracted.id !== manifest.id ||
      extracted.version !== manifest.version
    ) {
      throw new MarketplaceError('The extracted package does not match its manifest.');
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await discardExtraction(staging);
    if (error instanceof MarketplaceError || error instanceof VsixError) throw error;
    throw new MarketplaceError(
      `The extension could not be installed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let upgraded = false;
  await mutateState((state) => {
    const previous = state.extensions[manifest.id];
    upgraded = previous !== undefined && previous.version !== manifest.version;
    state.extensions[manifest.id] = {
      version: manifest.version,
      directoryName,
      installedAt: Date.now(),
      source,
      integrity,
      // Enablement survives an upgrade: a user who disabled an extension does not
      // expect a new version to switch it back on.
      disabledGlobally: previous?.disabledGlobally ?? false,
      disabledWorkspaces: previous?.disabledWorkspaces ?? [],
      autoUpdate: previous?.autoUpdate ?? true,
    };
  });

  // The superseded directory is removed last, so a crash mid-upgrade leaves a usable
  // extra copy rather than nothing.
  await pruneSupersededDirectories(manifest.id, directoryName);
  iconCache.delete(manifest.id);
  return { upgraded };
}

/** Remove directories for other versions of the same extension. */
async function pruneSupersededDirectories(id: string, keep: string): Promise<void> {
  const root = extensionsRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const prefix = `${id}-`;
  for (const name of names) {
    if (name === keep || !name.startsWith(prefix)) continue;
    const directory = await resolveExtensionDirectory(name);
    if (directory === null) continue;
    await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn('A superseded extension directory could not be removed', {
        directory: name,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/**
 * Refuse a package AXIOM cannot honestly offer.
 *
 * Incompatibility is a hard stop rather than a warning: an extension that declares it
 * needs a newer API will contribute against a schema this build does not implement, and
 * installing it would produce failures the user cannot act on. An *unevaluatable* engine
 * range is allowed through, because refusing on "we could not parse it" would block
 * working extensions over a formatting quirk.
 */
function assertInstallable(manifest: VsCodeManifest): void {
  const compatibility = reportCompatibility(manifest, AXIOM_VSCODE_API_VERSION);
  if (compatibility.engineSatisfied === false) {
    throw new MarketplaceError(compatibility.summary);
  }
}

async function installBytes(
  bytes: Buffer,
  source: InstallSource,
  integrity: InstallIntegrity,
  integritySummary: string,
): Promise<InstallOutcome> {
  const inspected = await inspectVsix(bytes);
  assertInstallable(inspected.manifest);
  const { upgraded } = await materialize(bytes, inspected.manifest, source, integrity);
  void appendAudit(
    'extension.install',
    `Extension ${upgraded ? 'updated' : 'installed'}: ${inspected.manifest.id}@${inspected.manifest.version} (${source}) — ${integritySummary}`,
  );
  log.info('Extension installed', {
    id: inspected.manifest.id,
    version: inspected.manifest.version,
    source,
    digestVerified: integrity.digestVerified,
  });
  return {
    id: inspected.manifest.id,
    version: inspected.manifest.version,
    displayName: inspected.manifest.displayName,
    integritySummary,
    upgraded,
    alsoInstalled: [],
  };
}

/**
 * Install one extension from the registry, without touching its dependencies.
 *
 * The build is negotiated rather than assumed: `resolveInstallCandidate` picks the newest
 * engine-compatible version published for this platform, so a user on Windows gets the
 * `win32-x64` package, and an extension whose newest release needs a newer editor installs
 * at the last version that does not. Both were previously "install `latest`, then refuse
 * it at the engine gate".
 */
async function installOneFromRegistry(id: string, version?: string): Promise<InstallOutcome> {
  const candidate = await resolveInstallCandidate(id, version === undefined ? {} : { version });
  const detail = candidate.detail;
  if (candidate.negotiated && version === undefined) {
    log.info('Selected an extension build', {
      id,
      version: detail.version,
      targetPlatform: candidate.targetPlatform,
      considered: candidate.considered,
      rejected: candidate.rejected.length,
    });
  }
  const downloaded = await downloadPackage(detail);
  const outcome = await installBytes(
    downloaded.bytes,
    'registry',
    {
      sha256: downloaded.integrity.sha256,
      digestVerified: downloaded.integrity.digestVerified,
      signatureManifestVerified: downloaded.integrity.signatureManifestVerified,
      signature: downloaded.integrity.signature,
    },
    downloaded.integritySummary,
  );
  if (detail.iconUrl !== null) {
    iconCache.set(outcome.id, await extensionIcon(detail.iconUrl));
  }
  return outcome;
}

/**
 * Build the dependency graph for an install, following `extensionDependencies` and
 * `extensionPack` transitively through the registry.
 *
 * Bounded by the visit count rather than by depth: a pack that references a pack that
 * references a pack is legitimate, an unbounded chain is not.
 */
async function buildDependencyGraph(rootId: string): Promise<DependencyGraph> {
  const edges = new Map<string, string[]>();
  const queue = [rootId.toLowerCase()];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 100) break;
    let dependencies: string[] = [];
    try {
      const detail = await extensionDetail(id);
      dependencies = [...detail.dependencies, ...detail.bundledExtensions]
        .map((dependency) => dependency.toLowerCase())
        .filter((dependency) => splitExtensionId(dependency) !== null);
    } catch (error) {
      // A dependency the registry cannot describe is recorded as having none, so the
      // install still proceeds and the missing piece is reported afterwards.
      log.info('A dependency could not be resolved from the registry', {
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    edges.set(id, dependencies);
    for (const dependency of dependencies) queue.push(dependency);
  }
  return { edges };
}

/** Run installs with bounded parallelism, collecting failures instead of aborting. */
async function installMany(
  ids: readonly string[],
): Promise<{ installed: string[]; failures: string[] }> {
  const installed: string[] = [];
  const failures: string[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(INSTALL_CONCURRENCY, ids.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= ids.length) return;
      const id = ids[index];
      if (id === undefined) return;
      try {
        await installOneFromRegistry(id);
        installed.push(id);
      } catch (error) {
        failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);
  return { installed, failures };
}

/**
 * Install an extension from the registry along with everything it requires.
 *
 * Dependencies install first, in topological order, and a dependency failure is reported
 * rather than hidden: an extension whose dependency could not be installed is still
 * installed, because its declarative contributions usually work regardless, and the
 * manager lists what is missing.
 */
export async function installExtension(id: string, version?: string): Promise<InstallOutcome> {
  const parts = splitExtensionId(id);
  if (!parts) throw new MarketplaceError('That extension identifier is not valid.');

  const graph = await buildDependencyGraph(id);
  const resolution = resolveInstallOrder(id.toLowerCase(), graph);
  if (!resolution.ok) {
    // A dependency cycle must not stop the extension the user actually asked for.
    log.warn('Dependency resolution failed; installing the requested extension only', {
      id,
      reason: resolution.reason,
    });
    return installOneFromRegistry(id, version);
  }

  const alreadyInstalled = new Set((await discoverInstalled()).map((entry) => entry.manifest.id));
  const dependencies = resolution.order.filter(
    (candidate) => candidate !== id.toLowerCase() && !alreadyInstalled.has(candidate),
  );
  const dependencyResult =
    dependencies.length > 0 ? await installMany(dependencies) : { installed: [], failures: [] };
  if (dependencyResult.failures.length > 0) {
    log.warn('Some dependencies could not be installed', { failures: dependencyResult.failures });
  }
  const outcome = await installOneFromRegistry(id, version);
  return { ...outcome, alsoInstalled: dependencyResult.installed };
}

/** Install a `.vsix` chosen from disk. */
export async function installExtensionFromFile(path: string): Promise<InstallOutcome> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new MarketplaceError('No package file was chosen.');
  }
  if (!path.toLowerCase().endsWith('.vsix')) {
    throw new MarketplaceError('Only .vsix packages can be installed from a file.');
  }
  const bytes = await readVsixFile(path);
  // A local file carries no registry digest, so integrity is reported as unverified
  // rather than being quietly presented as trustworthy.
  return installBytes(
    bytes,
    'vsix',
    { sha256: null, digestVerified: false, signatureManifestVerified: false, signature: 'absent' },
    'Installed from a local file; AXIOM validated its structure but no publisher checksum was available.',
  );
}

// ---------------------------------------------------------------------------
// Uninstall and enablement
// ---------------------------------------------------------------------------
export async function uninstallExtension(id: string): Promise<void> {
  const normalized = typeof id === 'string' ? id.toLowerCase() : '';
  if (splitExtensionId(normalized) === null) {
    throw new MarketplaceError('That extension identifier is not valid.');
  }
  const discovered = await discoverInstalled();
  const entry = discovered.find((candidate) => candidate.manifest.id === normalized);
  if (!entry) throw new MarketplaceError('That extension is not installed.');

  // Any dependent left behind would silently lose a capability, so the user is told.
  const dependents = discovered
    .filter((candidate) =>
      candidate.manifest.extensionDependencies.some(
        (dependency) => dependency.toLowerCase() === normalized,
      ),
    )
    .map((candidate) => candidate.manifest.displayName);

  await rm(entry.directory, { recursive: true, force: true });
  await pruneSupersededDirectories(normalized, '');
  await mutateState((state) => {
    delete state.extensions[normalized];
  });
  iconCache.delete(normalized);
  // Uninstalling must revoke what the extension kept about the user, not just delete its code.
  // Failing to forget a token would mean a reinstalled extension silently resumes a session the
  // user believes they removed.
  try {
    await clearExtensionSecrets(normalized);
    await revokeAllAuthGrants(normalized);
    // Phase 7: an environment variable collection outlives deactivation on purpose — upstream
    // re-applies it to every terminal until the extension withdraws it. An extension that is *gone*
    // has no way to withdraw anything, so removal is the one point where it is dropped.
    forgetTerminalEnvironment(normalized);
  } catch (error) {
    log.warn('Removing an uninstalled extension’s credentials failed', {
      id: normalized,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  void appendAudit('extension.install', `Extension removed: ${normalized}`);
  log.info('Extension removed', { id: normalized, dependents: dependents.length });
}

export type EnablementTarget = 'global' | 'workspace';

/**
 * Enable or disable an installed extension.
 *
 * A workspace target records the canonical root, so the same extension can be off in one
 * project and on everywhere else. Enabling at workspace scope clears only that project's
 * exception; it does not override a global disable, because that would make the narrower
 * switch silently widen.
 */
export async function setExtensionEnablement(
  id: string,
  enabled: boolean,
  target: EnablementTarget,
  workspaceRoot: string | null,
): Promise<void> {
  const normalized = typeof id === 'string' ? id.toLowerCase() : '';
  if (splitExtensionId(normalized) === null) {
    throw new MarketplaceError('That extension identifier is not valid.');
  }
  if (target === 'workspace' && (workspaceRoot === null || workspaceRoot.trim().length === 0)) {
    throw new MarketplaceError('A folder must be open to change an extension for this workspace.');
  }
  await mutateState((state) => {
    const record = state.extensions[normalized];
    if (!record) throw new MarketplaceError('That extension is not installed.');
    if (target === 'global') {
      record.disabledGlobally = !enabled;
    } else if (workspaceRoot !== null) {
      const without = record.disabledWorkspaces.filter((root) => root !== workspaceRoot);
      record.disabledWorkspaces = enabled ? without : [...without, workspaceRoot];
    }
  });
  void appendAudit(
    'extension.enable',
    `Extension ${enabled ? 'enabled' : 'disabled'} (${target}): ${normalized}`,
  );
}

export async function setExtensionAutoUpdate(id: string, autoUpdate: boolean): Promise<void> {
  const normalized = typeof id === 'string' ? id.toLowerCase() : '';
  await mutateState((state) => {
    const record = state.extensions[normalized];
    if (!record) throw new MarketplaceError('That extension is not installed.');
    record.autoUpdate = autoUpdate;
  });
}

export async function setAutoUpdateAll(enabled: boolean): Promise<void> {
  await mutateState((state) => {
    state.autoUpdateAll = enabled === true;
  });
}

export async function autoUpdateEnabled(): Promise<boolean> {
  return (await readState()).autoUpdateAll;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
/**
 * Ask the registry which installed extensions have a newer version.
 *
 * Registry-sourced extensions only: a package installed from a local file has no registry
 * identity to compare against, and reporting an "update" for it would offer to replace
 * the user's own build with a stranger's.
 */
export async function checkForUpdates(force = false): Promise<UpdatePlanEntry[]> {
  const [discovered, state] = await Promise.all([discoverInstalled(), readState()]);
  const tracked = discovered.filter(
    (entry) => (state.extensions[entry.manifest.id]?.source ?? 'vsix') === 'registry',
  );
  if (tracked.length === 0) return [];
  const lookups = await latestVersions(
    tracked.map((entry) => entry.manifest.id),
    { force },
  );
  const latest = new Map(lookups.map((lookup) => [lookup.id, lookup.latestVersion]));
  await mutateState((current) => {
    current.lastUpdateCheck = Date.now();
  });
  return planUpdates(
    tracked.map((entry) => ({
      id: entry.manifest.id,
      version: entry.manifest.version,
      displayName: entry.manifest.displayName,
      autoUpdate: state.extensions[entry.manifest.id]?.autoUpdate !== false,
    })),
    latest,
  );
}

/**
 * Update every extension with a newer version.
 *
 * `onlyAutomatic` distinguishes a background pass (which honours each extension's
 * auto-update preference) from the user pressing "Update All" (which does not).
 */
export async function updateAllExtensions(onlyAutomatic = false): Promise<UpdateAllOutcome> {
  const plan = await checkForUpdates(true);
  const target = onlyAutomatic ? plan.filter((entry) => entry.automatic) : plan;
  const targetIds = new Set(target.map((entry) => entry.id));
  const skipped = plan.filter((entry) => !targetIds.has(entry.id)).map((entry) => entry.id);
  const result = await installMany([...targetIds]);
  return { updated: result.installed, failed: result.failures, skipped };
}

/** True when a background update pass is due and enabled. */
export async function backgroundUpdateDue(): Promise<boolean> {
  const state = await readState();
  if (!state.autoUpdateAll) return false;
  return Date.now() - state.lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Remove staging directories left behind by an interrupted install.
 *
 * Called at startup: a crash during extraction leaves a partial directory that is
 * meaningless but occupies disk, and the naming convention makes it unambiguous which
 * directories are safe to delete.
 */
export async function cleanStagingDirectories(): Promise<void> {
  const root = extensionsRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Surface a registry failure to the renderer with its original wording preserved. */
export function describeInstallFailure(error: unknown): string {
  if (
    error instanceof MarketplaceError ||
    error instanceof VsixError ||
    error instanceof RegistryError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
