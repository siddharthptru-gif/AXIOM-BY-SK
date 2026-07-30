/**
 * VS Code compatibility layer (Phase 244 — VS Code Compatibility Layer).
 *
 * PURE module (no I/O, no Electron). Classifies the VS Code extension-API surface a
 * candidate extension uses into a SUPPORT level (supported / partial / unsupported)
 * against Axiom's shim, and rolls that up into a per-extension COMPATIBILITY verdict
 * + label — so users see up front whether a given extension will run, partly run, or
 * not run, rather than discovering it at runtime. Heuristic + curated: the actual
 * shim implements the mapping; this is the honest compat classifier + labeler.
 */

export type CompatLevel = 'supported' | 'partial' | 'unsupported';

/**
 * Curated VS Code API → support level (a high-value subset Axiom shims).
 *
 * Kept in step with `extensionHostWorker.ts`: an entry here is a claim that the shim answers that
 * call, and a wrong claim is worse than no claim — a user who installs on the strength of it finds
 * out at runtime. Webviews are Phase 4; tree data providers, `setContext` and the workbench menus
 * are Phase 5; the `languages` provider registrations and `workspace.applyEdit` are Phase 6.
 * Terminals, tasks, debugging, notebooks and the language-model APIs are later phases and stay
 * `unsupported` until the shim answers them.
 */
export const API_SUPPORT: Record<string, CompatLevel> = {
  'window.showInformationMessage': 'supported',
  'window.showWarningMessage': 'supported',
  'window.showErrorMessage': 'supported',
  'window.showQuickPick': 'supported',
  'window.showInputBox': 'supported',
  'window.setStatusBarMessage': 'supported',
  'window.createStatusBarItem': 'supported',
  'window.createOutputChannel': 'supported',
  'window.createLogOutputChannel': 'supported',
  'window.withProgress': 'supported',
  'commands.registerCommand': 'supported',
  'commands.executeCommand': 'supported',
  'workspace.getConfiguration': 'supported',
  'workspace.onDidChangeConfiguration': 'supported',
  'workspace.findFiles': 'supported',
  'languages.createDiagnosticCollection': 'supported',
  // Phase 4 — the webview runtime: panels, sidebar view providers, and serialised restoration.
  'window.createWebviewPanel': 'supported',
  'window.registerWebviewViewProvider': 'supported',
  'window.registerWebviewPanelSerializer': 'supported',
  // Phase 4 — identity and storage.
  'authentication.getSession': 'supported',
  'secrets.get': 'supported',
  'secrets.store': 'supported',
  'secrets.onDidChange': 'supported',
  'window.registerUriHandler': 'supported',
  'env.asExternalUri': 'supported',
  // Phase 5 — the contributed workbench.
  'window.createTreeView': 'supported',
  'window.registerTreeDataProvider': 'supported',
  'commands.setContext': 'supported',
  /*
   * Phase 6 — the language platform. Phase 7 finished it.
   *
   * Most entries here are provider registrations the shim forwards to a real registry, whose results
   * reach Monaco through one of its own `register*Provider` calls. Four have no Monaco registration to
   * forward to — workspace symbol, call hierarchy, type hierarchy and inline values are workbench
   * features upstream, not editor widgets — so AXIOM answers them from its own surfaces instead, and
   * as of Phase 7 each has the surface the API is specified against: workspace symbols answer Quick
   * Open and resolve the picked one through `resolveWorkspaceSymbol` (provider-minted ids carry the
   * identity the resolve call needs), call hierarchy and type hierarchy both expand lazily in either
   * direction — callers and callees, supertypes and subtypes — and inline values are drawn at the end
   * of the lines they belong to while a debug session is paused. All four register, dispose, honour
   * cancellation and re-query on `onDidChange*` exactly as the registered kinds do.
   */
  'languages.registerCompletionItemProvider': 'supported',
  'languages.registerHoverProvider': 'supported',
  'languages.registerSignatureHelpProvider': 'supported',
  'languages.registerDefinitionProvider': 'supported',
  'languages.registerTypeDefinitionProvider': 'supported',
  'languages.registerImplementationProvider': 'supported',
  'languages.registerDeclarationProvider': 'supported',
  'languages.registerReferenceProvider': 'supported',
  'languages.registerRenameProvider': 'supported',
  'languages.registerDocumentSymbolProvider': 'supported',
  'languages.registerDocumentFormattingEditProvider': 'supported',
  'languages.registerDocumentRangeFormattingEditProvider': 'supported',
  'languages.registerOnTypeFormattingEditProvider': 'supported',
  'languages.registerCodeActionsProvider': 'supported',
  'languages.registerCodeLensProvider': 'supported',
  'languages.registerDocumentColorProvider': 'supported',
  'languages.registerColorProvider': 'supported',
  'languages.registerDocumentHighlightProvider': 'supported',
  'languages.registerDocumentLinkProvider': 'supported',
  'languages.registerSelectionRangeProvider': 'supported',
  'languages.registerFoldingRangeProvider': 'supported',
  'languages.registerLinkedEditingRangeProvider': 'supported',
  'languages.registerInlayHintsProvider': 'supported',
  'languages.registerDocumentSemanticTokensProvider': 'supported',
  'languages.registerSemanticTokensProvider': 'supported',
  'languages.registerDocumentRangeSemanticTokensProvider': 'supported',
  'languages.registerWorkspaceSymbolProvider': 'supported',
  'languages.registerCallHierarchyProvider': 'supported',
  'languages.registerTypeHierarchyProvider': 'supported',
  'languages.registerInlineValuesProvider': 'supported',
  'languages.registerLanguage': 'supported',
  'languages.setLanguageConfiguration': 'supported',
  'languages.setTextDocumentLanguage': 'supported',
  'languages.getLanguages': 'supported',
  'languages.match': 'supported',
  'languages.getDiagnostics': 'supported',
  // Text edits an extension asks the workbench to make. Validated, then applied to the open buffer
  // when there is one and to the file when there is not; snippets go to the editor.
  'workspace.applyEdit': 'supported',
  /*
   * Phase 6 — the value types a provider builds its answer out of.
   *
   * A probe over bundled code recovers `new vscode.WorkspaceEdit()` as the bare name `WorkspaceEdit`,
   * and without an entry here that fell through to the conservative default and reported an extension
   * as incompatible over a class the shim exports. Every name below is exported by the shim's `vscode`
   * object, so an extension that constructs one gets a real object rather than `undefined`.
   */
  WorkspaceEdit: 'supported',
  TextEdit: 'supported',
  SnippetTextEdit: 'supported',
  SnippetString: 'supported',
  CompletionItem: 'supported',
  CompletionList: 'supported',
  CompletionItemKind: 'supported',
  CompletionItemTag: 'supported',
  CompletionTriggerKind: 'supported',
  Hover: 'supported',
  SignatureHelp: 'supported',
  SignatureInformation: 'supported',
  ParameterInformation: 'supported',
  SignatureHelpTriggerKind: 'supported',
  SymbolInformation: 'supported',
  DocumentSymbol: 'supported',
  SymbolKind: 'supported',
  SymbolTag: 'supported',
  CodeAction: 'supported',
  CodeActionKind: 'supported',
  CodeActionTriggerKind: 'supported',
  CodeLens: 'supported',
  DocumentLink: 'supported',
  Color: 'supported',
  ColorInformation: 'supported',
  ColorPresentation: 'supported',
  DocumentHighlight: 'supported',
  DocumentHighlightKind: 'supported',
  SelectionRange: 'supported',
  FoldingRange: 'supported',
  FoldingRangeKind: 'supported',
  InlayHint: 'supported',
  InlayHintKind: 'supported',
  InlayHintLabelPart: 'supported',
  InlineValueText: 'supported',
  InlineValueVariableLookup: 'supported',
  InlineValueEvaluatableExpression: 'supported',
  CallHierarchyItem: 'supported',
  CallHierarchyIncomingCall: 'supported',
  CallHierarchyOutgoingCall: 'supported',
  TypeHierarchyItem: 'supported',
  LinkedEditingRanges: 'supported',
  SemanticTokens: 'supported',
  SemanticTokensBuilder: 'supported',
  SemanticTokensEdit: 'supported',
  SemanticTokensEdits: 'supported',
  SemanticTokensLegend: 'supported',
  TextDocumentChangeReason: 'supported',
  TextDocumentSaveReason: 'supported',
  // A document can be opened and read, and the lifecycle events fire: Phase 6 mirrors every open
  // editor into the hosts, so an extension that re-lints on change or on save is driven by real
  // edits rather than by nothing.
  'workspace.openTextDocument': 'supported',
  'workspace.onDidOpenTextDocument': 'supported',
  'workspace.onDidChangeTextDocument': 'supported',
  'workspace.onDidSaveTextDocument': 'supported',
  'workspace.onDidCloseTextDocument': 'supported',
  // PRD Phase 7 §4/§5: a real workspace watcher runs in Main — recursive, glob-matched, debounced — and
  // the workspace file operation events fire for the gestures upstream fires them for.
  'workspace.createFileSystemWatcher': 'supported',
  'workspace.onDidCreateFiles': 'supported',
  'workspace.onDidRenameFiles': 'supported',
  'workspace.onDidDeleteFiles': 'supported',
  'workspace.fs.copy': 'supported',
  'workspace.fs.rename': 'supported',
  // PRD Phase 7 §1: extension terminals are real panes in the integrated terminal, including an
  // extension-implemented `Pseudoterminal` and contributed terminal profiles.
  'window.createTerminal': 'supported',
  'window.registerTerminalProfileProvider': 'supported',
  'window.terminals': 'supported',
  'window.activeTerminal': 'supported',
  'window.onDidOpenTerminal': 'supported',
  'window.onDidCloseTerminal': 'supported',
  'window.onDidChangeActiveTerminal': 'supported',
  'window.onDidChangeTerminalState': 'supported',
  // PRD Phase 7 §3: Main starts the adapter and frames DAP; an inline adapter runs in the host.
  'debug.startDebugging': 'supported',
  'debug.stopDebugging': 'supported',
  'debug.registerDebugAdapterDescriptorFactory': 'supported',
  'debug.registerDebugConfigurationProvider': 'supported',
  'debug.activeDebugSession': 'supported',
  'debug.activeDebugConsole': 'supported',
  'debug.onDidStartDebugSession': 'supported',
  'debug.onDidTerminateDebugSession': 'supported',
  'debug.onDidChangeActiveDebugSession': 'supported',
  'debug.onDidReceiveDebugSessionCustomEvent': 'supported',
  // Breakpoints are outside Phase 7: `debug.breakpoints` reads empty and the event never fires.
  'debug.addBreakpoints': 'unsupported',
  'debug.removeBreakpoints': 'unsupported',
  'debug.onDidChangeBreakpoints': 'partial',
  // PRD Phase 7 §2: contributed and workspace tasks run, with the four lifecycle events.
  'tasks.registerTaskProvider': 'supported',
  'tasks.executeTask': 'supported',
  'tasks.fetchTasks': 'supported',
  'tasks.taskExecutions': 'supported',
  'tasks.onDidStartTask': 'supported',
  'tasks.onDidEndTask': 'supported',
  'tasks.onDidStartTaskProcess': 'supported',
  'tasks.onDidEndTaskProcess': 'supported',
  /*
   * Phase 7 §1–§4 — the value types those four runtimes are driven by.
   *
   * The same trap as the Phase 6 block above, one phase later: a probe over bundled code recovers
   * `new vscode.ShellExecution(…)` as the bare name `ShellExecution`, and with no entry here that fell
   * through to the conservative default and reported every task-providing extension as incompatible
   * over a class the shim exports. Every name below is on the shim's `vscode` object as of Phase 7 —
   * the task a provider builds, the adapter descriptor a factory returns, the enums both read — so an
   * extension that constructs one gets a real object rather than `undefined`.
   */
  TerminalLocation: 'supported',
  TerminalExitReason: 'supported',
  TerminalProfile: 'supported',
  EnvironmentVariableMutatorType: 'supported',
  Task: 'supported',
  TaskGroup: 'supported',
  TaskScope: 'supported',
  TaskRevealKind: 'supported',
  TaskPanelKind: 'supported',
  ProcessExecution: 'supported',
  ShellExecution: 'supported',
  CustomExecution: 'supported',
  ShellQuoting: 'supported',
  DebugAdapterExecutable: 'supported',
  DebugAdapterServer: 'supported',
  DebugAdapterNamedPipeServer: 'supported',
  DebugAdapterInlineImplementation: 'supported',
  DebugConsoleMode: 'supported',
  DebugConfigurationProviderTriggerKind: 'supported',
  FileChangeType: 'supported',
  /*
   * Phase 7 §8 — the provider members the host reads rather than ignores.
   *
   * These five are declared on the provider an extension registers, not on the `vscode` object, and
   * that is why they need entries of their own: through Phase 6 a provider could fire
   * `onDidChangeCodeLenses` forever with nothing subscribed, so its first answer was its only answer
   * and every real language extension's lenses went stale. Registration now binds each one to the
   * provider and re-asks that provider when it fires, so an extension that declares one is reaching a
   * surface that works. `DocumentRangeSemanticTokensProvider` is absent because it has no change event
   * to declare — upstream does not define one, and claiming it would advertise a refresh that cannot
   * arrive.
   */
  onDidChangeCodeLenses: 'supported',
  onDidChangeInlayHints: 'supported',
  onDidChangeSemanticTokens: 'supported',
  onDidChangeFoldingRanges: 'supported',
  onDidChangeInlineValues: 'supported',
  /** The optional half of `WorkspaceSymbolProvider`, called for the one symbol the user picked. */
  resolveWorkspaceSymbol: 'supported',
  // Later phases.
  'notebooks.registerNotebookSerializer': 'unsupported',
  'lm.selectChatModels': 'unsupported',
  'chat.createChatParticipant': 'unsupported',
};

/**
 * The same table indexed by member name alone.
 *
 * A bundled extension's emitted code is the only evidence available for what it calls, and a probe
 * over minified output recovers `createWebviewPanel`, not `window.createWebviewPanel`. Without this
 * every such name fell through to the conservative default and the verdict read "not compatible"
 * for APIs that ship. Ambiguous last segments keep the first (namespace-qualified) entry, which is
 * why the table above lists the namespace an extension would actually reach through.
 *
 * Members whose name says nothing on its own (`get`, `store`, an `onDidChange` that could belong to
 * anything) are left out: matching them would classify a coincidence.
 */
const GENERIC_MEMBER_NAMES = new Set([
  'get',
  'store',
  'delete',
  'onDidChange',
  'match',
  'dispose',
  'copy',
  'rename',
]);

const API_SUPPORT_BY_MEMBER: Record<string, CompatLevel> = (() => {
  const index: Record<string, CompatLevel> = {};
  for (const [key, level] of Object.entries(API_SUPPORT)) {
    const member = key.slice(key.lastIndexOf('.') + 1);
    if (GENERIC_MEMBER_NAMES.has(member)) continue;
    if (index[member] === undefined) index[member] = level;
  }
  return index;
})();

/** Classify a single VS Code API member (exact, then bare member, then namespace heuristic). */
export function classifyApi(api: string): CompatLevel {
  const key = api.trim();
  const exact = API_SUPPORT[key];
  if (exact !== undefined) return exact;
  if (!key.includes('.')) {
    const member = API_SUPPORT_BY_MEMBER[key];
    if (member !== undefined) return member;
  }
  const ns = key.split('.')[0] ?? '';
  // Namespace heuristics for uncurated members (conservative).
  if (/^(notebooks|scm|tests|lm|chat)$/.test(ns)) return 'unsupported';
  // `debug` and `tasks` ship as of PRD Phase 7, but only the members named above: an uncurated one is
  // still absent from the shim, and `strictNamespace` throws on it rather than pretending.
  if (ns === 'debug' || ns === 'tasks') return 'unsupported';
  if (ns === 'window' && /^window\.show/.test(key)) return 'supported';
  if (ns === 'authentication' || ns === 'secrets') return 'supported';
  if (ns === 'commands') return 'supported';
  // An uncurated `languages` member is still one the shim does not have — Phase 6 delivered the 28
  // provider registrations named above, not the whole namespace — and `strictNamespace` throws on it
  // rather than returning a disposable that does nothing.
  if (ns === 'languages') return 'unsupported';
  if (ns === 'workspace') return 'partial';
  return 'unsupported'; // unknown → conservative
}

export interface ExtensionCompat {
  level: CompatLevel;
  supported: string[];
  partial: string[];
  unsupported: string[];
  /** 0..1 fraction of used APIs that are at least partially supported. */
  coverage: number;
  label: string;
}

/**
 * Assess an extension's overall compatibility from the VS Code APIs it uses. Overall
 * level: unsupported if any core API is unsupported, else partial if any is partial,
 * else supported. (Conservative — a single unsupported API can break an extension.)
 */
export function assessExtension(usedApis: readonly string[]): ExtensionCompat {
  const supported: string[] = [];
  const partial: string[] = [];
  const unsupported: string[] = [];
  for (const api of usedApis) {
    const lvl = classifyApi(api);
    if (lvl === 'supported') supported.push(api);
    else if (lvl === 'partial') partial.push(api);
    else unsupported.push(api);
  }
  const total = usedApis.length;
  const level: CompatLevel =
    unsupported.length > 0 ? 'unsupported' : partial.length > 0 ? 'partial' : 'supported';
  const coverage =
    total > 0 ? Math.round(((supported.length + partial.length) / total) * 100) / 100 : 1;
  const label =
    total === 0
      ? 'No VS Code APIs used — likely compatible.'
      : level === 'supported'
        ? `Compatible (${supported.length}/${total} APIs supported).`
        : level === 'partial'
          ? `Partially compatible (${partial.length} partial, ${supported.length} supported).`
          : `Not compatible (${unsupported.length} unsupported API(s): ${unsupported.slice(0, 3).join(', ')}).`;
  return { level, supported, partial, unsupported, coverage, label };
}
