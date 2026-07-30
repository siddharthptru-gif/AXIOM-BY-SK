import type { AiFileReview } from '../../../common/aiEditReview';

/**
 * AI edit review bus. Build publishes each APPLIED file change here; the editor
 * subscribes and renders the change inline with per-hunk accept/revert, so the
 * user reviews AI edits in the file itself rather than in a chat card.
 *
 * Renderer-only coordination state. It grants no authority: the diffs come from
 * Main, and reverting edits the open Monaco model (undoable, then saved by the
 * user through the normal authorized save path).
 */
const reviews = new Map<string, AiFileReview>();
type Listener = () => void;
const listeners = new Set<Listener>();

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.toLowerCase();
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to review changes. Returns an unsubscribe function. */
export function subscribeAiReviews(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish (or replace) the pending review for one file. */
export function publishAiReview(review: AiFileReview): void {
  if (review.hunks.length === 0) {
    if (reviews.delete(pathKey(review.path))) emit();
    return;
  }
  reviews.set(pathKey(review.path), review);
  emit();
}

export function getAiReview(path: string): AiFileReview | null {
  return reviews.get(pathKey(path)) ?? null;
}

export function listAiReviews(): AiFileReview[] {
  return [...reviews.values()].sort((a, b) => b.at - a.at);
}

export function aiReviewCount(): number {
  return reviews.size;
}

/** Drop one hunk (accepted, or reverted after the edit was applied). */
export function resolveAiReviewHunk(path: string, hunkId: string): void {
  const key = pathKey(path);
  const review = reviews.get(key);
  if (!review) return;
  const remaining = review.hunks.filter((hunk) => hunk.id !== hunkId);
  if (remaining.length === review.hunks.length) return;
  if (remaining.length === 0) reviews.delete(key);
  else reviews.set(key, { ...review, hunks: remaining });
  emit();
}

/** Clear the whole review for one file (accept all / revert all). */
export function clearAiReview(path: string): void {
  if (reviews.delete(pathKey(path))) emit();
}

/** Clear every pending review (workspace or trust change). */
export function clearAllAiReviews(): void {
  if (reviews.size === 0) return;
  reviews.clear();
  emit();
}
