/**
 * Inline edit (Cmd-K) core (PRD Epoch G §129.3 / Phase 187). Pure helpers: build a
 * region-scoped rewrite prompt from the selection + a natural-language instruction
 * (plus surrounding code for context only), clean the model's reply into the raw
 * replacement text (strip fences/prose), and decide whether the result is a
 * meaningful change. No I/O — the Main runner + editor widget use these. The edit
 * is applied through Monaco (undoable) and snapshot-protected by the caller.
 * Unit-smoke-tested.
 */
const CONTEXT_CHARS = 800;

const INLINE_EDIT_SYSTEM = [
  'You are an inline code editor inside an IDE. Rewrite ONLY the user-selected code',
  'region according to their instruction. Output ONLY the replacement code for that',
  'region — no explanations, no commentary, and no markdown code fences. Do NOT',
  'include the surrounding (prefix/suffix) code. Preserve the existing indentation and',
  'style. If the instruction cannot be sensibly applied, return the selection unchanged.',
].join(' ');

export interface InlineEditParams {
  /** The selected text to rewrite. */
  selection: string;
  /** The user's natural-language instruction. */
  instruction: string;
  /** Monaco language id (fenced-code hint). */
  language: string;
  /** Display name of the file, for context. */
  filename?: string;
  /** Code immediately before the selection (context only). */
  prefix?: string;
  /** Code immediately after the selection (context only). */
  suffix?: string;
}

/**
 * Build the inline-edit chat messages. The surrounding code is provided for
 * context with a marker where the selection sits, but the model is told to return
 * only the replacement for the selection.
 */
export function buildInlineEditMessages(params: InlineEditParams): {
  system: string;
  user: string;
} {
  const lang = params.language || 'plaintext';
  const prefix = (params.prefix ?? '').slice(-CONTEXT_CHARS);
  const suffix = (params.suffix ?? '').slice(0, CONTEXT_CHARS);
  const where = params.filename ? `File: ${params.filename}\n` : '';
  const ctx =
    prefix.length > 0 || suffix.length > 0
      ? `Surrounding code (context only \u2014 do not repeat it):\n\`\`\`${lang}\n${prefix}\u3010SELECTION\u3011${suffix}\n\`\`\`\n\n`
      : '';
  const user =
    `${where}Language: ${lang}\n\n` +
    ctx +
    `Instruction: ${params.instruction}\n\n` +
    `Selected code to rewrite:\n\`\`\`${lang}\n${params.selection}\n\`\`\``;
  return { system: INLINE_EDIT_SYSTEM, user };
}

/** Extract the first fenced code block's body, or null when there is none. */
function extractFenced(text: string): string | null {
  const m = /```[\w+#.-]*\n?([\s\S]*?)```/.exec(text);
  return m ? (m[1] ?? '') : null;
}

/**
 * Clean a model reply into raw replacement text: prefer the first fenced code
 * block if present (models often wrap despite instructions), else the trimmed
 * reply; drop leading blank lines and trailing whitespace while preserving the
 * first line's indentation.
 */
export function cleanInlineEdit(raw: string): string {
  const trimmed = raw.trim();
  const fenced = extractFenced(trimmed);
  const body = fenced !== null ? fenced : trimmed;
  return body.replace(/^\n+/, '').replace(/\s+$/, '');
}

/** Whether the edited text is a non-empty, real change from the original selection. */
export function isMeaningfulEdit(original: string, edited: string): boolean {
  return edited.trim().length > 0 && edited.trim() !== original.trim();
}
