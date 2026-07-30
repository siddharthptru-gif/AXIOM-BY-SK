import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendAudit } from './audit';
import { serializeFileMutation } from './fileMutation';
import { assertAuthorizedMutationPath, assertAuthorizedPath } from './pathAuthorization';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  groupCheckpoints,
  planPrune,
  referencedHashes,
  type Checkpoint,
  type SnapshotEntry,
} from '../../common/snapshot';
import type { FileState } from '../../common/safeEdit';

/**
 * Snapshot store (Main, PRD Epoch G §143 / Phase 171). Every index/object
 * transaction is serialized. Safe Edit checkpoints can be leased so pruning,
 * clear, and GC cannot remove recovery data while a commit is in progress.
 */
function baseDir(): string {
  return join(app.getPath('userData'), 'snapshots');
}
function indexPath(): string {
  return join(baseDir(), 'index.json');
}
function objectPath(hash: string): string {
  return join(baseDir(), 'objects', hash);
}
function recoveryHoldsPath(): string {
  return join(baseDir(), 'recovery-holds.json');
}
function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

let snapshotQueue: Promise<void> = Promise.resolve();
const leasedRunIds = new Set<string>();
/** Runs retained by clear only until their active lease is released. */
const clearAfterLease = new Set<string>();
/** Persisted runs whose automatic rollback was incomplete. */
const recoveryRunIds = new Set<string>();
let recoveryHoldsLoaded = false;

function serializeSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  const result = snapshotQueue.then(operation, operation);
  snapshotQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function ensureRecoveryHoldsLoaded(): Promise<void> {
  if (recoveryHoldsLoaded) return;
  try {
    const raw = await fs.readFile(recoveryHoldsPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((runId) => typeof runId !== 'string')) {
      throw new Error('Snapshot recovery holds have an invalid shape.');
    }
    for (const runId of parsed) recoveryRunIds.add(runId);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  recoveryHoldsLoaded = true;
}

async function writeRecoveryHolds(): Promise<void> {
  await fs.mkdir(baseDir(), { recursive: true });
  const tmp = join(baseDir(), `.axiom-recovery-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify([...recoveryRunIds].sort(), null, 2), 'utf-8');
  try {
    await fs.rename(tmp, recoveryHoldsPath());
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function isProtectedRun(runId: string): boolean {
  return leasedRunIds.has(runId) || recoveryRunIds.has(runId);
}

async function readIndex(): Promise<SnapshotEntry[]> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Snapshot index has an invalid shape.');
    return parsed.filter(
      (entry): entry is SnapshotEntry =>
        !!entry && typeof entry === 'object' && typeof (entry as SnapshotEntry).id === 'string',
    );
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function writeIndex(list: SnapshotEntry[]): Promise<void> {
  const dir = baseDir();
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.axiom-snap-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, indexPath());
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Write a content object if it is not already stored (content-addressed dedup). */
async function writeObject(hash: string, text: string): Promise<void> {
  const path = objectPath(hash);
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.access(path);
    return;
  } catch {
    // A failed write below remains fail-closed; access is only an optimization.
  }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function readCurrent(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Delete content objects no longer referenced by any retained entry. */
async function gcObjects(kept: SnapshotEntry[]): Promise<void> {
  const referenced = referencedHashes(kept);
  const dir = join(baseDir(), 'objects');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(
    files
      .filter((file) => !file.endsWith('.tmp') && !referenced.has(file))
      .map((file) => fs.rm(join(dir, file), { force: true }).catch(() => undefined)),
  );
}

/** Apply normal retention while forcibly preserving leased and recovery-held runs. */
async function persistPruned(index: SnapshotEntry[]): Promise<void> {
  await ensureRecoveryHoldsLoaded();
  const candidates = index.filter(
    (entry) => isProtectedRun(entry.runId) || !clearAfterLease.has(entry.runId),
  );
  const { keep: planned } = planPrune(candidates, DEFAULT_SNAPSHOT_LIMITS, Date.now());
  const keptIds = new Set(planned.map((entry) => entry.id));
  const keep = [...planned];
  for (const entry of candidates) {
    if (isProtectedRun(entry.runId) && !keptIds.has(entry.id)) {
      keep.push(entry);
      keptIds.add(entry.id);
    }
  }
  await writeIndex(keep);
  await gcObjects(keep);
}

export interface SnapshotCaptureOptions {
  label?: string;
  model?: string;
  /** Keep this run's index entries and objects until explicitly released. */
  lease?: boolean;
}

/** Capture the given files into a new checkpoint (snapshot-before-edit). */
export function captureFiles(
  paths: string[],
  meta: SnapshotCaptureOptions = {},
): Promise<Checkpoint> {
  return serializeSnapshot(async () => {
    const runId = randomUUID();
    const createdAt = Date.now();
    if (meta.lease) leasedRunIds.add(runId);
    try {
      const index = await readIndex();
      const entries: SnapshotEntry[] = [];
      for (const path of paths) {
        const content = await readCurrent(path);
        const existed = content !== null;
        const hash = existed ? hashOf(content) : '';
        if (existed) await writeObject(hash, content);
        const entry: SnapshotEntry = {
          id: randomUUID(),
          path,
          hash,
          size: existed ? Buffer.byteLength(content, 'utf-8') : 0,
          createdAt,
          runId,
          existed,
          ...(meta.label !== undefined ? { label: meta.label } : {}),
          ...(meta.model !== undefined ? { model: meta.model } : {}),
        };
        entries.push(entry);
        index.push(entry);
      }
      await persistPruned(index);
      await appendAudit(
        'snapshot.capture',
        `Captured ${entries.length} file(s)${meta.label ? ` — ${meta.label}` : ''}`,
      );
      return {
        runId,
        createdAt,
        entries,
        ...(meta.label !== undefined ? { label: meta.label } : {}),
        ...(meta.model !== undefined ? { model: meta.model } : {}),
      };
    } catch (error) {
      leasedRunIds.delete(runId);
      clearAfterLease.delete(runId);
      throw error;
    }
  });
}

async function authorizedEntries(entries: readonly SnapshotEntry[]): Promise<SnapshotEntry[]> {
  const checks = await Promise.all(
    entries.map(async (entry) => {
      try {
        await assertAuthorizedPath(entry.path, { allowMissing: true });
        return entry;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((entry): entry is SnapshotEntry => entry !== null);
}

export function listCheckpoints(): Promise<Checkpoint[]> {
  return serializeSnapshot(async () =>
    groupCheckpoints(await authorizedEntries(await readIndex())),
  );
}

/** The captured content of an authorized snapshot entry, or null when unavailable. */
export function readEntryContent(entryId: string): Promise<string | null> {
  return serializeSnapshot(async () => {
    const entry = (await readIndex()).find((candidate) => candidate.id === entryId);
    if (!entry || !entry.existed || entry.hash.length === 0) return null;
    if ((await authorizedEntries([entry])).length === 0) return null;
    try {
      return await fs.readFile(objectPath(entry.hash), 'utf-8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
}

class RestoreConflictError extends Error {
  constructor(readonly path: string) {
    super(`The file changed after Axiom committed it: ${path}`);
    this.name = 'RestoreConflictError';
  }
}

async function assertExpectedState(path: string, expected: FileState): Promise<void> {
  const content = await readCurrent(path);
  const actual: FileState =
    content === null ? { exists: false, hash: '' } : { exists: true, hash: hashOf(content) };
  if (
    actual.exists !== expected.exists ||
    (actual.exists && actual.hash.toLowerCase() !== expected.hash.toLowerCase())
  ) {
    throw new RestoreConflictError(path);
  }
}

/** Restore one entry, optionally guarded by Axiom's expected committed output. */
async function applyRestore(entry: SnapshotEntry, expected?: FileState): Promise<void> {
  // Recheck persisted snapshot paths at restore time. Ancestor symlinks are
  // canonicalized, but the selected leaf is retained so a replacement symlink
  // is removed/replaced rather than its referent being mutated.
  const path = await assertAuthorizedMutationPath(entry.path, { allowMissing: true });
  if (!entry.existed) {
    if (expected) await assertExpectedState(path, expected);
    await fs.rm(path, { force: true });
    return;
  }

  const text = await fs.readFile(objectPath(entry.hash), 'utf-8');
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    // The guard is intentionally after the replacement is prepared and directly
    // before rename, minimizing the external-editor race window.
    if (expected) await assertExpectedState(path, expected);
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Restore a single snapshotted file after an explicit user request. */
export function restoreEntry(entryId: string): Promise<{ path: string } | null> {
  return serializeFileMutation(() =>
    serializeSnapshot(async () => {
      const entry = (await readIndex()).find((candidate) => candidate.id === entryId);
      if (!entry || (await authorizedEntries([entry])).length === 0) return null;
      await applyRestore(entry);
      await appendAudit('snapshot.restore', `Restored ${entry.path}`);
      return { path: entry.path };
    }),
  );
}

/** Restore all files in a checkpoint after an explicit user request. */
export function restoreCheckpoint(
  runId: string,
): Promise<{ restored: number; restoredPaths: string[]; failed: string[] }> {
  return serializeFileMutation(() =>
    serializeSnapshot(async () => {
      await ensureRecoveryHoldsLoaded();
      const index = await readIndex();
      const checkpointEntries = index.filter((entry) => entry.runId === runId);
      const entries = await authorizedEntries(checkpointEntries);
      const restoredPaths: string[] = [];
      const failed: string[] = [];
      for (const entry of entries) {
        try {
          await applyRestore(entry);
          restoredPaths.push(entry.path);
        } catch {
          failed.push(entry.path);
        }
      }
      const restored = restoredPaths.length;

      // Only a complete, explicit whole-checkpoint restore resolves a durable
      // recovery hold. A one-file restore or partial failure keeps the run safe.
      if (
        checkpointEntries.length > 0 &&
        entries.length === checkpointEntries.length &&
        failed.length === 0 &&
        recoveryRunIds.has(runId)
      ) {
        recoveryRunIds.delete(runId);
        try {
          await writeRecoveryHolds();
        } catch (error) {
          recoveryRunIds.add(runId);
          throw error;
        }
        await persistPruned(index);
        clearAfterLease.delete(runId);
      }

      await appendAudit(
        failed.length === 0 ? 'snapshot.restore' : 'snapshot.restore.failed',
        failed.length === 0
          ? `Restored checkpoint (${restored} file(s))`
          : `Checkpoint restore incomplete (${restored} restored, ${failed.length} failed)`,
      );
      return { restored, restoredPaths, failed };
    }),
  );
}

export interface GuardedRestoreRequest {
  /** The trusted entry returned by the leased capture. */
  entry: SnapshotEntry;
  /** State Axiom itself committed; restoration is skipped if it no longer matches. */
  expected: FileState;
}

export interface GuardedRestoreResult {
  restored: number;
  restoredPaths: string[];
  failed: string[];
  conflicted: string[];
}

/**
 * Restore selected leased entries only when each target still equals Axiom's
 * committed output. Every request is attempted, even after an earlier failure.
 */
export function restoreGuardedEntries(
  requests: readonly GuardedRestoreRequest[],
): Promise<GuardedRestoreResult> {
  return serializeSnapshot(async () => {
    const indexed = new Map((await readIndex()).map((entry) => [entry.id, entry]));
    const restoredPaths: string[] = [];
    const failed: string[] = [];
    const conflicted: string[] = [];
    for (const request of requests) {
      const entry = indexed.get(request.entry.id);
      if (
        !entry ||
        entry.runId !== request.entry.runId ||
        entry.path !== request.entry.path ||
        !leasedRunIds.has(entry.runId)
      ) {
        failed.push(request.entry.path);
        continue;
      }
      try {
        await applyRestore(entry, request.expected);
        restoredPaths.push(entry.path);
      } catch (error) {
        if (error instanceof RestoreConflictError) conflicted.push(entry.path);
        else failed.push(entry.path);
      }
    }
    return {
      restored: restoredPaths.length,
      restoredPaths,
      failed: [...new Set(failed)],
      conflicted: [...new Set(conflicted)],
    };
  });
}

/**
 * Release a Safe Edit lease and apply deferred retention work. Incomplete
 * rollback runs become durable recovery holds before their lease is removed.
 */
export function releaseCheckpointLease(runId: string, retainForRecovery = false): Promise<void> {
  return serializeSnapshot(async () => {
    await ensureRecoveryHoldsLoaded();
    leasedRunIds.delete(runId);

    if (retainForRecovery) {
      recoveryRunIds.add(runId);
      // A Clear requested while the Safe Edit was active predates the failed
      // rollback and must not destroy the newly required recovery checkpoint.
      clearAfterLease.delete(runId);
      // Keep the in-memory hold even if persistence fails, so this process still
      // protects the checkpoint and the caller can surface a cleanup warning.
      await writeRecoveryHolds();
    }

    const index = await readIndex();
    await persistPruned(index);
    clearAfterLease.delete(runId);
  });
}

/**
 * Clear all idle checkpoints. This is an explicit abandonment of idle recovery
 * holds; active leases remain deferred until release, unless that release first
 * establishes a newer incomplete-rollback recovery hold.
 */
export function clearSnapshots(): Promise<void> {
  return serializeSnapshot(async () => {
    await ensureRecoveryHoldsLoaded();
    const abandonedRecoveryRuns = [...recoveryRunIds].filter((runId) => !leasedRunIds.has(runId));
    for (const runId of abandonedRecoveryRuns) recoveryRunIds.delete(runId);
    if (abandonedRecoveryRuns.length > 0) {
      try {
        await writeRecoveryHolds();
      } catch (error) {
        for (const runId of abandonedRecoveryRuns) recoveryRunIds.add(runId);
        throw error;
      }
    }

    const index = await readIndex();
    const keep = index.filter((entry) => leasedRunIds.has(entry.runId));
    await writeIndex(keep);
    await gcObjects(keep);

    for (const runId of [...clearAfterLease]) {
      if (!leasedRunIds.has(runId)) clearAfterLease.delete(runId);
    }
    for (const entry of keep) clearAfterLease.add(entry.runId);

    const retainedRuns = new Set(keep.map((entry) => entry.runId)).size;
    const details: string[] = [];
    if (retainedRuns > 0) {
      details.push(`deferred ${retainedRuns} active leased checkpoint(s)`);
    }
    if (abandonedRecoveryRuns.length > 0) {
      details.push(`abandoned ${abandonedRecoveryRuns.length} recovery checkpoint(s)`);
    }
    await appendAudit(
      'snapshot.clear',
      details.length > 0 ? `Cleared snapshots; ${details.join('; ')}` : 'Cleared all snapshots',
    );
  });
}
