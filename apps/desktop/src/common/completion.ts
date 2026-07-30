/**
 * Inline completion (ghost text) core (PRD Epoch G §129.1 / Phases 183 + 185). Pure
 * helpers: build the completion prompt (prefix + suffix around a cursor), clean the
 * model's reply into raw insertable code (strip fences, drop prefix echo, cap
 * lines), decide whether a completion should even be requested, and a small LRU+TTL
 * cache keyed by the local context. No I/O — the renderer provider + Main runner use
 * these; unit-tested (latency/cost come from caching + debounce in the provider).
 */
export const MAX_COMPLETION_LINES = 8;
const PREFIX_KEY_CHARS = 240;
const SUFFIX_KEY_CHARS = 80;

const COMPLETION_SYSTEM = [
  'You are a code completion engine. Continue the code exactly at the <CURSOR> marker.',
  'Output ONLY the raw code to insert at the cursor — no explanations, no markdown',
  'fences, and do not repeat the surrounding code. Prefer a short, single logical',
  'completion (a few lines at most).',
].join(' ');

/** Build the completion chat messages from the code around the cursor. */
export function buildCompletionMessages(
  prefix: string,
  suffix: string,
  language: string,
): { system: string; user: string } {
  return {
    system: COMPLETION_SYSTEM,
    user: `Language: ${language || 'plaintext'}\n\n${prefix}<CURSOR>${suffix}`,
  };
}

function stripFences(text: string): string {
  const fenced = /^```[\w+#.-]*\n?([\s\S]*?)```\s*$/.exec(text.trim());
  return fenced ? (fenced[1] ?? '') : text;
}

/**
 * Clean a model completion into insertable text: strip markdown fences, drop a
 * leading echo of the current line's prefix, cap the number of lines, and trim a
 * purely-whitespace result to empty. `prefix` is the text before the cursor.
 */
export function cleanCompletion(raw: string, prefix: string): string {
  let text = stripFences(raw).replace(/^\r?\n/, '');
  // Drop a leading echo of the current (unfinished) line.
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lastLine.length > 0 && text.startsWith(lastLine)) {
    text = text.slice(lastLine.length);
  }
  const lines = text.split('\n');
  if (lines.length > MAX_COMPLETION_LINES) {
    text = lines.slice(0, MAX_COMPLETION_LINES).join('\n');
  }
  // Strip trailing whitespace/newlines (ghost text rarely wants a trailing blank);
  // leading indentation is preserved.
  text = text.replace(/\s+$/, '');
  return text.length === 0 ? '' : text;
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * Whether to request a completion for this context. Skips empty prefixes and the
 * case where the cursor sits inside an identifier (word char on both sides), which
 * is where inline suggestions are noisy and usually wrong.
 */
export function shouldTriggerCompletion(prefix: string, suffix: string): boolean {
  if (prefix.trim().length === 0) return false;
  const before = prefix.slice(-1);
  const after = suffix.slice(0, 1);
  if (WORD.test(before) && WORD.test(after)) return false;
  return true;
}

/** Cache key for a completion request — the local context that determines it. */
export function completionCacheKey(prefix: string, suffix: string, language: string): string {
  return `${language}\u0000${prefix.slice(-PREFIX_KEY_CHARS)}\u0000${suffix.slice(0, SUFFIX_KEY_CHARS)}`;
}

interface Entry {
  value: string;
  at: number;
}

/** Small LRU + TTL cache for completions (avoids refetching + reduces cost/latency). */
export class CompletionCache {
  private readonly map = new Map<string, Entry>();
  constructor(
    private readonly max = 200,
    private readonly ttlMs = 60_000,
  ) {}

  get(key: string, now: number = Date.now()): string | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (now - e.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, e); // LRU touch
    return e.value;
  }

  set(key: string, value: string, now: number = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, at: now });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
