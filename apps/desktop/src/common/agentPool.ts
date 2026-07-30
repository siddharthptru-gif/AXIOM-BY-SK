import { planAdmissions, type SchedulableTask } from './agentScheduler';

/**
 * Bounded agent pool state machine (PRD Epoch H / Phases 218 Background Agents +
 * 219 Parallel Agents). The pure, deterministic core the Main agent service uses
 * to ENFORCE a concurrency ceiling: `submit` a run and it is either admitted now
 * or queued; when a run finishes (`complete`) or is cancelled (`remove`) the freed
 * slot admits the next queued run(s) in fair order (via agentScheduler). No I/O —
 * the service resolves the actual run Promises from the `admit` lists returned,
 * and the state is threaded through explicitly, so every transition is testable.
 */

export interface PoolState {
  /** Ids of runs currently occupying a slot (running or awaiting approval). */
  running: string[];
  /** Queued runs waiting for a slot, in submit order. */
  queued: SchedulableTask[];
  maxConcurrent: number;
}

export interface PoolTransition {
  state: PoolState;
  /** Ids newly moved from queued → running by this transition (start these). */
  admit: string[];
}

export function createPool(maxConcurrent: number): PoolState {
  const max = Number.isFinite(maxConcurrent) && maxConcurrent >= 1 ? Math.floor(maxConcurrent) : 1;
  return { running: [], queued: [], maxConcurrent: max };
}

/** Drain the queue up to the ceiling, moving admitted tasks queued → running. */
function drain(state: PoolState): PoolTransition {
  const plan = planAdmissions({
    queued: state.queued,
    running: state.running.length,
    maxConcurrent: state.maxConcurrent,
  });
  if (plan.admit.length === 0) return { state, admit: [] };
  const admitSet = new Set(plan.admit);
  const queued = state.queued.filter((t) => !admitSet.has(t.id));
  const running = [...state.running, ...plan.admit];
  return { state: { ...state, running, queued }, admit: plan.admit };
}

/** Submit a new run: admit it now if a slot is free, else queue it. Idempotent. */
export function submit(state: PoolState, task: SchedulableTask): PoolTransition {
  if (state.running.includes(task.id) || state.queued.some((t) => t.id === task.id)) {
    return { state, admit: [] };
  }
  return drain({ ...state, queued: [...state.queued, task] });
}

/** A run finished: free its slot and admit the next queued run(s). */
export function complete(state: PoolState, id: string): PoolTransition {
  const running = state.running.filter((r) => r !== id);
  if (running.length === state.running.length) {
    // id wasn't running (perhaps still queued) — drop it from the queue instead.
    return remove(state, id);
  }
  return drain({ ...state, running });
}

/** Remove a run from wherever it is (cancel), then admit replacements. */
export function remove(state: PoolState, id: string): PoolTransition {
  const running = state.running.filter((r) => r !== id);
  const queued = state.queued.filter((t) => t.id !== id);
  if (running.length === state.running.length && queued.length === state.queued.length) {
    return { state, admit: [] };
  }
  return drain({ ...state, running, queued });
}

export interface PoolStats {
  running: number;
  queued: number;
  free: number;
  max: number;
}

export function poolStats(state: PoolState): PoolStats {
  return {
    running: state.running.length,
    queued: state.queued.length,
    free: Math.max(0, state.maxConcurrent - state.running.length),
    max: state.maxConcurrent,
  };
}
