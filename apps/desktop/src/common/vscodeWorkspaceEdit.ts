/**
 * `WorkspaceEdit` policy: what an extension is allowed to change, and in what order (PRD Phase 6).
 *
 * `vscodeLanguageWire.ts` decides what a `WorkspaceEdit` *is* — it reads the shim's ordered
 * operation list into `WireWorkspaceEdit`. This module decides whether that edit may be applied at
 * all, and hands back a plan that can be applied without further thought. The split keeps shape
 * normalisation free of workspace knowledge and keeps policy in one auditable place.
 *
 * A `WorkspaceEdit` is the most dangerous thing a language provider can return: it is the one
 * provider result that writes to disk, and it arrives as a list of paths chosen by the extension.
 * So three rules hold here, and all three are all-or-nothing:
 *
 *   - Every URI must be inside a workspace root. Half-applying an edit whose second file lies
 *     outside the workspace would leave the workspace in a state no user asked for and no undo
 *     step describes, so one bad URI rejects the whole edit.
 *   - Ranges must be well-formed. A backwards or non-integer range is not a small mistake; applied
 *     literally it deletes a span the provider never named.
 *   - Text edits against one file must not overlap, and are ordered last-to-first so that applying
 *     one cannot move the offsets of the next.
 *
 * Pure: no I/O, no Electron, no Monaco. Nothing here touches the filesystem; it decides what the
 * caller is permitted to.
 */

import type { WireTextEdit, WireWorkspaceEdit, WireWorkspaceEditEntry } from './vscodeLanguageWire';
import { isPathInsideRoots, normalizeWebviewPath } from './vscodeWebview';

export const MAX_WORKSPACE_EDIT_ENTRIES = 500;
export const MAX_TEXT_EDITS_PER_FILE = 2000;
export const MAX_WORKSPACE_EDIT_TOTAL_EDITS = 5000;
/** Contents `createFile` may carry inline. Larger files are a filesystem API's job, not an edit's. */
export const MAX_CREATED_FILE_BYTES = 1024 * 1024;

/** Schemes an edit may name. Anything else is refused before boundary checks even run. */
export const EDITABLE_SCHEMES: ReadonlySet<string> = new Set(['file', 'untitled']);

export interface WorkspaceEditPolicy {
  /** Absolute workspace folder paths. Empty means nothing is editable. */
  roots: readonly string[];
  /** Whether path comparison folds case. Passed in rather than sniffed so this stays pure. */
  caseInsensitive: boolean;
  /** `untitled:` documents live only in the editor, so they are outside the boundary check. */
  allowUntitled?: boolean;
  maxEntries?: number;
  maxTotalEdits?: number;
}

export type WorkspaceEditRejectionCode =
  | 'empty'
  | 'invalid-uri'
  | 'unsupported-scheme'
  | 'outside-workspace'
  | 'too-many-entries'
  | 'too-many-edits'
  | 'invalid-range'
  | 'overlapping-edits'
  | 'too-large'
  | 'no-workspace';

export interface WorkspaceEditRejection {
  code: WorkspaceEditRejectionCode;
  /** Reported to the extension as the reason `applyEdit` resolved false, and written to the log. */
  message: string;
  uri?: string;
}

/** An edit that passed policy, ready to apply in the order given. */
export interface WorkspaceEditPlan {
  entries: WireWorkspaceEditEntry[];
  /** Every URI the plan writes to, de-duplicated — what the caller must reload or mark dirty. */
  touched: string[];
  /** Text edits across all files, for logging and for the caller's progress reporting. */
  textEditCount: number;
  fileOperationCount: number;
}

export type WorkspaceEditValidation =
  { ok: true; plan: WorkspaceEditPlan } | { ok: false; rejection: WorkspaceEditRejection };

/**
 * Decode a `file:` URI to a comparable filesystem path.
 *
 * Written here rather than taken from `node:url` because this module is imported by the renderer
 * too, and because `fileURLToPath` throws where a boundary check wants a `null`. Percent-escapes are
 * decoded before comparison — `%2e%2e` is `..`, and a check that compares the encoded form would let
 * it through. A decode failure returns `null` rather than the raw string, since a URI we cannot read
 * is a URI we cannot prove is inside the workspace.
 */
export function fileUriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 4096) return null;
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(uri);
  if (!match) return null;
  const authority = match[1] ?? '';
  let path = match[2] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  // `file:///c:/x` → `c:/x`; a UNC share keeps its authority as the root.
  if (authority.length > 0) return normalizeWebviewPath(`//${authority}${path}`);
  if (/^\/[A-Za-z]:/.test(path)) return normalizeWebviewPath(path.slice(1));
  return normalizeWebviewPath(path);
}

/** The scheme of a URI, lower-cased, or `undefined` when it has none. */
export function uriScheme(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  return match?.[1]?.toLowerCase();
}

/**
 * Is this URI one the extension may write to?
 *
 * `untitled:` is editable when the policy allows it because such a document has no path to be
 * inside anything — refusing it would break rename and quick-fix in every scratch buffer. Every
 * other scheme must resolve to a real path inside a root; a scheme we do not recognise is refused
 * rather than assumed harmless, since `git:`/`output:` documents are read-only views whose "write"
 * would be discarded silently.
 */
export function isEditableUri(uri: unknown, policy: WorkspaceEditPolicy): boolean {
  const scheme = uriScheme(uri);
  if (scheme === undefined || !EDITABLE_SCHEMES.has(scheme)) return false;
  if (scheme === 'untitled') return policy.allowUntitled === true;
  const fsPath = fileUriToPath(uri);
  if (fsPath === null) return false;
  return isPathInsideRoots(fsPath, policy.roots, policy.caseInsensitive);
}

/** Well-formed means integer, non-negative, and not ending before it starts. */
export function isValidEditRange(range: unknown): boolean {
  if (typeof range !== 'object' || range === null) return false;
  const value = range as { start?: unknown; end?: unknown };
  const start = asPosition(value.start);
  const end = asPosition(value.end);
  if (!start || !end) return false;
  if (end.line < start.line) return false;
  if (end.line === start.line && end.character < start.character) return false;
  return true;
}

function asPosition(value: unknown): { line: number; character: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as { line?: unknown; character?: unknown };
  const line = source.line;
  const character = source.character;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) return null;
  if (typeof character !== 'number' || !Number.isInteger(character) || character < 0) return null;
  return { line, character };
}

/**
 * Order text edits last-to-first.
 *
 * Applying in this order means every edit's range still refers to the text it was computed against,
 * because nothing before it in the document has moved. The alternative — applying front to back and
 * accumulating an offset — is the same answer with a running total to get wrong, and it is wrong in
 * a way that only shows up on the second edit.
 *
 * Ties are broken by end position, then stably: two edits at the same offset are an insertion and a
 * replacement at a cursor, and their relative order is the provider's intent.
 */
export function sortTextEditsForApply(edits: readonly WireTextEdit[]): WireTextEdit[] {
  return edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      const byStart = comparePositions(b.edit.range.start, a.edit.range.start);
      if (byStart !== 0) return byStart;
      const byEnd = comparePositions(b.edit.range.end, a.edit.range.end);
      if (byEnd !== 0) return byEnd;
      return a.index - b.index;
    })
    .map((item) => item.edit);
}

function comparePositions(
  a: { line: number; character: number },
  b: { line: number; character: number },
): number {
  return a.line !== b.line ? a.line - b.line : a.character - b.character;
}

/**
 * Do any two edits in a descending-sorted list overlap?
 *
 * Touching is not overlapping: `[0,5)` followed by `[5,9)` is two adjacent replacements, which is
 * what a formatter produces. Genuine overlap means the second edit's result depends on whether the
 * first already ran, and there is no order that makes both correct — so the edit is refused rather
 * than applied to whichever interpretation the loop happens to take.
 */
export function textEditsOverlap(sorted: readonly WireTextEdit[]): boolean {
  for (let i = 1; i < sorted.length; i += 1) {
    const later = sorted[i - 1];
    const earlier = sorted[i];
    if (!later || !earlier) continue;
    if (comparePositions(earlier.range.end, later.range.start) > 0) return true;
  }
  return false;
}

function reject(
  code: WorkspaceEditRejectionCode,
  message: string,
  uri?: string,
): WorkspaceEditValidation {
  return { ok: false, rejection: uri === undefined ? { code, message } : { code, message, uri } };
}

/**
 * Validate a whole `WorkspaceEdit` and return an applicable plan.
 *
 * All-or-nothing. `workspace.applyEdit` resolves to a boolean and an extension that gets `false`
 * retries or reports; an extension that gets `true` after a partial application has no way to learn
 * which half landed. Order between entries is preserved exactly as the extension built it, because
 * "create then write" and "write then create" are different edits and only the extension knows which
 * it meant.
 */
export function validateWorkspaceEdit(
  edit: WireWorkspaceEdit | undefined,
  policy: WorkspaceEditPolicy,
): WorkspaceEditValidation {
  if (!edit || !Array.isArray(edit.entries) || edit.entries.length === 0) {
    return reject('empty', 'The workspace edit contains no operations.');
  }
  if (policy.roots.length === 0 && policy.allowUntitled !== true) {
    return reject('no-workspace', 'No workspace folder is open, so no file may be edited.');
  }
  const maxEntries = policy.maxEntries ?? MAX_WORKSPACE_EDIT_ENTRIES;
  if (edit.entries.length > maxEntries) {
    return reject(
      'too-many-entries',
      `The workspace edit touches ${edit.entries.length} resources; the limit is ${maxEntries}.`,
    );
  }

  const maxTotalEdits = policy.maxTotalEdits ?? MAX_WORKSPACE_EDIT_TOTAL_EDITS;
  const entries: WireWorkspaceEditEntry[] = [];
  const touched: string[] = [];
  const seen = new Set<string>();
  let textEditCount = 0;
  let fileOperationCount = 0;

  const remember = (uri: string): void => {
    if (seen.has(uri)) return;
    seen.add(uri);
    touched.push(uri);
  };

  for (const entry of edit.entries) {
    if (!entry || typeof entry !== 'object') {
      return reject('empty', 'The workspace edit contains an unreadable operation.');
    }
    if (!isEditableUri(entry.uri, policy)) {
      return reject(
        uriScheme(entry.uri) === undefined
          ? 'invalid-uri'
          : EDITABLE_SCHEMES.has(uriScheme(entry.uri) as string)
            ? 'outside-workspace'
            : 'unsupported-scheme',
        `The workspace edit targets ${String(entry.uri)}, which is outside the workspace.`,
        typeof entry.uri === 'string' ? entry.uri : undefined,
      );
    }

    if (entry.kind === 'text') {
      if (!Array.isArray(entry.edits) || entry.edits.length === 0) continue;
      if (entry.edits.length > MAX_TEXT_EDITS_PER_FILE) {
        return reject(
          'too-many-edits',
          `${entry.uri} receives ${entry.edits.length} edits; the limit is ${MAX_TEXT_EDITS_PER_FILE}.`,
          entry.uri,
        );
      }
      for (const textEdit of entry.edits) {
        if (!isValidEditRange(textEdit?.range)) {
          return reject(
            'invalid-range',
            `An edit for ${entry.uri} has an invalid range.`,
            entry.uri,
          );
        }
      }
      const sorted = sortTextEditsForApply(entry.edits);
      if (textEditsOverlap(sorted)) {
        return reject(
          'overlapping-edits',
          `Two edits for ${entry.uri} overlap, so the result would depend on their order.`,
          entry.uri,
        );
      }
      textEditCount += sorted.length;
      if (textEditCount > maxTotalEdits) {
        return reject(
          'too-many-edits',
          `The workspace edit contains more than ${maxTotalEdits} text edits.`,
        );
      }
      entries.push({ kind: 'text', uri: entry.uri, edits: sorted });
      remember(entry.uri);
      continue;
    }

    if (entry.kind === 'create') {
      if (entry.contents !== undefined && entry.contents.length > MAX_CREATED_FILE_BYTES) {
        return reject(
          'too-large',
          `The contents for ${entry.uri} exceed ${MAX_CREATED_FILE_BYTES} bytes.`,
          entry.uri,
        );
      }
    } else if (entry.kind === 'rename') {
      // The destination is checked with the same rule as the source: a rename is the one operation
      // that can move a file out of the workspace, and only the target says where it lands.
      if (!isEditableUri(entry.newUri, policy)) {
        return reject(
          'outside-workspace',
          `The workspace edit renames ${entry.uri} to ${String(entry.newUri)}, which is outside the workspace.`,
          entry.uri,
        );
      }
      remember(entry.newUri);
    } else if (entry.kind !== 'delete') {
      return reject('empty', 'The workspace edit contains an unknown operation.');
    }

    fileOperationCount += 1;
    entries.push(entry);
    remember(entry.uri);
  }

  if (entries.length === 0) {
    return reject('empty', 'The workspace edit contains no applicable operations.');
  }
  return { ok: true, plan: { entries, touched, textEditCount, fileOperationCount } };
}

/**
 * Summarise a rejection for the log and for the extension.
 *
 * Extensions see only `applyEdit`'s `false`, so the reason has to reach the user some other way or
 * the failure is indistinguishable from a provider that did nothing.
 */
export function describeWorkspaceEditRejection(rejection: WorkspaceEditRejection): string {
  return `${rejection.code}: ${rejection.message}`;
}
