import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import {
  buildReviewMessages,
  parseReviewFindings,
  adjudicateReview,
  type ReviewResult,
} from '../../common/review';

/**
 * Code-Review runner (Main, PRD Epoch H §135 / Phase 222). Runs the model on a
 * scope of code with the strict review contract, accumulates the (non-streamed)
 * reply, and parses it into structured findings. Reuses the normalized chat path
 * (egress gateway, INV-2/3), so it inherits routing/caching. Read-only: it never
 * edits files — the user applies suggestions through the normal diff flow.
 */
export interface ReviewCreds {
  provider: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKey: string;
  credentialRevision: string;
}

async function accumulate(params: ChatParams, signal: AbortSignal): Promise<string> {
  let out = '';
  await chat(
    params,
    (d) => (out += d),
    () => undefined,
    signal,
  );
  return out;
}

export async function reviewCode(
  creds: ReviewCreds,
  code: string,
  label: string,
): Promise<ReviewResult> {
  const { system, user } = buildReviewMessages(label, code);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const controller = new AbortController();
  const raw = await accumulate({ ...creds, messages }, controller.signal);
  const findings = parseReviewFindings(raw);
  const { verdict, summary } = adjudicateReview(findings, creds.model);
  return { findings, raw, verdict, verdictSummary: summary };
}
