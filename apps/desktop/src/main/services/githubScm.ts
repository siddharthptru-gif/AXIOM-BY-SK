import { shell } from 'electron';
import { randomBytes } from 'node:crypto';
import type {
  GithubAccount,
  GithubAuthState,
  GithubCreateRepositoryInput,
  GithubDeviceFlow,
  GithubFlowPollResult,
  GithubRepository,
} from '../../common/ipc';
import { authStorage } from './authStore';
import {
  GITHUB_ACCESS_ENDPOINT,
  GITHUB_DEVICE_CODE_ENDPOINT,
  GITHUB_REPOSITORIES_ENDPOINT,
  GITHUB_USER_ENDPOINT,
  GITHUB_VERIFICATION_URL,
  nextDevicePollIntervalSeconds,
  parseBoundedJson,
  parseDeviceCodePayload,
  parseDevicePollPayload,
  parseScopeList,
  validateGithubCloneUrl,
  validateGithubHtmlUrl,
  validateGithubRepositoryName,
  validateRepositoryInput,
} from './githubScmPure';
import { GithubDeviceFlowMachine, type GithubDeviceFlowDependencies } from './githubDeviceFlow';

const DEFAULT_PUBLIC_CLIENT_ID = 'Ov23liwAEf5dBY6BeewD';
const STORAGE_KEY = 'axiom.github.oauth.device-flow.v1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PENDING_FLOWS = 32;
const USER_AGENT = 'Axiom-Desktop';

interface StoredCredential {
  version: 1;
  access: string;
  scopes: string[];
}

interface ValidatedAccount {
  account: GithubAccount;
  scopes: string[];
}

function publicClientId(): string {
  return DEFAULT_PUBLIC_CLIENT_ID;
}

function safeError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return new Error(sanitized || fallback);
}

interface RequestContext {
  signal?: AbortSignal;
  deadline?: number;
  checkpoint?: () => void;
}

async function readBoundedBody(response: Response, checkpoint?: () => void): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('GitHub returned a response that was too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      checkpoint?.();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        checkpoint?.();
        throw new Error('GitHub returned a response that was too large.');
      }
      chunks.push(chunk.value);
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

async function fixedRequest(
  url:
    | typeof GITHUB_DEVICE_CODE_ENDPOINT
    | typeof GITHUB_ACCESS_ENDPOINT
    | typeof GITHUB_USER_ENDPOINT
    | typeof GITHUB_REPOSITORIES_ENDPOINT,
  init: RequestInit,
  context: RequestContext = {},
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  context.signal?.addEventListener('abort', onAbort, { once: true });
  const now = Date.now();
  const deadlineRemaining =
    context.deadline === undefined ? REQUEST_TIMEOUT_MS : Math.max(0, context.deadline - now);
  if (deadlineRemaining === 0) {
    context.signal?.removeEventListener('abort', onAbort);
    throw new Error('GitHub authorization request expired.');
  }
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadlineRemaining);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    context.checkpoint?.();
    const text = await readBoundedBody(response, context.checkpoint);
    context.checkpoint?.();
    return { response, payload: parseBoundedJson(text) };
  } catch (error) {
    if (context.deadline !== undefined && Date.now() >= context.deadline) {
      throw new Error('GitHub authorization request expired.');
    }
    if (controller.signal.aborted && !context.signal?.aborted) {
      throw new Error('GitHub did not respond before the request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', onAbort);
  }
}

function formHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT,
  };
}

function apiHeaders(access: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${access}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

function delay(ms: number, signal: AbortSignal, deadline: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Device authorization was cancelled.'));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('Device authorization expired.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        if (Date.now() >= deadline) reject(new Error('Device authorization expired.'));
        else resolve();
      },
      Math.min(ms, remaining),
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Device authorization was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function scopeAccess(scopes: string[]): GithubAccount['repositoryAccess'] {
  if (scopes.includes('repo')) return 'full';
  if (scopes.includes('public_repo')) return 'public';
  return 'none';
}

function accountWarning(access: GithubAccount['repositoryAccess']): string | null {
  if (access === 'full') return null;
  if (access === 'public') {
    return 'GitHub granted public-repository access only; private repository publishing is unavailable.';
  }
  return 'GitHub did not grant repository scope. Reconnect and approve repository access to publish.';
}

function parseAccount(value: unknown, scopes: string[]): GithubAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub returned a malformed account response.');
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const login = record.login;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) {
    throw new Error('GitHub returned an invalid account id.');
  }
  if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw new Error('GitHub returned an invalid account login.');
  }

  const rawName = record.name;
  const name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName
          .replace(/[\u0000-\u001f\u007f]+/g, ' ')
          .trim()
          .slice(0, 100)
      : null;
  const expectedProfile = `https://github.com/${login}`;
  if (record.html_url !== expectedProfile) {
    throw new Error('GitHub returned an unexpected account profile address.');
  }

  let avatarUrl: string | null = null;
  if (typeof record.avatar_url === 'string' && record.avatar_url.length <= 512) {
    try {
      const avatar = new URL(record.avatar_url);
      if (
        avatar.protocol === 'https:' &&
        avatar.hostname === 'avatars.githubusercontent.com' &&
        avatar.port === '' &&
        !avatar.username &&
        !avatar.password &&
        !avatar.hash
      ) {
        avatarUrl = avatar.toString();
      }
    } catch {
      avatarUrl = null;
    }
  }

  const repositoryAccess = scopeAccess(scopes);
  return {
    id: id as number,
    login,
    name,
    avatarUrl,
    profileUrl: expectedProfile,
    scopes,
    repositoryAccess,
    warning: accountWarning(repositoryAccess),
  };
}

async function validateAccount(
  access: string,
  fallbackScopes: string[],
  context: RequestContext = {},
): Promise<ValidatedAccount> {
  const { response, payload } = await fixedRequest(
    GITHUB_USER_ENDPOINT,
    { method: 'GET', headers: apiHeaders(access) },
    context,
  );
  context.checkpoint?.();
  if (response.status === 401) {
    await authStorage.removeItem(STORAGE_KEY).catch(() => undefined);
    context.checkpoint?.();
    throw new Error('GitHub authorization is no longer valid. Reconnect your account.');
  }
  if (!response.ok) throw new Error('GitHub could not validate the account.');
  const headerScopes = parseScopeList(response.headers.get('x-oauth-scopes'));
  const scopes = headerScopes.length > 0 ? headerScopes : fallbackScopes;
  return { account: parseAccount(payload, scopes), scopes };
}

async function writeCredential(access: string, scopes: string[]): Promise<void> {
  const value: StoredCredential = { version: 1, access, scopes };
  await authStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

async function readCredential(): Promise<StoredCredential | null> {
  const raw = await authStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredential>;
    if (
      parsed.version !== 1 ||
      typeof parsed.access !== 'string' ||
      !/^[A-Za-z0-9._~-]{8,512}$/.test(parsed.access) ||
      !Array.isArray(parsed.scopes) ||
      parsed.scopes.some((scope) => typeof scope !== 'string')
    ) {
      throw new Error('invalid');
    }
    return { version: 1, access: parsed.access, scopes: parseScopeList(parsed.scopes.join(' ')) };
  } catch {
    await authStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

async function clearCredential(expectedAccess?: string): Promise<void> {
  if (expectedAccess === undefined) {
    await authStorage.removeItem(STORAGE_KEY);
    return;
  }
  const current = await readCredential();
  if (current?.access === expectedAccess) await authStorage.removeItem(STORAGE_KEY);
}

const deviceFlowDependencies: GithubDeviceFlowDependencies = {
  now: Date.now,
  createId: () => randomBytes(24).toString('base64url'),
  startTimeoutMs: REQUEST_TIMEOUT_MS,
  maximumFlows: MAX_PENDING_FLOWS,
  verificationUrl: GITHUB_VERIFICATION_URL,
  requestDeviceAuthorization: async (signal, deadline, checkpoint) => {
    const body = new URLSearchParams({ client_id: publicClientId(), scope: 'read:user repo' });
    const { response, payload } = await fixedRequest(
      GITHUB_DEVICE_CODE_ENDPOINT,
      { method: 'POST', headers: formHeaders(), body },
      { signal, deadline, checkpoint },
    );
    checkpoint();
    if (!response.ok) throw new Error('GitHub could not start device authorization.');
    return parseDeviceCodePayload(payload);
  },
  requestToken: async (deviceCode, signal, deadline, checkpoint) => {
    const body = new URLSearchParams({
      client_id: publicClientId(),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const { response, payload } = await fixedRequest(
      GITHUB_ACCESS_ENDPOINT,
      { method: 'POST', headers: formHeaders(), body },
      { signal, deadline, checkpoint },
    );
    checkpoint();
    if (!response.ok) throw new Error('GitHub could not complete device authorization.');
    const result = parseDevicePollPayload(payload);
    return result.kind === 'success'
      ? { kind: 'success' as const, access: result.accessToken, scopes: result.scopes }
      : result;
  },
  validateAccount: (access, scopes, signal, deadline, checkpoint) =>
    validateAccount(access, scopes, { signal, deadline, checkpoint }),
  persistCredential: writeCredential,
  clearCredential,
  wait: delay,
  nextPollIntervalSeconds: nextDevicePollIntervalSeconds,
};

const deviceFlows = new GithubDeviceFlowMachine(deviceFlowDependencies);

export async function getGithubState(): Promise<GithubAuthState> {
  const credential = await readCredential();
  if (!credential) return { status: 'disconnected', account: null };
  try {
    const validated = await validateAccount(credential.access, credential.scopes);
    return { status: 'connected', account: validated.account };
  } catch (error) {
    throw safeError(error, 'GitHub account validation failed.');
  }
}

export function startGithubDeviceFlow(ownerId: number): Promise<GithubDeviceFlow> {
  return deviceFlows.start(ownerId);
}

export function pollGithubDeviceFlow(
  ownerId: number,
  flowId: unknown,
): Promise<GithubFlowPollResult> {
  return deviceFlows.poll(ownerId, flowId);
}

export function cancelGithubDeviceFlow(ownerId: number, flowId: unknown): void {
  deviceFlows.cancel(ownerId, flowId);
}

export async function openGithubVerification(ownerId: number, flowId: unknown): Promise<void> {
  deviceFlows.assertOwned(ownerId, flowId);
  await shell.openExternal(GITHUB_VERIFICATION_URL);
  deviceFlows.assertOwned(ownerId, flowId);
}

export function disconnectGithub(ownerId: number): Promise<void> {
  return deviceFlows.disconnect(ownerId);
}

export function cancelGithubFlowsForOwner(ownerId: number): void {
  deviceFlows.cancelOwner(ownerId);
}

export function cancelAllGithubFlows(): void {
  deviceFlows.cancelAll();
}

/** Main-internal only: used by the operation-scoped askpass broker. */
export async function getGithubCredentialForGit(): Promise<string | null> {
  return (await readCredential())?.access ?? null;
}

/**
 * Main-internal only: the stored credential as the extension authentication broker reads it.
 *
 * The scopes travel with the token because an extension asking for a session names the scopes
 * it needs, and answering that question from the connected account rather than from a guess is
 * what stops AXIOM handing over a credential that cannot do what the extension is about to
 * attempt. Nothing here mints or refreshes anything: the credential is whatever Axiom's own
 * Source Control sign-in already established.
 */
export async function getGithubCredentialSnapshot(): Promise<{
  access: string;
  scopes: string[];
} | null> {
  const credential = await readCredential();
  return credential === null ? null : { access: credential.access, scopes: [...credential.scopes] };
}

function assertRepositoryPermission(
  scopes: string[],
  visibility: GithubCreateRepositoryInput['visibility'],
): void {
  const access = scopeAccess(scopes);
  if (access === 'none' || (visibility === 'private' && access !== 'full')) {
    throw new Error(
      visibility === 'private'
        ? 'GitHub did not grant private-repository scope. Reconnect and approve repository access.'
        : 'GitHub did not grant repository scope. Reconnect and approve repository access.',
    );
  }
}

function parseRepository(
  value: unknown,
  expected: ReturnType<typeof validateRepositoryInput>,
  ownerLogin: string,
): GithubRepository {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub returned a malformed repository response.');
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.id) || (record.id as number) <= 0) {
    throw new Error('GitHub returned an invalid repository id.');
  }
  const name = validateGithubRepositoryName(record.name);
  if (name !== expected.name) throw new Error('GitHub returned an unexpected repository name.');
  const fullName = `${ownerLogin}/${name}`;
  if (record.full_name !== fullName) {
    throw new Error('GitHub returned an unexpected repository owner.');
  }
  const cloneUrl = validateGithubCloneUrl(record.clone_url);
  const htmlUrl = validateGithubHtmlUrl(record.html_url);
  if (cloneUrl !== `${htmlUrl}.git` || htmlUrl !== `https://github.com/${fullName}`) {
    throw new Error('GitHub returned mismatched repository addresses.');
  }
  if (typeof record.private !== 'boolean') {
    throw new Error('GitHub returned an invalid repository visibility.');
  }
  const visibility = record.private ? 'private' : 'public';
  if (visibility !== expected.visibility) {
    throw new Error('GitHub returned an unexpected repository visibility.');
  }
  return {
    id: record.id as number,
    name,
    fullName,
    visibility,
    cloneUrl,
    htmlUrl,
  };
}

export async function createGithubRepository(input: unknown): Promise<GithubRepository> {
  const validatedInput = validateRepositoryInput(input);
  const credential = await readCredential();
  if (!credential) throw new Error('Connect a GitHub account before creating a repository.');
  assertRepositoryPermission(credential.scopes, validatedInput.visibility);
  const validatedAccount = await validateAccount(credential.access, credential.scopes);
  assertRepositoryPermission(validatedAccount.scopes, validatedInput.visibility);

  const requestBody = JSON.stringify({
    name: validatedInput.name,
    description: validatedInput.description ?? '',
    private: validatedInput.visibility === 'private',
    auto_init: false,
  });
  if (requestBody.length > 1_024) throw new Error('Repository request is too large.');
  const { response, payload } = await fixedRequest(GITHUB_REPOSITORIES_ENDPOINT, {
    method: 'POST',
    headers: { ...apiHeaders(credential.access), 'Content-Type': 'application/json' },
    body: requestBody,
  });
  if (response.status === 401) {
    await authStorage.removeItem(STORAGE_KEY);
    throw new Error('GitHub authorization is no longer valid. Reconnect your account.');
  }
  if (!response.ok) throw new Error('GitHub could not create the repository.');
  return parseRepository(payload, validatedInput, validatedAccount.account.login);
}
