import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type {
  CreateEntryResult,
  DeleteResult,
  DirEntry,
  FileContent,
  ListFilesResult,
  ReadDirectoryResult,
  RenameResult,
  WorkspaceFile,
  WriteFileResult,
} from '../../common/ipc';
import { LARGE_REPO_MAX_FILES } from '../../common/largeFile';
import { serializeFileMutation } from './fileMutation';
import { writeResolvedSettingsFile } from './settings';
import {
  assertAuthorizedMutationPath,
  assertAuthorizedPath,
  assertAuthorizedWorkspaceRoot,
  canonicalPathIdentity,
  samePath,
} from './pathAuthorization';

/**
 * FileSystem service (Main process). PRD Part VII §104.7 / Part II §22.
 * Every renderer-addressable path is resolved through a Main-owned capability,
 * and all mutations share the Safe Edit/checkpoint commit order.
 */

// Foundation read cap; large-file mode (streaming/virtualized) is a later phase (PRD Part XI §198).
const MAX_READ_BYTES = 5 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function readDirectory(dirPath: string): Promise<ReadDirectoryResult> {
  try {
    const directory = await assertAuthorizedPath(dirPath, { directory: true });
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (d.name === '.git' || d.name === 'node_modules') continue;
      let isDir = false;
      try {
        isDir = d.isDirectory();
      } catch {
        // Ignored for broken symlinks/junctions
      }
      entries.push({
        name: d.name,
        path: join(directory, d.name),
        kind: isDir ? ('directory' as const) : ('file' as const),
      });
    }

    // Directories first, then files; each alphabetical (case-insensitive).
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { path: directory, entries };
  } catch {
    return { path: dirPath, entries: [] };
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function currentEtag(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_READ_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
    return hashBuffer(await fs.readFile(path));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertExpectedEtag(path: string, expectedEtag: string | null): Promise<void> {
  const actualEtag = await currentEtag(path);
  if (actualEtag !== expectedEtag) {
    throw new Error(
      'The file changed on disk after it was opened. Revert or reopen it before saving, or use Save As to preserve your changes.',
    );
  }
}

function decodeUtf8(buffer: Buffer, allowTrailingPartial = false): string | null {
  if (buffer.includes(0)) return null;
  try {
    // Keep a leading UTF-8 BOM as U+FEFF so writing the model back preserves
    // the original bytes instead of silently normalizing the file.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return decoder.decode(buffer, { stream: allowTrailingPartial });
  } catch {
    return null;
  }
}

export async function readFile(filePath: string): Promise<FileContent> {
  try {
    const path = await assertAuthorizedPath(filePath);
    const stat = await fs.stat(path);
    const truncated = stat.size > MAX_READ_BYTES;
    let buffer: Buffer;
    if (truncated) {
      const handle = await fs.open(path, 'r');
      try {
        buffer = Buffer.alloc(MAX_READ_BYTES);
        const result = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
        buffer = buffer.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    } else {
      buffer = await fs.readFile(path);
    }

    const decoded = decodeUtf8(buffer, truncated);
    const binary = decoded === null;
    const editable = !truncated && !binary;
    const readOnlyReason = truncated
      ? `This file is ${(stat.size / (1024 * 1024)).toFixed(1)} MiB; only a read-only ${MAX_READ_BYTES / (1024 * 1024)} MiB preview is shown.`
      : binary
        ? 'This file is binary or is not valid UTF-8 and cannot be edited safely as text.'
        : null;
    return {
      path,
      content: binary ? '[Binary or non-UTF-8 file — text editing disabled]' : decoded,
      truncated,
      editable,
      binary,
      size: stat.size,
      readOnlyReason,
      etag: truncated ? `large:${stat.size}:${stat.mtimeMs}` : hashBuffer(buffer),
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      path: filePath,
      content: `[Could not open file: ${raw}]`,
      truncated: false,
      editable: false,
      binary: true,
      size: 0,
      readOnlyReason: `Could not open file: ${raw}`,
      etag: '',
    };
  }
}

export function writeFile(
  filePath: string,
  content: string,
  expectedEtag?: string | null,
  expectedIdentity?: string,
): Promise<WriteFileResult> {
  return serializeFileMutation(async () => {
    const path = await assertAuthorizedPath(filePath, { allowMissing: true });
    if (expectedIdentity !== undefined && canonicalPathIdentity(path) !== expectedIdentity) {
      throw new Error(
        'The selected save destination changed before it could be written. Choose it again.',
      );
    }
    if (expectedEtag !== undefined) {
      await assertExpectedEtag(path, expectedEtag);
    }
    const managedBytes = await writeResolvedSettingsFile(
      filePath,
      path,
      content,
      expectedEtag === undefined ? undefined : () => assertExpectedEtag(path, expectedEtag),
    );
    if (managedBytes !== null) {
      const etag = await currentEtag(path);
      if (!etag) throw new Error('The managed settings file was not written.');
      return {
        path,
        identity: canonicalPathIdentity(path),
        bytes: managedBytes,
        etag,
      };
    }
    const dir = dirname(path);
    const tmp = join(dir, `.axiom-tmp-${randomBytes(6).toString('hex')}`);
    try {
      await fs.writeFile(tmp, content, 'utf-8');
      if (expectedEtag !== undefined) {
        await assertExpectedEtag(path, expectedEtag);
      }
      await fs.rename(tmp, path);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    return {
      path,
      identity: canonicalPathIdentity(path),
      bytes: Buffer.byteLength(content, 'utf-8'),
      etag: hashBuffer(Buffer.from(content, 'utf-8')),
    };
  });
}

/**
 * Validates a single path segment supplied by the renderer before it is joined
 * to a trusted base directory. Rejects separators, traversal, reserved names,
 * and control characters (PRD Part X §182 path-traversal prevention, §47
 * server-side validation). Name composition happens only in Main.
 */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('Name cannot be empty.');
  if (trimmed.length > 255) throw new Error('Name is too long.');
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name.');
  if (/[\\/]/.test(trimmed)) throw new Error('Name cannot contain path separators.');
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) {
    throw new Error('Name contains characters that are not allowed.');
  }
  return trimmed;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Resolves the directory an operation targets: the anchor itself if it is a
 * directory, otherwise the anchor's parent directory. */
async function resolveBaseDir(anchorPath: string): Promise<string> {
  const stat = await fs.stat(anchorPath);
  return stat.isDirectory() ? anchorPath : dirname(anchorPath);
}

export function createFile(anchorPath: string, name: string): Promise<CreateEntryResult> {
  return serializeFileMutation(async () => {
    const safeName = validateName(name);
    const anchor = await assertAuthorizedPath(anchorPath);
    const baseDir = await resolveBaseDir(anchor);
    const target = await assertAuthorizedPath(join(baseDir, safeName), { allowMissing: true });
    // 'wx' fails if the path already exists, so we never clobber an existing file.
    const handle = await fs.open(target, 'wx');
    await handle.close();
    return { path: target, name: safeName, kind: 'file' };
  });
}

export function createDirectory(anchorPath: string, name: string): Promise<CreateEntryResult> {
  return serializeFileMutation(async () => {
    const safeName = validateName(name);
    const anchor = await assertAuthorizedPath(anchorPath);
    const baseDir = await resolveBaseDir(anchor);
    const target = await assertAuthorizedPath(join(baseDir, safeName), { allowMissing: true });
    // Non-recursive: throws EEXIST if the directory already exists (clear feedback).
    await fs.mkdir(target);
    return { path: target, name: safeName, kind: 'directory' };
  });
}

export function renamePath(targetPath: string, newName: string): Promise<RenameResult> {
  return serializeFileMutation(async () => {
    const safeName = validateName(newName);
    const oldPath = await assertAuthorizedMutationPath(targetPath);
    const newPath = await assertAuthorizedMutationPath(join(dirname(oldPath), safeName), {
      allowMissing: true,
    });
    if (!samePath(newPath, oldPath) && (await exists(newPath))) {
      throw new Error('A file or folder with that name already exists.');
    }
    await fs.rename(oldPath, newPath);
    return { oldPath, newPath, name: safeName };
  });
}

export function movePath(source: string, destDir: string): Promise<RenameResult> {
  return serializeFileMutation(async () => {
    const oldPath = await assertAuthorizedMutationPath(source);
    const destination = await assertAuthorizedPath(destDir, { directory: true });
    const relativeDestination = relative(oldPath, destination);
    // Never move an item into itself or one of its own descendants.
    if (
      relativeDestination === '' ||
      (!relativeDestination.startsWith(`..${sep}`) &&
        relativeDestination !== '..' &&
        !isAbsolute(relativeDestination))
    ) {
      throw new Error('Cannot move a folder into itself.');
    }
    const name = basename(oldPath);
    const newPath = await assertAuthorizedMutationPath(join(destination, name), {
      allowMissing: true,
    });
    if (samePath(newPath, oldPath)) {
      return { oldPath, newPath, name }; // already in this folder — no-op
    }
    if (await exists(newPath)) {
      throw new Error('An item with that name already exists in the destination.');
    }
    await fs.rename(oldPath, newPath);
    return { oldPath, newPath, name };
  });
}

export function deletePath(targetPath: string): Promise<DeleteResult> {
  return serializeFileMutation(async () => {
    const path = await assertAuthorizedMutationPath(targetPath);
    // A command labelled "Move to Recycle Bin" must never silently become an
    // irreversible recursive delete. Surface trash failures to the user instead.
    await shell.trashItem(path);
    return { path, trashed: true };
  });
}

/** Directories never descended into during a workspace file walk. */
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

// Upper bound so Quick Open stays responsive on very large repos (PRD Part XI §198 /
// Phases 267–269) — the large-repo file budget is centralized in common/largeFile.
const MAX_LISTED_FILES = LARGE_REPO_MAX_FILES;

/**
 * Recursively lists files under `rootPath` for Quick Open (PRD Part VII §105).
 * Skips heavy/ignored directories and symlinks (loop-safe), caps the total, and
 * returns paths relative to the root using `/` separators for display + matching.
 */
export async function listFiles(rootPath: string): Promise<ListFilesResult> {
  const root = await assertAuthorizedWorkspaceRoot(rootPath);
  const files: WorkspaceFile[] = [];
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_LISTED_FILES) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, races) — skip quietly
    }
    for (const d of dirents) {
      if (files.length >= MAX_LISTED_FILES) {
        truncated = true;
        return;
      }
      // isDirectory()/isFile() are false for symlinks, so links are never followed.
      if (d.isDirectory()) {
        if (IGNORED_DIRS.has(d.name)) continue;
        await walk(join(dir, d.name));
      } else if (d.isFile()) {
        const full = join(dir, d.name);
        files.push({ path: full, name: d.name, rel: relative(root, full).replace(/\\/g, '/') });
      }
    }
  };

  await walk(root);
  return { root, files, truncated };
}
