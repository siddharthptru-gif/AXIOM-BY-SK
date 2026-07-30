/**
 * Agent typing reveal — planning (pure).
 *
 * When Build applies an edit, the user should SEE the code appear in the editor
 * the way a person types it, not just find a changed file afterwards. The naive
 * way to do that is to write the text into the model character by character, but
 * that is unsafe: it makes the buffer dirty against its saved baseline, races the
 * on-disk reconciliation in `EditorPane`, and fills the undo stack with dozens of
 * fake edits the user would then have to undo one at a time.
 *
 * So the reveal is presentational. The bytes are already correct on disk and in
 * the model; the editor merely holds the newly added text INVISIBLE and then
 * uncovers it progressively, with a caret at the frontier. Nothing is mutated, so
 * the animation can be cancelled at any point with no cleanup beyond dropping the
 * decorations.
 *
 * This module owns the arithmetic of that sweep: given the added lines and a time
 * budget, where should the frontier be at each tick.
 *
 * Pure: no I/O, no Monaco, no DOM.
 */

/** A 1-based editor position the reveal has uncovered up to (exclusive). */
export interface RevealFrontier {
  line: number;
  /** 1-based column. `1` means nothing on this line is revealed yet. */
  column: number;
}

/** One contiguous block of added lines to sweep through. */
export interface RevealBlock {
  /** 1-based first line of the block. */
  startLine: number;
  /** Length in characters of each line in the block, in order. */
  lineLengths: readonly number[];
}

export interface RevealPlanOptions {
  /** Ticks the whole reveal should take. More ticks = smoother, slower. */
  ticks?: number;
  /** Never advance fewer than this many characters per tick. */
  minCharsPerTick?: number;
}

const DEFAULT_TICKS = 42;
const DEFAULT_MIN_CHARS = 3;
/** A block larger than this is revealed line-wise rather than character-wise. */
export const MAX_CHARACTER_SWEEP_CHARS = 40_000;

/** Total characters in a block, counting one for each line break. */
export function blockCharCount(block: RevealBlock): number {
  let total = 0;
  for (const length of block.lineLengths) total += length + 1;
  return total;
}

/**
 * The frontier positions for one block, in order, ending at the block's last
 * character. An empty block yields no steps.
 *
 * The step size is derived from the block's own size so a two-line change and a
 * four-hundred-line file both finish in about the same wall-clock time: a fixed
 * characters-per-tick would make a large file take minutes.
 */
export function planReveal(block: RevealBlock, options: RevealPlanOptions = {}): RevealFrontier[] {
  const lineCount = block.lineLengths.length;
  if (lineCount === 0) return [];
  const ticks = Math.max(1, Math.floor(options.ticks ?? DEFAULT_TICKS));
  const minChars = Math.max(1, Math.floor(options.minCharsPerTick ?? DEFAULT_MIN_CHARS));
  const total = blockCharCount(block);
  const perTick = Math.max(minChars, Math.ceil(total / ticks));

  const steps: RevealFrontier[] = [];
  let lineIndex = 0;
  let column = 1;
  let budget = 0;

  // Walk the block as one flat character stream, emitting a frontier whenever the
  // per-tick budget is spent. Line breaks cost one character so a run of short
  // lines still advances visibly instead of stalling.
  while (lineIndex < lineCount) {
    const lineLength = block.lineLengths[lineIndex] ?? 0;
    const remainingOnLine = lineLength + 1 - column;
    const advance = Math.min(perTick - budget, Math.max(0, remainingOnLine));
    column += advance;
    budget += advance;

    if (column > lineLength) {
      // Crossed the line break: move to the start of the next line.
      lineIndex += 1;
      column = 1;
      budget += 1;
    }
    if (budget >= perTick) {
      budget = 0;
      if (lineIndex < lineCount) {
        steps.push({ line: block.startLine + lineIndex, column });
      }
    }
  }

  // Always finish exactly at the end of the block so nothing stays hidden.
  const lastLength = block.lineLengths[lineCount - 1] ?? 0;
  const end: RevealFrontier = { line: block.startLine + lineCount - 1, column: lastLength + 1 };
  const last = steps.at(-1);
  if (!last || last.line !== end.line || last.column !== end.column) steps.push(end);
  return steps;
}

/**
 * A coarse plan that uncovers whole lines only. Used for very large blocks, where
 * a character sweep would cost more in decoration churn than it adds in polish.
 */
export function planLineReveal(block: RevealBlock): RevealFrontier[] {
  const steps: RevealFrontier[] = [];
  for (let index = 0; index < block.lineLengths.length; index += 1) {
    steps.push({
      line: block.startLine + index,
      column: (block.lineLengths[index] ?? 0) + 1,
    });
  }
  return steps;
}

/** Choose the sweep granularity for a block. */
export function planRevealForBlock(
  block: RevealBlock,
  options: RevealPlanOptions = {},
): RevealFrontier[] {
  return blockCharCount(block) > MAX_CHARACTER_SWEEP_CHARS
    ? planLineReveal(block)
    : planReveal(block, options);
}
