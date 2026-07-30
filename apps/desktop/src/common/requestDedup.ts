/**
 * Request normalization + near-duplicate detection (PRD Epoch F, response-cache
 * dedup). Pure helpers that normalize chat message content so requests differing
 * only in whitespace / blank lines share a response-cache entry (cutting spend on
 * BYOK), plus a token-similarity check for a future near-duplicate layer. No I/O —
 * the egress gateway's cache key uses `normalizeMessages`. Smoke-tested.
 *
 * Normalization is intentionally conservative (CRLF→LF, per-line right-trim,
 * collapse blank-line runs, trim leading/trailing blanks). It never lowercases or
 * reorders, so the model's intended answer is unchanged — safe for cache dedup.
 */

export interface NormMessage {
  role: string;
  content: string;
}

/** Normalize message text for cache-keying (whitespace/blank-line only). */
export function normalizeContent(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''));
  // Collapse runs of 2+ blank lines into a single blank line.
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun += 1;
      if (blankRun <= 1) out.push('');
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  // Trim leading/trailing blank lines.
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Normalize a message list (role preserved, content normalized). */
export function normalizeMessages(messages: readonly NormMessage[]): NormMessage[] {
  return messages.map((m) => ({ role: m.role, content: normalizeContent(m.content) }));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Jaccard token similarity of two texts (0..1). */
export function similarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Similarity at/above this is considered a near-duplicate. */
export const NEAR_DUP_THRESHOLD = 0.92;

/**
 * Whether two message lists are near-duplicates: same length, same roles per turn,
 * and each turn's content at least `threshold` similar. Reserved for a future
 * near-duplicate cache layer; the shipped cache uses exact normalized keys.
 */
export function isNearDuplicate(
  a: readonly NormMessage[],
  b: readonly NormMessage[],
  threshold: number = NEAR_DUP_THRESHOLD,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i]!;
    const mb = b[i]!;
    if (ma.role !== mb.role) return false;
    if (similarity(ma.content, mb.content) < threshold) return false;
  }
  return true;
}
