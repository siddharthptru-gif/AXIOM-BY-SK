import type { AiFileReview } from '../../../common/aiEditReview';

/**
 * Agent typing bus.
 *
 * Build knows WHEN a file changed; the editor pane knows HOW to show it. This is
 * the same owner/listener pattern as the other editor buses: the Build panel
 * publishes a request after it opens the changed file, and whichever pane ends up
 * holding that model performs the reveal.
 *
 * Requests are retained briefly because opening a file is asynchronous — the pane
 * that will show it may not have created the model yet when the request arrives.
 */
export interface AgentTypingRequest {
  /** Absolute path of the file the agent just changed. */
  path: string;
  /** The applied change, addressed in the post-edit document. */
  review: AiFileReview;
  /** When the request was published, for staleness checks. */
  at: number;
}

type Listener = (request: AgentTypingRequest) => void;

const listeners = new Set<Listener>();
/** A request older than this is dropped rather than animated late. */
const REQUEST_TTL_MS = 4_000;
const pending: AgentTypingRequest[] = [];
const MAX_PENDING = 8;

function prune(now: number): void {
  while (pending.length > 0 && now - (pending[0]?.at ?? 0) > REQUEST_TTL_MS) pending.shift();
  while (pending.length > MAX_PENDING) pending.shift();
}

/**
 * Subscribe to typing requests. On subscribe, any request still within its TTL is
 * delivered, so a pane that mounts or swaps models just after Build published does
 * not miss the reveal.
 */
export function subscribeAgentTyping(listener: Listener): () => void {
  listeners.add(listener);
  const now = Date.now();
  prune(now);
  for (const request of [...pending]) listener(request);
  return () => {
    listeners.delete(listener);
  };
}

/** Published by the Build panel once the changed file has been opened. */
export function requestAgentTyping(request: AgentTypingRequest): void {
  prune(request.at);
  pending.push(request);
  for (const listener of listeners) listener(request);
}

/** Called by a pane that has performed (or declined) the reveal for a path. */
export function settleAgentTyping(path: string): void {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.path === path) pending.splice(index, 1);
  }
}
