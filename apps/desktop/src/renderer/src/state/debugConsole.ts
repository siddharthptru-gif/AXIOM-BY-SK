import type { DebugState } from '../../../common/ipc';

/**
 * Debug Console store.
 *
 * The panel tab used to be permanently disabled and labelled "Debug Console
 * (Unavailable)" — adapter output only ever appeared inside the Run and Debug
 * sidebar, and there was no REPL at all. Everything a console needs was already
 * present in Main: the DAP service streams `output` events and answers
 * `evaluate(expression, frameId)`.
 *
 * This store owns that console independently of any view. It subscribes to the
 * debug event stream ONCE at startup, so output is captured whether or not the
 * sidebar happens to be mounted, and it keeps evaluating against whichever stack
 * frame the sidebar has selected — matching how a debug console behaves in every
 * other IDE: expressions resolve in the frame you are looking at.
 *
 * Bounded by construction: a chatty program cannot grow the transcript without
 * limit, and one over-long line is truncated rather than retained whole.
 */

export type DebugConsoleKind = 'input' | 'result' | 'error' | 'stdout' | 'stderr' | 'notice';

export interface DebugConsoleLine {
  id: number;
  kind: DebugConsoleKind;
  text: string;
  at: number;
}

/** Ring-buffer ceiling. Older lines are dropped, newest always kept. */
const MAX_LINES = 2_000;
const MAX_LINE_CHARS = 4_000;
/** Expression length cap, so a paste cannot become an unbounded adapter request. */
const MAX_EXPRESSION_CHARS = 2_000;
const MAX_HISTORY = 100;

interface ConsoleSnapshot {
  lines: readonly DebugConsoleLine[];
  session: DebugState;
  /** Frame expressions evaluate in; null means the adapter's global scope. */
  frameId: number | null;
  /** True when the adapter can answer an evaluate request right now. */
  canEvaluate: boolean;
}

let lines: DebugConsoleLine[] = [];
let session: DebugState = 'inactive';
let frameId: number | null = null;
let nextId = 1;
let subscribed = false;
const history: string[] = [];
const listeners = new Set<(snapshot: ConsoleSnapshot) => void>();

function snapshot(): ConsoleSnapshot {
  return {
    lines,
    session,
    frameId,
    // An adapter can only evaluate while a session exists. Paused is the useful
    // case; running is accepted because some adapters answer global expressions.
    canEvaluate: session === 'stopped' || session === 'running',
  };
}

function emit(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

function append(kind: DebugConsoleKind, text: string): void {
  const trimmed = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
  // Adapter output arrives in chunks that may contain several lines; split so the
  // transcript stays line-addressable and the ring buffer counts real lines.
  const parts = trimmed.split(/\r?\n/);
  const next = [...lines];
  for (const part of parts) {
    if (part.length === 0 && parts.length > 1) continue;
    next.push({ id: nextId++, kind, text: part, at: Date.now() });
  }
  lines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  emit();
}

/**
 * Begin capturing debug output. Idempotent, and called once from the renderer
 * entry so no view has to be open for output to be recorded.
 */
export function initDebugConsole(): void {
  if (subscribed) return;
  subscribed = true;
  window.axiom.debug.onEvent((event) => {
    if (event.kind === 'output') {
      append(event.category === 'stderr' ? 'stderr' : 'stdout', event.output);
      return;
    }
    const previous = session;
    session = event.state;
    if (event.state === 'stopped' && previous !== 'stopped') {
      append('notice', `Paused${event.reason ? ` (${event.reason})` : ''}.`);
    } else if (event.state === 'running' && previous === 'inactive') {
      append('notice', 'Debug session started.');
    } else if (event.state === 'terminated' || event.state === 'inactive') {
      frameId = null;
      if (previous !== 'inactive' && previous !== 'terminated') {
        append('notice', 'Debug session ended.');
      }
    }
    emit();
  });
}

/** Subscribe to the console. The current snapshot is delivered immediately. */
export function subscribeDebugConsole(
  listener: (snapshot: ConsoleSnapshot) => void,
): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Published by the Run and Debug view when the user selects a stack frame, so a
 * console expression resolves in the frame the user is actually inspecting.
 */
export function setDebugConsoleFrame(next: number | null): void {
  if (frameId === next) return;
  frameId = next;
  emit();
}

export function clearDebugConsole(): void {
  lines = [];
  emit();
}

/** Recent expressions, newest first, for Up/Down recall in the input. */
export function debugConsoleHistory(): readonly string[] {
  return history;
}

/**
 * Evaluate an expression in the active frame and record both sides of the
 * exchange. Errors are shown as console output rather than thrown, because a
 * failed expression is a normal part of using a debug console.
 */
export async function evaluateInDebugConsole(expression: string): Promise<void> {
  const expr = expression.trim();
  if (expr.length === 0) return;
  const bounded = expr.length > MAX_EXPRESSION_CHARS ? expr.slice(0, MAX_EXPRESSION_CHARS) : expr;
  history.unshift(bounded);
  if (history.length > MAX_HISTORY) history.pop();
  append('input', bounded);

  if (!snapshot().canEvaluate) {
    append('error', 'No debug session is active. Start one from Run and Debug first.');
    return;
  }
  try {
    const result = await window.axiom.debug.evaluate(bounded, frameId);
    append(result.ok ? 'result' : 'error', result.result || '(no value)');
  } catch (error) {
    append('error', error instanceof Error ? error.message : String(error));
  }
}
