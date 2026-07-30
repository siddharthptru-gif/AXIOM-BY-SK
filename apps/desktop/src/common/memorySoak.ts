/**
 * Memory soak analyzer (PRD Epoch J §200 / Phases 266–267). Pure trend detection
 * over a window of heap samples: a least-squares fit of heap-vs-time yields a growth
 * rate (MB/min) that classifies the session as ok / suspect / leak. This complements
 * the single-sample memory watchdog (common/memoryWatchdog) — the watchdog reacts to
 * the current level, this catches a slow upward drift a soak test would reveal. No
 * I/O: the Performance panel samples the heap and feeds these. Smoke-tested.
 * (V8-snapshot startup tuning + the fix for any leak found are separate concerns.)
 */

export type SoakTrend = 'ok' | 'suspect' | 'leak';

export interface HeapSample {
  /** Timestamp in ms. */
  t: number;
  /** Used JS heap in MB. */
  heapMb: number;
}

export interface SoakResult {
  trend: SoakTrend;
  /** Growth rate (MB/min) from a least-squares fit; 0 when undecidable. */
  growthMbPerMin: number;
  /** Net heap change over the window (last - first), MB. */
  deltaMb: number;
  /** Window span, minutes. */
  spanMin: number;
  /** Number of valid samples considered. */
  samples: number;
  reason: string;
}

/** Minimum samples before a trend is judged. */
export const SOAK_MIN_SAMPLES = 5;
/** Minimum elapsed time (ms) before a trend is judged. */
export const SOAK_MIN_SPAN_MS = 30_000;
/** Growth at/above this (MB/min) is suspect. */
export const SOAK_SUSPECT_MB_PER_MIN = 5;
/** Growth at/above this (MB/min) is a likely leak. */
export const SOAK_LEAK_MB_PER_MIN = 15;
/** Ring-buffer cap for retained samples. */
export const SOAK_MAX_SAMPLES = 120;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Append a sample to a bounded ring buffer (pure — returns a new array). */
export function pushSample(
  buffer: readonly HeapSample[],
  sample: HeapSample,
  max: number = SOAK_MAX_SAMPLES,
): HeapSample[] {
  const next = [...buffer, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Least-squares slope of heapMb over time, in MB per ms (0 when undefined). */
function slopeMbPerMs(samples: readonly HeapSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  const t0 = samples[0]!.t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    const x = s.t - t0;
    const y = s.heapMb;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

function reasonFor(trend: SoakTrend, growth: number, spanMin: number): string {
  const g = round1(growth);
  const span = round1(spanMin);
  switch (trend) {
    case 'leak':
      return `Possible memory leak \u2014 heap growing ~${g} MB/min over ${span} min.`;
    case 'suspect':
      return `Heap trending up ~${g} MB/min over ${span} min \u2014 watch for a leak.`;
    default:
      return `Heap stable (~${g} MB/min over ${span} min).`;
  }
}

/**
 * Analyze a window of heap samples for a soak leak. Needs at least SOAK_MIN_SAMPLES
 * spanning SOAK_MIN_SPAN_MS before it judges a trend; otherwise reports 'ok' with a
 * "collecting" reason. Deterministic and pure.
 */
export function analyzeSoak(samples: readonly HeapSample[]): SoakResult {
  const valid = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.heapMb) && s.heapMb >= 0)
    .sort((a, b) => a.t - b.t);
  const n = valid.length;
  if (n < SOAK_MIN_SAMPLES) {
    return {
      trend: 'ok',
      growthMbPerMin: 0,
      deltaMb: 0,
      spanMin: 0,
      samples: n,
      reason: `Collecting samples (${n}/${SOAK_MIN_SAMPLES})\u2026`,
    };
  }
  const first = valid[0]!;
  const last = valid[n - 1]!;
  const spanMs = last.t - first.t;
  const spanMin = spanMs / 60_000;
  const deltaMb = last.heapMb - first.heapMb;
  if (spanMs < SOAK_MIN_SPAN_MS) {
    return {
      trend: 'ok',
      growthMbPerMin: 0,
      deltaMb: round1(deltaMb),
      spanMin: round1(spanMin),
      samples: n,
      reason: 'Not enough time elapsed to judge a trend.',
    };
  }
  const growthMbPerMin = slopeMbPerMs(valid) * 60_000;
  let trend: SoakTrend = 'ok';
  if (growthMbPerMin >= SOAK_LEAK_MB_PER_MIN) trend = 'leak';
  else if (growthMbPerMin >= SOAK_SUSPECT_MB_PER_MIN) trend = 'suspect';
  return {
    trend,
    growthMbPerMin: round1(growthMbPerMin),
    deltaMb: round1(deltaMb),
    spanMin: round1(spanMin),
    samples: n,
    reason: reasonFor(trend, growthMbPerMin, spanMin),
  };
}
