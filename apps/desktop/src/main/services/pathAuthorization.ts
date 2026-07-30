import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/**
 * Main-owned filesystem capabilities. Renderer-provided paths are never authority:
 * native dialogs and validated recent workspaces register the only roots/files the
 * generic filesystem bridge may access. Canonical real paths prevent symlink escape.
 */
const workspaceRoots = new Set<string>();
const fileCapabilities = new Set<string>();
/** Exact lexical leaves granted by a native/dedicated file capability. */
const fileMutationCapabilities = new Set<string>();

function key(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Equality key for an already-canonical path (case-insensitive on Windows). */
export function canonicalPathIdentity(path: string): string {
  return key(path);
}

function pathError(path: string): Error {
  return new Error(`Access to this path is not authorized: ${path}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isWithin(candidate: string, root: string): boolean {
  const c = key(candidate);
  const r = key(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

async function canonicalExisting(path: string): Promise<string> {
  if (!isAbsolute(path)) throw pathError(path);
  return fs.realpath(resolve(path));
}

async function canonicalCandidate(path: string, allowMissing: boolean): Promise<string> {
  if (!isAbsolute(path)) throw pathError(path);
  const absolute = resolve(path);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (!allowMissing || !isMissing(error)) throw error;
  }

  // Resolve the deepest existing ancestor, then append only missing segments.
  // This supports legitimate nested creates while still resolving any symlinked
  // ancestor before containment is checked.
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) throw pathError(path);
    missing.unshift(basename(cursor));
    cursor = parent;
    try {
      const existing = await fs.realpath(cursor);
      return join(existing, ...missing);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

/**
 * Canonicalize every ancestor while retaining the final path component exactly.
 * Mutations then rename/trash the selected symlink itself instead of its referent.
 */
async function canonicalMutationCandidate(path: string, allowMissing: boolean): Promise<string> {
  if (!isAbsolute(path)) throw pathError(path);
  const absolute = resolve(path);
  const parent = await canonicalCandidate(dirname(absolute), allowMissing);
  const candidate = join(parent, basename(absolute));
  if (!allowMissing) await fs.lstat(candidate);
  return candidate;
}

/** Resolve a directory identity without granting a capability. */
export async function resolveWorkspaceRootIdentity(path: string): Promise<string> {
  const canonical = await canonicalExisting(path);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error('The selected workspace is not a directory.');
  return canonical;
}

/** Register a directory chosen by a native picker or validated Main-owned recent. */
export async function authorizeWorkspaceRoot(
  path: string,
  expectedIdentity?: string,
): Promise<string> {
  const canonical = await resolveWorkspaceRootIdentity(path);
  if (expectedIdentity !== undefined && key(canonical) !== key(resolve(expectedIdentity))) {
    throw pathError(path);
  }
  workspaceRoots.add(key(canonical));
  return canonical;
}

/** Register exactly one file selected by a native Save dialog or dedicated Main API. */
export async function authorizeFilePath(path: string): Promise<string> {
  const canonical = await canonicalCandidate(path, true);
  const mutationPath = await canonicalMutationCandidate(path, true);
  fileCapabilities.add(key(canonical));
  fileMutationCapabilities.add(key(mutationPath));
  // Return the canonical-parent/lexical-leaf path so future destructive actions
  // target a selected symlink itself while reads and writes still resolve safely.
  return mutationPath;
}

/** Resolve and authorize a renderer-supplied file/directory path. */
export async function assertAuthorizedPath(
  path: string,
  options: { allowMissing?: boolean; directory?: boolean } = {},
): Promise<string> {
  const canonical = await canonicalCandidate(path, options.allowMissing === true);
  const allowed =
    fileCapabilities.has(key(canonical)) ||
    [...workspaceRoots].some((root) => isWithin(canonical, root));
  if (!allowed) throw pathError(path);
  if (options.directory) {
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error(`Expected a directory: ${path}`);
  }
  return canonical;
}

/**
 * Authorize a destructive leaf operation without following that leaf. Ancestor
 * symlinks are resolved before containment is checked, so they cannot escape an
 * authorized root, while a final symlink is renamed/trashed as a link.
 */
export async function assertAuthorizedMutationPath(
  path: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const candidate = await canonicalMutationCandidate(path, options.allowMissing === true);
  const allowed =
    fileMutationCapabilities.has(key(candidate)) ||
    [...workspaceRoots].some((root) => isWithin(candidate, root));
  if (!allowed) throw pathError(path);
  return candidate;
}

/** Return the registered workspace capability that contains an already-canonical path. */
export function authorizedWorkspaceRootForPath(canonicalPath: string): string | null {
  const matches = [...workspaceRoots]
    .filter((root) => isWithin(canonicalPath, root))
    .sort((left, right) => right.length - left.length);
  return matches[0] ?? null;
}

/** Require the path itself—not merely a descendant—to be an authorized workspace root. */
export async function assertAuthorizedWorkspaceRoot(path: string): Promise<string> {
  const canonical = await canonicalExisting(path);
  if (!workspaceRoots.has(key(canonical))) throw pathError(path);
  return canonical;
}

/** Compare persisted recent paths without granting authority. */
export function samePath(a: string, b: string): boolean {
  return key(resolve(a)) === key(resolve(b));
}
