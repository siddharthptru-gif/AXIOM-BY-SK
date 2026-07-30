/**
 * TextMate snippet engine — parser (PRD Ch. 29, SN-3 … SN-12).
 *
 * Snippets arrive from three different places — `contributes.snippets` files, LSP
 * completions with `insertTextFormat: Snippet`, and `SnippetString` passed to
 * `insertSnippet` — and SN-8/SN-12 require all three to go through one engine. A second,
 * simpler parser for "just the tabstops" is how editors end up inserting literal
 * `${1:name}` text into a user's file, so the whole grammar is implemented here once:
 * tabstops, placeholders, choices, variables with defaults, and regex transforms.
 *
 * Parse failures never throw. SN-10 requires a broken snippet to be reported and skipped
 * without invalidating its file, so an unparseable construct degrades to the literal text
 * that produced it — the worst case is a snippet that inserts what the author typed.
 *
 * Pure: no I/O, no clock, no randomness. Variable values are supplied by the caller (see
 * `snippetVariables.ts`) so insertion is deterministic and testable.
 */

/** Snippet bodies longer than this are pathological rather than authored. */
export const MAX_SNIPPET_LENGTH = 32 * 1024;

export interface FormatText {
  type: 'text';
  value: string;
}

/** A `$n` / `${n:...}` reference inside a transform's replacement string. */
export interface FormatGroup {
  type: 'group';
  index: number;
  /** `${1:/upcase}` and friends. */
  shorthand?: 'upcase' | 'downcase' | 'capitalize' | 'camelcase' | 'pascalcase';
  /** `${1:+value}` — used when the group matched. */
  ifValue?: string;
  /** `${1:-value}` / `${1:value}` — used when the group did not match. */
  elseValue?: string;
}

export type FormatNode = FormatText | FormatGroup;

export interface SnippetTransform {
  pattern: string;
  flags: string;
  format: FormatNode[];
}

export type SnippetNode =
  | { type: 'text'; value: string }
  | { type: 'tabstop'; index: number; transform?: SnippetTransform }
  | { type: 'placeholder'; index: number; children: SnippetNode[] }
  | { type: 'choice'; index: number; options: string[] }
  | { type: 'variable'; name: string; children?: SnippetNode[]; transform?: SnippetTransform };

export interface ParsedSnippet {
  nodes: SnippetNode[];
  /** Non-fatal complaints, for the per-snippet log SN-10 asks for. */
  errors: string[];
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Scanner {
  public index = 0;
  public readonly errors: string[] = [];

  constructor(public readonly source: string) {}

  peek(offset = 0): string {
    return this.source[this.index + offset] ?? '';
  }

  eat(text: string): boolean {
    if (this.source.startsWith(text, this.index)) {
      this.index += text.length;
      return true;
    }
    return false;
  }
}

/** Read an integer at the cursor, or null when there is none. */
function readInteger(scanner: Scanner): number | null {
  const start = scanner.index;
  while (scanner.peek() >= '0' && scanner.peek() <= '9') scanner.index += 1;
  if (scanner.index === start) return null;
  return Number.parseInt(scanner.source.slice(start, scanner.index), 10);
}

function readName(scanner: Scanner): string | null {
  const start = scanner.index;
  while (/[A-Za-z0-9_]/.test(scanner.peek())) scanner.index += 1;
  if (scanner.index === start) return null;
  const name = scanner.source.slice(start, scanner.index);
  return VARIABLE_NAME.test(name) ? name : null;
}

/**
 * Parse the replacement half of a transform.
 *
 * The `${n:...}` forms differ only in their first character, and getting them wrong is
 * silently destructive — `${1:+x}` (when matched) versus `${1:-x}` (when not) invert each
 * other — so each prefix is handled explicitly rather than by falling through.
 */
function parseFormat(scanner: Scanner, terminator: string): FormatNode[] {
  const nodes: FormatNode[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) {
      nodes.push({ type: 'text', value: literal });
      literal = '';
    }
  };
  while (scanner.index < scanner.source.length && scanner.peek() !== terminator) {
    if (scanner.peek() === '\\') {
      const next = scanner.peek(1);
      // The case modifiers are part of the *format* grammar, not the snippet grammar, so
      // their backslash survives parsing and is interpreted at expansion time. Any other
      // escape (`\/`, `\$`, `\}`) is consumed here.
      if ('ulULEnt'.includes(next) && next.length === 1) {
        literal += `\\${next}`;
      } else {
        literal += next;
      }
      scanner.index += 2;
      continue;
    }
    if (scanner.peek() === '$') {
      const save = scanner.index;
      scanner.index += 1;
      if (scanner.peek() === '{') {
        scanner.index += 1;
        const index = readInteger(scanner);
        if (index === null) {
          scanner.index = save;
          literal += '$';
          scanner.index += 1;
          continue;
        }
        if (scanner.eat('}')) {
          flush();
          nodes.push({ type: 'group', index });
          continue;
        }
        if (scanner.eat(':')) {
          const group = parseFormatModifier(scanner, index);
          if (group === null) {
            scanner.index = save;
            literal += '$';
            scanner.index += 1;
            continue;
          }
          flush();
          nodes.push(group);
          continue;
        }
        scanner.index = save;
        literal += '$';
        scanner.index += 1;
        continue;
      }
      const index = readInteger(scanner);
      if (index === null) {
        literal += '$';
        continue;
      }
      flush();
      nodes.push({ type: 'group', index });
      continue;
    }
    literal += scanner.peek();
    scanner.index += 1;
  }
  flush();
  return nodes;
}

/** The part after `${n:` inside a format string. */
function parseFormatModifier(scanner: Scanner, index: number): FormatGroup | null {
  const readUntilBrace = (): string => {
    let value = '';
    while (scanner.index < scanner.source.length && scanner.peek() !== '}') {
      if (scanner.peek() === '\\') {
        value += scanner.peek(1);
        scanner.index += 2;
        continue;
      }
      value += scanner.peek();
      scanner.index += 1;
    }
    return value;
  };
  if (scanner.eat('/')) {
    const name = readName(scanner);
    if (name === null || !scanner.eat('}')) return null;
    const shorthand = name.toLowerCase();
    if (
      shorthand !== 'upcase' &&
      shorthand !== 'downcase' &&
      shorthand !== 'capitalize' &&
      shorthand !== 'camelcase' &&
      shorthand !== 'pascalcase'
    ) {
      return null;
    }
    return { type: 'group', index, shorthand };
  }
  if (scanner.eat('+')) {
    const ifValue = readUntilBrace();
    return scanner.eat('}') ? { type: 'group', index, ifValue } : null;
  }
  if (scanner.eat('?')) {
    let ifValue = '';
    while (
      scanner.index < scanner.source.length &&
      scanner.peek() !== ':' &&
      scanner.peek() !== '}'
    ) {
      if (scanner.peek() === '\\') {
        ifValue += scanner.peek(1);
        scanner.index += 2;
        continue;
      }
      ifValue += scanner.peek();
      scanner.index += 1;
    }
    if (!scanner.eat(':')) return null;
    const elseValue = readUntilBrace();
    return scanner.eat('}') ? { type: 'group', index, ifValue, elseValue } : null;
  }
  scanner.eat('-');
  const elseValue = readUntilBrace();
  return scanner.eat('}') ? { type: 'group', index, elseValue } : null;
}

/** Parse `/regex/format/flags`, positioned on the opening slash. */
function parseTransform(scanner: Scanner): SnippetTransform | null {
  if (!scanner.eat('/')) return null;
  let pattern = '';
  while (scanner.index < scanner.source.length && scanner.peek() !== '/') {
    if (scanner.peek() === '\\' && scanner.peek(1) === '/') {
      pattern += '/';
      scanner.index += 2;
      continue;
    }
    if (scanner.peek() === '\\') {
      pattern += scanner.peek() + scanner.peek(1);
      scanner.index += 2;
      continue;
    }
    pattern += scanner.peek();
    scanner.index += 1;
  }
  if (!scanner.eat('/')) return null;
  const format = parseFormat(scanner, '/');
  if (!scanner.eat('/')) return null;
  let flags = '';
  while (/[gimsuy]/.test(scanner.peek())) {
    flags += scanner.peek();
    scanner.index += 1;
  }
  if (!scanner.eat('}')) return null;
  return { pattern, flags, format };
}
/**
 * Parse a node list. `stopAtBrace` is set while inside `${...}`, where an unescaped `}`
 * closes the construct instead of being literal text.
 */
function parseNodes(scanner: Scanner, stopAtBrace: boolean): SnippetNode[] {
  const nodes: SnippetNode[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) {
      nodes.push({ type: 'text', value: literal });
      literal = '';
    }
  };
  while (scanner.index < scanner.source.length) {
    const character = scanner.peek();
    if (character === '}' && stopAtBrace) break;
    if (character === '\\') {
      const next = scanner.peek(1);
      // Only the three documented escapes are escapes; everything else keeps its
      // backslash, because snippet bodies are full of Windows paths and regex literals.
      if (next === '$' || next === '}' || next === '\\') {
        literal += next;
        scanner.index += 2;
      } else {
        literal += character;
        scanner.index += 1;
      }
      continue;
    }
    if (character === '$') {
      const parsed = parseDollar(scanner);
      if (parsed === null) {
        literal += '$';
        scanner.index += 1;
        continue;
      }
      flush();
      nodes.push(parsed);
      continue;
    }
    literal += character;
    scanner.index += 1;
  }
  flush();
  return nodes;
}

/** Parse one `$…` construct, or return null to fall back to literal text. */
function parseDollar(scanner: Scanner): SnippetNode | null {
  const start = scanner.index;
  scanner.index += 1; // consume '$'
  if (!scanner.eat('{')) {
    const index = readInteger(scanner);
    if (index !== null) return { type: 'tabstop', index };
    const name = readName(scanner);
    if (name !== null) return { type: 'variable', name };
    scanner.index = start;
    return null;
  }

  const index = readInteger(scanner);
  if (index !== null) {
    if (scanner.eat('}')) return { type: 'tabstop', index };
    if (scanner.eat(':')) {
      const children = parseNodes(scanner, true);
      if (!scanner.eat('}')) {
        scanner.errors.push(`Unterminated placeholder \${${index}:…}`);
        scanner.index = start;
        return null;
      }
      return { type: 'placeholder', index, children };
    }
    if (scanner.peek() === '|') {
      const choice = parseChoice(scanner, index);
      if (choice !== null) return choice;
      scanner.errors.push(`Unterminated choice \${${index}|…|}`);
      scanner.index = start;
      return null;
    }
    if (scanner.peek() === '/') {
      const transform = parseTransform(scanner);
      if (transform !== null) return { type: 'tabstop', index, transform };
      scanner.errors.push(`Invalid transform on \${${index}}`);
      scanner.index = start;
      return null;
    }
    scanner.errors.push(`Invalid tabstop \${${index}…}`);
    scanner.index = start;
    return null;
  }

  const name = readName(scanner);
  if (name === null) {
    scanner.index = start;
    return null;
  }
  if (scanner.eat('}')) return { type: 'variable', name };
  if (scanner.eat(':')) {
    const children = parseNodes(scanner, true);
    if (!scanner.eat('}')) {
      scanner.errors.push(`Unterminated variable \${${name}:…}`);
      scanner.index = start;
      return null;
    }
    return { type: 'variable', name, children };
  }
  if (scanner.peek() === '/') {
    const transform = parseTransform(scanner);
    if (transform !== null) return { type: 'variable', name, transform };
    scanner.errors.push(`Invalid transform on \${${name}}`);
    scanner.index = start;
    return null;
  }
  scanner.errors.push(`Invalid variable \${${name}…}`);
  scanner.index = start;
  return null;
}

/** Parse `|a,b,c|}` for a choice tabstop; the cursor sits on the first `|`. */
function parseChoice(scanner: Scanner, index: number): SnippetNode | null {
  scanner.index += 1; // consume '|'
  const options: string[] = [];
  let current = '';
  while (scanner.index < scanner.source.length) {
    const character = scanner.peek();
    if (character === '\\') {
      current += scanner.peek(1);
      scanner.index += 2;
      continue;
    }
    if (character === ',') {
      options.push(current);
      current = '';
      scanner.index += 1;
      continue;
    }
    if (character === '|') {
      scanner.index += 1;
      if (!scanner.eat('}')) return null;
      options.push(current);
      return { type: 'choice', index, options };
    }
    current += character;
    scanner.index += 1;
  }
  return null;
}

/**
 * Parse a snippet body.
 *
 * Always returns a node list: an oversized body becomes a single text node so a
 * misbehaving contribution cannot stall insertion, and every recovered construct is
 * recorded in `errors` for the per-snippet log.
 */
export function parseSnippet(body: string): ParsedSnippet {
  if (typeof body !== 'string') return { nodes: [], errors: ['Snippet body is not a string.'] };
  if (body.length > MAX_SNIPPET_LENGTH) {
    return {
      nodes: [{ type: 'text', value: body.slice(0, MAX_SNIPPET_LENGTH) }],
      errors: [`Snippet body exceeds ${MAX_SNIPPET_LENGTH} characters; inserted as plain text.`],
    };
  }
  const scanner = new Scanner(body);
  const nodes = parseNodes(scanner, false);
  return { nodes, errors: scanner.errors };
}

/** The tabstop indices a parsed snippet defines, ascending, with `$0` reported as 0. */
export function snippetTabstopIndices(nodes: readonly SnippetNode[]): number[] {
  const found = new Set<number>();
  const walk = (list: readonly SnippetNode[]): void => {
    for (const node of list) {
      if (node.type === 'tabstop' || node.type === 'placeholder' || node.type === 'choice') {
        found.add(node.index);
      }
      if (node.type === 'placeholder') walk(node.children);
      if (node.type === 'variable' && node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return [...found].sort((a, b) => a - b);
}
