/**
 * Semantic-token encoding, legends and caching (PRD Phase 6).
 *
 * Semantic tokens are the one language feature where the wire format is a bare array of integers
 * whose meaning depends entirely on a legend agreed beforehand: five numbers per token, four of
 * them relative to the token before it, and token type `3` means whatever the provider's legend
 * says it means. Everything in this module exists because that encoding is unforgiving — an
 * off-by-one in a delta line silently recolours the rest of the file, and a legend mismatch
 * recolours all of it.
 *
 * It holds three things: the legend (normalised, and compared by value so a re-registration that
 * changes nothing does not force Monaco to re-tokenise), the encoder behind `SemanticTokensBuilder`
 * (sorting into document order, which upstream's builder also does, because relative encoding is
 * meaningless otherwise), and the per-document cache that makes `resultId` mean something — without
 * a cache a provider's delta has no baseline to be a delta against.
 *
 * Pure: no I/O, no Electron, no Monaco.
 */

/** A legend as it crosses the boundary. */
export interface SemanticTokensLegendData {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export const MAX_TOKEN_TYPES = 256;
export const MAX_TOKEN_MODIFIERS = 64;
/** Tokens one document's result may hold. Five integers each, so this is the real memory bound. */
export const MAX_SEMANTIC_TOKENS = 100_000;
/** Documents whose tokens are kept for delta requests. */
export const MAX_CACHED_DOCUMENTS = 64;

const TOKEN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/**
 * Normalise a `SemanticTokensLegend`.
 *
 * Names are validated rather than merely capped because a legend name becomes a scope the theme
 * resolves against: an entry with a space or a quote in it cannot match anything and would leave
 * that token uncoloured while looking as though it had been registered.
 */
export function normalizeSemanticTokensLegend(value: unknown): SemanticTokensLegendData | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  const tokenTypes = normalizeNames(source.tokenTypes, MAX_TOKEN_TYPES);
  if (tokenTypes.length === 0) return null;
  return { tokenTypes, tokenModifiers: normalizeNames(source.tokenModifiers, MAX_TOKEN_MODIFIERS) };
}

function normalizeNames(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!TOKEN_NAME_RE.test(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Compare two legends by value.
 *
 * Monaco keys its semantic-token state on the legend object, so handing it a fresh-but-identical
 * legend discards every cached result for no gain. Extensions re-register providers on
 * configuration changes far more often than they change their legend, so this comparison is what
 * keeps a settings toggle from re-tokenising every open file.
 */
export function semanticTokensLegendEquals(
  a: SemanticTokensLegendData | undefined,
  b: SemanticTokensLegendData | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameNames(a.tokenTypes, b.tokenTypes) && sameNames(a.tokenModifiers, b.tokenModifiers);
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** A token as the builder receives it, before relative encoding. */
export interface RawSemanticToken {
  line: number;
  character: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

/**
 * Resolve a token type name against a legend.
 *
 * Returns `-1` for an unknown name. Upstream's builder throws in that case only when the builder
 * was constructed with a legend; without one it takes numbers directly. We report the failure and
 * let the caller decide, because a provider that mistypes one scope should lose that one token
 * rather than have its whole result rejected.
 */
export function resolveTokenType(legend: SemanticTokensLegendData, name: string): number {
  return legend.tokenTypes.indexOf(name);
}

/**
 * Fold modifier names into the bitmask the wire format carries.
 *
 * Unknown names are skipped rather than shifting the ones after them, which is the difference
 * between "one modifier was ignored" and "every modifier past it means something else".
 */
export function resolveTokenModifiers(
  legend: SemanticTokensLegendData,
  names: readonly string[],
): number {
  let mask = 0;
  for (const name of names) {
    const index = legend.tokenModifiers.indexOf(name);
    if (index >= 0 && index < 32) mask |= 1 << index;
  }
  return mask;
}

/**
 * Encode raw tokens into the delta-encoded integer array.
 *
 * Five integers per token: `deltaLine`, `deltaStart`, `length`, `tokenType`, `tokenModifiers`.
 * `deltaLine` is relative to the previous token's line; `deltaStart` is relative to the previous
 * token's start column *when they share a line* and absolute otherwise. That conditional is the
 * whole subtlety of the format.
 *
 * The sort is stable and by position, matching upstream's builder: a provider that walks an AST
 * out of order (a common shape — visit declarations, then references) would otherwise emit negative
 * deltas, which the consumer cannot represent. Non-finite or negative fields drop the token rather
 * than poisoning every token after it.
 */
export function encodeSemanticTokens(tokens: readonly RawSemanticToken[]): number[] {
  const valid: RawSemanticToken[] = [];
  for (const token of tokens) {
    if (!isEncodableToken(token)) continue;
    valid.push(token);
    if (valid.length >= MAX_SEMANTIC_TOKENS) break;
  }
  valid.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.character - b.character));

  const data: number[] = [];
  let lastLine = 0;
  let lastCharacter = 0;
  for (const token of valid) {
    const deltaLine = token.line - lastLine;
    const deltaStart = deltaLine === 0 ? token.character - lastCharacter : token.character;
    data.push(deltaLine, deltaStart, token.length, token.tokenType, token.tokenModifiers);
    lastLine = token.line;
    lastCharacter = token.character;
  }
  return data;
}

function isEncodableToken(token: RawSemanticToken | undefined): token is RawSemanticToken {
  if (!token) return false;
  return (
    isIndex(token.line) &&
    isIndex(token.character) &&
    isIndex(token.length) &&
    isIndex(token.tokenType) &&
    isIndex(token.tokenModifiers) &&
    token.length > 0
  );
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an already-encoded token array arriving from an extension.
 *
 * The length must be a multiple of five and every entry a non-negative integer; a `Uint32Array` is
 * accepted as-is because that is what `SemanticTokensBuilder.build()` produces. A ragged array is
 * rejected outright instead of truncated: the trailing partial token would be read as the first
 * fields of a token that does not exist, and the consumer's own decoder would then be one field out
 * of phase for the remainder of the buffer.
 */
export function normalizeSemanticTokensData(value: unknown): number[] | null {
  if (value instanceof Uint32Array) {
    if (value.length % 5 !== 0 || value.length > MAX_SEMANTIC_TOKENS * 5) return null;
    return Array.from(value);
  }
  if (!Array.isArray(value)) return null;
  if (value.length % 5 !== 0 || value.length > MAX_SEMANTIC_TOKENS * 5) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (!isIndex(entry)) return null;
    out.push(entry);
  }
  return out;
}

/** One contiguous replacement inside the encoded array, as Monaco and LSP both express deltas. */
export interface SemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: number[];
}

/**
 * Validate edits from a `provideDocumentSemanticTokensEdits` result.
 *
 * Every offset here indexes the *encoded integer array*, not tokens, and the edits are expressed
 * against the same baseline (they are not applied in sequence with earlier ones shifting later
 * ones). So they must be sorted and non-overlapping, and each must land inside the baseline —
 * otherwise the consumer either splices at the wrong place or throws.
 */
export function normalizeSemanticTokensEdits(
  value: unknown,
  baselineLength: number,
): SemanticTokensEdit[] | null {
  if (!Array.isArray(value)) return null;
  const out: SemanticTokensEdit[] = [];
  let previousEnd = 0;
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const start = entry.start;
    const deleteCount = entry.deleteCount;
    if (!isIndex(start) || !isIndex(deleteCount)) return null;
    if (start < previousEnd || start + deleteCount > baselineLength) return null;
    const data = entry.data === undefined ? undefined : normalizeEditData(entry.data);
    if (entry.data !== undefined && data === null) return null;
    out.push(data ? { start, deleteCount, data } : { start, deleteCount });
    previousEnd = start + deleteCount;
  }
  return out;
}

/**
 * An edit's payload is *not* constrained to whole tokens.
 *
 * VS Code diffs the integer arrays, not the token list, so a one-character rename produces an edit
 * whose `data` is a single integer in the middle of a token. Requiring a multiple of five here would
 * reject the most common delta there is.
 */
function normalizeEditData(value: unknown): number[] | null {
  if (value instanceof Uint32Array) {
    if (value.length > MAX_SEMANTIC_TOKENS * 5) return null;
    return Array.from(value);
  }
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_TOKENS * 5) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (!isIndex(entry)) return null;
    out.push(entry);
  }
  return out;
}

/**
 * Apply baseline-relative edits, producing a full token array.
 *
 * Applied back to front so that each splice cannot move the offsets of the edits still to come —
 * the alternative is tracking a running shift, which is the same computation with one more place to
 * get it wrong. Returns `null` when the result is not a whole number of tokens, because at that
 * point the provider and its own baseline have diverged and the honest recovery is a full re-request
 * rather than a subtly mis-phased highlight.
 */
export function applySemanticTokensEdits(
  baseline: readonly number[],
  edits: readonly SemanticTokensEdit[],
): number[] | null {
  const data = baseline.slice();
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    if (!edit) continue;
    if (edit.start > data.length || edit.start + edit.deleteCount > data.length) return null;
    data.splice(edit.start, edit.deleteCount, ...(edit.data ?? []));
  }
  if (data.length % 5 !== 0 || data.length > MAX_SEMANTIC_TOKENS * 5) return null;
  return data;
}

/**
 * Diff two encoded arrays into a single edit covering the changed middle.
 *
 * Used when a provider only implements the full-document method but the consumer already holds a
 * previous result: sending 60 integers instead of 60,000 is worth one array scan. A single edit
 * rather than a fine-grained diff is deliberate — because the encoding is relative, an insertion
 * near the top of a file changes the `deltaLine` of the token after it and nothing else, so the
 * changed region is almost always contiguous, and finding several regions costs more than it saves.
 *
 * Returns an empty array when the arrays are identical, which the caller should report as an
 * unchanged result rather than an empty one.
 */
export function computeSemanticTokensDelta(
  previous: readonly number[],
  next: readonly number[],
): SemanticTokensEdit[] {
  const limit = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  if (prefix === previous.length && prefix === next.length) return [];

  let suffix = 0;
  const maxSuffix = limit - prefix;
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const deleteCount = previous.length - prefix - suffix;
  const data = next.slice(prefix, next.length - suffix);
  return data.length === 0 && deleteCount === 0 ? [] : [{ start: prefix, deleteCount, data }];
}

/** One document's cached result. */
export interface SemanticTokensCacheEntry {
  resultId: string;
  documentVersion: number;
  data: number[];
}

/** What a lookup found, and whether it is still usable as a delta baseline. */
export interface SemanticTokensLookup {
  entry: SemanticTokensCacheEntry;
  /** The cached tokens describe the version being asked about. */
  fresh: boolean;
}

/**
 * Per-document, per-provider token cache.
 *
 * `resultId` is the whole point. A provider's delta method is handed the id of the result the
 * consumer still holds, and can only answer with edits if it recognises that id — so the ids must be
 * minted here, be unique for the lifetime of the process, and be forgotten in step with the tokens
 * they name. An id we hand out and then evict must never be honoured again, which is why eviction
 * removes the entry rather than merely marking it stale.
 *
 * Keys are `handle:uri`, not just `uri`: two providers over the same document keep independent
 * baselines, and one provider's eviction must not silently answer for the other.
 */
export class SemanticTokensCache {
  private readonly entries = new Map<string, SemanticTokensCacheEntry>();
  private nextResultId = 1;

  constructor(private readonly maxDocuments: number = MAX_CACHED_DOCUMENTS) {}

  private static key(handle: number, uri: string): string {
    return `${handle}:${uri}`;
  }

  /**
   * Store tokens and mint the id that names them.
   *
   * Re-inserting an existing key deletes first so the `Map` re-orders it to the newest position:
   * insertion order is the eviction order, so without the delete a document touched every keystroke
   * would still be evicted on the schedule of its first appearance.
   */
  store(handle: number, uri: string, documentVersion: number, data: number[]): string {
    const key = SemanticTokensCache.key(handle, uri);
    this.entries.delete(key);
    const resultId = String(this.nextResultId);
    this.nextResultId += 1;
    this.entries.set(key, { resultId, documentVersion, data });
    this.evict();
    return resultId;
  }

  /** The cached entry for a document, whatever its version. */
  get(handle: number, uri: string): SemanticTokensCacheEntry | undefined {
    return this.entries.get(SemanticTokensCache.key(handle, uri));
  }

  /**
   * Look up a baseline for a delta request.
   *
   * A caller that presents a `resultId` we no longer hold — or one that names a different
   * document — gets nothing, and must ask for full tokens. Honouring a mismatched id is how a file
   * ends up coloured with another file's tokens.
   */
  lookup(
    handle: number,
    uri: string,
    resultId: string | undefined,
    documentVersion: number,
  ): SemanticTokensLookup | undefined {
    const entry = this.entries.get(SemanticTokensCache.key(handle, uri));
    if (!entry) return undefined;
    if (resultId !== undefined && entry.resultId !== resultId) return undefined;
    return { entry, fresh: entry.documentVersion === documentVersion };
  }

  /**
   * Apply a provider's edits against the stored baseline and store the result.
   *
   * Returns `null` when the edits do not fit the baseline; the caller then re-requests in full.
   * Rejecting here rather than at the consumer keeps a bad delta from ever being handed to Monaco.
   */
  applyEdits(
    handle: number,
    uri: string,
    resultId: string,
    documentVersion: number,
    edits: readonly SemanticTokensEdit[],
  ): { resultId: string; data: number[] } | null {
    const entry = this.entries.get(SemanticTokensCache.key(handle, uri));
    if (!entry || entry.resultId !== resultId) return null;
    const data = applySemanticTokensEdits(entry.data, edits);
    if (!data) return null;
    return { resultId: this.store(handle, uri, documentVersion, data), data };
  }

  /** Forget one document's tokens — on close, or when its language changes. */
  invalidate(handle: number, uri: string): void {
    this.entries.delete(SemanticTokensCache.key(handle, uri));
  }

  /**
   * Forget every document belonging to one provider — on disposal or extension deactivation.
   *
   * Without this a disposed provider's baselines outlive it, and the handle is eventually reused by
   * whichever provider registers next, which would then be offered a baseline it never produced.
   */
  invalidateProvider(handle: number): number {
    const prefix = `${handle}:`;
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Forget one document across every provider — on close. */
  invalidateDocument(uri: string): number {
    const suffix = `:${uri}`;
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.endsWith(suffix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > this.maxDocuments) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
