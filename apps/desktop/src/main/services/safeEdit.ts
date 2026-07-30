import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  captureFiles,
  releaseCheckpointLease,
  restoreGuardedEntries,
  type GuardedRestoreRequest,
} from './snapshots';
import { appendAudit } from './audit';
import { serializeFileMutation } from './fileMutation';
import {
  planBatch,
  summarizePlan,
  type ApplyResult,
  type BatchPlan,
  type FileState,
  type StagedEdit,
} from '../../common/safeEdit';
import type { Checkpoint } from '../../common/snapshot';

/**
 * Safe Edit Engine (Main, PRD Epoch G §142.4 / Phase 172). Batches are
 * serialized, validated against mandatory source hashes, snapshotted under an
 * active lease, and committed with an immediate pre-rename stale check.
 */
function hashOf(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function currentState(path: string): Promise<FileState> {
  try {
    const bytes = await fs.readFile(path);
    return { exists: true, hash: hashOf(bytes) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, hash: '' };
    }
    throw error;
  }
}

async function atomicWrite(
  path: string,
  text: string,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  await beforeCommit?.();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    await beforeCommit?.();
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Read current states of all target files and produce an all-or-nothing plan. */
export async function stageEdits(edits: StagedEdit[]): Promise<BatchPlan> {
  const states = new Map<string, FileState>();
  for (const edit of edits) {
    if (!states.has(edit.path)) states.set(edit.path, await currentState(edit.path));
  }
  return planBatch(edits, states);
}

async function assertEditCurrent(edit: StagedEdit): Promise<void> {
  const state = await currentState(edit.path);
  const plan = planBatch([edit], new Map([[edit.path, state]]));
  if (!plan.ok) throw new Error(summarizePlan(plan));
}

let applyQueue: Promise<void> = Promise.resolve();

function serializeApply<T>(run: () => Promise<T>): Promise<T> {
  const result = applyQueue.then(run, run);
  applyQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function auditWithoutChangingOutcome(type: string, summary: string): Promise<string | null> {
  try {
    await appendAudit(type, summary);
    return null;
  } catch (error) {
    return `Audit recording failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function recoveryRequests(
  checkpoint: Checkpoint,
  edits: readonly StagedEdit[],
  applied: readonly string[],
): GuardedRestoreRequest[] {
  const entries = new Map(checkpoint.entries.map((entry) => [entry.path, entry]));
  const byPath = new Map(edits.map((edit) => [edit.path, edit]));
  const requests: GuardedRestoreRequest[] = [];
  for (const path of applied) {
    const entry = entries.get(path);
    const edit = byPath.get(path);
    if (!entry || !edit) continue;
    const expected: FileState =
      edit.kind === 'delete'
        ? { exists: false, hash: '' }
        : { exists: true, hash: hashOf(edit.newText) };
    requests.push({ entry, expected });
  }
  return requests;
}

async function recoverApplied(
  checkpoint: Checkpoint,
  edits: readonly StagedEdit[],
  applied: readonly string[],
  originalError: string,
): Promise<ApplyResult> {
  const requests = recoveryRequests(checkpoint, edits, applied);
  let restoredPaths = new Set<string>();
  let failed: string[] = [];
  let conflicted: string[] = [];
  let recoveryError: string | null = null;

  try {
    const recovery = await restoreGuardedEntries(requests);
    restoredPaths = new Set(recovery.restoredPaths);
    failed = recovery.failed;
    conflicted = recovery.conflicted;
  } catch (error) {
    recoveryError = error instanceof Error ? error.message : String(error);
  }

  // Only paths Axiom actually committed participate. Untouched checkpoint
  // targets are deliberately excluded even when they triggered the failure.
  const unresolved = applied.filter((path) => !restoredPaths.has(path));
  if (unresolved.length > 0 || recoveryError) {
    const requestedPaths = new Set(requests.map((request) => request.entry.path));
    const missingEntries = applied.filter((path) => !requestedPaths.has(path));
    const details: string[] = [];
    if (conflicted.length > 0) {
      details.push(`changed after Axiom's write (left untouched): ${conflicted.join(', ')}`);
    }
    if (failed.length > 0) details.push(`restore failed: ${failed.join(', ')}`);
    if (missingEntries.length > 0) {
      details.push(`snapshot entry unavailable: ${missingEntries.join(', ')}`);
    }
    if (recoveryError) details.push(`rollback could not run: ${recoveryError}`);
    await auditWithoutChangingOutcome(
      'safeedit.rollback.failed',
      `Recovery incomplete after a Safe Edit failure (${unresolved.length} unresolved committed path(s)): ${unresolved.join(', ')}`,
    );
    return {
      ok: false,
      applied: unresolved,
      runId: checkpoint.runId,
      error: `${originalError}. Recovery incomplete for ${unresolved.length} path(s): ${details.join('; ') || unresolved.join(', ')}`,
      recoveryRequired: true,
    };
  }

  const warning = await auditWithoutChangingOutcome(
    'safeedit.rollback',
    `Rolled back ${applied.length} committed path(s) after a Safe Edit failure`,
  );
  return {
    ok: false,
    applied: [],
    runId: checkpoint.runId,
    error: originalError,
    ...(warning ? { warning } : {}),
  };
}

async function applyCapturedBatch(
  edits: StagedEdit[],
  plan: BatchPlan,
  checkpoint: Checkpoint,
  beforeCommit?: () => Promise<void>,
): Promise<ApplyResult> {
  // Snapshot capture performs asynchronous I/O. Revalidate authorization and the
  // complete batch after capture so queued cancellation/revocation cannot commit.
  await beforeCommit?.();
  const commitPlan = await stageEdits(edits);
  if (!commitPlan.ok) {
    return {
      ok: false,
      applied: [],
      rejected: commitPlan.rejected,
      runId: checkpoint.runId,
      error: summarizePlan(commitPlan),
    };
  }

  const applied: string[] = [];
  try {
    for (const edit of edits) {
      if (edit.kind === 'delete') {
        await beforeCommit?.();
        await assertEditCurrent(edit);
        await beforeCommit?.();
        await fs.rm(edit.path, { force: true });
      } else {
        await atomicWrite(edit.path, edit.newText, async () => {
          await assertEditCurrent(edit);
          await beforeCommit?.();
        });
      }
      applied.push(edit.path);
    }
  } catch (error) {
    return recoverApplied(
      checkpoint,
      edits,
      applied,
      error instanceof Error ? error.message : String(error),
    );
  }

  const warning = await auditWithoutChangingOutcome(
    'safeedit.apply',
    `Applied ${summarizePlan(plan)} (${applied.length} file(s))`,
  );
  return {
    ok: true,
    applied,
    runId: checkpoint.runId,
    ...(warning ? { warning } : {}),
  };
}

/** Validate, lease a snapshot, then atomically apply or guardedly recover a batch. */
async function applyEditsLocked(
  edits: StagedEdit[],
  beforeCommit?: () => Promise<void>,
): Promise<ApplyResult> {
  await beforeCommit?.();
  const plan = await stageEdits(edits);
  if (!plan.ok) {
    return { ok: false, applied: [], rejected: plan.rejected, error: summarizePlan(plan) };
  }

  const checkpoint = await captureFiles(
    edits.map((edit) => edit.path),
    { label: 'Before safe edit', lease: true },
  );

  let result: ApplyResult | null = null;
  let unexpected: unknown;
  try {
    result = await applyCapturedBatch(edits, plan, checkpoint, beforeCommit);
  } catch (error) {
    unexpected = error;
  }

  const retainForRecovery = result !== null && !result.ok && result.applied.length > 0;
  try {
    await releaseCheckpointLease(checkpoint.runId, retainForRecovery);
  } catch (error) {
    const warning = `Snapshot lease cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    await auditWithoutChangingOutcome(
      'snapshot.lease.release.failed',
      `Safe Edit checkpoint lease cleanup failed for run ${checkpoint.runId}`,
    );
    if (result)
      result = { ...result, warning: result.warning ? `${result.warning}. ${warning}` : warning };
  }

  if (unexpected) throw unexpected;
  if (!result) throw new Error('Safe Edit completed without a result.');
  return result;
}

/**
 * Serialize app-owned Safe Edit batches and all explicit checkpoint file
 * mutations in one Main-owned order. applyQueue remains an additional FIFO for
 * Safe Edit callers; the shared coordinator prevents restore/apply interleaving.
 */
export interface ApplyEditsOptions {
  /** Rechecked inside the serialized queue and immediately before every mutation. */
  beforeCommit?: () => Promise<void>;
}

export function applyEdits(
  edits: StagedEdit[],
  options: ApplyEditsOptions = {},
): Promise<ApplyResult> {
  return serializeApply(() =>
    serializeFileMutation(() => applyEditsLocked(edits, options.beforeCommit)),
  );
}
