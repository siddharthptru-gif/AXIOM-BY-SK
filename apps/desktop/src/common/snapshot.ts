/**
 * Snapshot & Checkpoint model (PRD Epoch G §143 / Phase 171). Pure helpers for the
 * trust substrate that makes every AI edit reversible: group snapshot entries into
 * checkpoints (one per edit "run"), decide which to prune by TTL + count, and
 * compute which content objects are still referenced (for content-addressed GC).
 * No I/O — the Main service persists a content-addressed store and calls these.
 */

export interface SnapshotEntry {
  id: string;
  /** Absolute path of the snapshotted file. */
  path: string;
  /** sha256 of the captured content (content-addressed dedup); '' if the file was absent. */
  hash: string;
  size: number;
  createdAt: number;
  /** Groups entries captured together as one checkpoint. */
  runId: string;
  /** Whether the file existed at capture (false → restoring deletes it). */
  existed: boolean;
  label?: string;
  model?: string;
}

export interface Checkpoint {
  runId: string;
  createdAt: number;
  entries: SnapshotEntry[];
  label?: string;
  model?: string;
}

export interface PrunePlan {
  keep: SnapshotEntry[];
  removed: SnapshotEntry[];
}

export interface SnapshotLimits {
  maxCheckpoints: number;
  ttlMs: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxCheckpoints: 100,
  ttlMs: 14 * 24 * 60 * 60 * 1000, // 14 days
};

/** Group entries into checkpoints by runId, newest first (by createdAt). */
export function groupCheckpoints(entries: readonly SnapshotEntry[]): Checkpoint[] {
  const byRun = new Map<string, SnapshotEntry[]>();
  for (const e of entries) {
    const list = byRun.get(e.runId);
    if (list) list.push(e);
    else byRun.set(e.runId, [e]);
  }
  const checkpoints: Checkpoint[] = [];
  for (const [runId, list] of byRun) {
    const createdAt = list.reduce((min, e) => Math.min(min, e.createdAt), Infinity);
    const first = list[0]!;
    checkpoints.push({
      runId,
      createdAt: Number.isFinite(createdAt) ? createdAt : first.createdAt,
      entries: [...list].sort((a, b) => a.path.localeCompare(b.path)),
      ...(first.label !== undefined ? { label: first.label } : {}),
      ...(first.model !== undefined ? { model: first.model } : {}),
    });
  }
  return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Decide which entries to keep. Whole checkpoints are pruned as a unit: first drop
 * checkpoints older than the TTL, then, if still over the count cap, drop the
 * oldest remaining checkpoints. Newest checkpoints are always kept.
 */
export function planPrune(
  entries: readonly SnapshotEntry[],
  limits: SnapshotLimits,
  now: number,
): PrunePlan {
  const checkpoints = groupCheckpoints(entries); // newest first
  const keepRuns = new Set<string>();
  let kept = 0;
  for (const cp of checkpoints) {
    const expired = now - cp.createdAt > limits.ttlMs;
    if (!expired && kept < limits.maxCheckpoints) {
      keepRuns.add(cp.runId);
      kept++;
    }
  }
  const keep: SnapshotEntry[] = [];
  const removed: SnapshotEntry[] = [];
  for (const e of entries) (keepRuns.has(e.runId) ? keep : removed).push(e);
  return { keep, removed };
}

/** Content hashes still referenced by the kept entries (objects not in this set are GC-able). */
export function referencedHashes(entries: readonly SnapshotEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) if (e.hash.length > 0) set.add(e.hash);
  return set;
}
