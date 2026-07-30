/**
 * Document synchronisation: the extension host's view of what is open (PRD Phase 6).
 *
 * Every language provider is called with a document and a position, and the provider's answer is
 * only correct if the text the host holds is the text the user is looking at. "No stale document
 * state may exist" is the requirement, and staleness has exactly two causes worth designing against:
 * a change applied to the wrong baseline, and a change applied twice. Both are version problems, so
 * the version is the gate here — a change that does not follow the version the store holds is
 * refused, and the caller re-synchronises in full rather than guessing.
 *
 * The store is the same shape upstream uses: full text per document, with incremental changes
 * applied to it. Extensions read `document.getText()` and `document.offsetAt()` freely, so the text
 * has to exist somewhere; keeping it here means one copy, versioned, rather than one per provider
 * call.
 *
 * Pure: no I/O, no Electron, no Monaco.
 */

import type { DocumentCandidate } from './documentSelector';

/** Text one document may hold. Past this the language features are not the useful thing anyway. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_OPEN_DOCUMENTS = 500;
export const MAX_CONTENT_CHANGES = 2000;

/** A position as the wire carries it: 0-based line and UTF-16 character offset. */
export interface DocumentPosition {
  line: number;
  character: number;
}

export interface DocumentRange {
  start: DocumentPosition;
  end: DocumentPosition;
}

/**
 * One change, in the shape LSP and Monaco both use.
 *
 * `range` absent means the change replaces the whole document — the "full edits" case. Present means
 * incremental, and the range is relative to the document *as it stands after the previous change in
 * the same batch*, which is why they are applied in order and never sorted.
 */
export interface DocumentContentChange {
  range?: DocumentRange;
  text: string;
}

/** What the host and every provider call sees. */
export interface DocumentSnapshot {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  lineCount: number;
  isDirty: boolean;
  isClosed: boolean;
  eol: '\n' | '\r\n';
}

export interface DocumentOpenInput {
  uri: string;
  languageId: string;
  version?: number;
  text?: string;
  isDirty?: boolean;
}

/**
 * Line start offsets for a text.
 *
 * Computed on demand and cached per document version, because a provider round-trip converts
 * positions to offsets and back several times and rescanning a megabyte for each is the difference
 * between a hover that appears and a hover that stutters.
 */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10 /* \n */) i += 1;
      starts.push(i + 1);
    } else if (code === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Convert a position to an offset, clamping rather than throwing.
 *
 * Upstream clamps too: `TextDocument.offsetAt` on a position past the end of a line returns the end
 * of that line. Providers routinely hand back positions computed against a slightly older version,
 * and clamping turns that into a slightly wrong offset instead of a thrown error that loses the whole
 * result.
 */
export function offsetAt(text: string, position: DocumentPosition, lineStarts?: number[]): number {
  const starts = lineStarts ?? computeLineStarts(text);
  if (position.line < 0) return 0;
  if (position.line >= starts.length) return text.length;
  const lineStart = starts[position.line] ?? 0;
  const nextStart = starts[position.line + 1];
  const lineEnd = nextStart === undefined ? text.length : lineEndBefore(text, nextStart);
  return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}

function lineEndBefore(text: string, nextLineStart: number): number {
  let end = nextLineStart;
  if (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  if (end > 0 && text.charCodeAt(end - 1) === 13) end -= 1;
  return end;
}

/** The inverse of `offsetAt`, for turning provider offsets back into positions. */
export function positionAt(text: string, offset: number, lineStarts?: number[]): DocumentPosition {
  const starts = lineStarts ?? computeLineStarts(text);
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) > target) high = mid - 1;
    else low = mid;
  }
  return { line: low, character: target - (starts[low] ?? 0) };
}

/**
 * Apply a batch of changes to a text.
 *
 * In order, never sorted: each range is stated against the text produced by the previous change, so
 * reordering them — the right move for a `WorkspaceEdit`, where all ranges share one baseline — is
 * exactly wrong here. Returns `null` when a change cannot be applied, which the caller must treat as
 * a desynchronisation and answer with a full resend; silently applying the rest would leave a
 * document that looks synchronised and is not.
 */
export function applyContentChanges(
  text: string,
  changes: readonly DocumentContentChange[],
): string | null {
  if (changes.length > MAX_CONTENT_CHANGES) return null;
  let current = text;
  for (const change of changes) {
    if (!change || typeof change.text !== 'string') return null;
    if (change.range === undefined) {
      current = change.text;
    } else {
      if (!isSaneRange(change.range)) return null;
      const starts = computeLineStarts(current);
      const start = offsetAt(current, change.range.start, starts);
      const end = offsetAt(current, change.range.end, starts);
      if (end < start) return null;
      current = current.slice(0, start) + change.text + current.slice(end);
    }
    if (current.length > MAX_DOCUMENT_BYTES) return null;
  }
  return current;
}

function isSaneRange(range: DocumentRange): boolean {
  return isSanePosition(range.start) && isSanePosition(range.end);
}

function isSanePosition(position: DocumentPosition | undefined): boolean {
  if (!position) return false;
  return (
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    Number.isInteger(position.character) &&
    position.character >= 0
  );
}

/** What the store reports happened, so the caller can fire the matching `workspace` event. */
export type DocumentEvent =
  | { type: 'open'; snapshot: DocumentSnapshot }
  | { type: 'change'; snapshot: DocumentSnapshot; changes: DocumentContentChange[] }
  | { type: 'save'; snapshot: DocumentSnapshot }
  | { type: 'close'; snapshot: DocumentSnapshot }
  | { type: 'language'; snapshot: DocumentSnapshot; previousLanguageId: string };

export type DocumentChangeFailure = 'unknown' | 'stale' | 'invalid' | 'too-large';

export type DocumentChangeResult =
  { ok: true; event: DocumentEvent } | { ok: false; reason: DocumentChangeFailure };

interface StoredDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  isDirty: boolean;
  eol: '\n' | '\r\n';
  lineStarts: number[] | null;
}

/**
 * The set of open documents, versioned.
 *
 * One store per extension host, holding what that host is allowed to see. `close` removes the
 * document rather than marking it closed, and returns a final snapshot with `isClosed: true` — an
 * extension holding a `TextDocument` for a closed file must see a document that reports itself
 * closed, not one that keeps answering with the text it had when it was open.
 */
export class DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();

  constructor(private readonly maxDocuments: number = MAX_OPEN_DOCUMENTS) {}

  /**
   * Open a document, or re-open one already known.
   *
   * A second open for the same URI replaces the text and version rather than being ignored: the
   * editor re-sends an open when a document is reverted or reloaded from disk, and treating that as a
   * duplicate is how the store ends up one revision behind for the rest of the session.
   */
  open(input: DocumentOpenInput): DocumentEvent | null {
    if (typeof input.uri !== 'string' || input.uri.length === 0) return null;
    if (typeof input.languageId !== 'string' || input.languageId.length === 0) return null;
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length > MAX_DOCUMENT_BYTES) return null;
    if (!this.documents.has(input.uri) && this.documents.size >= this.maxDocuments) return null;

    const stored: StoredDocument = {
      uri: input.uri,
      languageId: input.languageId,
      version: typeof input.version === 'number' && input.version > 0 ? input.version : 1,
      text,
      isDirty: input.isDirty === true,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
      lineStarts: null,
    };
    this.documents.set(input.uri, stored);
    return { type: 'open', snapshot: this.snapshot(stored, false) };
  }

  /**
   * Apply a change batch.
   *
   * `version` is the version the document reaches *after* the batch, matching LSP and Monaco. A
   * version that is not greater than the one held means the change is a duplicate or arrived out of
   * order, and applying it would corrupt the text; the caller re-opens the document instead.
   */
  change(
    uri: string,
    version: number,
    changes: readonly DocumentContentChange[],
    options: { isDirty?: boolean } = {},
  ): DocumentChangeResult {
    const stored = this.documents.get(uri);
    if (!stored) return { ok: false, reason: 'unknown' };
    if (!Number.isInteger(version) || version <= stored.version)
      return { ok: false, reason: 'stale' };
    if (!Array.isArray(changes) || changes.length === 0) return { ok: false, reason: 'invalid' };

    const text = applyContentChanges(stored.text, changes);
    if (text === null) {
      return {
        ok: false,
        reason: stored.text.length > MAX_DOCUMENT_BYTES ? 'too-large' : 'invalid',
      };
    }
    stored.text = text;
    stored.version = version;
    stored.lineStarts = null;
    if (options.isDirty !== undefined) stored.isDirty = options.isDirty;
    return {
      ok: true,
      event: { type: 'change', snapshot: this.snapshot(stored, false), changes: changes.slice() },
    };
  }

  /** A full-text resynchronisation, used after any refused change. */
  replace(uri: string, version: number, text: string): DocumentEvent | null {
    const stored = this.documents.get(uri);
    if (!stored || typeof text !== 'string' || text.length > MAX_DOCUMENT_BYTES) return null;
    stored.text = text;
    stored.version = Number.isInteger(version) && version > 0 ? version : stored.version + 1;
    stored.lineStarts = null;
    return { type: 'change', snapshot: this.snapshot(stored, false), changes: [{ text }] };
  }

  save(uri: string): DocumentEvent | null {
    const stored = this.documents.get(uri);
    if (!stored) return null;
    stored.isDirty = false;
    return { type: 'save', snapshot: this.snapshot(stored, false) };
  }

  /**
   * Change a document's language — `setTextDocumentLanguage`.
   *
   * Upstream models this as a close followed by an open, because provider selection is keyed on the
   * language and every provider registered for the old one must stop being consulted. We report it as
   * its own event and leave that sequencing to the caller, which also has to invalidate the semantic
   * token baseline and the markers the old language's providers published.
   */
  setLanguage(uri: string, languageId: string): DocumentEvent | null {
    const stored = this.documents.get(uri);
    if (!stored) return null;
    if (typeof languageId !== 'string' || languageId.length === 0) return null;
    if (stored.languageId === languageId) return null;
    const previousLanguageId = stored.languageId;
    stored.languageId = languageId;
    stored.version += 1;
    return { type: 'language', snapshot: this.snapshot(stored, false), previousLanguageId };
  }

  close(uri: string): DocumentEvent | null {
    const stored = this.documents.get(uri);
    if (!stored) return null;
    this.documents.delete(uri);
    return { type: 'close', snapshot: this.snapshot(stored, true) };
  }

  get(uri: string): DocumentSnapshot | undefined {
    const stored = this.documents.get(uri);
    return stored ? this.snapshot(stored, false) : undefined;
  }

  has(uri: string): boolean {
    return this.documents.has(uri);
  }

  all(): DocumentSnapshot[] {
    return Array.from(this.documents.values(), (stored) => this.snapshot(stored, false));
  }

  uris(): string[] {
    return Array.from(this.documents.keys());
  }

  get size(): number {
    return this.documents.size;
  }

  clear(): void {
    this.documents.clear();
  }

  /** Cached line starts for the current version, for offset conversion on the hot path. */
  lineStartsFor(uri: string): number[] | undefined {
    const stored = this.documents.get(uri);
    if (!stored) return undefined;
    stored.lineStarts ??= computeLineStarts(stored.text);
    return stored.lineStarts;
  }

  offsetAt(uri: string, position: DocumentPosition): number | undefined {
    const stored = this.documents.get(uri);
    if (!stored) return undefined;
    return offsetAt(stored.text, position, this.lineStartsFor(uri));
  }

  positionAt(uri: string, offset: number): DocumentPosition | undefined {
    const stored = this.documents.get(uri);
    if (!stored) return undefined;
    return positionAt(stored.text, offset, this.lineStartsFor(uri));
  }

  private snapshot(stored: StoredDocument, isClosed: boolean): DocumentSnapshot {
    stored.lineStarts ??= computeLineStarts(stored.text);
    return {
      uri: stored.uri,
      languageId: stored.languageId,
      version: stored.version,
      text: stored.text,
      lineCount: stored.lineStarts.length,
      isDirty: stored.isDirty,
      isClosed,
      eol: stored.eol,
    };
  }
}

/**
 * Reduce a document to what `documentSelector.ts` scores against.
 *
 * The `path` a `pattern` selector matches is the *path* component, decoded — `file:///c:/a%20b/x.ts`
 * has to match a `.ts` glob under `a b` the way it does in VS Code, and a glob run against the raw
 * URI would match neither the spaces nor the drive letter. A path that cannot be decoded becomes the
 * empty string, so pattern selectors decline to match rather than matching by accident.
 */
export function toDocumentCandidate(snapshot: {
  uri: string;
  languageId: string;
  notebookType?: string;
}): DocumentCandidate {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/[^/]*)?(.*)$/.exec(snapshot.uri);
  const scheme = (match?.[1] ?? 'file').toLowerCase();
  let path = match?.[3] ?? snapshot.uri;
  const query = path.search(/[?#]/);
  if (query >= 0) path = path.slice(0, query);
  try {
    path = decodeURIComponent(path);
  } catch {
    path = '';
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  const candidate: DocumentCandidate = { languageId: snapshot.languageId, scheme, path };
  if (snapshot.notebookType !== undefined) candidate.notebookType = snapshot.notebookType;
  return candidate;
}
