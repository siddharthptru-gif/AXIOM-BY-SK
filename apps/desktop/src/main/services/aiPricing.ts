/**
 * Approximate model pricing for cost estimation (PRD Epoch F, Phase 151 / §54).
 * Figures are USD per 1,000,000 tokens (provider list prices, mid-2025). BYOK is
 * billed by the provider — not by Axiom — so these drive an on-screen *estimate*
 * only and may drift from a provider's current rates. Unknown models return null
 * (the UI then shows token counts without a dollar figure).
 */
export interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  input: number;
  /** USD per 1,000,000 output (completion) tokens. */
  output: number;
}

// Keyed by a distinctive model-id substring; the longest match wins so specific
// variants (e.g. gpt-4o-mini) take priority over their prefixes (gpt-4o, gpt-4).
const PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1-mini': { input: 1.1, output: 4.4 },
  o1: { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
  // Google Gemini
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

/** Look up pricing by the longest matching model-id substring, or null. */
export function priceForModel(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (id.includes(key) && (best === null || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best ? best.price : null;
}

/** Estimate USD cost for a completed turn, or null when the model is unknown. */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = priceForModel(model);
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
