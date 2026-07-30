/**
 * Inline values (PRD Phase 7 — Inline Values UI).
 *
 * PURE module: no Monaco, no debug adapter, no I/O. It turns what an `InlineValuesProvider` returned
 * into the two things the editor needs — the set of lookups the debugger must answer, and the label
 * to draw at the end of each line once they are answered.
 *
 * The provider's three result kinds are three different amounts of work, and the split is the whole
 * point of this module:
 *
 * - `InlineValueText` is already a label. Nothing to ask anyone.
 * - `InlineValueVariableLookup` names a variable (or points at a range and means "whatever is written
 *   there"), and the answer comes from the stopped frame's scopes, which the debug panel already has.
 * - `InlineValueEvaluatableExpression` needs a real `evaluate` round trip against the adapter.
 *
 * A provider is called for a whole visible range, so a screenful of code can produce a hundred
 * lookups, and the same variable usually appears on several lines. Deduplicating by name before
 * anything is asked is what keeps a stepped line from costing a hundred `evaluate` requests — which
 * is the difference between inline values that keep up with stepping and inline values that make
 * stepping feel broken.
 *
 * Ranges here are 0-based, as the wire uses; the renderer converts to Monaco's 1-based lines.
 */

import type { WireInlineValue } from './vscodeLanguageWire';

/** Values drawn on one line. Beyond this the line is unreadable and the rest are dropped. */
export const MAX_INLINE_VALUES_PER_LINE = 8;
/** Lines decorated at once, across the whole visible range. */
export const MAX_INLINE_VALUE_LINES = 300;
/** Characters kept from one value. */
export const MAX_INLINE_VALUE_TEXT = 64;
/** Characters kept from one whole line's label. */
export const MAX_INLINE_VALUE_LABEL = 240;
/** Distinct lookups sent to the debugger for one refresh. */
export const MAX_INLINE_VALUE_REQUESTS = 128;
/** Characters accepted as a variable name or expression. */
export const MAX_INLINE_VALUE_NAME = 128;

/** One value to draw, before it is known. */
export interface InlineValueSlot {
  /** 0-based line the value belongs to. */
  line: number;
  kind: 'text' | 'variable' | 'expression';
  /**
   * The literal label for `text`; the variable name for `variable`; the source expression for
   * `expression`.
   */
  name: string;
  /** `variable` only: whether the scope lookup must match case. */
  caseSensitive: boolean;
}

/** One lookup the debugger must answer. */
export interface InlineValueRequest {
  kind: 'variable' | 'expression';
  name: string;
  caseSensitive: boolean;
}

/** One end-of-line decoration. */
export interface InlineValueDecoration {
  /** 0-based line. */
  line: number;
  label: string;
}

/** Collapse whitespace and cap. A value with a newline in it would break the line it decorates. */
export function formatInlineValue(raw: string, limit = MAX_INLINE_VALUE_TEXT): string {
  const flat = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Whether two filesystem paths name the same file.
 *
 * A debug adapter reports a frame's source in its own form — backslashes on Windows, and a drive
 * letter cased however the adapter was launched — while the editor holds the path the workspace
 * opened. Comparing the two literally would leave a stopped frame undecorated on exactly the platform
 * where that is most likely, so separators are normalised and the match is case-insensitive, as
 * everywhere else in this codebase that compares a path (`relFromRoot`, `vscodeFileWatch`).
 */
export function sameInlineValuePath(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * The identifier written at `range` on `lineText`.
 *
 * A provider may return a variable lookup with no `variableName`, meaning "the text at this range" —
 * `InlineValueVariableLookup(range)` with one argument is the documented short form, and the
 * providers that ship with real debug extensions use it. Multi-line ranges are refused: the range is
 * meant to cover one identifier.
 */
export function inlineValueNameAt(
  lineText: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
): string | null {
  if (range.start.line !== range.end.line) return null;
  const start = Math.max(0, Math.min(range.start.character, lineText.length));
  const end = Math.max(start, Math.min(range.end.character, lineText.length));
  const text = lineText.slice(start, end).trim();
  if (text.length === 0 || text.length > MAX_INLINE_VALUE_NAME) return null;
  return text;
}

/**
 * Turn provider results into ordered slots.
 *
 * Order is the provider's, per line, because that is the order the values are written in the source.
 * `lineTextAt` is supplied by the caller (the renderer reads it from the model) so this stays pure.
 */
export function planInlineValues(
  values: readonly WireInlineValue[],
  lineTextAt: (line: number) => string,
): InlineValueSlot[] {
  const perLine = new Map<number, number>();
  const out: InlineValueSlot[] = [];
  for (const value of values) {
    if (perLine.size >= MAX_INLINE_VALUE_LINES && !perLine.has(value.range.start.line)) continue;
    const line = value.range.start.line;
    if (!Number.isInteger(line) || line < 0) continue;
    const used = perLine.get(line) ?? 0;
    if (used >= MAX_INLINE_VALUES_PER_LINE) continue;
    const slot = readSlot(value, lineTextAt);
    if (slot === null) continue;
    perLine.set(line, used + 1);
    out.push({ ...slot, line });
  }
  return out;
}

function readSlot(
  value: WireInlineValue,
  lineTextAt: (line: number) => string,
): Omit<InlineValueSlot, 'line'> | null {
  if (value.kind === 'text') {
    const text = formatInlineValue(value.text, MAX_INLINE_VALUE_TEXT);
    return text.length === 0 ? null : { kind: 'text', name: text, caseSensitive: true };
  }
  if (value.kind === 'variable') {
    const explicit =
      typeof value.variableName === 'string' && value.variableName.trim().length > 0
        ? value.variableName.trim().slice(0, MAX_INLINE_VALUE_NAME)
        : null;
    const name = explicit ?? inlineValueNameAt(lineTextAt(value.range.start.line), value.range);
    if (name === null) return null;
    return { kind: 'variable', name, caseSensitive: value.caseSensitiveLookup };
  }
  const explicit =
    typeof value.expression === 'string' && value.expression.trim().length > 0
      ? value.expression.trim().slice(0, MAX_INLINE_VALUE_NAME)
      : null;
  const name = explicit ?? inlineValueNameAt(lineTextAt(value.range.start.line), value.range);
  if (name === null) return null;
  return { kind: 'expression', name, caseSensitive: true };
}

/** The key a resolved value is stored under. Case-insensitive lookups fold their name. */
export function inlineValueKey(slot: InlineValueRequest | InlineValueSlot): string {
  if (slot.kind === 'text') return `text:${slot.name}`;
  const name = slot.caseSensitive ? slot.name : slot.name.toLowerCase();
  return `${slot.kind}:${name}`;
}

/**
 * The distinct lookups needed for a set of slots.
 *
 * One request per key however many lines use it: a loop counter on twenty lines is one `evaluate`,
 * not twenty. Literal text slots produce nothing.
 */
export function inlineValueRequests(slots: readonly InlineValueSlot[]): InlineValueRequest[] {
  const seen = new Set<string>();
  const out: InlineValueRequest[] = [];
  for (const slot of slots) {
    if (slot.kind === 'text') continue;
    const request: InlineValueRequest = {
      kind: slot.kind,
      name: slot.name,
      caseSensitive: slot.caseSensitive,
    };
    const key = inlineValueKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
    if (out.length >= MAX_INLINE_VALUE_REQUESTS) break;
  }
  return out;
}

/**
 * Find a variable in the stopped frame's scopes.
 *
 * Scope order is the adapter's, which is innermost first, so the first match wins — a local shadowing
 * a global must read as the local, exactly as it does in the variables view.
 */
export function findInlineVariable(
  variables: ReadonlyArray<{ name: string; value: string }>,
  name: string,
  caseSensitive: boolean,
): string | null {
  const target = caseSensitive ? name : name.toLowerCase();
  for (const variable of variables) {
    const candidate = caseSensitive ? variable.name : variable.name.toLowerCase();
    if (candidate === target) return variable.value;
  }
  return null;
}

/**
 * Build one decoration per line from the slots and whatever was resolved.
 *
 * A lookup with no answer contributes nothing: upstream shows a variable it could not find as absent
 * rather than as `undefined`, because "not in scope on this line" and "holds the value undefined" are
 * different facts and only one of them is true.
 */
export function composeInlineValueDecorations(
  slots: readonly InlineValueSlot[],
  resolved: ReadonlyMap<string, string>,
): InlineValueDecoration[] {
  const byLine = new Map<number, string[]>();
  const order: number[] = [];
  for (const slot of slots) {
    let label: string | null;
    if (slot.kind === 'text') {
      label = slot.name;
    } else {
      const value = resolved.get(inlineValueKey(slot));
      label = value === undefined ? null : `${slot.name} = ${formatInlineValue(value)}`;
    }
    if (label === null || label.length === 0) continue;
    const existing = byLine.get(slot.line);
    if (existing === undefined) {
      byLine.set(slot.line, [label]);
      order.push(slot.line);
    } else if (!existing.includes(label)) {
      existing.push(label);
    }
  }
  const out: InlineValueDecoration[] = [];
  for (const line of order) {
    const parts = byLine.get(line);
    if (parts === undefined || parts.length === 0) continue;
    const label = parts.join(', ');
    out.push({
      line,
      label:
        label.length > MAX_INLINE_VALUE_LABEL
          ? `${label.slice(0, MAX_INLINE_VALUE_LABEL - 1)}…`
          : label,
    });
    if (out.length >= MAX_INLINE_VALUE_LINES) break;
  }
  return out;
}
