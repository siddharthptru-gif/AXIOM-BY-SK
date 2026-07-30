/**
 * Provider health & circuit breaker (PRD Epoch F, Phases 167/168). A pure,
 * deterministic circuit breaker per AI provider: consecutive failures trip the
 * circuit OPEN (that provider is skipped in the failover chain); after a cooldown
 * it goes HALF-OPEN (one trial allowed); a success closes it again. No I/O and no
 * clock of its own — callers pass `now`, so it is fully unit-testable. The Main
 * failover handler records each attempt's outcome and skips open providers.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderStat {
  /** Consecutive failures since the last success. */
  failures: number;
  /** ms timestamp of the last failure. */
  lastFailureAt: number;
  /** ms timestamp the circuit opened (0 = closed). */
  openedAt: number;
}

export type HealthMap = Record<string, ProviderStat>;

/** Consecutive failures required to trip the circuit open. */
export const FAILURE_THRESHOLD = 3;
/** How long a circuit stays open before a half-open trial (ms). */
export const COOLDOWN_MS = 30_000;

function stat(map: HealthMap, provider: string): ProviderStat {
  return map[provider] ?? { failures: 0, lastFailureAt: 0, openedAt: 0 };
}

/** The circuit state for a provider at time `now`. */
export function circuitState(map: HealthMap, provider: string, now: number): CircuitState {
  const s = stat(map, provider);
  if (s.openedAt === 0) return 'closed';
  return now - s.openedAt >= COOLDOWN_MS ? 'half-open' : 'open';
}

/** True when a provider may be attempted (closed or half-open trial). */
export function isAvailable(map: HealthMap, provider: string, now: number): boolean {
  return circuitState(map, provider, now) !== 'open';
}

/** Record a failed attempt. Trips open at the threshold; a half-open failure re-opens. */
export function recordFailure(map: HealthMap, provider: string, now: number): HealthMap {
  const s = stat(map, provider);
  const halfOpen = s.openedAt !== 0 && now - s.openedAt >= COOLDOWN_MS;
  const failures = s.failures + 1;
  let openedAt = s.openedAt;
  if (halfOpen) {
    openedAt = now; // half-open trial failed → re-open the circuit
  } else if (s.openedAt === 0 && failures >= FAILURE_THRESHOLD) {
    openedAt = now; // closed → tripped open
  }
  return { ...map, [provider]: { failures, lastFailureAt: now, openedAt } };
}

/** Record a successful attempt — closes the circuit and clears the failure count. */
export function recordSuccess(map: HealthMap, provider: string, _now: number): HealthMap {
  const existing = map[provider];
  if (!existing || (existing.failures === 0 && existing.openedAt === 0)) return map;
  return { ...map, [provider]: { failures: 0, lastFailureAt: 0, openedAt: 0 } };
}

/**
 * Filter a failover chain to the providers whose circuit is not open (closed or
 * half-open). If that would leave the chain empty (every provider is open), the
 * original chain is returned unchanged — a last-resort attempt beats a hard fail.
 * Order is preserved.
 */
export function selectHealthy<T extends { provider: string }>(
  chain: readonly T[],
  map: HealthMap,
  now: number,
): T[] {
  const healthy = chain.filter((c) => circuitState(map, c.provider, now) !== 'open');
  return healthy.length > 0 ? healthy : [...chain];
}

export interface ProviderHealthSummary {
  provider: string;
  state: CircuitState;
  failures: number;
  /** ms until the circuit is eligible for a half-open trial (0 when not open). */
  cooldownRemainingMs: number;
}

/** Summarize every tracked provider's circuit for display. */
export function summarizeHealth(map: HealthMap, now: number): ProviderHealthSummary[] {
  return Object.keys(map)
    .map((provider) => {
      const s = stat(map, provider);
      const state = circuitState(map, provider, now);
      const cooldownRemainingMs =
        state === 'open' ? Math.max(0, s.openedAt + COOLDOWN_MS - now) : 0;
      return { provider, state, failures: s.failures, cooldownRemainingMs };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}
