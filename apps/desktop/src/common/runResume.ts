/**
 * Agent-run resume / checkpoint depth (Phase 209/210 — Run Persistence & Resume).
 *
 * PURE module (no I/O, no Electron). It sits on top of the run JOURNAL
 * (common/runJournal.ts, which records a run's step timeline) and adds the missing
 * RESUME half: a checkpoint that tracks which PLAN steps a run has completed, and a
 * resume plan that lets an interrupted run continue from where it stopped WITHOUT
 * re-executing finished work — the key property when steps have side effects (file
 * writes, shell commands): replaying them would duplicate edits or re-run commands.
 *
 * Model:
 *   - PlanStep: one step of a plan-first agent run (id + title + side-effect flag).
 *   - RunCheckpoint: the run's identity/status + its plan + the set of completed
 *     step ids (the replay-safe skip set) + a linear cursor.
 *   - completeStep: fold a finished step into the checkpoint (idempotent).
 *   - planResume: from a checkpoint, compute { skip, remaining, cursor, resumable,
 *     context } — completed steps are skipped, side-effecting skips are counted so
 *     the caller knows how many mutating steps are being intentionally NOT replayed.
 *   - checkpointFromRun: a best-effort checkpoint reconstructed from a persisted
 *     journal alone (when no explicit checkpoint was saved).
 *
 * The Main agent service persists checkpoints (userData JSON) and consumes the
 * resume plan; the Tasks panel can show remaining steps. Smoke-tested.
 */

import type { RunRecord, RunStatus } from './runJournal';
import { isRunTerminal } from './runJournal';

export interface PlanStep {
  id: string;
  title: string;
  /** True when executing this step mutates the world (writes/commands) — never replayed. */
  sideEffect?: boolean;
}

export interface RunCheckpoint {
  runId: string;
  preset: string;
  task: string;
  status: RunStatus;
  /** The plan-first step list this run is executing. */
  plan: PlanStep[];
  /** Ids of plan steps already completed (order-independent skip set). */
  completedStepIds: string[];
  /** Linear cursor: index of the first not-yet-completed plan step. */
  cursor: number;
  updatedAt: number;
}

export interface ResumePlan {
  /** Can this run be meaningfully resumed (work remains + not completed)? */
  resumable: boolean;
  reason: string;
  /** Index of the first remaining step (== plan.length when all done). */
  cursor: number;
  /** Completed steps — skipped, never re-executed (replay-safe). */
  skip: PlanStep[];
  /** Steps still to execute, in plan order. */
  remaining: PlanStep[];
  /** How many skipped steps had side effects (mutating steps NOT replayed). */
  sideEffectsSkipped: number;
  /** Natural-language context to hand the model when continuing the run. */
  context: string;
  summary: string;
}

/** First plan index whose id is not in `completed` (plan.length when all done). */
function firstIncomplete(plan: readonly PlanStep[], completed: ReadonlySet<string>): number {
  const idx = plan.findIndex((s) => !completed.has(s.id));
  return idx < 0 ? plan.length : idx;
}

/** Begin a checkpoint for a run + its plan (nothing completed yet). */
export function initCheckpoint(
  run: Pick<RunRecord, 'id' | 'preset' | 'task' | 'status'>,
  plan: readonly PlanStep[],
  now: number,
): RunCheckpoint {
  return {
    runId: run.id,
    preset: run.preset,
    task: run.task,
    status: run.status,
    plan: plan.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.sideEffect ? { sideEffect: true } : {}),
    })),
    completedStepIds: [],
    cursor: 0,
    updatedAt: now,
  };
}

/** Mark a plan step complete (idempotent) and advance the linear cursor. */
export function completeStep(cp: RunCheckpoint, stepId: string, now: number): RunCheckpoint {
  const completedStepIds = cp.completedStepIds.includes(stepId)
    ? cp.completedStepIds
    : [...cp.completedStepIds, stepId];
  const completed = new Set(completedStepIds);
  return {
    ...cp,
    completedStepIds,
    cursor: firstIncomplete(cp.plan, completed),
    updatedAt: now,
  };
}

/** Update a checkpoint's status (e.g. failed / cancelled / awaiting-approval). */
export function setStatus(cp: RunCheckpoint, status: RunStatus, now: number): RunCheckpoint {
  return { ...cp, status, updatedAt: now };
}

/** A run is resumable when it isn't finished and has remaining planned work. */
export function isResumable(cp: RunCheckpoint): boolean {
  if (cp.status === 'completed') return false;
  const completed = new Set(cp.completedStepIds);
  return cp.plan.some((s) => !completed.has(s.id));
}

/**
 * Record-level resumability (no plan needed): a persisted run can be resumed unless
 * it finished cleanly or was cancelled. Used to list interrupted runs for a "resume"
 * affordance without reconstructing a full checkpoint.
 */
export function isRunResumable(run: Pick<RunRecord, 'status'>): boolean {
  return run.status !== 'completed' && run.status !== 'cancelled';
}

function resumeInstruction(cp: RunCheckpoint, skip: PlanStep[], remaining: PlanStep[]): string {
  const parts = [
    `Resuming a previous ${cp.preset} agent run — do NOT repeat already-completed work.`,
    `Original task: ${cp.task}`,
    `${skip.length} of ${cp.plan.length} planned step(s) are already done.`,
  ];
  if (skip.length > 0) parts.push(`Completed (skip): ${skip.map((s) => s.title).join('; ')}`);
  if (remaining.length > 0) {
    parts.push(`Continue with: ${remaining.map((s) => s.title).join('; ')}`);
  }
  return parts.join('\n');
}

/**
 * Build a resume plan from a checkpoint: which steps to skip vs execute, whether
 * the run is resumable, and a continuation context. Replay-safe: any step whose id
 * is in the completed set is skipped regardless of order, so side-effecting steps
 * are never run twice.
 */
export function planResume(cp: RunCheckpoint): ResumePlan {
  const completed = new Set(cp.completedStepIds);
  const skip = cp.plan.filter((s) => completed.has(s.id));
  const remaining = cp.plan.filter((s) => !completed.has(s.id));
  const cursor = firstIncomplete(cp.plan, completed);
  const sideEffectsSkipped = skip.filter((s) => s.sideEffect === true).length;

  let resumable = true;
  let reason: string;
  if (cp.status === 'completed') {
    resumable = false;
    reason = 'Run already completed — nothing to resume.';
  } else if (cp.plan.length === 0) {
    resumable = false;
    reason = 'No plan recorded — cannot compute a resume point.';
  } else if (remaining.length === 0) {
    resumable = false;
    reason = 'All planned steps already completed.';
  } else {
    reason = `Resume at step ${cursor + 1}/${cp.plan.length} (${remaining.length} remaining).`;
  }

  const summary =
    `${skip.length}/${cp.plan.length} done · ${remaining.length} remaining` +
    (sideEffectsSkipped > 0 ? ` · ${sideEffectsSkipped} side-effecting skipped` : '') +
    (resumable ? '' : ' · not resumable');

  return {
    resumable,
    reason,
    cursor,
    skip,
    remaining,
    sideEffectsSkipped,
    context: resumeInstruction(cp, skip, remaining),
    summary,
  };
}

export interface FromRunOptions {
  /** Journal step kinds that count as a completed plan step (default: ['tool']). */
  completedKinds?: readonly string[];
}

/**
 * Reconstruct a best-effort checkpoint from a persisted run journal alone (used
 * when no explicit checkpoint was saved, e.g. after a crash). Since journal steps
 * don't carry plan-step ids, it maps the first N completed execution steps onto the
 * first N plan steps (N = count of steps whose kind is in `completedKinds`).
 */
export function checkpointFromRun(
  run: RunRecord,
  plan: readonly PlanStep[],
  options: FromRunOptions = {},
): RunCheckpoint {
  const kinds = new Set(options.completedKinds ?? ['tool']);
  const executed = run.steps.filter((s) => kinds.has(s.kind)).length;
  const doneCount = Math.min(executed, plan.length);
  const planCopy = plan.map((s) => ({
    id: s.id,
    title: s.title,
    ...(s.sideEffect ? { sideEffect: true } : {}),
  }));
  const completedStepIds = planCopy.slice(0, doneCount).map((s) => s.id);
  const completed = new Set(completedStepIds);
  return {
    runId: run.id,
    preset: run.preset,
    task: run.task,
    status: isRunTerminal(run.status) ? run.status : 'running',
    plan: planCopy,
    completedStepIds,
    cursor: firstIncomplete(planCopy, completed),
    updatedAt: run.endedAt ?? run.startedAt,
  };
}
