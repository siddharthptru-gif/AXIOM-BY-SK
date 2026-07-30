/**
 * Multi-file diff review session (PRD Epoch G §142.1 / Phase 195). Pure helpers that
 * lift the single-file review (reviewSession) to a batch: compute per-file hunks for
 * a proposed change set, and resolve the user's per-hunk accept/reject selections
 * into the concrete edits to apply as ONE Safe-Edit batch (a single snapshot).
 * Files with nothing accepted are skipped. No I/O — unit-tested.
 */
import { buildReviewHunks, applySelectedHunks, type ReviewHunk } from './reviewSession';
import type { PlanAction } from './editPlan';

/** Implicit hunk id used to accept/reject a whole-file delete. */
export const DELETE_HUNK_ID = 'delete';

export interface MultiReviewInput {
  path: string;
  action: PlanAction;
  /** Current on-disk content ('' if the file does not exist). */
  oldText: string;
  /** Proposed content ('' for a delete). */
  newText: string;
}

export interface MultiReviewFile {
  path: string;
  action: PlanAction;
  oldText: string;
  newText: string;
  /** Hunks from old→new (empty for a delete). */
  hunks: ReviewHunk[];
}

export interface ResolvedEdit {
  path: string;
  kind: PlanAction;
  newText?: string;
}

/** Build the per-file review model (diff each proposed change into hunks). */
export function buildMultiReview(items: readonly MultiReviewInput[]): MultiReviewFile[] {
  return items.map((it) => ({
    path: it.path,
    action: it.action,
    oldText: it.oldText,
    newText: it.newText,
    hunks: it.action === 'delete' ? [] : buildReviewHunks(it.oldText, it.newText).hunks,
  }));
}

/** Default acceptance: every hunk accepted (deletes accepted via DELETE_HUNK_ID). */
export function defaultAccepted(files: readonly MultiReviewFile[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const f of files) {
    map[f.path] =
      f.action === 'delete' ? new Set([DELETE_HUNK_ID]) : new Set(f.hunks.map((h) => h.id));
  }
  return map;
}

/**
 * Resolve accepted hunks into the concrete edits to apply. For create/modify the
 * new text is reconstructed from only the accepted hunks (kind is create when the
 * file was absent, else modify); a file with no accepted hunks is skipped. A delete
 * is included only when its DELETE_HUNK_ID is accepted.
 */
export function applyMultiReview(
  files: readonly MultiReviewFile[],
  acceptedByPath: Record<string, ReadonlySet<string>>,
): ResolvedEdit[] {
  const out: ResolvedEdit[] = [];
  for (const f of files) {
    const accepted = acceptedByPath[f.path] ?? new Set<string>();
    if (f.action === 'delete') {
      if (accepted.has(DELETE_HUNK_ID)) out.push({ path: f.path, kind: 'delete' });
      continue;
    }
    if (f.hunks.length === 0) continue; // no textual change
    const acceptedIds = f.hunks.filter((h) => accepted.has(h.id)).map((h) => h.id);
    if (acceptedIds.length === 0) continue; // nothing accepted for this file
    const newText = applySelectedHunks(f.oldText, f.newText, acceptedIds);
    out.push({ path: f.path, kind: f.oldText.length === 0 ? 'create' : 'modify', newText });
  }
  return out;
}

/** Count of files that would change given the current selections. */
export function countAcceptedFiles(
  files: readonly MultiReviewFile[],
  acceptedByPath: Record<string, ReadonlySet<string>>,
): number {
  return applyMultiReview(files, acceptedByPath).length;
}
