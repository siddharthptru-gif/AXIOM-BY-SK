import { redactString, rootLogger } from '@axiom/shared';
import type {
  AiImageInput,
  AiModelsResult,
  AiResponseFormat,
  AiTestResult,
  ChatMessage,
} from '../../common/ipc';
import { providerFamily } from '../../common/providers';
import { cacheKey, getResponseCache, guardedFetch } from './aiGateway';
import { reasoningBody, type ReasoningConfig } from '../../common/reasoning';
import { planPromptCache } from '../../common/promptCache';
import { sanitizeAiHeaders } from '../../common/headerSafety';
import {
  deltasFromOpenAIChunk,
  assembleStream,
  createSseDataParser,
  textFromProviderContent,
  type StreamDelta,
} from '../../common/streamAssembler';

/**
 * AI provider probes (Main process, PRD Epoch F). Lightweight helpers a Custom
 * OpenAI-compatible provider uses to validate its configuration: Test Connection
 * and Fetch Models both hit the standard `/models` endpoint. Network calls run in
 * Main so the API key never reaches the renderer and is never logged (INV-3); the
 * key is sent only to the user's configured endpoint.
 */
const log = rootLogger.child('ai');

const PROBE_TIMEOUT_MS = 15000;

export interface OpenAiCompatCreds {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  /** Model to verify during Test Connection. Empty skips the chat-capability stage. */
  model?: string;
}

/** Parse and normalize an endpoint base without retaining credentials or query secrets. */
function baseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The Base URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The Base URL must start with http:// or https://.');
  }
  if (url.username || url.password) throw new Error('Credentials are not allowed in the Base URL.');
  if (url.search) {
    throw new Error(
      'Query parameters are not allowed in the Base URL. Use safe custom headers instead.',
    );
  }
  if (url.hash) throw new Error('Fragments are not allowed in the Base URL.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function normalizeBase(value: string): string {
  return baseUrl(value).toString().replace(/\/$/, '');
}

function endpointUrl(value: string, suffix: string): string {
  const url = baseUrl(value);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/${suffix.replace(/^\/+/, '')}`;
  return url.toString();
}

function safeEndpoint(value: string): string {
  try {
    const url = baseUrl(value);
    return `${url.host}${url.pathname || '/'}`;
  } catch {
    return '(invalid endpoint)';
  }
}

function trustedProviderHeaders(value: unknown): Record<string, string> {
  const result = sanitizeAiHeaders(value);
  if (result.rejectedNames.length > 0) {
    throw new Error(
      `Credential-bearing custom headers are not allowed (${result.rejectedNames.join(', ')}).`,
    );
  }
  return result.headers;
}

/** Compose request headers; Authorization is added only from Main's secret. */
function buildHeaders(creds: OpenAiCompatCreds): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...trustedProviderHeaders(creds.headers),
  };
  if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`;
  return headers;
}

/** Map a thrown fetch error to a concise, user-facing explanation (no secrets). */
function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { name?: string; message?: string; cause?: unknown };
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return 'The request timed out.';
    }
    const cause = err.cause;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = String((cause as { code: unknown }).code);
      if (code === 'ENOTFOUND') return 'Server not found (DNS lookup failed). Check the Base URL.';
      if (code === 'ECONNREFUSED')
        return 'Connection refused — is the server running and reachable?';
      if (code === 'ETIMEDOUT') return 'The connection timed out.';
      if (code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code.startsWith('UNABLE_TO'))
        return 'TLS/certificate error connecting to the server.';
      return `Network error (${code}).`;
    }
    if (err.name === 'EgressBlockedError') {
      return 'The configured endpoint is blocked by the AI egress policy.';
    }
    if (
      typeof err.message === 'string' &&
      /^(?:The provider did not start responding|The provider stream timed out)/.test(err.message)
    ) {
      return err.message;
    }
    if (
      typeof err.message === 'string' &&
      /^(The Base URL|Credentials are not allowed|Query parameters are not allowed|Fragments are not allowed)/.test(
        err.message,
      )
    ) {
      return err.message;
    }
  }
  return 'The network request failed before the provider returned a response.';
}

async function getModels(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await guardedFetch(url, { method: 'GET', headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Pull model ids out of an OpenAI-style `{ data: [{ id }] }` (or looser) body. */
function extractModelIds(json: unknown): string[] {
  const container =
    json && typeof json === 'object' && !Array.isArray(json) && 'data' in json
      ? (json as { data: unknown }).data
      : json;
  if (!Array.isArray(container)) return [];
  const ids: string[] = [];
  for (const item of container) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id: unknown }).id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * Second stage of Test Connection: can the SELECTED model actually complete?
 *
 * `/models` only proves the endpoint is reachable and the key is accepted. Relays
 * advertise catalogues far larger than what they can currently serve, so an
 * endpoint whose chat route is entirely dead used to report "Connection
 * successful" and every Ask/Build turn then failed with an opaque 5xx.
 *
 * Capability, not quality: any OpenAI-shaped 2xx counts, because a reasoning model
 * can legitimately spend a small token budget on thinking and return no visible
 * text. Only a transport or HTTP failure means the model is unusable.
 */
async function chatCapabilityProbe(creds: OpenAiCompatCreds, model: string): Promise<AiTestResult> {
  let url: string;
  try {
    url = endpointUrl(creds.baseUrl, 'chat/completions');
  } catch (error) {
    return { ok: false, message: 'Invalid Base URL', detail: describeError(error) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await guardedFetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(creds), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = providerErrorDetail(
        res.headers.get('content-type') ?? '',
        await readBoundedErrorBody(res),
      );
      const because = detail ? ` Provider said: ${detail}` : '';
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: 'Chat requests are not authorized',
          detail: `The endpoint lists models but rejected a chat completion (HTTP ${res.status}). The key may lack chat permission.`,
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          message: `Model "${model}" was not found`,
          detail: `The endpoint has no chat route for this model (HTTP 404).${because}`,
        };
      }
      if (res.status === 429) {
        // Quota is a live-usage condition, not a broken configuration.
        return {
          ok: true,
          message: 'Connection successful.',
          detail: `The endpoint and model respond, but chat is rate limited right now (HTTP 429).${because}`,
        };
      }
      return {
        ok: false,
        message: `Model "${model}" cannot complete requests`,
        detail: `The endpoint is reachable and authorized, but a minimal chat completion failed with HTTP ${res.status}. This is a failure inside the provider or its upstream, not in Axiom — pick a different model.${because}`,
      };
    }
    const json: unknown = await res.json().catch(() => null);
    const root = asRecord(json);
    if (!root || (!Array.isArray(root.choices) && !asRecord(root.usage))) {
      return {
        ok: false,
        message: 'Unexpected chat response',
        detail: `Model "${model}" returned 2xx but not an OpenAI-compatible completion.`,
      };
    }
    return { ok: true, message: 'Connection successful.', detail: '' };
  } catch (error) {
    return {
      ok: false,
      message: `Model "${model}" cannot complete requests`,
      detail: `${describeError(error)} The models list works, so the endpoint is reachable — this model's route is not.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test Connection: GET `{base}/models`, then verify the selected model can
 * actually complete a chat request. A successful result requires a 2xx, a
 * recognizable model-list payload (arbitrary HTML/login pages do not count as a
 * healthy OpenAI-compatible endpoint), and a working chat route for the model.
 */
export async function testConnection(creds: OpenAiCompatCreds): Promise<AiTestResult> {
  let url: string;
  try {
    url = endpointUrl(creds.baseUrl, 'models');
  } catch (error) {
    return { ok: false, message: 'Invalid Base URL', detail: describeError(error) };
  }
  try {
    const res = await getModels(url, buildHeaders(creds));
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: 'Authentication failed',
        detail: `The server rejected the API key (HTTP ${res.status}).`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: 'Endpoint not found',
        detail: `No models endpoint was found (HTTP 404). The Base URL usually ends with /v1.`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Server returned HTTP ${res.status}`,
        detail: 'The provider rejected the connection test. Check the endpoint and server logs.',
      };
    }
    const json: unknown = await res.json().catch(() => null);
    const container = asRecord(json)?.data ?? json;
    if (!Array.isArray(container)) {
      return {
        ok: false,
        message: 'Unexpected models response',
        detail: 'The endpoint returned 2xx but not an OpenAI-compatible model list.',
      };
    }
    const models = extractModelIds(json);
    const listed =
      models.length > 0
        ? `${models.length} model${models.length === 1 ? '' : 's'} available.`
        : 'The endpoint is reachable and authorized, but returned no model IDs.';
    const model = (creds.model ?? '').trim();
    if (model.length === 0) {
      return { ok: true, message: 'Connection successful.', detail: listed };
    }
    // The live probe is authoritative. Some gateways serve aliases they do not
    // advertise, so absence from `/models` is a hint to add, never a verdict.
    const unlisted = models.length > 0 && !models.includes(model);
    const capability = await chatCapabilityProbe(creds, model);
    if (!capability.ok) {
      if (!unlisted) return capability;
      return {
        ok: false,
        message: capability.message,
        detail:
          `${capability.detail ?? ''} It is also absent from this endpoint's model list — run Fetch Models and pick one from there.`.trim(),
      };
    }
    const note = unlisted
      ? `Model "${model}" is not advertised by this endpoint but completed a test request.`
      : `Model "${model}" completed a test request.`;
    return {
      ok: true,
      message: capability.message,
      detail: capability.detail ? `${listed} ${capability.detail}` : `${listed} ${note}`,
    };
  } catch (error) {
    log.warn('Custom provider test connection failed', { endpoint: safeEndpoint(creds.baseUrl) });
    return { ok: false, message: 'Could not reach the server', detail: describeError(error) };
  }
}

/** Fetch Models: GET `{base}/models` and return the discovered model ids. */
export async function fetchModels(creds: OpenAiCompatCreds): Promise<AiModelsResult> {
  let url: string;
  try {
    url = endpointUrl(creds.baseUrl, 'models');
  } catch (error) {
    return { ok: false, models: [], message: describeError(error) };
  }
  try {
    const res = await getModels(url, buildHeaders(creds));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, models: [], message: `Authentication failed (HTTP ${res.status}).` };
      }
      return { ok: false, models: [], message: `Server returned HTTP ${res.status}.` };
    }
    const json: unknown = await res.json();
    const container = asRecord(json)?.data ?? json;
    if (!Array.isArray(container)) {
      return {
        ok: false,
        models: [],
        message: 'The endpoint did not return an OpenAI-compatible model list.',
      };
    }
    return { ok: true, models: extractModelIds(json) };
  } catch (error) {
    log.warn('Custom provider fetch models failed', { endpoint: safeEndpoint(creds.baseUrl) });
    return { ok: false, models: [], message: describeError(error) };
  }
}

// ---- Streaming chat (PRD Epoch F) --------------------------------------------

export interface ChatParams {
  provider: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKey: string;
  /** Opaque resolver-issued credential identity used for cache isolation. */
  credentialRevision: string;
  messages: ChatMessage[];
  /** Main-validated images attached to the current user turn. */
  images?: AiImageInput[];
  /** Optional reasoning config (opt-in; applied only to reasoning-capable models). */
  reasoning?: ReasoningConfig;
}

/** Narrow an unknown to a plain object for safe field access. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Split a message list into a joined system prompt and the user/assistant turns. */
function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  const system: string[] = [];
  const turns: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else turns.push(m);
  }
  return { system: system.join('\n\n'), turns };
}

function lastUserMessageIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function openAiMessages(params: ChatParams): unknown[] {
  const images = params.images ?? [];
  if (images.length === 0) return params.messages;
  const target = lastUserMessageIndex(params.messages);
  if (target < 0) throw new Error('Image attachments require a user message.');
  return params.messages.map((message, index) =>
    index === target
      ? {
          role: message.role,
          content: [
            { type: 'text', text: message.content },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
          ],
        }
      : message,
  );
}

function anthropicTurns(turns: ChatMessage[], images: readonly AiImageInput[]): unknown[] {
  const target = lastUserMessageIndex(turns);
  if (images.length > 0 && target < 0) throw new Error('Image attachments require a user message.');
  return turns.map((message, index) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content:
      images.length > 0 && index === target
        ? [
            { type: 'text', text: message.content },
            ...images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data },
            })),
          ]
        : message.content,
  }));
}

function geminiContents(turns: ChatMessage[], images: readonly AiImageInput[]): unknown[] {
  const target = lastUserMessageIndex(turns);
  if (images.length > 0 && target < 0) throw new Error('Image attachments require a user message.');
  return turns.map((message, index) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [
      { text: message.content },
      ...(images.length > 0 && index === target
        ? images.map((image) => ({
            inlineData: { mimeType: image.mediaType, data: image.data },
          }))
        : []),
    ],
  }));
}

/** A sanitized provider failure with enough structure for bounded retry decisions. */
class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

const MAX_PROVIDER_RETRIES = 2;
const CONNECT_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_DELAYS_MS = [1_500, 4_000] as const;
// BluesMinds advertises a 5 RPM entry tier (https://doc.bluesminds.com/),
// or one request every 12 seconds. A missing Retry-After must therefore not trigger the old sub-two-second retry storm.
const RATE_LIMIT_RETRY_DELAYS_MS = [12_000, 24_000] as const;
const MAX_PROVIDER_COOLDOWNS = 32;
const PROVIDER_COOLDOWN_RETENTION_MS = 5 * MAX_RETRY_AFTER_MS;
interface ProviderCooldown {
  until: number;
  spacingMs: number;
  expiresAt: number;
}
const providerCooldowns = new Map<string, ProviderCooldown>();

/** Parse either Retry-After seconds or an HTTP date without trusting unbounded waits. */
function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// Bounds for reading a failed response. A provider error envelope is tiny; these
// caps keep a hostile or hung endpoint from buffering or stalling the failure path.
const MAX_ERROR_BODY_CHARS = 8_192;
const MAX_ERROR_BODY_WAIT_MS = 2_000;
/** How much sanitized provider text may reach the user-facing message. */
const MAX_PROVIDER_DETAIL_CHARS = 220;
/**
 * An unbroken token-shaped run this long is credential-shaped. The whole detail is
 * dropped rather than risk echoing key material `redactString` did not recognize.
 * Kept above the length of typical gateway request ids so those stay visible.
 */
const CREDENTIAL_SHAPED_RUN = /[A-Za-z0-9+/=_-]{48,}/;

/**
 * Read a bounded prefix of a failed response under its own deadline. The status
 * alone stays authoritative: any read failure simply yields no detail.
 */
async function readBoundedErrorBody(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), MAX_ERROR_BODY_WAIT_MS);
  });
  let text = '';
  try {
    while (text.length < MAX_ERROR_BODY_CHARS) {
      const step = await Promise.race([reader.read(), expiry]);
      if (step === 'timeout') break;
      if (step.done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(step.value, { stream: true });
    }
  } catch {
    /* the HTTP status remains the authoritative signal */
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS);
}

/**
 * Locate a JSON error envelope in a failed body. Gateways return these either as
 * a bare object or wrapped in a single SSE `data:` frame.
 */
function parseErrorEnvelope(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const candidates: string[] = [];
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const frame = line.replace(/^data:\s*/i, '').trim();
    if (frame.startsWith('{')) candidates.push(frame);
  }
  for (const candidate of candidates) {
    try {
      const record = asRecord(JSON.parse(candidate));
      if (record) return record;
    } catch {
      /* try the next frame */
    }
  }
  return null;
}

function firstString(values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

/** Redact, flatten, and cap one provider-supplied string before it reaches the UI. */
function safeProviderDetail(value: string): string {
  const cleaned = redactString(value)
    // Control characters could forge log lines or UI structure.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  if (CREDENTIAL_SHAPED_RUN.test(cleaned)) return '';
  return cleaned.length > MAX_PROVIDER_DETAIL_CHARS
    ? `${cleaned.slice(0, MAX_PROVIDER_DETAIL_CHARS - 1)}\u2026`
    : cleaned;
}

/**
 * Extract the provider's OWN machine-readable failure reason. Only a structured
 * JSON error envelope is accepted, and only its message/code/type fields — never
 * arbitrary body text, so an HTML login page or an echoed prompt cannot leak.
 */
function providerErrorDetail(contentType: string, body: string): string {
  if (!/\bjson\b|event-stream/i.test(contentType)) return '';
  const root = parseErrorEnvelope(body);
  if (!root) return '';
  const error = asRecord(root.error) ?? root;
  const message = firstString([
    error.message,
    error.detail,
    // Some gateways report `{"error": "<message>"}` rather than an error object.
    typeof root.error === 'string' ? root.error : undefined,
    root.message,
    root.detail,
  ]);
  const code = firstString([error.code, error.type, root.code]);
  if (!message) return safeProviderDetail(code);
  const detail = safeProviderDetail(message);
  if (!detail) return '';
  const safeCode = safeProviderDetail(code);
  return safeCode && !detail.toLowerCase().includes(safeCode.toLowerCase())
    ? `${detail} [${safeCode}]`
    : detail;
}

/**
 * The provider's own reason leads the message, because downstream diagnostics and
 * UI truncate long errors and the reason is the only part the user cannot guess.
 * Axiom's guidance follows.
 */
function providerHttpMessage(status: number, retryAfter: number | null, detail: string): string {
  const said = detail ? `${detail} — ` : '';
  if (status === 400) {
    return `HTTP 400: ${said}the provider rejected the request. Check the selected model and endpoint compatibility.`;
  }
  if (status === 401 || status === 403) {
    // Never echo provider text on an auth failure; it is the likeliest place for a
    // gateway to quote the credential it just rejected.
    return `HTTP ${status}: Authentication failed for the configured provider endpoint.`;
  }
  if (status === 404) {
    return `HTTP 404: ${said}the provider route or selected model was not found. Check the Base URL and model.`;
  }
  if (status === 408) {
    return `HTTP 408: ${said}the provider timed out while processing the request.`;
  }
  if (status === 413) {
    return `HTTP 413: ${said}the request context is too large for this provider.`;
  }
  if (status === 429) {
    const wait =
      retryAfter === null
        ? ''
        : ` The provider requested a ${Math.max(1, Math.ceil(retryAfter / 1_000))}s wait.`;
    return `HTTP 429: ${said}the provider rate limit was reached.${wait} Wait for quota to reset or configure a fallback provider.`;
  }
  if (status >= 500) {
    // A 5xx from a reachable, authorized endpoint is almost always the gateway's
    // own upstream or quota failing rather than anything Axiom sent, so say so and
    // name the two remedies the user actually controls.
    return `HTTP ${status}: ${said}the provider accepted the request but could not complete it. This is a failure inside the provider or its upstream model, not in Axiom. Try a different model, or configure a fallback provider.`;
  }
  return `HTTP ${status}: ${said}the provider rejected the request.`;
}

/**
 * Build a safe structured HTTP error. A bounded prefix of the body is parsed for
 * the provider's own structured error envelope, and only its message/code fields
 * are surfaced — redacted, control-stripped, credential-screened, and length
 * capped. Raw body text is still never surfaced or persisted, because gateways
 * can echo credentials or prompt data.
 */
async function providerHttpError(res: Response): Promise<ProviderHttpError> {
  const retryAfter = retryAfterMs(res.headers.get('retry-after'));
  const contentType = res.headers.get('content-type') ?? '';
  let detail = '';
  try {
    detail = providerErrorDetail(contentType, await readBoundedErrorBody(res));
  } catch {
    /* a diagnosable detail is best-effort; the status is what matters */
  }
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  const retryable =
    res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
  return new ProviderHttpError(
    providerHttpMessage(res.status, retryAfter, detail),
    res.status,
    retryable,
    retryAfter,
  );
}

function isTransientProviderError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:request timed out|connection timed out|connection refused|network error|network request failed|did not start responding|stream timed out)/i.test(
    message,
  );
}

function retryDelayFor(error: unknown, retryIndex: number): number | null {
  if (error instanceof ProviderHttpError && error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  if (error instanceof ProviderHttpError && error.status === 429) {
    return RATE_LIMIT_RETRY_DELAYS_MS[retryIndex] ?? null;
  }
  return RETRY_DELAYS_MS[retryIndex] ?? null;
}

function abortError(): Error {
  const error = new Error('The AI request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Wait for a retry without allowing Stop, window teardown, or workspace changes to hang. */
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function providerCooldownKey(params: ChatParams): string {
  let endpoint = params.baseUrl.trim();
  try {
    endpoint = normalizeBase(endpoint);
  } catch {
    // The normal adapter validation will report the invalid endpoint.
  }
  return `${params.provider}\u0000${endpoint}`;
}

function rememberProviderCooldown(params: ChatParams, delayMs: number): void {
  const key = providerCooldownKey(params);
  const now = Date.now();
  const boundedDelay = Math.max(0, Math.min(delayMs, MAX_RETRY_AFTER_MS));
  const current = providerCooldowns.get(key);
  const spacingMs = Math.min(Math.max(1_000, boundedDelay), RATE_LIMIT_RETRY_DELAYS_MS[0]);
  providerCooldowns.delete(key);
  providerCooldowns.set(key, {
    until: Math.max(current?.until ?? 0, now + boundedDelay),
    spacingMs: Math.max(current?.spacingMs ?? 0, spacingMs),
    expiresAt: Math.max(current?.expiresAt ?? 0, now + PROVIDER_COOLDOWN_RETENTION_MS),
  });
  while (providerCooldowns.size > MAX_PROVIDER_COOLDOWNS) {
    const oldest = providerCooldowns.keys().next().value as string | undefined;
    if (!oldest) break;
    providerCooldowns.delete(oldest);
  }
}

/**
 * Wait for the latest cooldown and atomically reserve the next provider slot.
 * Re-reading after every wait prevents an older waiter from deleting an extended
 * deadline; reserving in the same event-loop turn prevents a thundering herd.
 * Adaptive spacing expires after a bounded quiet period instead of penalizing a
 * recovered endpoint for the rest of the desktop process lifetime.
 */
async function waitForProviderCooldown(params: ChatParams, signal: AbortSignal): Promise<void> {
  const key = providerCooldownKey(params);
  for (;;) {
    const cooldown = providerCooldowns.get(key);
    if (!cooldown) return;
    const now = Date.now();
    const remaining = cooldown.until - now;
    if (remaining > 0) {
      await waitForRetry(remaining, signal);
      continue;
    }
    if (cooldown.expiresAt <= now) {
      providerCooldowns.delete(key);
      return;
    }
    // No await occurs between observing and reserving, so concurrent waiters
    // serialize through this update on JavaScript's event loop.
    cooldown.until = now + cooldown.spacingMs;
    providerCooldowns.delete(key);
    providerCooldowns.set(key, cooldown);
    return;
  }
}

/** Bound only the connection/header phase; successful streams use an idle deadline below. */
async function guardedChatFetch(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal;
  if (!signal) throw new Error('A cancellable AI request signal is required.');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await guardedFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !signal.aborted) {
      throw new Error(
        `The provider did not start responding within ${CONNECT_TIMEOUT_MS / 1_000} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

type SseReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<SseReadResult> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const succeed = (value: SseReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      fail(abortError());
    };
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      fail(
        new Error(
          `The provider stream timed out after ${STREAM_IDLE_TIMEOUT_MS / 1_000} seconds without data.`,
        ),
      );
    }, STREAM_IDLE_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(succeed, fail);
  });
}

/** Read a non-streaming completion with the same cancellation and idle guarantees as SSE. */
async function readJsonResponse(res: Response, signal: AbortSignal): Promise<unknown> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await readSseChunk(reader, signal);
      if (done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(describeError(error));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function exhaustedRetryError(error: unknown, retries: number): unknown {
  if (retries === 0) return error;
  const suffix = ` Axiom made ${retries} automatic ${retries === 1 ? 'retry' : 'retries'} before stopping.`;
  if (error instanceof ProviderHttpError) {
    return new ProviderHttpError(
      `${error.message}${suffix}`,
      error.status,
      error.retryable,
      error.retryAfterMs,
    );
  }
  return new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
}

/**
 * Read a Server-Sent-Events response using event framing rather than physical
 * lines. Multiline `data:` fields are joined and a final unterminated event is
 * flushed when the provider closes the stream.
 */
async function pumpSse(
  res: Response,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseDataParser(onData);
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { done, value } = await readSseChunk(reader, signal);
      if (done) {
        parser.push(decoder.decode());
        parser.finish();
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(describeError(error));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function extractAnthropicDelta(data: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const root = asRecord(json);
  if (!root || root.type !== 'content_block_delta') return null;
  const delta = asRecord(root.delta);
  if (!delta) return null;
  return typeof delta.text === 'string' ? delta.text : null;
}

function extractGeminiDelta(data: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const root = asRecord(json);
  if (!root) return null;
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const cand = asRecord(candidates[0]);
  if (!cand) return null;
  const content = asRecord(cand.content);
  if (!content) return null;
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = parts
    .map((value) => {
      const part = asRecord(value);
      return part && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
  return text.length > 0 ? text : null;
}

/** Token counts for a completed turn (as reported by the provider's stream). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Parse SSE `data` as a JSON object, or null on any failure. */
function parseRecord(data: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

/** OpenAI usage arrives in a trailing chunk when `stream_options.include_usage`. */
function extractOpenAiUsage(data: string): TokenUsage | null {
  const root = parseRecord(data);
  const usage = root ? asRecord(root.usage) : null;
  if (!usage) return null;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output };
}

/** Anthropic input tokens are set once, in the `message_start` event. */
function extractAnthropicInputTokens(data: string): number | null {
  const root = parseRecord(data);
  if (!root || root.type !== 'message_start') return null;
  const msg = asRecord(root.message);
  const usage = msg ? asRecord(msg.usage) : null;
  return usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
}

/** Anthropic output tokens accumulate; the latest `message_delta` is final. */
function extractAnthropicOutputTokens(data: string): number | null {
  const root = parseRecord(data);
  if (!root) return null;
  if (root.type === 'message_delta') {
    const usage = asRecord(root.usage);
    return usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  }
  if (root.type === 'message_start') {
    const msg = asRecord(root.message);
    const usage = msg ? asRecord(msg.usage) : null;
    return usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  }
  return null;
}

/** Gemini reports cumulative usage in `usageMetadata`; the last chunk is final. */
function extractGeminiUsage(data: string): TokenUsage | null {
  const root = parseRecord(data);
  const meta = root ? asRecord(root.usageMetadata) : null;
  if (!meta) return null;
  const input = typeof meta.promptTokenCount === 'number' ? meta.promptTokenCount : 0;
  const output = typeof meta.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0;
  return { inputTokens: input, outputTokens: output };
}

/**
 * Some OpenAI-compatible servers (many local servers + gateways) ignore
 * `stream: true` and reply with a single JSON completion instead of an SSE
 * stream. Pull the message content + usage out of that body so the reply renders
 * instead of appearing blank.
 */
function extractNonStreamCompletion(json: unknown): { text: string; usage: TokenUsage | null } {
  const root = asRecord(json);
  if (!root) return { text: '', usage: null };
  let text = '';
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c0 = asRecord(choices[0]);
    const message = c0 ? asRecord(c0.message) : null;
    const delta = c0 ? asRecord(c0.delta) : null;
    for (const candidate of [
      message?.content,
      message?.text,
      delta?.content,
      delta?.text,
      c0?.text,
    ]) {
      text = textFromProviderContent(candidate);
      if (text.length > 0) break;
    }
  }
  // Some OpenAI-compatible gateways expose Responses-style or simplified
  // completion fields even on `/chat/completions`.
  if (text.length === 0) {
    for (const candidate of [
      root.output_text,
      root.output,
      root.answer,
      root.response,
      root.text,
      root.content,
    ]) {
      text = textFromProviderContent(candidate);
      if (text.length > 0) break;
    }
  }
  const usageRec = asRecord(root.usage);
  let usage: TokenUsage | null = null;
  if (usageRec) {
    const input =
      typeof usageRec.prompt_tokens === 'number'
        ? usageRec.prompt_tokens
        : typeof usageRec.input_tokens === 'number'
          ? usageRec.input_tokens
          : 0;
    const output =
      typeof usageRec.completion_tokens === 'number'
        ? usageRec.completion_tokens
        : typeof usageRec.output_tokens === 'number'
          ? usageRec.output_tokens
          : 0;
    if (input || output) usage = { inputTokens: input, outputTokens: output };
  }
  return { text, usage };
}

/** OpenAI Chat Completions streaming — also serves the Custom provider. */
async function streamOpenAiCompatible(
  p: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<AiResponseFormat> {
  const base = normalizeBase(p.baseUrl || 'https://api.openai.com/v1');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...p.headers };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  let res: Response;
  try {
    res = await guardedChatFetch(endpointUrl(base, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: p.model,
        messages: openAiMessages(p),
        stream: true,
        stream_options: { include_usage: true },
        ...reasoningBody('openai', p.model, p.reasoning),
      }),
      signal,
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!res.ok) throw await providerHttpError(res);
  // Compatibility: if the server ignored `stream: true` and returned a plain JSON
  // completion (Content-Type: application/json) instead of SSE, parse the whole
  // body so the reply renders instead of appearing blank.
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('json')) {
    const json = await readJsonResponse(res, signal);
    const nonStream = extractNonStreamCompletion(json);
    if (nonStream.text) onDelta(nonStream.text);
    if (nonStream.usage) onUsage(nonStream.usage);
    return 'openai-json';
  }
  let usage: TokenUsage | null = null;
  const toolDeltas: StreamDelta[] = [];
  let reasoningOpen = false;
  let sawContent = false;
  await pumpSse(res, signal, (data) => {
    if (data === '[DONE]') return;
    const u = extractOpenAiUsage(data);
    if (u) usage = u;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    for (const d of deltasFromOpenAIChunk(json)) {
      if (d.kind === 'content') {
        if (reasoningOpen) {
          onDelta('</think>\n\n');
          reasoningOpen = false;
        }
        sawContent = true;
        onDelta(d.text);
      } else if (d.kind === 'reasoning') {
        // Some OpenAI-compatible reasoning models stream thinking tokens in a
        // separate `reasoning_content` field that the old extractor dropped.
        // Wrap them so the existing thinking-mode UI (common/thinking.ts) shows
        // them. No reasoning field => no change for ordinary streams.
        if (!reasoningOpen) {
          onDelta('<think>');
          reasoningOpen = true;
        }
        onDelta(d.text);
      } else if (d.kind === 'tool_call') {
        toolDeltas.push(d);
      }
    }
  });
  if (reasoningOpen) onDelta('</think>\n\n');
  // Finalize any streamed tool-call fragments (PRD Phase 148). When the turn
  // produced no visible content (a tool-only reply), surface a concise summary
  // of the assembled calls so the assistant message is not blank.
  if (toolDeltas.length > 0 && !sawContent) {
    const summary = assembleStream(toolDeltas)
      .toolCalls.map((c) => `${c.name || '(tool)'}(${c.arguments || ''})`)
      .join(', ');
    if (summary.length > 0) onDelta(`Requested tool call: ${summary}`);
  }
  if (usage) onUsage(usage);
  return 'openai-sse';
}

/** Anthropic Messages API streaming. */
async function streamAnthropic(
  p: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<AiResponseFormat> {
  const base = normalizeBase(p.baseUrl || 'https://api.anthropic.com');
  const { system, turns } = splitSystem(p.messages);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...p.headers,
  };
  if (p.apiKey) headers['x-api-key'] = p.apiKey;
  // Prompt caching (PRD F §157): when the stable system prefix is large enough to
  // be worth caching, send it as a content block marked with `cache_control` so
  // repeat turns re-use the cached prefix (~10x cheaper on those tokens). Small
  // prefixes stay a plain string (below Anthropic's cache floor — no benefit).
  const cachePlan = planPromptCache({ messages: p.messages, family: 'anthropic' });
  const systemField =
    system && cachePlan.cacheable
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  let res: Response;
  try {
    res = await guardedChatFetch(endpointUrl(base, 'v1/messages'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: p.model,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system: systemField } : {}),
        ...reasoningBody('anthropic', p.model, p.reasoning),
        messages: anthropicTurns(turns, p.images ?? []),
      }),
      signal,
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!res.ok) throw await providerHttpError(res);
  let inputTokens = 0;
  let outputTokens = 0;
  let haveUsage = false;
  await pumpSse(res, signal, (data) => {
    const it = extractAnthropicInputTokens(data);
    if (it !== null) {
      inputTokens = it;
      haveUsage = true;
    }
    const ot = extractAnthropicOutputTokens(data);
    if (ot !== null) {
      outputTokens = ot;
      haveUsage = true;
    }
    const delta = extractAnthropicDelta(data);
    if (delta) onDelta(delta);
  });
  if (haveUsage) onUsage({ inputTokens, outputTokens });
  return 'anthropic-sse';
}

/** Google Gemini streaming (streamGenerateContent, SSE). */
async function streamGemini(
  p: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<AiResponseFormat> {
  const base = normalizeBase(p.baseUrl || 'https://generativelanguage.googleapis.com');
  const { system, turns } = splitSystem(p.messages);
  const url = new URL(
    endpointUrl(base, `v1beta/models/${encodeURIComponent(p.model)}:streamGenerateContent`),
  );
  url.searchParams.set('alt', 'sse');
  url.searchParams.set('key', p.apiKey);
  let res: Response;
  try {
    res = await guardedChatFetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...p.headers },
      body: JSON.stringify({
        contents: geminiContents(turns, p.images ?? []),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      }),
      signal,
    });
  } catch (error) {
    throw new Error(describeError(error));
  }
  if (!res.ok) throw await providerHttpError(res);
  let usage: TokenUsage | null = null;
  await pumpSse(res, signal, (data) => {
    const u = extractGeminiUsage(data);
    if (u) usage = u;
    const delta = extractGeminiDelta(data);
    if (delta) onDelta(delta);
  });
  if (usage) onUsage(usage);
  return 'gemini-sse';
}

/**
 * Dispatch one attempt to the correct adapter by provider *family* (PRD Phase
 * 135). Text deltas via `onDelta`; token usage via `onUsage`; `signal` cancels.
 */
function dispatchOnce(
  params: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<AiResponseFormat> {
  const trustedParams: ChatParams = {
    ...params,
    headers: trustedProviderHeaders(params.headers),
  };
  switch (providerFamily(trustedParams.provider)) {
    case 'anthropic':
      return streamAnthropic(trustedParams, onDelta, onUsage, signal);
    case 'gemini':
      return streamGemini(trustedParams, onDelta, onUsage, signal);
    default:
      // OpenAI + custom + any other OpenAI-compatible endpoint.
      return streamOpenAiCompatible(trustedParams, onDelta, onUsage, signal);
  }
}

/**
 * Retry one provider only while doing so is safe: the failure is transient, no
 * output has reached the renderer, the wait is bounded, and the request remains
 * active. Usage is held until an attempt completes so failed retries cannot be
 * charged or rendered twice.
 */
async function dispatchByFamily(
  params: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<AiResponseFormat> {
  let retries = 0;
  for (;;) {
    await waitForProviderCooldown(params, signal);
    let emittedOutput = false;
    let completedUsage: TokenUsage | null = null;
    try {
      const format = await dispatchOnce(
        params,
        (part) => {
          if (part.length > 0) emittedOutput = true;
          onDelta(part);
        },
        (usage) => {
          completedUsage = usage;
        },
        signal,
      );
      if (completedUsage) onUsage(completedUsage);
      return format;
    } catch (error) {
      const transient = isTransientProviderError(error);
      const delayMs = transient ? retryDelayFor(error, retries) : null;
      if (error instanceof ProviderHttpError && error.status === 429) {
        const fallbackDelay =
          RATE_LIMIT_RETRY_DELAYS_MS[Math.min(retries, RATE_LIMIT_RETRY_DELAYS_MS.length - 1)] ??
          RATE_LIMIT_RETRY_DELAYS_MS[RATE_LIMIT_RETRY_DELAYS_MS.length - 1];
        rememberProviderCooldown(
          params,
          Math.min(error.retryAfterMs ?? fallbackDelay ?? MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS),
        );
      }
      if (
        signal.aborted ||
        emittedOutput ||
        !transient ||
        retries >= MAX_PROVIDER_RETRIES ||
        delayMs === null
      ) {
        throw exhaustedRetryError(error, retries);
      }
      retries += 1;
      log.warn('Retrying transient AI provider request', {
        provider: params.provider,
        model: params.model,
        retry: retries,
        delayMs,
      });
      if (!(error instanceof ProviderHttpError && error.status === 429)) {
        await waitForRetry(delayMs, signal);
      }
    }
  }
}

/**
 * Stream a single chat completion (no failover). Identical requests are served
 * from the response cache (replayed as one delta); on a miss the streamed reply
 * is accumulated and cached once it completes without an abort.
 */
export async function chat(
  params: ChatParams,
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage) => void,
  signal: AbortSignal,
): Promise<void> {
  // Defense in depth at the final provider-dispatch boundary. Main IPC and
  // settings migration reject these too, but no internal caller can bypass this.
  const trustedParams: ChatParams = {
    ...params,
    headers: trustedProviderHeaders(params.headers),
  };
  const cache = getResponseCache();
  const key = cacheKey(trustedParams);
  const hit = cache.get(key);
  if (hit) {
    if (signal.aborted) throw abortError();
    if (hit.text) onDelta(hit.text);
    onUsage(hit.usage);
    return;
  }
  let text = '';
  let usage: TokenUsage | null = null;
  await dispatchByFamily(
    trustedParams,
    (t) => {
      text += t;
      onDelta(t);
    },
    (u) => {
      // Publish usage only after the response is known to contain renderable
      // output. This prevents a token-only turn from looking successful.
      usage = u;
    },
    signal,
  );
  if (signal.aborted) throw abortError();
  if (text.trim().length === 0) {
    throw new Error(
      `The ${trustedParams.provider} model “${trustedParams.model}” completed without returning renderable text. Verify the model and endpoint response format.`,
    );
  }
  const completedUsage = usage ?? { inputTokens: 0, outputTokens: 0 };
  if (usage) onUsage(usage);
  cache.set(key, { text, usage: completedUsage });
}

/**
 * Failover core (PRD Phases 165/167). Tries attempts in order; falls over to the
 * next only when an attempt fails **before streaming any content** and it is not
 * the last attempt, and never on user abort. Returns the index that succeeded.
 * The per-attempt runner is injected so the decision logic is unit-testable.
 */
export async function runChain<T>(
  attempts: readonly T[],
  runAttempt: (attempt: T, onDelta: (t: string) => void, signal: AbortSignal) => Promise<void>,
  onDelta: (t: string) => void,
  signal: AbortSignal,
): Promise<number> {
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    let started = false;
    let pending = '';
    const wrapped = (t: string): void => {
      if (!started) {
        pending += t;
        if (pending.trim().length === 0) return;
        started = true;
        onDelta(pending);
        pending = '';
        return;
      }
      onDelta(t);
    };
    try {
      const attempt = attempts[i] as T;
      await runAttempt(attempt, wrapped, signal);
      return i;
    } catch (e) {
      if (signal.aborted || started || i === attempts.length - 1) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error('No providers to try.');
}

export interface ChatFailoverResult {
  attemptIndex: number;
  responseFormat: AiResponseFormat;
}

/** Stream a chat completion with provider failover across an ordered chain. */
export async function chatWithFailover(
  attempts: readonly ChatParams[],
  onDelta: (t: string) => void,
  onUsage: (u: TokenUsage, attemptIndex: number) => void,
  signal: AbortSignal,
): Promise<ChatFailoverResult> {
  const indexed = attempts.map((attempt, index) => ({ attempt, index }));
  let responseFormat: AiResponseFormat = 'unknown';
  const attemptIndex = await runChain(
    indexed,
    async (entry, delta, sig) => {
      let text = '';
      let usage: TokenUsage | null = null;
      const format = await dispatchByFamily(
        entry.attempt,
        (part) => {
          text += part;
          delta(part);
        },
        (reported) => {
          usage = reported;
        },
        sig,
      );
      if (sig.aborted) throw abortError();
      if (text.trim().length === 0) {
        throw new Error(
          `The ${entry.attempt.provider} model “${entry.attempt.model}” completed without returning renderable text. Verify the model and endpoint response format.`,
        );
      }
      responseFormat = format;
      if (usage) onUsage(usage, entry.index);
    },
    onDelta,
    signal,
  );
  return { attemptIndex, responseFormat };
}
