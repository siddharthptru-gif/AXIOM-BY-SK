/**
 * Hierarchy bus (PRD Phase 7 — Type Hierarchy UI).
 *
 * Carries a prepared hierarchy from the editor to the Explorer "Hierarchy" panel. The editor owns
 * `monaco`, so it is the side that knows the position the user asked about and can call `prepare`;
 * the panel owns the lazy tree and every level fetched after the roots.
 *
 * The roots travel on the bus rather than the position, because `prepareTypeHierarchy` and
 * `prepareCallHierarchy` mint the provider tokens that every later level is routed by — asking twice
 * would produce a second set of tokens and a tree whose children came from a different query than its
 * roots. Owner pattern, like {@link ./callHierarchyBus}.
 */
import type { HierarchyKind } from '../../../common/hierarchyTree';
import type { WireHierarchyItem } from '../../../common/vscodeLanguageWire';

export interface HierarchyRequest {
  /** Which provider answered: a call hierarchy or a type hierarchy. */
  kind: HierarchyKind;
  /** The word under the cursor, shown while the roots are named by their provider. */
  symbol: string;
  /** The roots `prepare` returned, with their provider tokens intact. */
  roots: WireHierarchyItem[];
}

type Listener = (req: HierarchyRequest) => void;

let listener: Listener | null = null;
let pending: HierarchyRequest | null = null;
let revealer: (() => void) | null = null;

/** App registers how to reveal the panel (e.g. `layout.showView('intelligence')`). */
export function setHierarchyRevealer(fn: () => void): () => void {
  revealer = fn;
  return () => {
    if (revealer === fn) revealer = null;
  };
}

/** The panel subscribes; any buffered request is delivered immediately on mount. */
export function setHierarchyListener(fn: Listener): () => void {
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
export function showHierarchy(req: HierarchyRequest): void {
  revealer?.();
  if (listener) listener(req);
  else pending = req;
}
