/**
 * The extension-host protocol and the policy that governs it.
 *
 * AXIOM runs VS Code extension code, and this file is where the rules of that arrangement
 * are written down. Everything here is pure: message shapes, message validation, which API
 * requests exist and what a valid payload for each looks like, which activation events a
 * manifest declares, and when a repeatedly crashing extension stops being restarted. Main
 * owns the processes; the worker owns the `vscode` shim; both agree here.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **Nothing crossing the boundary is trusted in either direction.** The worker runs
 *      third-party code with the user's OS privileges, so every message it sends is parsed
 *      and validated before Main acts on it — an extension that sends a malformed or
 *      hostile request gets an error, never an unchecked effect.
 *   2. **The request set is closed and enumerable.** An extension cannot ask for a
 *      capability that is not in `HOST_REQUEST_KINDS`. Adding one is a visible change here
 *      rather than an emergent consequence of the shim growing.
 *   3. **Crash handling is a stated policy, not a reflex.** A crash loop that restarts
 *      forever burns the machine and hides the fault, so the restart decision is a pure
 *      function of the crash history and is tested as one.
 */
import { parseActivationEvent, type ActivationEventKind } from './activationIndex';
import {
  MAX_SECRET_CHARS,
  MAX_SECRET_KEY_CHARS,
  isProviderId,
  isSecretKey,
  normalizeScopes,
} from './vscodeAuth';
import { matchesVsCodeGlob } from './vscodeGlob';
import { isContextKeyName, normalizeContextValue } from './vscodeContextKeys';
import {
  isLanguageFeature,
  isLanguageId,
  normalizeDocumentSelector,
  normalizeLanguageConfiguration,
  normalizeLanguageDefinition,
  normalizeProviderMetadata,
} from './vscodeLanguages';
import { MAX_TREE_HANDLE_CHARS, MAX_TREE_SELECTION } from './vscodeTree';
import {
  MAX_WEBVIEW_HTML_CHARS,
  isWebviewHandle,
  isWebviewToken,
  isWebviewViewType,
  normalizeWebviewMessagePayload,
  sanitizeViewColumn,
  sanitizeWebviewOptions,
  sanitizeWebviewPanelOptions,
  sanitizeWebviewTitle,
} from './vscodeWebview';

/** Wire version. A worker built against a different protocol must not be spoken to. */
export const HOST_PROTOCOL_VERSION = 1;

/** The API level AXIOM's shim implements, reported to extensions as `vscode.version`. */
export const HOST_VSCODE_VERSION = '1.96.0';

// ---------------------------------------------------------------------------
// Requests an extension may make of Main
// ---------------------------------------------------------------------------
/**
 * Every capability the shim can ask Main for.
 *
 * Deliberately flat and finite. Grouping them into namespaces would have hidden how many
 * there are, and the count is the point: this is the entire surface through which extension
 * code can affect the user's machine and window.
 */
export const HOST_REQUEST_KINDS = [
  'window.showMessage',
  'window.showQuickPick',
  'window.showInputBox',
  'window.setStatusBarItem',
  'window.removeStatusBarItem',
  'window.appendOutput',
  'window.showTextDocument',
  'languages.setDiagnostics',
  'workspace.readFile',
  'workspace.writeFile',
  'workspace.readDirectory',
  'workspace.stat',
  'workspace.createDirectory',
  'workspace.delete',
  'workspace.findFiles',
  'workspace.getConfiguration',
  'commands.execute',
  'commands.registered',
  'authentication.getSession',
  'authentication.removeSession',
  'authentication.getAccounts',
  'authentication.registerProvider',
  'authentication.unregisterProvider',
  'authentication.sessionsChanged',
  'secrets.get',
  'secrets.store',
  'secrets.delete',
  'window.registerUriHandler',
  'env.asExternalUri',
  'env.clipboardWrite',
  'env.clipboardRead',
  'env.openExternal',
  // Phase 4: the webview runtime. Creating a webview is a window effect, not a filesystem one,
  // so none of these appear in EFFECTFUL_REQUEST_KINDS; what a webview may *read* is decided
  // against its localResourceRoots when the frame fetches, not here.
  'webview.create',
  'webview.setHtml',
  'webview.setOptions',
  'webview.setTitle',
  'webview.setIconPath',
  'webview.setBadge',
  'webview.reveal',
  'webview.dispose',
  'webview.postMessage',
  'webview.registerViewProvider',
  'webview.unregisterViewProvider',
  'webview.registerSerializer',
  // Phase 5: the contribution-driven workbench. A tree view is a window effect too — the content
  // it draws comes from the provider, so nothing here reads the filesystem and none of these are
  // effectful. `context.setKey` is `setContext`, which upstream routes through `executeCommand`;
  // it is a first-class request here so the store can attribute every key to its writer.
  'tree.registerProvider',
  'tree.unregisterProvider',
  'tree.refresh',
  'tree.setTitle',
  'tree.setDescription',
  'tree.setMessage',
  'tree.setBadge',
  'tree.reveal',
  'tree.setSelection',
  'context.setKey',
  // Phase 6: the language platform. Registering a provider is not itself an effect — it only tells
  // the workbench that this extension wants to be asked — so the registrations are not effectful,
  // and the one request here that writes to the user's files, `languages.applyWorkspaceEdit`, is.
  // There is one registration kind for all 28 provider types rather than 28 kinds, because the
  // feature name is data the registry already validates; a kind per feature would multiply this
  // list without adding a single decision to it.
  'languages.registerProvider',
  'languages.unregisterProvider',
  'languages.refreshProvider',
  // A provider fired its own change event (`onDidChangeCodeLenses` and the four others). Not
  // effectful: it invalidates that provider's answers and wakes the editor, and it can reach nothing
  // the provider was not already being asked for.
  'languages.providerChanged',
  'languages.registerLanguage',
  'languages.setLanguageConfiguration',
  'languages.setTextDocumentLanguage',
  'languages.getLanguages',
  'languages.getDiagnostics',
  'languages.applyWorkspaceEdit',
  /*
   * Phase 7: the runtime. Four subsystems, and the split between them is the split between what they
   * can do to the machine.
   *
   * Terminals and tasks start real processes, so `terminal.create` and `tasks.execute` are effectful;
   * so is `terminal.sendText`, which types into a shell that is already running and is therefore the
   * same capability by another route. Debugging starts an adapter *and* attaches it to a program, so
   * `debug.start` is effectful too. Everything else here is bookkeeping: a registration, a disposal, a
   * name change, or an event acknowledgement, none of which can reach outside the window on its own.
   *
   * `workspace.copyFile` and `workspace.renameFile` complete `workspace.fs`, which Phase 6 left with
   * two members throwing; both write to the user's files and are effectful.
   */
  'terminal.create',
  'terminal.dispose',
  'terminal.sendText',
  'terminal.show',
  'terminal.hide',
  'terminal.setName',
  'terminal.write',
  'terminal.registerProfileProvider',
  'terminal.unregisterProfileProvider',
  'terminal.envMutate',
  'terminal.envClear',
  'terminal.envDescribe',
  'tasks.registerProvider',
  'tasks.unregisterProvider',
  'tasks.fetch',
  'tasks.execute',
  'tasks.terminate',
  'tasks.customDone',
  'debug.registerConfigurationProvider',
  'debug.unregisterConfigurationProvider',
  'debug.registerAdapterFactory',
  'debug.unregisterAdapterFactory',
  'debug.start',
  'debug.stop',
  'debug.customRequest',
  'debug.adapterMessage',
  'debug.appendConsole',
  'workspace.createWatcher',
  'workspace.disposeWatcher',
  'workspace.copyFile',
  'workspace.renameFile',
] as const;

export type HostRequestKind = (typeof HOST_REQUEST_KINDS)[number];

const REQUEST_KIND_SET: ReadonlySet<string> = new Set(HOST_REQUEST_KINDS);

/** Requests that mutate the user's files or leave the machine, for audit and consent copy. */
export const EFFECTFUL_REQUEST_KINDS: readonly HostRequestKind[] = [
  'workspace.writeFile',
  'workspace.createDirectory',
  'workspace.delete',
  'env.openExternal',
  'env.clipboardWrite',
  // A sign-in and a stored credential are effects on the user's accounts, not just on the
  // window: one can open a browser and ask them to authorize an extension, and the other
  // writes a secret to the encrypted store that survives the session.
  'authentication.getSession',
  'authentication.removeSession',
  'secrets.store',
  'secrets.delete',
  'env.asExternalUri',
  // A `WorkspaceEdit` is the one provider result that writes to the user's files, and it can create,
  // rename and delete them as well as edit their text.
  'languages.applyWorkspaceEdit',
  // Phase 7. A terminal is a shell; text sent to one is a command line in that shell; a task is a
  // process; a debug session is a process attached to another process. All four are machine effects
  // whether or not they touch the workspace, which is why they are audited alongside file writes.
  'terminal.create',
  'terminal.sendText',
  'tasks.execute',
  'debug.start',
  'workspace.copyFile',
  'workspace.renameFile',
];

export function isHostRequestKind(value: unknown): value is HostRequestKind {
  return typeof value === 'string' && REQUEST_KIND_SET.has(value);
}

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------
export interface HostInit {
  t: 'init';
  version: number;
  extensionId: string;
  extensionPath: string;
  mainFile: string;
  displayName: string;
  version_: string;
  workspaceRoot: string | null;
  globalStoragePath: string;
  workspaceStoragePath: string;
  logPath: string;
  /** Settings the extension may read, already filtered to its own keys plus editor basics. */
  configuration: Record<string, unknown>;
  /** Persisted `globalState` and `workspaceState`, restored before activation. */
  globalState: Record<string, unknown>;
  workspaceState: Record<string, unknown>;
}

export type MainToWorker =
  | HostInit
  | { t: 'activate'; reason: string }
  | { t: 'deactivate' }
  | { t: 'invoke'; id: number; command: string; args: unknown[] }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'configuration'; configuration: Record<string, unknown> }
  | { t: 'editor'; editor: { path: string; languageId: string } | null }
  /** A deep link or an OAuth redirect addressed to this extension's URI handler. */
  | { t: 'uri'; uri: string }
  /** One of this extension's own secrets changed, possibly in another window. */
  | { t: 'secretChanged'; key: string }
  /** Sessions changed for a provider this extension has asked about. */
  | { t: 'sessionsChanged'; providerId: string }
  /** Main asking an extension's own authentication provider to do something. */
  | {
      t: 'provider';
      id: number;
      providerId: string;
      op: 'getSessions' | 'createSession' | 'removeSession';
      scopes: string[];
      sessionId: string | null;
    }
  /** A message a webview frame sent, already origin-checked and validated. */
  | { t: 'webviewMessage'; handle: string; payload: unknown }
  /** The frame's own `setState`, so `WebviewPanelSerializer` sees the current state. */
  | { t: 'webviewState'; handle: string; state: string | null }
  /** The frame became visible, hidden, focused or blurred. */
  | { t: 'webviewVisibility'; handle: string; visible: boolean; active: boolean }
  /** The user closed the panel, or the workbench tore the view down. */
  | { t: 'webviewDispose'; handle: string }
  /** A `WebviewViewProvider` must resolve: the workbench is showing its view. */
  | {
      t: 'webviewResolveView';
      id: number;
      handle: string;
      token: string;
      viewType: string;
      state: string | null;
      visible: boolean;
    }
  /** A `WebviewPanelSerializer` must restore a panel persisted from a previous session. */
  | {
      t: 'webviewRestorePanel';
      id: number;
      handle: string;
      token: string;
      viewType: string;
      title: string;
      state: string | null;
      viewColumn: number;
    }
  /**
   * The workbench needs a node's children.
   *
   * `handle` is null for the roots. This is the only way children are ever fetched, which is what
   * makes the tree lazy: no request, no `getChildren` call.
   */
  | { t: 'treeGetChildren'; id: number; viewId: string; handle: string | null }
  /** `resolveTreeItem`: the user hovered a row and the tooltip is still unresolved. */
  | { t: 'treeResolveItem'; id: number; viewId: string; handle: string }
  /** The user expanded or collapsed a row, for `onDidExpandElement` / `onDidCollapseElement`. */
  | { t: 'treeExpansion'; viewId: string; handle: string; expanded: boolean }
  /** Selection changed, for `TreeView.onDidChangeSelection`. */
  | { t: 'treeSelection'; viewId: string; handles: string[] }
  /** The view became visible or hidden, for `TreeView.onDidChangeVisibility`. */
  | { t: 'treeVisibility'; viewId: string; visible: boolean }
  /** Checkboxes the user toggled, for `TreeView.onDidChangeCheckboxState`. */
  | { t: 'treeCheckbox'; viewId: string; items: Array<{ handle: string; checked: boolean }> }
  /**
   * Call one language provider.
   *
   * One message for all 28 provider types. VS Code's extension host does the same thing — a table of
   * adapters keyed by handle, dispatched by feature name — and the alternative, a message type per
   * feature, would repeat the same id/handle/cancellation plumbing 28 times with 28 chances to get
   * the cancellation wrong.
   *
   * `op` distinguishes the calls a single provider answers: `provide` versus the `resolve` that
   * follows it, or a hierarchy provider's `prepare`, `incoming` and `outgoing`. `payload` is the
   * feature's own arguments (a position, a range, a resolution token), already validated against the
   * feature by the language service before it is sent.
   */
  | {
      t: 'languageProvide';
      id: number;
      handle: number;
      feature: string;
      op: string;
      uri: string | null;
      payload: unknown;
    }
  /**
   * Abandon a call in flight.
   *
   * This is the whole of "cancellation must propagate correctly through IPC": the workbench cancels a
   * request the user has moved past, Main forwards the id, and the worker fires the
   * `CancellationTokenSource` it created for that id so the provider's own token is the one that
   * trips. No reply is expected — the pending call is settled on the Main side already.
   */
  | { t: 'languageCancel'; id: number }
  /** A document became visible to this extension: `workspace.onDidOpenTextDocument`. */
  | {
      t: 'documentOpen';
      uri: string;
      languageId: string;
      version: number;
      text: string;
      isDirty: boolean;
    }
  /**
   * The document changed: `workspace.onDidChangeTextDocument`.
   *
   * `changes` are incremental and ordered, each stated against the text left by the one before it.
   * `version` is the version reached *after* the batch, so a worker that receives a version it cannot
   * follow knows it is desynchronised and can ask for the text again rather than diverging quietly.
   */
  | {
      t: 'documentChange';
      uri: string;
      version: number;
      changes: Array<{
        range?: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        text: string;
      }>;
      isDirty: boolean;
    }
  /** Full-text resynchronisation after a refused change, or a revert from disk. */
  | { t: 'documentReplace'; uri: string; version: number; text: string }
  | { t: 'documentSave'; uri: string }
  | { t: 'documentClose'; uri: string }
  /** `setTextDocumentLanguage` took effect, from this extension or another. */
  | { t: 'documentLanguage'; uri: string; languageId: string }
  /*
   * Phase 7 — the runtime, Main → worker.
   *
   * Every message below is either an event the extension's API surface must report, or a call into
   * something the extension itself implements (a `Pseudoterminal`, a `TaskProvider`, a
   * `DebugConfigurationProvider`, an inline debug adapter). The ones with an `id` expect a `result`
   * back and are cancellable; the rest are fire-and-forget notifications.
   */
  /** A terminal this extension created is now backed by a real session. */
  | { t: 'terminalOpened'; handle: number; sessionId: string; processId: number | null }
  /** The terminal closed, from a `dispose`, a shell exit, or the user closing the tab. */
  | { t: 'terminalClosed'; handle: number; exitCode: number | null }
  /** `Terminal.state` changed: `onDidChangeTerminalState`. */
  | { t: 'terminalState'; handle: number; isInteractedWith: boolean; shellIntegration: boolean }
  /** The active terminal changed. `handle` is null when none is active or it is not ours. */
  | { t: 'terminalActive'; handle: number | null }
  /** Input for an extension-implemented `Pseudoterminal`: `handleInput`. */
  | { t: 'terminalInput'; handle: number; data: string }
  /** The pane was resized: `Pseudoterminal.setDimensions`. */
  | { t: 'terminalDimensions'; handle: number; columns: number; rows: number }
  /** The pty is being shown for the first time: `Pseudoterminal.open`. */
  | { t: 'terminalOpenPty'; handle: number; columns: number; rows: number }
  /** The pty is going away: `Pseudoterminal.close`. */
  | { t: 'terminalClosePty'; handle: number }
  /** A contributed terminal profile must be resolved: `provideTerminalProfile`. */
  | { t: 'terminalProvideProfile'; id: number; profileId: string; token: string }
  /** `provideTasks` on one registered provider. */
  | { t: 'taskProvide'; id: number; token: string; providerToken: number }
  /** `resolveTask` for a task whose execution the provider must fill in. */
  | { t: 'taskResolve'; id: number; token: string; providerToken: number; task: unknown }
  /** A task's lifecycle: the four `onDid*Task*` events, in the order upstream fires them. */
  | {
      t: 'taskEvent';
      phase: 'start' | 'processStart' | 'processEnd' | 'end';
      executionId: number;
      task: unknown;
      processId: number | null;
      exitCode: number | null;
    }
  /** Run a `CustomExecution`: the extension supplies the `Pseudoterminal` that is the task. */
  | { t: 'taskCustomStart'; id: number; executionId: number; task: unknown }
  /** The user or the extension cancelled a `CustomExecution`. */
  | { t: 'taskCustomCancel'; executionId: number }
  /** A watcher fired. `token` is the watcher's own handle, so no path matching happens in the worker. */
  | { t: 'watcherEvent'; token: number; kind: 'create' | 'change' | 'delete'; path: string }
  /** `workspace.onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles`. */
  | {
      t: 'fileOperation';
      kind: 'create' | 'delete' | 'rename';
      entries: Array<{ oldPath: string | null; newPath: string | null }>;
    }
  /** `debug.onDidStartDebugSession`, and the session `activeDebugSession` now reports. */
  | {
      t: 'debugSessionStarted';
      sessionId: string;
      type: string;
      name: string;
      configuration: Record<string, unknown>;
      parentId: string | null;
      workspaceFolder: string | null;
    }
  | { t: 'debugSessionTerminated'; sessionId: string }
  | { t: 'debugActiveSession'; sessionId: string | null }
  /** `onDidReceiveDebugSessionCustomEvent`. */
  | { t: 'debugCustomEvent'; sessionId: string; event: string; body: unknown }
  /** `resolveDebugConfiguration`, its `WithSubstitutedVariables` variant, and `provideDebugConfigurations`. */
  | {
      t: 'debugResolveConfiguration';
      id: number;
      token: string;
      providerToken: number;
      op: 'provide' | 'resolve' | 'resolveWithSubstituted';
      folder: string | null;
      configuration: unknown;
    }
  /** `createDebugAdapterDescriptor`: the extension says how the adapter is started. */
  | {
      t: 'debugCreateAdapter';
      id: number;
      token: string;
      debugType: string;
      sessionId: string;
      configuration: Record<string, unknown>;
    }
  /** A DAP message for an extension's inline adapter (`DebugAdapterInlineImplementation`). */
  | { t: 'debugAdapterMessage'; sessionId: string; message: unknown }
  /** Dispose an inline adapter: the session it served has ended. */
  | { t: 'debugAdapterStop'; sessionId: string };

export type WorkerToMain =
  | { t: 'ready'; version: number }
  | { t: 'activated'; commands: string[]; ms: number }
  | { t: 'failed'; phase: 'load' | 'activate'; message: string; stack: string | null }
  | { t: 'commands'; commands: string[] }
  | { t: 'request'; id: number; kind: HostRequestKind; payload: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { t: 'state'; scope: 'global' | 'workspace'; values: Record<string, unknown> }
  | { t: 'deactivated' };

/** Longest string AXIOM will carry out of an extension in one field. */
export const MAX_HOST_STRING = 8 * 1024;
/** Largest file an extension may read or write through the host. */
export const MAX_HOST_FILE_BYTES = 8 * 1024 * 1024;
/** Largest persisted state blob per extension per scope. */
export const MAX_HOST_STATE_BYTES = 256 * 1024;
/** Commands one extension may register. */
export const MAX_HOST_COMMANDS = 200;
/** Status bar items one extension may own at once. */
export const MAX_HOST_STATUS_ITEMS = 8;
/** Diagnostics one extension may publish per file. */
export const MAX_HOST_DIAGNOSTICS = 500;
/** Longest URI the protocol carries. Matches the wire format's own limit. */
export const MAX_HOST_URI = 2048;
/** Resources one `WorkspaceEdit` may name. Matches `MAX_WORKSPACE_EDIT_ENTRIES`. */
export const MAX_HOST_EDIT_ENTRIES = 500;

function clampString(value: unknown, limit = MAX_HOST_STRING): string | null {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, limit)) {
    const text = clampString(entry, 512);
    if (text !== null && text.length > 0) out.push(text);
  }
  return out;
}

/** Longest a contributed view id may be. Upstream's own are well under this. */
export const MAX_TREE_VIEW_ID_CHARS = 200;

const TREE_VIEW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,199}$/;

/**
 * Is this a view id the workbench will talk about?
 *
 * The same character set as a command id. A tree view's id is matched against
 * `contributes.views`, so an id that could not have been declared there is refused at the
 * boundary rather than becoming a view nobody can see.
 */
export function isTreeViewId(value: unknown): value is string {
  return typeof value === 'string' && TREE_VIEW_ID_RE.test(value);
}

/**
 * Parse a message the worker sent.
 *
 * Returns null for anything unrecognized rather than throwing, so a worker that goes wrong
 * is dropped rather than able to crash its supervisor. Every accepted shape is narrowed to
 * exactly the fields Main will read.
 */
export function parseWorkerMessage(raw: unknown): WorkerToMain | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  switch (message.t) {
    case 'ready':
      return typeof message.version === 'number' ? { t: 'ready', version: message.version } : null;
    case 'activated':
      return {
        t: 'activated',
        commands: stringArray(message.commands, MAX_HOST_COMMANDS),
        ms: typeof message.ms === 'number' && Number.isFinite(message.ms) ? message.ms : 0,
      };
    case 'failed': {
      const phase = message.phase === 'load' ? 'load' : 'activate';
      return {
        t: 'failed',
        phase,
        message: clampString(message.message, 2_000) ?? 'The extension failed without a message.',
        stack: clampString(message.stack, 4_000),
      };
    }
    case 'commands':
      return { t: 'commands', commands: stringArray(message.commands, MAX_HOST_COMMANDS) };
    case 'request': {
      if (typeof message.id !== 'number' || !isHostRequestKind(message.kind)) return null;
      return { t: 'request', id: message.id, kind: message.kind, payload: message.payload };
    }
    case 'result': {
      if (typeof message.id !== 'number') return null;
      return message.ok === true
        ? { t: 'result', id: message.id, ok: true, value: message.value }
        : {
            t: 'result',
            id: message.id,
            ok: false,
            error: clampString(message.error, 2_000) ?? 'The command failed.',
          };
    }
    case 'log': {
      const level = message.level;
      return {
        t: 'log',
        level: level === 'debug' || level === 'warn' || level === 'error' ? level : 'info',
        message: clampString(message.message, 2_000) ?? '',
      };
    }
    case 'state': {
      const values =
        message.values && typeof message.values === 'object' && !Array.isArray(message.values)
          ? (message.values as Record<string, unknown>)
          : null;
      if (values === null) return null;
      return { t: 'state', scope: message.scope === 'workspace' ? 'workspace' : 'global', values };
    }
    case 'deactivated':
      return { t: 'deactivated' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Activation events
// ---------------------------------------------------------------------------
export interface ActivationTrigger {
  /**
   * What happened. The full upstream vocabulary, because an extension that declares
   * `onView:` or `onDebug` and never wakes is indistinguishable, to its user, from an
   * extension that is broken.
   */
  kind: Exclude<ActivationEventKind, 'unknown'>;
  /**
   * The trigger's subject: the language id, command, view id, debug type, uri authority,
   * task type, notebook type, and so on. For `workspaceContains` it is a workspace-relative
   * file path, matched against the declared glob.
   */
  value?: string;
}

/**
 * Decide whether a declared activation event fires for a trigger.
 *
 * Lazy activation is the difference between installing twenty extensions and paying for
 * twenty Node processes at startup. VS Code's semantics are followed closely because
 * extension authors write against them:
 *
 *   - `*` and `onStartupFinished` are eager; everything else waits for its trigger.
 *   - An unrecognized event never activates. Treating an unknown event as eager would
 *     quietly turn every lazy extension into a startup cost.
 *   - An event declared with no argument (`onDebug`, and the bare `onLanguage` several
 *     shipping extensions use) listens to its whole family, so it fires for any argument.
 *   - `workspaceContains:` declares a glob and the trigger carries a path, which is the
 *     only pair in the vocabulary that is not compared for equality.
 *
 * The event grammar itself is not restated here: `parseActivationEvent` owns it, and the
 * startup index in `activationIndex` classifies events with the same function, so a
 * manifest can never be lazy to one of them and unknown to the other.
 */
export function activationMatches(event: string, trigger: ActivationTrigger): boolean {
  const parsed = parseActivationEvent(event);
  if (parsed.kind === 'unknown') return false;
  if (parsed.kind === 'startup') return trigger.kind === 'startup';
  if (trigger.kind !== parsed.kind) return false;
  if (parsed.argument === undefined) return true;
  const value = trigger.value;
  if (value === undefined || value.length === 0) return false;
  if (parsed.kind === 'workspaceContains') {
    // Either spelling: the caller may report the file it found, or replay the declared
    // pattern after resolving it itself.
    return value === parsed.argument || matchesVsCodeGlob(parsed.argument, value);
  }
  return value === parsed.argument;
}

/** True when a manifest asks to be activated at startup. */
export function activatesEagerly(events: readonly string[]): boolean {
  return events.some((event) => activationMatches(event, { kind: 'startup' }));
}

/** The languages a manifest waits for, deduplicated. */
export function activationLanguages(events: readonly string[]): string[] {
  const out = new Set<string>();
  for (const event of events) {
    const trimmed = event.trim();
    if (trimmed.startsWith('onLanguage:') && trimmed.length > 'onLanguage:'.length) {
      out.add(trimmed.slice('onLanguage:'.length));
    }
  }
  return [...out];
}

/** The workspace files a manifest waits for. */
export function activationWorkspaceFiles(events: readonly string[]): string[] {
  const out = new Set<string>();
  for (const event of events) {
    const trimmed = event.trim();
    if (trimmed.startsWith('workspaceContains:') && trimmed.length > 'workspaceContains:'.length) {
      out.add(trimmed.slice('workspaceContains:'.length));
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Crash policy
// ---------------------------------------------------------------------------
/** How long a crash counts against an extension. */
export const CRASH_WINDOW_MS = 3 * 60 * 1000;
/** Crashes inside the window before AXIOM stops restarting and asks the user. */
export const CRASH_LIMIT = 3;
/** Backoff before each restart, indexed by how many crashes have already happened. */
export const CRASH_BACKOFF_MS: readonly number[] = [500, 2_000, 8_000];

export interface CrashDecision {
  /** Restart this extension. */
  restart: boolean;
  /** Delay before restarting. */
  delayMs: number;
  /** Ask the user whether to disable it — it is crashing repeatedly. */
  offerDisable: boolean;
  /** Crashes that count against it inside the window, including this one. */
  recentCrashes: number;
}

/**
 * Decide what to do about a crashed extension.
 *
 * The rule is deliberately unforgiving in one direction and forgiving in the other: a
 * crash-on-activate loop is capped at three attempts inside three minutes and then stops,
 * because a fourth attempt has never fixed anything and an extension that cannot start is
 * better reported than retried. But crashes age out, so an extension that failed once
 * yesterday and once today is treated as having failed once — an accumulating counter would
 * eventually disable a perfectly healthy extension.
 *
 * `crashTimes` is the history of previous crashes; `now` is when this one happened.
 */
export function decideCrashResponse(crashTimes: readonly number[], now: number): CrashDecision {
  const recent = crashTimes.filter((time) => now - time < CRASH_WINDOW_MS).length + 1;
  if (recent >= CRASH_LIMIT) {
    return { restart: false, delayMs: 0, offerDisable: true, recentCrashes: recent };
  }
  const backoff = CRASH_BACKOFF_MS[Math.min(recent - 1, CRASH_BACKOFF_MS.length - 1)] ?? 8_000;
  return { restart: true, delayMs: backoff, offerDisable: false, recentCrashes: recent };
}

/** Drop crash records that have aged out of the window. */
export function pruneCrashTimes(crashTimes: readonly number[], now: number): number[] {
  return crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Request payload validation
// ---------------------------------------------------------------------------
export interface ValidatedRequest {
  kind: HostRequestKind;
  payload: Record<string, unknown>;
}

/**
 * Validate one request's payload against the shape its handler will read.
 *
 * This runs before any handler, so a handler can read its fields without re-checking types.
 * Errors are returned rather than thrown: a bad request is answered with an error the
 * extension can see and log, which is far more useful to an author than a silent failure,
 * and it keeps one malformed call from taking down the broker.
 */
export function validateHostRequest(
  kind: HostRequestKind,
  rawPayload: unknown,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const payload =
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const requireString = (
    field: string,
    limit = MAX_HOST_STRING,
  ): { ok: true; value: string } | { ok: false; error: string } => {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `${kind} requires a non-empty ${field}.` };
    }
    return { ok: true, value: value.slice(0, limit) };
  };

  switch (kind) {
    case 'window.showMessage': {
      const text = requireString('message', 2_000);
      if (!text.ok) return text;
      const severity = payload.severity;
      if (severity !== 'info' && severity !== 'warning' && severity !== 'error') {
        return { ok: false, error: 'window.showMessage requires severity info|warning|error.' };
      }
      return {
        ok: true,
        payload: { message: text.value, severity, items: stringArray(payload.items, 6) },
      };
    }
    case 'window.showQuickPick': {
      const items = stringArray(payload.items, 500);
      if (items.length === 0) {
        return { ok: false, error: 'window.showQuickPick requires at least one item.' };
      }
      return {
        ok: true,
        payload: { items, placeHolder: clampString(payload.placeHolder, 200) ?? '' },
      };
    }
    case 'window.showInputBox':
      return {
        ok: true,
        payload: {
          prompt: clampString(payload.prompt, 400) ?? '',
          value: clampString(payload.value, 2_000) ?? '',
          placeHolder: clampString(payload.placeHolder, 200) ?? '',
          password: payload.password === true,
        },
      };
    case 'window.setStatusBarItem': {
      const id = requireString('id', 200);
      if (!id.ok) return id;
      const alignment = payload.alignment === 'left' ? 'left' : 'right';
      return {
        ok: true,
        payload: {
          id: id.value,
          text: clampString(payload.text, 200) ?? '',
          tooltip: clampString(payload.tooltip, 500) ?? '',
          command: clampString(payload.command, 200) ?? '',
          alignment,
          priority:
            typeof payload.priority === 'number' && Number.isFinite(payload.priority)
              ? Math.max(-1000, Math.min(1000, Math.round(payload.priority)))
              : 0,
        },
      };
    }
    case 'window.removeStatusBarItem': {
      const id = requireString('id', 200);
      return id.ok ? { ok: true, payload: { id: id.value } } : id;
    }
    case 'window.appendOutput': {
      const channel = requireString('channel', 200);
      if (!channel.ok) return channel;
      return {
        ok: true,
        payload: { channel: channel.value, text: clampString(payload.text, 16_000) ?? '' },
      };
    }
    case 'window.showTextDocument': // falls through: all of these carry only a path
    case 'workspace.readFile':
    case 'workspace.stat':
    case 'workspace.readDirectory':
    case 'workspace.createDirectory':
    case 'workspace.delete': {
      const target = requireString('path', 4_096);
      if (!target.ok) return target;
      return {
        ok: true,
        payload: {
          path: target.value,
          ...(kind === 'workspace.delete' ? { recursive: payload.recursive === true } : {}),
        },
      };
    }
    case 'workspace.writeFile': {
      const target = requireString('path', 4_096);
      if (!target.ok) return target;
      const content = payload.content;
      if (typeof content !== 'string') {
        return { ok: false, error: 'workspace.writeFile requires base64 content.' };
      }
      if (content.length > Math.ceil((MAX_HOST_FILE_BYTES * 4) / 3) + 4) {
        return { ok: false, error: 'workspace.writeFile exceeds the size limit.' };
      }
      return { ok: true, payload: { path: target.value, content } };
    }
    case 'workspace.findFiles': {
      const include = requireString('include', 500);
      if (!include.ok) return include;
      return {
        ok: true,
        payload: {
          include: include.value,
          maxResults:
            typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)
              ? Math.max(1, Math.min(2_000, Math.round(payload.maxResults)))
              : 500,
        },
      };
    }
    case 'workspace.getConfiguration':
      return { ok: true, payload: { section: clampString(payload.section, 200) ?? '' } };
    case 'languages.setDiagnostics': {
      const owner = requireString('owner', 200);
      if (!owner.ok) return owner;
      if (!Array.isArray(payload.entries)) {
        return { ok: false, error: 'languages.setDiagnostics requires an entries array.' };
      }
      return {
        ok: true,
        payload: { owner: owner.value, entries: payload.entries.slice(0, 2_000) },
      };
    }
    case 'commands.execute': {
      const command = requireString('command', 400);
      if (!command.ok) return command;
      return {
        ok: true,
        payload: {
          command: command.value,
          args: Array.isArray(payload.args) ? payload.args.slice(0, 16) : [],
        },
      };
    }
    case 'commands.registered':
      return { ok: true, payload: {} };
    case 'authentication.getSession': {
      const providerId = requireString('providerId', 200);
      if (!providerId.ok) return providerId;
      if (!isProviderId(providerId.value)) {
        return { ok: false, error: 'authentication.getSession requires a valid provider id.' };
      }
      return {
        ok: true,
        payload: {
          providerId: providerId.value,
          scopes: normalizeScopes(payload.scopes),
          createIfNone: payload.createIfNone === true,
          clearSessionPreference: payload.clearSessionPreference === true,
          forceNewSession: payload.forceNewSession === true,
          silent: payload.silent === true,
        },
      };
    }
    case 'authentication.removeSession': {
      const providerId = requireString('providerId', 200);
      if (!providerId.ok) return providerId;
      const sessionId = requireString('sessionId', 200);
      if (!sessionId.ok) return sessionId;
      if (!isProviderId(providerId.value)) {
        return { ok: false, error: 'authentication.removeSession requires a valid provider id.' };
      }
      return { ok: true, payload: { providerId: providerId.value, sessionId: sessionId.value } };
    }
    case 'authentication.getAccounts':
    case 'authentication.unregisterProvider':
    case 'authentication.sessionsChanged': {
      const providerId = requireString('providerId', 200);
      if (!providerId.ok) return providerId;
      if (!isProviderId(providerId.value)) {
        return { ok: false, error: `${kind} requires a valid provider id.` };
      }
      return { ok: true, payload: { providerId: providerId.value } };
    }
    case 'authentication.registerProvider': {
      const providerId = requireString('providerId', 200);
      if (!providerId.ok) return providerId;
      if (!isProviderId(providerId.value)) {
        return { ok: false, error: 'authentication.registerProvider requires a valid id.' };
      }
      return {
        ok: true,
        payload: {
          providerId: providerId.value,
          label: clampString(payload.label, 200) ?? providerId.value,
          supportsMultipleAccounts: payload.supportsMultipleAccounts === true,
        },
      };
    }
    case 'secrets.get':
    case 'secrets.delete': {
      const key = requireString('key', MAX_SECRET_KEY_CHARS);
      if (!key.ok) return key;
      if (!isSecretKey(key.value)) return { ok: false, error: `${kind} requires a valid key.` };
      return { ok: true, payload: { key: key.value } };
    }
    case 'secrets.store': {
      const key = requireString('key', MAX_SECRET_KEY_CHARS);
      if (!key.ok) return key;
      if (!isSecretKey(key.value))
        return { ok: false, error: 'secrets.store requires a valid key.' };
      const value = payload.value;
      if (typeof value !== 'string') {
        return { ok: false, error: 'secrets.store requires a string value.' };
      }
      if (value.length > MAX_SECRET_CHARS) {
        return { ok: false, error: 'secrets.store exceeds the size limit for one secret.' };
      }
      return { ok: true, payload: { key: key.value, value } };
    }
    case 'window.registerUriHandler':
      return { ok: true, payload: {} };
    case 'env.asExternalUri': {
      const uri = requireString('uri', 8 * 1024);
      return uri.ok ? { ok: true, payload: { uri: uri.value } } : uri;
    }
    case 'env.clipboardWrite': {
      const text = requireString('text', 128 * 1024);
      return text.ok ? { ok: true, payload: { text: text.value } } : text;
    }
    case 'env.clipboardRead':
      return { ok: true, payload: {} };
    case 'env.openExternal': {
      const url = requireString('url', 2_048);
      return url.ok ? { ok: true, payload: { url: url.value } } : url;
    }
    case 'webview.create': {
      const viewType = payload.viewType;
      if (!isWebviewViewType(viewType)) {
        return { ok: false, error: 'webview.create requires a valid viewType.' };
      }
      // The extension API is synchronous: `webview.asWebviewUri()` and `webview.cspSource` have to
      // answer in the same tick the panel is created, before any round trip to Main could return.
      // So the host declares the identity it minted (128 crypto-random bits each) and Main decides
      // whether to accept it — an identity already in use is refused there.
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.create requires a webview handle.' };
      }
      if (!isWebviewToken(payload.token)) {
        return { ok: false, error: 'webview.create requires a webview origin token.' };
      }
      const surface = payload.surface === 'view' ? 'view' : 'panel';
      return {
        ok: true,
        payload: {
          surface,
          viewType,
          handle: payload.handle,
          token: payload.token,
          title: sanitizeWebviewTitle(payload.title),
          viewColumn: sanitizeViewColumn(payload.viewColumn),
          preserveFocus: payload.preserveFocus === true,
          options: sanitizeWebviewOptions(payload.options),
          panelOptions: sanitizeWebviewPanelOptions(payload.panelOptions),
        },
      };
    }
    case 'webview.setHtml': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.setHtml requires a webview handle.' };
      }
      if (typeof payload.html !== 'string') {
        return { ok: false, error: 'webview.setHtml requires html.' };
      }
      if (payload.html.length > MAX_WEBVIEW_HTML_CHARS) {
        return { ok: false, error: 'webview.setHtml exceeds the size limit for one document.' };
      }
      return { ok: true, payload: { handle: payload.handle, html: payload.html } };
    }
    case 'webview.setOptions': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.setOptions requires a webview handle.' };
      }
      return {
        ok: true,
        payload: { handle: payload.handle, options: sanitizeWebviewOptions(payload.options) },
      };
    }
    case 'webview.setTitle': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.setTitle requires a webview handle.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          title: sanitizeWebviewTitle(payload.title),
          description: clampString(payload.description, 200) ?? '',
        },
      };
    }
    case 'webview.setIconPath': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.setIconPath requires a webview handle.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          light: clampString(payload.light, 4_096) ?? '',
          dark: clampString(payload.dark, 4_096) ?? '',
        },
      };
    }
    case 'webview.setBadge': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.setBadge requires a webview handle.' };
      }
      const value = payload.value;
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          value:
            typeof value === 'number' && Number.isFinite(value)
              ? Math.max(0, Math.min(9_999, Math.round(value)))
              : null,
          tooltip: clampString(payload.tooltip, 200) ?? '',
        },
      };
    }
    case 'webview.reveal': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.reveal requires a webview handle.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          viewColumn: sanitizeViewColumn(payload.viewColumn),
          preserveFocus: payload.preserveFocus === true,
        },
      };
    }
    case 'webview.dispose': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.dispose requires a webview handle.' };
      }
      return { ok: true, payload: { handle: payload.handle } };
    }
    case 'webview.postMessage': {
      if (!isWebviewHandle(payload.handle)) {
        return { ok: false, error: 'webview.postMessage requires a webview handle.' };
      }
      const normalized = normalizeWebviewMessagePayload(payload.payload);
      if (normalized === null) {
        return { ok: false, error: 'webview.postMessage requires a JSON payload within budget.' };
      }
      return { ok: true, payload: { handle: payload.handle, payload: normalized.payload } };
    }
    case 'webview.registerViewProvider':
    case 'webview.unregisterViewProvider':
    case 'webview.registerSerializer': {
      if (!isWebviewViewType(payload.viewType)) {
        return { ok: false, error: `${kind} requires a valid viewType.` };
      }
      return {
        ok: true,
        payload: {
          viewType: payload.viewType,
          retainContextWhenHidden: payload.retainContextWhenHidden === true,
        },
      };
    }
    case 'tree.registerProvider': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.registerProvider requires a valid viewId.' };
      }
      return {
        ok: true,
        payload: {
          viewId: payload.viewId,
          canSelectMany: payload.canSelectMany === true,
          showCollapseAll: payload.showCollapseAll === true,
          hasResolve: payload.hasResolve === true,
          hasGetParent: payload.hasGetParent === true,
        },
      };
    }
    case 'tree.unregisterProvider': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.unregisterProvider requires a valid viewId.' };
      }
      return { ok: true, payload: { viewId: payload.viewId } };
    }
    case 'tree.refresh': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.refresh requires a valid viewId.' };
      }
      // `handles: null` is `onDidChangeTreeData` fired with no element: refresh everything.
      const handles = payload.handles;
      return {
        ok: true,
        payload: {
          viewId: payload.viewId,
          handles: Array.isArray(handles)
            ? stringArray(handles, MAX_TREE_SELECTION).map((handle) =>
                handle.slice(0, MAX_TREE_HANDLE_CHARS),
              )
            : null,
        },
      };
    }
    case 'tree.setTitle':
    case 'tree.setDescription':
    case 'tree.setMessage': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: `${kind} requires a valid viewId.` };
      }
      const field =
        kind === 'tree.setTitle'
          ? 'title'
          : kind === 'tree.setDescription'
            ? 'description'
            : 'message';
      return {
        ok: true,
        payload: { viewId: payload.viewId, [field]: clampString(payload[field], 1_024) },
      };
    }
    case 'tree.setBadge': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.setBadge requires a valid viewId.' };
      }
      const value = payload.value;
      return {
        ok: true,
        payload: {
          viewId: payload.viewId,
          value:
            typeof value === 'number' && Number.isFinite(value)
              ? Math.max(0, Math.min(9_999, Math.round(value)))
              : null,
          tooltip: clampString(payload.tooltip, 200) ?? '',
        },
      };
    }
    case 'tree.reveal': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.reveal requires a valid viewId.' };
      }
      const handle = clampString(payload.handle, MAX_TREE_HANDLE_CHARS);
      if (handle === null || handle.length === 0) {
        return { ok: false, error: 'tree.reveal requires a node handle.' };
      }
      const expand = payload.expand;
      return {
        ok: true,
        payload: {
          viewId: payload.viewId,
          handle,
          select: payload.select !== false,
          focus: payload.focus === true,
          // Upstream accepts `true` (one level) or a number up to three.
          expand:
            expand === true
              ? 1
              : typeof expand === 'number' && Number.isFinite(expand)
                ? Math.max(0, Math.min(3, Math.round(expand)))
                : 0,
        },
      };
    }
    case 'tree.setSelection': {
      if (!isTreeViewId(payload.viewId)) {
        return { ok: false, error: 'tree.setSelection requires a valid viewId.' };
      }
      return {
        ok: true,
        payload: {
          viewId: payload.viewId,
          handles: stringArray(payload.handles, MAX_TREE_SELECTION).map((handle) =>
            handle.slice(0, MAX_TREE_HANDLE_CHARS),
          ),
        },
      };
    }
    case 'context.setKey': {
      if (!isContextKeyName(payload.key)) {
        return { ok: false, error: 'setContext requires a valid key name.' };
      }
      // The value is narrowed here rather than in the service so that an extension gets an error
      // it can see, instead of a key that silently never appears in any `when` clause.
      const normalized = normalizeContextValue(payload.value);
      if (normalized === null) {
        return {
          ok: false,
          error: 'setContext accepts a boolean, number, string, null, or a flat array of those.',
        };
      }
      return {
        ok: true,
        payload: {
          key: payload.key,
          value: normalized.kind === 'remove' ? undefined : normalized.value,
          remove: normalized.kind === 'remove',
        },
      };
    }
    case 'languages.registerProvider': {
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: 'languages.registerProvider requires a provider handle.' };
      }
      if (!isLanguageFeature(payload.feature)) {
        return {
          ok: false,
          error: `languages.registerProvider does not know the feature ${String(payload.feature)}.`,
        };
      }
      // An empty selector is refused rather than treated as "everything": upstream scores a selector
      // against a document and a provider that matches nothing is a bug in the extension, whereas a
      // provider silently promoted to every language would be a bug in AXIOM.
      const selector = normalizeDocumentSelector(payload.selector);
      if (selector === null) {
        return { ok: false, error: 'languages.registerProvider requires a document selector.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          feature: payload.feature,
          selector,
          metadata: normalizeProviderMetadata(payload.metadata),
        },
      };
    }
    case 'languages.unregisterProvider':
    case 'languages.refreshProvider':
    case 'languages.providerChanged': {
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: `${kind} requires a provider handle.` };
      }
      return { ok: true, payload: { handle: payload.handle } };
    }
    case 'languages.registerLanguage': {
      const definition = normalizeLanguageDefinition(payload.definition);
      if (definition === null) {
        return { ok: false, error: 'languages.registerLanguage requires a valid language id.' };
      }
      return { ok: true, payload: { definition } };
    }
    case 'languages.setLanguageConfiguration': {
      if (!isLanguageId(payload.languageId)) {
        return {
          ok: false,
          error: 'languages.setLanguageConfiguration requires a valid language id.',
        };
      }
      return {
        ok: true,
        payload: {
          languageId: payload.languageId,
          configuration: normalizeLanguageConfiguration(payload.configuration),
        },
      };
    }
    case 'languages.setTextDocumentLanguage': {
      const uri = requireString('uri', MAX_HOST_URI);
      if (!uri.ok) return uri;
      if (!isLanguageId(payload.languageId)) {
        return {
          ok: false,
          error: 'languages.setTextDocumentLanguage requires a valid language id.',
        };
      }
      return { ok: true, payload: { uri: uri.value, languageId: payload.languageId } };
    }
    case 'languages.getLanguages':
      return { ok: true, payload: {} };
    case 'languages.getDiagnostics': {
      // No `uri` means "every document", which is what `languages.getDiagnostics()` returns with no
      // argument. That is a read of what other extensions published, so it is bounded by the
      // service, not here.
      const uri = clampString(payload.uri, MAX_HOST_URI);
      return { ok: true, payload: uri === null ? {} : { uri } };
    }
    case 'languages.applyWorkspaceEdit': {
      const edit = payload.edit;
      if (typeof edit !== 'object' || edit === null) {
        return { ok: false, error: 'languages.applyWorkspaceEdit requires an edit.' };
      }
      const entries = (edit as Record<string, unknown>).entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        return {
          ok: false,
          error: 'languages.applyWorkspaceEdit requires at least one operation.',
        };
      }
      // Shape only. Whether these operations may be applied is workspace policy, decided by
      // `validateWorkspaceEdit` where the workspace roots are known; deciding it twice in two places
      // is how the two answers drift apart.
      return { ok: true, payload: { edit: { entries: entries.slice(0, MAX_HOST_EDIT_ENTRIES) } } };
    }
    // -----------------------------------------------------------------------
    // Phase 7 — terminals
    // -----------------------------------------------------------------------
    case 'terminal.create': {
      // `options` is validated in full by `normalizeTerminalRequest`, which cannot fail; all this has
      // to establish is that there is an object to normalise and a handle to answer about. The handle
      // is minted by the worker so the `Terminal` object exists synchronously, exactly as upstream's
      // does — `createTerminal` returns a terminal, not a promise.
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: 'terminal.create requires a terminal handle.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          options:
            typeof payload.options === 'object' && payload.options !== null ? payload.options : {},
        },
      };
    }
    case 'terminal.dispose':
    case 'terminal.show':
    case 'terminal.hide': {
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: `${kind} requires a terminal handle.` };
      }
      return {
        ok: true,
        payload: { handle: payload.handle, preserveFocus: payload.preserveFocus === true },
      };
    }
    case 'terminal.sendText': {
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: 'terminal.sendText requires a terminal handle.' };
      }
      if (typeof payload.text !== 'string') {
        return { ok: false, error: 'terminal.sendText requires text.' };
      }
      return {
        ok: true,
        payload: {
          handle: payload.handle,
          text: payload.text.slice(0, MAX_HOST_STRING),
          addNewLine: payload.addNewLine !== false,
        },
      };
    }
    case 'terminal.setName': {
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: 'terminal.setName requires a terminal handle.' };
      }
      const name = requireString('name', 200);
      if (!name.ok) return name;
      return { ok: true, payload: { handle: payload.handle, name: name.value } };
    }
    case 'terminal.write': {
      // A `Pseudoterminal`'s own output. Escape sequences are allowed through — the extension *is* the
      // terminal here, and xterm.js is the renderer that interprets them — but the volume is capped,
      // because this is the one path where an extension writes to a pane without a process pacing it.
      if (!isProviderHandle(payload.handle)) {
        return { ok: false, error: 'terminal.write requires a terminal handle.' };
      }
      if (typeof payload.data !== 'string') {
        return { ok: false, error: 'terminal.write requires data.' };
      }
      return {
        ok: true,
        payload: { handle: payload.handle, data: payload.data.slice(0, MAX_HOST_STRING) },
      };
    }
    case 'terminal.registerProfileProvider':
    case 'terminal.unregisterProfileProvider': {
      const id = requireString('profileId', 200);
      if (!id.ok) return id;
      return { ok: true, payload: { profileId: id.value } };
    }
    case 'terminal.envMutate': {
      const variable = requireString('variable', 200);
      if (!variable.ok) return variable;
      const type = payload.type;
      if (type !== 'replace' && type !== 'append' && type !== 'prepend') {
        return { ok: false, error: 'terminal.envMutate requires type replace|append|prepend.' };
      }
      if (typeof payload.value !== 'string') {
        return { ok: false, error: 'terminal.envMutate requires a string value.' };
      }
      return {
        ok: true,
        payload: {
          variable: variable.value,
          value: payload.value.slice(0, 4_096),
          type,
          scope: clampString(payload.scope, MAX_HOST_URI) ?? '',
          applyAtProcessCreation: payload.applyAtProcessCreation !== false,
          applyAtShellIntegration: payload.applyAtShellIntegration === true,
          remove: payload.remove === true,
        },
      };
    }
    case 'terminal.envClear':
      return { ok: true, payload: { scope: clampString(payload.scope, MAX_HOST_URI) ?? '' } };
    case 'terminal.envDescribe':
      return {
        ok: true,
        payload: {
          description: clampString(payload.description, 500),
          persistent: payload.persistent !== false,
        },
      };
    // -----------------------------------------------------------------------
    // Phase 7 — tasks
    // -----------------------------------------------------------------------
    case 'tasks.registerProvider': {
      const type = requireString('type', 200);
      if (!type.ok) return type;
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'tasks.registerProvider requires a token.' };
      }
      return { ok: true, payload: { type: type.value, token: payload.token } };
    }
    case 'tasks.unregisterProvider': {
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'tasks.unregisterProvider requires a token.' };
      }
      return { ok: true, payload: { token: payload.token } };
    }
    case 'tasks.fetch':
      return { ok: true, payload: { type: clampString(payload.type, 200) } };
    case 'tasks.execute': {
      const task = payload.task;
      if (typeof task !== 'object' || task === null || Array.isArray(task)) {
        return { ok: false, error: 'tasks.execute requires a task.' };
      }
      // The task itself is normalised by `normalizeTask` and its execution refused by the service if
      // there is nothing to run. What cannot be deferred is the shape check: a non-object here would
      // reach a spawn as `undefined`.
      return { ok: true, payload: { task } };
    }
    case 'tasks.terminate': {
      if (!isProviderHandle(payload.executionId)) {
        return { ok: false, error: 'tasks.terminate requires an execution id.' };
      }
      return { ok: true, payload: { executionId: payload.executionId } };
    }
    case 'tasks.customDone': {
      if (!isProviderHandle(payload.executionId)) {
        return { ok: false, error: 'tasks.customDone requires an execution id.' };
      }
      const code = payload.exitCode;
      return {
        ok: true,
        payload: {
          executionId: payload.executionId,
          exitCode: typeof code === 'number' && Number.isFinite(code) ? Math.trunc(code) : 0,
        },
      };
    }
    // -----------------------------------------------------------------------
    // Phase 7 — debugging
    // -----------------------------------------------------------------------
    case 'debug.registerConfigurationProvider': {
      const debugType = requireString('debugType', 200);
      if (!debugType.ok) return debugType;
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'debug.registerConfigurationProvider requires a token.' };
      }
      return {
        ok: true,
        payload: {
          debugType: debugType.value,
          token: payload.token,
          trigger: payload.trigger === 'dynamic' ? 'dynamic' : 'initial',
        },
      };
    }
    case 'debug.registerAdapterFactory': {
      const debugType = requireString('debugType', 200);
      if (!debugType.ok) return debugType;
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'debug.registerAdapterFactory requires a token.' };
      }
      return { ok: true, payload: { debugType: debugType.value, token: payload.token } };
    }
    case 'debug.unregisterConfigurationProvider':
    case 'debug.unregisterAdapterFactory': {
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: `${kind} requires a token.` };
      }
      return { ok: true, payload: { token: payload.token } };
    }
    case 'debug.start': {
      const configuration = payload.configuration;
      if (typeof configuration !== 'object' || configuration === null) {
        return {
          ok: false,
          error: 'debug.start requires a configuration or a configuration name.',
        };
      }
      return {
        ok: true,
        payload: {
          configuration,
          folder: clampString(payload.folder, MAX_HOST_URI),
          parentSessionId: clampString(payload.parentSessionId, 200),
        },
      };
    }
    case 'debug.stop': {
      // No session id means "the active session", which is what `stopDebugging()` with no argument
      // does. An id that is not this extension's is refused by the service, not here.
      return { ok: true, payload: { sessionId: clampString(payload.sessionId, 200) } };
    }
    case 'debug.customRequest': {
      const sessionId = requireString('sessionId', 200);
      if (!sessionId.ok) return sessionId;
      const command = requireString('command', 200);
      if (!command.ok) return command;
      return {
        ok: true,
        payload: {
          sessionId: sessionId.value,
          command: command.value,
          args: payload.args === undefined ? {} : payload.args,
        },
      };
    }
    case 'debug.adapterMessage': {
      const sessionId = requireString('sessionId', 200);
      if (!sessionId.ok) return sessionId;
      const message = payload.message;
      if (typeof message !== 'object' || message === null) {
        return { ok: false, error: 'debug.adapterMessage requires a DAP message.' };
      }
      // Whether it *is* a DAP message is decided by `validateOutboundDapMessage`, next to the framing
      // it has to survive; duplicating the rule here would be a second answer to the same question.
      return { ok: true, payload: { sessionId: sessionId.value, message } };
    }
    case 'debug.appendConsole': {
      if (typeof payload.text !== 'string') {
        return { ok: false, error: 'debug.appendConsole requires text.' };
      }
      return {
        ok: true,
        payload: {
          sessionId: clampString(payload.sessionId, 200),
          text: payload.text.slice(0, MAX_HOST_STRING),
        },
      };
    }
    // -----------------------------------------------------------------------
    // Phase 7 — watchers and the rest of workspace.fs
    // -----------------------------------------------------------------------
    case 'workspace.createWatcher': {
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'workspace.createWatcher requires a token.' };
      }
      const pattern = payload.pattern;
      if (typeof pattern !== 'string' && (typeof pattern !== 'object' || pattern === null)) {
        return { ok: false, error: 'workspace.createWatcher requires a glob pattern.' };
      }
      return {
        ok: true,
        payload: {
          token: payload.token,
          pattern,
          ignoreCreateEvents: payload.ignoreCreateEvents === true,
          ignoreChangeEvents: payload.ignoreChangeEvents === true,
          ignoreDeleteEvents: payload.ignoreDeleteEvents === true,
        },
      };
    }
    case 'workspace.disposeWatcher': {
      if (!isProviderHandle(payload.token)) {
        return { ok: false, error: 'workspace.disposeWatcher requires a token.' };
      }
      return { ok: true, payload: { token: payload.token } };
    }
    case 'workspace.copyFile':
    case 'workspace.renameFile': {
      const source = requireString('source', MAX_HOST_URI);
      if (!source.ok) return source;
      const target = requireString('target', MAX_HOST_URI);
      if (!target.ok) return target;
      // Both paths are authorised against the workspace by the service, which is the only place that
      // knows the roots. `overwrite` defaults to false, as upstream's `FileSystem` does.
      return {
        ok: true,
        payload: {
          source: source.value,
          target: target.value,
          overwrite: payload.overwrite === true,
        },
      };
    }
    default:
      return { ok: false, error: `${String(kind)} is not a host request.` };
  }
}

/** A provider handle: minted by the worker, so validated rather than trusted. */
function isProviderHandle(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
  );
}

// ---------------------------------------------------------------------------
// Diagnostics carried across the boundary
// ---------------------------------------------------------------------------
export interface HostDiagnostic {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source: string;
  code: string;
  /**
   * The rest is Phase 6 and optional, so every existing consumer keeps working unchanged.
   *
   * Monaco draws `unnecessary` as a fade and `deprecated` as a strikethrough, and related
   * information is the "declared here" link a compiler diagnostic carries. A diagnostic that loses
   * them is still drawn, which is why they are additive rather than required.
   */
  tags?: Array<'unnecessary' | 'deprecated'>;
  relatedInformation?: HostDiagnosticRelated[];
  /** `Diagnostic.code.target` — the documentation link Monaco renders beside the code. */
  codeHref?: string;
}

export interface HostDiagnosticRelated {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
}

/** Related-information entries one diagnostic may carry. */
export const MAX_HOST_DIAGNOSTIC_RELATED = 32;

function normalizeDiagnosticRelated(value: unknown): HostDiagnosticRelated[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: HostDiagnosticRelated[] = [];
  for (const raw of value.slice(0, MAX_HOST_DIAGNOSTIC_RELATED)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const path = clampString(entry.path, 4_096);
    const message = clampString(entry.message, 1_000);
    if (path === null || path.length === 0 || message === null || message.length === 0) continue;
    const at = (candidate: unknown): number =>
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? Math.max(0, Math.floor(candidate))
        : 0;
    const startLine = at(entry.startLine);
    const startColumn = at(entry.startColumn);
    const endLine = Math.max(startLine, at(entry.endLine));
    out.push({
      path,
      startLine,
      startColumn,
      endLine,
      endColumn:
        endLine === startLine ? Math.max(startColumn, at(entry.endColumn)) : at(entry.endColumn),
      message,
    });
  }
  return out.length === 0 ? undefined : out;
}

function normalizeDiagnosticTags(value: unknown): Array<'unnecessary' | 'deprecated'> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<'unnecessary' | 'deprecated'> = [];
  for (const entry of value) {
    // Both the enum number and the wire name are accepted: the worker sends names, but a
    // diagnostic round-tripped through an extension's own serialisation can arrive as numbers.
    const tag =
      entry === 1 || entry === 'unnecessary'
        ? 'unnecessary'
        : entry === 2 || entry === 'deprecated'
          ? 'deprecated'
          : null;
    if (tag !== null && !out.includes(tag)) out.push(tag);
  }
  return out.length === 0 ? undefined : out;
}

/**
 * Normalize the diagnostics an extension published.
 *
 * Positions are clamped to non-negative integers and ordered, because a range with a
 * negative or inverted span reaches the editor as a decoration it cannot draw. Anything
 * without a message or a path is dropped rather than rendered as an empty marker.
 */
export function normalizeHostDiagnostics(entries: readonly unknown[]): HostDiagnostic[] {
  const out: HostDiagnostic[] = [];
  for (const raw of entries.slice(0, MAX_HOST_DIAGNOSTICS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const path = clampString(entry.path, 4_096);
    const message = clampString(entry.message, 2_000);
    if (path === null || path.length === 0 || message === null || message.length === 0) continue;
    const line = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const startLine = line(entry.startLine);
    const startColumn = line(entry.startColumn);
    const endLine = Math.max(startLine, line(entry.endLine));
    const endColumn =
      endLine === startLine ? Math.max(startColumn, line(entry.endColumn)) : line(entry.endColumn);
    const severity = entry.severity;
    const tags = normalizeDiagnosticTags(entry.tags);
    const relatedInformation = normalizeDiagnosticRelated(entry.relatedInformation);
    const codeHref = clampString(entry.codeHref, 2_048);
    out.push({
      path,
      startLine,
      startColumn,
      endLine,
      endColumn,
      message,
      severity:
        severity === 'warning' || severity === 'info' || severity === 'hint' ? severity : 'error',
      source: clampString(entry.source, 100) ?? '',
      code: clampString(entry.code, 100) ?? '',
      ...(tags ? { tags } : {}),
      ...(relatedInformation ? { relatedInformation } : {}),
      ...(codeHref !== null && codeHref.length > 0 ? { codeHref } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host status, as the UI and the model see it
// ---------------------------------------------------------------------------
export type HostState =
  'inactive' | 'starting' | 'active' | 'failed' | 'crashed' | 'disabled-after-crashes';

export interface HostStatus {
  extensionId: string;
  displayName: string;
  state: HostState;
  /** Commands the extension registered and can actually run. */
  commands: string[];
  /** Crashes counted inside the current window. */
  recentCrashes: number;
  /** Why it is not running, when it is not. */
  detail: string | null;
  /** Milliseconds its activate() took, when it activated. */
  activationMs: number | null;
}

export interface HostStatusBarItem {
  extensionId: string;
  id: string;
  text: string;
  tooltip: string;
  command: string;
  alignment: 'left' | 'right';
  priority: number;
}

/**
 * A question an extension is asking the user, on its way to the window.
 *
 * One shape for all three prompt kinds so the renderer has a single component and a single
 * reply path. The extension is always named in the payload — a dialog that does not say which
 * extension is asking is a dialog the user cannot make an informed decision about.
 */
export interface HostPromptRequest {
  id: number;
  kind: 'message' | 'quickPick' | 'inputBox';
  extensionId: string;
  displayName: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error';
  items?: string[];
  placeHolder?: string;
  prompt?: string;
  value?: string;
  password?: boolean;
}
