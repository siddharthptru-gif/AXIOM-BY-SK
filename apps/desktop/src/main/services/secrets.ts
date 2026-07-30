import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { aiSecretKey, type AiCredentialBinding } from '../../common/ipc';
import { providerInfo, type ProviderInfo } from '../../common/providers';
import { assertEgressAllowed } from './aiGateway';

/**
 * Secret storage (Main process, PRD Part X / INV-3). BYOK API keys are kept out
 * of the renderer entirely: they are encrypted at rest with the OS keychain via
 * Electron `safeStorage` and persisted to userData/secrets.json. The renderer
 * may set, probe, or clear a secret — but never read one back. Only Main
 * decrypts, and only to make outbound provider calls.
 */
interface StoredSecret {
  /** True when `data` is OS-encrypted; false identifies a legacy unencrypted entry. */
  enc: boolean;
  data: string;
  /** Opaque, non-secret revision used to isolate connection-scoped AI state. */
  revision?: string;
  /** Provider + normalized endpoint this credential is authorized for. */
  binding?: AiCredentialBinding;
}
type SecretStore = Record<string, StoredSecret>;

export interface ResolvedAiCredential {
  apiKey: string;
  /** Normalized endpoint authorized for this request. */
  baseUrl: string;
  /** Opaque, non-secret identity rotated whenever the credential is replaced. */
  revision: string;
}

class AiCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiCredentialError';
  }
}

class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/**
 * Serialize every store operation. In particular, a legacy revision migration
 * can never write an older snapshot over a concurrently saved endpoint binding.
 */
let storeQueue: Promise<void> = Promise.resolve();

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation);
  storeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface ParsedSecretStore {
  store: SecretStore;
  removedLegacy: boolean;
}

function parseStore(parsed: unknown): ParsedSecretStore {
  if (!isPlainObject(parsed)) {
    throw new SecretStoreError('The local secret store is malformed.');
  }
  const store: SecretStore = Object.create(null) as SecretStore;
  let removedLegacy = false;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPlainObject(value) || typeof value.enc !== 'boolean' || typeof value.data !== 'string') {
      throw new SecretStoreError('The local secret store contains a malformed entry.');
    }
    // Old builds could write reversible base64 entries. Drop them before this
    // store can be observed or rewritten; users must re-enter those credentials.
    if (!value.enc) {
      removedLegacy = true;
      continue;
    }
    if (value.revision !== undefined && typeof value.revision !== 'string') {
      throw new SecretStoreError('The local secret store contains an invalid revision.');
    }
    let binding: AiCredentialBinding | undefined;
    if (value.binding !== undefined) {
      if (
        !isPlainObject(value.binding) ||
        typeof value.binding.provider !== 'string' ||
        typeof value.binding.baseUrl !== 'string'
      ) {
        throw new SecretStoreError('The local secret store contains an invalid endpoint binding.');
      }
      binding = {
        provider: value.binding.provider,
        baseUrl: value.binding.baseUrl,
      };
    }
    store[key] = {
      enc: true,
      data: value.data,
      ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
      ...(binding ? { binding } : {}),
    };
  }
  return { store, removedLegacy };
}

async function readStore(): Promise<SecretStore> {
  let raw: string;
  try {
    raw = await fs.readFile(secretsPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return Object.create(null) as SecretStore;
    throw new SecretStoreError('The local secret store could not be read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretStoreError('The local secret store is not valid JSON.');
  }
  const result = parseStore(parsed);
  if (result.removedLegacy) await writeStore(result.store);
  return result.store;
}

async function writeStore(store: SecretStore): Promise<void> {
  const path = secretsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-secrets-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function encode(value: string): Pick<StoredSecret, 'enc' | 'data'> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SecretStoreError(
      'OS credential encryption is unavailable. Unlock or configure it, then try saving the API key again.',
    );
  }
  try {
    return { enc: true, data: safeStorage.encryptString(value).toString('base64') };
  } catch {
    throw new SecretStoreError(
      'The API key could not be encrypted and was not stored. Check OS credential encryption, then try again.',
    );
  }
}

function decode(entry: StoredSecret): string {
  if (!entry.enc) {
    throw new SecretStoreError(
      'This legacy credential was stored without OS encryption and cannot be used. Remove it or re-enter it when OS credential encryption is available.',
    );
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new SecretStoreError(
      'OS credential encryption is unavailable. Unlock or configure it before using this credential.',
    );
  }
  if (entry.data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) {
    throw new SecretStoreError('A stored credential is malformed.');
  }
  try {
    return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
  } catch {
    throw new SecretStoreError(
      'A stored credential could not be decrypted. Re-enter or remove it.',
    );
  }
}

function nextRevision(): string {
  return randomBytes(16).toString('hex');
}

function requireProvider(provider: string): ProviderInfo {
  const info = providerInfo(provider);
  if (!info || typeof info !== 'object' || info.id !== provider) {
    throw new AiCredentialError(`Unknown AI provider: ${provider || '(empty)'}.`);
  }
  return info;
}

/**
 * Resolve and normalize the effective provider endpoint. Scheme and host are
 * canonicalized, trailing path slashes are removed, and path/query case remains
 * significant. The existing egress policy blocks remote HTTP while permitting
 * HTTPS and loopback HTTP.
 */
export function normalizeAiBaseUrl(provider: string, requestedBaseUrl: string): string {
  const info = requireProvider(provider);
  if (typeof requestedBaseUrl !== 'string') {
    throw new AiCredentialError('The AI Base URL must be a string.');
  }
  const candidate = requestedBaseUrl.trim() || info.defaultBaseUrl;
  if (!candidate) throw new AiCredentialError(`A Base URL is required for ${info.label}.`);

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AiCredentialError('The AI Base URL is invalid.');
  }
  if (url.username || url.password) {
    throw new AiCredentialError('Credentials are not allowed in the AI Base URL.');
  }
  if (url.search) {
    throw new AiCredentialError(
      'Query parameters are not allowed in the AI Base URL. Use safe custom headers instead.',
    );
  }
  if (url.hash) throw new AiCredentialError('Fragments are not allowed in the AI Base URL.');
  try {
    assertEgressAllowed(url.toString());
  } catch (error) {
    throw new AiCredentialError(
      error instanceof Error ? error.message : 'The endpoint is blocked.',
    );
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
}

function normalizeBinding(binding: AiCredentialBinding): AiCredentialBinding {
  if (
    !isPlainObject(binding) ||
    typeof binding.provider !== 'string' ||
    typeof binding.baseUrl !== 'string'
  ) {
    throw new AiCredentialError('A valid AI credential binding is required.');
  }
  return {
    provider: binding.provider,
    baseUrl: normalizeAiBaseUrl(binding.provider, binding.baseUrl),
  };
}

function assertMatchingSecretKey(key: string, provider: string): void {
  if (key !== aiSecretKey(provider)) {
    throw new AiCredentialError('The secret key does not match the credential provider.');
  }
}

/** Store an AI credential with a normalized provider/endpoint authorization binding. */
export function setAiCredential(
  key: string,
  value: string,
  binding: AiCredentialBinding,
): Promise<void> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return Promise.reject(new AiCredentialError('API keys cannot be empty.'));
  }
  let normalized: AiCredentialBinding;
  try {
    normalized = normalizeBinding(binding);
    assertMatchingSecretKey(key, normalized.provider);
  } catch (error) {
    return Promise.reject(error);
  }
  return withStoreLock(async () => {
    const store = await readStore();
    store[key] = {
      ...encode(value),
      revision: nextRevision(),
      binding: normalized,
    };
    await writeStore(store);
  });
}

/** True when a non-empty secret exists, regardless of endpoint authorization. */
export function hasSecret(key: string): Promise<boolean> {
  return withStoreLock(async () => {
    const entry = (await readStore())[key];
    return !!entry && entry.data.length > 0;
  });
}

/** Remove a secret if present. */
export function deleteSecret(key: string): Promise<void> {
  return withStoreLock(async () => {
    const store = await readStore();
    if (Object.prototype.hasOwnProperty.call(store, key)) {
      delete store[key];
      await writeStore(store);
    }
  });
}

/**
 * The single Main-process AI credential resolver. It returns key material only
 * to trusted Main callers and always pairs it with the exact authorized endpoint.
 *
 * Legacy built-in credentials are accepted only at their provider's registry
 * default. Legacy Custom credentials remain unusable until the user re-enters
 * the key. A Custom endpoint stays keyless only when no stored key exists.
 */
export function resolveAiCredential(
  provider: string,
  requestedBaseUrl: string,
): Promise<ResolvedAiCredential> {
  const info = requireProvider(provider);
  const baseUrl = normalizeAiBaseUrl(provider, requestedBaseUrl);
  return withStoreLock(async () => {
    const store = await readStore();
    const entry = store[aiSecretKey(provider)];
    if (!entry) {
      if (info.keyless) return { apiKey: '', baseUrl, revision: 'none' };
      throw new AiCredentialError(`No API key is set for ${provider}. Add one in the AI panel.`);
    }

    if (entry.binding) {
      let boundBaseUrl: string;
      try {
        requireProvider(entry.binding.provider);
        boundBaseUrl = normalizeAiBaseUrl(entry.binding.provider, entry.binding.baseUrl);
      } catch {
        throw new AiCredentialError('The stored API key has an invalid endpoint binding.');
      }
      if (entry.binding.provider !== provider || boundBaseUrl !== baseUrl) {
        throw new AiCredentialError(
          'The saved API key is not authorized for this provider endpoint. Re-enter or remove it.',
        );
      }
    } else {
      if (provider === 'custom') {
        throw new AiCredentialError(
          'This legacy Custom API key is not endpoint-authorized. Re-enter or remove it.',
        );
      }
      const registryDefault = normalizeAiBaseUrl(provider, info.defaultBaseUrl);
      if (baseUrl !== registryDefault) {
        throw new AiCredentialError(
          'This legacy API key may only be used with the provider default endpoint. Re-enter it to authorize this endpoint.',
        );
      }
    }

    const apiKey = decode(entry);
    if (apiKey.trim().length === 0) {
      throw new AiCredentialError(`No usable API key is set for ${provider}.`);
    }
    let revision = entry.revision;
    if (!revision) {
      revision = nextRevision();
      entry.revision = revision;
      await writeStore(store);
    }
    return { apiKey, baseUrl, revision };
  });
}

/** Binding-aware presence check; generic presence remains available via hasSecret. */
export async function hasAiCredential(key: string, binding: AiCredentialBinding): Promise<boolean> {
  let normalized: AiCredentialBinding;
  try {
    normalized = normalizeBinding(binding);
    assertMatchingSecretKey(key, normalized.provider);
    const resolved = await resolveAiCredential(normalized.provider, normalized.baseUrl);
    return resolved.apiKey.length > 0;
  } catch (error) {
    if (error instanceof AiCredentialError) return false;
    throw error;
  }
}

const OPAQUE_SECRET_KEY = /^deployment\.hook\.[A-Za-z0-9_.-]{1,220}$/;

function normalizedHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretStoreError('Deployment hook origin is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new SecretStoreError('Deployment hooks require exact credential-free HTTPS origins.');
  }
  return url.origin;
}

export interface DeploymentHookSecretMetadata {
  revision: string;
  origin: string;
  urlSha256: string;
}

/** Store an opaque deployment hook. The value never crosses Main in the read direction. */
export function setDeploymentHookSecret(
  key: string,
  hookUrl: string,
): Promise<DeploymentHookSecretMetadata> {
  if (!OPAQUE_SECRET_KEY.test(key))
    return Promise.reject(new SecretStoreError('Deployment secret key is invalid.'));
  if (typeof hookUrl !== 'string' || hookUrl.trim().length === 0 || hookUrl.length > 4_000) {
    return Promise.reject(new SecretStoreError('Deployment hook URL is invalid.'));
  }
  let parsed: URL;
  try {
    parsed = new URL(hookUrl.trim());
  } catch {
    return Promise.reject(new SecretStoreError('Deployment hook URL is invalid.'));
  }
  const origin = normalizedHttpsOrigin(parsed.origin);
  if (parsed.origin !== origin || parsed.hash) {
    return Promise.reject(new SecretStoreError('Deployment hook URL is invalid.'));
  }
  return withStoreLock(async () => {
    const store = await readStore();
    const revision = nextRevision();
    const normalizedUrl = parsed.toString();
    store[key] = {
      ...encode(normalizedUrl),
      revision,
      binding: { provider: 'deployment-hook', baseUrl: origin },
    };
    await writeStore(store);
    return {
      revision,
      origin,
      urlSha256: createHash('sha256').update(normalizedUrl, 'utf-8').digest('hex'),
    };
  });
}

/** Main-internal resolution with exact target-origin binding. */
export function resolveDeploymentHookSecret(
  key: string,
  expectedOrigin: string,
  expectedRevision?: string,
  expectedUrlSha256?: string,
): Promise<string> {
  if (!OPAQUE_SECRET_KEY.test(key))
    return Promise.reject(new SecretStoreError('Deployment secret key is invalid.'));
  const origin = normalizedHttpsOrigin(expectedOrigin);
  return withStoreLock(async () => {
    const entry = (await readStore())[key];
    if (!entry?.binding || entry.binding.provider !== 'deployment-hook') {
      throw new SecretStoreError('No deployment hook is stored for this target.');
    }
    if (expectedRevision && entry.revision !== expectedRevision) {
      throw new SecretStoreError('The stored deployment hook changed after this plan was created.');
    }
    if (normalizedHttpsOrigin(entry.binding.baseUrl) !== origin) {
      throw new SecretStoreError('The stored deployment hook is bound to another origin.');
    }
    const hook = decode(entry);
    const parsed = new URL(hook);
    if (
      parsed.origin !== origin ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new SecretStoreError('The stored deployment hook is invalid for this target.');
    }
    const normalizedUrl = parsed.toString();
    if (
      expectedUrlSha256 &&
      createHash('sha256').update(normalizedUrl, 'utf-8').digest('hex') !== expectedUrlSha256
    ) {
      throw new SecretStoreError(
        'The stored deployment hook URL changed after this plan was created.',
      );
    }
    return normalizedUrl;
  });
}

/** Runtime-parity readiness probe. Credential material never leaves this module. */
export async function hasUsableAiCredential(
  provider: string,
  requestedBaseUrl: string,
): Promise<boolean> {
  try {
    await resolveAiCredential(provider, requestedBaseUrl);
    return true;
  } catch {
    return false;
  }
}
