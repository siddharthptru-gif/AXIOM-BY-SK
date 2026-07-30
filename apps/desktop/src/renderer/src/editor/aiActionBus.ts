/**
 * AI editor-action bus (PRD Epoch G — inline AI actions). Lets the editor hand a
 * selection off to the chat: the editor calls `requestAiAction`, which reveals
 * the AI panel and delivers the request to the ChatPanel (buffering it until the
 * panel mounts). Owner pattern like the other buses. The prompt is built here as
 * a pure function so it can be unit-tested.
 */
import { buildExplainRequest, type ExplainDepth } from '../../../common/explain';
export type AiActionKind = 'explain' | 'refactor' | 'fix' | 'docstring';

export interface AiEditorAction {
  kind: AiActionKind;
  /** The selected code (or the whole file when there is no selection). */
  code: string;
  /** Display label for the source file (base name). */
  fileLabel: string;
  /** Monaco language id, used for the fenced-code hint. */
  language: string;
  startLine: number;
  endLine: number;
  /** Explanation depth (only meaningful for the 'explain' action). */
  depth?: ExplainDepth;
  /**
   * A caller-supplied question to answer about `code`. Used when the evidence comes
   * from somewhere other than a single editor selection — semantic search results,
   * for example — so the user's own words lead the prompt instead of a generic
   * instruction. Omitted for the plain editor actions.
   */
  question?: string;
}

export type AiActionDelivery = 'accepted' | 'retry' | 'rejected';
type Listener = (action: AiEditorAction) => AiActionDelivery | Promise<AiActionDelivery>;

let listener: Listener | null = null;
const pending: AiEditorAction[] = [];
let deliveryInFlight = false;
let revealer: (() => void) | null = null;

async function flushPending(): Promise<void> {
  const owner = listener;
  const action = pending[0];
  if (!owner || !action || deliveryInFlight) return;

  deliveryInFlight = true;
  let result: AiActionDelivery = 'retry';
  try {
    result = await owner(action);
  } catch {
    result = 'retry';
  } finally {
    deliveryInFlight = false;
  }

  if (result !== 'retry' && pending[0] === action) pending.shift();
  // A StrictMode effect replacement may have installed a new owner while the
  // previous delivery was awaiting acknowledgement. Give that owner a chance;
  // otherwise a busy ChatPanel calls retryPendingAiActions when it becomes idle.
  if (listener && (listener !== owner || result !== 'retry')) void flushPending();
}

/** App registers how to reveal the AI panel (e.g. `layout.showView('ai')`). */
export function setAiPanelRevealer(fn: () => void): () => void {
  revealer = fn;
  return () => {
    if (revealer === fn) revealer = null;
  };
}

/** ChatPanel subscribes; buffered requests remain queued until acknowledged. */
export function setAiActionListener(fn: Listener): () => void {
  listener = fn;
  void flushPending();
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Ask the current ChatPanel to retry actions retained while it was busy. */
export function retryPendingAiActions(): void {
  void flushPending();
}

/** Editor entry point: reveal the AI panel and queue the action for delivery. */
export function requestAiAction(action: AiEditorAction): void {
  revealer?.();
  pending.push(action);
  void flushPending();
}

const INSTRUCTIONS: Record<AiActionKind, string> = {
  explain: 'Explain what the following code does, clearly and concisely.',
  refactor:
    'Refactor the following code to be cleaner and more maintainable without changing its ' +
    'behavior. Briefly explain the key changes, then provide the full refactored version.',
  fix:
    'Review the following code for bugs, edge cases, and problems. Explain what you find, then ' +
    'provide a corrected version.',
  docstring:
    'Add clear, idiomatic doc comments / docstrings to the following code. Return the fully ' +
    'documented version.',
};

/** Compose the chat prompt for an inline action (pure — unit-tested). */
export function buildActionPrompt(action: AiEditorAction): string {
  const question = action.question?.trim() ?? '';
  if (question.length > 0) {
    const where = `Evidence: ${action.fileLabel}`;
    return `${question}\n\n${where}\n\n\`\`\`${action.language}\n${action.code}\n\`\`\``;
  }
  if (action.kind === 'explain') {
    return buildExplainRequest(action.code, {
      lang: action.language,
      label: action.fileLabel,
      startLine: action.startLine,
      endLine: action.endLine,
      ...(action.depth ? { depth: action.depth } : {}),
    });
  }
  const instruction = INSTRUCTIONS[action.kind];
  const where = `File: ${action.fileLabel} (lines ${action.startLine}\u2013${action.endLine}), language: ${action.language}`;
  return `${instruction}\n\n${where}\n\n\`\`\`${action.language}\n${action.code}\n\`\`\``;
}
