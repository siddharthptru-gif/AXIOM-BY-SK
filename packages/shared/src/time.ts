/** Time helpers. Wall-clock and monotonic. */

export const now = (): number => Date.now();

export function isoNow(): string {
  return new Date().toISOString();
}

interface MaybePerformance {
  now?: () => number;
}

/** Monotonic clock for measuring durations (immune to wall-clock changes). */
export function monotonicNow(): number {
  const p = (globalThis as { performance?: MaybePerformance }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
