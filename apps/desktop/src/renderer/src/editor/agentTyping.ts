import { monaco } from './monacoEnv';
import {
  planRevealForBlock,
  type RevealBlock,
  type RevealFrontier,
} from '../../../common/agentTyping';
import { isDeletionOnly, type AiFileReview } from '../../../common/aiEditReview';

/**
 * Agent typing reveal — the editor half.
 *
 * Makes the agent's newly written code appear as if it is being typed, WITHOUT
 * touching the document. The added lines are covered by a zero-opacity inline
 * decoration and uncovered progressively, with a caret decoration at the frontier.
 *
 * Because nothing is mutated:
 *   • the buffer never goes dirty, so `EditorPane`'s on-disk reconciliation and
 *     the ETag save guard are unaffected;
 *   • the undo stack stays clean — the user undoes the agent's edit once, not once
 *     per animation frame;
 *   • cancelling is free, so switching tabs mid-reveal simply stops it.
 *
 * The reveal is skipped when it would be wrong or unwelcome: an unsaved buffer, a
 * stale request, a diff Main had to truncate, or `prefers-reduced-motion`.
 */

/** Wall-clock budget for one file's reveal, however large the change. */
const TARGET_DURATION_MS = 1_400;
const TICK_MS = 24;
const MAX_TICKS = Math.floor(TARGET_DURATION_MS / TICK_MS);

export interface AgentTypingHandle {
  cancel: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The line blocks to sweep, clamped to the model. A hunk that only removed lines
 * has nothing to type, and a range past the end of the document means the model
 * moved on since the diff was built — both are skipped rather than guessed at.
 */
function blocksFor(model: monaco.editor.ITextModel, review: AiFileReview): RevealBlock[] {
  const lineCount = model.getLineCount();
  const blocks: RevealBlock[] = [];
  for (const hunk of review.hunks) {
    if (isDeletionOnly(hunk)) continue;
    const start = Math.max(1, hunk.startLine);
    const end = Math.min(lineCount, hunk.endLine);
    if (end < start) continue;
    const lineLengths: number[] = [];
    for (let line = start; line <= end; line += 1) lineLengths.push(model.getLineLength(line));
    blocks.push({ startLine: start, lineLengths });
  }
  return blocks;
}

function hiddenRange(
  model: monaco.editor.ITextModel,
  frontier: RevealFrontier,
  block: RevealBlock,
): monaco.Range {
  const lastLine = block.startLine + block.lineLengths.length - 1;
  return new monaco.Range(
    frontier.line,
    frontier.column,
    lastLine,
    model.getLineMaxColumn(Math.min(lastLine, model.getLineCount())),
  );
}

/**
 * Run the reveal for one applied file change. Returns a handle whose `cancel`
 * immediately restores full visibility; safe to call more than once.
 */
export function revealAgentEdit(
  editor: monaco.editor.IStandaloneCodeEditor,
  model: monaco.editor.ITextModel,
  review: AiFileReview,
): AgentTypingHandle | null {
  if (review.truncated || prefersReducedMotion()) return null;
  const blocks = blocksFor(model, review);
  if (blocks.length === 0) return null;

  const collection = editor.createDecorationsCollection([]);
  let cancelled = false;
  let timer: number | null = null;

  const finish = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    collection.clear();
  };

  // Split the tick budget across blocks so the whole file finishes on time.
  const ticksPerBlock = Math.max(4, Math.floor(MAX_TICKS / blocks.length));
  const queue = blocks.map((block) => ({
    block,
    steps: planRevealForBlock(block, { ticks: ticksPerBlock }),
  }));

  let blockIndex = 0;
  let stepIndex = 0;

  const paint = (): void => {
    if (cancelled) return;
    if (model.isDisposed() || editor.getModel() !== model) {
      finish();
      return;
    }
    const current = queue[blockIndex];
    if (!current) {
      finish();
      return;
    }
    const frontier = current.steps[stepIndex];
    if (!frontier) {
      blockIndex += 1;
      stepIndex = 0;
      timer = window.setTimeout(paint, TICK_MS);
      return;
    }

    // One decoration hides the not-yet-typed remainder of this block; every later
    // block stays fully hidden until its turn.
    const decorations: monaco.editor.IModelDeltaDecoration[] = [
      {
        range: hiddenRange(model, frontier, current.block),
        options: {
          inlineClassName: 'axiom-agent-typing-hidden',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
      {
        range: new monaco.Range(frontier.line, frontier.column, frontier.line, frontier.column),
        options: {
          beforeContentClassName: 'axiom-agent-typing-caret',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ];
    for (let index = blockIndex + 1; index < queue.length; index += 1) {
      const later = queue[index];
      if (!later) continue;
      decorations.push({
        range: hiddenRange(model, { line: later.block.startLine, column: 1 }, later.block),
        options: {
          inlineClassName: 'axiom-agent-typing-hidden',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    collection.set(decorations);

    // Follow the caret, but only when it has left the viewport, so a reveal that
    // fits on screen does not jitter the scroll position.
    editor.revealLineInCenterIfOutsideViewport(frontier.line, monaco.editor.ScrollType.Smooth);

    stepIndex += 1;
    timer = window.setTimeout(paint, TICK_MS);
  };

  // Start fully hidden, then begin uncovering on the next tick.
  collection.set(
    queue.map(({ block }) => ({
      range: hiddenRange(model, { line: block.startLine, column: 1 }, block),
      options: {
        inlineClassName: 'axiom-agent-typing-hidden',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
  timer = window.setTimeout(paint, TICK_MS);

  return { cancel: finish };
}
