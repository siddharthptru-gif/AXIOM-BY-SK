/**
 * Model output sanitation (pure).
 *
 * Reasoning-capable models emit two things the user must never see verbatim:
 *
 *   1. A REASONING BLOCK. `ai.ts` normalizes every provider's reasoning stream
 *      into `<think>…</think>`, and models like gpt-oss additionally emit their
 *      own `<think>` / `<thinking>` / `<reasoning>` / `<scratchpad>` tags. Left in
 *      place these render as raw pseudo-XML in the transcript.
 *   2. The TOOL-CALL JSON itself. The agent protocol asks for one JSON action; the
 *      action is meant to be executed and shown as a structured card, not printed.
 *
 * Both leaked into AXIOM's Build transcript, which is why a run could look like
 * `<think>We need to just list_dir…</think> {"tool":"list_dir","args":{"path":"."}}`.
 *
 * The reasoning block also broke ACTION PARSING. The old parser located candidate
 * JSON with `indexOf('{')` / `lastIndexOf('}')`, so when a model discussed the
 * action inside its reasoning ("We will issue: {"tool":"write_file","args":{…}}")
 * every brace slice straddled the reasoning text and failed to parse. The run then
 * fell through to "no usable action" and printed the raw reply — the exact reason a
 * requested file was never created. {@link balancedJsonSlices} replaces the naive
 * slicing with a string-aware brace scanner, and reasoning is removed before
 * parsing so its prose can never be mistaken for the action.
 *
 * Pure: no I/O, no Electron, no DOM. Safe in Main or the renderer.
 */

/** Tags whose contents are private model reasoning, never user-facing output. */
const REASONING_TAGS = ['think', 'thinking', 'reason', 'reasoning', 'scratchpad', 'analysis'];

/** Matches a complete reasoning block, e.g. `<think> … </think>`. */
const CLOSED_REASONING = new RegExp(
  `<\\s*(${REASONING_TAGS.join('|')})\\s*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`,
  'gi',
);

/**
 * Matches a reasoning block whose closing tag never arrived — a stream that was
 * cut off mid-thought. Everything after the opener is reasoning.
 */
const OPEN_REASONING = new RegExp(`<\\s*(?:${REASONING_TAGS.join('|')})\\s*>[\\s\\S]*$`, 'i');

/** A stray closing tag left behind when the opener was dropped upstream. */
const ORPHAN_CLOSE = new RegExp(`<\\s*/\\s*(?:${REASONING_TAGS.join('|')})\\s*>`, 'gi');

/**
 * gpt-oss "harmony" channel markers. When a provider forwards these raw they must
 * not reach the transcript either.
 */
const HARMONY_MARKERS = /<\|(?:channel|message|start|end|return|constrain)\|>/g;
const HARMONY_ANALYSIS = /<\|channel\|>\s*analysis[\s\S]*?(?=<\|channel\|>|$)/gi;

/** Upper bound on retained reasoning, so a runaway thought cannot bloat the UI. */
const MAX_REASONING_CHARS = 20_000;

export interface SplitModelText {
  /** The model's private reasoning, concatenated in order. '' when there was none. */
  reasoning: string;
  /** What remains once reasoning is removed — the candidate user-facing text. */
  visible: string;
}

/**
 * Separate private reasoning from the rest of a reply.
 *
 * The reasoning is returned rather than discarded so the UI can offer it behind a
 * collapsed disclosure: useful when diagnosing a bad run, invisible otherwise.
 */
export function splitReasoning(text: string): SplitModelText {
  if (typeof text !== 'string' || text.length === 0) return { reasoning: '', visible: '' };
  const parts: string[] = [];

  let visible = text.replace(HARMONY_ANALYSIS, (block) => {
    parts.push(block.replace(HARMONY_MARKERS, '').replace(/^\s*analysis/i, ''));
    return '';
  });

  CLOSED_REASONING.lastIndex = 0;
  visible = visible.replace(CLOSED_REASONING, (block) => {
    parts.push(block.replace(/^<[^>]*>/, '').replace(/<[^>]*>$/, ''));
    return '';
  });

  const open = OPEN_REASONING.exec(visible);
  if (open) {
    parts.push(open[0].replace(/^<[^>]*>/, ''));
    visible = visible.slice(0, open.index);
  }

  ORPHAN_CLOSE.lastIndex = 0;
  visible = visible.replace(ORPHAN_CLOSE, '');
  visible = visible.replace(HARMONY_MARKERS, '');

  const reasoning = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n')
    .slice(0, MAX_REASONING_CHARS);
  return { reasoning, visible: visible.trim() };
}

/** Just the non-reasoning remainder. */
export function stripReasoning(text: string): string {
  return splitReasoning(text).visible;
}

/**
 * Every balanced `{…}` region in `text`, outermost first, then the objects nested
 * one level inside each.
 *
 * String literals are tracked so a brace inside `"content": "function () {"` never
 * unbalances the scan, and escapes are honoured so `\"` does not end a string.
 * This is what makes an action containing a code payload parseable.
 */
export function balancedJsonSlices(text: string, limit = 16): string[] {
  const slices: string[] = [];
  if (typeof text !== 'string') return slices;

  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length < 2 || slices.length >= limit) return;
    if (!slices.includes(trimmed)) slices.push(trimmed);
  };

  // Depth-tracked scan. `starts` holds the offset of each currently-open brace, so
  // closing one yields that exact object regardless of how deeply it was nested.
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      starts.push(i);
      continue;
    }
    if (ch !== '}') continue;
    const start = starts.pop();
    if (start === undefined) continue;
    // Only the outermost object and its immediate children are worth trying; a
    // deeper slice is an argument value, not the action.
    if (starts.length <= 1) push(text.slice(start, i + 1));
    if (slices.length >= limit) break;
  }
  return slices;
}

/**
 * Does this text look like the agent's own protocol JSON rather than prose the user
 * should read? Used to keep a tool action out of the transcript.
 */
function looksLikeAction(slice: string): boolean {
  return /"\s*(?:tool|tool_name|toolName|function|tool_call|toolCall|final|final_answer|finalAnswer)\s*"\s*:/i.test(
    slice,
  );
}

/**
 * Remove the protocol JSON from a reply, leaving whatever prose surrounded it.
 *
 * Only slices that actually look like a protocol action are removed, so a code
 * block the user asked for — a `package.json` snippet, say — survives intact.
 */
export function stripActionJson(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const slice of balancedJsonSlices(text, 8)) {
    if (!looksLikeAction(slice)) continue;
    out = out.split(slice).join('');
  }
  // A fence emptied by the removal above would otherwise render as a blank block.
  return out
    .replace(/```[A-Za-z0-9_+-]*\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PresentedAssistantText {
  /** Markdown-ready text for the transcript. '' when the reply was pure protocol. */
  text: string;
  /** The model's reasoning, for an opt-in disclosure. '' when there was none. */
  reasoning: string;
  /** True when protocol JSON was removed, so the UI can explain a bare card. */
  hadAction: boolean;
}

/**
 * Turn a raw model reply into what the transcript should actually show: prose only,
 * with reasoning separated and protocol JSON removed.
 */
export function presentAssistantText(text: string): PresentedAssistantText {
  const { reasoning, visible } = splitReasoning(text);
  const withoutAction = stripActionJson(visible);
  return {
    text: withoutAction,
    reasoning,
    hadAction: withoutAction.length !== visible.trim().length,
  };
}
