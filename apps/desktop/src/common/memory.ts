import type { MemoryEntry } from './ipc';

/**
 * Long-term memory selection (PRD Epoch F, Phases 160–162 / §70). Pure,
 * deterministic scoring + selection of stored memories relevant to a query,
 * within a bounded budget, so the model gets continuity without unbounded prompt
 * growth. No I/O — the Main-process store loads entries and calls these; safe to
 * import anywhere. Memory is local only (INV-4).
 */

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'is',
  'it',
  'for',
  'on',
  'with',
  'as',
  'at',
  'by',
  'be',
  'this',
  'that',
  'are',
  'was',
  'we',
  'i',
  'you',
  'my',
  'our',
  'use',
  'using',
]);

/** Lowercased word tokens, dropping stopwords and 1-char noise. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return words.filter((t) => t.length > 1 && !STOP.has(t));
}

/** Lexical relevance: fraction of query tokens present in the memory (0..1). */
export function scoreMemory(entry: MemoryEntry, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const memTokens = new Set(tokenize(entry.text));
  if (memTokens.size === 0) return 0;
  let hits = 0;
  for (const q of new Set(queryTokens)) if (memTokens.has(q)) hits++;
  return hits / new Set(queryTokens).size;
}

export interface SelectOptions {
  /** Max memories to include. */
  maxCount?: number;
  /** Total character budget across included memories. */
  maxChars?: number;
}

/**
 * Select memories relevant to `query`: pinned entries first (always eligible),
 * then entries with query relevance (score desc), then recency (updatedAt desc);
 * capped by count and total characters. Non-pinned entries with zero relevance
 * are excluded so the block stays focused.
 */
export function selectMemories(
  entries: readonly MemoryEntry[],
  query: string,
  opts: SelectOptions = {},
): MemoryEntry[] {
  const maxCount = opts.maxCount ?? 8;
  const maxChars = opts.maxChars ?? 1200;
  const qTokens = tokenize(query);

  const scored = entries.map((e) => ({ e, score: scoreMemory(e, qTokens) }));
  scored.sort((a, b) => {
    if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return b.e.updatedAt - a.e.updatedAt;
  });

  const out: MemoryEntry[] = [];
  let used = 0;
  for (const { e, score } of scored) {
    if (!e.pinned && score <= 0) continue;
    if (out.length >= maxCount) break;
    const cost = e.text.length + 1;
    if (out.length > 0 && used + cost > maxChars) break;
    out.push(e);
    used += cost;
  }
  return out;
}

/** Render selected memories as a system-message block for grounding. */
export function buildMemoryBlock(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.text}`).join('\n');
  return `Remembered context the user has saved (use if relevant; ignore if not):\n${lines}`;
}
