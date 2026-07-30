import { disconnectGithub, getGithubCredentialForGit } from './githubScm';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const USER_AGENT = 'Axiom-Desktop';
const API_PATH =
  /^\/repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:issues\/[1-9]\d{0,9}|pulls|actions\/workflows\/[A-Za-z0-9_.-]{1,200}\/dispatches)$/;

export interface GithubApiResponse {
  status: number;
  ok: boolean;
  payload: unknown;
}

function parsePayload(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('GitHub returned malformed JSON.');
  }
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('GitHub response exceeded the size limit.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('GitHub response exceeded the size limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function githubApiRequest(
  ownerId: number,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
): Promise<GithubApiResponse> {
  if (!API_PATH.test(path)) throw new Error('GitHub API path is not allow-listed.');
  const access = await getGithubCredentialForGit();
  if (!access) throw new Error('Connect a GitHub account before using this workflow.');
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded, 'utf-8') > MAX_REQUEST_BYTES) {
    throw new Error('GitHub request exceeded the size limit.');
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${access}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(encoded ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(encoded ? { body: encoded } : {}),
    });
    const payload = parsePayload(await readBounded(response));
    if (response.status === 401) {
      await disconnectGithub(ownerId);
      throw new Error('GitHub authorization is no longer valid. Reconnect your account.');
    }
    return { status: response.status, ok: response.ok, payload };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error('GitHub did not respond before the request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
