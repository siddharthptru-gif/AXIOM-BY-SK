/**
 * Preferences sync engine (PRD Epoch E §49.3 / §55). The hard, pure parts of
 * cross-device sync: last-writer-wins conflict resolution by server timestamp,
 * additive per-key merge of record maps, and an offline write-queue reconcile
 * (drop server-acked ops, coalesce redundant writes per key). No I/O and no
 * backend dependency — unit-tested. The Main service persists a local mirror +
 * queue; the actual backend push is a later phase (fail-safe: nothing is lost).
 */

export interface SyncRecord {
  key: string;
  body: unknown;
  /** Server-authoritative timestamp (epoch ms) used for LWW ordering. */
  updatedAt: number;
  updatedByDevice?: string;
  deleted?: boolean;
}

export interface QueueOp {
  id: string;
  record: SyncRecord;
  enqueuedAt: number;
}

export interface SyncStatus {
  pending: number;
  mirrored: number;
  lastEnqueuedAt: number | null;
}

/**
 * Last-writer-wins: the newer `updatedAt` wins; on a tie a deletion wins (so a
 * concurrent delete is not resurrected), otherwise `remote` wins (server is
 * authoritative). Either side may be undefined (missing).
 */
export function resolveConflict(
  local: SyncRecord | undefined,
  remote: SyncRecord | undefined,
): SyncRecord | undefined {
  if (!local) return remote;
  if (!remote) return local;
  if (local.updatedAt > remote.updatedAt) return local;
  if (remote.updatedAt > local.updatedAt) return remote;
  if (local.deleted && !remote.deleted) return local;
  if (remote.deleted && !local.deleted) return remote;
  return remote;
}

/** Additive per-key merge of two record maps (union of keys, LWW per key). */
export function mergeRecords(
  local: Record<string, SyncRecord>,
  remote: Record<string, SyncRecord>,
): Record<string, SyncRecord> {
  const out: Record<string, SyncRecord> = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const winner = resolveConflict(local[k], remote[k]);
    if (winner) out[k] = winner;
  }
  return out;
}

/** Drop queued ops the server has acked (by op id); preserve the rest in order. */
export function reconcileQueue(
  pending: readonly QueueOp[],
  ackedIds: readonly string[],
): QueueOp[] {
  const acked = new Set(ackedIds);
  return pending.filter((op) => !acked.has(op.id));
}

/**
 * Collapse a queue so only the latest op per record key remains (older writes to
 * the same key are superseded), reducing redundant backend writes.
 */
export function coalesceQueue(pending: readonly QueueOp[]): QueueOp[] {
  const latest = new Map<string, QueueOp>();
  for (const op of pending) latest.set(op.record.key, op);
  return [...latest.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}
