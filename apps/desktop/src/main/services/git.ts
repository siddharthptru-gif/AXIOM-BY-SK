import fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { getRepositoryInfo } from './systemGit';
import type {
  GitBranches,
  GitChange,
  GitChangeType,
  GitDiff,
  GitDiffMode,
  GitLogEntry,
  GitStatusResult,
} from '../../common/ipc';

/**
 * Git service (Main process, PRD Epoch D). Backed by isomorphic-git — a pure-JS
 * git implementation — so no `git` binary is required. Batch 1 covers local
 * working-tree operations: status, stage/unstage, and commit. Remotes (clone,
 * fetch, push, pull) and diffs arrive in later phases.
 */

/** Cheap repo check: a `.git` entry at the workspace root. */
async function hasGitDir(root: string): Promise<boolean> {
  try {
    await fs.promises.access(join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Working-tree status. isomorphic-git's status matrix yields
 * `[path, head, workdir, stage]`; a file is staged when `head !== stage` and has
 * unstaged changes when `workdir !== stage` (a file can be in both lists).
 */
export async function getStatus(root: string): Promise<GitStatusResult> {
  const isRepo = await hasGitDir(root);
  const repository = await getRepositoryInfo(root, isRepo);
  if (!isRepo) {
    return { ...repository, isRepo: false, branch: null, staged: [], unstaged: [] };
  }

  let branch: string | null = null;
  try {
    branch = (await git.currentBranch({ fs, dir: root, fullname: false })) ?? null;
  } catch {
    branch = null; // e.g. a repo with no commits yet
  }

  const matrix = await git.statusMatrix({ fs, dir: root });
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  for (const [path, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // unmodified
    if (head !== stage) {
      const type: GitChangeType = head === 0 ? 'added' : stage === 0 ? 'deleted' : 'modified';
      staged.push({ path, type });
    }
    if (workdir !== stage) {
      const type: GitChangeType =
        head === 0 && stage === 0
          ? 'untracked'
          : workdir === 0
            ? 'deleted'
            : head === 0
              ? 'added'
              : 'modified';
      unstaged.push({ path, type });
    }
  }
  staged.sort((a, b) => a.path.localeCompare(b.path));
  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  return { ...repository, isRepo: true, branch, staged, unstaged };
}

/** Stage a path (add), or stage its deletion when the file is gone. */
export async function stage(root: string, filepath: string): Promise<void> {
  const exists = await fs.promises
    .lstat(join(root, filepath))
    .then(() => true)
    .catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    });
  if (exists) await git.add({ fs, dir: root, filepath });
  else await git.remove({ fs, dir: root, filepath });
}

/** Unstage a path (reset the index entry to HEAD). */
export async function unstage(root: string, filepath: string): Promise<void> {
  await git.resetIndex({ fs, dir: root, filepath });
}

/** Commit the staged changes, taking the author from git config (with fallback). */
export async function commit(root: string, message: string): Promise<string> {
  const name: string = (await git.getConfig({ fs, dir: root, path: 'user.name' })) || 'Axiom User';
  const email: string =
    (await git.getConfig({ fs, dir: root, path: 'user.email' })) || 'axiom@localhost';
  return git.commit({ fs, dir: root, message, author: { name, email } });
}

/** Local branches plus the currently checked-out one. */
export async function listBranches(root: string): Promise<GitBranches> {
  const branches = await git.listBranches({ fs, dir: root });
  let current: string | null = null;
  try {
    current = (await git.currentBranch({ fs, dir: root, fullname: false })) ?? null;
  } catch {
    current = null;
  }
  return { current, branches };
}

/** Switch to an existing branch (throws if the working tree would be clobbered). */
export async function checkout(root: string, ref: string): Promise<void> {
  await git.checkout({ fs, dir: root, ref });
}

/** Create a new branch and switch to it. */
export async function createBranch(root: string, name: string): Promise<void> {
  await git.branch({ fs, dir: root, ref: name, checkout: true });
}

/** A normalized entry found through an isomorphic-git tree walker. */
interface WalkedEntry {
  type: 'tree' | 'blob' | 'special' | 'commit';
  mode: number;
  oid: string | null;
}

interface IndexBlob {
  mode: number;
  blob: Uint8Array;
}

const REGULAR_FILE_MODE = 0o100644;
const EXECUTABLE_FILE_MODE = 0o100755;
const SYMLINK_MODE = 0o120000;

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Find one exact entry without reading or refreshing the working tree. */
async function findEntry(
  root: string,
  filepath: string,
  tree: ReturnType<typeof git.STAGE>,
): Promise<WalkedEntry | null> {
  const matches = (await git.walk({
    fs,
    dir: root,
    trees: [tree],
    map: async (walkPath, [entry]) => {
      if (walkPath !== filepath) {
        // Prune every branch except the target's ancestors.
        return walkPath === '.' || filepath.startsWith(`${walkPath}/`) ? undefined : null;
      }
      if (!entry) return undefined;
      const type = await entry.type();
      return {
        type,
        mode: await entry.mode(),
        oid: type === 'tree' ? null : await entry.oid(),
      } satisfies WalkedEntry;
    },
  })) as WalkedEntry[];
  return matches[0] ?? null;
}

/**
 * Read an index blob through STAGE. Stage entries intentionally expose no
 * content, so resolve the entry OID and read the corresponding blob object.
 */
async function readIndexBlob(root: string, filepath: string): Promise<IndexBlob | null> {
  const entry = await findEntry(root, filepath, git.STAGE());
  if (!entry) return null;
  if (
    entry.type !== 'blob' ||
    entry.oid === null ||
    (entry.mode !== REGULAR_FILE_MODE &&
      entry.mode !== EXECUTABLE_FILE_MODE &&
      entry.mode !== SYMLINK_MODE)
  ) {
    throw new Error(
      `Unsupported index entry type for "${filepath}": ${entry.type} ` +
        `(mode ${entry.mode.toString(8)}).`,
    );
  }
  const { blob } = await git.readBlob({ fs, dir: root, oid: entry.oid });
  return { mode: entry.mode, blob };
}

async function readHeadBlob(root: string, filepath: string): Promise<Uint8Array | null> {
  let headOid: string;
  try {
    headOid = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError || error instanceof git.Errors.NoCommitError) {
      return null;
    }
    throw error;
  }

  const entry = await findEntry(root, filepath, git.TREE({ ref: headOid }));
  if (!entry) return null;
  if (entry.type !== 'blob' || entry.oid === null) {
    throw new Error(
      `Unsupported HEAD entry type for "${filepath}": ${entry.type} ` +
        `(mode ${entry.mode.toString(8)}).`,
    );
  }
  return (await git.readBlob({ fs, dir: root, oid: entry.oid })).blob;
}

async function readWorktreeBlob(root: string, filepath: string): Promise<Uint8Array | null> {
  const path = join(root, filepath);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return fs.promises.readlink(path, { encoding: 'buffer' });
  }
  if (!stat.isFile()) {
    throw new Error(`Unsupported working-tree entry type for "${filepath}".`);
  }
  return fs.promises.readFile(path);
}

/**
 * Replace a worktree path from a prepared sibling entry. The existing path is
 * first moved into a same-filesystem transaction directory and restored if the
 * final atomic rename fails.
 */
async function replaceWorktreePath(
  path: string,
  prepare: (replacement: string) => Promise<void>,
): Promise<void> {
  const parent = join(path, '..');
  await fs.promises.mkdir(parent, { recursive: true });
  const transaction = await fs.promises.mkdtemp(join(parent, '.axiom-git-discard-'));
  const replacement = join(transaction, 'replacement');
  const previous = join(transaction, 'previous');
  let preserveTransaction = false;
  let failed = false;
  let failure: unknown;

  try {
    await prepare(replacement);
    let hadPrevious = false;
    try {
      await fs.promises.rename(path, previous);
      hadPrevious = true;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }

    if (hadPrevious) {
      const previousStat = await fs.promises.lstat(previous);
      if (!previousStat.isFile() && !previousStat.isSymbolicLink()) {
        try {
          await fs.promises.rename(previous, path);
        } catch (rollbackError) {
          preserveTransaction = true;
          throw new Error(
            `Cannot discard "${path}": the working-tree path is not a file or symbolic link. ` +
              `Rollback also failed: ${errorMessage(rollbackError)}. ` +
              `The previous entry remains at "${previous}".`,
          );
        }
        throw new Error(
          `Cannot discard "${path}": the working-tree path is not a file or symbolic link.`,
        );
      }
    }

    try {
      await fs.promises.rename(replacement, path);
    } catch (installError) {
      if (hadPrevious) {
        try {
          await fs.promises.rename(previous, path);
        } catch (rollbackError) {
          preserveTransaction = true;
          throw new Error(
            `Could not restore "${path}": ${errorMessage(installError)} ` +
              `Rollback also failed: ${errorMessage(rollbackError)}. ` +
              `The previous entry remains at "${previous}".`,
          );
        }
      }
      throw installError;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (!preserveTransaction) {
    try {
      await fs.promises.rm(transaction, { recursive: true, force: true });
    } catch (cleanupError) {
      if (failed) {
        throw new Error(
          `${errorMessage(failure)} Temporary-data cleanup also failed: ` +
            errorMessage(cleanupError),
        );
      }
      throw new Error(
        `The file was restored, but temporary rollback data at "${transaction}" ` +
          `could not be removed: ${errorMessage(cleanupError)}`,
      );
    }
  }
  if (failed) throw failure;
}

/**
 * Diff a single file in the requested SCM section. Staged changes compare HEAD
 * to the index; unstaged changes compare the index to the working tree.
 */
export async function diff(root: string, filepath: string, mode: GitDiffMode): Promise<GitDiff> {
  let original: Uint8Array | null;
  let modified: Uint8Array | null;
  if (mode === 'staged') {
    original = await readHeadBlob(root, filepath);
    modified = (await readIndexBlob(root, filepath))?.blob ?? null;
  } else {
    original = (await readIndexBlob(root, filepath))?.blob ?? null;
    modified = await readWorktreeBlob(root, filepath);
  }
  const decoder = new TextDecoder();
  return {
    original: original ? decoder.decode(original) : '',
    modified: modified ? decoder.decode(modified) : '',
  };
}

/**
 * Discard unstaged changes by restoring exactly the index state. This never
 * calls an index-mutating Git operation: absent index entries remove the
 * worktree file, while supported entries restore the staged blob and mode.
 */
export async function discard(root: string, filepath: string): Promise<void> {
  const entry = await readIndexBlob(root, filepath);
  const path = join(root, filepath);
  if (!entry) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(
        `Cannot discard "${filepath}": the index has no entry and the working-tree ` +
          'path is not a file or symbolic link.',
      );
    }
    await fs.promises.unlink(path);
    return;
  }

  switch (entry.mode) {
    case REGULAR_FILE_MODE:
    case EXECUTABLE_FILE_MODE:
      await replaceWorktreePath(path, async (replacement) => {
        const permissions = entry.mode === EXECUTABLE_FILE_MODE ? 0o755 : 0o644;
        const handle = await fs.promises.open(replacement, 'wx', permissions);
        try {
          await handle.writeFile(entry.blob);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.chmod(replacement, permissions);
      });
      return;
    case SYMLINK_MODE:
      await replaceWorktreePath(path, async (replacement) => {
        await fs.promises.symlink(Buffer.from(entry.blob), replacement);
      });
      return;
    default:
      // readIndexBlob rejects this first; retain an explicit invariant guard.
      throw new Error(
        `Unsupported index entry type for "${filepath}" (mode ${entry.mode.toString(8)}).`,
      );
  }
}

/** Initialize a new git repository at the workspace root (default branch main). */
export async function init(root: string): Promise<void> {
  await git.init({ fs, dir: root, defaultBranch: 'main' });
}

/**
 * Recent commit history (newest first) from HEAD. Returns an empty list when the
 * repo has no commits yet (HEAD does not resolve).
 */
export async function log(root: string, depth = 50): Promise<GitLogEntry[]> {
  try {
    const commits = await git.log({ fs, dir: root, depth });
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      author: c.commit.author.name,
      email: c.commit.author.email,
      timestamp: c.commit.author.timestamp,
    }));
  } catch {
    return [];
  }
}
