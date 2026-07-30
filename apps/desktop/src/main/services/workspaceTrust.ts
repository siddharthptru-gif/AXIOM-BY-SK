import { app } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { WorkspaceTrustState } from '../../common/ipc';
import { assertAuthorizedPath, assertAuthorizedWorkspaceRoot } from './pathAuthorization';

const STORE_VERSION = 1;
const STORE_NAME = 'workspace-trust.json';

interface WorkspaceTrustStore {
  version: typeof STORE_VERSION;
  trustedRoots: string[];
}

let operationTail: Promise<void> = Promise.resolve();
const revokedRoots = new Set<string>();
let trustIntentSequence = 0;
const latestTrustIntent = new Map<string, { sequence: number; trusted: boolean }>();

function storePath(): string {
  return join(app.getPath('userData'), STORE_NAME);
}

function pathKey(path: string): string {
  const value = normalize(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(candidate: string, root: string): boolean {
  const child = pathKey(candidate);
  const parent = pathKey(root);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = error.code;
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EISDIR' ||
    code === 'EBADF' ||
    (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
  );
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStore(): Promise<WorkspaceTrustStore> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath(), 'utf-8');
  } catch (error) {
    if (isMissing(error)) return { version: STORE_VERSION, trustedRoots: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON fails closed. The file is left intact so the user can
    // inspect/recover it; a subsequent explicit trust action replaces it.
    return { version: STORE_VERSION, trustedRoots: [] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: STORE_VERSION, trustedRoots: [] };
  }
  const candidate = parsed as { version?: unknown; trustedRoots?: unknown };
  if (candidate.version !== STORE_VERSION || !Array.isArray(candidate.trustedRoots)) {
    return { version: STORE_VERSION, trustedRoots: [] };
  }

  const canonicalRoots: string[] = [];
  for (const root of candidate.trustedRoots) {
    if (typeof root !== 'string' || !isAbsolute(root) || normalize(root) !== root) {
      return { version: STORE_VERSION, trustedRoots: [] };
    }

    try {
      const canonicalRoot = await fs.realpath(root);
      if (pathKey(canonicalRoot) !== pathKey(root)) {
        return { version: STORE_VERSION, trustedRoots: [] };
      }
      const stat = await fs.stat(canonicalRoot);
      if (!stat.isDirectory()) return { version: STORE_VERSION, trustedRoots: [] };
      canonicalRoots.push(canonicalRoot);
    } catch (error) {
      if (isMissing(error)) return { version: STORE_VERSION, trustedRoots: [] };
      throw error;
    }
  }

  return {
    version: STORE_VERSION,
    trustedRoots: [...new Map(canonicalRoots.map((root) => [pathKey(root), root])).values()],
  };
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(dirname(path), 'r');
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeStore(store: WorkspaceTrustStore): Promise<void> {
  const path = storePath();
  const parent = dirname(path);
  await fs.mkdir(parent, { recursive: true });
  const temp = join(parent, `.workspace-trust-${randomBytes(8).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, path);
    await syncParentDirectory(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function restrictedModeError(root: string): Error {
  return new Error(`Restricted Mode: workspace is not trusted: ${root}`);
}

function recordTrustIntent(root: string, trusted: boolean): number {
  const sequence = ++trustIntentSequence;
  latestTrustIntent.set(pathKey(root), { sequence, trusted });
  return sequence;
}

/** Install an immediate fail-closed deny tombstone for an already canonical root. */
export function markWorkspaceTrustRevoked(root: string): void {
  recordTrustIntent(root, false);
  revokedRoots.add(pathKey(root));
}

/** Read persisted trust for an already Main-authorized workspace root. */
export async function getWorkspaceTrust(root: string): Promise<WorkspaceTrustState> {
  const canonicalRoot = await assertAuthorizedWorkspaceRoot(root);
  return serialize(async () => {
    const key = pathKey(canonicalRoot);
    if (revokedRoots.has(key)) return { root: canonicalRoot, trusted: false };
    const store = await readStore();
    return {
      root: canonicalRoot,
      trusted:
        !revokedRoots.has(key) &&
        store.trustedRoots.some((trustedRoot) => pathKey(trustedRoot) === key),
    };
  });
}

/** Persist or revoke trust for an already Main-authorized workspace root. */
export async function setWorkspaceTrust(
  root: string,
  trusted: boolean,
): Promise<WorkspaceTrustState> {
  const admissionKey = pathKey(root);
  const intentSequence = recordTrustIntent(root, trusted);
  if (!trusted) revokedRoots.add(admissionKey);
  return serialize(async () => {
    const canonicalRoot = await assertAuthorizedWorkspaceRoot(root);
    const key = pathKey(canonicalRoot);
    if (key !== admissionKey) {
      const current = latestTrustIntent.get(key);
      if (!current || current.sequence < intentSequence) {
        latestTrustIntent.set(key, { sequence: intentSequence, trusted });
      }
      if (!trusted) revokedRoots.add(key);
    }
    const latest = latestTrustIntent.get(key);
    if (!latest || latest.sequence !== intentSequence || latest.trusted !== trusted) {
      return { root: canonicalRoot, trusted: trusted && !revokedRoots.has(key) };
    }
    const store = await readStore();
    const retained = store.trustedRoots.filter((entry) => pathKey(entry) !== key);
    const trustedRoots = trusted ? [...retained, canonicalRoot] : retained;
    await writeStore({ version: STORE_VERSION, trustedRoots });
    const current = latestTrustIntent.get(key);
    if (trusted && current?.sequence === intentSequence && current.trusted) {
      revokedRoots.delete(key);
    } else if (!trusted) {
      revokedRoots.add(key);
    }
    return { root: canonicalRoot, trusted: trusted && !revokedRoots.has(key) };
  });
}

/** Require persisted trust for an already Main-authorized workspace root. */
export async function assertWorkspaceTrusted(root: string): Promise<string> {
  const canonicalRoot = await assertAuthorizedWorkspaceRoot(root);
  const key = pathKey(canonicalRoot);
  if (revokedRoots.has(key)) throw restrictedModeError(canonicalRoot);
  const state = await serialize(async () => {
    if (revokedRoots.has(key)) return false;
    const store = await readStore();
    return !revokedRoots.has(key) && store.trustedRoots.some((entry) => pathKey(entry) === key);
  });
  if (!state) throw restrictedModeError(canonicalRoot);
  return canonicalRoot;
}

/**
 * Require an authorized file/directory path to be contained by the supplied
 * persisted trusted root. Both identities are canonicalized before comparison.
 */
export async function assertPathInTrustedWorkspace(
  root: string,
  path: string,
  options: { allowMissing?: boolean; directory?: boolean } = {},
): Promise<string> {
  const canonicalRoot = await assertWorkspaceTrusted(root);
  const canonicalPath = await assertAuthorizedPath(path, options);
  if (!isWithin(canonicalPath, canonicalRoot)) throw restrictedModeError(canonicalRoot);
  return canonicalPath;
}
