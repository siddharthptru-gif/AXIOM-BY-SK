import type { AiConversation, ChatMessage } from './ipc';

/**
 * Chat history / threads / search core (PRD Epoch G §128.8 / Phase 179). Pure
 * helpers over the persisted conversation list: derive an auto-title, order
 * threads (pinned first, then most-recent), rename, pin/unpin, run a full-text
 * search across titles + message bodies (ranked, with a match snippet), and
 * export a thread to Markdown or JSON. No I/O — the Main store persists; the
 * renderer drives the UI; both call these. Unit-smoke-tested.
 */

const TITLE_MAX = 60;
const RENAME_MAX = 120;
const SNIPPET_RADIUS = 48;

/** A search hit: the matched thread, its relevance score, and a preview snippet. */
export interface ThreadSearchResult {
  thread: AiConversation;
  score: number;
  snippet: string;
}

/** Collapse runs of whitespace and trim — used for titles and snippets. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Derive a thread title from its messages: the first user turn, whitespace-
 * collapsed and clamped. Falls back to "New chat" when there is no usable text.
 */
export function deriveThreadTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const derived = normalizeWhitespace(firstUser?.content ?? '').slice(0, TITLE_MAX);
  return derived.length > 0 ? derived : 'New chat';
}

/** The first non-empty user message, as a short preview line. */
function firstUserSnippet(thread: AiConversation): string {
  const firstUser = thread.messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  return normalizeWhitespace(firstUser?.content ?? '').slice(0, SNIPPET_RADIUS * 2);
}

/**
 * Order threads for display: pinned first, then most-recently-updated. Stable and
 * non-mutating (returns a new array).
 */
export function sortThreads(threads: readonly AiConversation[]): AiConversation[] {
  return [...threads].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.updatedAt - a.updatedAt;
  });
}

/** Rename a thread (whitespace-collapsed + clamped). Empty input keeps the old title. */
export function renameThread(
  threads: readonly AiConversation[],
  id: string,
  title: string,
): AiConversation[] {
  const clean = normalizeWhitespace(title).slice(0, RENAME_MAX);
  return threads.map((t) => (t.id === id && clean.length > 0 ? { ...t, title: clean } : t));
}

/** Set a thread's pinned flag (non-mutating). */
export function setPinned(
  threads: readonly AiConversation[],
  id: string,
  pinned: boolean,
): AiConversation[] {
  return threads.map((t) => (t.id === id ? { ...t, pinned } : t));
}

/** Toggle a thread's pinned flag. */
export function togglePin(threads: readonly AiConversation[], id: string): AiConversation[] {
  const t = threads.find((c) => c.id === id);
  return setPinned(threads, id, !(t && t.pinned));
}

/** Build a ~radius-char snippet centered on the first occurrence of `term`. */
function makeSnippet(content: string, term: string): string {
  const flat = normalizeWhitespace(content);
  const idx = flat.toLowerCase().indexOf(term);
  if (idx < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? '\u2026' : ''}${flat.slice(start, end)}${end < flat.length ? '\u2026' : ''}`;
}

/**
 * Full-text search across thread titles and message bodies. AND semantics: every
 * term must appear somewhere in the thread. Score weights title matches heavily,
 * then counts body occurrences; results are ranked (score, then recency) with a
 * preview snippet. An empty query returns all threads in display order.
 */
export function searchThreads(
  threads: readonly AiConversation[],
  query: string,
): ThreadSearchResult[] {
  const q = normalizeWhitespace(query).toLowerCase();
  if (q.length === 0) {
    return sortThreads(threads).map((thread) => ({
      thread,
      score: 0,
      snippet: firstUserSnippet(thread),
    }));
  }
  const terms = q.split(' ').filter(Boolean);
  const results: ThreadSearchResult[] = [];
  for (const thread of threads) {
    const title = thread.title.toLowerCase();
    const bodies = thread.messages.map((m) => m.content.toLowerCase());
    const haystack = `${title}\n${bodies.join('\n')}`;
    if (!terms.every((t) => haystack.includes(t))) continue;

    let score = 0;
    let snippet = '';
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      for (const m of thread.messages) {
        const lc = m.content.toLowerCase();
        let from = lc.indexOf(term);
        while (from >= 0) {
          score += 1;
          if (snippet.length === 0) snippet = makeSnippet(m.content, term);
          from = lc.indexOf(term, from + term.length);
        }
      }
    }
    results.push({ thread, score, snippet: snippet || firstUserSnippet(thread) });
  }
  results.sort((a, b) => b.score - a.score || b.thread.updatedAt - a.thread.updatedAt);
  return results;
}

/** Render a thread as portable Markdown (system turns omitted). */
export function exportThreadMarkdown(thread: AiConversation): string {
  const out: string[] = [
    `# ${thread.title}`,
    '',
    `_Axiom AI conversation \u00B7 exported ${new Date().toISOString()}_`,
    '',
  ];
  for (const m of thread.messages) {
    if (m.role === 'system') continue;
    out.push(`## ${m.role === 'user' ? 'You' : 'Axiom AI'}`, '', m.content.trim(), '');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/** Render a thread as pretty JSON (visible turns only). */
export function exportThreadJson(thread: AiConversation): string {
  return JSON.stringify(
    {
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    },
    null,
    2,
  );
}
