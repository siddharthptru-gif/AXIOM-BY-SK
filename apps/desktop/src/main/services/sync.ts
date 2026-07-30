import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { rootLogger } from '@axiom/shared';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { QueueOp, SyncRecord, SyncStatus } from '../../common/sync';
import { coalesceQueue, mergeRecords, reconcileQueue } from '../../common/sync';
import {
  buildPushRows,
  parsePullRows,
  ackedIds,
  shouldPullNow,
  MIN_PULL_INTERVAL_MS,
} from '../../common/syncProtocol';
import { getSupabase } from './supabase';
import { readSettings } from './settings';

/**
 * Preferences sync engine (Main, PRD Epoch E §49.3/§55 / Phase 120). Maintains a
 * local mirror of synced records and an offline write queue (pure engine in
 * common/sync). Reads always succeed from the mirror (offline layer); writes queue
 * locally. `flushQueue` pushes the coalesced queue to the deployed `user_settings`
 * table (upsert) then pulls + LWW-merges remote records back. `startSyncEngine`
 * activates the cloud lifecycle: an initial reconcile, a Supabase Realtime
 * subscription that pulls+merges on remote changes (debounced), and a periodic
 * flush. Best-effort + queue-safe — offline / signed-out keeps the queue intact
 * (no data loss). All local (INV-4) until the user is signed in.
 */
const MIRROR_FILE = 'sync-mirror.json';
const QUEUE_FILE = 'sync-queue.json';
/** The Supabase table cross-device preferences sync upserts into (see setup SQL doc). */
const SYNC_TABLE = 'user_settings';

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pathFor(name: string): string {
  return join(app.getPath('userData'), name);
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(pathFor(name), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(name: string, data: unknown): Promise<void> {
  const path = pathFor(name);
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-sync-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function cloudSafeRecord(record: SyncRecord): SyncRecord {
  if (record.key !== 'user.settings' || !record.body || typeof record.body !== 'object') {
    return record;
  }
  const body = { ...(record.body as Record<string, unknown>) };
  // Arbitrary provider headers may contain API keys or bearer tokens. They are
  // local-only configuration and must never enter the cloud mirror or queue.
  delete body['ai.custom.headers'];
  return { ...record, body };
}

async function getMirror(): Promise<Record<string, SyncRecord>> {
  const mirror = await readJson<Record<string, SyncRecord>>(MIRROR_FILE, {});
  const settings = mirror['user.settings'];
  if (settings) mirror['user.settings'] = cloudSafeRecord(settings);
  return mirror;
}
async function getQueue(): Promise<QueueOp[]> {
  return (await readJson<QueueOp[]>(QUEUE_FILE, [])).map((op) => ({
    ...op,
    record: cloudSafeRecord(op.record),
  }));
}

let cachedDeviceId: string | null = null;
/** A stable per-install device id (persisted), used to tag outgoing sync rows. */
async function deviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = await readJson<{ id?: string }>('sync-device.json', {});
  const id = typeof existing.id === 'string' && existing.id.length > 0 ? existing.id : randomUUID();
  if (id !== existing.id) await writeJson('sync-device.json', { id });
  cachedDeviceId = id;
  return id;
}

function statusOf(mirror: Record<string, SyncRecord>, queue: readonly QueueOp[]): SyncStatus {
  const last = queue[queue.length - 1];
  return {
    pending: queue.length,
    mirrored: Object.keys(mirror).length,
    lastEnqueuedAt: last ? last.enqueuedAt : null,
  };
}

/** Queue a preference change: write the mirror + append a (coalesced) queue op. */
export async function enqueueChange(key: string, body: unknown): Promise<SyncStatus> {
  const now = Date.now();
  const record = cloudSafeRecord({ key, body, updatedAt: now });
  const mirror = await getMirror();
  mirror[key] = record;
  await writeJson(MIRROR_FILE, mirror);
  const queue = coalesceQueue([
    ...(await getQueue()),
    { id: randomUUID(), record, enqueuedAt: now },
  ]);
  await writeJson(QUEUE_FILE, queue);
  return statusOf(mirror, queue);
}

/** Snapshot the current user settings into the sync mirror + queue (one record). */
export async function snapshotSettings(): Promise<SyncStatus> {
  return enqueueChange('user.settings', await readSettings());
}

/** Merge server-provided records into the local mirror (LWW). */
export async function applyRemote(
  remote: Record<string, SyncRecord>,
): Promise<Record<string, SyncRecord>> {
  const safeRemote: Record<string, SyncRecord> = {};
  let needsCloudScrub = false;
  let newestLegacyTimestamp = 0;
  for (const [key, record] of Object.entries(remote)) {
    const hasCustomHeaders =
      record.key === 'user.settings' &&
      !!record.body &&
      typeof record.body === 'object' &&
      Object.prototype.hasOwnProperty.call(record.body, 'ai.custom.headers');
    safeRemote[key] = cloudSafeRecord(record);
    if (hasCustomHeaders) {
      needsCloudScrub = true;
      newestLegacyTimestamp = Math.max(newestLegacyTimestamp, record.updatedAt);
    }
  }

  const merged = mergeRecords(await getMirror(), safeRemote);
  if (needsCloudScrub) {
    const winner = merged['user.settings'];
    if (winner) {
      // Queue the sanitized LWW winner (never the stale remote body) and make its
      // version strictly newer than both sides, even when another clock is ahead.
      const now = Date.now();
      const cleanup = cloudSafeRecord({
        ...winner,
        updatedAt: Math.max(now, winner.updatedAt + 1, newestLegacyTimestamp + 1),
      });
      merged['user.settings'] = cleanup;
      const queue = coalesceQueue([
        ...(await getQueue()),
        { id: randomUUID(), record: cleanup, enqueuedAt: now },
      ]);
      await writeJson(QUEUE_FILE, queue);
    }
  }
  await writeJson(MIRROR_FILE, merged);
  return merged;
}

/**
 * Flush the offline queue to Supabase, then pull remote records back and merge them
 * (LWW). Best-effort and queue-safe: when signed out or the `user_settings` table
 * isn't provisioned yet, the queue is kept intact (no data loss) and a reason is
 * returned. Requires the one-time SQL in docs/SUPABASE_SYNC_SETUP.md.
 */
export async function flushQueue(): Promise<{ flushed: number; reason?: string }> {
  const supa = getSupabase();
  let userId: string;
  try {
    const { data, error } = await supa.auth.getUser();
    if (error || !data.user) {
      return { flushed: 0, reason: 'Not signed in — cloud sync is offline.' };
    }
    userId = data.user.id;
  } catch (e) {
    return { flushed: 0, reason: `Cloud sync unavailable: ${detail(e)}` };
  }

  // Push queued writes (coalesced to the latest per key).
  const outgoing = coalesceQueue(await getQueue());
  let flushed = 0;
  if (outgoing.length > 0) {
    try {
      const rows = buildPushRows(outgoing, userId, await deviceId());
      const { error } = await supa.from(SYNC_TABLE).upsert(rows, { onConflict: 'user_id,key' });
      if (error) {
        return {
          flushed: 0,
          reason: `Sync deferred (is the setup SQL applied?): ${error.message}`,
        };
      }
      await writeJson(QUEUE_FILE, reconcileQueue(await getQueue(), ackedIds(outgoing)));
      flushed = outgoing.length;
    } catch (e) {
      return { flushed: 0, reason: `Sync deferred: ${detail(e)}` };
    }
  }

  // Pull remote records + merge into the mirror (best-effort).
  try {
    const { data, error } = await supa
      .from(SYNC_TABLE)
      .select('key, body, updated_at, device, deleted')
      .eq('user_id', userId);
    if (!error && data) await applyRemote(parsePullRows(data));
  } catch {
    /* pull is best-effort — a push already succeeded */
  }
  return { flushed };
}

export async function getStatus(): Promise<SyncStatus> {
  return statusOf(await getMirror(), await getQueue());
}

// --- Cloud sync lifecycle (Phase 120): Realtime subscription + periodic flush ---

const SYNC_FLUSH_INTERVAL_MS = 5 * 60_000;
const log = rootLogger.child('sync');
let channel: RealtimeChannel | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pullTrailingTimer: ReturnType<typeof setTimeout> | null = null;
let lastPullAt = 0;

/** Pull remote records for a user and LWW-merge them into the local mirror. */
async function pullRemote(userId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from(SYNC_TABLE)
    .select('key, body, updated_at, device, deleted')
    .eq('user_id', userId);
  lastPullAt = Date.now();
  if (!error && data) await applyRemote(parsePullRows(data));
}

/** Pull for the signed-in user (best-effort; no-op when signed out). */
async function pullForCurrentUser(): Promise<void> {
  try {
    const { data, error } = await getSupabase().auth.getUser();
    if (error || !data.user) return;
    await pullRemote(data.user.id);
  } catch {
    /* best-effort — the periodic flush will retry */
  }
}

/** Handle a Realtime change with leading + trailing debounce to coalesce bursts. */
function handleRemoteChange(): void {
  const now = Date.now();
  if (shouldPullNow(lastPullAt, now)) {
    void pullForCurrentUser();
  } else if (!pullTrailingTimer) {
    const wait = Math.max(0, MIN_PULL_INTERVAL_MS - (now - lastPullAt));
    pullTrailingTimer = setTimeout(() => {
      pullTrailingTimer = null;
      void pullForCurrentUser();
    }, wait);
    if (typeof pullTrailingTimer.unref === 'function') pullTrailingTimer.unref();
  }
}

/**
 * Activate the cloud sync lifecycle (Phase 120): an initial reconcile (push queued
 * writes + pull), a Supabase Realtime subscription on `user_settings` that
 * pulls+merges on remote changes (debounced), and a periodic flush that covers
 * offline→online transitions + missed Realtime events. Best-effort — signed-out /
 * offline keeps the local queue intact (no data loss).
 */
export function startSyncEngine(): void {
  void flushQueue().catch(() => undefined);
  try {
    channel = getSupabase()
      .channel('axiom-user-settings')
      .on('postgres_changes', { event: '*', schema: 'public', table: SYNC_TABLE }, () => {
        handleRemoteChange();
      })
      .subscribe();
  } catch (e) {
    log.warn('sync Realtime unavailable (Phase 120)', { reason: detail(e) });
  }
  if (!flushTimer) {
    flushTimer = setInterval(
      () => void flushQueue().catch(() => undefined),
      SYNC_FLUSH_INTERVAL_MS,
    );
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }
}

/** Tear down the Realtime subscription + timers (clean shutdown). */
export function stopSyncEngine(): void {
  if (channel) {
    try {
      void getSupabase().removeChannel(channel);
    } catch {
      /* best-effort */
    }
    channel = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (pullTrailingTimer) {
    clearTimeout(pullTrailingTimer);
    pullTrailingTimer = null;
  }
}
