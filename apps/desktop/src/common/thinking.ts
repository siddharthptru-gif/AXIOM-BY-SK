/**
 * Thinking mode core (PRD Epoch H §133 / Phase 215). Surfaces a model's reasoning:
 * parse a leading reasoning block out of an answer, decide whether to show it per
 * the visibility setting, and estimate the reasoning-token cost. Pure — the chat
 * surface renders a collapsible reasoning block. Smoke-tested.
 */
export type ThinkingVisibility = 'auto' | 'always' | 'never';

export const THINKING_VISIBILITIES: readonly ThinkingVisibility[] = ['auto', 'always', 'never'];

export const THINKING_VISIBILITY_LABELS: Record<ThinkingVisibility, string> = {
  auto: 'When present',
  always: 'Always show',
  never: 'Hide',
};

/** Coerce input to a valid visibility (default 'auto'). */
export function parseThinkingVisibility(value: unknown): ThinkingVisibility {
  return value === 'always' || value === 'never' ? value : 'auto';
}

// Reasoning is emitted by some models as a <think>…</think> / <thinking>…</thinking>
// block, or a leading "Reasoning: … \n\nAnswer:" section. We split it off the answer.
const TAG_RE = /^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i;
const LABEL_RE = /^\s*(?:reasoning|thinking)\s*:\s*([\s\S]*?)\n\s*(?:answer|response)\s*:\s*/i;

export interface ThinkingSplit {
  /** The reasoning text, or null when the answer contains none. */
  thinking: string | null;
  /** The answer with any reasoning block removed. */
  answer: string;
}

/** Split a leading reasoning block off an answer (tag form or labeled form). */
export function extractThinking(text: string): ThinkingSplit {
  const tag = TAG_RE.exec(text);
  if (tag) {
    return { thinking: (tag[1] ?? '').trim(), answer: text.slice(tag[0].length).trim() };
  }
  const label = LABEL_RE.exec(text);
  if (label) {
    return { thinking: (label[1] ?? '').trim(), answer: text.slice(label[0].length).trim() };
  }
  return { thinking: null, answer: text };
}

/** Whether to show the reasoning block given the visibility setting + presence. */
export function shouldShowThinking(visibility: ThinkingVisibility, hasThinking: boolean): boolean {
  if (visibility === 'never') return false;
  return hasThinking;
}

/** Rough reasoning-token estimate (~4 chars/token) for the cost note. */
export function estimateThinkingTokens(thinking: string): number {
  return Math.ceil(thinking.length / 4);
}

/** A short cost label for a reasoning block, e.g. "~120 reasoning tokens". */
export function formatThinkingCost(thinking: string): string {
  return `~${estimateThinkingTokens(thinking).toLocaleString()} reasoning tokens`;
}
