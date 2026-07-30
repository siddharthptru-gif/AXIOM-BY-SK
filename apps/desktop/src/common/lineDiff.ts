/**
 * Pure line-diff engine (PRD Epoch G/H). LCS-based line diff with a common
 * prefix/suffix fast-path, plus a size guard so a pathological whole-file rewrite
 * can't blow up memory. Extracted to `common/` so both the Main agent-diff preview
 * (agentDiff.ts) and the renderer review session (reviewSession.ts) share one
 * implementation. No I/O — fully unit-testable.
 */

// Upper bound on the LCS table before we fall back to a coarse (del-all + add-all) diff.
export const MAX_LCS_CELLS = 4_000_000;

export type DiffOp = { op: 'eq' | 'add' | 'del'; line: string };

/** Split text into lines, dropping a single trailing empty line (final newline). */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line diff via LCS, with a common prefix/suffix fast-path so localized edits
 * only run the quadratic core on the small changed middle.
 */
export function computeLineDiff(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;

  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < lo; i++) ops.push({ op: 'eq', line: a[i]! });
  ops.push(...diffMiddle(a.slice(lo, aHi), b.slice(lo, bHi)));
  for (let i = aHi; i < a.length; i++) ops.push({ op: 'eq', line: a[i]! });
  return ops;
}

/** LCS diff of the (already prefix/suffix-trimmed) differing middle sections. */
function diffMiddle(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ op: 'add' as const, line }));
  if (m === 0) return a.map((line) => ({ op: 'del' as const, line }));
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((line) => ({ op: 'del' as const, line })),
      ...b.map((line) => ({ op: 'add' as const, line })),
    ];
  }

  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'eq', line: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ op: 'del', line: a[i]! });
      i++;
    } else {
      ops.push({ op: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'del', line: a[i++]! });
  while (j < m) ops.push({ op: 'add', line: b[j++]! });
  return ops;
}
