/**
 * Extension language providers, registered with Monaco (PRD Phase 6).
 *
 * Main owns the provider registry; this module owns Monaco's. It reads the registry as one snapshot
 * and registers **one Monaco provider per extension provider handle**, with the extension's own
 * `DocumentSelector` passed straight through as Monaco's `LanguageSelector`. That is what makes
 * ordering and coexistence match VS Code without reimplementing either: Monaco scores selectors and
 * merges results with the same code the real workbench uses, and each request names exactly one
 * provider so Main routes it without scoring anything a second time.
 *
 * Four of the twenty-eight features have no Monaco registration to bridge —
 * `registerWorkspaceSymbolProvider`, `registerCallHierarchyProvider`, `registerTypeHierarchyProvider`
 * and `registerInlineValuesProvider` do not exist in the standalone editor API. Those are exported as
 * query functions instead, and answered by Main's own selector scoring. Inventing a Monaco
 * registration for them would mean monkey-patching the editor, which this file does not do: every
 * registration below is a public `monaco.languages.register*` call.
 *
 * Provider commands are the other thing the renderer cannot do itself. An extension's command runs in
 * its host, so a `Command` on a completion, lens, action or hint becomes an invocation of one shim id
 * carrying the real command as data — the same indirection the language-server path uses.
 *
 * A provider that fires its own change event (`onDidChangeCodeLenses` and the four others) is
 * refreshed per handle, through the emitter this module hands Monaco — not by rebuilding the snapshot.
 */
import { monaco } from './monacoEnv';
import {
  applyResolvedExtensionCompletion,
  applyResolvedInlayHint,
  hierarchyItemToRef,
  splitWorkspaceEdit,
  toMonacoCodeAction,
  toMonacoCodeLens,
  toMonacoColorInformation,
  toMonacoColorPresentation,
  toMonacoCompletionList,
  toMonacoDocumentSymbols,
  toMonacoFoldingRange,
  toMonacoHighlight,
  toMonacoHover,
  toMonacoInlayHint,
  toMonacoLanguageConfiguration,
  toMonacoLink,
  toMonacoLinkedEditingRanges,
  toMonacoLocationLinks,
  toMonacoRenameLocation,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSemanticTokensEdits,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  type CodeActionResidue,
  type ExtensionCodeAction,
  type ExtensionCodeLens,
  type ExtensionCompletionItem,
  type ExtensionInlayHint,
  type ExtensionLink,
  type SplitWorkspaceEdit,
} from './extensionLanguageConvert';
import {
  applyProviderResidue,
  flushDocument,
  refreshDiagnostics,
  requestProvider,
  startDocumentSync,
  startExtensionBridges,
} from './extensionLanguageClient';
import {
  findModel,
  markerToLspSeverity,
  monacoPositionToLsp,
  monacoRangeToLsp,
} from './lspConvert';
import { notifyError } from '../notifications/bus';
import { isLanguageFeature, normalizeLanguageConfiguration } from '../../../common/vscodeLanguages';
import { normalizeProviderChangeBatch } from '../../../common/vscodeProviderEvents';
import type { LanguageFeature, ProviderOp } from '../../../common/vscodeLanguages';
import type { RefLocation } from '../../../common/callHierarchy';
import type {
  ExtensionLanguageDescriptor,
  ExtensionProviderDescriptor,
  LspDiagnostic,
  LspDocumentSymbol,
  LspFoldingRange,
  LspRange,
  LspSemanticTokens,
  LspSymbolInformation,
} from '../../../common/ipc';
import type {
  WireCodeAction,
  WireCodeLens,
  WireColorInformation,
  WireColorPresentation,
  WireCompletionItem,
  WireCompletionList,
  WireDocumentLink,
  WireHierarchyItem,
  WireHover,
  WireIncomingCall,
  WireInlayHint,
  WireInlineValue,
  WireLinkedEditingRanges,
  WireLocationLink,
  WireOutgoingCall,
  WirePrepareRename,
  WireSelectionRanges,
  WireSignatureHelp,
  WireTextEdit,
  WireWorkspaceEdit,
  WireWorkspaceSymbol,
} from '../../../common/vscodeLanguageWire';

/** Runs an extension command an extension attached to a provider result. */
const RUN_COMMAND_ID = 'axiom.extensions.runCommand';

/** Applies the part of a code action's edit Monaco's bulk-edit service cannot. */
const APPLY_RESIDUE_ID = 'axiom.extensions.applyProviderResidue';

/* --------------------------------------------------------------------- state */

/** The workspace an extension command runs against; `null` until a folder is open. */
let workspaceRoot: string | null = null;

/** Every Monaco registration made from the current snapshot, disposed as a set. */
let registrations: monaco.IDisposable[] = [];

/** Languages already handed to `monaco.languages.register`, which has no disposal. */
const registeredLanguages = new Set<string>();

/** Providers for the four features Monaco cannot register, answered by query functions. */
const queryable = new Map<LanguageFeature, ExtensionProviderDescriptor[]>();

let snapshotRevision = -1;
let started = false;

/** Reloads are serialised: two overlapping rebuilds would dispose each other's registrations. */
let reloadChain: Promise<void> = Promise.resolve();

/* ------------------------------------------------------------------- helpers */

/**
 * The extension's `DocumentSelector` as Monaco's `LanguageSelector`.
 *
 * Passed through rather than translated. Both sides mean the same thing by `language`, `scheme` and
 * `pattern`, and `'*'` is a wildcard in both, so re-deriving a selector here would only be a chance to
 * disagree with the scoring Main already does. An empty selector matches nothing and is skipped.
 */
function selectorOf(
  descriptor: ExtensionProviderDescriptor,
): monaco.languages.LanguageSelector | null {
  const filters: monaco.languages.LanguageFilter[] = [];
  for (const entry of descriptor.selector) {
    const filter: monaco.languages.LanguageFilter = {
      ...(entry.language === undefined ? {} : { language: entry.language }),
      ...(entry.scheme === undefined ? {} : { scheme: entry.scheme }),
      ...(entry.pattern === undefined ? {} : { pattern: entry.pattern }),
      ...(entry.notebookType === undefined ? {} : { notebookType: entry.notebookType }),
    };
    if (Object.keys(filter).length > 0) filters.push(filter);
  }
  return filters.length === 0 ? null : filters;
}

/** How a provider names itself in the editor's "format with…" and marker surfaces. */
function labelOf(descriptor: ExtensionProviderDescriptor): string {
  return descriptor.displayName ?? descriptor.extensionId;
}

/**
 * One provider invocation.
 *
 * Pending edits for the document are flushed first. A provider that is asked about version 7 while the
 * host still holds version 5 answers about text the user has already changed, and the ranges it
 * returns land in the wrong place — so "no stale document state" is enforced here, at the one place
 * every request passes through, rather than trusted to the debounce having elapsed.
 */
async function ask<T>(
  handle: number,
  feature: LanguageFeature,
  op: ProviderOp,
  uri: string | null,
  payload: Record<string, unknown>,
  token: monaco.CancellationToken,
): Promise<T | null> {
  if (uri !== null) await flushDocument(uri);
  if (token.isCancellationRequested) return null;
  return requestProvider<T>(
    { feature, op, handle, payload, ...(uri === null ? {} : { uri }) },
    token,
  );
}

/** A request for a feature Monaco cannot register: no handle, so Main scores the selectors. */
async function askAny<T>(
  feature: LanguageFeature,
  op: ProviderOp,
  uri: string | null,
  payload: Record<string, unknown>,
  token?: monaco.CancellationToken,
): Promise<T | null> {
  if (queryable.get(feature) === undefined) return null;
  const source = token === undefined ? new monaco.CancellationTokenSource() : null;
  const live = token ?? (source as monaco.CancellationTokenSource).token;
  try {
    if (uri !== null) await flushDocument(uri);
    return await requestProvider<T>(
      { feature, op, payload, ...(uri === null ? {} : { uri }) },
      live,
    );
  } finally {
    source?.dispose();
  }
}

/** The word Monaco would replace, used when a completion expresses no range of its own. */
function wordRange(model: monaco.editor.ITextModel, position: monaco.IPosition): monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
}

/** A marker in Monaco's code-action context as the diagnostic the provider expects. */
function markerToDiagnostic(marker: monaco.editor.IMarkerData): LspDiagnostic {
  const code = marker.code;
  const diagnostic: LspDiagnostic = {
    range: monacoRangeToLsp(marker),
    message: marker.message,
    severity: markerToLspSeverity(marker.severity),
  };
  if (marker.source !== undefined) diagnostic.source = marker.source;
  if (typeof code === 'string') diagnostic.code = code;
  else if (typeof code === 'object' && code !== null) diagnostic.code = code.value;
  return diagnostic;
}

/* ------------------------------------------------------- applying provider edits */

/**
 * Apply the parts of a provider `WorkspaceEdit` that are not Monaco's to apply.
 *
 * Snippet edits for open documents are applied on the model as one undo step each — Monaco's
 * standalone bulk-edit service ignores `insertAsSnippet` outright, so handing it a snippet edit would
 * write `${1:name}` into the file. Everything else (closed files, created and deleted files, renames)
 * goes to Main, where it is checked against the live workspace roots by the same validator an
 * extension's own `workspace.applyEdit` goes through.
 */
async function applyResidue(split: SplitWorkspaceEdit): Promise<boolean> {
  let applied = false;
  for (const entry of split.localEdits) {
    const model = findModel(entry.uri);
    if (model === null) continue;
    model.pushStackElement();
    model.pushEditOperations(
      null,
      entry.edits.map((edit) => ({ range: edit.range, text: edit.text })),
      () => null,
    );
    model.pushStackElement();
    applied = true;
  }
  if (split.residual !== null) {
    const ok = await applyProviderResidue(split.residual);
    applied = applied || ok;
    // A workspace edit that touched files on disk changes what every linter has to say about them.
    if (ok) void refreshDiagnostics();
  }
  return applied;
}

/** Run one extension command, with the workspace the window currently has open. */
async function runExtensionCommand(command: string, args: unknown[]): Promise<void> {
  try {
    await window.axiom.host.runCommand(command, args, workspaceRoot);
  } catch {
    notifyError(`The command ${command} could not be run.`, { source: 'Extensions' });
  }
}

/* ---------------------------------------------------- provider refresh events */

/**
 * Per-handle change signals.
 *
 * A provider that fires `onDidChangeCodeLenses` is saying its own answers are stale, not that the
 * registry changed — so the signal is keyed by provider handle and reaches exactly the one Monaco
 * registration made for it. Rebuilding the snapshot instead would drop every other provider's caches
 * and re-register twenty-seven features for nothing.
 *
 * `void` is the payload because that is what Monaco's inlay-hint and semantic-token events carry; the
 * two typed `IEvent<this>` are adapted by `selfChangeEvent`.
 */
const changeSignals = new Map<number, monaco.Emitter<void>>();

function changeSignal(handle: number): monaco.Emitter<void> {
  const existing = changeSignals.get(handle);
  if (existing !== undefined) return existing;
  const emitter = new monaco.Emitter<void>();
  changeSignals.set(handle, emitter);
  return emitter;
}

/**
 * The handle's change signal as an event whose payload is the provider itself.
 *
 * Monaco types `CodeLensProvider.onDidChange` and `FoldingRangeProvider.onDidChange` as
 * `IEvent<this>`. Neither the standalone editor nor the workbench reads that payload, but firing
 * `undefined` where the type promises the provider is a lie the next reader has to discover, so the
 * registered object is passed through.
 */
function selfChangeEvent<T>(handle: number, self: () => T): monaco.IEvent<T> {
  const emitter = changeSignal(handle);
  return (listener, thisArg) => emitter.event(() => listener.call(thisArg, self()));
}

/** Listeners on the features Monaco cannot register, which have no provider object to signal. */
const queryableListeners = new Map<LanguageFeature, Set<() => void>>();

/**
 * Subscribe to "an extension's providers for this feature changed".
 *
 * For a feature Monaco cannot register there is no provider object to hang an event on, so the surface
 * that calls the query function subscribes here instead: the debug view re-asks for inline values when
 * a provider says its values moved, exactly as Monaco re-asks for lenses.
 */
export function onExtensionProviderChanged(
  feature: LanguageFeature,
  listener: () => void,
): () => void {
  const listeners = queryableListeners.get(feature) ?? new Set<() => void>();
  queryableListeners.set(feature, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One batch of provider-change notifications from Main.
 *
 * Validated rather than trusted: the payload crosses the preload boundary as `unknown`. A handle this
 * window does not know is dropped — it belongs to a provider registered after the snapshot this module
 * is holding, whose Monaco registration will ask fresh the moment the rebuild lands. A batch minted
 * against a newer revision says this window has not applied that registry yet, so it catches up.
 */
function applyProviderChanges(raw: unknown): void {
  const batch = normalizeProviderChangeBatch(raw);
  if (batch === null) return;
  for (const change of batch.changes) {
    const emitter = changeSignals.get(change.handle);
    if (emitter !== undefined) {
      try {
        emitter.fire();
      } catch {
        // A listener Monaco has already torn down must not cost the rest of the batch its refresh.
      }
    }
    if (!isLanguageFeature(change.feature)) continue;
    for (const listener of queryableListeners.get(change.feature) ?? []) {
      try {
        listener();
      } catch {
        // One subscriber's failure is its own.
      }
    }
  }
  if (batch.revision !== snapshotRevision) scheduleReload();
}

/* -------------------------------------------------------------- registrars */

/** Registers one Monaco provider for one extension provider, or `null` if it cannot be bridged. */
type Registrar = (
  selector: monaco.languages.LanguageSelector,
  descriptor: ExtensionProviderDescriptor,
) => monaco.IDisposable | null;

/**
 * The four navigation features are one request shape.
 *
 * `Location` and `LocationLink` arrive in the same wire form, and Monaco's `LocationLink` is a
 * superset of its `Location`, so one conversion serves definition, type definition, implementation
 * and declaration alike.
 */
function navigate(
  feature: LanguageFeature,
  descriptor: ExtensionProviderDescriptor,
): (
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  token: monaco.CancellationToken,
) => Promise<monaco.languages.LocationLink[] | null> {
  return async (model, position, token) => {
    const links = await ask<WireLocationLink[]>(
      descriptor.handle,
      feature,
      'provide',
      model.uri.toString(),
      { position: monacoPositionToLsp(position) },
      token,
    );
    return links === null ? null : toMonacoLocationLinks(links);
  };
}

const REGISTRARS: Partial<Record<LanguageFeature, Registrar>> = {
  completion: (selector, descriptor) =>
    monaco.languages.registerCompletionItemProvider(selector, {
      ...(descriptor.triggerCharacters === undefined
        ? {}
        : { triggerCharacters: [...descriptor.triggerCharacters] }),
      provideCompletionItems: async (model, position, context, token) => {
        const uri = model.uri.toString();
        const list = await ask<WireCompletionList>(
          descriptor.handle,
          'completion',
          'provide',
          uri,
          {
            position: monacoPositionToLsp(position),
            triggerKind: context.triggerKind,
            ...(context.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: context.triggerCharacter }),
          },
          token,
        );
        if (list === null) return null;
        return toMonacoCompletionList(list, wordRange(model, position), {
          uri,
          handle: descriptor.handle,
          shimId: RUN_COMMAND_ID,
        });
      },
      ...(descriptor.hasResolve !== true
        ? {}
        : {
            resolveCompletionItem: async (item, token) => {
              const held = item as ExtensionCompletionItem;
              if (held.axiomId === undefined) return item;
              const resolved = await ask<WireCompletionItem>(
                held.axiomHandle ?? descriptor.handle,
                'completion',
                'resolve',
                null,
                { id: held.axiomId },
                token,
              );
              if (resolved !== null) applyResolvedExtensionCompletion(held, resolved);
              return item;
            },
          }),
    }),

  hover: (selector, descriptor) =>
    monaco.languages.registerHoverProvider(selector, {
      provideHover: async (model, position, token) => {
        const value = await ask<WireHover>(
          descriptor.handle,
          'hover',
          'provide',
          model.uri.toString(),
          { position: monacoPositionToLsp(position) },
          token,
        );
        return value === null ? null : toMonacoHover(value);
      },
    }),

  signatureHelp: (selector, descriptor) =>
    monaco.languages.registerSignatureHelpProvider(selector, {
      ...(descriptor.triggerCharacters === undefined
        ? {}
        : { signatureHelpTriggerCharacters: [...descriptor.triggerCharacters] }),
      ...(descriptor.retriggerCharacters === undefined
        ? {}
        : { signatureHelpRetriggerCharacters: [...descriptor.retriggerCharacters] }),
      provideSignatureHelp: async (model, position, token, context) => {
        const help = await ask<WireSignatureHelp>(
          descriptor.handle,
          'signatureHelp',
          'provide',
          model.uri.toString(),
          {
            position: monacoPositionToLsp(position),
            triggerKind: context.triggerKind,
            isRetrigger: context.isRetrigger,
            ...(context.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: context.triggerCharacter }),
          },
          token,
        );
        return help === null ? null : toMonacoSignatureHelp(help);
      },
    }),

  definition: (selector, descriptor) =>
    monaco.languages.registerDefinitionProvider(selector, {
      provideDefinition: navigate('definition', descriptor),
    }),

  typeDefinition: (selector, descriptor) =>
    monaco.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition: navigate('typeDefinition', descriptor),
    }),

  implementation: (selector, descriptor) =>
    monaco.languages.registerImplementationProvider(selector, {
      provideImplementation: navigate('implementation', descriptor),
    }),

  declaration: (selector, descriptor) =>
    monaco.languages.registerDeclarationProvider(selector, {
      provideDeclaration: navigate('declaration', descriptor),
    }),

  reference: (selector, descriptor) =>
    monaco.languages.registerReferenceProvider(selector, {
      provideReferences: async (model, position, context, token) => {
        const links = await ask<WireLocationLink[]>(
          descriptor.handle,
          'reference',
          'provide',
          model.uri.toString(),
          {
            position: monacoPositionToLsp(position),
            includeDeclaration: context.includeDeclaration,
          },
          token,
        );
        return links === null ? null : toMonacoLocationLinks(links);
      },
    }),

  /**
   * Rename.
   *
   * Monaco is handed only the text edits it can apply to models it already has; the rest is applied
   * before returning, because a `RenameProvider` has no follow-up command to carry it and a rename
   * that silently dropped every closed file would be worse than one that failed.
   */
  rename: (selector, descriptor) =>
    monaco.languages.registerRenameProvider(selector, {
      provideRenameEdits: async (model, position, newName, token) => {
        const edit = await ask<WireWorkspaceEdit>(
          descriptor.handle,
          'rename',
          'provide',
          model.uri.toString(),
          { position: monacoPositionToLsp(position), newName },
          token,
        );
        if (edit === null) {
          return {
            edits: [],
            rejectReason: `${labelOf(descriptor)} could not rename that symbol.`,
          };
        }
        const split = splitWorkspaceEdit(edit);
        await applyResidue(split);
        return { edits: split.monacoEdits };
      },
      ...(descriptor.hasPrepare !== true
        ? {}
        : {
            resolveRenameLocation: async (model, position, token) => {
              const value = await ask<WirePrepareRename>(
                descriptor.handle,
                'rename',
                'prepare',
                model.uri.toString(),
                { position: monacoPositionToLsp(position) },
                token,
              );
              if (value === null) return null;
              return toMonacoRenameLocation(value, model.getWordAtPosition(position)?.word ?? '');
            },
          }),
    }),

  documentSymbol: (selector, descriptor) =>
    monaco.languages.registerDocumentSymbolProvider(selector, {
      displayName: labelOf(descriptor),
      provideDocumentSymbols: async (model, token) => {
        const result = await ask<{ symbols: LspDocumentSymbol[]; flat: LspSymbolInformation[] }>(
          descriptor.handle,
          'documentSymbol',
          'provide',
          model.uri.toString(),
          {},
          token,
        );
        return result === null ? null : toMonacoDocumentSymbols(result);
      },
    }),

  formatting: (selector, descriptor) =>
    monaco.languages.registerDocumentFormattingEditProvider(selector, {
      displayName: labelOf(descriptor),
      provideDocumentFormattingEdits: async (model, options, token) => {
        const edits = await ask<WireTextEdit[]>(
          descriptor.handle,
          'formatting',
          'provide',
          model.uri.toString(),
          { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
          token,
        );
        return edits === null ? null : toMonacoTextEdits(edits);
      },
    }),

  rangeFormatting: (selector, descriptor) =>
    monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
      displayName: labelOf(descriptor),
      provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
        const edits = await ask<WireTextEdit[]>(
          descriptor.handle,
          'rangeFormatting',
          'provide',
          model.uri.toString(),
          {
            range: monacoRangeToLsp(range),
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
          },
          token,
        );
        return edits === null ? null : toMonacoTextEdits(edits);
      },
    }),

  onTypeFormatting: (selector, descriptor) => {
    const triggers = [
      ...(descriptor.firstTriggerCharacter === undefined ? [] : [descriptor.firstTriggerCharacter]),
      ...(descriptor.moreTriggerCharacter ?? []),
    ];
    if (triggers.length === 0) return null;
    return monaco.languages.registerOnTypeFormattingEditProvider(selector, {
      autoFormatTriggerCharacters: triggers,
      provideOnTypeFormattingEdits: async (model, position, ch, options, token) => {
        const edits = await ask<WireTextEdit[]>(
          descriptor.handle,
          'onTypeFormatting',
          'provide',
          model.uri.toString(),
          {
            position: monacoPositionToLsp(position),
            ch,
            options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
          },
          token,
        );
        return edits === null ? null : toMonacoTextEdits(edits);
      },
    });
  },

  /**
   * Code actions.
   *
   * The markers Monaco is showing at the range are sent as the context diagnostics, which is what an
   * extension matches its quick fixes against — a code-action provider given an empty diagnostic list
   * offers refactorings and no fixes. `providedCodeActionKinds` is declared when the extension
   * declared it, so Monaco can skip the provider entirely for a kind it does not offer.
   */
  codeAction: (selector, descriptor) =>
    monaco.languages.registerCodeActionProvider(
      selector,
      {
        provideCodeActions: async (model, range, context, token) => {
          const actions = await ask<WireCodeAction[]>(
            descriptor.handle,
            'codeAction',
            'provide',
            model.uri.toString(),
            {
              range: monacoRangeToLsp(range),
              diagnostics: context.markers.map(markerToDiagnostic),
              triggerKind: context.trigger,
              ...(context.only === undefined ? {} : { only: context.only }),
            },
            token,
          );
          if (actions === null) return null;
          const label = labelOf(descriptor);
          return {
            actions: actions.map((action) =>
              toMonacoCodeAction(action, {
                handle: descriptor.handle,
                runCommandId: RUN_COMMAND_ID,
                applyResidueId: APPLY_RESIDUE_ID,
                fallbackSource: label,
              }),
            ),
            dispose: () => undefined,
          };
        },
        ...(descriptor.hasResolve !== true
          ? {}
          : {
              resolveCodeAction: async (action, token) => {
                const held = action as ExtensionCodeAction;
                if (held.axiomId === undefined) return action;
                const resolved = await ask<WireCodeAction>(
                  held.axiomHandle ?? descriptor.handle,
                  'codeAction',
                  'resolve',
                  null,
                  { id: held.axiomId },
                  token,
                );
                if (resolved === null) return action;
                return toMonacoCodeAction(resolved, {
                  handle: held.axiomHandle ?? descriptor.handle,
                  runCommandId: RUN_COMMAND_ID,
                  applyResidueId: APPLY_RESIDUE_ID,
                  fallbackSource: labelOf(descriptor),
                });
              },
            }),
      },
      descriptor.codeActionKinds === undefined
        ? undefined
        : { providedCodeActionKinds: [...descriptor.codeActionKinds] },
    ),

  codeLens: (selector, descriptor) => {
    const provider: monaco.languages.CodeLensProvider = {
      provideCodeLenses: async (model, token) => {
        const lenses = await ask<WireCodeLens[]>(
          descriptor.handle,
          'codeLens',
          'provide',
          model.uri.toString(),
          {},
          token,
        );
        if (lenses === null) return null;
        return {
          lenses: lenses.map((lens) =>
            toMonacoCodeLens(lens, { handle: descriptor.handle, shimId: RUN_COMMAND_ID }),
          ),
          dispose: () => undefined,
        };
      },
      ...(descriptor.hasResolve !== true
        ? {}
        : {
            resolveCodeLens: async (_model, lens, token) => {
              const held = lens as ExtensionCodeLens;
              if (held.axiomId === undefined) return lens;
              const handle = held.axiomHandle ?? descriptor.handle;
              const resolved = await ask<WireCodeLens>(
                handle,
                'codeLens',
                'resolve',
                null,
                { id: held.axiomId },
                token,
              );
              if (resolved === null) return lens;
              return toMonacoCodeLens(resolved, { handle, shimId: RUN_COMMAND_ID });
            },
          }),
    };
    if (descriptor.hasChangeEvent === true) {
      provider.onDidChange = selfChangeEvent(descriptor.handle, () => provider);
    }
    return monaco.languages.registerCodeLensProvider(selector, provider);
  },

  color: (selector, descriptor) =>
    monaco.languages.registerColorProvider(selector, {
      provideDocumentColors: async (model, token) => {
        const colors = await ask<WireColorInformation[]>(
          descriptor.handle,
          'color',
          'provide',
          model.uri.toString(),
          {},
          token,
        );
        return colors === null ? null : colors.map(toMonacoColorInformation);
      },
      provideColorPresentations: async (model, info, token) => {
        const presentations = await ask<WireColorPresentation[]>(
          descriptor.handle,
          'color',
          'presentations',
          model.uri.toString(),
          { color: info.color, range: monacoRangeToLsp(info.range) },
          token,
        );
        return presentations === null ? null : presentations.map(toMonacoColorPresentation);
      },
    }),

  documentHighlight: (selector, descriptor) =>
    monaco.languages.registerDocumentHighlightProvider(selector, {
      provideDocumentHighlights: async (model, position, token) => {
        const highlights = await ask<Array<{ range: LspRange; kind: number }>>(
          descriptor.handle,
          'documentHighlight',
          'provide',
          model.uri.toString(),
          { position: monacoPositionToLsp(position) },
          token,
        );
        return highlights === null ? null : highlights.map(toMonacoHighlight);
      },
    }),

  documentLink: (selector, descriptor) =>
    monaco.languages.registerLinkProvider(selector, {
      provideLinks: async (model, token) => {
        const links = await ask<WireDocumentLink[]>(
          descriptor.handle,
          'documentLink',
          'provide',
          model.uri.toString(),
          {},
          token,
        );
        if (links === null) return null;
        const converted: monaco.languages.ILink[] = [];
        for (const link of links) {
          const one = toMonacoLink(link, { handle: descriptor.handle });
          if (one !== null) converted.push(one);
        }
        return { links: converted };
      },
      ...(descriptor.hasResolve !== true
        ? {}
        : {
            resolveLink: async (link, token) => {
              const held = link as ExtensionLink;
              if (held.axiomId === undefined) return link;
              const handle = held.axiomHandle ?? descriptor.handle;
              const resolved = await ask<WireDocumentLink>(
                handle,
                'documentLink',
                'resolve',
                null,
                { id: held.axiomId },
                token,
              );
              if (resolved === null) return link;
              return toMonacoLink(resolved, { handle }) ?? link;
            },
          }),
    }),

  selectionRange: (selector, descriptor) =>
    monaco.languages.registerSelectionRangeProvider(selector, {
      provideSelectionRanges: async (model, positions, token) => {
        const result = await ask<WireSelectionRanges>(
          descriptor.handle,
          'selectionRange',
          'provide',
          model.uri.toString(),
          { positions: positions.map(monacoPositionToLsp) },
          token,
        );
        return result === null ? null : toMonacoSelectionRanges(result.ranges);
      },
    }),

  foldingRange: (selector, descriptor) => {
    const provider: monaco.languages.FoldingRangeProvider = {
      provideFoldingRanges: async (model, _context, token) => {
        const ranges = await ask<LspFoldingRange[]>(
          descriptor.handle,
          'foldingRange',
          'provide',
          model.uri.toString(),
          {},
          token,
        );
        return ranges === null ? null : ranges.map(toMonacoFoldingRange);
      },
    };
    if (descriptor.hasChangeEvent === true) {
      provider.onDidChange = selfChangeEvent(descriptor.handle, () => provider);
    }
    return monaco.languages.registerFoldingRangeProvider(selector, provider);
  },

  linkedEditingRange: (selector, descriptor) =>
    monaco.languages.registerLinkedEditingRangeProvider(selector, {
      provideLinkedEditingRanges: async (model, position, token) => {
        const value = await ask<WireLinkedEditingRanges>(
          descriptor.handle,
          'linkedEditingRange',
          'provide',
          model.uri.toString(),
          { position: monacoPositionToLsp(position) },
          token,
        );
        return value === null ? null : toMonacoLinkedEditingRanges(value);
      },
    }),

  inlayHint: (selector, descriptor) =>
    monaco.languages.registerInlayHintsProvider(selector, {
      displayName: labelOf(descriptor),
      ...(descriptor.hasChangeEvent !== true
        ? {}
        : { onDidChangeInlayHints: changeSignal(descriptor.handle).event }),
      provideInlayHints: async (model, range, token) => {
        const hints = await ask<WireInlayHint[]>(
          descriptor.handle,
          'inlayHint',
          'provide',
          model.uri.toString(),
          { range: monacoRangeToLsp(range) },
          token,
        );
        if (hints === null) return null;
        return {
          hints: hints.map((hint) => toMonacoInlayHint(hint, { handle: descriptor.handle })),
          dispose: () => undefined,
        };
      },
      ...(descriptor.hasResolve !== true
        ? {}
        : {
            resolveInlayHint: async (hint, token) => {
              const held = hint as ExtensionInlayHint;
              if (held.axiomId === undefined) return hint;
              const resolved = await ask<WireInlayHint>(
                held.axiomHandle ?? descriptor.handle,
                'inlayHint',
                'resolve',
                null,
                { id: held.axiomId },
                token,
              );
              if (resolved !== null) applyResolvedInlayHint(held, resolved);
              return hint;
            },
          }),
    }),

  /**
   * Document semantic tokens.
   *
   * Monaco hands back the `resultId` of the tokens it is holding, and that is what turns the second
   * request for a document into a delta: Main looks up the baseline behind that id and answers with
   * edits — computing them itself if the extension implements only the full method — so a large file
   * is not recoloured from a fresh megabyte of tokens on every keystroke.
   */
  semanticTokens: (selector, descriptor) => {
    const legend = descriptor.legend;
    if (legend === undefined) return null;
    return monaco.languages.registerDocumentSemanticTokensProvider(selector, {
      ...(descriptor.hasChangeEvent !== true
        ? {}
        : { onDidChange: changeSignal(descriptor.handle).event }),
      getLegend: () => ({
        tokenTypes: [...legend.tokenTypes],
        tokenModifiers: [...legend.tokenModifiers],
      }),
      provideDocumentSemanticTokens: async (model, lastResultId, token) => {
        const value = await ask<{
          resultId?: string;
          data?: number[];
          edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
        }>(
          descriptor.handle,
          'semanticTokens',
          lastResultId === null ? 'provide' : 'edits',
          model.uri.toString(),
          lastResultId === null ? {} : { previousResultId: lastResultId },
          token,
        );
        if (value === null) return null;
        if (Array.isArray(value.data)) return toMonacoSemanticTokens(value as LspSemanticTokens);
        if (Array.isArray(value.edits)) {
          return toMonacoSemanticTokensEdits({
            edits: value.edits,
            ...(value.resultId === undefined ? {} : { resultId: value.resultId }),
          });
        }
        return null;
      },
      releaseDocumentSemanticTokens: () => undefined,
    });
  },

  semanticTokensRange: (selector, descriptor) => {
    const legend = descriptor.legend;
    if (legend === undefined) return null;
    return monaco.languages.registerDocumentRangeSemanticTokensProvider(selector, {
      getLegend: () => ({
        tokenTypes: [...legend.tokenTypes],
        tokenModifiers: [...legend.tokenModifiers],
      }),
      provideDocumentRangeSemanticTokens: async (model, range, token) => {
        const value = await ask<LspSemanticTokens>(
          descriptor.handle,
          'semanticTokensRange',
          'provide',
          model.uri.toString(),
          { range: monacoRangeToLsp(range) },
          token,
        );
        return value === null ? null : toMonacoSemanticTokens(value);
      },
    });
  },
};

/* ----------------------------------------------------------------- languages */

/**
 * Apply the languages extensions registered through `vscode.languages.registerLanguage`.
 *
 * `monaco.languages.register` has no disposal and merges a repeated registration into the language it
 * already knows, so a language is registered once and never again — re-registering on every snapshot
 * would append the same file extensions to it over and over. The configuration is disposable and does
 * come back on every rebuild, because an extension can replace or un-set it while running.
 *
 * Manifest `contributes.languages` is applied separately by `contributedLanguages.ts`; this is the
 * dynamic API, and Monaco merging the two is the same thing upstream does with them.
 */
function applyLanguages(descriptors: readonly ExtensionLanguageDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.id.length === 0) continue;
    try {
      if (!registeredLanguages.has(descriptor.id)) {
        monaco.languages.register({
          id: descriptor.id,
          ...(descriptor.extensions.length > 0 ? { extensions: [...descriptor.extensions] } : {}),
          ...(descriptor.filenames.length > 0 ? { filenames: [...descriptor.filenames] } : {}),
          ...(descriptor.filenamePatterns.length > 0
            ? { filenamePatterns: [...descriptor.filenamePatterns] }
            : {}),
          ...(descriptor.aliases.length > 0 ? { aliases: [...descriptor.aliases] } : {}),
          ...(descriptor.mimetypes.length > 0 ? { mimetypes: [...descriptor.mimetypes] } : {}),
          ...(descriptor.firstLine === undefined ? {} : { firstLine: descriptor.firstLine }),
        });
        registeredLanguages.add(descriptor.id);
      }
      if (descriptor.configuration === undefined) continue;
      const configuration = toMonacoLanguageConfiguration(
        normalizeLanguageConfiguration(descriptor.configuration),
      );
      if (Object.keys(configuration).length === 0) continue;
      registrations.push(monaco.languages.setLanguageConfiguration(descriptor.id, configuration));
    } catch {
      // One malformed language contribution must not stop the rest of the snapshot from applying.
    }
  }
}

/* ------------------------------------------------------------ reconciliation */

function disposeRegistrations(): void {
  const previous = registrations;
  registrations = [];
  for (const registration of previous) {
    try {
      registration.dispose();
    } catch {
      // A registration Monaco has already dropped is not an error worth propagating.
    }
  }
  // The change signals belong to the registrations that were just dropped: their handles may not
  // exist in the next snapshot, and Monaco has already released its subscriptions.
  const signals = [...changeSignals.values()];
  changeSignals.clear();
  for (const signal of signals) {
    try {
      signal.dispose();
    } catch {
      // Disposing an emitter twice is harmless; refusing to continue would not be.
    }
  }
}

/**
 * Rebuild every Monaco registration from the current registry.
 *
 * Whole-snapshot rather than incremental, and skipped when the revision has not moved. Monaco has no
 * way to update a provider in place, and a half-applied delta would leave a provider registered for
 * an extension that has been uninstalled — which is worse than the cost of re-registering, since
 * registration is a map insertion and the provider is not consulted until a document needs it.
 */
async function reload(): Promise<void> {
  let snapshot;
  try {
    snapshot = await window.axiom.languageProviders.registry();
  } catch {
    return;
  }
  if (snapshot.revision === snapshotRevision) return;
  snapshotRevision = snapshot.revision;
  disposeRegistrations();
  queryable.clear();
  applyLanguages(snapshot.languages);
  for (const [feature, descriptors] of Object.entries(snapshot.features)) {
    if (!isLanguageFeature(feature)) continue;
    const registrar = REGISTRARS[feature];
    if (registrar === undefined) {
      queryable.set(feature, descriptors);
      continue;
    }
    for (const descriptor of descriptors) {
      const selector = selectorOf(descriptor);
      if (selector === null) continue;
      try {
        const registration = registrar(selector, descriptor);
        if (registration !== null) registrations.push(registration);
      } catch {
        // A selector Monaco refuses costs that one provider its registration, not the snapshot.
      }
    }
  }
}

/** Queue a rebuild behind any rebuild already running, so two never interleave. */
function scheduleReload(): void {
  reloadChain = reloadChain.then(reload).catch(() => undefined);
}

/* ------------------------------------------------------------- command shims */

/**
 * Apply a code action's residue, then run the command it also carried.
 *
 * In that order, because the command an extension attaches to an action expects the action's edit to
 * have happened — "organise imports, then save" is not the same as the reverse. Monaco has already
 * applied the edits it could by the time this runs, since it applies `edit` before invoking `command`.
 */
async function applyCodeActionResidue(residue: CodeActionResidue): Promise<void> {
  await applyResidue({
    monacoEdits: [],
    localEdits: residue.localEdits,
    residual: residue.residual,
  });
  if (residue.command !== null) {
    await runExtensionCommand(residue.command.command, residue.command.arguments ?? []);
  }
}

/** The two commands provider results point at. Registered once; Monaco keeps them for the session. */
function registerCommandShims(): void {
  monaco.editor.registerCommand(RUN_COMMAND_ID, (_accessor, command: unknown, args: unknown) => {
    if (typeof command !== 'string' || command.length === 0) return;
    void runExtensionCommand(command, Array.isArray(args) ? args : []);
  });
  monaco.editor.registerCommand(APPLY_RESIDUE_ID, (_accessor, residue: unknown) => {
    if (typeof residue !== 'object' || residue === null) return;
    void applyCodeActionResidue(residue as CodeActionResidue);
  });
}

/* -------------------------------------------------- features Monaco cannot register */

/**
 * Workspace symbols from every extension whose selector matches.
 *
 * No Monaco registration exists for this, so Main scores the selectors and merges the results — which
 * is why these providers register for `{ scheme: '*' }` and why the request carries no handle. Each
 * symbol keeps the `id` its provider minted, which is what `resolveWorkspaceSymbol` needs.
 */
export async function queryWorkspaceSymbols(
  query: string,
  token?: monaco.CancellationToken,
): Promise<WireWorkspaceSymbol[]> {
  const symbols = await askAny<WireWorkspaceSymbol[]>(
    'workspaceSymbol',
    'provide',
    null,
    { query },
    token,
  );
  return symbols ?? [];
}

/**
 * Fill in the symbol the user picked, if its provider left it to be resolved.
 *
 * `resolveWorkspaceSymbol` is what lets a provider answer a query from a cheap index and compute the
 * real `location.range` for the one symbol that is about to be opened. The `id` is the token Main
 * routes back to the provider that minted the symbol, so no handle is passed here either. A symbol
 * with no id, a provider without the method, and a provider that answers `undefined` all resolve to
 * the item unchanged — which is exactly what upstream does with an unresolvable symbol.
 */
export async function resolveWorkspaceSymbol(
  symbol: WireWorkspaceSymbol,
  token?: monaco.CancellationToken,
): Promise<WireWorkspaceSymbol> {
  if (symbol.id === undefined) return symbol;
  const resolved = await askAny<LspSymbolInformation>(
    'workspaceSymbol',
    'resolve',
    null,
    { id: symbol.id },
    token,
  );
  return resolved === null ? symbol : { ...resolved, id: symbol.id };
}

/** The call-hierarchy roots at a position, as the items the traversal functions take. */
export async function prepareCallHierarchy(
  uri: string,
  position: { line: number; character: number },
  token?: monaco.CancellationToken,
): Promise<WireHierarchyItem[]> {
  const items = await askAny<WireHierarchyItem[]>(
    'callHierarchy',
    'prepare',
    uri,
    { position },
    token,
  );
  return items ?? [];
}

/** Callers of one hierarchy item. Routed by the item's own token, back to the provider that made it. */
export async function callHierarchyIncoming(
  item: WireHierarchyItem,
  token?: monaco.CancellationToken,
): Promise<WireIncomingCall[]> {
  if (item.id === undefined) return [];
  const calls = await askAny<WireIncomingCall[]>(
    'callHierarchy',
    'incoming',
    null,
    { id: item.id },
    token,
  );
  return calls ?? [];
}

/** Callees of one hierarchy item. */
export async function callHierarchyOutgoing(
  item: WireHierarchyItem,
  token?: monaco.CancellationToken,
): Promise<WireOutgoingCall[]> {
  if (item.id === undefined) return [];
  const calls = await askAny<WireOutgoingCall[]>(
    'callHierarchy',
    'outgoing',
    null,
    { id: item.id },
    token,
  );
  return calls ?? [];
}

/** The type-hierarchy roots at a position. */
export async function prepareTypeHierarchy(
  uri: string,
  position: { line: number; character: number },
  token?: monaco.CancellationToken,
): Promise<WireHierarchyItem[]> {
  const items = await askAny<WireHierarchyItem[]>(
    'typeHierarchy',
    'prepare',
    uri,
    { position },
    token,
  );
  return items ?? [];
}

/** Supertypes or subtypes of one type-hierarchy item, with their own positions. */
export async function typeHierarchyRelated(
  item: WireHierarchyItem,
  direction: 'supertypes' | 'subtypes',
  token?: monaco.CancellationToken,
): Promise<Array<{ item: WireHierarchyItem; location: RefLocation | null }>> {
  if (item.id === undefined) return [];
  const items = await askAny<WireHierarchyItem[]>(
    'typeHierarchy',
    direction,
    null,
    { id: item.id },
    token,
  );
  return (items ?? []).map((entry) => ({ item: entry, location: hierarchyItemToRef(entry) }));
}

/**
 * Inline values for a stopped frame.
 *
 * Standalone Monaco has no inline-value provider to register, so the debug surfaces read this
 * directly. The three result kinds come back as the provider produced them: only `InlineValueText` is
 * already a label, a variable lookup has to be found in the stopped frame's scopes, and an
 * evaluatable expression costs an `evaluate` round trip — so `common/inlineValues` is what turns them
 * into the lookups the debugger must answer and the text drawn at the end of each line.
 */
export async function queryInlineValues(
  uri: string,
  range: LspRange,
  frameId: number,
  stoppedLocation: LspRange,
  token?: monaco.CancellationToken,
): Promise<WireInlineValue[]> {
  const values = await askAny<WireInlineValue[]>(
    'inlineValue',
    'provide',
    uri,
    { range, frameId, stoppedLocation },
    token,
  );
  return values ?? [];
}

/* ------------------------------------------------------------------ lifecycle */

/** The workspace extension commands run against. Set from the window's workspace state. */
export function setExtensionLanguageRoot(root: string | null): void {
  workspaceRoot = root;
}

/**
 * Start the extension language platform. Idempotent.
 *
 * Document synchronisation starts before the first registry read, so a provider registered a moment
 * later is asked about documents the hosts already know. The registry is then rebuilt on every host
 * change — a provider registered during activation, an extension stopped, a configuration replaced.
 */
export function initExtensionLanguages(): void {
  if (started) return;
  started = true;
  registerCommandShims();
  startDocumentSync();
  startExtensionBridges();
  window.axiom.languageProviders.onChanged(scheduleReload);
  window.axiom.languageProviders.onProviderChanged(applyProviderChanges);
  window.axiom.host.onChanged(scheduleReload);
  scheduleReload();
}
