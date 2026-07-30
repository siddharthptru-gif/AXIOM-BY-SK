import {
  compareVersions,
  type RegistryEntry,
  type RegistryIndex,
  type InstalledRef,
} from './extensionRegistryIndex';

/**
 * Extension management (PRD Epoch I §117.5 / Phase 245). Pure management logic on
 * top of the registry index: per-workspace enablement resolution, a bulk-update
 * plan (which installed extensions have a newer version in the registry), and
 * trust-aware recommendations from the project profile. No I/O — the Extensions
 * view + service consume these, so the policy is fully unit-testable. Honest scope:
 * install/enable/disable/upgrade + the local (trusted) registry already ship
 * (239–243); this adds bulk update + workspace enablement + recommendations. A
 * pre-install permission diff for remote packages remains future work.
 */

export type EnableScope = 'workspace' | 'global' | 'default';

export interface Enablement {
  id: string;
  enabled: boolean;
  /** Where the effective decision came from. */
  scope: EnableScope;
}

/**
 * Resolve an extension's effective enablement: a per-workspace override wins, else
 * the global setting, else the trust-aware default (disabled). Extensions are
 * disabled by default, so an unknown id resolves to disabled/'default'.
 */
export function resolveEnablement(
  id: string,
  global: Readonly<Record<string, boolean>>,
  workspace: Readonly<Record<string, boolean>>,
): Enablement {
  const w = workspace[id];
  if (w !== undefined) return { id, enabled: w, scope: 'workspace' };
  const g = global[id];
  if (g !== undefined) return { id, enabled: g, scope: 'global' };
  return { id, enabled: false, scope: 'default' };
}

export interface UpdateCandidate {
  id: string;
  name: string;
  fromVersion: string;
  toVersion: string;
}

/**
 * Plan a bulk update: for each installed extension present in the registry with a
 * strictly-newer version, produce an update candidate. Sorted by name. Installed
 * extensions absent from the registry (or already current) are skipped.
 */
export function planBulkUpdate(
  installed: readonly InstalledRef[],
  index: RegistryIndex,
): UpdateCandidate[] {
  const out: UpdateCandidate[] = [];
  for (const inst of installed) {
    const entry = index.entries.find((e) => e.id === inst.id);
    if (!entry) continue;
    if (compareVersions(entry.version, inst.version) > 0) {
      out.push({
        id: inst.id,
        name: entry.name,
        fromVersion: inst.version,
        toVersion: entry.version,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface RecommendProfile {
  languages?: string[];
  frameworks?: string[];
}

const RECOMMEND_LIMIT = 6;

/** Score a registry entry against the project's language/framework terms. */
function recommendScore(e: RegistryEntry, terms: readonly string[]): number {
  const kws = (e.keywords ?? []).map((k) => k.toLowerCase());
  const hay = `${e.id} ${e.name} ${e.description ?? ''} ${kws.join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (kws.includes(t)) score += 10;
    else if (hay.includes(t)) score += 4;
  }
  return score;
}

/**
 * Recommend extensions for the current project (trust-aware — only from the local,
 * trusted registry). Ranks registry entries by how well their keywords / name /
 * description match the project's languages + frameworks, excluding already-installed
 * ones. Returns [] when the profile has no usable terms.
 */
export function recommendExtensions(
  profile: RecommendProfile,
  index: RegistryIndex,
  installed: readonly InstalledRef[],
  limit: number = RECOMMEND_LIMIT,
): RegistryEntry[] {
  const installedIds = new Set(installed.map((i) => i.id));
  const terms = [...(profile.languages ?? []), ...(profile.frameworks ?? [])]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  return index.entries
    .filter((e) => !installedIds.has(e.id))
    .map((e) => ({ e, score: recommendScore(e, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    .slice(0, Math.max(1, limit))
    .map((r) => r.e);
}
