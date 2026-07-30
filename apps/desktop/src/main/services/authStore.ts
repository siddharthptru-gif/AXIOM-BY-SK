import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rootUserDataPath } from './accountProfile';

/**
 * Encrypted key/value storage backing the Supabase auth client (PRD Epoch E,
 * INV-3). The whole map is persisted encrypted at rest with the OS keychain via
 * `safeStorage`. It lives only in Main — session tokens never reach the renderer.
 * Implements the async Storage shape Supabase expects
 * (`getItem`/`setItem`/`removeItem`).
 *
 * Deliberately stored at the REAL userData root rather than the per-account profile
 * directory: the session is what identifies which profile to bind, so keeping it
 * inside a profile would be circular — AXIOM would have to know the account before it
 * could discover the account.
 */
function storePath(): string {
  return join(rootUserDataPath(), 'auth-store.enc');
}

let cache: Record<string, string> | null = null;
let hydrating: Promise<void> | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function parseStore(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The local authentication store is malformed.');
  }
  const map = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('The local authentication store contains a non-string value.');
    }
    map[key] = value;
  }
  return map;
}

async function hydrate(): Promise<void> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(storePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = Object.create(null) as Record<string, string>;
      return;
    }
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable; saved authentication tokens cannot be read.',
    );
  }
  try {
    cache = parseStore(safeStorage.decryptString(raw));
  } catch {
    // The ciphertext was encrypted under a different OS credential context
    // (DPAPI key rotation, profile migration, corrupted store). Delete the
    // stale file so the next sign-in starts clean.
    await fs.rm(storePath(), { force: true });
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
  if (!cache) throw new Error('The local authentication store could not be hydrated.');
  return cache;
}

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persist(map: Record<string, string>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable; authentication tokens were not stored.',
    );
  }
  const buf = safeStorage.encryptString(JSON.stringify(map));
  const path = storePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-auth-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, buf);
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export const authStorage = {
  async getItem(key: string): Promise<string | null> {
    const map = await ensureHydrated();
    return Object.prototype.hasOwnProperty.call(map, key) ? (map[key] ?? null) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    return withMutationLock(async () => {
      const map = await ensureHydrated();
      const hadValue = Object.prototype.hasOwnProperty.call(map, key);
      const previous = hadValue ? { value: map[key] as string } : null;
      map[key] = value;
      try {
        await persist(map);
      } catch (error) {
        if (previous) map[key] = previous.value;
        else delete map[key];
        throw error;
      }
    });
  },
  async removeItem(key: string): Promise<void> {
    return withMutationLock(async () => {
      const map = await ensureHydrated();
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        const previous = map[key] as string;
        delete map[key];
        try {
          await persist(map);
        } catch (error) {
          map[key] = previous;
          throw error;
        }
      }
    });
  },
};
