// Bounded-pool fair agent scheduler (PRD Epoch H / Phases 218 Background Agents +
// 219 Parallel Agents). Pure — no I/O, no Electron — so the admission policy is
// deterministic and unit-testable; the service layer applies the plan (actually
// starting runs) and feeds back running counts.
//
// Policy: never exceed `maxConcurrent` running agents. Among queued tasks, higher
// priority always wins; within a priority tier, groups are served round-robin so
// one noisy group (e.g. one agent preset or one user) cannot starve the others;
// within a group it is FIFO by enqueue time. Also aggregates finished results.

export type TaskPriority = 'high' | 'normal' | 'low';

export interface SchedulableTask {
  id: string;
  priority: TaskPriority;
  /** Fairness bucket (agent preset, user, …). Defaults to 'default'. */
  group?: string;
  /** Monotonic enqueue timestamp — FIFO tiebreak within a group. */
  enqueuedAt: number;
}

export interface SchedulerInput {
  queued: SchedulableTask[];
  /** How many agents are already running. */
  running: number;
  maxConcurrent: number;
}

export interface SchedulePlan {
  /** Task ids to start now (in fair order), never more than the free slots. */
  admit: string[];
  /** Task ids that stay queued (in fair order). */
  remaining: string[];
  /** Free slots that existed before admitting. */
  slots: number;
}

/** Free slots given running count and the ceiling (never negative). */
export function freeSlots(running: number, maxConcurrent: number): number {
  return Math.max(0, maxConcurrent - running);
}

/** Whether at least one more agent may start right now. */
export function canAdmit(running: number, maxConcurrent: number): boolean {
  return freeSlots(running, maxConcurrent) > 0;
}

/**
 * Order queued tasks by the fairness policy: priority tier (high → normal → low),
 * then round-robin across groups, then FIFO within a group. Pure and stable.
 */
export function fairOrder(queued: SchedulableTask[]): SchedulableTask[] {
  const tiers: TaskPriority[] = ['high', 'normal', 'low'];
  const out: SchedulableTask[] = [];
  for (const tier of tiers) {
    out.push(...roundRobin(queued.filter((t) => t.priority === tier)));
  }
  return out;
}

/** Round-robin the given tasks across their groups (one per group per round). */
function roundRobin(tasks: SchedulableTask[]): SchedulableTask[] {
  if (tasks.length === 0) return [];
  const buckets = new Map<string, SchedulableTask[]>();
  for (const t of tasks) {
    const g = t.group ?? 'default';
    const arr = buckets.get(g);
    if (arr) arr.push(t);
    else buckets.set(g, [t]);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
  }
  // Deterministic group order: earliest-enqueued group first, then by name.
  const groups = [...buckets.entries()].sort((a, b) => {
    const ea = a[1][0]!.enqueuedAt;
    const eb = b[1][0]!.enqueuedAt;
    return ea - eb || a[0].localeCompare(b[0]);
  });
  const out: SchedulableTask[] = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const [, arr] of groups) {
      const t = arr[round];
      if (t !== undefined) {
        out.push(t);
        added = true;
      }
    }
    round++;
  }
  return out;
}

/**
 * Decide which queued tasks to admit now: the first `freeSlots` tasks in fair
 * order. The rest stay queued (also in fair order, so the next tick is stable).
 */
export function planAdmissions(input: SchedulerInput): SchedulePlan {
  const slots = freeSlots(input.running, input.maxConcurrent);
  const ordered = fairOrder(input.queued);
  const admit = slots > 0 ? ordered.slice(0, slots).map((t) => t.id) : [];
  const admitSet = new Set(admit);
  const remaining = ordered.filter((t) => !admitSet.has(t.id)).map((t) => t.id);
  return { admit, remaining, slots };
}

export type RunOutcome = 'success' | 'failure' | 'cancelled';

export interface TaskResult {
  id: string;
  outcome: RunOutcome;
  group?: string;
}

export interface GroupTally {
  success: number;
  failure: number;
  cancelled: number;
}

export interface AggregateResult {
  total: number;
  success: number;
  failure: number;
  cancelled: number;
  byGroup: Record<string, GroupTally>;
  /** True when `expectedTotal` was omitted, or all expected results are in. */
  allSettled: boolean;
}

/** Aggregate parallel-agent results overall and per group (PRD Phase 219). */
export function aggregateResults(results: TaskResult[], expectedTotal?: number): AggregateResult {
  const byGroup: Record<string, GroupTally> = {};
  let success = 0;
  let failure = 0;
  let cancelled = 0;
  for (const r of results) {
    const g = r.group ?? 'default';
    const tally = byGroup[g] ?? { success: 0, failure: 0, cancelled: 0 };
    tally[r.outcome] += 1;
    byGroup[g] = tally;
    if (r.outcome === 'success') success += 1;
    else if (r.outcome === 'failure') failure += 1;
    else cancelled += 1;
  }
  const total = results.length;
  return {
    total,
    success,
    failure,
    cancelled,
    byGroup,
    allSettled: expectedTotal === undefined ? true : total >= expectedTotal,
  };
}
