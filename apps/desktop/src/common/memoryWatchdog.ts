/**
 * Memory watchdog core (PRD Epoch J §200 / Phase 266). Pure policy: classify heap
 * usage against a budget into ok / soft / hard, so the app can proactively evict
 * caches (soft) or warn (hard) before the runtime is starved. The renderer feeds it
 * a real heap measurement; full V8-snapshot startup tuning + soak-leak fixes are a
 * separate, out-of-app concern (266 partial). Smoke-tested.
 */
export type WatchdogLevel = 'ok' | 'soft' | 'hard';

/** Default heap budget (MB) for the renderer before the watchdog reacts. */
export const DEFAULT_MEMORY_LIMIT_MB = 800;
/** Fraction of the limit at which the soft threshold trips. */
export const DEFAULT_SOFT_PCT = 75;

/**
 * Classify heap usage: `hard` at/over the limit (evict + warn), `soft` at/over the
 * soft threshold (proactively evict caches), else `ok`.
 */
export function watchdogLevel(
  usedMb: number,
  limitMb: number = DEFAULT_MEMORY_LIMIT_MB,
  softPct: number = DEFAULT_SOFT_PCT,
): WatchdogLevel {
  if (limitMb <= 0) return 'ok';
  const ratio = usedMb / limitMb;
  if (ratio >= 1) return 'hard';
  if (ratio >= softPct / 100) return 'soft';
  return 'ok';
}

/** Whether the app should evict caches at this level. */
export function shouldEvict(level: WatchdogLevel): boolean {
  return level === 'soft' || level === 'hard';
}

/** Human-readable advice for a watchdog level. */
export function watchdogAdvice(level: WatchdogLevel): string {
  switch (level) {
    case 'hard':
      return 'Heap over budget — evicting caches; consider reloading if it persists.';
    case 'soft':
      return 'Heap high — proactively evicting caches.';
    default:
      return 'Heap within budget.';
  }
}
