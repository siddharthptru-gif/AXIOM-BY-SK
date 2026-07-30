/**
 * AI-authored provenance tracking (UI/UX PRD Part 6.2 gutter ribbon + Part 12).
 * Pure, I/O-free line-range bookkeeping of which lines in a file were authored or
 * modified by AI since the last commit. The editor renders a 2px `signal.ai` gutter
 * ribbon on these lines (the reserved AI-provenance violet), and provenance clears
 * on commit. All ranges are 1-based, inclusive line ranges. Smoke-tested.
 */

export interface LineRange {
  /** 1-based inclusive first line. */
  start: number;
  /** 1-based inclusive last line. */
  end: number;
}

/** Coalesce overlapping / adjacent ranges into a minimal sorted set. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const valid = ranges
    .filter(
      (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start && r.start >= 1,
    )
    .map((r) => ({ start: Math.floor(r.start), end: Math.floor(r.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LineRange[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Add an AI-authored range to the set (order-independent; result is merged). */
export function addRange(ranges: readonly LineRange[], start: number, end: number): LineRange[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return mergeRanges(ranges);
  const s = Math.max(1, Math.floor(Math.min(start, end)));
  const e = Math.max(1, Math.floor(Math.max(start, end)));
  return mergeRanges([...ranges, { start: s, end: e }]);
}

/**
 * Adjust ranges after a document edit at `editLine` (1-based) that removed
 * `removed` lines and inserted `added` lines. Ranges fully above the edit are
 * unchanged; ranges fully below shift by (added - removed); a range spanning the
 * edit grows/shrinks by the delta. Keeps the ribbon aligned as the user types
 * around AI regions.
 */
export function shiftRangesOnEdit(
  ranges: readonly LineRange[],
  editLine: number,
  removed: number,
  added: number,
): LineRange[] {
  const delta = (Number.isFinite(added) ? added : 0) - (Number.isFinite(removed) ? removed : 0);
  if (delta === 0) return mergeRanges(ranges);
  const out: LineRange[] = [];
  for (const r of ranges) {
    if (r.end < editLine) {
      out.push({ ...r }); // fully above the edit — unchanged
    } else if (r.start > editLine) {
      out.push({ start: Math.max(1, r.start + delta), end: Math.max(1, r.end + delta) }); // below — shift
    } else {
      out.push({ start: r.start, end: Math.max(r.start, r.end + delta) }); // spans the edit — resize
    }
  }
  return mergeRanges(out);
}

/** A Monaco-agnostic gutter decoration descriptor for a provenance range. */
export interface GutterDecoration {
  startLine: number;
  endLine: number;
  className: string;
}

/** Turn provenance ranges into gutter decoration descriptors (the 2px signal.ai ribbon). */
export function toGutterDecorations(
  ranges: readonly LineRange[],
  className = 'ai-provenance-gutter',
): GutterDecoration[] {
  return mergeRanges(ranges).map((r) => ({ startLine: r.start, endLine: r.end, className }));
}

/** Total AI-authored line count across the ranges (for a status readout). */
export function aiLineCount(ranges: readonly LineRange[]): number {
  return mergeRanges(ranges).reduce((n, r) => n + (r.end - r.start + 1), 0);
}
