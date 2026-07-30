import type { AgentDiffLine, AgentFileDiff } from './ipc';
import { buildReviewHunks } from './reviewSession';

/**
 * Inline AI edit review (pure).
 *
 * Converts a Main-authored `AgentFileDiff` for an APPLIED edit into reviewable
 * hunks addressed in the CURRENT (post-edit) document, so the editor can show
 * exactly what the agent changed and offer per-hunk accept/revert in place —
 * instead of forcing the user to read a chat card.
 *
 * No I/O and no editor dependency: the renderer supplies the diff and receives
 * line ranges plus the exact original text needed to undo one hunk.
 */

/** One contiguous change the user can accept or revert on its own. */
export interface AiReviewHunk {
  /** Stable id within one file review. */
  id: string;
  /**
   * 1-based inclusive line range in the post-edit document that this hunk
   * introduced. For a deletion-only hunk the range is the single anchor line
   * AFTER which the removed text used to live (0 when it was the file head).
   */
  startLine: number;
  endLine: number;
  /** Lines this hunk added to the document (empty for a pure deletion). */
  addedText: string[];
  /** Lines this hunk removed, in original order (empty for a pure insertion). */
  removedText: string[];
}

export interface AiFileReview {
  /** Absolute path of the changed file. */
  path: string;
  /** Workspace-relative path, for labels. */
  rel: string;
  changeKind: AgentFileDiff['changeKind'];
  hunks: AiReviewHunk[];
  added: number;
  removed: number;
  /** True when Main capped the diff, so the review is partial. */
  truncated: boolean;
  /** When the edit was applied. */
  at: number;
}

/** True for a hunk that only removed lines (nothing was inserted). */
export function isDeletionOnly(hunk: AiReviewHunk): boolean {
  return hunk.addedText.length === 0 && hunk.removedText.length > 0;
}

interface Group {
  adds: AgentDiffLine[];
  dels: AgentDiffLine[];
  /** Last `ctx`/`add` line number seen before this group, in the new document. */
  anchor: number;
}

/**
 * Group a unified diff into contiguous change runs. A run ends at a context
 * line, a hunk header, or the end of the diff — matching how a reader perceives
 * "one change".
 */
function groupChanges(lines: readonly AgentDiffLine[]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let anchor = 0;

  const flush = (): void => {
    if (current && (current.adds.length > 0 || current.dels.length > 0)) groups.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.kind === 'hunk') {
      flush();
      continue;
    }
    if (line.kind === 'ctx') {
      flush();
      if (typeof line.newLine === 'number') anchor = line.newLine;
      continue;
    }
    current ??= { adds: [], dels: [], anchor };
    if (line.kind === 'add') {
      current.adds.push(line);
      if (typeof line.newLine === 'number') anchor = line.newLine;
    } else {
      current.dels.push(line);
    }
  }
  flush();
  return groups;
}

function addedRange(group: Group): { startLine: number; endLine: number } | null {
  const numbers = group.adds
    .map((line) => line.newLine)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  if (numbers.length === 0) return null;
  return { startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

/**
 * Build the reviewable hunks for one applied file diff. Returns an empty hunk
 * list when the diff carries no positioned change (for example a delete-file
 * event or a truncated diff with no usable line numbers).
 */
export function buildAiFileReview(
  diff: AgentFileDiff,
  absolutePath: string,
  at: number,
): AiFileReview {
  const hunks: AiReviewHunk[] = [];
  const groups = groupChanges(diff.lines);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const removedText = group.dels.map((line) => line.text);
    const addedText = group.adds.map((line) => line.text);
    const range = addedRange(group);
    if (range) {
      hunks.push({
        id: `h${index}`,
        startLine: range.startLine,
        endLine: range.endLine,
        addedText,
        removedText,
      });
      continue;
    }
    if (removedText.length === 0) continue;
    // Deletion-only: anchor on the surviving line above the removal.
    hunks.push({
      id: `h${index}`,
      startLine: group.anchor,
      endLine: group.anchor,
      addedText: [],
      removedText,
    });
  }
  return {
    path: absolutePath,
    rel: diff.path,
    changeKind: diff.changeKind,
    hunks,
    added: diff.added,
    removed: diff.removed,
    truncated: diff.truncated,
    at,
  };
}

/**
 * Build an inline review directly from an old→new text pair.
 *
 * Used by the multi-file Composer: after an atomic batch is applied, each changed
 * file becomes an in-editor review with the same per-hunk accept/revert affordances
 * that Build's single-file edits get. Hunk ids match `reviewSession` ids, so panel
 * and editor refer to the same hunk.
 */
export function buildAiReviewFromTexts(
  oldText: string,
  newText: string,
  absolutePath: string,
  rel: string,
  changeKind: AgentFileDiff['changeKind'],
  at: number,
): AiFileReview {
  const session = buildReviewHunks(oldText, newText);
  const hunks: AiReviewHunk[] = [];
  for (const hunk of session.hunks) {
    const addedText = hunk.ops.filter((op) => op.op === 'add').map((op) => op.line);
    const removedText = hunk.ops.filter((op) => op.op === 'del').map((op) => op.line);
    if (addedText.length > 0) {
      hunks.push({
        id: hunk.id,
        startLine: hunk.newStart,
        endLine: hunk.newStart + addedText.length - 1,
        addedText,
        removedText,
      });
      continue;
    }
    if (removedText.length === 0) continue;
    // Deletion-only: anchor on the surviving line above the removal.
    const anchor = Math.max(0, hunk.newStart - 1);
    hunks.push({ id: hunk.id, startLine: anchor, endLine: anchor, addedText: [], removedText });
  }
  return {
    path: absolutePath,
    rel,
    changeKind,
    hunks,
    added: session.added,
    removed: session.removed,
    truncated: false,
    at,
  };
}

/** Short human summary for a review header / status text. */
export function summarizeAiReview(review: AiFileReview): string {
  const hunkLabel = `${review.hunks.length} change${review.hunks.length === 1 ? '' : 's'}`;
  return `${hunkLabel} · +${review.added} −${review.removed}${review.truncated ? ' · truncated' : ''}`;
}
