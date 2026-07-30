import { app, safeStorage } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import { MAX_SECRETS_PER_EXTENSION, isSecretKey, secretRecordKey } from '../../common/vscodeAuth';

/**
 * `context.secrets` — the encrypted store behind every extension's credentials.
 *
 * Extensions keep exactly the things that must not be readable from disk here: API keys the
 * user pasted, OAuth refresh tokens, session cookies. Before this existed the shim refused
 * the whole namespace, which was honest but meant every authenticating extension re-asked for
 * a token on each launch.
 *
 * Three decisions worth stating plainly:
 *
 *   - **One file, encrypted whole, via the OS keychain.** `safeStorage` binds the ciphertext
 *     to the logged-in OS user (DPAPI on Windows, Keychain on macOS, libsecret on Linux), so
 *     a copied file is not a copied credential. The same technique AXIOM's own account store
 *     uses, deliberately: one encryption story to audit, not two.
 *   - **Separate from AXIOM's own credential store.** Extension secrets live in their own
 *     file. Sharing `auth-store.enc` would put third-party code's keys in the same map as the
 *     user's Axiom session, and one parse bug would then be a cross-boundary leak.
 *   - **Namespaced per extension, with no way to spell another extension's key.** Keys are
 *     stored as `<extension id> <key>`, and `isSecretKey` refuses separators, so an extension
 *     cannot construct a key that resolves into another extension's namespace.
 *
 * If OS encryption is unavailable, reads and writes fail with that reason instead of falling
 * back to plaintext. An extension that is told storage failed can ask the user again; an
 * extension whose token was silently written in the clear cannot un-write it.
 */
const log = rootLogger.child('extension-secrets');

function storePath(): string {
  return join(app.getPath('userData'), 'extension-secrets.enc');
}

let cache: Record<string, string> | null = null;
let hydrating: Promise<void> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function parseStore(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The extension secret store is malformed.');
  }
  const map = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    map[key] = value;
  }
  return map;
}

async function hydrate(): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFile(storePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = Object.create(null) as Record<string, string>;
      return;
    }
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable; extension secrets cannot be read.');
  }
  try {
    cache = parseStore(safeStorage.decryptString(raw));
  } catch {
    // Encrypted under a different OS credential context (key rotation, profile migration) or
    // corrupted. Start clean rather than failing every read forever: extensions treat a
    // missing secret as "not signed in", which is recoverable, and a permanently unreadable
    // store is not.
    log.warn('The extension secret store could not be decrypted and was reset');
    await rm(storePath(), { force: true });
    cache = Object.create(null) as Record<string, string>;
  }
}

async function ensureHydrated(): Promise<Record<string, string>> {
  if (cache) return cache;
  const pending = hydrating ?? hydrate();
  hydrating = pending;
  try {
    await pending;
  } finally {
    if (hydrating === pending) hydrating = null;
  }
  if (!cache) throw new Error('The extension secret store could not be opened.');
  return cache;
}

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Write the whole map atomically, so a crash mid-write cannot truncate the store. */
async function persist(map: Record<string, string>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable; the secret was not stored.');
  }
  const bytes = safeStorage.encryptString(JSON.stringify(map));
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    '.axiom-ext-secrets-' + randomBytes(6).toString('hex') + '.tmp',
  );
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function countFor(map: Record<string, string>, extensionId: string): number {
  const prefix = extensionId.toLowerCase() + ' ';
  let total = 0;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) total += 1;
  }
  return total;
}

/** Read one of an extension's secrets, or null when it has never stored it. */
export async function readExtensionSecret(
  extensionId: string,
  key: string,
): Promise<string | null> {
  if (!isSecretKey(key)) throw new Error('That secret key is not valid.');
  const map = await ensureHydrated();
  const record = secretRecordKey(extensionId, key);
  return Object.prototype.hasOwnProperty.call(map, record) ? (map[record] ?? null) : null;
}

/**
 * Store one secret for an extension.
 *
 * Bounded per extension: an extension using the credential store as a general-purpose
 * database would grow a file that must be decrypted in full on every read, so the limit is
 * enforced here rather than discovered later as a performance bug.
 */
export async function writeExtensionSecret(
  extensionId: string,
  key: string,
  value: string,
): Promise<void> {
  if (!isSecretKey(key)) throw new Error('That secret key is not valid.');
  await withMutationLock(async () => {
    const map = await ensureHydrated();
    const record = secretRecordKey(extensionId, key);
    const existing = Object.prototype.hasOwnProperty.call(map, record);
    if (!existing && countFor(map, extensionId) >= MAX_SECRETS_PER_EXTENSION) {
      throw new Error(
        'This extension has already stored the maximum number of secrets AXIOM allows.',
      );
    }
    const previous = existing ? (map[record] as string) : null;
    map[record] = value;
    try {
      await persist(map);
    } catch (error) {
      if (previous === null) delete map[record];
      else map[record] = previous;
      throw error;
    }
  });
}

/** Forget one secret. Missing keys succeed: sign-out must be idempotent. */
export async function deleteExtensionSecret(extensionId: string, key: string): Promise<void> {
  if (!isSecretKey(key)) throw new Error('That secret key is not valid.');
  await withMutationLock(async () => {
    const map = await ensureHydrated();
    const record = secretRecordKey(extensionId, key);
    if (!Object.prototype.hasOwnProperty.call(map, record)) return;
    const previous = map[record] as string;
    delete map[record];
    try {
      await persist(map);
    } catch (error) {
      map[record] = previous;
      throw error;
    }
  });
}

/**
 * Drop everything one extension stored.
 *
 * Called when an extension is uninstalled: leaving its credentials encrypted on disk forever
 * would mean uninstalling an extension does not revoke what it kept about the user.
 */
export async function clearExtensionSecrets(extensionId: string): Promise<number> {
  return withMutationLock(async () => {
    const map = await ensureHydrated();
    const prefix = extensionId.toLowerCase() + ' ';
    const removed = Object.keys(map).filter((key) => key.startsWith(prefix));
    if (removed.length === 0) return 0;
    const snapshot = { ...map };
    for (const key of removed) delete map[key];
    try {
      await persist(map);
    } catch (error) {
      for (const key of removed) map[key] = snapshot[key] as string;
      throw error;
    }
    log.info('Cleared stored secrets for an uninstalled extension', {
      extensionId,
      count: removed.length,
    });
    return removed.length;
  });
}

/** How many secrets an extension is keeping, for the extension detail panel. */
export async function countExtensionSecrets(extensionId: string): Promise<number> {
  const map = await ensureHydrated();
  return countFor(map, extensionId);
}
