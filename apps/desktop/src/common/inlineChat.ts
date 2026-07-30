/**
 * Inline chat core (PRD Epoch G §129.4 / Phase 188). A lightweight, anchored Q&A at
 * the cursor: the user asks a quick question about the selected code (or current
 * line) and gets a short, read-only answer they can escalate into an inline edit
 * (Phase 187). Pure helpers only — build the prompt and clean the reply. No I/O.
 * Unit-smoke-tested.
 */
const CONTEXT_CHARS = 800;

const INLINE_CHAT_SYSTEM = [
  'You are Axiom AI answering a quick, local question about the code at the user\u2019s cursor.',
  'Use the provided code as context. Be concise \u2014 a few sentences or a short list; this is an',
  'inline bubble, not the full chat panel. If the user wants a change, briefly describe it (they',
  'can apply it with the inline edit action). Do not dump large code blocks; explain and point.',
].join(' ');

export interface InlineChatParams {
  /** The user's question. */
  question: string;
  /** The selected code (or current line) the question is about. */
  selection: string;
  /** Monaco language id (fenced-code hint). */
  language: string;
  /** Display name of the file, for context. */
  filename?: string;
  /** Code immediately before the selection (context only). */
  prefix?: string;
  /** Code immediately after the selection (context only). */
  suffix?: string;
}

/** Build the inline-chat messages from the question + the local code context. */
export function buildInlineChatMessages(params: InlineChatParams): {
  system: string;
  user: string;
} {
  const lang = params.language || 'plaintext';
  const prefix = (params.prefix ?? '').slice(-CONTEXT_CHARS);
  const suffix = (params.suffix ?? '').slice(0, CONTEXT_CHARS);
  const where = params.filename ? `File: ${params.filename}\n` : '';
  const around =
    prefix.length > 0 || suffix.length > 0
      ? `Surrounding code (context):\n\`\`\`${lang}\n${prefix}\u3010CURSOR\u3011${suffix}\n\`\`\`\n\n`
      : '';
  const focus =
    params.selection.trim().length > 0
      ? `Code in focus:\n\`\`\`${lang}\n${params.selection}\n\`\`\`\n\n`
      : '';
  const user = `${where}Language: ${lang}\n\n${focus}${around}Question: ${params.question}`;
  return { system: INLINE_CHAT_SYSTEM, user };
}

/** Clean the inline-chat answer: trim surrounding whitespace/newlines. */
export function cleanInlineChatAnswer(raw: string): string {
  return raw.replace(/^\s+/, '').replace(/\s+$/, '');
}
