/**
 * Agent-run re-invocation (Phase 209/210 — resume/branch EXECUTION).
 *
 * PURE module (no I/O, no Electron). It turns the RESUME plan (runResume) and the
 * time-travel BRANCH plan (timeTravel) into a concrete request to seed a FRESH
 * agent run: a composed task/instruction + the source preset. The Main agent
 * service then starts a normal run with that composed task (reusing the proven
 * `agent:run` path), so "resume" and "redo from step N" become executable rather
 * than just inspectable.
 *
 * Both plans are derivable from the persisted run journal alone (no stored plan
 * needed): resume uses `resumeContext`, branch uses `planBranch` — so this works on
 * any run in history. The composed task is self-contained (it restates the original
 * task + what already happened + what to do next), so the new run needs no extra
 * context plumbing.
 */

import type { RunRecord } from './runJournal';
import { resumeContext } from './runJournal';
import { isRunResumable } from './runResume';
import { planBranch, type BranchOptions } from './timeTravel';

export type ReinvokeKind = 'resume' | 'branch';

export interface ReinvokeRequest {
  kind: ReinvokeKind;
  sourceRunId: string;
  /** Preset (persona + tool scope) to carry into the new run. */
  preset: string;
  /** The composed task/instruction to pass to a fresh agent run. */
  task: string;
  /** True when the source run supports this re-invocation. */
  ok: boolean;
  reason: string;
  summary: string;
}

function truncate(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/**
 * Build a request to RESUME a run: a fresh run seeded with a context that restates
 * the original task, how far the prior run got, and its last output — so the agent
 * continues rather than starting over. `ok` is false for completed/cancelled runs.
 */
export function buildResumeReinvoke(run: RunRecord): ReinvokeRequest {
  const ok = isRunResumable(run);
  const context = resumeContext(run);
  const task = ok
    ? context
    : `${context}\n\n(Note: the prior run ended as "${run.status}"; starting fresh from its task.)`;
  return {
    kind: 'resume',
    sourceRunId: run.id,
    preset: run.preset,
    task,
    ok,
    reason: ok
      ? `Resuming run ${run.id} — ${run.steps.length} step(s) done, status "${run.status}".`
      : `Run ${run.id} is "${run.status}" — re-running its task fresh.`,
    summary: `Resume ${run.preset}: "${truncate(run.task)}".`,
  };
}

/**
 * Build a request to BRANCH a run at `branchIndex` ("redo from step N with a
 * different approach"): a fresh run seeded with the branch context (kept history +
 * the new-approach guidance). `ok` mirrors the branch plan's validity.
 */
export function buildBranchReinvoke(
  run: RunRecord,
  branchIndex: number,
  options: BranchOptions = {},
): ReinvokeRequest {
  const plan = planBranch(run, branchIndex, options);
  return {
    kind: 'branch',
    sourceRunId: run.id,
    preset: run.preset,
    task: plan.context,
    ok: plan.valid,
    reason: plan.reason,
    summary: plan.valid
      ? `Branch ${run.preset} from step ${plan.branchIndex + 1}: "${truncate(run.task)}".`
      : plan.reason,
  };
}

/** Dispatch to the resume/branch builder by kind. */
export function buildReinvoke(
  run: RunRecord,
  kind: ReinvokeKind,
  options: { branchIndex?: number; guidance?: string } = {},
): ReinvokeRequest {
  if (kind === 'branch') {
    return buildBranchReinvoke(
      run,
      options.branchIndex ?? 0,
      options.guidance !== undefined ? { guidance: options.guidance } : {},
    );
  }
  return buildResumeReinvoke(run);
}
