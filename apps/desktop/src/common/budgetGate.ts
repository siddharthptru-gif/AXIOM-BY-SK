/**
 * AI spend-budget enforcement (PRD Epoch F, Phases 152/197). A pure, deterministic
 * gate that decides whether an AI request may proceed given today's estimated
 * spend, an optional daily budget, and an enforcement mode. No I/O — the renderer
 * feeds it the live spend summary + settings and acts on the decision, so it is
 * fully unit-testable. Estimates only (BYOK is billed by the provider); the gate
 * never blocks when no budget is set or enforcement is off.
 */

export type BudgetEnforcement = 'off' | 'warn' | 'block';
export type BudgetDecision = 'allow' | 'warn' | 'block';

export const BUDGET_ENFORCEMENTS: readonly BudgetEnforcement[] = ['off', 'warn', 'block'] as const;

export const BUDGET_ENFORCEMENT_LABELS: Record<BudgetEnforcement, string> = {
  off: 'Off \u2014 track only',
  warn: 'Warn \u2014 notify but allow (default)',
  block: 'Block \u2014 stop requests over budget',
};

/** Coerce a persisted value into a known enforcement mode (defaults to 'warn'). */
export function parseBudgetEnforcement(value: unknown): BudgetEnforcement {
  return typeof value === 'string' && (BUDGET_ENFORCEMENTS as readonly string[]).includes(value)
    ? (value as BudgetEnforcement)
    : 'warn';
}

export interface BudgetGateInput {
  /** Today's estimated spend so far (USD). */
  todayUsd: number;
  /** The daily budget (USD); 0 or negative means "no budget" (always allow). */
  budgetUsd: number;
  /** How strictly to enforce the budget. */
  enforcement: BudgetEnforcement;
  /** Optional estimated cost of the pending request (USD); default 0. */
  estimatedRequestUsd?: number;
  /** Fraction of the budget at which to start warning (default 0.8, clamped 0..1). */
  warnRatio?: number;
}

export interface BudgetGateResult {
  decision: BudgetDecision;
  /** A short, user-facing explanation of the decision. */
  reason: string;
  budgetUsd: number;
  todayUsd: number;
  /** todayUsd + estimatedRequestUsd, clamped to >= 0. */
  projectedUsd: number;
  /** budgetUsd - projectedUsd (may be negative when over budget). */
  remainingUsd: number;
  /** projectedUsd / budgetUsd in [0, inf); 0 when no budget is set. */
  usedFraction: number;
  /** True when the projected spend exceeds the budget. */
  overBudget: boolean;
  /** True when a budget is actually in effect (budget > 0 and enforcement !== 'off'). */
  enforced: boolean;
}

function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** Compact USD formatting (more precision for tiny amounts). */
export function formatBudgetUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Evaluate the budget gate. Pure + deterministic:
 *  - no budget or enforcement 'off' -> allow
 *  - projected over budget -> 'block' (block mode) or 'warn' (warn mode)
 *  - projected within [warnRatio * budget, budget] -> 'warn' (approaching)
 *  - otherwise -> 'allow'
 */
export function evaluateBudget(input: BudgetGateInput): BudgetGateResult {
  const today = Math.max(0, num(input.todayUsd));
  const budget = Math.max(0, num(input.budgetUsd));
  const est = Math.max(0, num(input.estimatedRequestUsd ?? 0));
  const warnRatio = clamp01(input.warnRatio ?? 0.8);
  const projected = today + est;
  const enforced = budget > 0 && input.enforcement !== 'off';

  const base = {
    budgetUsd: budget,
    todayUsd: today,
    projectedUsd: projected,
    remainingUsd: budget - projected,
    usedFraction: budget > 0 ? projected / budget : 0,
    enforced,
  };

  if (!enforced) {
    return {
      ...base,
      decision: 'allow',
      overBudget: false,
      reason: budget > 0 ? 'Budget tracking only (enforcement off).' : 'No daily AI budget set.',
    };
  }

  const overBudget = projected > budget;
  if (overBudget) {
    const extra = est > 0 ? ` (this request ~${formatBudgetUsd(est)})` : '';
    if (input.enforcement === 'block') {
      return {
        ...base,
        decision: 'block',
        overBudget: true,
        reason: `Daily AI budget reached \u2014 ${formatBudgetUsd(today)} of ${formatBudgetUsd(
          budget,
        )} used${extra}. Blocked by budget enforcement.`,
      };
    }
    return {
      ...base,
      decision: 'warn',
      overBudget: true,
      reason: `Over daily AI budget \u2014 ${formatBudgetUsd(today)} of ${formatBudgetUsd(
        budget,
      )}${extra}. Proceeding (warn mode).`,
    };
  }

  if (base.usedFraction >= warnRatio) {
    return {
      ...base,
      decision: 'warn',
      overBudget: false,
      reason: `Approaching daily AI budget \u2014 ${formatBudgetUsd(projected)} of ${formatBudgetUsd(
        budget,
      )} (${Math.round(base.usedFraction * 100)}%).`,
    };
  }

  return {
    ...base,
    decision: 'allow',
    overBudget: false,
    reason: `Within budget \u2014 ${formatBudgetUsd(projected)} of ${formatBudgetUsd(budget)}.`,
  };
}
