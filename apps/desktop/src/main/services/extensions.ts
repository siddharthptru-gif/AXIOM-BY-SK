import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateManifest, type ExtensionManifest } from '../../common/extensionManifest';
import {
  validateRegistryIndex,
  type RegistryEntry,
  type RegistryIndex,
} from '../../common/extensionRegistryIndex';
import {
  buildContributionRegistry,
  type ContributionRegistry,
} from '../../common/extensionRegistry';
import {
  deactivateExtension,
  deactivateExtensionsForWorkspace,
  listActiveHosts,
} from './extensionHost';
import { appendAudit } from './audit';
import { assertWorkspaceTrusted } from './workspaceTrust';

/**
 * Main extension discovery and declarative contribution service. Extensions are
 * disabled by default. Legacy JavaScript entries remain fail-closed; import-free
 * WASM activation is delegated to the integrity-checked, quota-bounded trusted
 * worker in extensionSandbox.ts. The WASM runtime has no capability broker APIs.
 */
const MANIFEST_FILE = 'axiom-extension.json';

function statePath(): string {
  return join(app.getPath('userData'), 'extension-state.json');
}
function userExtDir(): string {
  return join(app.getPath('userData'), 'extensions');
}

async function readState(): Promise<Record<string, boolean>> {
  try {
    const raw = await fs.readFile(statePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, boolean>): Promise<void> {
  const path = statePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-extstate-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function readManifestsFrom(
  dir: string,
): Promise<Array<{ manifest: ExtensionManifest; dir: string }>> {
  const out: Array<{ manifest: ExtensionManifest; dir: string }> = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const extDir = join(dir, name);
      const stat = await fs.stat(extDir);
      if (!stat.isDirectory()) continue;
      const text = await fs.readFile(join(extDir, MANIFEST_FILE), 'utf-8');
      const m = validateManifest(JSON.parse(text));
      if (m) out.push({ manifest: m, dir: extDir });
    } catch {
      /* skip unreadable/invalid manifest */
    }
  }
  return out;
}

async function discover(
  root: string | null,
): Promise<Map<string, { manifest: ExtensionManifest; dir: string }>> {
  const dirs = [userExtDir()];
  if (root) dirs.push(join(root, '.axiom', 'extensions'));
  const byId = new Map<string, { manifest: ExtensionManifest; dir: string }>();
  for (const d of dirs) {
    for (const entry of await readManifestsFrom(d)) byId.set(entry.manifest.id, entry);
  }
  return byId;
}

/** All discovered extensions (user-global + workspace), with enable state applied. */
export async function listExtensions(root: string | null): Promise<ExtensionManifest[]> {
  const state = await readState();
  const discovered = await discover(root);
  return [...discovered.values()]
    .map(({ manifest }) => ({ ...manifest, enabled: state[manifest.id] === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolve an extension entry only after canonical containment checks. */
export async function resolveExtensionMain(
  id: string,
  root: string | null,
): Promise<{ manifest: ExtensionManifest; mainPath: string } | null> {
  const entry = (await discover(root)).get(id);
  if (!entry || !entry.manifest.main) return null;
  const extensionDir = await fs.realpath(entry.dir);
  const allowedRoots: string[] = [];
  try {
    allowedRoots.push(await fs.realpath(userExtDir()));
  } catch {
    // User extension directory may not exist.
  }
  if (root) allowedRoots.push(await fs.realpath(root));
  if (!allowedRoots.some((allowedRoot) => isWithin(extensionDir, allowedRoot))) {
    throw new Error('Extension directory escapes its approved root.');
  }
  const mainPath = await fs.realpath(resolve(extensionDir, entry.manifest.main));
  if (!isWithin(mainPath, extensionDir)) {
    throw new Error('Extension entry point escapes its extension directory.');
  }
  const stat = await fs.stat(mainPath);
  if (!stat.isFile()) throw new Error('Extension entry point is not a file.');
  return {
    manifest: { ...entry.manifest, enabled: true },
    mainPath,
  };
}

/** Resolve a declared WASM module after canonical package containment checks. */
export async function resolveExtensionWasm(
  id: string,
  root: string | null,
): Promise<{ manifest: ExtensionManifest; modulePath: string } | null> {
  const entry = (await discover(root)).get(id);
  if (!entry?.manifest.runtime) return null;
  const extensionDir = await fs.realpath(entry.dir);
  const allowedRoots: string[] = [];
  try {
    allowedRoots.push(await fs.realpath(userExtDir()));
  } catch {
    // User extension directory may not exist.
  }
  if (root) allowedRoots.push(await fs.realpath(root));
  if (!allowedRoots.some((allowedRoot) => isWithin(extensionDir, allowedRoot))) {
    throw new Error('Extension directory escapes its approved root.');
  }
  const modulePath = await fs.realpath(resolve(extensionDir, entry.manifest.runtime.entry));
  if (!isWithin(modulePath, extensionDir)) {
    throw new Error('Extension WASM module escapes its extension directory.');
  }
  const stat = await fs.stat(modulePath);
  if (!stat.isFile()) throw new Error('Extension WASM module is not a regular file.');
  const state = await readState();
  return {
    manifest: { ...entry.manifest, enabled: state[entry.manifest.id] === true },
    modulePath,
  };
}

/** Enable/disable declarative contributions. Executable entry points are rejected. */
export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
  root: string | null,
): Promise<ExtensionManifest[]> {
  if (!enabled) {
    const state = await readState();
    delete state[id];
    await writeState(state);
    void appendAudit('extension.enable', `Extension disabled: ${id}`);
    // Deactivation is cleanup and must remain available in Restricted Mode or
    // when the renderer no longer has an active workspace.
    await deactivateExtension(id);
    return listExtensions(root);
  }

  if (!root) throw new Error('Restricted Mode: a trusted workspace is required.');
  const canonicalRoot = await assertWorkspaceTrusted(root);
  const resolved = await resolveExtensionMain(id, canonicalRoot);
  if (resolved) {
    throw new Error(
      'Executable extensions are disabled until the extension host can enforce filesystem, network, and process isolation. Declarative contributions remain supported.',
    );
  }
  if (await resolveExtensionWasm(id, canonicalRoot)) {
    throw new Error(
      'WASM extensions must be enabled through the God Mode sandbox review so integrity, signature, permissions, and quotas are acknowledged.',
    );
  }

  try {
    await assertWorkspaceTrusted(canonicalRoot);
    const state = await readState();
    state[id] = true;
    await assertWorkspaceTrusted(canonicalRoot);
    await writeState(state);
  } catch (error) {
    throw error;
  }
  void appendAudit('extension.enable', `Extension enabled: ${id}`);
  return listExtensions(canonicalRoot);
}

/** Main-internal: persist WASM enablement only after extensionSandbox verifies it. */
export async function setSandboxExtensionEnabledState(
  id: string,
  enabled: boolean,
  root: string,
): Promise<ExtensionManifest[]> {
  const canonicalRoot = await assertWorkspaceTrusted(root);
  if (await resolveExtensionMain(id, canonicalRoot)) {
    throw new Error('Legacy JavaScript extension entry points remain disabled.');
  }
  if (enabled && !(await resolveExtensionWasm(id, canonicalRoot))) {
    throw new Error('The extension does not declare a valid WASM runtime.');
  }
  const state = await readState();
  if (enabled) state[id] = true;
  else delete state[id];
  await assertWorkspaceTrusted(canonicalRoot);
  await writeState(state);
  void appendAudit('extension.sandbox', `WASM extension ${enabled ? 'enabled' : 'disabled'}: ${id}`);
  return listExtensions(canonicalRoot);
}

/** The merged contribution registry from enabled extensions. */
export async function getExtensionRegistry(root: string | null): Promise<ContributionRegistry> {
  return buildContributionRegistry(await listExtensions(root));
}

/** Which extension hosts are currently running/active (crash-isolated child processes). */
export function getActiveExtensionHosts(): Array<{ extId: string; active: boolean }> {
  return listActiveHosts();
}

/** Stop all extension hosts for a workspace without consulting trust. */
export function stopExtensionsForWorkspace(root: string): Promise<void> {
  return deactivateExtensionsForWorkspace(root);
}

// ---------------------------------------------------------------------------
// Extension marketplace / local registry (PRD Epoch I / Phase 243).
// A LOCAL/first-party registry lives under userData/registry: an optional
// index.json (metadata) + a packages/<source>/ folder per publishable extension
// (each a normal extension folder with an axiom-extension.json). Installing copies
// a package folder into userData/extensions/<id> so the existing discover() picks
// it up. No remote registry — honest local-first scope (243 partial).
// ---------------------------------------------------------------------------
function registryDir(): string {
  return join(app.getPath('userData'), 'registry');
}
function registryPackagesDir(): string {
  return join(registryDir(), 'packages');
}
function registryIndexPath(): string {
  return join(registryDir(), 'index.json');
}

/** Synthesize registry entries from the packages dir (each folder = one package). */
async function scanRegistryPackages(): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = [];
  const dir = registryPackagesDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const pkgDir = join(dir, name);
      const stat = await fs.stat(pkgDir);
      if (!stat.isDirectory()) continue;
      const text = await fs.readFile(join(pkgDir, MANIFEST_FILE), 'utf-8');
      const m = validateManifest(JSON.parse(text));
      if (!m) continue;
      out.push({
        id: m.id,
        name: m.name,
        version: m.version,
        source: name,
        ...(m.publisher ? { publisher: m.publisher } : {}),
        ...(m.description ? { description: m.description } : {}),
      });
    } catch {
      /* skip unreadable/invalid package */
    }
  }
  return out;
}

async function readJsonArray(path: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf-8'));
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return (parsed as { entries: unknown[] }).entries;
    }
  } catch {
    /* no/invalid file */
  }
  return [];
}

/**
 * The local registry index: merge index.json + the synthesized packages scan + an
 * optional workspace .axiom/registry.json, validated + deduped by the pure module.
 */
export async function getRegistryIndex(root: string | null): Promise<RegistryIndex> {
  const raw: unknown[] = [];
  for (const item of await readJsonArray(registryIndexPath())) raw.push(item);
  for (const entry of await scanRegistryPackages()) raw.push(entry);
  if (root) {
    for (const item of await readJsonArray(join(root, '.axiom', 'registry.json'))) raw.push(item);
  }
  return validateRegistryIndex(raw);
}

/**
 * Install (or upgrade) an extension from the local registry: locate its package
 * folder, verify the manifest, and copy it into userData/extensions/<id>. Throws a
 * descriptive error when the entry or its package files are missing.
 */
export async function installExtension(
  id: string,
  root: string | null,
): Promise<ExtensionManifest[]> {
  const index = await getRegistryIndex(root);
  const entry = index.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Extension not found in local registry: ${id}`);

  const srcDir = join(registryPackagesDir(), entry.source ?? entry.id);
  let manifest: ExtensionManifest | null = null;
  try {
    manifest = validateManifest(
      JSON.parse(await fs.readFile(join(srcDir, MANIFEST_FILE), 'utf-8')),
    );
  } catch {
    manifest = null;
  }
  if (!manifest) throw new Error(`Package files for "${id}" are missing from the local registry.`);

  const destDir = join(userExtDir(), manifest.id);
  await fs.mkdir(userExtDir(), { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.cp(srcDir, destDir, { recursive: true });
  void appendAudit(
    'extension.install',
    `Extension installed from local registry: ${manifest.id}@${manifest.version}`,
  );
  return listExtensions(root);
}
