import { providerInfo } from './providers';
import { autopilotOrder } from './costAutopilot';

/**
 * Policy-based model routing (PRD Epoch F, Phase 165 / §73). A pure, deterministic
 * engine that orders a set of candidate providers/models into a preference chain
 * according to a routing policy (and optional task profile + required
 * capabilities). It has no side effects and no I/O, so it is fully unit-testable;
 * Main uses it to order the failover chain, and the renderer uses its option list
 * for the AI settings UI. Rankings are honest heuristics derived from the
 * provider family + model name (there is no live benchmark data on-device).
 */

export type RoutingPolicy =
  'manual' | 'quality' | 'cost' | 'latency' | 'privacy' | 'capability' | 'autopilot';

/** The task a request serves; used to pick a sensible default policy for 'auto' callers. */
export type TaskKind = 'chat' | 'autocomplete' | 'planning' | 'refactor' | 'review' | 'agent';

export interface RouteCaps {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  longContext: boolean;
}

export interface RouteCandidate {
  provider: string;
  model: string;
  /** True when the endpoint runs locally (keyless + loopback/empty base URL). */
  local: boolean;
  /** True when the candidate can actually be used (has a key, or is keyless/local). */
  usable: boolean;
  /** 0..100, higher is better output quality. */
  qualityRank: number;
  /** 0..100, lower is cheaper. */
  costRank: number;
  /** 0..100, lower is faster to first token. */
  latencyRank: number;
  capabilities: RouteCaps;
}

export interface RouteRequest {
  policy: RoutingPolicy;
  task?: TaskKind;
  /** Only keep candidates that satisfy these capabilities (capability policy). */
  required?: Partial<RouteCaps>;
}

export const ROUTING_POLICIES: readonly RoutingPolicy[] = [
  'manual',
  'quality',
  'cost',
  'latency',
  'privacy',
  'capability',
  'autopilot',
] as const;

export const ROUTING_POLICY_LABELS: Record<RoutingPolicy, string> = {
  manual: 'Manual (use my order)',
  quality: 'Quality-first',
  cost: 'Cost-optimized',
  latency: 'Latency-optimized',
  privacy: 'Privacy-first (prefer local)',
  capability: 'Capability-required',
  autopilot: 'Cost-aware autopilot (draft cheap, escalate)',
};

/** Coerce a persisted value into a known policy (defaults to 'manual'). */
export function parseRoutingPolicy(value: unknown): RoutingPolicy {
  return typeof value === 'string' && (ROUTING_POLICIES as readonly string[]).includes(value)
    ? (value as RoutingPolicy)
    : 'manual';
}

/** For 'auto'-style callers: a reasonable default policy per task profile. */
export function defaultPolicyForTask(task: TaskKind): RoutingPolicy {
  switch (task) {
    case 'autocomplete':
      return 'latency';
    case 'planning':
    case 'review':
    case 'refactor':
      return 'quality';
    default:
      return 'manual';
  }
}

const has = (model: string, ...needles: string[]): boolean => {
  const m = model.toLowerCase();
  return needles.some((n) => m.includes(n));
};

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * Derive routing metadata (caps + rankings + locality) for a provider/model from
 * the family and model-name markers. Heuristic and conservative for unknowns.
 */
export function deriveRouteMeta(
  provider: string,
  model: string,
  baseUrl: string,
): Omit<RouteCandidate, 'provider' | 'model' | 'usable'> {
  const info = providerInfo(provider);
  const family = info?.family ?? 'openai';
  const keyless = info?.keyless ?? false;
  let loopback = baseUrl.trim().length === 0;
  if (!loopback) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      loopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]';
    } catch {
      loopback = false;
    }
  }
  const local = keyless && loopback;

  // Base quality by family; adjusted by model-name markers.
  let quality =
    family === 'anthropic' ? 88 : family === 'gemini' ? 82 : provider === 'custom' ? 60 : 85;
  let cost = 50;
  let latency = 50;

  if (has(model, 'opus')) {
    quality += 10;
    cost = 90;
    latency = 78;
  } else if (has(model, 'sonnet', '4o', 'pro', 'large')) {
    quality += 5;
    cost = 60;
    latency = 55;
  }
  if (has(model, 'mini', 'haiku', 'flash', 'lite', 'small', '8b')) {
    quality -= 10;
    cost = 20;
    latency = 25;
  }
  const reasoning = has(model, 'o1', 'o3', 'r1', 'reason', 'think');
  if (reasoning) {
    quality += 6;
    latency = Math.max(latency, 75);
  }
  if (local) {
    cost = 0;
    latency = Math.min(latency, 20);
  }

  const capabilities: RouteCaps = {
    tools: true, // OpenAI-compatible endpoints generally support tool-call payloads
    vision: family !== 'openai' ? family === 'gemini' || family === 'anthropic' : true,
    reasoning,
    longContext: family === 'gemini' || family === 'anthropic' || has(model, '4o', '128k', 'pro'),
  };
  // Conservative defaults for a fully-unknown custom endpoint.
  if (provider === 'custom') {
    capabilities.vision = false;
    capabilities.longContext = has(model, '128k', 'pro', 'large');
  }

  return {
    local,
    qualityRank: clamp(quality),
    costRank: clamp(cost),
    latencyRank: clamp(latency),
    capabilities,
  };
}

function meetsRequired(caps: RouteCaps, required?: Partial<RouteCaps>): boolean {
  if (!required) return true;
  return (Object.keys(required) as (keyof RouteCaps)[]).every((k) => !required[k] || caps[k]);
}

/**
 * Order candidates into a preference chain per the routing policy. Unusable and
 * capability-failing candidates are dropped; ordering is stable (input order
 * breaks ties) so 'manual' preserves the caller's chain exactly.
 */
export function orderCandidates(
  candidates: readonly RouteCandidate[],
  req: RouteRequest,
): RouteCandidate[] {
  const usable = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.usable && meetsRequired(c.capabilities, req.required));

  const cmp: Record<RoutingPolicy, (a: RouteCandidate, b: RouteCandidate) => number> = {
    manual: () => 0,
    quality: (a, b) => b.qualityRank - a.qualityRank,
    capability: (a, b) => b.qualityRank - a.qualityRank,
    cost: (a, b) => a.costRank - b.costRank,
    latency: (a, b) => Number(b.local) - Number(a.local) || a.latencyRank - b.latencyRank,
    privacy: (a, b) => Number(b.local) - Number(a.local) || b.qualityRank - a.qualityRank,
    autopilot: (a, b) => autopilotOrder(a, b),
  };
  const compare = cmp[req.policy];

  return usable.sort((x, y) => compare(x.c, y.c) || x.i - y.i).map(({ c }) => c);
}
