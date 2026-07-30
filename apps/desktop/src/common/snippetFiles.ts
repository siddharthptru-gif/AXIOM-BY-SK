/**
 * Snippet file normalization (PRD Ch. 29, SN-1, SN-2, SN-5, SN-10).
 *
 * Two on-disk shapes carry snippets. A `contributes.snippets` entry with a `language`
 * points at a per-language file whose entries have no scope; a `.code-snippets` file is
 * multi-language and each entry carries its own comma-separated `scope`. The existing
 * loader in `extensionContributions.ts` reads and JSONC-parses the file — that part is
 * already right and stays there. What was missing is this normalization: `scope`
 * handling, prefix *arrays* (an entry may bind several prefixes, and taking only the first
 * loses the rest), and per-entry error isolation.
 *
 * SN-10 is the reason every field is validated individually: one malformed entry in a
 * 300-snippet file must cost that entry, not the file.
 *
 * Pure: the caller supplies already-parsed JSON.
 */

/** Entries beyond this are a generated file, not an authored snippet set. */
const MAX_SNIPPET_ENTRIES = 2_000;
const MAX_PREFIX_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_BODY_LENGTH = 32 * 1024;

export interface SnippetFileEntry {
  /** The key in the snippet file, used as a display name and as a fallback prefix. */
  name: string;
  /** Every prefix that triggers this snippet. */
  prefixes: string[];
  body: string;
  description: string | null;
  /**
   * Language ids this entry applies to. Empty means "all languages", which is what a
   * `.code-snippets` entry with no `scope` means.
   */
  scopes: string[];
}

export interface SnippetFileParse {
  entries: SnippetFileEntry[];
  /** Per-entry complaints, for the extension's log channel. */
  errors: string[];
}

export interface SnippetFileOptions {
  /**
   * The language from the `contributes.snippets` entry. Applied to entries that declare
   * no `scope` of their own, so a per-language file keeps its language.
   */
  defaultLanguage?: string | undefined;
}

function normalizeBody(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const lines = raw.filter((line): line is string => typeof line === 'string');
    if (lines.length !== raw.length) return null;
    return lines.join('\n');
  }
  return null;
}

function normalizePrefixes(raw: unknown, fallback: string): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().slice(0, MAX_PREFIX_LENGTH);
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  };
  if (Array.isArray(raw)) for (const value of raw.slice(0, 32)) add(value);
  else add(raw);
  if (out.length === 0) add(fallback);
  return out;
}

function normalizeScopes(raw: unknown, fallback: string | undefined): string[] {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
      .slice(0, 32);
  }
  return fallback !== undefined && fallback.length > 0 ? [fallback] : [];
}

/**
 * Normalize one parsed snippet file.
 *
 * The return type is deliberately not a map keyed by prefix: two snippets may share a
 * prefix (upstream shows both), and collapsing them would silently drop one.
 */
export function normalizeSnippetFile(
  raw: unknown,
  options: SnippetFileOptions = {},
): SnippetFileParse {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: [], errors: ['Snippet file is not a JSON object.'] };
  }
  const entries: SnippetFileEntry[] = [];
  const record = raw as Record<string, unknown>;
  for (const [name, rawEntry] of Object.entries(record).slice(0, MAX_SNIPPET_ENTRIES)) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      errors.push(`Snippet "${name}" is not an object; skipped.`);
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const body = normalizeBody(entry.body);
    if (body === null) {
      errors.push(`Snippet "${name}" has no usable body; skipped.`);
      continue;
    }
    if (body.length === 0 || body.length > MAX_BODY_LENGTH) {
      errors.push(`Snippet "${name}" body is empty or too large; skipped.`);
      continue;
    }
    entries.push({
      name,
      prefixes: normalizePrefixes(entry.prefix, name),
      body,
      description:
        typeof entry.description === 'string'
          ? entry.description.slice(0, MAX_DESCRIPTION_LENGTH)
          : Array.isArray(entry.description) && typeof entry.description[0] === 'string'
            ? (entry.description[0] as string).slice(0, MAX_DESCRIPTION_LENGTH)
            : null,
      scopes: normalizeScopes(entry.scope, options.defaultLanguage),
    });
  }
  return { entries, errors };
}

/** The entries that apply to a language; an empty scope list applies everywhere. */
export function snippetsForLanguage(
  entries: readonly SnippetFileEntry[],
  languageId: string,
): SnippetFileEntry[] {
  return entries.filter((entry) => entry.scopes.length === 0 || entry.scopes.includes(languageId));
}

/** `editor.snippetSuggestions` (SN-5). */
export type SnippetSuggestionMode = 'top' | 'bottom' | 'inline' | 'none';

/**
 * Merge snippet completions into a completion list per the user's setting.
 *
 * `inline` keeps the provider's own ordering, which is why the two lists are concatenated
 * rather than re-sorted: re-sorting would discard the language server's ranking, and that
 * ranking is usually better than anything a lexical comparison could produce.
 */
export function orderSnippetSuggestions<T>(
  others: readonly T[],
  snippets: readonly T[],
  mode: SnippetSuggestionMode = 'inline',
): T[] {
  switch (mode) {
    case 'none':
      return [...others];
    case 'top':
      return [...snippets, ...others];
    case 'bottom':
      return [...others, ...snippets];
    default:
      return [...others, ...snippets];
  }
}
