import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { rootLogger } from '@axiom/shared';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { FeatureFlag, FlagContext, FlagValue } from '../../common/ipc';
import {
  DEFAULT_FLAGS,
  evaluateAll,
  evaluateFlag,
  parseFlagsPayload,
  FLAG_CACHE_TTL_MS,
} from '../../common/featureFlags';
import { getSupabase } from './supabase';

/**
 * Feature-flags service (Main, PRD Epoch E §57 / Phase 129). Serves compiled
 * fail-safe defaults, then layers backend-delivered overrides on top: an initial
 * authenticated fetch from the deployed `feature-flags` Edge function, a Supabase
 * Realtime subscription that re-fetches when the `feature_flags` table changes, a
 * periodic safety refresh, and a persisted disk cache for offline/first-paint use.
 * Every layer fails safe (offline → cache → compiled defaults). The evaluation
 * context (app version, OS, a stable local user id for rollout bucketing) is
 * derived locally; the server is authoritative for per-user rollout.
 */
const log = rootLogger.child('featureFlags');
const overrides = new Map<string, FeatureFlag>();

function flagContext(): FlagContext {
  // A stable, non-PII per-install id so percentage rollouts are consistent.
  const userId = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16);
  return { appVersion: app.getVersion(), os: process.platform, userId };
}

function currentFlags(): Record<string, FeatureFlag> {
  const merged: Record<string, FeatureFlag> = { ...DEFAULT_FLAGS };
  for (const [k, f] of overrides) merged[k] = f;
  return merged;
}

/** Resolved values for every flag (defaults ∪ overrides) in the current context. */
export function getAllFlags(): Record<string, FlagValue> {
  return evaluateAll(currentFlags(), flagContext());
}

/** True iff a boolean flag resolves on (unknown flags are off — fail-safe). */
export function isFlagEnabled(key: string): boolean {
  const flag = currentFlags()[key];
  return flag ? evaluateFlag(flag, flagContext()) === true : false;
}

/** Apply backend-provided overrides (Realtime/fetch). Fail-safe: empty = defaults. */
export function setFlagOverrides(list: readonly FeatureFlag[]): void {
  overrides.clear();
  for (const f of list) overrides.set(f.key, f);
}

const CACHE_FILE = 'feature-flags-cache.json';
let cacheFetchedAt = 0;
let channel: RealtimeChannel | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

interface FlagCache {
  fetchedAt: number;
  flags: FeatureFlag[];
}

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_FILE);
}

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readCache(): Promise<FlagCache | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as FlagCache).flags)) {
      const c = parsed as FlagCache;
      return { fetchedAt: typeof c.fetchedAt === 'number' ? c.fetchedAt : 0, flags: c.flags };
    }
  } catch {
    /* no cache yet — compiled defaults apply */
  }
  return null;
}

async function writeCache(cache: FlagCache): Promise<void> {
  const path = cachePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(cache), 'utf-8');
}

/**
 * Load last-known flags from disk so first-paint / offline uses cached values
 * (fail-safe to compiled DEFAULT_FLAGS when there is no cache).
 */
export async function loadCachedFlags(): Promise<void> {
  const cache = await readCache();
  if (cache) {
    setFlagOverrides(cache.flags);
    cacheFetchedAt = cache.fetchedAt;
  }
}

/**
 * Fetch resolved flags from the deployed `feature-flags` Edge function under the
 * signed-in user's identity, apply them as overrides, and persist a cache. No-op
 * (keeps cache/defaults) when signed out or the backend is unreachable — flags are
 * never fatal (Phase 129 fail-safe + exposure logging).
 */
export async function fetchFlags(): Promise<{ ok: boolean; count: number; reason?: string }> {
  try {
    const supa = getSupabase();
    const {
      data: { user },
    } = await supa.auth.getUser();
    if (!user) {
      return { ok: false, count: 0, reason: 'Not signed in — using cached/default flags.' };
    }
    const { data, error } = await supa.functions.invoke('feature-flags', { body: {} });
    if (error) return { ok: false, count: 0, reason: error.message };
    const flags = parseFlagsPayload(data);
    setFlagOverrides(flags);
    cacheFetchedAt = Date.now();
    await writeCache({ fetchedAt: cacheFetchedAt, flags });
    log.info('feature flags fetched (Phase 129)', { count: flags.length });
    return { ok: true, count: flags.length };
  } catch (e) {
    return { ok: false, count: 0, reason: detail(e) };
  }
}

/**
 * Start Realtime feature-flag delivery (Phase 129): seed from the disk cache, do an
 * initial fetch, subscribe to `feature_flags` changes (re-fetch on any change), and
 * run a periodic safety refresh (covers missed Realtime events / rollout widening).
 * Fully best-effort — every layer fails safe to cache → compiled defaults.
 */
export function startFlagSync(): void {
  void loadCachedFlags().then(() => fetchFlags());
  try {
    const supa = getSupabase();
    channel = supa
      .channel('axiom-feature-flags')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feature_flags' }, () => {
        void fetchFlags();
      })
      .subscribe();
  } catch (e) {
    log.warn('feature-flags Realtime unavailable (Phase 129)', { reason: detail(e) });
  }
  if (!pollTimer) {
    pollTimer = setInterval(() => void fetchFlags(), FLAG_CACHE_TTL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }
}

/** Tear down Realtime + the refresh timer (clean shutdown). */
export function stopFlagSync(): void {
  if (channel) {
    try {
      void getSupabase().removeChannel(channel);
    } catch {
      /* best-effort */
    }
    channel = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** When the last successful flag fetch happened (epoch millis; 0 = never). */
export function flagCacheFetchedAt(): number {
  return cacheFetchedAt;
}
