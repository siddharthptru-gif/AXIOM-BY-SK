import { deriveRouteMeta, type RouteCaps } from './routing';

/**
 * Model capability matching + re-fit (PRD Epoch F, Phase 166). Pure helpers that
 * (1) infer the capabilities a specific request needs (image input, tool calling,
 * extended reasoning, long context), (2) check whether the selected model supports
 * them, and (3) suggest switching to a capable model from the available list. It
 * builds on the routing engine's capability heuristics (deriveRouteMeta) and has
 * no I/O, so it is fully unit-testable. Heuristic: there is no live per-model
 * capability manifest on-device, so unknowns are treated conservatively.
 */

/** A single capability a model may or may not support. */
export type Capability = keyof RouteCaps; // 'tools' | 'vision' | 'reasoning' | 'longContext'

export const CAPABILITY_LABELS: Record<Capability, string> = {
  tools: 'tool/function calling',
  vision: 'image input',
  reasoning: 'extended reasoning',
  longContext: 'long context',
};

/** Prompt-token count above which a request is considered "long context". */
export const LONG_CONTEXT_TOKENS = 16000;

/** The capabilities a request requires. */
export interface RequestNeeds {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  longContext: boolean;
}

/** Raw signals about a request, from which needs are derived. */
export interface RequestSignals {
  /** The request includes one or more images. */
  hasImages?: boolean;
  /** The request will use tool/function calling (agent/composer). */
  usesTools?: boolean;
  /** Extended reasoning is requested (and enabled). */
  reasoningRequested?: boolean;
  /** Estimated total prompt tokens (to detect a long-context need). */
  estimatedTokens?: number;
  /** Override the long-context token threshold. */
  longContextThreshold?: number;
}

/** Derive the capabilities a request needs from its raw signals. */
export function analyzeRequestNeeds(signals: RequestSignals): RequestNeeds {
  const threshold = signals.longContextThreshold ?? LONG_CONTEXT_TOKENS;
  const tokens = Math.max(0, signals.estimatedTokens ?? 0);
  return {
    vision: signals.hasImages === true,
    tools: signals.usesTools === true,
    reasoning: signals.reasoningRequested === true,
    longContext: tokens >= threshold,
  };
}

export interface CapabilityFit {
  /** True when the model supports every capability the request needs. */
  fits: boolean;
  /** Capabilities the request needs that the model lacks. */
  missing: Capability[];
  /** The model's full capability set (from the routing heuristic). */
  caps: RouteCaps;
}

/** Check whether a provider/model supports everything a request needs. */
export function checkModelFit(
  provider: string,
  model: string,
  baseUrl: string,
  needs: RequestNeeds,
): CapabilityFit {
  const caps = deriveRouteMeta(provider, model, baseUrl).capabilities;
  const missing: Capability[] = [];
  for (const k of Object.keys(needs) as Capability[]) {
    if (needs[k] && !caps[k]) missing.push(k);
  }
  return { fits: missing.length === 0, missing, caps };
}

/** An available model to consider switching to. */
export interface ModelOption {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface SwitchSuggestion {
  option: ModelOption;
  /** The capabilities this option adds that the current model lacked. */
  gains: Capability[];
}

/**
 * From a list of available models, suggest the best one that satisfies the needs
 * the current model misses. Prefers the highest-quality fitting option; returns
 * null when the current model already fits or nothing better fits. Stable: input
 * order breaks ties.
 */
export function suggestModelSwitch(
  current: ModelOption,
  needs: RequestNeeds,
  available: readonly ModelOption[],
): SwitchSuggestion | null {
  const currentFit = checkModelFit(current.provider, current.model, current.baseUrl, needs);
  if (currentFit.fits) return null;

  const fitting = available
    .map((opt, i) => ({
      opt,
      i,
      fit: checkModelFit(opt.provider, opt.model, opt.baseUrl, needs),
    }))
    .filter(
      ({ opt, fit }) =>
        fit.fits && !(opt.provider === current.provider && opt.model === current.model),
    );

  if (fitting.length === 0) return null;

  fitting.sort((a, b) => {
    const qa = deriveRouteMeta(a.opt.provider, a.opt.model, a.opt.baseUrl).qualityRank;
    const qb = deriveRouteMeta(b.opt.provider, b.opt.model, b.opt.baseUrl).qualityRank;
    return qb - qa || a.i - b.i;
  });

  const best = fitting[0]!;
  return { option: best.opt, gains: currentFit.missing };
}

/** A short, user-facing sentence describing a capability gap (+ optional switch). */
export function describeCapabilityGap(
  fit: CapabilityFit,
  suggestion: SwitchSuggestion | null,
  model: string,
): string {
  if (fit.fits) return '';
  const names = fit.missing.map((c) => CAPABILITY_LABELS[c]).join(', ');
  const base = `${model} may not support ${names} for this request`;
  return suggestion ? `${base}. Consider ${suggestion.option.model}.` : `${base}.`;
}
