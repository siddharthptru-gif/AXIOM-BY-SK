/**
 * Per-model spend budgets (PRD Epoch F, Phases 152/197 long-tail). Pure logic to
 * parse a per-model daily budget map, evaluate each model's today-spend against its
 * budget (ok / warn / over / none), and summarize. Complements the global daily
 * budget gate (common/budgetGate) with per-model granularity. No I/O — the spend
 * dashboard reads the settings string + the ledger's top-model totals and renders
 * these. Smoke-tested.
 */

export type ModelBudgetStatus = 'ok' | 'warn' | 'over' | 'none';

export interface ModelBudgetRow {
  model: string;
  usd: number;
  /** Per-model daily budget (USD); 0 when none is set. */
  budget: number;
  status: ModelBudgetStatus;
  /** usd / budget (0 when no budget). */
  fraction: number;
  reason: string;
}

/** Fraction of a model's budget at which it's flagged as approaching. */
export const MODEL_WARN_RATIO = 0.8;

/** Parse a "model=usd, other=usd" string into a positive-value budget map. */
export function parseModelBudgets(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(',')) {
    const eq = part.lastIndexOf('=');
    if (eq < 0) continue;
    const model = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (model.length > 0 && Number.isFinite(value) && value > 0) out[model] = value;
  }
  return out;
}

/** Serialize a budget map back to the "model=usd, …" form (sorted by model). */
export function formatModelBudgets(budgets: Record<string, number>): string {
  return Object.keys(budgets)
    .sort((a, b) => a.localeCompare(b))
    .map((m) => `${m}=${budgets[m]}`)
    .join(', ');
}

function money(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Evaluate one model's spend against its budget. */
export function evaluateModelBudget(
  usd: number,
  budget: number,
  warnRatio: number = MODEL_WARN_RATIO,
): { status: ModelBudgetStatus; fraction: number } {
  const u = Math.max(0, Number.isFinite(usd) ? usd : 0);
  const b = Math.max(0, Number.isFinite(budget) ? budget : 0);
  if (b <= 0) return { status: 'none', fraction: 0 };
  const fraction = u / b;
  if (u > b) return { status: 'over', fraction };
  if (fraction >= warnRatio) return { status: 'warn', fraction };
  return { status: 'ok', fraction };
}

function reasonFor(status: ModelBudgetStatus, usd: number, budget: number): string {
  switch (status) {
    case 'over':
      return `Over budget \u2014 ${money(usd)} of ${money(budget)}.`;
    case 'warn':
      return `Approaching \u2014 ${money(usd)} of ${money(budget)}.`;
    case 'ok':
      return `${money(usd)} of ${money(budget)}.`;
    default:
      return 'No per-model budget set.';
  }
}

/** Evaluate every model's today-spend against the per-model budget map. */
export function evaluateModelBudgets(
  models: ReadonlyArray<{ model: string; usd: number }>,
  budgets: Record<string, number>,
): ModelBudgetRow[] {
  return models.map(({ model, usd }) => {
    const budget = budgets[model] ?? 0;
    const { status, fraction } = evaluateModelBudget(usd, budget);
    return { model, usd, budget, status, fraction, reason: reasonFor(status, usd, budget) };
  });
}

export interface ModelBudgetSummary {
  /** Models that have a budget configured. */
  tracked: number;
  over: number;
  warn: number;
}

/** Count how many tracked models are over / approaching their budget. */
export function summarizeModelBudgets(rows: readonly ModelBudgetRow[]): ModelBudgetSummary {
  let tracked = 0;
  let over = 0;
  let warn = 0;
  for (const r of rows) {
    if (r.budget <= 0) continue;
    tracked += 1;
    if (r.status === 'over') over += 1;
    else if (r.status === 'warn') warn += 1;
  }
  return { tracked, over, warn };
}
