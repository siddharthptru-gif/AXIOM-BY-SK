import type { FeatureFlag, FlagContext, FlagValue } from './ipc';

/**
 * Feature-flags client evaluator (PRD Epoch E §57 / Phase 129). Pure and
 * deterministic: resolves a flag against a context via kill switch, version/OS
 * targeting, and stable percentage rollout (a user is consistently in or out of a
 * rollout across sessions). Ships compiled fail-safe DEFAULT_FLAGS so the product
 * works before/without any backend fetch (Realtime overrides merge on top later).
 * No I/O here — unit-tested for bucketing stability + targeting + kill switch.
 */

export const DEFAULT_FLAGS: Record<string, FeatureFlag> = {
  'feature.agents.subagents': { key: 'feature.agents.subagents', value: true },
  'feature.agents.parallel': { key: 'feature.agents.parallel', value: true, rolloutPct: 100 },
  'feature.semanticSearch': { key: 'feature.semanticSearch', value: true },
  'feature.memory': { key: 'feature.memory', value: true },
  'ai.default.contextBudgetTokens': { key: 'ai.default.contextBudgetTokens', value: 2400 },
  'experiment.diffReview.variant': { key: 'experiment.diffReview.variant', value: 'inline' },
};

/** Stable 0–99 bucket for a user+flag (FNV-1a). Deterministic across sessions. */
export function stableBucket(userId: string, key: string): number {
  let h = 0x811c9dc5;
  const s = `${userId}:${key}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/** Compare dotted numeric versions; non-numeric parts count as 0. Returns -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Resolve a single flag. Kill switch, version/OS targeting, and rollout gate only
 * boolean flags (they can turn off → false); non-boolean flags pass through.
 */
export function evaluateFlag(flag: FeatureFlag, ctx: FlagContext): FlagValue {
  if (typeof flag.value !== 'boolean') return flag.value;
  if (flag.killed) return false;
  if (flag.minVersion && compareVersions(ctx.appVersion, flag.minVersion) < 0) return false;
  if (flag.os && flag.os.length > 0 && !flag.os.includes(ctx.os)) return false;
  if (typeof flag.rolloutPct === 'number' && flag.rolloutPct < 100) {
    if (flag.rolloutPct <= 0) return false;
    if (stableBucket(ctx.userId, flag.key) >= flag.rolloutPct) return false;
  }
  return flag.value;
}

/** Resolve all flags to their effective values for a context. */
export function evaluateAll(
  flags: Record<string, FeatureFlag>,
  ctx: FlagContext,
): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (const [k, f] of Object.entries(flags)) out[k] = evaluateFlag(f, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Realtime delivery (Phase 129): parse the deployed `feature-flags` Edge
// response into overrides + a cache-freshness model. Still PURE (no I/O) — the
// Main service does the fetch/subscribe/persist and feeds `parseFlagsPayload`.
// ---------------------------------------------------------------------------

/** One row of the deployed `feature-flags` Edge function response. */
export interface FlagFetchRow {
  key: string;
  enabled: boolean;
  description?: string;
}

/**
 * Parse the `feature-flags` Edge response (`{ flags: [{ key, enabled }] }`) into
 * resolved boolean OVERRIDE flags. Defensive + fail-safe: a missing/malformed
 * payload or any bad entry is skipped, so garbage yields no overrides and the
 * compiled DEFAULT_FLAGS keep working (INV: never crash on a bad backend reply).
 * The server has already applied per-user rollout/targeting, so each override is a
 * resolved boolean that the client passes through unchanged in `evaluateFlag`.
 */
export function parseFlagsPayload(raw: unknown): FeatureFlag[] {
  if (!raw || typeof raw !== 'object') return [];
  const flags = (raw as { flags?: unknown }).flags;
  if (!Array.isArray(flags)) return [];
  const out: FeatureFlag[] = [];
  for (const item of flags) {
    if (!item || typeof item !== 'object') continue;
    const key = (item as { key?: unknown }).key;
    const enabled = (item as { enabled?: unknown }).enabled;
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof enabled !== 'boolean') continue;
    out.push({ key, value: enabled });
  }
  return out;
}

/** Default flag-cache TTL (15 min): re-fetch after this even without a Realtime nudge. */
export const FLAG_CACHE_TTL_MS = 15 * 60_000;

/** Whether a flag set fetched at `fetchedAt` is still fresh at `now` (offline fallback). */
export function isFlagCacheFresh(
  fetchedAt: number,
  now: number,
  ttlMs: number = FLAG_CACHE_TTL_MS,
): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : FLAG_CACHE_TTL_MS;
  return now - fetchedAt < ttl;
}
