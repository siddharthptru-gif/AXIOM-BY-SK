/**
 * Context-key expressions (`when` clauses).
 *
 * Every declarative contribution point in VS Code gates on a `when` string — keybindings
 * (Ch. 25), menus, views, custom editors. AXIOM had no evaluator for them, so a `when`
 * could only be displayed, never honoured. This module parses one into an AST and
 * evaluates it against a plain record of context keys.
 *
 * Two deliberate choices:
 *
 *   1. **Parse once, evaluate many.** Keybinding resolution runs on every keypress and has
 *      a 1 ms budget for a 2,000-entry table (KB-12), so re-parsing a string per keypress
 *      is not an option. `parseContextKeyExpression` is called at registration time.
 *   2. **An unparseable clause is `null`, not `true`.** Treating garbage as "always
 *      applies" would let a typo'd `when` fire a command everywhere; the caller decides,
 *      and the keybinding compiler drops the rule with a logged warning.
 *
 * Pure: no globals, no I/O.
 */

const MAX_EXPRESSION_LENGTH = 1_024;
const MAX_DEPTH = 24;

export type CompareOperator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in';

export type ContextKeyExpression =
  | { kind: 'true' }
  | { kind: 'false' }
  /** A bare key: truthy by JavaScript rules. */
  | { kind: 'has'; key: string }
  | { kind: 'not'; expr: ContextKeyExpression }
  | { kind: 'and'; parts: ContextKeyExpression[] }
  | { kind: 'or'; parts: ContextKeyExpression[] }
  | { kind: 'compare'; key: string; op: CompareOperator; value: string }
  /** `key =~ /pattern/flags`. */
  | { kind: 'match'; key: string; pattern: string; flags: string };

interface Cursor {
  readonly text: string;
  index: number;
}

const KEY_RE = /[A-Za-z_$][A-Za-z0-9_$.:\-[\]]*/;

function skipSpace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index] as string)) {
    cursor.index += 1;
  }
}

function eat(cursor: Cursor, token: string): boolean {
  if (cursor.text.startsWith(token, cursor.index)) {
    cursor.index += token.length;
    return true;
  }
  return false;
}

function readKey(cursor: Cursor): string | null {
  const rest = cursor.text.slice(cursor.index);
  const match = KEY_RE.exec(rest);
  if (match === null || match.index !== 0) return null;
  cursor.index += match[0].length;
  return match[0];
}

/** A quoted string, or a bare token up to the next operator/whitespace/paren. */
function readValue(cursor: Cursor): string | null {
  skipSpace(cursor);
  const quote = cursor.text[cursor.index];
  if (quote === "'" || quote === '"') {
    const end = cursor.text.indexOf(quote, cursor.index + 1);
    if (end < 0) return null;
    const value = cursor.text.slice(cursor.index + 1, end);
    cursor.index = end + 1;
    return value;
  }
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] as string;
    if (/\s/.test(char) || char === ')' || char === '&' || char === '|') break;
    cursor.index += 1;
  }
  return cursor.index > start ? cursor.text.slice(start, cursor.index) : null;
}

/** `/pattern/flags`, the right-hand side of `=~`. */
function readRegex(cursor: Cursor): { pattern: string; flags: string } | null {
  skipSpace(cursor);
  if (cursor.text[cursor.index] !== '/') return null;
  let index = cursor.index + 1;
  let pattern = '';
  while (index < cursor.text.length) {
    const char = cursor.text[index] as string;
    if (char === '\\') {
      pattern += char + (cursor.text[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '/') break;
    pattern += char;
    index += 1;
  }
  if (cursor.text[index] !== '/') return null;
  index += 1;
  let flags = '';
  while (index < cursor.text.length && /[gimsuy]/.test(cursor.text[index] as string)) {
    flags += cursor.text[index] as string;
    index += 1;
  }
  cursor.index = index;
  return { pattern, flags };
}

/** Longest first, so `==` is not read as `=` and `!==` is not read as `!=`. */
const OPERATORS: CompareOperator[] = ['>=', '<=', '!=', '==', '>', '<'];

function parsePrimary(cursor: Cursor, depth: number): ContextKeyExpression | null {
  skipSpace(cursor);
  if (eat(cursor, '(')) {
    const inner = parseOr(cursor, depth + 1);
    skipSpace(cursor);
    if (inner === null || !eat(cursor, ')')) return null;
    return inner;
  }
  if (eat(cursor, '!')) {
    // `!=` cannot start a primary, so a bare `!` here is negation.
    const operand = parsePrimary(cursor, depth + 1);
    return operand === null ? null : { kind: 'not', expr: operand };
  }
  const key = readKey(cursor);
  if (key === null) return null;
  if (key === 'true') return { kind: 'true' };
  if (key === 'false') return { kind: 'false' };

  const before = cursor.index;
  skipSpace(cursor);
  if (eat(cursor, '=~')) {
    const regex = readRegex(cursor);
    if (regex !== null) return { kind: 'match', key, pattern: regex.pattern, flags: regex.flags };
    // A non-regex right-hand side is not a comparison this evaluator can honour.
    return null;
  }
  for (const op of OPERATORS) {
    if (!eat(cursor, op)) continue;
    // `===` and `!==` are accepted spellings of `==` and `!=`.
    eat(cursor, '=');
    const value = readValue(cursor);
    return value === null ? null : { kind: 'compare', key, op, value };
  }
  if (eat(cursor, 'not in') || eat(cursor, 'in')) {
    const negated = cursor.text.slice(before, cursor.index).includes('not');
    const value = readValue(cursor);
    if (value === null) return null;
    return { kind: 'compare', key, op: negated ? 'not in' : 'in', value };
  }
  cursor.index = before;
  return { kind: 'has', key };
}

function parseAnd(cursor: Cursor, depth: number): ContextKeyExpression | null {
  if (depth > MAX_DEPTH) return null;
  const parts: ContextKeyExpression[] = [];
  for (;;) {
    const part = parsePrimary(cursor, depth);
    if (part === null) return null;
    parts.push(part);
    skipSpace(cursor);
    if (!eat(cursor, '&&')) break;
  }
  return parts.length === 1 ? (parts[0] as ContextKeyExpression) : { kind: 'and', parts };
}

function parseOr(cursor: Cursor, depth: number): ContextKeyExpression | null {
  if (depth > MAX_DEPTH) return null;
  const parts: ContextKeyExpression[] = [];
  for (;;) {
    const part = parseAnd(cursor, depth);
    if (part === null) return null;
    parts.push(part);
    skipSpace(cursor);
    if (!eat(cursor, '||')) break;
  }
  return parts.length === 1 ? (parts[0] as ContextKeyExpression) : { kind: 'or', parts };
}

/**
 * Parse a `when` clause. Returns `null` when the clause is malformed or over the length
 * cap; an empty or whitespace-only clause is `{ kind: 'true' }`, matching upstream's
 * "no `when` means always".
 */
export function parseContextKeyExpression(
  source: string | null | undefined,
): ContextKeyExpression | null {
  if (source === null || source === undefined) return { kind: 'true' };
  if (source.length > MAX_EXPRESSION_LENGTH) return null;
  const trimmed = source.trim();
  if (trimmed.length === 0) return { kind: 'true' };
  const cursor: Cursor = { text: trimmed, index: 0 };
  const expr = parseOr(cursor, 0);
  if (expr === null) return null;
  skipSpace(cursor);
  // Trailing junk means the clause was not understood in full; reject rather than guess.
  return cursor.index === trimmed.length ? expr : null;
}

export type ContextKeyValues = Readonly<Record<string, unknown>>;

/** Upstream compares loosely: a context value of `1` satisfies `== '1'`. */
function looseEquals(actual: unknown, expected: string): boolean {
  if (actual === undefined || actual === null)
    return expected === 'undefined' || expected === 'null';
  if (typeof actual === 'boolean') return String(actual) === expected;
  if (typeof actual === 'number') return String(actual) === expected;
  if (typeof actual === 'string') return actual === expected;
  return false;
}

function numeric(actual: unknown, expected: string): [number, number] | null {
  const left = typeof actual === 'number' ? actual : Number(actual);
  const right = Number(expected);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return [left, right];
}

function isIn(actual: unknown, collection: unknown): boolean {
  if (Array.isArray(collection)) return collection.some((item) => item === actual);
  if (collection !== null && typeof collection === 'object') {
    return Object.prototype.hasOwnProperty.call(collection, String(actual));
  }
  if (typeof collection === 'string') return collection.split(',').includes(String(actual));
  return false;
}

/** Evaluate a parsed clause. Unknown keys are `undefined`, which is falsy. */
export function evaluateContextKey(
  expr: ContextKeyExpression | null | undefined,
  context: ContextKeyValues = {},
): boolean {
  if (expr === null || expr === undefined) return false;
  switch (expr.kind) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'has':
      return Boolean(context[expr.key]);
    case 'not':
      return !evaluateContextKey(expr.expr, context);
    case 'and':
      return expr.parts.every((part) => evaluateContextKey(part, context));
    case 'or':
      return expr.parts.some((part) => evaluateContextKey(part, context));
    case 'match': {
      let regex: RegExp;
      try {
        regex = new RegExp(expr.pattern, expr.flags);
      } catch {
        return false;
      }
      const value = context[expr.key];
      return typeof value === 'string' ? regex.test(value) : false;
    }
    default: {
      const actual = context[expr.key];
      switch (expr.op) {
        case '==':
          return looseEquals(actual, expr.value);
        case '!=':
          return !looseEquals(actual, expr.value);
        case 'in':
          return isIn(actual, context[expr.value] ?? expr.value);
        case 'not in':
          return !isIn(actual, context[expr.value] ?? expr.value);
        default: {
          const pair = numeric(actual, expr.value);
          if (pair === null) return false;
          const [left, right] = pair;
          if (expr.op === '>') return left > right;
          if (expr.op === '>=') return left >= right;
          if (expr.op === '<') return left < right;
          return left <= right;
        }
      }
    }
  }
}

/** Keys a clause reads, for the troubleshooting log and for change-driven re-evaluation. */
export function contextKeysUsed(expr: ContextKeyExpression | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (node: ContextKeyExpression | null | undefined): void => {
    if (node === null || node === undefined) return;
    switch (node.kind) {
      case 'has':
      case 'match':
      case 'compare':
        out.add(node.key);
        return;
      case 'not':
        walk(node.expr);
        return;
      case 'and':
      case 'or':
        for (const part of node.parts) walk(part);
        return;
      default:
        return;
    }
  };
  walk(expr);
  return [...out].sort();
}
