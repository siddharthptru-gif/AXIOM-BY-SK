/**
 * Startup performance & deferred-init planner (Phase 268 — Startup Performance /
 * Deferred-Init).
 *
 * PURE module (no perf.now, no Electron, no I/O). It takes the app's declared
 * startup tasks — each tagged with a PHASE and its dependencies — and produces a
 * dependency-respecting schedule that pushes as much work as possible OUT of the
 * critical path (time-to-first-paint), so the window appears fast and the rest
 * initializes afterwards.
 *
 * Phases (most → least urgent):
 *   critical  must finish before the first window paint (window, config, theme).
 *   deferred  runs right AFTER the first frame (indexer, LSP, watchers, sync).
 *   idle      runs when the app is idle (telemetry flush, prefetch, warmup).
 *
 * Guarantees:
 *   - Topological: a task never runs before a dependency it declares.
 *   - Promotion: if an urgent task depends on a less-urgent one, the dependency is
 *     PROMOTED to the urgent phase (anything the critical path needs is critical).
 *   - Cycle-safe: a dependency cycle never hangs or throws — the offending ids are
 *     reported and still scheduled (in a deterministic order) so startup proceeds.
 *   - Budget: `criticalPathMs` (the sum of critical work, treated as sequential)
 *     is compared against a target budget to yield a pass/fail verdict.
 *
 * The real estMs values come from the startupTiming marks (main-side); this module
 * just plans. It complements (does not replace) a real V8 startup snapshot, which
 * needs build tooling outside the sandbox.
 */

export type StartupPhase = 'critical' | 'deferred' | 'idle';

export interface StartupTask {
  id: string;
  phase: StartupPhase;
  /** Estimated cost in ms (from startupTiming marks). Clamped to >= 0. */
  estMs: number;
  /** Ids this task depends on (must run first). Unknown ids are ignored. */
  deps?: readonly string[];
}

export interface StartupPlan {
  /** Full schedule order (task ids), urgent phases first, deps respected. */
  order: string[];
  /** Ids grouped by their EFFECTIVE phase, in schedule order. */
  phases: { critical: string[]; deferred: string[]; idle: string[] };
  /** Sum of critical-phase est (sequential critical work) — the paint-blocking cost. */
  criticalPathMs: number;
  /** Sum of deferred-phase est. */
  deferredMs: number;
  /** Sum of idle-phase est. */
  idleMs: number;
  /** Sum of all est. */
  totalMs: number;
  /** The critical-path budget this plan was measured against. */
  budgetMs: number;
  /** True when criticalPathMs <= budgetMs. */
  budgetOk: boolean;
  /** How far over budget the critical path is (0 when within budget). */
  overBudgetMs: number;
  /** Ids promoted to a more-urgent phase because an urgent task depends on them. */
  promoted: string[];
  /** Ids caught in a dependency cycle (empty when the graph is acyclic). */
  cycle: string[];
  summary: string;
}

/** Default critical-path budget (ms) — target time-to-first-paint work. */
export const CRITICAL_BUDGET_MS = 1500;

const URGENCY: Record<StartupPhase, number> = { critical: 0, deferred: 1, idle: 2 };
const PHASE_BY_URGENCY: StartupPhase[] = ['critical', 'deferred', 'idle'];

export interface PlanOptions {
  /** Critical-path budget in ms (defaults to CRITICAL_BUDGET_MS). */
  budgetMs?: number;
}

/**
 * Plan a startup schedule. Deterministic: ties break by task id, so the same input
 * always yields the same order.
 */
export function planStartup(tasks: readonly StartupTask[], options: PlanOptions = {}): StartupPlan {
  const budgetMs = options.budgetMs ?? CRITICAL_BUDGET_MS;

  // De-dupe by id (first wins) and normalize est.
  const map = new Map<string, StartupTask>();
  for (const t of tasks) {
    if (!map.has(t.id)) {
      map.set(t.id, { ...t, estMs: Math.max(0, t.estMs) });
    }
  }
  const ids = [...map.keys()];
  const est = (id: string): number => map.get(id)?.estMs ?? 0;
  const declared = (id: string): StartupPhase => map.get(id)?.phase ?? 'deferred';

  // Existing-only dependency lists.
  const depsOf = new Map<string, string[]>();
  for (const id of ids) {
    const raw = map.get(id)?.deps ?? [];
    depsOf.set(
      id,
      raw.filter((d) => map.has(d) && d !== id),
    );
  }

  // Effective phase = most-urgent phase demanded by anything that (transitively)
  // depends on the task, capped by its own declared phase. Fixpoint: urgency flows
  // from a dependent A to its dependency B (B must be ready no later than A).
  const eff = new Map<string, number>();
  for (const id of ids) eff.set(id, URGENCY[declared(id)]);
  let changed = true;
  let guard = 0;
  while (changed && guard < ids.length + 2) {
    changed = false;
    guard += 1;
    for (const id of ids) {
      const u = eff.get(id) ?? 2;
      for (const dep of depsOf.get(id) ?? []) {
        const du = eff.get(dep) ?? 2;
        if (du > u) {
          eff.set(dep, u);
          changed = true;
        }
      }
    }
  }
  const effPhase = (id: string): StartupPhase => PHASE_BY_URGENCY[eff.get(id) ?? 1] ?? 'deferred';
  const promoted = ids.filter((id) => (eff.get(id) ?? 2) < URGENCY[declared(id)]).sort();

  // Priority Kahn topological sort: emit the most-urgent ready task first (ties by
  // id). Because an urgent task's deps are promoted to the same urgency, the urgent
  // subgraph is closed and always drains before any less-urgent task.
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, (depsOf.get(id) ?? []).length);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const dep of depsOf.get(id) ?? []) {
      dependents.get(dep)?.push(id);
    }
  }

  const cmp = (a: string, b: string): number => {
    const ua = eff.get(a) ?? 2;
    const ub = eff.get(b) ?? 2;
    if (ua !== ub) return ua - ub;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const order: string[] = [];
  const ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const emitted = new Set<string>();
  while (ready.length > 0) {
    ready.sort(cmp);
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    emitted.add(next);
    for (const dep of dependents.get(next) ?? []) {
      const d = (indeg.get(dep) ?? 0) - 1;
      indeg.set(dep, d);
      if (d === 0) ready.push(dep);
    }
  }

  // Cycle-safe: anything not emitted is in (or downstream of) a cycle. Append it in
  // a deterministic order so startup still proceeds.
  const cycle = ids.filter((id) => !emitted.has(id)).sort(cmp);
  for (const id of cycle) order.push(id);

  const phases: StartupPlan['phases'] = { critical: [], deferred: [], idle: [] };
  for (const id of order) phases[effPhase(id)].push(id);

  const sumEst = (list: string[]): number => list.reduce((s, id) => s + est(id), 0);
  const criticalPathMs = sumEst(phases.critical);
  const deferredMs = sumEst(phases.deferred);
  const idleMs = sumEst(phases.idle);
  const totalMs = criticalPathMs + deferredMs + idleMs;
  const budgetOk = criticalPathMs <= budgetMs;
  const overBudgetMs = Math.max(0, criticalPathMs - budgetMs);

  const summary =
    `${order.length} task${order.length === 1 ? '' : 's'} · ` +
    `critical ${criticalPathMs}ms (${phases.critical.length}), ` +
    `deferred ${deferredMs}ms (${phases.deferred.length}), ` +
    `idle ${idleMs}ms (${phases.idle.length}) · ` +
    `budget ${criticalPathMs}/${budgetMs}ms ${budgetOk ? 'OK' : `OVER by ${overBudgetMs}ms`}` +
    (promoted.length > 0 ? ` · ${promoted.length} promoted` : '') +
    (cycle.length > 0 ? ` · \u26a0 ${cycle.length} in cycle` : '');

  return {
    order,
    phases,
    criticalPathMs,
    deferredMs,
    idleMs,
    totalMs,
    budgetMs,
    budgetOk,
    overBudgetMs,
    promoted,
    cycle,
    summary,
  };
}

/** Ids that can be deferred past first paint (deferred + idle), in schedule order. */
export function deferredTaskIds(plan: StartupPlan): string[] {
  return [...plan.phases.deferred, ...plan.phases.idle];
}
