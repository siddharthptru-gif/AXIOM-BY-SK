/**
 * Marketplace extension state: installation records, enablement, and update planning.
 *
 * Pure — no filesystem, no network — so the policy that decides what is enabled, what
 * needs updating, and in what order a dependency set installs is testable without
 * touching a disk or a registry.
 *
 * This deliberately does NOT reuse `extensionManagement.resolveEnablement`. That module
 * serves AXIOM's native extensions, which are disabled until explicitly enabled because
 * they can request capabilities. A marketplace extension is a different bargain: the user
 * installed it on purpose, so it is enabled on arrival, and a disable is recorded as an
 * exception. Sharing one function would have meant one of the two defaults being wrong.
 */
import { compareVersions } from './extensionRegistryIndex';
import type { SignatureState } from './openVsx';
import type { CapabilityReport, CompatibilityReport, VsCodeManifest } from './vscodeManifest';

export type InstallSource = 'registry' | 'vsix';
export type EnablementScope = 'workspace' | 'global' | 'default';

/** What AXIOM was able to verify about the bytes at install time. */
export interface InstallIntegrity {
  sha256: string | null;
  digestVerified: boolean;
  signatureManifestVerified: boolean;
  signature: SignatureState;
}

/** One installation record as persisted. */
export interface InstallRecord {
  version: string;
  /** Directory under the extensions root; the version is part of the name. */
  directoryName: string;
  installedAt: number;
  source: InstallSource;
  integrity: InstallIntegrity;
  /** An explicit global disable. Absent means enabled, which is the install default. */
  disabledGlobally: boolean;
  /** Canonical workspace roots where this extension is switched off. */
  disabledWorkspaces: string[];
  /** Per-extension opt-out from automatic updating. */
  autoUpdate: boolean;
}

/**
 * Whether the user has agreed to let one extension's code run.
 *
 * Three states, not two. `unset` is what every extension starts at and is why installing an
 * extension is not the same act as running its code: a theme, a snippet pack and a language
 * definition need no permission at all, while an extension entry point gets the user's own
 * OS privileges. `denied` has to be recorded as distinctly as `granted`, otherwise every
 * restart would ask again about something already refused.
 */
export type HostConsent = 'unset' | 'granted' | 'denied';

export interface MarketplaceState {
  version: 1;
  extensions: Record<string, InstallRecord>;
  /** Master switch for background updates. */
  autoUpdateAll: boolean;
  lastUpdateCheck: number;
  /** Per-extension decision about running its code. Absent means never asked. */
  hostConsent: Record<string, HostConsent>;
}

export function emptyMarketplaceState(): MarketplaceState {
  return {
    version: 1,
    extensions: {},
    autoUpdateAll: true,
    lastUpdateCheck: 0,
    hostConsent: {},
  };
}

const MAX_TRACKED_EXTENSIONS = 2_000;
const MAX_DISABLED_WORKSPACES = 200;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}\.[a-z0-9][a-z0-9._-]{0,127}$/;
const DIRECTORY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * The on-disk directory name for an installed version.
 *
 * Includes the version, matching VS Code's own layout, which buys two things: an upgrade
 * writes a new directory instead of mutating a live one, and a failed upgrade leaves the
 * previous version intact and still loadable.
 */
export function directoryNameFor(id: string, version: string): string {
  return `${id}-${version}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 4_096) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeIntegrity(value: unknown): InstallIntegrity {
  const record = asRecord(value);
  const sha256 =
    typeof record?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)
      ? record.sha256
      : null;
  const signature = record?.signature === 'present-unverified' ? 'present-unverified' : 'absent';
  return {
    sha256,
    digestVerified: record?.digestVerified === true,
    signatureManifestVerified: record?.signatureManifestVerified === true,
    signature,
  };
}

/**
 * Validate a persisted state file.
 *
 * Unreadable or partly-corrupt state degrades to "nothing recorded" for the affected
 * entries rather than throwing: the extensions on disk are the real source of truth, and
 * refusing to launch because a preferences file got truncated would be the wrong trade.
 */
export function sanitizeMarketplaceState(raw: unknown): MarketplaceState {
  const record = asRecord(raw);
  if (!record) return emptyMarketplaceState();
  const extensions: Record<string, InstallRecord> = {};
  const rawExtensions = asRecord(record.extensions) ?? {};
  for (const [rawId, rawEntry] of Object.entries(rawExtensions)) {
    if (Object.keys(extensions).length >= MAX_TRACKED_EXTENSIONS) break;
    const id = rawId.toLowerCase();
    const entry = asRecord(rawEntry);
    if (!entry || !ID_RE.test(id)) continue;
    const version = typeof entry.version === 'string' ? entry.version : null;
    const directoryName = typeof entry.directoryName === 'string' ? entry.directoryName : null;
    if (version === null || directoryName === null || !DIRECTORY_RE.test(directoryName)) continue;
    extensions[id] = {
      version,
      directoryName,
      installedAt:
        typeof entry.installedAt === 'number' && Number.isFinite(entry.installedAt)
          ? entry.installedAt
          : 0,
      source: entry.source === 'vsix' ? 'vsix' : 'registry',
      integrity: sanitizeIntegrity(entry.integrity),
      disabledGlobally: entry.disabledGlobally === true,
      disabledWorkspaces: asStringArray(entry.disabledWorkspaces, MAX_DISABLED_WORKSPACES),
      // Absent means opted in: a user who never expressed a preference gets updates.
      autoUpdate: entry.autoUpdate !== false,
    };
  }
  // Consent is read with the same suspicion as everything else in this file: an id that is
  // not a valid extension id, or a value that is not one of the three states, is dropped
  // rather than coerced. Coercing an unrecognized value would be the one bug in this parser
  // that could grant permission nobody gave.
  const hostConsent: Record<string, HostConsent> = {};
  for (const [rawId, rawValue] of Object.entries(asRecord(record.hostConsent) ?? {})) {
    if (Object.keys(hostConsent).length >= MAX_TRACKED_EXTENSIONS) break;
    const id = rawId.toLowerCase();
    if (!ID_RE.test(id)) continue;
    if (rawValue === 'granted' || rawValue === 'denied') hostConsent[id] = rawValue;
  }
  return {
    version: 1,
    extensions,
    autoUpdateAll: record.autoUpdateAll !== false,
    lastUpdateCheck:
      typeof record.lastUpdateCheck === 'number' && Number.isFinite(record.lastUpdateCheck)
        ? record.lastUpdateCheck
        : 0,
    hostConsent,
  };
}

/**
 * Effective enablement for an extension in a workspace.
 *
 * Precedence is workspace, then global, then the install default of enabled. A workspace
 * disable is the narrowest statement the user can make, so it wins.
 */
export function resolveMarketplaceEnablement(
  record: InstallRecord | undefined,
  workspaceRoot: string | null,
): { enabled: boolean; scope: EnablementScope } {
  if (!record) return { enabled: false, scope: 'default' };
  if (workspaceRoot !== null && record.disabledWorkspaces.includes(workspaceRoot)) {
    return { enabled: false, scope: 'workspace' };
  }
  if (record.disabledGlobally) return { enabled: false, scope: 'global' };
  return { enabled: true, scope: 'default' };
}

// ---------------------------------------------------------------------------
// The renderer-facing view of an installed extension
// ---------------------------------------------------------------------------
export interface InstalledExtensionSummary {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  description: string | null;
  version: string;
  installedAt: number;
  source: InstallSource;
  integrity: InstallIntegrity;
  enabled: boolean;
  enablementScope: EnablementScope;
  autoUpdate: boolean;
  categories: string[];
  /** What actually works, and what is declared but inert. */
  capabilities: CapabilityReport;
  compatibility: CompatibilityReport;
  /** Newer version available, when an update check has run. */
  latestVersion: string | null;
  /** Ids this extension needs that are not installed. */
  missingDependencies: string[];
  /** True when the registry has marked the extension deprecated. */
  deprecated: boolean;
  iconDataUrl: string | null;
}

/** The full manifest, fetched on demand for the details pane. */
export interface InstalledExtensionDetail extends InstalledExtensionSummary {
  manifest: VsCodeManifest;
  /** Absolute path on disk, shown so a user can inspect what they installed. */
  directory: string;
}

// ---------------------------------------------------------------------------
// Update planning
// ---------------------------------------------------------------------------
export interface UpdatePlanEntry {
  id: string;
  displayName: string;
  fromVersion: string;
  toVersion: string;
  /** False when the user opted this extension out of automatic updating. */
  automatic: boolean;
}

/**
 * Which installed extensions have a strictly newer published version.
 *
 * Only strictly-newer counts: a registry that briefly reports an older version (a yanked
 * release, a platform-specific variant) must never trigger a silent downgrade.
 */
export function planUpdates(
  installed: readonly { id: string; version: string; displayName: string; autoUpdate: boolean }[],
  latest: ReadonlyMap<string, string | null>,
): UpdatePlanEntry[] {
  const out: UpdatePlanEntry[] = [];
  for (const extension of installed) {
    const latestVersion = latest.get(extension.id) ?? null;
    if (latestVersion === null) continue;
    if (compareVersions(latestVersion, extension.version) <= 0) continue;
    out.push({
      id: extension.id,
      displayName: extension.displayName,
      fromVersion: extension.version,
      toVersion: latestVersion,
      automatic: extension.autoUpdate,
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---------------------------------------------------------------------------
// Dependency and pack resolution
// ---------------------------------------------------------------------------
export interface DependencyGraph {
  /** id -> ids it directly requires (`extensionDependencies` + `extensionPack`). */
  edges: ReadonlyMap<string, readonly string[]>;
}

export type ResolutionResult =
  { ok: true; order: string[] } | { ok: false; reason: string; cycle?: string[] };

/** Installing more than this in one action is a runaway, not a user intent. */
const MAX_INSTALL_SET = 100;

/**
 * Order an install set so every dependency is installed before whatever requires it.
 *
 * A depth-first topological sort with explicit cycle reporting. Extension packs in the
 * wild do contain cycles (two packs listing each other), so a cycle is reported as a
 * named failure the UI can explain rather than being silently broken or hanging.
 */
export function resolveInstallOrder(target: string, graph: DependencyGraph): ResolutionResult {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): ResolutionResult | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return {
        ok: false,
        reason: 'These extensions depend on each other in a loop.',
        cycle: [...stack.slice(start >= 0 ? start : 0), id],
      };
    }
    if (order.length >= MAX_INSTALL_SET) {
      return {
        ok: false,
        reason: `Installing ${id} would pull in more extensions than AXIOM allows at once.`,
      };
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of graph.edges.get(id) ?? []) {
      const failure = visit(dependency);
      if (failure) return failure;
    }
    stack.pop();
    state.set(id, 'done');
    order.push(id);
    return null;
  };

  const failure = visit(target);
  if (failure) return failure;
  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// Manager views
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Operation results, as they cross IPC
// ---------------------------------------------------------------------------
export interface InstallOutcome {
  id: string;
  version: string;
  displayName: string;
  /** What AXIOM verified about the package, verbatim — never a reassuring summary. */
  integritySummary: string;
  /** True when a previous version was replaced. */
  upgraded: boolean;
  /** Ids installed alongside this one to satisfy dependencies. */
  alsoInstalled: string[];
}

export interface UpdateAllOutcome {
  updated: string[];
  /** `id: reason` for each failure, so one bad extension is explained, not hidden. */
  failed: string[];
  /** Skipped because the user opted them out of automatic updates. */
  skipped: string[];
}

export type ManagerView =
  | 'installed'
  | 'enabled'
  | 'disabled'
  | 'updates'
  | 'recommended'
  | 'popular'
  | 'recently-updated'
  | 'search';

/** Views served entirely from local state, with no registry request. */
export function isLocalView(view: ManagerView): boolean {
  return view === 'installed' || view === 'enabled' || view === 'disabled' || view === 'updates';
}

/** Filter and sort the installed list for a local view. */
export function selectInstalled(
  installed: readonly InstalledExtensionSummary[],
  view: ManagerView,
  query: string,
): InstalledExtensionSummary[] {
  const needle = query.trim().toLowerCase();
  const matches = (extension: InstalledExtensionSummary): boolean => {
    if (needle === '') return true;
    return (
      extension.id.includes(needle) ||
      extension.displayName.toLowerCase().includes(needle) ||
      (extension.description ?? '').toLowerCase().includes(needle) ||
      extension.categories.some((category) => category.toLowerCase().includes(needle))
    );
  };
  return installed
    .filter((extension) => {
      if (!matches(extension)) return false;
      switch (view) {
        case 'enabled':
          return extension.enabled;
        case 'disabled':
          return !extension.enabled;
        case 'updates':
          return (
            extension.latestVersion !== null &&
            compareVersions(extension.latestVersion, extension.version) > 0
          );
        default:
          return true;
      }
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Recommend registry extensions for the languages present in the workspace.
 *
 * Keyword and category matching only — the registry exposes no recommendation API, and
 * inventing a ranking that looks authoritative would misrepresent where it came from.
 */
export function recommendationQueries(languages: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const language of languages) {
    const term = language.trim().toLowerCase();
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= 6) break;
  }
  return out;
}
