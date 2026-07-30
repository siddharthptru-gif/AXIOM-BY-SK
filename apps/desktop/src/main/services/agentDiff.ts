import type { AgentDiffLine, AgentFileDiff } from '../../common/ipc';
import { computeLineDiff, type DiffOp } from '../../common/lineDiff';

/**
 * Unified-diff preview builder for agent write approvals (PRD Epoch H). Uses the
 * shared line-diff engine (common/lineDiff) to produce a hunked view (changed
 * lines + surrounding context) between a file's current contents and the contents
 * the agent proposes to write, so the user approves an edit they can actually see.
 * No I/O — fully unit-testable.
 */
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 400;

type NumberedOp = DiffOp & { oldLine: number | null; newLine: number | null };

/**
 * Build a unified-diff preview between `oldText` (null = the file does not yet
 * exist) and `newText`: changed lines plus `context` unchanged lines around
 * them, grouped into hunks, with add/remove counts and a size cap.
 */
export function buildFileDiff(
  path: string,
  oldText: string | null,
  newText: string,
  opts?: {
    context?: number;
    maxLines?: number;
    changeKind?: AgentFileDiff['changeKind'];
  },
): AgentFileDiff {
  const context = opts?.context ?? DEFAULT_CONTEXT;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const isNew = oldText === null;
  const changeKind = opts?.changeKind ?? (isNew ? 'create' : 'modify');
  const ops = computeLineDiff(oldText ?? '', newText);

  let added = 0;
  let removed = 0;
  const numbered: NumberedOp[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const o of ops) {
    if (o.op === 'eq') {
      numbered.push({ ...o, oldLine: oldNo++, newLine: newNo++ });
    } else if (o.op === 'del') {
      removed++;
      numbered.push({ ...o, oldLine: oldNo++, newLine: null });
    } else {
      added++;
      numbered.push({ ...o, oldLine: null, newLine: newNo++ });
    }
  }

  // Keep changed lines plus `context` unchanged lines on each side.
  const keep = new Array<boolean>(numbered.length).fill(false);
  for (let k = 0; k < numbered.length; k++) {
    if (numbered[k]!.op !== 'eq') {
      const from = Math.max(0, k - context);
      const to = Math.min(numbered.length - 1, k + context);
      for (let x = from; x <= to; x++) keep[x] = true;
    }
  }

  const lines: AgentDiffLine[] = [];
  let truncated = false;
  let idx = 0;
  while (idx < numbered.length) {
    if (!keep[idx]) {
      idx++;
      continue;
    }
    let end = idx;
    while (end < numbered.length && keep[end]) end++;
    const hunk = numbered.slice(idx, end);
    const oldStart = hunk.find((h) => h.oldLine !== null)?.oldLine ?? 0;
    const newStart = hunk.find((h) => h.newLine !== null)?.newLine ?? 0;
    const oldCount = hunk.filter((h) => h.op !== 'add').length;
    const newCount = hunk.filter((h) => h.op !== 'del').length;
    lines.push({
      kind: 'hunk',
      text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldLine: null,
      newLine: null,
    });
    for (const h of hunk) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push({
        kind: h.op === 'add' ? 'add' : h.op === 'del' ? 'del' : 'ctx',
        text: h.line,
        oldLine: h.oldLine,
        newLine: h.newLine,
      });
    }
    if (truncated) break;
    idx = end;
  }

  return { path, changeKind, isNew, added, removed, lines, truncated };
}
