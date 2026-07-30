/**
 * The renderer half of the extension language platform (PRD Phase 6).
 *
 * Three jobs, all of them plumbing between Monaco and the extension host:
 *
 *   1. **Requests.** Every provider invocation Monaco makes becomes one `languages:provide` call
 *      carrying a request id, and Monaco's cancellation token is wired to `languages:cancel` so an
 *      abandoned completion stops costing the extension work instead of merely being ignored. This
 *      is the same discipline the language-server path uses, and it is what keeps typing responsive
 *      when a provider is slow.
 *   2. **Document synchronisation.** Extensions read `TextDocument`s, so the host's copy of every
 *      open document has to match Monaco's exactly. Changes are sent incrementally and debounced;
 *      the host answers `resync` if a version arrives out of order, and the whole text is resent.
 *      Nothing is inferred about the host's state — it says when it is behind.
 *   3. **Diagnostics and edits.** Diagnostics an extension published are painted as Monaco markers,
 *      one owner per publisher so several linters can coexist, and updated per file rather than
 *      wholesale. Edits Main asks the editor to apply arrive here too, because a dirty buffer — not
 *      the file on disk — is the truth for an open document.
 *
 * Provider registration lives in `extensionProviders.ts`; this module is the transport it uses.
 */
import { monaco } from './monacoEnv';
import { applyTextEdits, findModel } from './lspConvert';
import { collapseSnippet } from './extensionLanguageConvert';
import { onFileSaved } from '../state/fileEvents';
import type {
  ExtensionApplyEditPayload,
  ExtensionProvideInput,
  ExtensionProviderEditInput,
  LspRange,
} from '../../../common/ipc';
import type { HostDiagnostic } from '../../../common/vscodeHost';
import type { LanguageFeature, ProviderOp } from '../../../common/vscodeLanguages';

/* ------------------------------------------------------------------ requests */

let nextRequestId = 1;

/** What a caller supplies; the request id is this module's business. */
export interface ProviderRequest {
  feature: LanguageFeature;
  op: ProviderOp;
  uri?: string;
  handle?: number;
  payload?: Record<string, unknown>;
}

/**
 * Ask the extension host for one provider result.
 *
 * Returns `null` for every kind of failure — cancelled, no provider matched, the provider threw,
 * the host is gone — because that is what every Monaco provider interface wants for "nothing to
 * show". Failures the host reported are logged once per provider so a broken extension is
 * diagnosable without a console full of repeats as the user types.
 */
export async function requestProvider<T>(
  request: ProviderRequest,
  token: monaco.CancellationToken,
): Promise<T | null> {
  const requestId = nextRequestId++;
  const subscription = token.onCancellationRequested(() => {
    void window.axiom.languageProviders.cancel(requestId).catch(() => undefined);
  });
  try {
    if (token.isCancellationRequested) return null;
    const input: ExtensionProvideInput = { requestId, ...request };
    const result = await window.axiom.languageProviders.provide(input);
    if (result.failures !== undefined) reportFailures(request, result.failures);
    if (!result.ok || result.value === null || result.value === undefined) return null;
    return result.value as T;
  } catch {
    return null;
  } finally {
    subscription.dispose();
  }
}

/** Provider failures already reported, so a provider that throws on every keystroke logs once. */
const reported = new Set<string>();

function reportFailures(request: ProviderRequest, failures: readonly string[]): void {
  for (const failure of failures) {
    const key = `${request.feature}:${request.op}:${failure}`;
    if (reported.has(key)) continue;
    reported.add(key);
    console.warn(`[axiom] ${request.feature} provider failed: ${failure}`);
  }
}

/* --------------------------------------------------- document synchronisation */

/** Long enough to batch a burst of typing, short enough that a provider is never asked about a
 *  document the host has not caught up with — the same window the language-server sync uses. */
const CHANGE_DEBOUNCE_MS = 120;

/** Schemes an extension may see. A diff view or a model Monaco made for itself is not a document. */
const SYNCED_SCHEMES = new Set(['file', 'untitled']);

interface Tracked {
  model: monaco.editor.ITextModel;
  uri: string;
  pending: Array<{ range?: LspRange; text: string }>;
  timer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  /** A flush is in flight; a second one would race it and arrive out of version order. */
  flushing: boolean;
  disposables: monaco.IDisposable[];
}

const tracked = new Map<string, Tracked>();
let syncStarted = false;

function syncable(model: monaco.editor.ITextModel): boolean {
  return SYNCED_SCHEMES.has(model.uri.scheme) && !model.isDisposed();
}

function monacoRange(range: monaco.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

/** Tell the hosts a document exists, and start watching it. Opening is also what activates. */
function openDocument(model: monaco.editor.ITextModel): void {
  if (!syncable(model)) return;
  const uri = model.uri.toString();
  if (tracked.has(uri)) return;
  const entry: Tracked = {
    model,
    uri,
    pending: [],
    timer: null,
    dirty: false,
    flushing: false,
    disposables: [],
  };
  tracked.set(uri, entry);
  entry.disposables.push(
    model.onDidChangeContent((event) => {
      entry.dirty = true;
      for (const change of event.changes) {
        entry.pending.push({ range: monacoRange(change.range), text: change.text });
      }
      schedule(entry);
    }),
    model.onDidChangeLanguage((event) => {
      void window.axiom.languageProviders
        .document({ type: 'language', uri, languageId: event.newLanguage })
        .catch(() => undefined);
    }),
  );
  void window.axiom.languageProviders
    .document({
      type: 'open',
      uri,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      text: model.getValue(),
      isDirty: false,
    })
    .catch(() => undefined);
  // Diagnostics for a file nobody had open were held back for want of a model; now there is one.
  void refreshDiagnostics();
}

function schedule(entry: Tracked): void {
  if (entry.timer !== null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flush(entry);
  }, CHANGE_DEBOUNCE_MS);
}

/**
 * Send one batch of changes.
 *
 * The version is read at send time, not at edit time, so it describes the document the batch
 * produces. If the host says it cannot follow — a change arrived out of order, or it never saw the
 * open — the full text is resent under the current version, which is the only way back to a known
 * state. Changes that arrive while a flush is in flight are collected for the next one, because two
 * concurrent batches would reach Main in an order neither of them describes.
 */
async function flush(entry: Tracked): Promise<void> {
  if (entry.flushing || entry.model.isDisposed()) return;
  if (entry.pending.length === 0) return;
  const changes = entry.pending;
  entry.pending = [];
  entry.flushing = true;
  try {
    const result = await window.axiom.languageProviders.document({
      type: 'change',
      uri: entry.uri,
      version: entry.model.getVersionId(),
      changes,
      isDirty: entry.dirty,
    });
    if (result.resync === true) await resync(entry);
  } catch {
    // The host is gone or restarting; the next change resynchronises from whatever it then holds.
  } finally {
    entry.flushing = false;
    if (entry.pending.length > 0) schedule(entry);
  }
}

/** Resend the whole document. Reported as a change with `text` and no `changes`. */
async function resync(entry: Tracked): Promise<void> {
  if (entry.model.isDisposed()) return;
  const result = await window.axiom.languageProviders
    .document({
      type: 'change',
      uri: entry.uri,
      version: entry.model.getVersionId(),
      text: entry.model.getValue(),
      isDirty: entry.dirty,
    })
    .catch(() => ({ ok: false }));
  // A host that does not know the document at all needs the open event, not a replacement.
  if (!result.ok && !entry.model.isDisposed()) {
    await window.axiom.languageProviders
      .document({
        type: 'open',
        uri: entry.uri,
        languageId: entry.model.getLanguageId(),
        version: entry.model.getVersionId(),
        text: entry.model.getValue(),
        isDirty: entry.dirty,
      })
      .catch(() => undefined);
  }
}

/** Flush anything outstanding for one document, so a provider is never asked about a stale copy. */
export async function flushDocument(uri: string): Promise<void> {
  const entry = tracked.get(uri);
  if (entry === undefined || entry.pending.length === 0) return;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  await flush(entry);
}

function closeDocument(model: monaco.editor.ITextModel): void {
  const uri = model.uri.toString();
  const entry = tracked.get(uri);
  if (entry === undefined) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  for (const disposable of entry.disposables) disposable.dispose();
  tracked.delete(uri);
  void window.axiom.languageProviders.document({ type: 'close', uri }).catch(() => undefined);
}

/**
 * A document was saved.
 *
 * Extensions that only re-evaluate on save — most formatters and linters — publish nothing until
 * this arrives, so a missing save event looks exactly like a broken extension.
 */
function saveDocument(path: string): void {
  for (const entry of tracked.values()) {
    if (entry.model.uri.scheme !== 'file') continue;
    if (entry.model.uri.fsPath.toLowerCase() !== path.toLowerCase()) continue;
    entry.dirty = false;
    void flushDocument(entry.uri)
      .then(() => window.axiom.languageProviders.document({ type: 'save', uri: entry.uri }))
      .catch(() => undefined);
  }
}

/** Begin mirroring Monaco's models into the extension hosts. Idempotent. */
export function startDocumentSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  for (const model of monaco.editor.getModels()) openDocument(model);
  monaco.editor.onDidCreateModel(openDocument);
  monaco.editor.onWillDisposeModel(closeDocument);
  onFileSaved(saveDocument);
}

/* --------------------------------------------------------------- diagnostics */

/**
 * Marker owner for one publisher.
 *
 * Every `DiagnosticCollection` gets its own owner, which is what lets ESLint, the TypeScript server
 * and a spell checker mark the same line without erasing each other — Monaco replaces markers per
 * owner, so a shared owner would mean last-writer-wins.
 */
function markerOwner(owner: string): string {
  return `axiom-ext:${owner}`;
}

/** owner → file path → the markers currently painted, so an unchanged file is not repainted. */
const painted = new Map<string, Map<string, string>>();

const SEVERITIES: Record<HostDiagnostic['severity'], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

function toMarker(diagnostic: HostDiagnostic): monaco.editor.IMarkerData {
  const marker: monaco.editor.IMarkerData = {
    severity: SEVERITIES[diagnostic.severity] ?? monaco.MarkerSeverity.Info,
    message: diagnostic.message,
    source: diagnostic.source,
    startLineNumber: diagnostic.startLine + 1,
    startColumn: diagnostic.startColumn + 1,
    endLineNumber: diagnostic.endLine + 1,
    endColumn: diagnostic.endColumn + 1,
  };
  if (diagnostic.code.length > 0) {
    marker.code =
      diagnostic.codeHref === undefined
        ? diagnostic.code
        : { value: diagnostic.code, target: monaco.Uri.parse(diagnostic.codeHref) };
  }
  const tags: monaco.MarkerTag[] = [];
  for (const tag of diagnostic.tags ?? []) {
    if (tag === 'unnecessary') tags.push(monaco.MarkerTag.Unnecessary);
    else if (tag === 'deprecated') tags.push(monaco.MarkerTag.Deprecated);
  }
  if (tags.length > 0) marker.tags = tags;
  if (diagnostic.relatedInformation !== undefined) {
    marker.relatedInformation = diagnostic.relatedInformation.map((related) => ({
      resource: monaco.Uri.file(related.path),
      message: related.message,
      startLineNumber: related.startLine + 1,
      startColumn: related.startColumn + 1,
      endLineNumber: related.endLine + 1,
      endColumn: related.endColumn + 1,
    }));
  }
  return marker;
}

/** The model for a diagnostic's path, matched case-insensitively for Windows' sake. */
function modelForPath(path: string): monaco.editor.ITextModel | null {
  const target = path.replace(/\\/g, '/').toLowerCase();
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== 'file') continue;
    if (model.uri.fsPath.replace(/\\/g, '/').toLowerCase() === target) return model;
  }
  return null;
}

/**
 * Repaint extension diagnostics.
 *
 * Incremental in the way that matters: a publisher's markers for one file are only handed to Monaco
 * when they actually differ, and a file that dropped out of a publisher's set is cleared rather than
 * left behind. Repainting every marker on every host event is what makes a large workspace with a
 * chatty linter feel slow, and it also resets Monaco's marker decorations needlessly.
 */
export async function refreshDiagnostics(): Promise<void> {
  const published = await window.axiom.host.diagnostics().catch(() => []);
  const seenOwners = new Set<string>();
  for (const entry of published) {
    seenOwners.add(entry.owner);
    const byPath = new Map<string, HostDiagnostic[]>();
    for (const diagnostic of entry.diagnostics) {
      const list = byPath.get(diagnostic.path);
      if (list === undefined) byPath.set(diagnostic.path, [diagnostic]);
      else list.push(diagnostic);
    }
    const previous = painted.get(entry.owner) ?? new Map<string, string>();
    const current = new Map<string, string>();
    for (const [path, diagnostics] of byPath) {
      const model = modelForPath(path);
      if (model === null) continue;
      const markers = diagnostics.map(toMarker);
      const signature = JSON.stringify(markers);
      current.set(path, signature);
      if (previous.get(path) === signature) continue;
      monaco.editor.setModelMarkers(model, markerOwner(entry.owner), markers);
    }
    for (const path of previous.keys()) {
      if (current.has(path)) continue;
      const model = modelForPath(path);
      if (model !== null) monaco.editor.setModelMarkers(model, markerOwner(entry.owner), []);
    }
    painted.set(entry.owner, current);
  }
  // A collection that was disposed publishes nothing at all, so its markers have to be cleared here.
  for (const [owner, files] of painted) {
    if (seenOwners.has(owner)) continue;
    for (const path of files.keys()) {
      const model = modelForPath(path);
      if (model !== null) monaco.editor.setModelMarkers(model, markerOwner(owner), []);
    }
    painted.delete(owner);
  }
}

/* ------------------------------------------------------------ applying edits */

/**
 * Apply text edits Main asked the editor to make.
 *
 * These are the entries a validated `WorkspaceEdit` could not be applied on disk: the document is
 * open (its buffer is the truth, and the user expects one undo step), it is `untitled:` (there is no
 * file yet), or the edit is a snippet. Grouping per model is what makes a multi-file rename one undo
 * step per file rather than one per edit.
 */
export async function applyEditorEdits(payload: ExtensionApplyEditPayload): Promise<boolean> {
  let applied = false;
  for (const entry of payload.entries) {
    const model = findModel(entry.uri);
    if (model !== null) {
      model.pushStackElement();
      model.pushEditOperations(
        null,
        entry.edits.map((edit) => ({
          range: new monaco.Range(
            edit.range.start.line + 1,
            edit.range.start.character + 1,
            edit.range.end.line + 1,
            edit.range.end.character + 1,
          ),
          text: edit.insertAsSnippet === true ? collapseSnippet(edit.newText).text : edit.newText,
        })),
        () => null,
      );
      model.pushStackElement();
      applied = true;
      continue;
    }
    // Main only sends closed-file entries when it decided the editor must handle them — a snippet,
    // or a URI it cannot map to a path. A snippet is collapsed to its inserted text rather than
    // written verbatim, which would put `${1:name}` in the user's file.
    let path: string;
    try {
      path = monaco.Uri.parse(entry.uri).fsPath;
    } catch {
      continue;
    }
    if (path.length === 0) continue;
    try {
      const file = await window.axiom.fs.readFile(path);
      const updated = applyTextEdits(
        file.content,
        entry.edits.map((edit) => ({
          range: edit.range,
          newText:
            edit.insertAsSnippet === true ? collapseSnippet(edit.newText).text : edit.newText,
        })),
      );
      if (updated !== file.content) {
        await window.axiom.fs.writeFile(path, updated);
        applied = true;
      }
    } catch {
      /* a file that cannot be read or written is reported as not applied */
    }
  }
  return applied;
}

/** Hand Main the part of a provider edit the editor could not apply. */
export async function applyProviderResidue(edit: ExtensionProviderEditInput): Promise<boolean> {
  if (edit.entries.length === 0) return true;
  return window.axiom.languageProviders.applyProviderEdit(edit).catch(() => false);
}

/* ---------------------------------------------------------------- subscriptions */

let bridgesStarted = false;

/**
 * Subscribe to the two things the hosts push at the editor: diagnostics and edits.
 *
 * Diagnostics are pulled on every host change rather than streamed per collection, because
 * `languages.createDiagnosticCollection` has no per-collection channel and the pull is cheap next to
 * the repaint it avoids when nothing differs.
 */
export function startExtensionBridges(): void {
  if (bridgesStarted) return;
  bridgesStarted = true;
  window.axiom.host.onChanged(() => {
    void refreshDiagnostics();
  });
  window.axiom.languageProviders.onApplyEdit((payload) => {
    void applyEditorEdits(payload);
  });
  void refreshDiagnostics();
}
