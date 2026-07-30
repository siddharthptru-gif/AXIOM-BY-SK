import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { rootLogger } from '@axiom/shared';
import type { ChatParams, TokenUsage } from './ai';
import { normalizeMessages } from '../../common/requestDedup';
import { resolveEgress, DEFAULT_EGRESS_POLICY, type EgressPolicy } from '../../common/aiSafety';

/**
 * AI egress gateway + response cache + rate limiter (PRD Epoch F — engine
 * hardening). Every outbound AI request funnels through `guardedFetch`, which is
 * the single policy chokepoint: it validates the destination (HTTPS, or HTTP
 * only to loopback for local model servers), throttles per host with a token
 * bucket so an agent loop can't flood a provider, and logs the host only — never
 * the full URL, since some providers (Gemini) carry the API key in the query
 * string (INV-3). Identical chat requests are served from an in-memory TTL/LRU
 * cache so repeats cost nothing. All logic here is pure/deterministic given a
 * `now`, so it is exercised by a standalone contract test.
 */
const log = rootLogger.child('ai-egress');

// Generous defaults: a human never trips these; a runaway agent/burst does.
const EGRESS_BURST = 12;
const EGRESS_REFILL_PER_SEC = 8;

// Response cache: bounded + short-lived so repeats are cheap without going stale.
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 5 * 60_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Three Main-validated 5 MiB images expand to ~20 MiB as base64; leave a bounded
// margin for text/context while still rejecting unexpectedly large egress bodies.
const MAX_AI_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_AI_RESPONSE_BYTES = 32 * 1024 * 1024;

const blockedAiIpv4Addresses = new BlockList();
const blockedAiIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAiIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAiIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

// ---- rate limiter (token bucket per key) ------------------------------------

/** A per-key token-bucket rate limiter. Deterministic given an explicit `now`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  /** Current bucket state for `key`, refilled up to `now` (does not persist). */
  private peek(key: string, now: number): { tokens: number; updated: number } {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsedSec = Math.max(0, now - b.updated) / 1000;
    const tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    return { tokens, updated: now };
  }

  /** Consume one token if available; returns true on success (pure given `now`). */
  tryRemove(key: string, now: number = Date.now()): boolean {
    const b = this.peek(key, now);
    if (b.tokens >= 1) {
      this.buckets.set(key, { tokens: b.tokens - 1, updated: now });
      return true;
    }
    this.buckets.set(key, b);
    return false;
  }

  /** Milliseconds until at least one token is available (0 if available now). */
  msUntilAvailable(key: string, now: number = Date.now()): number {
    const b = this.peek(key, now);
    if (b.tokens >= 1) return 0;
    return Math.ceil(((1 - b.tokens) / this.refillPerSec) * 1000);
  }

  /** Wait (honoring `signal`) until a token frees up, then consume it. */
  async acquire(key: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (this.tryRemove(key)) return;
      await sleep(Math.min(Math.max(this.msUntilAvailable(key), 5), 1000), signal);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

function abortError(): Error {
  const e = new Error('Egress wait aborted.');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---- response cache (TTL + LRU) ---------------------------------------------

export interface CachedResponse {
  text: string;
  usage: TokenUsage;
}

/** Bounded, TTL'd, least-recently-used cache of completed chat responses. */
export class ResponseCache {
  private readonly map = new Map<string, { value: CachedResponse; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, now: number = Date.now()): CachedResponse | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expires <= now) {
      this.map.delete(key);
      return null;
    }
    // LRU touch: reinsert so this key becomes the most-recently-used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CachedResponse, now: number = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: now + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

function normalizeBaseForKey(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    // Scheme/host are case-insensitive; path and query may identify distinct
    // tenants/deployments and therefore retain their original case.
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * Stable cache key for a chat request: provider + model + authorized endpoint +
 * the message content. Message content is normalized so requests differing only
 * in trailing whitespace or blank lines share a cache entry. The resolver's
 * opaque revision and normalized ordinary headers isolate credentials/accounts
 * without retaining or hashing API key material in the cache layer.
 */
export function cacheKey(
  params: Pick<
    ChatParams,
    | 'provider'
    | 'model'
    | 'baseUrl'
    | 'messages'
    | 'images'
    | 'headers'
    | 'credentialRevision'
  >,
): string {
  const headers = Object.entries(params.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const headerIdentity = createHash('sha256').update(JSON.stringify(headers)).digest('hex');
  const canonical = JSON.stringify({
    provider: params.provider,
    model: params.model,
    baseUrl: normalizeBaseForKey(params.baseUrl),
    credentialRevision: params.credentialRevision,
    headerIdentity,
    messages: normalizeMessages(params.messages),
    images: (params.images ?? []).map((image) => ({
      mediaType: image.mediaType,
      sha256: image.sha256,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---- egress policy + guarded fetch ------------------------------------------

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/**
 * Validate an outbound AI URL against egress policy. HTTPS is always allowed;
 * plain HTTP only to loopback (local model servers like Ollama/LM Studio);
 * anything else is refused. Returns the parsed URL for host extraction.
 */
export function assertEgressAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('Invalid request URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EgressBlockedError(`Blocked non-HTTP egress (${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new EgressBlockedError('Credential-bearing endpoint URLs are not allowed.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new EgressBlockedError(
      'Blocked insecure HTTP egress to a non-loopback host — use https://.',
    );
  }
  if (
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new EgressBlockedError('Blocked private or special-use AI endpoint hostname.');
  }
  return url;
}

export interface PinnedAiAddress {
  address: string;
  family: 4 | 6;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return normalized === '::1';
}

function isPublicAiAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return !blockedAiIpv4Addresses.check(normalized, 'ipv4');
  if (family === 6) return !blockedAiIpv6Addresses.check(normalized, 'ipv6');
  return false;
}

/**
 * Select one policy-approved DNS answer for the pinned transport. Unsafe answers
 * are never connected to; mixed answers are valid when at least one independently
 * passes policy (for example, a public A record plus a synthesized NAT64 AAAA).
 */
export function selectPinnedAiAddress(
  addresses: ReadonlyArray<{ address: string; family: number }>,
  localMode: boolean,
): PinnedAiAddress {
  if (addresses.length === 0) {
    throw new EgressBlockedError('AI endpoint host did not resolve.');
  }
  const approved: PinnedAiAddress[] = [];
  for (const entry of addresses) {
    if (entry.family !== 4 && entry.family !== 6) continue;
    const allowed = localMode
      ? isLoopbackAddress(entry.address)
      : isPublicAiAddress(entry.address);
    if (allowed) approved.push({ address: entry.address, family: entry.family });
  }
  if (approved.length === 0) {
    throw new EgressBlockedError('AI endpoint DNS resolved only to private or special-use addresses.');
  }
  return approved[0]!;
}

async function resolvePinnedAiAddress(url: URL, signal?: AbortSignal): Promise<PinnedAiAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const localMode = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (localMode ? !isLoopbackAddress(hostname) : !isPublicAiAddress(hostname)) {
      throw new EgressBlockedError('AI endpoint targets a private or special-use address.');
    }
    return { address: hostname, family: literalFamily };
  }

  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolveLookup, rejectLookup) => {
    let settled = false;
    const finish = (
      error: unknown,
      value?: Array<{ address: string; family: number }>,
    ): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectLookup(error);
      else resolveLookup(value!);
    };
    const onAbort = (): void => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void lookup(hostname, { all: true, verbatim: true }).then(
      (value) => finish(null, value),
      () => finish(new EgressBlockedError('AI endpoint host resolution failed.')),
    );
  });
  return selectPinnedAiAddress(addresses, localMode);
}

function requestBodyBytes(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf-8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new EgressBlockedError('Unsupported outbound AI request body type.');
}

function responseHeadersFromNode(
  values: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (typeof value === 'string') headers.append(name, value);
  }
  return headers;
}

async function pinnedAiRequest(url: URL, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  const address = await resolvePinnedAiAddress(url, signal ?? undefined);
  if (signal?.aborted) throw abortError();
  const bytes = requestBodyBytes(init.body);
  if (bytes && bytes.byteLength > MAX_AI_REQUEST_BYTES) {
    throw new EgressBlockedError('Outbound AI request exceeds the transport size limit.');
  }
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    if (name.toLowerCase() !== 'host' && name.toLowerCase() !== 'content-length') {
      headers[name] = value;
    }
  });
  headers.Host = url.host;
  if (bytes) headers['Content-Length'] = String(bytes.byteLength);

  return new Promise<Response>((resolveResponse, rejectResponse) => {
    let delivered = false;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      signal?.removeEventListener('abort', onAbort);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        ...(url.protocol === 'https:' && isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
          ? { servername: url.hostname }
          : {}),
        headers,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          cleanup();
          rejectResponse(new EgressBlockedError('AI endpoint redirects are not allowed.'));
          return;
        }
        const declared = Number(incoming.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_AI_RESPONSE_BYTES) {
          incoming.destroy();
          cleanup();
          rejectResponse(new EgressBlockedError('AI response exceeds the transport size limit.'));
          return;
        }
        const noBody = (init.method ?? 'GET').toUpperCase() === 'HEAD' || status === 204 || status === 304;
        if (noBody) {
          delivered = true;
          incoming.resume();
          incoming.once('end', cleanup);
          resolveResponse(
            new Response(null, {
              status,
              ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
              headers: responseHeadersFromNode(incoming.headers),
            }),
          );
          return;
        }
        let length = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on('data', (chunk: Buffer) => {
              length += chunk.byteLength;
              if (length > MAX_AI_RESPONSE_BYTES) {
                const error = new EgressBlockedError('AI response exceeds the transport size limit.');
                incoming.destroy(error);
                controller.error(error);
                cleanup();
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            incoming.once('end', () => {
              controller.close();
              cleanup();
            });
            incoming.once('error', (error) => {
              controller.error(error);
              cleanup();
            });
          },
          cancel() {
            incoming.destroy();
            cleanup();
          },
        });
        delivered = true;
        resolveResponse(
          new Response(stream, {
            status,
            ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
            headers: responseHeadersFromNode(incoming.headers),
          }),
        );
      },
    );
    const onAbort = (): void => {
      request.destroy(abortError());
    };
    request.once('error', (error) => {
      cleanup();
      if (!delivered) rejectResponse(error);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (bytes) request.write(bytes);
    request.end();
  });
}

const egressLimiter = new RateLimiter(EGRESS_BURST, EGRESS_REFILL_PER_SEC);
const responseCache = new ResponseCache(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

// ---- active AI egress safety policy (Phase 170) -----------------------------

// The policy that `guardedFetch` applies to every outbound AI body. Defaults to
// 'audit' (detect + log, non-mutating) so behavior is unchanged until the user
// opts into 'sanitize'/'block'; kept in sync from settings by the main process.
let activeEgressPolicy: EgressPolicy = DEFAULT_EGRESS_POLICY;

/** Set the active outbound-AI safety policy (called from settings at startup + on change). */
export function setEgressSafetyPolicy(policy: EgressPolicy): void {
  activeEgressPolicy = policy;
}

/** The active outbound-AI safety policy (for readouts / tests). */
export function getEgressSafetyPolicy(): EgressPolicy {
  return activeEgressPolicy;
}

/**
 * The single outbound chokepoint for AI requests: enforce egress policy, wait
 * for a rate-limit token (per host), log the host only, then fetch.
 */
export async function guardedFetch(rawUrl: string, init: RequestInit): Promise<Response> {
  const url = assertEgressAllowed(rawUrl);
  const signal = init.signal ?? undefined;
  await egressLimiter.acquire(url.host, signal ?? undefined);
  log.debug('ai egress', { host: url.host, method: init.method ?? 'GET' });
  // Phase 170 AI safety — ACTIVE egress guardrail. Apply the configured policy to
  // the outbound body: 'audit' logs high-severity leaks (non-mutating, default),
  // 'sanitize' redacts secrets/PII in place, and 'block' refuses to send when a
  // finding at/above the block-severity threshold is present. API keys travel in
  // headers / the URL (not the body), so they are unaffected. Only value-free
  // metadata (rule ids + counts) is ever logged (INV-3); redaction text never
  // contains a raw secret. Bounded to avoid scanning huge bodies.
  const body = init.body;
  let outboundInit = init;
  if (activeEgressPolicy.mode !== 'off' && typeof body === 'string') {
    const scanLimit = 512 * 1024;
    if (body.length > scanLimit) {
      // Enforcing policies must never silently transmit a payload they could not
      // inspect. Audit mode remains non-mutating and records the skipped scan.
      if (activeEgressPolicy.mode === 'sanitize' || activeEgressPolicy.mode === 'block') {
        log.warn('ai egress blocked because body exceeds safety scan limit', {
          host: url.host,
          length: body.length,
          limit: scanLimit,
        });
        throw new EgressBlockedError('Outbound request exceeds the safety inspection limit.');
      }
      log.warn('ai egress safety scan skipped for oversized body in audit mode', {
        host: url.host,
        length: body.length,
        limit: scanLimit,
      });
    } else {
      const decision = resolveEgress(body, activeEgressPolicy);
      const rules = [...new Set(decision.findings.map((f) => f.ruleId))];
      if (decision.action === 'block') {
        log.warn('ai egress blocked by safety policy', {
          host: url.host,
          count: decision.findings.length,
          rules,
        });
        throw new EgressBlockedError(decision.summary);
      }
      if (decision.action === 'sanitize' && decision.redactions > 0) {
        log.warn('ai egress sanitized by safety policy', {
          host: url.host,
          redactions: decision.redactions,
          rules,
        });
        outboundInit = { ...init, body: decision.text };
      } else {
        const high = decision.findings.filter((f) => f.severity === 'high');
        if (high.length > 0) {
          log.warn('ai egress: possible credential in outbound request', {
            host: url.host,
            count: high.length,
            rules: [...new Set(high.map((s) => s.ruleId))],
          });
        }
      }
    }
  }
  return pinnedAiRequest(url, outboundInit);
}

/** Shared response cache used by `chat()` (exported for stats/clear + tests). */
export function getResponseCache(): ResponseCache {
  return responseCache;
}

/** Clear the AI response cache (e.g. from a settings action). */
export function clearResponseCache(): void {
  responseCache.clear();
}

/** Reset egress throttling state (used by tests). */
export function resetEgressLimiter(): void {
  egressLimiter.reset();
}
