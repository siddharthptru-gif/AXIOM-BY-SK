/**
 * Grounded-answer guarantee core (PRD Epoch H §151 / Phase 238). Detects file
 * citations in an answer and, when strict grounded mode is on, flags substantive
 * answers that cite nothing (so the user knows the answer may be ungrounded). Pure
 * logic — user-toggleable; the Ask-mode surface renders the warning. Smoke-tested.
 */
export interface Citation {
  file: string;
  line?: number;
}

// A path-like token ending in a file extension, optionally with :line. Guarded so
// URLs (http://…) and bare sentence words aren't treated as citations.
const CITATION_RE = /(?<![\w/:.])([\w./-]+\.[A-Za-z][\w]*(?::\d+)?)/g;
const MIN_SUBSTANTIVE_CHARS = 40;

/** Detect `path/to/file.ext[:line]` citations in text (deduped, URL-guarded). */
export function detectCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) {
    const token = m[1];
    if (!token) continue;
    // Skip things that look like URLs or version numbers (e.g. 1.2.3).
    if (/^\d+\.\d+/.test(token)) continue;
    if (
      !token.includes('/') &&
      !/\.(ts|tsx|js|jsx|rs|py|go|java|rb|css|scss|html|json|md|toml|yml|yaml|c|cpp|cs|php|sh)(:\d+)?$/i.test(
        token,
      )
    ) {
      // A bare `word.ext` only counts for known code extensions.
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    const colon = token.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(token.slice(colon + 1))) {
      out.push({ file: token.slice(0, colon), line: Number(token.slice(colon + 1)) });
    } else {
      out.push({ file: token });
    }
  }
  return out;
}

export interface GroundedResult {
  ok: boolean;
  citationCount: number;
  reason: string;
}

/** Whether an answer is "substantive" (makes claims) vs a trivial reply/question. */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_SUBSTANTIVE_CHARS) return false;
  // A pure clarifying question isn't a grounded claim.
  if (t.endsWith('?') && t.length < 160) return false;
  return true;
}

/**
 * Validate an answer against the grounded-answer policy. When `requireCitation` is
 * off, always ok. When on, a substantive answer must include at least one file
 * citation; otherwise it is flagged as potentially ungrounded (user-toggleable, so
 * this is a warning surfaced to the user — not a hard block).
 */
export function validateGroundedAnswer(
  text: string,
  opts: { requireCitation: boolean },
): GroundedResult {
  const citations = detectCitations(text);
  if (!opts.requireCitation) {
    return { ok: true, citationCount: citations.length, reason: 'Grounded mode off.' };
  }
  if (!isSubstantive(text)) {
    return { ok: true, citationCount: citations.length, reason: 'No substantive claim to ground.' };
  }
  if (citations.length > 0) {
    return { ok: true, citationCount: citations.length, reason: 'Answer cites workspace files.' };
  }
  return {
    ok: false,
    citationCount: 0,
    reason:
      'This answer cites no files — it may not be grounded in your code. Attach files or verify before relying on it.',
  };
}
