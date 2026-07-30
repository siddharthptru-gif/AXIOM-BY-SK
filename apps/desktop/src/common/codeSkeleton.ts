/**
 * Code-skeleton context compression (PRD Epoch F §69.5). A pure, language-agnostic
 * skeletonizer for brace languages: it keeps declarations, signatures, and braces
 * while eliding statement bodies as `/* … *​/`, cutting tokens sharply while
 * preserving structure — ideal for including dependency files as context. Non-brace
 * code (e.g. Python) has no top-level-body braces to elide, so it is returned
 * effectively unchanged (safe). No I/O — unit-tested.
 */

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Return a structural skeleton of `code`. A line is KEPT when it changes brace
 * depth (a signature/opener or a closer) or is at top level; statement-body lines
 * inside a block (depth > 0, no brace change) are collapsed into a single
 * `/* … *​/` marker per contiguous run.
 */
export function skeletonize(code: string): string {
  const lines = code.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let eliding = false;
  for (const line of lines) {
    const net = countChar(line, '{') - countChar(line, '}');
    const before = depth;
    if (net !== 0 || before === 0) {
      out.push(line);
      eliding = false;
    } else if (!eliding) {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      out.push(`${indent}/* \u2026 */`);
      eliding = true;
    }
    depth = Math.max(0, depth + net);
  }
  return out.join('\n');
}

/** True when skeletonizing would meaningfully shrink the code (worth doing). */
export function shouldSkeletonize(code: string, minChars = 1500): boolean {
  if (code.length < minChars) return false;
  // Only worthwhile for brace languages with nested bodies.
  return countChar(code, '{') >= 2;
}
