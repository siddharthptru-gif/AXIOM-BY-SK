/**
 * Document selector scoring and provider merging (PRD Ch. 26 — LSP-2, LSP-3, LSP-5).
 *
 * Every language feature an extension registers arrives with a `DocumentSelector`, and
 * the platform has to answer two questions from it: does this provider apply to this
 * document, and when several apply, how are their results combined? Both answers are
 * copied from upstream deliberately. Extension authors tune selectors against VS Code's
 * scoring — a language-only filter is expected to lose to a language+scheme filter — and
 * a formatter that wins a tie it should have lost rewrites the user's file with the wrong
 * tool. So the numeric scores here are the upstream numbers, not an approximation.
 *
 * Pure: no I/O, no registry. The host holds the provider table; this decides ordering.
 */
import { matchesRelativePattern, matchesVsCodeGlob, normalizeGlobPath } from './vscodeGlob';

export interface DocumentFilter {
  language?: string;
  scheme?: string;
  /** A glob, or a `RelativePattern` as it crosses the boundary. */
  pattern?: string | { base: string; pattern: string };
  notebookType?: string;
}

export type DocumentSelector = string | DocumentFilter | ReadonlyArray<string | DocumentFilter>;

/** The document a request is being scored against. */
export interface DocumentCandidate {
  languageId: string;
  scheme: string;
  /** Filesystem path (or the URI path for non-file schemes). */
  path: string;
  notebookType?: string;
}

/** Upstream's scores: 10 for an exact match, 5 for a wildcard, 0 for no match. */
const EXACT = 10;
const WILDCARD = 5;

function scoreFilter(filter: DocumentFilter, document: DocumentCandidate): number {
  let score = 0;
  const { language, scheme, pattern, notebookType } = filter;

  if (scheme !== undefined) {
    if (scheme === document.scheme) score = EXACT;
    else if (scheme === '*') score = Math.max(score, WILDCARD);
    else return 0;
  }
  if (language !== undefined) {
    if (language === document.languageId) score = EXACT;
    else if (language === '*') score = Math.max(score, WILDCARD);
    else return 0;
  }
  if (notebookType !== undefined) {
    if (notebookType === document.notebookType) score = EXACT;
    else if (notebookType === '*' && document.notebookType !== undefined) {
      score = Math.max(score, WILDCARD);
    } else return 0;
  }
  if (pattern !== undefined) {
    const path = normalizeGlobPath(document.path);
    const matched =
      typeof pattern === 'string'
        ? normalizeGlobPath(pattern) === path || matchesVsCodeGlob(pattern, path)
        : matchesRelativePattern(pattern.base, pattern.pattern, path);
    if (!matched) return 0;
    score = EXACT;
  }
  // A filter that constrained nothing (`{}`) is treated as a wildcard rather than as a
  // non-match: it is legal, and upstream lets it apply everywhere at the lowest weight.
  return score === 0 ? WILDCARD : score;
}

/**
 * Score a selector against a document. 0 means "does not apply"; higher is more
 * specific. An array selector scores as its best member, so a provider registered for
 * `['typescript', {language:'typescript', scheme:'file'}]` is as specific as its
 * strongest clause.
 */
export function scoreDocumentSelector(
  selector: DocumentSelector | undefined,
  document: DocumentCandidate,
): number {
  if (selector === undefined || selector === null) return 0;
  if (Array.isArray(selector)) {
    let best = 0;
    for (const entry of selector) {
      const score = scoreDocumentSelector(entry as DocumentSelector, document);
      if (score === EXACT) return EXACT;
      if (score > best) best = score;
    }
    return best;
  }
  if (typeof selector === 'string') {
    if (selector === '*') return WILDCARD;
    return selector === document.languageId ? EXACT : 0;
  }
  if (typeof selector === 'object') return scoreFilter(selector as DocumentFilter, document);
  return 0;
}

/** A registered provider, as the ordering functions see it. */
export interface RegisteredProvider {
  /** Registration handle, unique per provider instance. */
  handle: number;
  extensionId: string;
  selector: DocumentSelector;
  /** Registration order, used to break score ties deterministically. */
  sequence: number;
}

export interface ScoredProvider<T extends RegisteredProvider = RegisteredProvider> {
  provider: T;
  score: number;
}

/**
 * Order the providers that apply to a document, best first.
 *
 * Ties break on registration order (later registration first, matching upstream's
 * "most recently registered wins" for equal scores), which keeps a user-installed
 * override ahead of a bundled default.
 */
export function orderProviders<T extends RegisteredProvider>(
  providers: readonly T[],
  document: DocumentCandidate,
): Array<ScoredProvider<T>> {
  const scored: Array<ScoredProvider<T>> = [];
  for (const provider of providers) {
    const score = scoreDocumentSelector(provider.selector, document);
    if (score > 0) scored.push({ provider, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.provider.sequence - a.provider.sequence);
}

/**
 * How results from several providers combine, per feature (LSP-3).
 *
 *   `merge`  — every applicable provider is asked and the results are combined
 *              (completions, code actions, document links, inlay hints).
 *   `concat` — results are concatenated in provider order (definitions, references).
 *   `stack`  — results render as separate sections in one widget (hover).
 *   `single` — only the highest-scoring provider is used; a tie needs a picker
 *              (formatting, rename, folding — running two would corrupt the buffer).
 */
export type MergeStrategy = 'merge' | 'concat' | 'stack' | 'single';

export const FEATURE_MERGE_STRATEGY: Readonly<Record<string, MergeStrategy>> = {
  completion: 'merge',
  codeAction: 'merge',
  codeLens: 'merge',
  documentLink: 'merge',
  inlayHint: 'merge',
  documentSymbol: 'merge',
  color: 'merge',
  definition: 'concat',
  declaration: 'concat',
  typeDefinition: 'concat',
  implementation: 'concat',
  reference: 'concat',
  documentHighlight: 'concat',
  selectionRange: 'concat',
  hover: 'stack',
  signatureHelp: 'stack',
  formatting: 'single',
  rangeFormatting: 'single',
  onTypeFormatting: 'single',
  rename: 'single',
  foldingRange: 'single',
  semanticTokens: 'single',
  linkedEditingRange: 'single',
  callHierarchy: 'single',
  typeHierarchy: 'single',
  inlineValue: 'merge',
};

export function mergeStrategyFor(feature: string): MergeStrategy {
  return FEATURE_MERGE_STRATEGY[feature] ?? 'merge';
}

export interface ProviderSelection<T extends RegisteredProvider = RegisteredProvider> {
  strategy: MergeStrategy;
  /** Providers to invoke, in invocation order. */
  providers: T[];
  /**
   * True when a `single`-strategy feature had two providers at the same score, so the
   * caller must ask the user instead of silently picking one.
   */
  needsPicker: boolean;
}

/**
 * Choose which providers to invoke for a feature on a document.
 *
 * For `single` features only the top scorer is returned, and an equal-scoring runner-up
 * raises `needsPicker` — VS Code's behaviour for "multiple formatters for this file".
 */
export function selectProviders<T extends RegisteredProvider>(
  feature: string,
  providers: readonly T[],
  document: DocumentCandidate,
): ProviderSelection<T> {
  const strategy = mergeStrategyFor(feature);
  const ordered = orderProviders(providers, document);
  if (ordered.length === 0) return { strategy, providers: [], needsPicker: false };
  if (strategy !== 'single') {
    return { strategy, providers: ordered.map((entry) => entry.provider), needsPicker: false };
  }
  const best = ordered[0] as ScoredProvider<T>;
  const contested = ordered.filter(
    (entry) =>
      entry.score === best.score && entry.provider.extensionId !== best.provider.extensionId,
  );
  return {
    strategy,
    providers: [best.provider],
    needsPicker: contested.length > 0,
  };
}

/**
 * Combine per-provider results, dropping the failures.
 *
 * LSP-5: a provider that threw is excluded from this request's results and never fails
 * the request as a whole — one broken extension must not remove hover from the editor.
 */
export function combineProviderResults<R>(
  results: ReadonlyArray<{ ok: true; value: R[] } | { ok: false; error: string }>,
): { values: R[]; failures: string[] } {
  const values: R[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.ok) values.push(...result.value);
    else failures.push(result.error);
  }
  return { values, failures };
}
