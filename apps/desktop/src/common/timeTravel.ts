/**
 * Time-travel agent review (Phase 256 — Time-Travel Agent Review).
 *
 * PURE module (no I/O, no Electron). It sits on top of the run JOURNAL
 * (common/runJournal.ts) and the resume model (common/runResume.ts) and adds
 * SCRUB + BRANCH: replay a finished/interrupted run step-by-step, and "redo from
 * step N with a different approach" — branching a new run that PRESERVES the first
 * N steps as history and re-plans from that point.
 *
 * Model:
 *   - ScrubFrame: one reviewable step (label + offset + side-effect + branchable).
 *   - buildScrubTimeline: annotate a run's steps for a scrubber UI.
 *   - listBranchPoints: the step indices you can branch/redo from.
 *   - planBranch: from a run + a branch index, produce a BranchPlan — the kept
 *     prefix (history, NOT re-executed), a continuation context, and validity.
 *     Side-effecting steps in the kept prefix are counted so the caller knows how
 *     much mutating history is preserved (and therefore not redone).
 *
 * The Main agent service consumes planBranch to seed a new run; the Tasks/run
 * timeline renders the scrub frames. Executing the branched run + the scrubber UI
 * are the out-of-core follow-ups (honest partial). Smoke-tested.
 */

import type { RunRecord } from './runJournal';
import { buildTimeline } from './runJournal';

/** Step kinds that mutate the world (already-happened effects preserved on branch). */
const SIDE_EFFECT_KINDS = new Set(['tool']);
/** Step kinds you can meaningfully redo from (decision / action / approval points). */
const BRANCHABLE_KINDS = new Set(['tool', 'plan', 'approval']);

export interface ScrubFrame {
  index: number;
  kind: string;
  label: string;
  /** Offset from run start (ms). */
  offsetMs: number;
  text?: string;
  /** Does this step have external side effects (a tool/command run)? */
  sideEffect: boolean;
  /** Can you branch / redo from this step? */
  branchable: boolean;
}

export interface ScrubTimeline {
  runId: string;
  frames: ScrubFrame[];
  total: number;
  summary: string;
}

/** Annotate a run's steps into a scrubbable timeline (labels + side-effect + branchable). */
export function buildScrubTimeline(run: RunRecord): ScrubTimeline {
  const frames: ScrubFrame[] = buildTimeline(run).map((t) => ({
    index: t.index,
    kind: t.kind,
    label: t.label,
    offsetMs: t.offsetMs,
    ...(t.text !== undefined ? { text: t.text } : {}),
    sideEffect: SIDE_EFFECT_KINDS.has(t.kind),
    branchable: BRANCHABLE_KINDS.has(t.kind),
  }));
  const branchable = frames.filter((f) => f.branchable).length;
  const summary =
    frames.length === 0
      ? 'No steps recorded.'
      : `${frames.length} step${frames.length === 1 ? '' : 's'} · ${branchable} branch point${branchable === 1 ? '' : 's'}`;
  return { runId: run.id, frames, total: frames.length, summary };
}

/** The step indices you can branch / redo from. */
export function listBranchPoints(run: RunRecord): number[] {
  return buildScrubTimeline(run)
    .frames.filter((f) => f.branchable)
    .map((f) => f.index);
}

export interface BranchPlan {
  runId: string;
  /** Step index to redo from (clamped to a valid index; see `valid`). */
  branchIndex: number;
  valid: boolean;
  reason: string;
  /** Steps [0, branchIndex) preserved as history (NOT re-executed). */
  keptSteps: number;
  /** Side-effecting steps in the kept prefix — already happened, preserved. */
  preservedSideEffects: number;
  /** Natural-language seed to re-plan the run from the branch point. */
  context: string;
  summary: string;
}

export interface BranchOptions {
  /** Guidance for the new approach at the branch point. */
  guidance?: string;
}

/**
 * Plan a branch ("redo from step N differently") of a run. Preserves steps
 * [0, branchIndex) as history and produces a continuation context; it never
 * re-executes the preserved prefix, so prior side effects are not duplicated.
 */
export function planBranch(
  run: RunRecord,
  branchIndex: number,
  options: BranchOptions = {},
): BranchPlan {
  const total = run.steps.length;
  const timeline = buildScrubTimeline(run);

  let valid = true;
  let reason: string;
  if (total === 0) {
    valid = false;
    reason = 'Run has no steps to branch from.';
  } else if (!Number.isInteger(branchIndex) || branchIndex < 0 || branchIndex >= total) {
    valid = false;
    reason = `Branch index ${branchIndex} out of range (0..${total - 1}).`;
  } else {
    reason = `Branch from step ${branchIndex + 1}/${total}.`;
  }

  const idx = valid ? branchIndex : 0;
  const keptSteps = valid ? idx : 0;
  const preservedSideEffects = run.steps
    .slice(0, keptSteps)
    .filter((s) => SIDE_EFFECT_KINDS.has(s.kind)).length;

  const frame = timeline.frames[idx];
  const guidance =
    options.guidance !== undefined && options.guidance.trim().length > 0
      ? options.guidance.trim()
      : 'Try a different approach at this step.';
  const contextParts = [
    `Time-travel branch of a previous ${run.preset} agent run.`,
    `Original task: ${run.task}`,
  ];
  if (valid) {
    contextParts.push(
      `Preserving ${keptSteps} earlier step(s) as history; redoing from step ${idx + 1}` +
        (frame ? ` (${frame.label})` : '') +
        '.',
      `New approach: ${guidance}`,
    );
  } else {
    contextParts.push(reason);
  }

  const summary = valid
    ? `Keep ${keptSteps} step(s), redo from step ${idx + 1}` +
      (preservedSideEffects > 0 ? ` · ${preservedSideEffects} prior side-effect(s) preserved` : '')
    : reason;

  return {
    runId: run.id,
    branchIndex: idx,
    valid,
    reason,
    keptSteps,
    preservedSideEffects,
    context: contextParts.join('\n'),
    summary,
  };
}
