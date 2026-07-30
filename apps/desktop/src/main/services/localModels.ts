import { rootLogger } from '@axiom/shared';
import { LOCAL_MODEL_ENDPOINTS } from '../../common/providers';
import type { LocalModelProbe } from '../../common/ipc';

/**
 * Local model server detection (free, keyless, zero-egress AI).
 *
 * Axiom probes a loopback Ollama server and reports the models it already has
 * installed, so a user with no API key can still use Ask, Build, and every agent.
 *
 * Main is the only authority here:
 * - Only fixed loopback endpoints are probed; no renderer-supplied URL is accepted.
 * - The probe is bounded (timeout + response cap) and never follows redirects.
 * - Nothing leaves the machine: loopback requests cannot reach the network.
 * - A missing server is a normal, non-error outcome ("not detected"), never a crash.
 */
const log = rootLogger.child('local-models');
const PROBE_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MODELS = 60;
const MAX_MODEL_NAME = 200;

/** A model id is displayed only when it is a safe, bounded, printable token. */
function safeModelName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_MODEL_NAME) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('The local model server returned an oversized response.');
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('The local model server returned an oversized response.');
  }
  return JSON.parse(text) as unknown;
}

/** Extract model ids from Ollama's native `/api/tags` payload. */
function parseOllamaTags(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    if (names.length >= MAX_MODELS) break;
    if (!entry || typeof entry !== 'object') continue;
    const name =
      safeModelName((entry as { name?: unknown; model?: unknown }).name) ??
      safeModelName((entry as { model?: unknown }).model);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

async function probeEndpoint(
  origin: string,
  signal?: AbortSignal,
): Promise<LocalModelProbe | null> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/tags`, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const models = parseOllamaTags(await readBoundedJson(response));
    return {
      available: true,
      provider: 'ollama',
      label: 'Ollama',
      baseUrl: `${origin}/v1`,
      models,
      message:
        models.length > 0
          ? `Ollama is running with ${models.length} local model${models.length === 1 ? '' : 's'}. No API key needed.`
          : 'Ollama is running but has no models installed yet. Install one, for example: ollama pull llama3.2',
    };
  } catch {
    // A closed port, non-JSON reply, or timeout simply means "not detected".
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Detect a local, keyless model server. Returns an honest unavailable result with
 * actionable setup guidance rather than throwing when nothing is running.
 */
export async function detectLocalModels(signal?: AbortSignal): Promise<LocalModelProbe> {
  for (const origin of LOCAL_MODEL_ENDPOINTS) {
    if (signal?.aborted) break;
    const found = await probeEndpoint(origin, signal);
    if (found) {
      log.info('Local model server detected', {
        provider: found.provider,
        models: found.models.length,
      });
      return found;
    }
  }
  return {
    available: false,
    provider: 'ollama',
    label: 'Ollama',
    baseUrl: '',
    models: [],
    message:
      'No local model server detected. Install Ollama from ollama.com and run "ollama pull llama3.2" to use Axiom with no API key and zero data leaving your machine.',
  };
}
