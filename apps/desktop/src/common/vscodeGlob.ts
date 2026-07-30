/**
 * VS Code glob semantics (PRD Ch. 26 LSP-2, Ch. 31 CE-5, Ch. 41 LA-4).
 *
 * Document selectors, file-system watchers, custom-editor `filenamePattern`s, and
 * `workspaceContains:` activation all compare paths against globs written by extension
 * authors against VS Code's matcher. AXIOM already had a small glob helper for workflow
 * triggers, but it understands neither brace expansion (`**\/*.{ts,tsx}`) nor character
 * classes, and those two forms appear in a large share of real manifests — a selector
 * that silently fails to match routes a language request to no provider at all, which
 * looks to the user like the extension is broken rather than like AXIOM is.
 *
 * So this is a separate, complete matcher rather than an extension of that helper:
 * changing the workflow matcher's behaviour would alter an unrelated shipped feature,
 * and the two have different compatibility obligations.
 *
 * Supported grammar, matching upstream:
 *   `*`      — any run of characters within one path segment
 *   `?`      — exactly one character within one path segment
 *   `**`     — any number of segments, including none (`a/**\/b` matches `a/b`)
 *   `{a,b}`  — alternation, nestable
 *   `[abc]`  — a character class, with `!`/`^` negation and `a-z` ranges
 *
 * Pure: no I/O. Paths are normalized to forward slashes before matching, so a Windows
 * path and its POSIX spelling match the same pattern.
 */

/** Longer patterns are pathological rather than authored; refuse instead of compiling. */
const MAX_PATTERN_LENGTH = 1_024;
/** A compiled-pattern cache: selectors are re-scored on every keystroke. */
const compiled = new Map<string, RegExp | null>();
const MAX_CACHE_ENTRIES = 2_000;

/** Normalize a path for matching: forward slashes, no leading `./`. */
export function normalizeGlobPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeLiteral(character: string): string {
  return '.+^$(){}|[]\\/'.includes(character) ? `\\${character}` : character;
}

/**
 * Translate one glob into an anchored regular expression source.
 *
 * Returns null for a pattern this grammar does not cover (an unclosed brace or class),
 * so the caller reports "did not match" rather than throwing inside a hot path.
 */
function translate(pattern: string): string | null {
  let source = '';
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        // `**/` may consume nothing at all, which is why the slash is part of the group
        // rather than a separate token: `src/**/*.ts` has to match `src/a.ts`.
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]*(?:/|$))*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      source += '(?:';
      continue;
    }
    if (character === '}') {
      if (braceDepth === 0) return null;
      braceDepth -= 1;
      source += ')';
      continue;
    }
    if (character === ',' && braceDepth > 0) {
      source += '|';
      continue;
    }
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close < 0) return null;
      let body = pattern.slice(index + 1, close);
      if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`;
      // A class may not span segments; forward slashes inside one are dropped so the
      // pattern cannot accidentally become path-crossing.
      source += `[${body.replaceAll('/', '').replaceAll('\\', '\\\\')}]`;
      index = close;
      continue;
    }
    source += escapeLiteral(character);
  }
  return braceDepth === 0 ? source : null;
}

/** Compile a glob, memoized. Null means the pattern is not expressible here. */
export function compileGlob(pattern: string): RegExp | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const source = translate(normalizeGlobPath(pattern));
  let expression: RegExp | null = null;
  if (source !== null) {
    try {
      expression = new RegExp(`^${source}$`);
    } catch {
      expression = null;
    }
  }
  if (compiled.size >= MAX_CACHE_ENTRIES) compiled.clear();
  compiled.set(pattern, expression);
  return expression;
}

/**
 * Does a path match a glob?
 *
 * A pattern with no slash matches on the basename as well as the full path, which is the
 * behaviour authors rely on when they write `package.json` or `*.ts` and expect it to
 * match at any depth.
 */
export function matchesVsCodeGlob(pattern: string, path: string): boolean {
  const expression = compileGlob(pattern);
  if (expression === null) return false;
  const normalized = normalizeGlobPath(path);
  if (expression.test(normalized)) return true;
  if (!pattern.includes('/')) {
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return expression.test(basename);
  }
  return false;
}

/**
 * Match a `RelativePattern`: a base directory plus a pattern relative to it. A path
 * outside the base never matches, which is what makes per-folder watchers correct in a
 * multi-root workspace.
 */
export function matchesRelativePattern(base: string, pattern: string, path: string): boolean {
  const normalizedBase = normalizeGlobPath(base).replace(/\/$/, '');
  const normalizedPath = normalizeGlobPath(path);
  if (normalizedBase.length > 0) {
    if (!normalizedPath.startsWith(`${normalizedBase}/`)) return false;
    return matchesVsCodeGlob(pattern, normalizedPath.slice(normalizedBase.length + 1));
  }
  return matchesVsCodeGlob(pattern, normalizedPath);
}
