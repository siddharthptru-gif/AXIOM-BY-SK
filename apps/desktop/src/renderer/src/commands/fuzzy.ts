/**
 * Small fuzzy subsequence matcher for the palette / quick open (PRD Part VII §105).
 * Returns a score (higher is better) and the matched character indices for
 * highlighting, or null when `query` is not a subsequence of `target`.
 */
export interface FuzzyResult {
  score: number;
  matches: number[];
}

const BOUNDARY = /[\\/_\-. ]/;

export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, matches: [] };
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    const tc = t[ti];
    if (tc === undefined || tc !== q[qi]) continue;
    let bonus = 1;
    if (ti === prev + 1) bonus += 4; // contiguous run
    const prevCh = ti > 0 ? t[ti - 1] : undefined;
    if (ti === 0 || (prevCh !== undefined && BOUNDARY.test(prevCh))) bonus += 6; // word/segment start
    if (target[ti] === query[qi]) bonus += 1; // exact-case nudge
    score += bonus;
    matches.push(ti);
    prev = ti;
    qi += 1;
  }

  if (qi < q.length) return null;

  // Prefer shorter targets and earlier first matches on ties.
  score -= target.length * 0.02;
  score -= (matches[0] ?? 0) * 0.15;
  return { score, matches };
}
