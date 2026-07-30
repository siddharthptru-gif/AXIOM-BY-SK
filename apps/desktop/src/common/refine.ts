/**
 * Iterative refinement (PRD Epoch G §130 / Phase 196). Pure builder for a refinement
 * instruction: the original request + a compact summary of the prior plan + the
 * user's feedback, instructing the model to REVISE (not restart). The result is fed
 * back into the Composer (composeEdits), so the reply is another edit plan. No I/O.
 */
import type { PlannedEdit } from './editPlan';

/** Compact `- action path` summary of a prior plan for the refinement prompt. */
export function summarizePriorPlan(edits: readonly PlannedEdit[]): string {
  if (edits.length === 0) return '(no changes)';
  return edits.map((e) => `- ${e.action} ${e.path}`).join('\n');
}

/**
 * Build the refinement instruction fed back into the Composer. Combines the original
 * request, the prior plan summary, and the feedback into a revise-this-plan prompt.
 */
export function buildRefinementPrompt(
  originalInstruction: string,
  priorEdits: readonly PlannedEdit[],
  feedback: string,
): string {
  return [
    `Original request:\n${originalInstruction.trim()}`,
    `\nYou previously proposed this multi-file plan:\n${summarizePriorPlan(priorEdits)}`,
    `\nRevise that plan based on this feedback (keep what works; change only what is needed):\n${feedback.trim()}`,
  ].join('\n');
}
