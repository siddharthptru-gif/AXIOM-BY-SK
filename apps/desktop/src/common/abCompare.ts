/**
 * Model A/B compare foundation (PRD Epoch G §128.9/§151.3 / Phase 182). Pure
 * helpers for running the same prompt against two models side by side: resolve the
 * available alternate models (everything except the current one) and build the
 * A/B pair. No I/O — the chat composer picks an alternate and the panel runs both
 * models serially to respect low-RPM providers, routing each stream by message id. Unit-tested.
 */

/** Models available as the "B" side — the option list minus the current model. */
export function resolveAltModels(modelOptions: readonly string[], current: string): string[] {
  return modelOptions.filter((m) => m !== current && m.length > 0);
}

/** The default alternate (first option that isn't the current model), or ''. */
export function defaultAltModel(modelOptions: readonly string[], current: string): string {
  return resolveAltModels(modelOptions, current)[0] ?? '';
}

export interface AbPair {
  a: string;
  b: string;
}

/** Build an A/B pair, or null when the alternate is empty or equals the current model. */
export function buildAbPair(current: string, alt: string): AbPair | null {
  if (current.length === 0 || alt.length === 0 || alt === current) return null;
  return { a: current, b: alt };
}
