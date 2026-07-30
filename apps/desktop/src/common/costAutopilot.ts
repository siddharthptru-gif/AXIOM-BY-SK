/**
 * Cost-aware autopilot (Phase 261 — Cost-Aware Autopilot).
 *
 * PURE module (no I/O, no Electron). A routing/escalation policy that hits a quality
 * bar at minimum spend: DRAFT on the cheapest capable model (local first), and
 * ESCALATE up a cost ladder to a stronger model only when the draft is
 * insufficient (verification failed, low confidence) or the task is high-risk — all
 * within a per-task / remaining budget.
 *
 * It extends the ideas of policy model routing (Phase 165) + the cost/spend ledger
 * (Phase 152) + the model-capability matcher, but stays self-contained and pure so
 * it is trivially testable and reusable from Main or the renderer.
 *
 * Model:
 *   - AutopilotModel: an available model (tier, capability 0..100, per-1K costs).
 *   - TaskProfile: complexity + risk + estimated token counts.
 *   - AutopilotBudget: per-task and/or remaining USD caps.
 *   - answerFloor / draftFloor: capability thresholds derived from complexity+risk.
 *   - planAutopilot: pick the cheapest viable DRAFT model, build a cheap→capable
 *     escalation LADDER (affordable + capable-enough), identify the ANSWER model
 *     (first meeting the answer floor), and report costs + budget verdict.
 *   - shouldEscalate: given a draft's outcome signals, decide whether to climb.
 *   - nextModel: the next rung above a given model in the ladder.
 */

export type ModelTier = 'local' | 'cheap' | 'standard' | 'frontier';
export type Complexity = 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface AutopilotModel {
  id: string;
  tier: ModelTier;
  /** Capability score 0..100 (higher = more capable). */
  capability: number;
  /** USD per 1K input tokens (0 for local). */
  inputCostPer1k: number;
  /** USD per 1K output tokens (0 for local). */
  outputCostPer1k: number;
  local?: boolean;
}

export interface TaskProfile {
  complexity: Complexity;
  risk: RiskLevel;
  estInputTokens: number;
  estOutputTokens: number;
}

export interface AutopilotBudget {
  /** Hard cap for this single task (USD). */
  maxPerTaskUsd?: number;
  /** Remaining session/day budget (USD). */
  remainingUsd?: number;
}

export interface AutopilotPlan {
  /** Model ids in escalation order (cheapest → most capable), affordable + viable. */
  ladder: string[];
  /** Where to begin — the cheapest viable draft (null when nothing is viable). */
  startModel: string | null;
  /** First ladder model meeting the answer floor (null when none qualifies). */
  answerModel: string | null;
  /** Capability threshold required for the final answer. */
  answerFloor: number;
  /** Capability threshold a draft must clear. */
  draftFloor: number;
  /** Conditions under which the caller should escalate to the next rung. */
  escalateWhen: string[];
  /** Estimated USD to run the start model once. */
  estStartCostUsd: number;
  /** Estimated USD if the whole ladder runs (worst case). */
  estMaxCostUsd: number;
  /** True when at least the start model fits the budget. */
  withinBudget: boolean;
  rationale: string;
  summary: string;
}

const COMPLEXITY_FLOOR: Record<Complexity, number> = { low: 30, medium: 55, high: 80 };
const RISK_BUMP: Record<RiskLevel, number> = { low: 0, medium: 5, high: 15 };
/** A draft may be this much less capable than the answer floor. */
const DRAFT_SLACK = 30;
const CONFIDENCE_ESCALATE_BELOW = 0.6;

/** Estimated USD to run `model` for the task's token counts. */
export function estimateCostUsd(
  model: AutopilotModel,
  inTokens: number,
  outTokens: number,
): number {
  const cost =
    (Math.max(0, inTokens) / 1000) * model.inputCostPer1k +
    (Math.max(0, outTokens) / 1000) * model.outputCostPer1k;
  return Math.round(cost * 1e6) / 1e6;
}

/** Capability required for the final answer, from complexity + risk (clamped 0..100). */
export function answerFloor(task: Pick<TaskProfile, 'complexity' | 'risk'>): number {
  return Math.min(100, COMPLEXITY_FLOOR[task.complexity] + RISK_BUMP[task.risk]);
}

/** Capability a draft model must clear (answer floor minus slack, min 20). */
export function draftFloor(task: Pick<TaskProfile, 'complexity' | 'risk'>): number {
  return Math.max(20, answerFloor(task) - DRAFT_SLACK);
}

/** The effective spend cap = min(per-task, remaining), or Infinity when unset. */
function effectiveCap(budget: AutopilotBudget): number {
  const perTask = budget.maxPerTaskUsd ?? Infinity;
  const remaining = budget.remainingUsd ?? Infinity;
  return Math.min(perTask, remaining);
}

/**
 * Build a cost-aware autopilot plan: draft cheap, escalate only when needed, within
 * budget. Deterministic — ties break by model id.
 */
export function planAutopilot(
  task: TaskProfile,
  models: readonly AutopilotModel[],
  budget: AutopilotBudget = {},
): AutopilotPlan {
  const floor = answerFloor(task);
  const dFloor = draftFloor(task);
  const cap = effectiveCap(budget);

  const withCost = models.map((m) => ({
    m,
    cost: estimateCostUsd(m, task.estInputTokens, task.estOutputTokens),
  }));
  // Cheapest first; ties → higher capability first, then id.
  const byCost = [...withCost].sort(
    (a, b) => a.cost - b.cost || b.m.capability - a.m.capability || (a.m.id < b.m.id ? -1 : 1),
  );

  const affordable = byCost.filter((x) => x.cost <= cap);
  const escalateWhen = ['verification-failed', 'low-confidence'];
  if (task.risk === 'high') escalateWhen.push('high-risk-not-yet-at-answer-model');

  if (affordable.length === 0) {
    // Nothing fits: fall back to the single cheapest model, flag over-budget.
    const cheapest = byCost[0];
    if (!cheapest) {
      return {
        ladder: [],
        startModel: null,
        answerModel: null,
        answerFloor: floor,
        draftFloor: dFloor,
        escalateWhen,
        estStartCostUsd: 0,
        estMaxCostUsd: 0,
        withinBudget: false,
        rationale: 'No models available.',
        summary: 'Autopilot: no models available.',
      };
    }
    return {
      ladder: [cheapest.m.id],
      startModel: cheapest.m.id,
      answerModel: cheapest.m.capability >= floor ? cheapest.m.id : null,
      answerFloor: floor,
      draftFloor: dFloor,
      escalateWhen,
      estStartCostUsd: cheapest.cost,
      estMaxCostUsd: cheapest.cost,
      withinBudget: false,
      rationale: `Cheapest model ($${cheapest.cost.toFixed(4)}) exceeds the budget cap ($${cap === Infinity ? '∞' : cap.toFixed(4)}); running it anyway.`,
      summary: `Autopilot: over budget — ${cheapest.m.id} only.`,
    };
  }

  // Ladder = affordable models that clear the DRAFT floor, cheapest→costliest.
  // (A model too weak to even draft is never useful.)
  let ladderRecs = affordable.filter((x) => x.m.capability >= dFloor);
  if (ladderRecs.length === 0) {
    // Nothing clears the draft floor: use the most capable affordable model alone.
    const best = [...affordable].sort(
      (a, b) => b.m.capability - a.m.capability || a.cost - b.cost,
    )[0]!;
    ladderRecs = [best];
  }

  const ladder = ladderRecs.map((x) => x.m.id);
  const start = ladderRecs[0]!;
  const answer = ladderRecs.find((x) => x.m.capability >= floor) ?? null;
  const estStartCostUsd = start.cost;
  const estMaxCostUsd = Math.round(ladderRecs.reduce((s, x) => s + x.cost, 0) * 1e6) / 1e6;

  const startTierNote = start.m.local === true ? 'local' : start.m.tier;
  const rationale =
    answer && answer.m.id === start.m.id
      ? `Start on ${start.m.id} (${startTierNote}, capability ${start.m.capability}) — already meets the answer floor ${floor}; no escalation needed.`
      : answer
        ? `Draft on ${start.m.id} (${startTierNote}); escalate toward ${answer.m.id} (capability ${answer.m.capability}) if the draft is insufficient.`
        : `Draft on ${start.m.id} (${startTierNote}); no affordable model meets the answer floor ${floor} — escalate as far as the budget allows.`;

  const summary =
    `Autopilot: ${ladder.length} rung${ladder.length === 1 ? '' : 's'}, start ${start.m.id}` +
    (answer ? ` → answer ${answer.m.id}` : ' (answer floor unmet)') +
    ` · $${estStartCostUsd.toFixed(4)}–$${estMaxCostUsd.toFixed(4)}`;

  return {
    ladder,
    startModel: start.m.id,
    answerModel: answer ? answer.m.id : null,
    answerFloor: floor,
    draftFloor: dFloor,
    escalateWhen,
    estStartCostUsd,
    estMaxCostUsd,
    withinBudget: true,
    rationale,
    summary,
  };
}

export interface EscalationSignals {
  /** Did the draft pass verification (tests / self-check)? */
  verificationPassed?: boolean;
  /** Model/heuristic confidence in the draft, 0..1. */
  confidence?: number;
  /** Is the task high-risk (always wants a capable pass)? */
  highRisk?: boolean;
  /** Is the current model already at/above the answer floor? */
  atAnswerModel?: boolean;
}

/**
 * Decide whether to escalate to the next rung given a draft's outcome. Escalate on
 * a failed verification, low confidence, or a high-risk task that hasn't yet used
 * an answer-grade model.
 */
export function shouldEscalate(signals: EscalationSignals): boolean {
  if (signals.verificationPassed === false) return true;
  if (typeof signals.confidence === 'number' && signals.confidence < CONFIDENCE_ESCALATE_BELOW) {
    return true;
  }
  if (signals.highRisk === true && signals.atAnswerModel !== true) return true;
  return false;
}

/** The next model id above `currentId` in the ladder, or null at the top. */
export function nextModel(plan: AutopilotPlan, currentId: string): string | null {
  const i = plan.ladder.indexOf(currentId);
  if (i < 0 || i + 1 >= plan.ladder.length) return null;
  return plan.ladder[i + 1] ?? null;
}

/** Minimal rank-based candidate shape (what the routing engine already computes). */
export interface RankedCandidate {
  /** 0..100, higher is better output quality. */
  qualityRank: number;
  /** 0..100, lower is cheaper. */
  costRank: number;
  local: boolean;
}

/**
 * Draft-cheap → escalate ordering for a candidate chain: prefer local (free) first,
 * then the cheapest, then the highest quality as a tiebreak. Placing the cheapest
 * first makes the existing failover chain "draft then escalate" naturally — the
 * routing engine delegates its 'autopilot' policy to this comparator.
 */
export function autopilotOrder<T extends RankedCandidate>(a: T, b: T): number {
  if (a.local !== b.local) return a.local ? -1 : 1;
  if (a.costRank !== b.costRank) return a.costRank - b.costRank;
  return b.qualityRank - a.qualityRank;
}
