/**
 * Provider A/B compare — full (Phase 258 — Provider A/B Compare (full)).
 *
 * PURE module (no I/O, no Electron). Given the SAME prompt run on two
 * providers/models, score each on QUALITY (a judge/user rating, or output length
 * as a proxy), LATENCY (lower is better), and COST (lower is better), combine them
 * with configurable weights, and pick a winner (or a tie). Extends the model A/B
 * core (Phase 182) into a full provider-level comparison for the BYOK / AI-engineer
 * persona. The two runs are produced by the normal chat path; this only adjudicates.
 */

export interface ProviderRun {
  /** Stable id, e.g. 'a' / 'b'. */
  id: string;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  /** Optional quality rating 0..1 (from a judge model or the user). */
  quality?: number;
  /** Optional output length (chars) — a rough completeness proxy when no rating. */
  outputChars?: number;
}

export interface CompareWeights {
  quality: number;
  latency: number;
  cost: number;
}

export const DEFAULT_WEIGHTS: CompareWeights = { quality: 0.5, latency: 0.2, cost: 0.3 };

export interface DimensionScores {
  quality: number;
  latency: number;
  cost: number;
}

export type CompareWinner = 'a' | 'b' | 'tie';

export interface CompareResult {
  winner: CompareWinner;
  scoreA: number;
  scoreB: number;
  dimA: DimensionScores;
  dimB: DimensionScores;
  /** Whether the quality dimension had data (else it was dropped + reweighted). */
  usedQuality: boolean;
  /** Dimensions the winner led on (e.g. ['latency', 'cost']). */
  winReasons: string[];
  summary: string;
}

/** Self's share of a two-way dimension in [0,1]; `lowerBetter` inverts (latency/cost). */
function share(selfVal: number, otherVal: number, lowerBetter: boolean): number {
  const s = Math.max(0, selfVal) + Math.max(0, otherVal);
  if (s <= 0) return 0.5;
  return lowerBetter ? Math.max(0, otherVal) / s : Math.max(0, selfVal) / s;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const TIE_EPSILON = 0.02;

/**
 * Compare two runs and pick a winner. Quality uses explicit ratings when both runs
 * have them, else output length; when neither is available the quality weight is
 * redistributed across latency + cost.
 */
export function compareRuns(
  a: ProviderRun,
  b: ProviderRun,
  weights: CompareWeights = DEFAULT_WEIGHTS,
): CompareResult {
  const bothRated = a.quality !== undefined && b.quality !== undefined;
  const bothSized = a.outputChars !== undefined && b.outputChars !== undefined;
  const usedQuality = bothRated || bothSized;
  const qA = a.quality ?? a.outputChars ?? 0;
  const qB = b.quality ?? b.outputChars ?? 0;

  // Effective (renormalized) weights — drop quality when unavailable.
  const wqRaw = usedQuality ? Math.max(0, weights.quality) : 0;
  const wlRaw = Math.max(0, weights.latency);
  const wcRaw = Math.max(0, weights.cost);
  const wsum = wqRaw + wlRaw + wcRaw || 1;
  const wq = wqRaw / wsum;
  const wl = wlRaw / wsum;
  const wc = wcRaw / wsum;

  const dimA: DimensionScores = {
    quality: usedQuality ? share(qA, qB, false) : 0,
    latency: share(a.latencyMs, b.latencyMs, true),
    cost: share(a.costUsd, b.costUsd, true),
  };
  const dimB: DimensionScores = {
    quality: usedQuality ? share(qB, qA, false) : 0,
    latency: share(b.latencyMs, a.latencyMs, true),
    cost: share(b.costUsd, a.costUsd, true),
  };

  const scoreA = round(wq * dimA.quality + wl * dimA.latency + wc * dimA.cost);
  const scoreB = round(wq * dimB.quality + wl * dimB.latency + wc * dimB.cost);
  const winner: CompareWinner =
    Math.abs(scoreA - scoreB) < TIE_EPSILON ? 'tie' : scoreA > scoreB ? 'a' : 'b';

  const winDim = winner === 'a' ? dimA : dimB;
  const loseDim = winner === 'a' ? dimB : dimA;
  const winReasons =
    winner === 'tie'
      ? []
      : (['quality', 'latency', 'cost'] as const).filter(
          (d) => (d !== 'quality' || usedQuality) && winDim[d] > loseDim[d],
        );

  const label = (r: ProviderRun): string => `${r.provider}/${r.model}`;
  const summary =
    winner === 'tie'
      ? `Tie: ${label(a)} (${scoreA}) vs ${label(b)} (${scoreB}).`
      : `${winner === 'a' ? label(a) : label(b)} wins (${winner === 'a' ? scoreA : scoreB} vs ${
          winner === 'a' ? scoreB : scoreA
        })${winReasons.length > 0 ? ` on ${winReasons.join(' + ')}` : ''}.`;

  return { winner, scoreA, scoreB, dimA, dimB, usedQuality, winReasons, summary };
}
