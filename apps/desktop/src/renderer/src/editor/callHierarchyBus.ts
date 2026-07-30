/**
 * Call-hierarchy bus (PRD Epoch D — Phase 95). Lets the editor hand a symbol's
 * incoming references off to the Explorer "Call Hierarchy" panel: the editor
 * resolves the references (it owns `monaco`, needed to turn LSP URIs into file
 * paths) and calls `showCallHierarchy`, which reveals the Explorer and delivers
 * the request to the panel (buffering it until the panel mounts). The panel owns
 * the workspace root, so it builds the grouped hierarchy itself via the pure
 * `buildCallHierarchy`. Owner pattern, like aiActionBus.
 */
import type { RefLocation } from '../../../common/callHierarchy';

export interface CallHierarchyRequest {
  /** The symbol under the cursor whose callers were resolved. */
  symbol: string;
  /** Raw reference sites (1-based), already mapped from LSP locations. */
  refs: RefLocation[];
}

type Listener = (req: CallHierarchyRequest) => void;

let listener: Listener | null = null;
let pending: CallHierarchyRequest | null = null;
let revealer: (() => void) | null = null;

/** App registers how to reveal the panel (e.g. `layout.showView('explorer')`). */
export function setCallHierarchyRevealer(fn: () => void): () => void {
  revealer = fn;
  return () => {
    if (revealer === fn) revealer = null;
  };
}

/** The panel subscribes; any buffered request is delivered immediately on mount. */
export function setCallHierarchyListener(fn: Listener): () => void {
  listener = fn;
  if (pending) {
    const p = pending;
    pending = null;
    fn(p);
  }
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Editor entry point: reveal the panel and deliver (or buffer) the request. */
export function showCallHierarchy(req: CallHierarchyRequest): void {
  revealer?.();
  if (listener) listener(req);
  else pending = req;
}
