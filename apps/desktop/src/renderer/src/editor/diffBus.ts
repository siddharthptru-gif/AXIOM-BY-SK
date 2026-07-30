import type { GitDiffMode } from '../../../common/ipc';

/**
 * Diff bus. Lets the Source Control view ask the workbench to open a read-only
 * Monaco diff for one staged or unstaged change. Owner pattern (like eolBus):
 * DiffHost registers the opener; callers invoke openDiff(target).
 */
export interface DiffTarget {
  /** Absolute workspace root the file belongs to. */
  root: string;
  /** File path relative to the root, using `/` separators. */
  rel: string;
  /** Base name for the diff title. */
  name: string;
  /** Staged compares HEAD → index; unstaged compares index → working tree. */
  mode: GitDiffMode;
}

type DiffOpener = (target: DiffTarget) => void;

let opener: DiffOpener | null = null;

export function setDiffOpener(fn: DiffOpener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

export function openDiff(target: DiffTarget): void {
  opener?.(target);
}
