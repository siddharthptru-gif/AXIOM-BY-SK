import { monaco } from './monacoEnv';
import { LspSync } from './lspSync';
import {
  applyResolvedCompletion,
  applyTextEdits,
  findModel,
  foldingKind,
  highlightKind,
  lspRangeToMonaco,
  markerToLspSeverity,
  monacoPositionToLsp,
  monacoRangeToLsp,
  textEditToMonaco,
  toMonacoCompletion,
  toMonacoSymbol,
  type LspBackedCompletionItem,
} from './lspConvert';
import { monacoLanguageIds } from '../../../common/lspServers';
import { requestAiAction } from './aiActionBus';
import { notifyError, notifyInfo } from '../notifications/bus';
import { onFileSaved } from '../state/fileEvents';
import type {
  LspCodeAction,
  LspDiagnostic,
  LspServerStatus,
  LspTextEdit,
} from '../../../common/ipc';

/**
 * Renderer-side LSP integration (PRD Part VII §107/§109).
 *
 * Registers Monaco providers for every capability the Main-side client supports
 * and routes them over IPC. `monacoEnv` loads Monarch only (no built-in TS
 * worker), so these are the sole language providers — no duplication.
 *
 * Notable behaviours beyond plain request forwarding:
 *   • Requests are CANCELLED when Monaco abandons them, so a superseded
 *     completion stops costing the server work rather than just being ignored.
 *   • Completions are RESOLVED lazily, which is what supplies documentation and
 *     the import statement behind an auto-import.
 *   • Code actions that carry only a COMMAND are kept and executed server-side.
 *     Organize-imports and most refactors are command-only; dropping them is why
 *     the quick-fix menu used to look thin.
 *   • Every diagnostic also offers "Explain with AI" and "Fix with AI".
 */

const MONACO_LANGS = monacoLanguageIds();
/** Trigger characters, unioned across the registry so one provider serves all. */
const REGISTRY_TRIGGERS = ['.', '"', "'", '/', '@', '<', ':', '-', '=', ' ', '$', '#'];
const SIGNATURE_TRIGGERS = ['(', ','];
const SIGNATURE_RETRIGGERS = [')'];
/** Command ids Monaco invokes when the user picks a server-backed action. */
const RUN_CODE_ACTION_COMMAND = 'axiom.lsp.runCodeAction';
const RUN_COMPLETION_COMMAND = 'axiom.lsp.runCompletionCommand';
const AI_DIAGNOSTIC_COMMAND = 'axiom.lsp.aiDiagnostic';

let workspaceRoot: string | null = null;
let initialized = false;
let sync: LspSync | null = null;
/** Set by App: opens a file in the workbench at a line/column (cross-file nav). */
let navigate: ((path: string, line: number, column: number) => void) | null = null;
/** Latest known health of each language server, for the status surface. */
const serverStatuses = new Map<string, LspServerStatus>();
const statusListeners = new Set<(statuses: LspServerStatus[]) => void>();

/** App keeps the current workspace root here so servers can scope to the project. */
export function setLspWorkspaceRoot(root: string | null): void {
  if (root === workspaceRoot) return;
  const previous = workspaceRoot;
  workspaceRoot = root;
  serverStatuses.clear();
  emitStatuses();
  sync?.reconcileRoot(previous, root);
  if (root) void refreshServerStatuses();
}

/** App wires cross-file go-to-definition / references navigation here. */
export function setLspNavigator(fn: (path: string, line: number, column: number) => void): void {
  navigate = fn;
}

/** Tell the servers a file was saved (ESLint/Prettier act on save). */
export function notifyLspSaved(path: string): void {
  sync?.didSave(path);
}

/** Subscribe to language-server health. Returns an unsubscribe fn. */
export function subscribeLspServers(
  listener: (statuses: LspServerStatus[]) => void,
): () => void {
  statusListeners.add(listener);
  listener(currentServerStatuses());
  return () => statusListeners.delete(listener);
}

export function currentServerStatuses(): LspServerStatus[] {
  return [...serverStatuses.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function emitStatuses(): void {
  const snapshot = currentServerStatuses();
  for (const listener of statusListeners) listener(snapshot);
}

async function refreshServerStatuses(): Promise<void> {
  const root = workspaceRoot;
  if (!root) return;
  const statuses = await window.axiom.lsp.serverStatuses(root).catch(() => []);
  if (workspaceRoot !== root) return;
  for (const status of statuses) serverStatuses.set(status.id, status);
  emitStatuses();
}

/** Restart one language server from the UI. */
export async function restartLspServer(serverId: string): Promise<void> {
  const root = workspaceRoot;
  if (!root) return;
  await window.axiom.lsp.restartServer(root, serverId).catch(() => undefined);
  await refreshServerStatuses();
}

// ---- Cancellation ----------------------------------------------------------

let nextRequestId = 1;

/**
 * Run a request under Monaco's cancellation token. When Monaco abandons the
 * request — the user typed another character, moved the cursor, closed the
 * widget — Main is told to send `$/cancelRequest`, so the language server stops
 * computing a result nobody will read. This is the difference between an editor
 * that stays responsive under fast typing and one that queues up stale work.
 */
async function cancellable<T>(
  token: monaco.CancellationToken,
  run: (requestId: number) => Promise<T>,
  fallback: T,
): Promise<T> {
  const requestId = nextRequestId++;
  const subscription = token.onCancellationRequested(() => {
    void window.axiom.lsp.cancel(requestId).catch(() => undefined);
  });
  try {
    if (token.isCancellationRequested) return fallback;
    return await run(requestId);
  } catch {
    return fallback;
  } finally {
    subscription.dispose();
  }
}

/** True when this model is one the language servers are tracking. */
function active(model: monaco.editor.ITextModel): boolean {
  return workspaceRoot !== null && model.uri.scheme === 'file' && sync !== null;
}

// ---- Diagnostics-driven AI actions -----------------------------------------

interface AiDiagnosticPayload {
  mode: 'explain' | 'fix';
  message: string;
  code: string;
  language: string;
  fileLabel: string;
  startLine: number;
  endLine: number;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Build the AI request for a diagnostic: the marker's own text plus the lines it
 * points at, so the model sees the error and the code that caused it.
 */
function aiPayloadForMarker(
  model: monaco.editor.ITextModel,
  marker: monaco.editor.IMarkerData,
  mode: 'explain' | 'fix',
): AiDiagnosticPayload {
  const startLine = Math.max(1, marker.startLineNumber - 2);
  const endLine = Math.min(model.getLineCount(), marker.endLineNumber + 2);
  const code = model.getValueInRange(
    new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)),
  );
  const label = marker.code === undefined ? '' : ` [${typeof marker.code === 'string' ? marker.code : marker.code.value}]`;
  return {
    mode,
    message: `${marker.message}${label}${marker.source ? ` (${marker.source})` : ''}`,
    code,
    language: model.getLanguageId(),
    fileLabel: baseName(model.uri.fsPath),
    startLine,
    endLine,
  };
}

function runAiDiagnostic(payload: AiDiagnosticPayload): void {
  const instruction =
    payload.mode === 'explain'
      ? `Explain this diagnostic: ${payload.message}\n\nSay why it happens, how to fix it, the best practice, and show a corrected example.`
      : `Fix this diagnostic: ${payload.message}\n\nReturn the corrected code.`;
  requestAiAction({
    kind: payload.mode === 'explain' ? 'explain' : 'fix',
    code: `${instruction}\n\n${payload.code}`,
    fileLabel: payload.fileLabel,
    language: payload.language,
    startLine: payload.startLine,
    endLine: payload.endLine,
    ...(payload.mode === 'explain' ? { depth: 'normal' as const } : {}),
  });
}

// ---- Code actions ----------------------------------------------------------

/** A Monaco code action that remembers the Main-side handle behind it. */
interface LspBackedCodeAction extends monaco.languages.CodeAction {
  axiomHandle?: number;
  axiomUri?: string;
}

/**
 * Convert one server action. An action with an edit is applied by Monaco; an
 * action with only a command is routed back through Main to be executed by the
 * server, which then returns the resulting edits via `workspace/applyEdit`.
 */
function toMonacoCodeAction(action: LspCodeAction, uri: string): LspBackedCodeAction {
  const out: LspBackedCodeAction = { title: action.title };
  if (action.kind !== undefined) out.kind = action.kind;
  if (action.isPreferred === true) out.isPreferred = true;
  if (action.disabledReason !== undefined) out.disabled = action.disabledReason;
  if (action.edit) {
    const edits: monaco.languages.IWorkspaceTextEdit[] = [];
    for (const [target, textEdits] of Object.entries(action.edit.changes)) {
      const model = findModel(target);
      const resource = model ? model.uri : monaco.Uri.parse(target);
      for (const edit of textEdits) {
        edits.push({ resource, textEdit: textEditToMonaco(edit), versionId: undefined });
      }
    }
    if (edits.length > 0) out.edit = { edits };
  }
  if (!out.edit && action.id !== undefined) {
    out.command = {
      id: RUN_CODE_ACTION_COMMAND,
      title: action.title,
      arguments: [uri, action.id],
    };
  }
  if (action.id !== undefined) {
    out.axiomHandle = action.id;
    out.axiomUri = uri;
  }
  return out;
}

// ---- Server-requested edits ------------------------------------------------

/**
 * Apply a `workspace/applyEdit` the server asked for. Open models get real,
 * undoable Monaco edits; files that are not open are written through the
 * authorized filesystem bridge. The answer Main receives is the truth, not an
 * assumption.
 */
async function applyServerEdit(changes: Record<string, LspTextEdit[]>): Promise<boolean> {
  const modelEdits: monaco.languages.IWorkspaceTextEdit[] = [];
  const closedFiles: Array<{ path: string; edits: LspTextEdit[] }> = [];
  for (const [uri, edits] of Object.entries(changes)) {
    const model = findModel(uri);
    if (model) {
      for (const edit of edits) {
        modelEdits.push({
          resource: model.uri,
          textEdit: textEditToMonaco(edit),
          versionId: undefined,
        });
      }
    } else {
      closedFiles.push({ path: monaco.Uri.parse(uri).fsPath, edits });
    }
  }

  let applied = false;
  if (modelEdits.length > 0) {
    // Group per model so each file's edits land as one undo step.
    const byModel = new Map<string, monaco.languages.IWorkspaceTextEdit[]>();
    for (const edit of modelEdits) {
      const key = edit.resource.toString();
      byModel.set(key, [...(byModel.get(key) ?? []), edit]);
    }
    for (const [key, edits] of byModel) {
      const model = monaco.editor.getModel(monaco.Uri.parse(key));
      if (!model) continue;
      model.pushStackElement();
      model.pushEditOperations(
        null,
        edits.map((edit) => ({ range: edit.textEdit.range, text: edit.textEdit.text })),
        () => null,
      );
      model.pushStackElement();
      applied = true;
    }
  }
  for (const { path, edits } of closedFiles) {
    try {
      const file = await window.axiom.fs.readFile(path);
      const updated = applyTextEdits(file.content, edits);
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

// ---- Initialization --------------------------------------------------------

export function initLsp(): void {
  if (initialized) return;
  initialized = true;

  const semanticProviders = new Map<string, monaco.IDisposable>();

  sync = new LspSync({
    root: () => workspaceRoot,
    onDocumentSynced: (uri) => {
      void pullDiagnostics(uri);
      void ensureSemanticProvider(uri);
    },
  });
  const syncing = sync;

  /**
   * Pull diagnostics for a document. Servers that prefer the pull model publish
   * nothing until asked, so without this their problems never appear.
   */
  const pullDiagnostics = async (uri: string): Promise<void> => {
    const events = await window.axiom.lsp.pullDiagnostics(uri).catch(() => []);
    for (const event of events) syncing.applyDiagnostics(event.uri, event.diagnostics, event.serverId);
  };

  /**
   * Semantic tokens need their legend up front and Monaco's `getLegend()` is
   * synchronous, so the provider is registered per language only once the
   * server has told us its legend.
   */
  const ensureSemanticProvider = async (uri: string): Promise<void> => {
    const model = findModel(uri);
    if (!model) return;
    const language = model.getLanguageId();
    if (semanticProviders.has(language)) return;
    const legend = await window.axiom.lsp.semanticTokensLegend(uri).catch(() => null);
    if (!legend || legend.tokenTypes.length === 0 || semanticProviders.has(language)) return;

    const disposable = monaco.languages.registerDocumentSemanticTokensProvider(language, {
      getLegend: () => ({
        tokenTypes: legend.tokenTypes,
        tokenModifiers: legend.tokenModifiers,
      }),
      provideDocumentSemanticTokens: async (target, _lastResultId, token) => {
        if (!active(target)) return null;
        const result = await cancellable(
          token,
          (requestId) => window.axiom.lsp.semanticTokens(target.uri.toString(), requestId),
          null,
        );
        if (!result) return null;
        return result.resultId === undefined
          ? { data: new Uint32Array(result.data) }
          : { resultId: result.resultId, data: new Uint32Array(result.data) };
      },
      releaseDocumentSemanticTokens: () => undefined,
    });
    semanticProviders.set(language, disposable);
  };

  // Commands Monaco invokes for server-backed actions. Each passes a handle, so
  // the payload that reaches a language server always comes from Main's copy.
  monaco.editor.registerCommand(RUN_CODE_ACTION_COMMAND, (_accessor, uri: string, handle: number) => {
    if (typeof uri !== 'string' || typeof handle !== 'number') return;
    void window.axiom.lsp
      .executeCodeAction(uri, handle)
      .then((ok) => {
        if (!ok) notifyError('That quick fix could not be applied.', { source: 'Language Server' });
      })
      .catch(() => undefined);
  });

  monaco.editor.registerCommand(
    RUN_COMPLETION_COMMAND,
    (_accessor, uri: string, handle: number) => {
      if (typeof uri !== 'string' || typeof handle !== 'number') return;
      void window.axiom.lsp.executeCompletionCommand(uri, handle).catch(() => undefined);
    },
  );

  monaco.editor.registerCommand(
    AI_DIAGNOSTIC_COMMAND,
    (_accessor, payload: AiDiagnosticPayload) => {
      if (payload && typeof payload.message === 'string') runAiDiagnostic(payload);
    },
  );

  syncing.openModels();
  monaco.editor.onDidCreateModel((model) => syncing.open(model));
  monaco.editor.onWillDisposeModel((model) => syncing.close(model));

  // ESLint and Prettier only re-evaluate a file on save, so the save has to be
  // announced or their diagnostics go stale after a fix.
  onFileSaved((path) => syncing.didSave(path));

  window.axiom.lsp.onDiagnostics((evt) => {
    if (workspaceRoot === null) return;
    const model = findModel(evt.uri);
    if (!model || !syncing.isOpen(model.uri.toString())) return;
    syncing.applyDiagnostics(evt.uri, evt.diagnostics, evt.serverId);
  });

  // Server health drives the status surface, and a crash is announced rather than
  // leaving the user wondering why completions went quiet.
  window.axiom.lsp.onServerStatus((status) => {
    const previous = serverStatuses.get(status.id);
    serverStatuses.set(status.id, status);
    emitStatuses();
    if (status.state === 'failed' && previous?.state !== 'failed' && status.detail) {
      notifyInfo(status.detail, { source: `${status.displayName} language server`, toast: false });
    }
  });

  window.axiom.lsp.onLog((evt) => {
    // Errors and warnings from a server are worth surfacing; log lines are not.
    if (evt.type > 2) return;
    notifyInfo(evt.message, { source: `${evt.serverId} language server`, toast: false });
  });

  window.axiom.lsp.onApplyEdit((request) => {
    void applyServerEdit(request.edit.changes)
      .then((applied) => window.axiom.lsp.applyEditResult(request.nonce, applied))
      .catch(() => window.axiom.lsp.applyEditResult(request.nonce, false));
  });

  // Route cross-file navigation (go-to-definition / references peek) to the
  // workbench, since the standalone Monaco editor has no built-in file opener.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) => {
      if (resource.scheme !== 'file' || !navigate) return false;
      let line = 1;
      let column = 1;
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber;
          column = selectionOrPosition.startColumn;
        } else {
          line = selectionOrPosition.lineNumber;
          column = selectionOrPosition.column;
        }
      }
      navigate(resource.fsPath, line, column);
      return true;
    },
  });

  const locationsToMonaco = (
    locations: Array<{ uri: string; range: import('../../../common/ipc').LspRange }>,
  ): monaco.languages.Location[] =>
    locations.map((loc) => ({
      uri: monaco.Uri.parse(loc.uri),
      range: lspRangeToMonaco(loc.range),
    }));

  for (const lang of MONACO_LANGS) {
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.hover(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.contents.length === 0) return null;
        const hover: monaco.languages.Hover = { contents: [{ value: res.contents }] };
        if (res.range) hover.range = lspRangeToMonaco(res.range);
        return hover;
      },
    });

    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: REGISTRY_TRIGGERS,
      provideCompletionItems: async (model, position, context, token) => {
        if (!active(model)) return { suggestions: [] };
        const uri = model.uri.toString();
        // The server must see the text the cursor is actually in.
        await syncing.flushNow(uri);
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.completion(
              uri,
              position.lineNumber - 1,
              position.column - 1,
              {
                triggerKind: context.triggerKind === 1 ? 2 : context.triggerKind === 2 ? 3 : 1,
                ...(context.triggerCharacter === undefined
                  ? {}
                  : { triggerCharacter: context.triggerCharacter }),
              },
              requestId,
            ),
          null,
        );
        if (!res) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        return {
          suggestions: res.items.map((it) =>
            toMonacoCompletion(it, range, uri, RUN_COMPLETION_COMMAND),
          ),
          // An incomplete list must be recomputed as the user keeps typing,
          // otherwise filtering happens against a truncated set.
          incomplete: res.isIncomplete === true,
        };
      },
      resolveCompletionItem: async (item, token) => {
        const backed = item as LspBackedCompletionItem;
        if (backed.axiomHandle === undefined || backed.axiomUri === undefined) return item;
        const resolved = await cancellable(
          token,
          () =>
            window.axiom.lsp.resolveCompletion(
              backed.axiomUri as string,
              backed.axiomHandle as number,
            ),
          null,
        );
        if (resolved) applyResolvedCompletion(backed, resolved);
        return backed;
      },
    });

    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: SIGNATURE_TRIGGERS,
      signatureHelpRetriggerCharacters: SIGNATURE_RETRIGGERS,
      provideSignatureHelp: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.signatureHelp(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.signatures.length === 0) return null;
        const signatures: monaco.languages.SignatureInformation[] = res.signatures.map((s) => {
          const si: monaco.languages.SignatureInformation = {
            label: s.label,
            parameters: s.parameters.map((p) => {
              const pi: monaco.languages.ParameterInformation = { label: p.label };
              if (p.documentation !== undefined) pi.documentation = p.documentation;
              return pi;
            }),
          };
          if (s.documentation !== undefined) si.documentation = s.documentation;
          return si;
        });
        const activeSignature = res.activeSignature ?? 0;
        // A per-signature active parameter overrides the list-level one, which is
        // what highlights the correct argument in an overloaded call.
        const perSignature = res.signatures[activeSignature]?.activeParameter;
        return {
          value: {
            signatures,
            activeSignature,
            activeParameter: perSignature ?? res.activeParameter ?? 0,
          },
          dispose: () => {},
        };
      },
    });

    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.definition(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.locations.length === 0) return null;
        return locationsToMonaco(res.locations);
      },
    });

    monaco.languages.registerDeclarationProvider(lang, {
      provideDeclaration: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.declaration(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.locations.length === 0) return null;
        return locationsToMonaco(res.locations);
      },
    });

    monaco.languages.registerReferenceProvider(lang, {
      provideReferences: async (model, position, _context, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.references(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res) return null;
        return locationsToMonaco(res.locations);
      },
    });

    monaco.languages.registerTypeDefinitionProvider(lang, {
      provideTypeDefinition: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.typeDefinition(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.locations.length === 0) return null;
        return locationsToMonaco(res.locations);
      },
    });

    monaco.languages.registerImplementationProvider(lang, {
      provideImplementation: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.implementation(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res || res.locations.length === 0) return null;
        return locationsToMonaco(res.locations);
      },
    });

    monaco.languages.registerDocumentHighlightProvider(lang, {
      provideDocumentHighlights: async (model, position, token) => {
        if (!active(model)) return null;
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.documentHighlight(
              model.uri.toString(),
              position.lineNumber - 1,
              position.column - 1,
              requestId,
            ),
          null,
        );
        if (!res) return null;
        return res.highlights.map((h) => ({
          range: lspRangeToMonaco(h.range),
          kind: highlightKind(h.kind),
        }));
      },
    });

    monaco.languages.registerRenameProvider(lang, {
      // Validating before the input box opens is what turns "rename produced
      // nothing" into "rename is not available here", before the user types.
      resolveRenameLocation: async (model, position) => {
        if (!active(model)) {
          return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'No workspace.' };
        }
        const res = await window.axiom.lsp
          .prepareRename(model.uri.toString(), position.lineNumber - 1, position.column - 1)
          .catch(() => null);
        const word = model.getWordAtPosition(position);
        const fallbackRange = word
          ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        if (!res) {
          return {
            range: fallbackRange,
            text: word?.word ?? '',
            rejectReason: 'This symbol cannot be renamed.',
          };
        }
        const range = res.range ? lspRangeToMonaco(res.range) : fallbackRange;
        return { range, text: res.placeholder || model.getValueInRange(range) };
      },
      provideRenameEdits: async (model, position, newName) => {
        if (!active(model)) return { edits: [] };
        const uri = model.uri.toString();
        await syncing.flushNow(uri);
        const res = await window.axiom.lsp
          .rename(uri, position.lineNumber - 1, position.column - 1, newName)
          .catch(() => null);
        if (!res) return { edits: [], rejectReason: 'Rename is not available here.' };

        const monacoEdits: monaco.languages.IWorkspaceTextEdit[] = [];
        const closedFiles: Array<{ path: string; edits: LspTextEdit[] }> = [];
        for (const [target, edits] of Object.entries(res.changes)) {
          const targetModel = findModel(target);
          if (targetModel) {
            for (const e of edits) {
              monacoEdits.push({
                resource: targetModel.uri,
                textEdit: textEditToMonaco(e),
                versionId: undefined,
              });
            }
          } else {
            closedFiles.push({ path: monaco.Uri.parse(target).fsPath, edits });
          }
        }
        // Open models go through Monaco (undoable + preview-safe). Files not open
        // as models are written directly, since standalone Monaco's bulk edit
        // only touches open models.
        await Promise.all(
          closedFiles.map(async ({ path, edits }) => {
            try {
              const file = await window.axiom.fs.readFile(path);
              const updated = applyTextEdits(file.content, edits);
              if (updated !== file.content) await window.axiom.fs.writeFile(path, updated);
            } catch {
              /* skip files that can't be read/written */
            }
          }),
        );
        return { edits: monacoEdits };
      },
    });

    monaco.languages.registerCodeActionProvider(lang, {
      provideCodeActions: async (model, range, context, token) => {
        if (!active(model)) return { actions: [], dispose: () => {} };
        const uri = model.uri.toString();
        // Hand the server the diagnostics it is being asked to fix, including the
        // rule code — that is what turns "no quick fixes" into a real fix list.
        const diagnostics: LspDiagnostic[] = context.markers.map((m) => ({
          range: monacoRangeToLsp(m),
          message: m.message,
          severity: markerToLspSeverity(m.severity),
          ...(m.source === undefined ? {} : { source: m.source }),
          ...(m.code === undefined
            ? {}
            : { code: typeof m.code === 'string' ? m.code : m.code.value }),
        }));
        const only = context.only === undefined ? undefined : [context.only];
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.codeAction(
              uri,
              monacoRangeToLsp(range),
              diagnostics,
              only,
              requestId,
            ),
          [] as LspCodeAction[],
        );
        const actions: monaco.languages.CodeAction[] = res.map((a) => toMonacoCodeAction(a, uri));

        // Every diagnostic on this range also gets an AI explanation and an AI
        // fix, so an error the server has no quick fix for is still actionable.
        for (const marker of context.markers) {
          if (marker.severity < monaco.MarkerSeverity.Warning) continue;
          for (const mode of ['explain', 'fix'] as const) {
            const payload = aiPayloadForMarker(model, marker, mode);
            actions.push({
              title: mode === 'explain' ? 'Axiom AI: Explain this error' : 'Axiom AI: Fix with AI',
              kind: 'quickfix',
              diagnostics: [marker],
              command: {
                id: AI_DIAGNOSTIC_COMMAND,
                title: mode === 'explain' ? 'Explain with AI' : 'Fix with AI',
                arguments: [payload],
              },
            });
          }
          break; // one pair of AI actions is enough; they cover the whole marker
        }
        return { actions, dispose: () => {} };
      },
      resolveCodeAction: async (codeAction, token) => {
        const backed = codeAction as LspBackedCodeAction;
        if (backed.axiomHandle === undefined || backed.axiomUri === undefined) return codeAction;
        if (backed.edit) return codeAction;
        const resolved = await cancellable(
          token,
          () =>
            window.axiom.lsp.resolveCodeAction(
              backed.axiomUri as string,
              backed.axiomHandle as number,
            ),
          null,
        );
        if (resolved?.edit) {
          const merged = toMonacoCodeAction({ ...resolved, id: backed.axiomHandle }, backed.axiomUri);
          if (merged.edit) backed.edit = merged.edit;
        }
        return backed;
      },
    });

    monaco.languages.registerDocumentSymbolProvider(lang, {
      provideDocumentSymbols: async (model, token) => {
        if (!active(model)) return [];
        const res = await cancellable(
          token,
          (requestId) => window.axiom.lsp.documentSymbol(model.uri.toString(), requestId),
          [],
        );
        return res.map(toMonacoSymbol);
      },
    });

    // Code folding driven by the language server, so functions, classes, imports
    // and #region blocks collapse on real syntax rather than indentation.
    monaco.languages.registerFoldingRangeProvider(lang, {
      provideFoldingRanges: async (model, _context, token) => {
        if (!active(model)) return [];
        const res = await cancellable(
          token,
          (requestId) => window.axiom.lsp.foldingRange(model.uri.toString(), requestId),
          [],
        );
        return res.map((r) => {
          const range: monaco.languages.FoldingRange = {
            start: r.startLine + 1,
            end: r.endLine + 1,
          };
          const kind = foldingKind(r.kind);
          if (kind) range.kind = kind;
          return range;
        });
      },
    });

    monaco.languages.registerSelectionRangeProvider(lang, {
      provideSelectionRanges: async (model, positions) => {
        if (!active(model)) return [];
        const uri = model.uri.toString();
        const ranges = await window.axiom.lsp
          .selectionRange(uri, positions.map(monacoPositionToLsp))
          .catch(() => []);
        if (ranges.length === 0) return [];
        const chain = ranges.map((range) => ({ range: lspRangeToMonaco(range) }));
        return positions.map(() => chain);
      },
    });

    monaco.languages.registerLinkProvider(lang, {
      provideLinks: async (model, token) => {
        if (!active(model)) return { links: [] };
        const res = await cancellable(
          token,
          (requestId) => window.axiom.lsp.documentLink(model.uri.toString(), requestId),
          [],
        );
        return {
          links: res.map((link) => {
            const out: monaco.languages.ILink = { range: lspRangeToMonaco(link.range) };
            if (link.target !== undefined) out.url = link.target;
            if (link.tooltip !== undefined) out.tooltip = link.tooltip;
            return out;
          }),
        };
      },
    });

    monaco.languages.registerInlayHintsProvider(lang, {
      provideInlayHints: async (model, range, token) => {
        if (!active(model)) return { hints: [], dispose: () => {} };
        const res = await cancellable(
          token,
          (requestId) =>
            window.axiom.lsp.inlayHint(model.uri.toString(), monacoRangeToLsp(range), requestId),
          [],
        );
        const hints: monaco.languages.InlayHint[] = res.map((h) => {
          const hint: monaco.languages.InlayHint = {
            position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
            label: h.label,
            kind:
              h.kind === 2
                ? monaco.languages.InlayHintKind.Parameter
                : monaco.languages.InlayHintKind.Type,
          };
          if (h.paddingLeft !== undefined) hint.paddingLeft = h.paddingLeft;
          if (h.paddingRight !== undefined) hint.paddingRight = h.paddingRight;
          return hint;
        });
        return { hints, dispose: () => {} };
      },
    });

    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      provideDocumentFormattingEdits: async (model, options) => {
        if (!active(model)) return [];
        const uri = model.uri.toString();
        await syncing.flushNow(uri);
        const res = await window.axiom.lsp
          .formatting(uri, options.tabSize, options.insertSpaces)
          .catch(() => []);
        return res.map(textEditToMonaco);
      },
    });

    monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
      provideDocumentRangeFormattingEdits: async (model, range, options) => {
        if (!active(model)) return [];
        const uri = model.uri.toString();
        await syncing.flushNow(uri);
        const res = await window.axiom.lsp
          .rangeFormatting(uri, monacoRangeToLsp(range), options.tabSize, options.insertSpaces)
          .catch(() => []);
        return res.map(textEditToMonaco);
      },
    });

    // Format-as-you-type: closing a brace or typing a newline reindents the line
    // through the server's own rules.
    monaco.languages.registerOnTypeFormattingEditProvider(lang, {
      autoFormatTriggerCharacters: ['}', ';', '\n', ')'],
      provideOnTypeFormattingEdits: async (model, position, ch, options) => {
        if (!active(model)) return [];
        const uri = model.uri.toString();
        await syncing.flushNow(uri);
        const res = await window.axiom.lsp
          .onTypeFormatting(
            uri,
            position.lineNumber - 1,
            position.column - 1,
            ch,
            options.tabSize,
            options.insertSpaces,
          )
          .catch(() => []);
        return res.map(textEditToMonaco);
      },
    });
  }
}
