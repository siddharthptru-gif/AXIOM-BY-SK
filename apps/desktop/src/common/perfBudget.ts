/**
 * Performance budget engine (PRD Epoch J §194/§209 / Phase 265). Pure logic: define
 * budgets (SLO targets with a tolerance band), classify a measured value as
 * pass / warn / fail, and summarize a set of measurements. The renderer's
 * Performance panel measures real in-app metrics and renders these. No I/O.
 * NOTE: this is the enforcement *engine*; full CI gates on reference hardware are
 * out of scope for the in-app tool. Smoke-tested.
 */
export type BudgetUnit = 'ms' | 'mb';

export interface Budget {
  id: string;
  label: string;
  /** Target ceiling (lower is better). */
  limit: number;
  unit: BudgetUnit;
  /** Percent over the limit still tolerated as a warning (not yet a failure). */
  tolerancePct: number;
}

/** Default budgets (indicative SLOs; real numbers are tuned per reference HW). */
export const BUDGETS: readonly Budget[] = [
  { id: 'coldStart', label: 'Cold start', limit: 3000, unit: 'ms', tolerancePct: 20 },
  { id: 'warmStart', label: 'Warm start', limit: 1500, unit: 'ms', tolerancePct: 20 },
  { id: 'domReady', label: 'Renderer DOM ready', limit: 1200, unit: 'ms', tolerancePct: 25 },
  { id: 'idleMemory', label: 'Idle heap', limit: 400, unit: 'mb', tolerancePct: 25 },
];

export type BudgetStatus = 'pass' | 'warn' | 'fail';

export interface BudgetResult {
  budget: Budget;
  value: number;
  status: BudgetStatus;
  /** value / limit (1.0 = exactly at budget). */
  ratio: number;
}

/** Classify a measured value against a budget (pass ≤ limit; warn ≤ limit+tol; else fail). */
export function checkBudget(value: number, budget: Budget): BudgetResult {
  const ratio = budget.limit > 0 ? Math.round((value / budget.limit) * 100) / 100 : 0;
  const warnCeil = budget.limit * (1 + budget.tolerancePct / 100);
  const status: BudgetStatus = value <= budget.limit ? 'pass' : value <= warnCeil ? 'warn' : 'fail';
  return { budget, value, status, ratio };
}

export interface Measurement {
  id: string;
  value: number;
}

export interface BudgetSummary {
  results: BudgetResult[];
  worst: BudgetStatus;
  passed: number;
  warned: number;
  failed: number;
}

const RANK: Record<BudgetStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Summarize measurements against budgets (only budgets with a measurement are included). */
export function summarizeBudgets(
  measurements: readonly Measurement[],
  budgets: readonly Budget[] = BUDGETS,
): BudgetSummary {
  const byId = new Map(measurements.map((m) => [m.id, m.value]));
  const results: BudgetResult[] = [];
  for (const b of budgets) {
    const v = byId.get(b.id);
    if (v === undefined) continue;
    results.push(checkBudget(v, b));
  }
  let worst: BudgetStatus = 'pass';
  let passed = 0;
  let warned = 0;
  let failed = 0;
  for (const r of results) {
    if (RANK[r.status] > RANK[worst]) worst = r.status;
    if (r.status === 'pass') passed++;
    else if (r.status === 'warn') warned++;
    else failed++;
  }
  return { results, worst, passed, warned, failed };
}

/** Format a measured value with its unit. */
export function formatMetric(value: number, unit: BudgetUnit): string {
  return unit === 'ms' ? `${Math.round(value)} ms` : `${Math.round(value)} MB`;
}
