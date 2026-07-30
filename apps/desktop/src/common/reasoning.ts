import type { ProviderFamily } from './providers';

/**
 * Reasoning-models support (PRD Epoch F §68 / Phase 149). A normalized reasoning
 * configuration mapped to each provider's request params — OpenAI o-series
 * `reasoning_effort`, Anthropic extended-thinking budget, Gemini (default). It is
 * OPT-IN and capability-gated: params are emitted only when reasoning is enabled
 * AND the model is a known reasoning model, so the default path is byte-identical
 * (zero regression). Pure — unit-tested.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ReasoningVisibility = 'hidden' | 'summary' | 'full';

export interface ReasoningConfig {
  enabled: boolean;
  effort: ReasoningEffort;
  visibility: ReasoningVisibility;
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
export const DEFAULT_REASONING: ReasoningConfig = {
  enabled: false,
  effort: 'medium',
  visibility: 'summary',
};

export function parseReasoningEffort(value: unknown): ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : 'medium';
}

/** Conservatively detect a reasoning-capable model from its id + family. */
export function isReasoningModel(family: ProviderFamily, model: string): boolean {
  const m = model.toLowerCase();
  // `gpt-5` must be a whole model token, optionally with a minor version. An
  // unanchored substring also matched ids like `gpt-50` or `gpt-5x`, which would
  // attach `reasoning_effort` to an unrelated model on an OpenAI-compatible relay.
  if (family === 'openai') {
    return /(^|[-/])(o1|o3|o4)(-|$)|(^|[-/])gpt-5(\.\d+)?(-|$)|reason/.test(m);
  }
  if (family === 'anthropic') return /3-7|3\.7|sonnet-4|opus-4|-4-|thinking/.test(m);
  if (family === 'gemini') return /2\.5|2-5|thinking/.test(m);
  return false;
}

// Anthropic extended-thinking budgets, kept below the 4096 max_tokens the adapter
// sends so the request stays valid (budget must be < max_tokens).
function anthropicBudget(effort: ReasoningEffort): number {
  return effort === 'low' ? 1600 : effort === 'high' ? 3000 : 2400;
}

/**
 * Additive request-body params for reasoning on a given family/model. Returns an
 * empty object (no-op) unless reasoning is enabled and the model supports it.
 */
export function reasoningBody(
  family: ProviderFamily,
  model: string,
  cfg: ReasoningConfig | undefined,
): Record<string, unknown> {
  if (!cfg?.enabled || !isReasoningModel(family, model)) return {};
  if (family === 'openai') return { reasoning_effort: cfg.effort };
  if (family === 'anthropic') {
    return { thinking: { type: 'enabled', budget_tokens: anthropicBudget(cfg.effort) } };
  }
  // Gemini 2.5 reasons by default; no stable v1beta toggle → no-op (safe).
  return {};
}
