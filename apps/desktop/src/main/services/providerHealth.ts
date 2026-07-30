import {
  selectHealthy,
  recordFailure,
  recordSuccess,
  summarizeHealth,
  type HealthMap,
  type ProviderHealthSummary,
} from '../../common/providerHealth';

/**
 * Provider health service (Main, PRD Phases 167/168). Holds the in-memory circuit
 * state for the AI providers (runtime-only — a fresh session starts all-healthy),
 * filters the failover chain to skip tripped-open providers, and records each
 * failover run's outcome via the pure circuit breaker in common/providerHealth.
 */
let health: HealthMap = {};

/** Drop providers whose circuit is open from a failover chain (keeps at least one). */
export function healthyChain<T extends { provider: string }>(chain: readonly T[]): T[] {
  return selectHealthy(chain, health, Date.now());
}

/**
 * Record the outcome of a completed failover run. `winIndex` is the attempt that
 * succeeded; every earlier attempt in the (already health-filtered) chain failed
 * over before it, so they are recorded as failures.
 */
export function noteChainResult(chain: readonly { provider: string }[], winIndex: number): void {
  const now = Date.now();
  for (let i = 0; i < winIndex && i < chain.length; i++) {
    const a = chain[i];
    if (a) health = recordFailure(health, a.provider, now);
  }
  const win = chain[winIndex];
  if (win) health = recordSuccess(health, win.provider, now);
}

/** Record that the entire chain failed (every attempt threw). */
export function noteChainFailure(chain: readonly { provider: string }[]): void {
  const now = Date.now();
  for (const a of chain) health = recordFailure(health, a.provider, now);
}

/** Current per-provider circuit summary (for display in the AI panel). */
export function getProviderHealth(): ProviderHealthSummary[] {
  return summarizeHealth(health, Date.now());
}
