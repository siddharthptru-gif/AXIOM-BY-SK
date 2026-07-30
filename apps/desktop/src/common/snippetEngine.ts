/**
 * TextMate snippet engine — evaluation (PRD Ch. 29, SN-3 … SN-9, SN-11).
 *
 * Turns a parsed snippet into the exact text to insert plus the tabstop geometry the
 * editor needs to drive Tab/Shift+Tab. Keeping this separate from the parser means the
 * same tree can be evaluated twice with different variable values (two cursors, SN-6)
 * without re-parsing, and it keeps the parser free of any notion of "now" or "clipboard".
 *
 * Pure: variable values arrive resolved. `snippetVariables.ts` owns the impure parts
 * (clock, clipboard, workspace) so that insertion itself stays reproducible.
 */
import type { FormatNode, SnippetNode, SnippetTransform } from './snippetParser';
import { parseSnippet } from './snippetParser';

/** Guard against a catastrophic transform pattern on a large mirror value. */
const MAX_TRANSFORM_INPUT = 8 * 1024;

export interface SnippetEvalContext {
  /** Resolved variable values; a missing key means "not set". */
  variables?: Readonly<Record<string, string | undefined>>;
}

export interface SnippetTabstop {
  index: number;
  /** Offset into the produced text. */
  offset: number;
  length: number;
  /** The text the tabstop starts with (a placeholder default, or ''). */
  value: string;
  /** Choice options, when the tabstop was written as `${1|a,b|}`. */
  choices?: string[];
  /**
   * False for the second and later occurrences of one index: those mirror the primary
   * and must be updated as the user types, not visited separately.
   */
  primary: boolean;
}

export interface EvaluatedSnippet {
  text: string;
  /** Tabstops in visit order: 1, 2, 3 …, then `$0`. */
  tabstops: SnippetTabstop[];
  /** Where the cursor lands when the snippet is finished. */
  finalOffset: number;
  errors: string[];
}

function applyShorthand(value: string, shorthand: string): string {
  switch (shorthand) {
    case 'upcase':
      return value.toUpperCase();
    case 'downcase':
      return value.toLowerCase();
    case 'capitalize':
      return value.length === 0 ? value : value[0]?.toUpperCase() + value.slice(1);
    case 'camelcase':
    case 'pascalcase': {
      const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
      const joined = words
        .map((word, position) =>
          position === 0 && shorthand === 'camelcase'
            ? word[0]?.toLowerCase() + word.slice(1)
            : word[0]?.toUpperCase() + word.slice(1),
        )
        .join('');
      return joined;
    }
    default:
      return value;
  }
}

/** Expand one format string against a regex match. */
function expandFormat(format: readonly FormatNode[], match: RegExpMatchArray): string {
  let out = '';
  // `\u`/`\l` affect only the next character produced, `\U`/`\L` until `\E` — that state
  // lives across nodes, which is why this is a fold rather than a map.
  let pendingSingle: 'upper' | 'lower' | null = null;
  let running: 'upper' | 'lower' | null = null;
  const emit = (raw: string): void => {
    let text = raw;
    if (pendingSingle !== null && text.length > 0) {
      const first = pendingSingle === 'upper' ? text[0]?.toUpperCase() : text[0]?.toLowerCase();
      text = `${first}${text.slice(1)}`;
      pendingSingle = null;
    }
    if (running === 'upper') text = text.toUpperCase();
    else if (running === 'lower') text = text.toLowerCase();
    out += text;
  };
  for (const node of format) {
    if (node.type === 'text') {
      let literal = '';
      for (let index = 0; index < node.value.length; index += 1) {
        const character = node.value[index] as string;
        if (character === '\\') {
          const next = node.value[index + 1];
          if (next === 'u' || next === 'l' || next === 'U' || next === 'L' || next === 'E') {
            if (literal.length > 0) {
              emit(literal);
              literal = '';
            }
            if (next === 'u') pendingSingle = 'upper';
            else if (next === 'l') pendingSingle = 'lower';
            else if (next === 'U') running = 'upper';
            else if (next === 'L') running = 'lower';
            else running = null;
            index += 1;
            continue;
          }
          if (next === 'n') {
            literal += '\n';
            index += 1;
            continue;
          }
          if (next === 't') {
            literal += '\t';
            index += 1;
            continue;
          }
        }
        literal += character;
      }
      if (literal.length > 0) emit(literal);
      continue;
    }
    const group = match[node.index];
    const matched = group !== undefined && group.length > 0;
    if (node.shorthand !== undefined) {
      emit(applyShorthand(group ?? '', node.shorthand));
      continue;
    }
    if (node.ifValue !== undefined && node.elseValue !== undefined) {
      emit(matched ? node.ifValue : node.elseValue);
      continue;
    }
    if (node.ifValue !== undefined) {
      emit(matched ? node.ifValue : '');
      continue;
    }
    if (node.elseValue !== undefined) {
      emit(matched ? (group as string) : node.elseValue);
      continue;
    }
    emit(group ?? '');
  }
  return out;
}

/**
 * Apply a `${var/regex/format/flags}` transform.
 *
 * An invalid pattern returns the input unchanged rather than throwing: a snippet with a
 * bad regex should insert something reasonable, not abort the edit the user asked for.
 */
export function applySnippetTransform(transform: SnippetTransform, value: string): string {
  const input = value.length > MAX_TRANSFORM_INPUT ? value.slice(0, MAX_TRANSFORM_INPUT) : value;
  let expression: RegExp;
  try {
    expression = new RegExp(transform.pattern, transform.flags);
  } catch {
    return input;
  }
  if (!transform.flags.includes('g')) {
    const match = expression.exec(input);
    if (match === null) return '';
    return (
      input.slice(0, match.index) +
      expandFormat(transform.format, match) +
      input.slice(match.index + match[0].length)
    );
  }
  let out = '';
  let cursor = 0;
  let guard = 0;
  let match = expression.exec(input);
  while (match !== null && guard < 10_000) {
    guard += 1;
    out += input.slice(cursor, match.index) + expandFormat(transform.format, match);
    cursor = match.index + match[0].length;
    if (match[0].length === 0) expression.lastIndex += 1;
    match = expression.exec(input);
  }
  return out + input.slice(cursor);
}
/**
 * Evaluate a parsed snippet into text plus tabstop geometry.
 *
 * Repeated indices are handled the way upstream does: the first occurrence owns the
 * value and later ones mirror it. Marking the mirrors instead of dropping them lets the
 * editor keep them in sync while visiting each index once — a snippet like
 * `<$1>$2</$1>` is the common case and must not stop twice on `$1`.
 */
export function evaluateSnippet(
  nodes: readonly SnippetNode[],
  context: SnippetEvalContext = {},
): EvaluatedSnippet {
  const variables = context.variables ?? {};
  const errors: string[] = [];
  const tabstops: SnippetTabstop[] = [];
  const resolvedByIndex = new Map<number, string>();
  let text = '';

  const emit = (value: string): void => {
    text += value;
  };

  const renderNodes = (list: readonly SnippetNode[]): string => {
    const before = text.length;
    walk(list);
    return text.slice(before);
  };

  const record = (index: number, offset: number, value: string, choices?: string[]): void => {
    const primary = !resolvedByIndex.has(index);
    if (primary) resolvedByIndex.set(index, value);
    tabstops.push({
      index,
      offset,
      length: value.length,
      value,
      primary,
      ...(choices ? { choices } : {}),
    });
  };

  function walk(list: readonly SnippetNode[]): void {
    for (const node of list) {
      switch (node.type) {
        case 'text':
          emit(node.value);
          break;
        case 'tabstop': {
          const offset = text.length;
          // A transform on a plain tabstop applies to the mirrored value, so it only has
          // an effect on the second and later occurrences.
          const mirrored = resolvedByIndex.get(node.index) ?? '';
          const value =
            node.transform !== undefined
              ? applySnippetTransform(node.transform, mirrored)
              : mirrored;
          emit(value);
          record(node.index, offset, value);
          break;
        }
        case 'placeholder': {
          const offset = text.length;
          if (resolvedByIndex.has(node.index)) {
            const value = resolvedByIndex.get(node.index) as string;
            emit(value);
            tabstops.push({
              index: node.index,
              offset,
              length: value.length,
              value,
              primary: false,
            });
            break;
          }
          const value = renderNodes(node.children);
          record(node.index, offset, value);
          break;
        }
        case 'choice': {
          const offset = text.length;
          const value = node.options[0] ?? '';
          emit(value);
          record(node.index, offset, value, [...node.options]);
          break;
        }
        case 'variable': {
          const resolved = variables[node.name];
          if (resolved !== undefined) {
            emit(
              node.transform !== undefined
                ? applySnippetTransform(node.transform, resolved)
                : resolved,
            );
            break;
          }
          if (node.children !== undefined && node.children.length > 0) {
            walk(node.children);
            break;
          }
          // Upstream inserts the name of an unknown variable as plain text; an empty
          // insertion would silently swallow a typo like `$TM_FILENAME_BAS`.
          emit(
            node.transform !== undefined ? applySnippetTransform(node.transform, '') : node.name,
          );
          break;
        }
        default:
          break;
      }
    }
  }

  walk(nodes);

  const visitOrder = tabstops
    .filter((stop) => stop.primary)
    .sort((a, b) => {
      if (a.index === 0) return 1;
      if (b.index === 0) return -1;
      return a.index - b.index;
    });
  const final = visitOrder.find((stop) => stop.index === 0);
  const ordered = [...visitOrder, ...tabstops.filter((stop) => !stop.primary)];
  return {
    text,
    tabstops: ordered,
    finalOffset: final !== undefined ? final.offset : text.length,
    errors,
  };
}

/** Parse and evaluate in one step — the entry point for every insertion path (SN-8). */
export function expandSnippet(body: string, context: SnippetEvalContext = {}): EvaluatedSnippet {
  const parsed = parseSnippet(body);
  const evaluated = evaluateSnippet(parsed.nodes, context);
  return { ...evaluated, errors: [...parsed.errors, ...evaluated.errors] };
}

/**
 * A live insertion, as the editor session sees it (SN-7, SN-9).
 *
 * Nested insertions push onto a stack so Escape leaves one level rather than abandoning
 * the outer snippet, and the context keys below are what Tab/Shift+Tab bind against.
 */
export interface SnippetSession {
  /** Visitable indices in order, `0` last. */
  stops: number[];
  /** Position within `stops`; -1 before the first Tab. */
  position: number;
}

export function createSnippetSession(snippet: EvaluatedSnippet): SnippetSession {
  const stops = snippet.tabstops.filter((stop) => stop.primary).map((stop) => stop.index);
  return { stops, position: stops.length > 0 ? 0 : -1 };
}

export interface SnippetContextKeys {
  inSnippetMode: boolean;
  hasNextTabstop: boolean;
  hasPrevTabstop: boolean;
}

/** Context keys for the whole stack: the innermost session decides Tab behaviour. */
export function snippetContextKeys(stack: readonly SnippetSession[]): SnippetContextKeys {
  const active = stack[stack.length - 1];
  if (active === undefined || active.position < 0) {
    return { inSnippetMode: false, hasNextTabstop: false, hasPrevTabstop: false };
  }
  return {
    inSnippetMode: true,
    hasNextTabstop: active.position < active.stops.length - 1,
    hasPrevTabstop: active.position > 0,
  };
}

/**
 * Advance or retreat within a session.
 *
 * Returns null when the move would leave the snippet, which is the signal for the caller
 * to pop the stack — moving past `$0` ends the session rather than wrapping.
 */
export function moveTabstop(session: SnippetSession, direction: 1 | -1): SnippetSession | null {
  const next = session.position + direction;
  if (next < 0 || next >= session.stops.length) return null;
  return { stops: session.stops, position: next };
}
