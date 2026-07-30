/**
 * Ask mode core (PRD Epoch G §128.3 / Phases 175 + 176). Ask mode is a read-only,
 * grounded Q&A surface: it forces workspace grounding on, swaps in a system prompt
 * that requires citations and forbids proposing edits, and otherwise reuses the
 * chat pipeline. Pure helpers only (no I/O) — the ChatPanel selects the mode and
 * calls these. Unit-smoke-tested.
 */
export type ChatMode = 'chat' | 'ask';

export const CHAT_MODES: readonly ChatMode[] = ['chat', 'ask'];

export const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  chat: 'Chat',
  ask: 'Ask',
};

export const CHAT_MODE_HINTS: Record<ChatMode, string> = {
  chat: 'General assistant — explanations and code.',
  ask: 'Grounded, read-only Q&A about this workspace (cites sources, no edits).',
};

/** Coerce arbitrary input to a valid ChatMode (defaults to 'chat'). */
export function parseChatMode(value: unknown): ChatMode {
  return value === 'ask' ? 'ask' : 'chat';
}

const ASK_SYSTEM_PROMPT = [
  'You are Axiom AI in Ask mode \u2014 a read-only code Q&A assistant for the user\u2019s workspace.',
  'Answer the question using ONLY the provided workspace context and the conversation so far.',
  'Cite the specific files you rely on inline as `path:line` (or `path`) so the user can verify.',
  'If the answer is not supported by the provided context, say so plainly and suggest what to',
  'attach or open \u2014 do not guess or invent APIs. Do NOT propose, write, or apply code edits in',
  'Ask mode; explain and point to the relevant code instead. Be concise, precise, and technical.',
  // Ask has no tools, so a request to create or change files cannot be served here.
  // Naming the surface that CAN do it is far more useful than a generic refusal or
  // a hand-written tutorial the user then has to carry out themselves.
  'If the user asks you to create, edit, scaffold, or delete files, or to run a command, do not',
  'write a tutorial: tell them in one line to switch to Build mode in Axiom, which has the',
  'workspace tools to do it directly, and offer to sketch the approach first if that helps.',
].join(' ');

/**
 * The system prompt for a mode: the caller's base prompt for normal chat, or the
 * grounded read-only prompt for Ask mode.
 */
export function buildSystemPrompt(mode: ChatMode, baseChatPrompt: string): string {
  return mode === 'ask' ? ASK_SYSTEM_PROMPT : baseChatPrompt;
}

/** Ask mode always grounds on workspace context (RAG); normal chat leaves it to the user. */
export function forcesGrounding(mode: ChatMode): boolean {
  return mode === 'ask';
}
