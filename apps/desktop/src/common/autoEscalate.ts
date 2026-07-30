/**
 * Live draft-then-escalate policy (Phase 261 depth — Cost-Aware Autopilot in the loop).
 *
 * PURE module (no I/O, no Electron). It closes the loop between the cost-aware
 * autopilot LADDER (common/costAutopilot: draft cheap → escalate) and the
 * autonomous verify-iterate controller (common/autoLoop): after each verification
 * cycle it decides whether to ESCALATE the model to the next, more-capable rung —
 * on a failed verification, low confidence, or a high-risk task that hasn't yet
 * used an answer-grade model — bounded by the ladder (never past the top rung, which
 * is already budget-capped by planAutopilot).
 *
 * The agent service builds the ladder once at run start, then feeds each
 * verification verdict here to pick the model for the next ReAct pass.
 */

import { nextModel, shouldEscalate, type AutopilotPlan } from './costAutopilot';
import type { VerifySnapshot } from './autoLoop';

export interface EscalationDecision {
  /** Should the next pass use a stronger model? */
  escalate: boolean;
  fromModel: string;
  /** The model to use next (a higher rung when escalating, else the same). */
  toModel: string;
  /** True when already at the most capable (top) rung of the ladder. */
  atTop: boolean;
  reason: string;
}

export interface EscalationSignals {
  /** Task is high-risk (wants an answer-grade model even if a draft passed). */
  highRisk?: boolean;
  /** Confidence in the draft, 0..1 (low → escalate). */
  confidence?: number;
}

/** Is `model` at or beyond the plan's answer model (the quality target)? */
export function atAnswerModel(plan: AutopilotPlan, model: string): boolean {
  if (plan.answerModel === null) return false;
  const cur = plan.ladder.indexOf(model);
  const ans = plan.ladder.indexOf(plan.answerModel);
  if (cur < 0 || ans < 0) return model === plan.answerModel;
  return cur >= ans;
}

/**
 * Decide whether to escalate after a verification cycle. Composes the autopilot's
 * `shouldEscalate` (why) with `nextModel` (where): escalate only when a trigger
 * fires AND a higher rung exists.
 */
export function decideEscalation(
  plan: AutopilotPlan,
  currentModel: string,
  verify: VerifySnapshot,
  signals: EscalationSignals = {},
): EscalationDecision {
  const to = nextModel(plan, currentModel);
  const atTop = to === null;
  const want = shouldEscalate({
    verificationPassed: verify.passed,
    ...(signals.confidence !== undefined ? { confidence: signals.confidence } : {}),
    ...(signals.highRisk !== undefined ? { highRisk: signals.highRisk } : {}),
    atAnswerModel: atAnswerModel(plan, currentModel),
  });
  const escalate = want && to !== null;

  let reason: string;
  if (escalate && to !== null) {
    reason = verify.passed
      ? `Escalating ${currentModel} \u2192 ${to} (higher-quality pass for a high-stakes task).`
      : `Verification failed (${verify.failureCount} check(s)) \u2014 escalating ${currentModel} \u2192 ${to}.`;
  } else if (want && atTop) {
    reason = `Would escalate, but ${currentModel} is already the most capable model available.`;
  } else if (verify.passed) {
    reason = `Verified on ${currentModel} \u2014 no escalation needed.`;
  } else {
    reason = `Verification failed on ${currentModel} \u2014 no escalation.`;
  }

  return {
    escalate,
    fromModel: currentModel,
    toModel: to !== null && escalate ? to : currentModel,
    atTop,
    reason,
  };
}

/** The model to use for the next pass after a verification cycle. */
export function nextModelAfterVerify(
  plan: AutopilotPlan,
  currentModel: string,
  verify: VerifySnapshot,
  signals: EscalationSignals = {},
): string {
  return decideEscalation(plan, currentModel, verify, signals).toModel;
}

/** One-line summary of an escalation decision. */
export function summarizeEscalation(d: EscalationDecision): string {
  return d.reason;
}
