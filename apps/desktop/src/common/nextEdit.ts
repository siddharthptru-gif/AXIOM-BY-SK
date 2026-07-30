/**
 * IntelliSense coexistence + next-edit prediction (PRD Epoch G §129 / Phases 184 +
 * 186). Pure helpers: (184) arbitrate whether ghost text should be offered given the
 * user's inline-vs-IntelliSense priority (suppress ghost text right after a
 * member/path trigger so the LSP widget leads); (186) detect a single whole-token
 * rename on a line and find the other occurrences to propagate to (tab-to-jump /
 * apply). No I/O — unit-tested; the editor wiring is thin over these.
 */
export type InlinePriority = 'inline' | 'intellisense';
export const INLINE_PRIORITIES: readonly InlinePriority[] = ['inline', 'intellisense'];

export function parseInlinePriority(value: unknown): InlinePriority {
  return value === 'intellisense' ? 'intellisense' : 'inline';
}

// Chars after which the LSP suggest widget is authoritative (member/path/etc).
const TRIGGER_TAIL = /[.:/@<]$/;

/**
 * Whether an inline (ghost-text) completion should be offered. Disabled → never;
 * when the user prioritizes IntelliSense, suppress ghost text right after a trigger
 * char so the widget isn't fought. Otherwise offer it (Monaco shows both surfaces;
 * Tab commits ghost text, Enter accepts the widget).
 */
export function arbitrateInline(state: {
  enabled: boolean;
  prefix: string;
  priority: InlinePriority;
}): boolean {
  if (!state.enabled) return false;
  if (state.priority === 'intellisense' && TRIGGER_TAIL.test(state.prefix)) return false;
  return true;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const WORD_CHAR = /[\w$]/;

export interface TokenRename {
  oldToken: string;
  newToken: string;
}

/**
 * Detect a single whole-identifier substitution between two versions of a line
 * (e.g. `const foo = 1` → `const bar = 1` yields {foo, bar}). Returns null when the
 * change is not a clean single-token rename.
 */
export function diffLineToken(before: string, after: string): TokenRename | null {
  if (before === after) return null;
  const minLen = Math.min(before.length, after.length);
  let mismatch = 0;
  while (mismatch < minLen && before[mismatch] === after[mismatch]) mismatch++;

  let oldStart = mismatch;
  let newStart = mismatch;
  while (oldStart > 0 && WORD_CHAR.test(before[oldStart - 1]!)) oldStart--;
  while (newStart > 0 && WORD_CHAR.test(after[newStart - 1]!)) newStart--;
  let oldEnd = mismatch;
  let newEnd = mismatch;
  while (oldEnd < before.length && WORD_CHAR.test(before[oldEnd]!)) oldEnd++;
  while (newEnd < after.length && WORD_CHAR.test(after[newEnd]!)) newEnd++;

  const oldToken = before.slice(oldStart, oldEnd);
  const newToken = after.slice(newStart, newEnd);
  if (!IDENT.test(oldToken) || !IDENT.test(newToken) || oldToken === newToken) return null;
  if (before.slice(0, oldStart) !== after.slice(0, newStart)) return null;
  if (before.slice(oldEnd) !== after.slice(newEnd)) return null;
  return { oldToken, newToken };
}

export interface Occurrence {
  line: number;
  column: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word occurrences of `token` in text (1-based line + column). */
export function findWholeWordOccurrences(text: string, token: string): Occurrence[] {
  if (token.length === 0) return [];
  const out: Occurrence[] = [];
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`(?<![\\w$])${escapeRe(token)}(?![\\w$])`, 'g');
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i]!)) !== null) out.push({ line: i + 1, column: m.index + 1 });
  }
  return out;
}

/**
 * Predict the next edits after a token rename: the other occurrences of the old
 * token (optionally excluding the line already edited) that could be renamed too.
 */
export function predictNextEdit(
  fullText: string,
  rename: TokenRename,
  excludeLine?: number,
): Occurrence[] {
  return findWholeWordOccurrences(fullText, rename.oldToken).filter((o) => o.line !== excludeLine);
}
