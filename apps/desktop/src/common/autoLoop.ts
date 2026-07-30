/**
 * Autonomous coding-agent loop controller (PRD Epoch H §131 / Phase 216). The pure
 * OUTER controller that drives goal → plan → act (edit/tools) → verify → iterate
 * until the work is verified or a bound is hit. It is deterministic and I/O-free —
 * the agent service runs the actual ReAct passes + verification commands and feeds
 * each verification verdict back here; this decides the next phase, bounds the
 * iterations, detects no-progress (to avoid thrashing), and produces an honest
 * convergence summary. Smoke-tested.
 *
 * Main uses this controller together with a bounded outer pass loop in the Agent
 * service. A failed check or an edit generation without fresh verification suppresses
 * the model's premature final event and starts another ReAct pass against the current
 * workspace state. The same tool authority, approvals, replay guard, cancellation,
 * checkpoints, and model escalation remain in force on every pass.
 */

export type AutoPhase = 'plan' | 'act' | 'verify' | 'summarize' | 'done' | 'aborted';

export interface AutoLoopConfig {
  /** Hard cap on act→verify iterations. */
  maxIterations: number;
  /** Consecutive non-improving iterations tolerated before aborting. */
  maxNoProgress: number;
}

export const DEFAULT_AUTO_CONFIG: AutoLoopConfig = { maxIterations: 5, maxNoProgress: 2 };

export interface AutoLoopState {
  goal: string;
  phase: AutoPhase;
  /** Completed act→verify cycles. */
  iteration: number;
  /** Failing-check count from the previous verification (null before the first). */
  lastFailureCount: number | null;
  /** Consecutive iterations with no reduction in failures. */
  noProgress: number;
  aborted: boolean;
  reason: string;
  config: AutoLoopConfig;
}

export interface AutonomousPassDecision {
  cancelled: boolean;
  latestMutationVerified: boolean;
  completedPasses: number;
  maxPasses: number;
  convergenceAborted: boolean;
}

/** Continue only for unverified work while a live, bounded convergence budget remains. */
export function shouldContinueAutonomousPass(input: AutonomousPassDecision): boolean {
  return (
    !input.cancelled &&
    !input.latestMutationVerified &&
    !input.convergenceAborted &&
    Number.isSafeInteger(input.completedPasses) &&
    Number.isSafeInteger(input.maxPasses) &&
    input.completedPasses >= 1 &&
    input.maxPasses >= 1 &&
    input.completedPasses < input.maxPasses
  );
}

/** A verification outcome fed back after an act→verify cycle. */
export interface VerifySnapshot {
  /** True when every check in this cycle passed. */
  passed: boolean;
  /** Number of failing checks (used for progress detection). */
  failureCount: number;
}

function posInt(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

function clampConfig(c: Partial<AutoLoopConfig>): AutoLoopConfig {
  return {
    maxIterations: posInt(c.maxIterations, DEFAULT_AUTO_CONFIG.maxIterations),
    maxNoProgress: posInt(c.maxNoProgress, DEFAULT_AUTO_CONFIG.maxNoProgress),
  };
}

/** Start an autonomous run in the planning phase. */
export function createAutoLoop(goal: string, config: Partial<AutoLoopConfig> = {}): AutoLoopState {
  return {
    goal: goal.trim(),
    phase: 'plan',
    iteration: 0,
    lastFailureCount: null,
    noProgress: 0,
    aborted: false,
    reason: 'Planning.',
    config: clampConfig(config),
  };
}

/** Plan drafted → begin acting. No-op unless in the 'plan' phase. */
export function recordPlan(s: AutoLoopState): AutoLoopState {
  if (s.phase !== 'plan') return s;
  return { ...s, phase: 'act', reason: 'Plan ready \u2014 implementing.' };
}

/** Actions (edits/tools) done for this iteration → verify. No-op unless 'act'. */
export function recordAction(s: AutoLoopState): AutoLoopState {
  if (s.phase !== 'act') return s;
  return { ...s, phase: 'verify', reason: 'Verifying the changes.' };
}

/**
 * A verification cycle completed → decide the next phase: `summarize` when green,
 * else `act` to iterate, else `aborted` when the iteration cap or the no-progress
 * cap is hit. No-op unless in the 'verify' phase.
 */
export function recordVerification(s: AutoLoopState, v: VerifySnapshot): AutoLoopState {
  if (s.phase !== 'verify') return s;
  const iteration = s.iteration + 1;
  if (v.passed) {
    return {
      ...s,
      phase: 'summarize',
      iteration,
      lastFailureCount: 0,
      noProgress: 0,
      reason: `Verified after ${iteration} iteration(s).`,
    };
  }
  const failureCount = Math.max(0, Math.floor(v.failureCount));
  const improved = s.lastFailureCount !== null && failureCount < s.lastFailureCount;
  const noProgress = improved ? 0 : s.noProgress + 1;
  const next: AutoLoopState = { ...s, iteration, lastFailureCount: failureCount, noProgress };
  if (iteration >= s.config.maxIterations) {
    return {
      ...next,
      phase: 'aborted',
      aborted: true,
      reason: `Reached the ${s.config.maxIterations}-iteration limit with ${failureCount} failure(s).`,
    };
  }
  if (noProgress >= s.config.maxNoProgress) {
    return {
      ...next,
      phase: 'aborted',
      aborted: true,
      reason: `No progress for ${noProgress} iteration(s) \u2014 stopping.`,
    };
  }
  return {
    ...next,
    phase: 'act',
    reason: improved
      ? `Progress (${failureCount} failing) \u2014 iterating.`
      : `Still ${failureCount} failing \u2014 iterating.`,
  };
}

/** Summary produced → done. No-op unless in the 'summarize' phase. */
export function recordSummary(s: AutoLoopState): AutoLoopState {
  if (s.phase !== 'summarize') return s;
  return { ...s, phase: 'done' };
}

export type AutoAction = 'draft-plan' | 'implement' | 'verify' | 'summarize' | 'stop';

/** What the agent should do next given the current phase. */
export function nextAction(s: AutoLoopState): AutoAction {
  switch (s.phase) {
    case 'plan':
      return 'draft-plan';
    case 'act':
      return 'implement';
    case 'verify':
      return 'verify';
    case 'summarize':
      return 'summarize';
    case 'done':
    case 'aborted':
      return 'stop';
  }
}

/** True when the run has finished (verified) or been stopped (bounded). */
export function isAutoTerminal(s: AutoLoopState): boolean {
  return s.phase === 'done' || s.phase === 'aborted';
}

/** An honest, human-readable convergence summary of the run. */
export function summarizeAutoRun(s: AutoLoopState): string {
  const status =
    s.phase === 'done' ? 'completed' : s.phase === 'aborted' ? 'stopped' : 'in progress';
  return `Autonomous run ${status} after ${s.iteration} iteration(s): ${s.reason}`;
}
