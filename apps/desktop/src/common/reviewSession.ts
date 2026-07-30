/**
 * Visual Diff Review session model (PRD Epoch G §142 / Phase 173). Pure helpers on
 * top of the shared line-diff engine: group a diff into reviewable hunks (each with
 * a stable id) and reconstruct the resulting text when only a chosen subset of
 * hunks is accepted (rejected hunks keep the old lines). This is the granular
 * accept/reject core; the renderer renders the hunks and the Safe Edit Engine
 * (Phase 172) applies `applySelectedHunks(...)` atomically. No I/O.
 */
import { computeLineDiff, type DiffOp } from './lineDiff';

export interface ReviewHunk {
  id: string;
  /** 1-based line in the old text where this hunk starts. */
  oldStart: number;
  /** 1-based line in the new text where this hunk starts. */
  newStart: number;
  ops: DiffOp[];
  added: number;
  removed: number;
}

export interface ReviewSession {
  hunks: ReviewHunk[];
  added: number;
  removed: number;
}

interface Tagged {
  ops: DiffOp[];
  /** Hunk id for ops[k], or null for unchanged (eq) lines. */
  hunkOf: (string | null)[];
  hunks: ReviewHunk[];
}

/**
 * Compute the diff once and group each maximal run of non-`eq` ops into a hunk with
 * a deterministic id (`h0`, `h1`, …). Deterministic in (oldText, newText), so
 * buildReviewHunks and applySelectedHunks agree on ids without sharing state.
 */
function tag(oldText: string, newText: string): Tagged {
  const ops = computeLineDiff(oldText, newText);
  const hunkOf: (string | null)[] = new Array(ops.length).fill(null);
  const hunks: ReviewHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === 'eq') {
      oldLine++;
      newLine++;
      k++;
      continue;
    }
    const id = `h${hunks.length}`;
    const oldStart = oldLine;
    const newStart = newLine;
    const hops: DiffOp[] = [];
    let added = 0;
    let removed = 0;
    while (k < ops.length && ops[k]!.op !== 'eq') {
      const op = ops[k]!;
      hunkOf[k] = id;
      hops.push(op);
      if (op.op === 'add') {
        added++;
        newLine++;
      } else {
        removed++;
        oldLine++;
      }
      k++;
    }
    hunks.push({ id, oldStart, newStart, ops: hops, added, removed });
  }
  return { ops, hunkOf, hunks };
}

/** Build the reviewable hunk list for a proposed change (oldText → newText). */
export function buildReviewHunks(oldText: string, newText: string): ReviewSession {
  const { hunks } = tag(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.added;
    removed += h.removed;
  }
  return { hunks, added, removed };
}

/**
 * Reconstruct the resulting text when only `acceptedIds` hunks are applied. Rejected
 * hunks keep the old lines. Accepting none returns oldText exactly; accepting all
 * returns newText exactly.
 */
export function applySelectedHunks(
  oldText: string,
  newText: string,
  acceptedIds: readonly string[],
): string {
  const accepted = new Set(acceptedIds);
  const { ops, hunkOf, hunks } = tag(oldText, newText);
  if (accepted.size === 0) return oldText;
  if (hunks.length > 0 && hunks.every((h) => accepted.has(h.id))) return newText;

  const out: string[] = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.op === 'eq') {
      out.push(op.line);
      continue;
    }
    const isAccepted = hunkOf[k] !== null && accepted.has(hunkOf[k]!);
    if (op.op === 'del') {
      if (!isAccepted) out.push(op.line); // rejected deletion → keep the old line
    } else {
      if (isAccepted) out.push(op.line); // accepted addition → include the new line
    }
  }
  const joined = out.join('\n');
  const trailing = newText.endsWith('\n') || oldText.endsWith('\n');
  return trailing && joined.length > 0 ? `${joined}\n` : joined;
}
