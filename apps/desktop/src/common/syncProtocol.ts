import type { QueueOp, SyncRecord } from './sync';

/**
 * Cloud-sync wire protocol (PRD Epoch E §55). Pure translation between the local
 * sync engine (common/sync) and the Supabase `user_settings` table: build upsert
 * rows from queued ops, parse pulled rows back into local SyncRecords, and list the
 * op ids a successful push acknowledges. No I/O — the Main sync service performs the
 * network round-trip; this keeps the (testable) payload shaping pure. Smoke-tested.
 */

/** A row in the `user_settings` table (server shape). */
export interface SyncRow {
  user_id: string;
  key: string;
  body: unknown;
  /** ISO-8601 timestamp for Postgres `timestamptz`. */
  updated_at: string;
  device?: string;
  deleted?: boolean;
}

/** Build upsert rows for the queued ops (one row per record key). */
export function buildPushRows(ops: readonly QueueOp[], userId: string, device?: string): SyncRow[] {
  return ops.map((op) => ({
    user_id: userId,
    key: op.record.key,
    body: op.record.body ?? null,
    updated_at: new Date(op.record.updatedAt).toISOString(),
    ...(device ? { device } : {}),
    ...(op.record.deleted ? { deleted: true } : {}),
  }));
}

/** Parse rows returned from a pull into a local SyncRecord map (keyed by `key`). */
export function parsePullRows(rows: unknown): Record<string, SyncRecord> {
  const out: Record<string, SyncRecord> = {};
  if (!Array.isArray(rows)) return out;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.key !== 'string' || o.key.length === 0) continue;
    const updatedAt =
      typeof o.updated_at === 'string'
        ? Date.parse(o.updated_at)
        : typeof o.updated_at === 'number'
          ? o.updated_at
          : NaN;
    if (!Number.isFinite(updatedAt)) continue;
    const record: SyncRecord = { key: o.key, body: o.body ?? null, updatedAt };
    if (typeof o.device === 'string' && o.device.length > 0) record.updatedByDevice = o.device;
    if (o.deleted === true) record.deleted = true;
    out[o.key] = record;
  }
  return out;
}

/** The op ids a successful push acknowledges (all pushed ops). */
export function ackedIds(ops: readonly QueueOp[]): string[] {
  return ops.map((op) => op.id);
}

/** Minimum spacing between reconcile pulls triggered by Realtime bursts (2s). */
export const MIN_PULL_INTERVAL_MS = 2000;

/**
 * Debounce gate for the Realtime subscription lifecycle (Phase 120): a burst of
 * `postgres_changes` events should collapse into at most one reconcile pull per
 * `minIntervalMs`. Returns true when a pull should run now given the last pull
 * time (0/never → always pull).
 */
export function shouldPullNow(
  lastPullAt: number,
  now: number,
  minIntervalMs: number = MIN_PULL_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(lastPullAt) || lastPullAt <= 0) return true;
  const min =
    Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : MIN_PULL_INTERVAL_MS;
  return now - lastPullAt >= min;
}
