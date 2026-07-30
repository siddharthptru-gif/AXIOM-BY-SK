/**
 * Prompt / context caching core (PRD Epoch F §157). Pure helpers that split a chat
 * request into a STABLE prefix (system prompt + workspace rules + pinned context —
 * identical turn-to-turn) and a VOLATILE suffix (recent conversation + the live
 * query), hash the stable prefix into a cache key, estimate the cached-vs-fresh
 * token split + billable savings, and emit provider-specific cache directives
 * (Anthropic explicit `cache_control` breakpoints; OpenAI / DeepSeek automatic
 * prefix caching; Gemini `cachedContent`). No I/O — a caller passes the composed
 * messages and gets a plan back. Unit-smoke-tested.
 */

/** Rough token estimate (~4 chars/token) — matches the context builder heuristic. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Provider families we know caching behaviour for. */
export type ProviderFamily = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'custom';

/** A chat message as far as caching cares (structural — matches ChatMessage). */
export interface CacheMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Force a non-system message into the stable prefix (workspace rules, pinned files). */
  pinned?: boolean;
}

/** Minimum stable-prefix tokens below which caching is never worth it anywhere. */
export const MIN_CACHEABLE_TOKENS = 1024;

/** Deterministic 32-bit FNV-1a hash → 8-hex-char string (pure, no crypto import). */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Split messages into the maximal leading run of STABLE messages (system role or
 * `pinned`) and everything after. Caching requires a *contiguous* prefix, so the
 * first volatile message ends the stable region.
 */
export function segmentMessages(messages: readonly CacheMessage[]): {
  stablePrefix: CacheMessage[];
  volatileSuffix: CacheMessage[];
} {
  let splitAt = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'system' || m.pinned === true) {
      splitAt = i + 1;
    } else {
      break;
    }
  }
  return {
    stablePrefix: messages.slice(0, splitAt),
    volatileSuffix: messages.slice(splitAt),
  };
}

/** Content-addressed key for a stable prefix (role+content joined, hashed, length-tagged). */
export function stablePrefixKey(prefix: readonly CacheMessage[]): string {
  const joined = prefix.map((m) => `${m.role}\u0001${m.content}`).join('\u0000');
  return `${hashText(joined)}_${joined.length}`;
}

/** Sum of estimated tokens across messages. */
export function estimateMessageTokens(messages: readonly CacheMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}

/** How a provider caches, its minimum prefix size, and its read/write cost multipliers. */
export interface CacheDirective {
  /** 'explicit' → we must mark breakpoints; 'automatic' → provider caches for us; 'none'. */
  mode: 'explicit' | 'automatic' | 'none';
  /** Minimum stable-prefix tokens before caching applies for this provider. */
  minTokens: number;
  /** Billable multiplier for tokens served FROM cache (vs full input price). */
  readMultiplier: number;
  /** Billable multiplier for the first turn that WRITES the prefix into the cache. */
  writeMultiplier: number;
  /** Marker to attach to the last stable block (explicit providers only). */
  breakpoint?: { type: string };
  note: string;
}

/** Cache behaviour per provider family (multipliers reflect published list pricing). */
export function cacheDirectiveFor(family: ProviderFamily): CacheDirective {
  switch (family) {
    case 'anthropic':
      return {
        mode: 'explicit',
        minTokens: 1024,
        readMultiplier: 0.1,
        writeMultiplier: 1.25,
        breakpoint: { type: 'ephemeral' },
        note: 'cache_control breakpoint on the last stable block (5m TTL)',
      };
    case 'openai':
      return {
        mode: 'automatic',
        minTokens: 1024,
        readMultiplier: 0.5,
        writeMultiplier: 1,
        note: 'automatic prefix caching (>=1024 tokens, 128-token steps)',
      };
    case 'deepseek':
      return {
        mode: 'automatic',
        minTokens: 1,
        readMultiplier: 0.1,
        writeMultiplier: 1,
        note: 'automatic on-disk context caching',
      };
    case 'gemini':
      return {
        mode: 'explicit',
        minTokens: 4096,
        readMultiplier: 0.25,
        writeMultiplier: 1,
        breakpoint: { type: 'cachedContent' },
        note: 'explicit cachedContent handle (>=4096 tokens)',
      };
    default:
      return {
        mode: 'none',
        minTokens: 0,
        readMultiplier: 1,
        writeMultiplier: 1,
        note: 'no prompt caching',
      };
  }
}

/**
 * Message indices that should carry a cache breakpoint marker (explicit providers
 * only). We mark the LAST stable message so the whole stable prefix is cached.
 */
export function cacheBreakpointIndices(
  messages: readonly CacheMessage[],
  family: ProviderFamily,
): number[] {
  const directive = cacheDirectiveFor(family);
  if (directive.mode !== 'explicit') return [];
  const { stablePrefix } = segmentMessages(messages);
  if (stablePrefix.length === 0) return [];
  return [stablePrefix.length - 1];
}

/** Inputs to the cache planner. */
export interface CachePlanInput {
  messages: readonly CacheMessage[];
  family: ProviderFamily;
  /** The stable-prefix key seen last turn (plan.key), to detect a warm hit. */
  priorKey?: string;
}

/** The full cache plan for one turn. */
export interface CachePlan {
  key: string;
  family: ProviderFamily;
  directive: CacheDirective;
  stableTokens: number;
  volatileTokens: number;
  totalTokens: number;
  /** Stable prefix is large enough to be cached by this provider. */
  cacheable: boolean;
  /** Cacheable AND the prefix matches priorKey → a warm cache hit this turn. */
  cacheHit: boolean;
  /** Tokens expected to be served from cache (0 unless cacheHit). */
  cachedTokens: number;
  /** Tokens that must be freshly processed this turn. */
  freshTokens: number;
  /** Fraction 0..1 of total tokens served from cache. */
  hitRatio: number;
  /** Message indices to mark with a cache breakpoint (explicit providers). */
  breakpointIndices: number[];
  summary: string;
}

/** One-line human summary of a plan (used in the context manifest footer). */
export function summarizeCachePlan(plan: Omit<CachePlan, 'summary'>): string {
  if (!plan.cacheable) {
    if (plan.directive.mode === 'none') return `no caching (${plan.family})`;
    return `not cacheable \u00B7 prefix ${plan.stableTokens.toLocaleString()} < ${plan.directive.minTokens.toLocaleString()} tok`;
  }
  if (plan.cacheHit) {
    const pct = Math.round(plan.hitRatio * 100);
    return `cache hit \u00B7 ${plan.cachedTokens.toLocaleString()}/${plan.totalTokens.toLocaleString()} tok cached (${pct}%)`;
  }
  return `cache write \u00B7 prefix ${plan.stableTokens.toLocaleString()} tok \u00B7 ${plan.directive.mode}`;
}

/** Compute the cache plan for a turn: segment, key, estimate, directive, hit split. */
export function planPromptCache(input: CachePlanInput): CachePlan {
  const { stablePrefix, volatileSuffix } = segmentMessages(input.messages);
  const directive = cacheDirectiveFor(input.family);
  const key = `${input.family}:${stablePrefixKey(stablePrefix)}`;
  const stableTokens = estimateMessageTokens(stablePrefix);
  const volatileTokens = estimateMessageTokens(volatileSuffix);
  const totalTokens = stableTokens + volatileTokens;
  const cacheable = directive.mode !== 'none' && stableTokens >= directive.minTokens;
  const cacheHit = cacheable && input.priorKey !== undefined && input.priorKey === key;
  const cachedTokens = cacheHit ? stableTokens : 0;
  const freshTokens = totalTokens - cachedTokens;
  const hitRatio = totalTokens > 0 ? cachedTokens / totalTokens : 0;
  const base: Omit<CachePlan, 'summary'> = {
    key,
    family: input.family,
    directive,
    stableTokens,
    volatileTokens,
    totalTokens,
    cacheable,
    cacheHit,
    cachedTokens,
    freshTokens,
    hitRatio,
    breakpointIndices: cacheBreakpointIndices(input.messages, input.family),
  };
  return { ...base, summary: summarizeCachePlan(base) };
}

/**
 * Billable-equivalent input tokens for this turn given caching. On a hit the cached
 * prefix is discounted by readMultiplier; on the first (write) turn the prefix costs
 * writeMultiplier (can exceed 1 for Anthropic). Returns totalTokens when uncacheable.
 */
export function effectiveInputTokens(plan: CachePlan): number {
  const d = plan.directive;
  if (!plan.cacheable) return plan.totalTokens;
  if (plan.cacheHit) {
    return Math.round(plan.cachedTokens * d.readMultiplier + plan.freshTokens);
  }
  return Math.round(plan.stableTokens * d.writeMultiplier + plan.volatileTokens);
}

/** Token-equivalent savings this turn (positive on hits; may be negative on a write). */
export function savedTokens(plan: CachePlan): number {
  return plan.totalTokens - effectiveInputTokens(plan);
}
