/**
 * Extension registry index + install planning (PRD Epoch I §117 / Phase 243). Pure
 * logic for a LOCAL/first-party extension marketplace: validate a registry index,
 * search/rank entries by a query, compare semver-ish versions, and build an install
 * plan (install / upgrade / downgrade / up-to-date) against the currently-installed
 * set. No I/O — the Main service reads the local index + performs the copy; this
 * decides what to do, so it is fully unit-testable. Honest scope: there is no live
 * remote registry, so 243 ships as a local/first-party index (remote federation is
 * future work).
 */

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  keywords?: string[];
  /** Folder name of the packaged extension in the local registry's packages dir. */
  source?: string;
}

export interface RegistryIndex {
  entries: RegistryEntry[];
}

/** A currently-installed extension (id + its installed version). */
export interface InstalledRef {
  id: string;
  version: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,60}$/i;

/** Parse a semver-ish version into 3 numeric parts + a prerelease tag. */
export function parseSemver(v: string): { parts: number[]; pre: string } {
  const s = v.trim().replace(/^v/i, '');
  const dash = s.indexOf('-');
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : '';
  const parts = core.split('.').map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), pre };
}

/**
 * Compare two versions: -1 (a<b) / 0 (equal) / 1 (a>b). Numeric parts compare
 * left-to-right; a release (no prerelease) outranks the same core with a prerelease.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function sanitizeEntry(raw: unknown): RegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
  const version = typeof o.version === 'string' ? o.version.trim().slice(0, 20) : '';
  if (!ID_RE.test(id) || name.length === 0 || version.length === 0) return null;
  const entry: RegistryEntry = { id, name, version };
  if (typeof o.publisher === 'string' && o.publisher.trim())
    entry.publisher = o.publisher.trim().slice(0, 60);
  if (typeof o.description === 'string' && o.description.trim())
    entry.description = o.description.trim().slice(0, 200);
  if (Array.isArray(o.keywords)) {
    const kw = o.keywords
      .filter((k): k is string => typeof k === 'string' && k.length > 0)
      .map((k) => k.slice(0, 40))
      .slice(0, 20);
    if (kw.length > 0) entry.keywords = kw;
  }
  if (typeof o.source === 'string' && o.source.trim()) entry.source = o.source.trim().slice(0, 120);
  return entry;
}

/**
 * Validate + normalize a raw registry index (an array of entries, or `{ entries }`).
 * Invalid entries are dropped; duplicate ids collapse to the highest version.
 */
export function validateRegistryIndex(raw: unknown): RegistryIndex {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries as unknown[])
      : [];
  const byId = new Map<string, RegistryEntry>();
  for (const item of list) {
    const e = sanitizeEntry(item);
    if (!e) continue;
    const existing = byId.get(e.id);
    if (!existing || compareVersions(e.version, existing.version) > 0) byId.set(e.id, e);
  }
  return { entries: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function scoreEntry(e: RegistryEntry, q: string): number {
  const name = e.name.toLowerCase();
  const id = e.id.toLowerCase();
  const desc = (e.description ?? '').toLowerCase();
  const kw = (e.keywords ?? []).map((k) => k.toLowerCase());
  let score = 0;
  if (name === q || id === q) score += 100;
  else if (name.startsWith(q) || id.startsWith(q)) score += 60;
  else if (name.includes(q) || id.includes(q)) score += 40;
  if (kw.includes(q)) score += 30;
  else if (kw.some((k) => k.includes(q))) score += 15;
  if (desc.includes(q)) score += 10;
  return score;
}

/**
 * Search the index for a query, ranked by relevance (exact > prefix > substring on
 * name/id, then keyword, then description). An empty query returns all entries
 * sorted by name. Stable: name breaks score ties.
 */
export function searchRegistry(index: RegistryIndex, query: string): RegistryEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...index.entries].sort((a, b) => a.name.localeCompare(b.name));
  return index.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((r) => r.entry);
}

export type InstallAction = 'install' | 'upgrade' | 'downgrade' | 'up-to-date';

export interface InstallPlan {
  id: string;
  action: InstallAction;
  fromVersion: string | null;
  toVersion: string;
  reason: string;
}

/** Decide what installing a registry entry would do, given what's installed. */
export function buildInstallPlan(
  entry: RegistryEntry,
  installed: readonly InstalledRef[],
): InstallPlan {
  const cur = installed.find((i) => i.id === entry.id);
  if (!cur) {
    return {
      id: entry.id,
      action: 'install',
      fromVersion: null,
      toVersion: entry.version,
      reason: 'Not installed.',
    };
  }
  const cmp = compareVersions(entry.version, cur.version);
  if (cmp > 0) {
    return {
      id: entry.id,
      action: 'upgrade',
      fromVersion: cur.version,
      toVersion: entry.version,
      reason: `Upgrade ${cur.version} \u2192 ${entry.version}.`,
    };
  }
  if (cmp < 0) {
    return {
      id: entry.id,
      action: 'downgrade',
      fromVersion: cur.version,
      toVersion: entry.version,
      reason: `Registry has an older version (${entry.version} < ${cur.version}).`,
    };
  }
  return {
    id: entry.id,
    action: 'up-to-date',
    fromVersion: cur.version,
    toVersion: entry.version,
    reason: `Already at ${cur.version}.`,
  };
}

/** The user-facing label for an install action. */
export const INSTALL_ACTION_LABELS: Record<InstallAction, string> = {
  install: 'Install',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  'up-to-date': 'Installed',
};
