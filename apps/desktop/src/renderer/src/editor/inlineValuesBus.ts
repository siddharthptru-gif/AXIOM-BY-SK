/**
 * Inline values bus (PRD Phase 7 — Inline Values UI).
 *
 * The editor draws a debugger's values at the end of the lines they belong to, and it needs three
 * facts to do it: which DAP frame the values resolve in, which file that frame is stopped in, and
 * which line it stopped on. All three belong to the debug session, which the Run and Debug view
 * owns — so that view publishes them here and every editor pane subscribes. It is the same ownership
 * split the debug console already uses (`state/debugConsole.ts`) and the same owner-pattern bus as
 * {@link ./callHierarchyBus}.
 *
 * A null context means "nothing to draw": no session, running rather than paused, a frame with no
 * source, or the panel going away. Publishing null rather than leaving the last context in place is
 * what keeps a resumed program from still showing the values it had while it was paused.
 */
import type { DebugStackFrame } from '../../../common/ipc';

/** What the editor needs to ask an `InlineValuesProvider` for values and then resolve them. */
export interface InlineValueContext {
  /** DAP stack frame the values resolve in — the frame the user has selected. */
  frameId: number;
  /** Absolute path of that frame's source file, as the adapter reported it. */
  path: string;
  /** 1-based line the frame is stopped on. */
  line: number;
}

type Listener = (context: InlineValueContext | null) => void;

let current: InlineValueContext | null = null;
const listeners = new Set<Listener>();

function same(a: InlineValueContext | null, b: InlineValueContext | null): boolean {
  if (a === null || b === null) return a === b;
  return a.frameId === b.frameId && a.line === b.line && a.path === b.path;
}

/** The live context, for a subscriber that needs it outside a notification. */
export function inlineValueContext(): InlineValueContext | null {
  return current;
}

/**
 * Publish the frame being inspected. An identical context is dropped, so re-selecting the frame that
 * is already selected does not cost every open pane a fresh provider round trip.
 */
export function setInlineValueContext(next: InlineValueContext | null): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener(current);
}

/** Subscribe to context changes. The current context is delivered immediately. */
export function subscribeInlineValues(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The context for a stack frame, or null when there is nothing to decorate.
 *
 * A frame with no source path is a frame in code the debugger cannot show — an adapter internal, a
 * native call, an eval'd script — and there is no buffer to draw values in.
 */
export function frameInlineValueContext(
  frame: DebugStackFrame | undefined,
): InlineValueContext | null {
  if (frame === undefined || frame.path === null || frame.path.length === 0) return null;
  return { frameId: frame.id, path: frame.path, line: frame.line };
}
