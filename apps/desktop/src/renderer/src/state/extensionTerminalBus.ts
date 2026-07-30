/**
 * Renderer-local delivery of extension terminal writes (PRD Phase 7 §1).
 *
 * `op: 'write'` arrives on one IPC channel for every extension terminal, but the thing that can
 * satisfy it is one xterm instance deep in the pane tree — and for a pty-backed terminal it is not
 * even that, it is a `terminal.write` back to Main. Prop-drilling a write callback down through the
 * panel, the tab and the pane would put that plumbing in three components that have nothing else to
 * do with extensions, so the provider hands writes to this module and each pane registers what to
 * do with its own.
 *
 * Writes that arrive before a pane can take them are held, because they will: an extension that
 * calls `createTerminal()` and `sendText()` in the same tick has its text on the way before React
 * has committed the pane. The buffer is bounded and dropped with the terminal, so a pane that never
 * appears cannot grow one.
 */
type TerminalWriteSink = (data: string) => void;

/** Per-handle cap on held text. Enough for a long command, far short of a stream. */
export const MAX_BUFFERED_WRITE_CHARS = 64 * 1024;

/** How many handles may hold buffered text at once. Bounded like every other Phase 7 registry. */
export const MAX_BUFFERED_WRITE_HANDLES = 64;

const sinks = new Map<number, TerminalWriteSink>();
const buffered = new Map<number, string>();

/**
 * Panes that are about to become active without taking keyboard focus.
 *
 * `Terminal.show(preserveFocus)` has to make a pane the active one — otherwise the user cannot see
 * it — while leaving the caret wherever it was. Only the pane itself can decline to focus, and it
 * learns that here rather than through a prop the rest of the terminal UI has no use for.
 */
const focusSuppressed = new Set<string>();

/**
 * Route one write to the pane that owns `handle`, or hold it until the pane is ready.
 *
 * Returns true when the text was delivered or held, false when it was dropped — which happens only
 * when the buffer for that terminal is already full, or when too many terminals are waiting.
 */
export function deliverExtensionTerminalWrite(handle: number, data: string): boolean {
  if (handle <= 0 || data.length === 0) return false;
  const sink = sinks.get(handle);
  if (sink) {
    sink(data);
    return true;
  }
  const held = buffered.get(handle) ?? '';
  if (held.length === 0 && buffered.size >= MAX_BUFFERED_WRITE_HANDLES) return false;
  if (held.length >= MAX_BUFFERED_WRITE_CHARS) return false;
  buffered.set(handle, (held + data).slice(0, MAX_BUFFERED_WRITE_CHARS));
  return true;
}

/**
 * Claim `handle` for one pane and flush whatever was held for it.
 *
 * Registered once the pane can actually accept text — for a pty-backed terminal that means after the
 * shell exists, so `sendText` is never typed into a pane with no process behind it. The returned
 * function unregisters; it deliberately does not drop the buffer, so a pane that re-registers during
 * a React strict-mode double mount does not lose the extension's first write.
 */
export function registerExtensionTerminalSink(handle: number, sink: TerminalWriteSink): () => void {
  if (handle <= 0) return () => undefined;
  sinks.set(handle, sink);
  const held = buffered.get(handle);
  if (held !== undefined && held.length > 0) {
    buffered.delete(handle);
    sink(held);
  }
  return () => {
    if (sinks.get(handle) === sink) sinks.delete(handle);
  };
}

/** Forget a terminal entirely: its pane is gone and no later write can be for it. */
export function dropExtensionTerminalWrites(handle: number): void {
  sinks.delete(handle);
  buffered.delete(handle);
}

/** Clear every sink and buffer. For a workspace change and for the validators. */
export function resetExtensionTerminalWrites(): void {
  sinks.clear();
  buffered.clear();
  focusSuppressed.clear();
}

/** How much text is held, in characters. Diagnostics only. */
export function bufferedExtensionTerminalChars(): number {
  let total = 0;
  for (const value of buffered.values()) total += value.length;
  return total;
}

/**
 * Panes that are about to become active without taking keyboard focus: see `focusSuppressed`.
 *
 * Mark one pane so the next time it becomes active it does not steal focus.
 */
export function suppressNextTerminalFocus(paneId: string): void {
  if (paneId.length > 0) focusSuppressed.add(paneId);
}

/** True once, if this pane was marked. Consumes the mark. */
export function consumeSuppressedTerminalFocus(paneId: string): boolean {
  return focusSuppressed.delete(paneId);
}

/**
 * How the workbench reveals or collapses the terminal panel.
 *
 * `Terminal.show()` and `Terminal.hide()` are about the panel, not the pane, and the panel belongs
 * to the workbench chrome several providers above the terminal state. Same owner pattern as the
 * AI-action bus: the chrome registers what to do, and the terminal state needs to know nothing else
 * about it.
 */
export interface TerminalPanelController {
  /** Bring the terminal panel forward. `preserveFocus` leaves keyboard focus where it is. */
  reveal: (preserveFocus: boolean) => void;
  /** Collapse the terminal panel. */
  hide: () => void;
}

let panelController: TerminalPanelController | null = null;

export function setTerminalPanelController(controller: TerminalPanelController): () => void {
  panelController = controller;
  return () => {
    if (panelController === controller) panelController = null;
  };
}

/** Reveal the terminal panel, if the workbench has registered how. */
export function revealTerminalPanel(preserveFocus: boolean): void {
  panelController?.reveal(preserveFocus);
}

/** Collapse the terminal panel, if the workbench has registered how. */
export function hideTerminalPanel(): void {
  panelController?.hide();
}
