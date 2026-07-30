import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  HOST_PROTOCOL_VERSION,
  HOST_VSCODE_VERSION,
  MAX_HOST_COMMANDS,
  MAX_HOST_STATE_BYTES,
  MAX_HOST_STATUS_ITEMS,
  type HostInit,
  type HostRequestKind,
  type MainToWorker,
  type WorkerToMain,
} from '../common/vscodeHost';
import { webviewCspSource, webviewResourceUrl } from '../common/vscodeWebview';
import {
  MAX_TREE_CHILDREN,
  composeHandle,
  normalizeTreeItem,
  type WireTreeItem,
} from '../common/vscodeTree';
import {
  encodeSemanticTokens,
  normalizeSemanticTokensLegend,
  resolveTokenModifiers,
  resolveTokenType,
  type RawSemanticToken,
  type SemanticTokensLegendData,
} from '../common/vscodeSemanticTokens';
import {
  DocumentStore,
  offsetAt as offsetInText,
  positionAt as positionInText,
  toDocumentCandidate,
  type DocumentContentChange,
  type DocumentSnapshot,
} from '../common/vscodeDocumentSync';
import { scoreDocumentSelector, type DocumentSelector } from '../common/documentSelector';
import {
  normalizeTriggerCharacters,
  type LanguageFeature,
  type ProviderOp,
} from '../common/vscodeLanguages';
import {
  normalizeProviderResult,
  toWireWorkspaceEdit,
  type WireContext,
} from '../common/vscodeLanguageWire';
import { providerChangeEventName } from '../common/vscodeProviderEvents';

/**
 * The extension host process: one per activated extension.
 *
 * This file is the whole of AXIOM's `vscode` API. An extension `require`s `'vscode'`, gets
 * the object built here, and every call that needs to touch the machine or the window is
 * forwarded to Main as a validated request. Nothing in this process talks to the renderer,
 * the filesystem, or the network directly.
 *
 * Started with `utilityProcess.fork`, which matters for three reasons:
 *
 *   - It is a real child process, so a crash, an infinite loop, or a runaway allocation in
 *     one extension cannot take down the window or the other extensions.
 *   - It needs no `ELECTRON_RUN_AS_NODE` and no `process.execPath` juggling. The Node
 *     environment comes from Electron itself, so the packaged app keeps its RunAsNode fuse
 *     policy exactly as the release gate asserts it.
 *   - It has no `BrowserWindow`, no `ipcRenderer`, and no DOM. There is no path from
 *     extension code into the UI process except the request set below.
 *
 * What this file does NOT do is pretend. Members AXIOM has not implemented are not stubs
 * that silently succeed — reaching one throws an error naming the exact member, so an
 * extension author sees `vscode.debug.startDebugging is not implemented by AXIOM` in their
 * output channel instead of watching a call return `undefined` and debugging a ghost.
 *
 * Honest statement of the privilege this grants, repeated from the consent prompt Main
 * shows before ever starting one of these: extension code runs with the user's own OS
 * privileges. The request set below bounds what the *shim* offers, not what Node can do.
 */

// ---------------------------------------------------------------------------
// Parent port
// ---------------------------------------------------------------------------
/**
 * The utility-process message port, described locally rather than imported.
 *
 * `require('electron')` inside a utility process resolves to a stub, and importing it here
 * would put an Electron edge in this bundle for no gain. The port is three methods; naming
 * them is cheaper and clearer than depending on a global augmentation.
 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function send(message: WorkerToMain): void {
  parentPort?.postMessage(message);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  send({ t: 'log', level, message: message.slice(0, 2_000) });
}

// ---------------------------------------------------------------------------
// Request/response plumbing
// ---------------------------------------------------------------------------
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** Ask Main for something. Rejects with the broker's own message when refused. */
function request<T>(kind: HostRequestKind, payload: Record<string, unknown> = {}): Promise<T> {
  const id = nextRequestId++;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    pendingRequests.set(id, {
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    });
    send({ t: 'request', id, kind, payload });
  });
}

/** A member AXIOM has not implemented. Named so the failure is actionable. */
function notImplemented(member: string): never {
  throw new Error(
    `vscode.${member} is not implemented by AXIOM's extension host. The extension needs an API this build does not provide.`,
  );
}

/**
 * A namespace whose every unknown member fails loudly.
 *
 * Used to fill in the parts of the API that are not implemented. The alternative — leaving
 * them undefined — turns a missing API into `TypeError: x is not a function` with no clue
 * about which API was expected, and turns a missing *property* into silently wrong
 * behaviour. This way the first line of the error says what is missing.
 */
function strictNamespace<T extends object>(name: string, implemented: T): T {
  return new Proxy(implemented, {
    get(target, property, receiver) {
      if (property in target || typeof property === 'symbol') {
        return Reflect.get(target, property, receiver);
      }
      return notImplemented(`${name}.${String(property)}`);
    },
  });
}

// ---------------------------------------------------------------------------
// API value types
// ---------------------------------------------------------------------------
class Disposable {
  private disposeFn: (() => void) | null;

  constructor(callOnDispose: () => void) {
    this.disposeFn = callOnDispose;
  }

  static from(...items: Array<{ dispose: () => unknown }>): Disposable {
    return new Disposable(() => {
      for (const item of items) {
        try {
          item.dispose();
        } catch {
          // One failing disposal must not strand the rest.
        }
      }
    });
  }

  dispose(): void {
    const fn = this.disposeFn;
    this.disposeFn = null;
    fn?.();
  }
}

class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        log('warn', `An event listener threw: ${errorMessage(error)}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };

  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLineOrStart: number | Position,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (typeof startLineOrStart === 'number' && typeof startCharacterOrEnd === 'number') {
      const start = new Position(startLineOrStart, startCharacterOrEnd);
      const end = new Position(endLine ?? startLineOrStart, endCharacter ?? startCharacterOrEnd);
      this.start = start.isBefore(end) ? start : end;
      this.end = start.isBefore(end) ? end : start;
      return;
    }
    const start = startLineOrStart as Position;
    const end = startCharacterOrEnd as Position;
    this.start = start.isBefore(end) ? start : end;
    this.end = start.isBefore(end) ? end : start;
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    const target = positionOrRange instanceof Range ? positionOrRange.start : positionOrRange;
    const upper = positionOrRange instanceof Range ? positionOrRange.end : positionOrRange;
    return !target.isBefore(this.start) && !this.end.isBefore(upper);
  }

  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {
    super(anchor, active);
  }

  get isReversed(): boolean {
    return this.active.isBefore(this.anchor);
  }
}

/**
 * A URI, restricted to what AXIOM brokers.
 *
 * Only `file:` and `untitled:` are constructible from paths here. An extension that builds
 * some other scheme still gets a usable object — it just cannot be handed to a filesystem
 * request, because Main resolves requests from real paths and refuses anything else.
 */
class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  static file(path: string): Uri {
    const normalized = path.replaceAll('\\', '/');
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`, '', '');
  }

  static parse(value: string): Uri {
    try {
      const parsed = new URL(value);
      return new Uri(
        parsed.protocol.replace(/:$/, ''),
        parsed.host,
        decodeURIComponent(parsed.pathname),
        parsed.search.replace(/^\?/, ''),
        parsed.hash.replace(/^#/, ''),
      );
    } catch {
      return Uri.file(value);
    }
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, base.authority, joined, '', '');
  }

  get fsPath(): string {
    const raw = this.path.replace(/^\//, '');
    return /^[A-Za-z]:/.test(raw) ? raw.replaceAll('/', sep) : this.path.replaceAll('/', sep);
  }

  with(change: Partial<{ scheme: string; path: string; query: string; fragment: string }>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
  }

  toJSON(): Record<string, string> {
    return { scheme: this.scheme, path: this.path, fsPath: this.fsPath };
  }
}

class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range,
  ) {}
}

class Diagnostic {
  source?: string;
  /** The third form — `{value, target}` — is how a diagnostic carries a documentation link. */
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: unknown[];
  tags?: number[];

  constructor(
    readonly range: Range,
    readonly message: string,
    public severity: number = 0,
  ) {}
}

class DiagnosticRelatedInformation {
  constructor(
    readonly location: Location,
    readonly message: string,
  ) {}
}

class MarkdownString {
  isTrusted = false;
  supportThemeIcons = false;

  constructor(public value = '') {}

  appendText(value: string): MarkdownString {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(code: string, language = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class ThemeColor {
  constructor(readonly id: string) {}
}

class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

class RelativePattern {
  readonly baseUri: Uri;
  constructor(
    base: Uri | string,
    readonly pattern: string,
  ) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base;
  }
}

class TreeItem {
  label?: string | { label: string; highlights?: Array<[number, number]> };
  id?: string;
  iconPath?: unknown;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  command?: unknown;
  contextValue?: string;
  collapsibleState?: number;
  /** The file this row stands for. Drives the icon theme and the explorer-style label. */
  resourceUri?: Uri;
  /** `TreeItemCheckboxState`, or `{ state, tooltip }`. Absent means "no checkbox". */
  checkboxState?: number | { state: number; tooltip?: string };
  accessibilityInformation?: { label?: string; role?: string };

  constructor(labelOrUri: string | Uri | { label: string }, collapsibleState?: number) {
    if (typeof labelOrUri === 'string') {
      this.label = labelOrUri;
    } else if (labelOrUri instanceof Uri) {
      // Upstream's `TreeItem(resourceUri)` overload: the label comes from the path.
      this.resourceUri = labelOrUri;
    } else if (labelOrUri !== null && typeof labelOrUri === 'object') {
      this.label = labelOrUri as { label: string };
    }
    this.collapsibleState = collapsibleState ?? 0;
  }
}

// Enums, copied from the published API because extensions compare against the numbers.
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
const StatusBarAlignment = { Left: 1, Right: 2 } as const;
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
const ExtensionKind = { UI: 1, Workspace: 2 } as const;
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 } as const;
const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
const UIKind = { Desktop: 1, Web: 2 } as const;
const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const;
const EndOfLine = { LF: 1, CRLF: 2 } as const;
const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;
const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 } as const;
const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
} as const;
const CompletionItemTag = { Deprecated: 1 } as const;
const CompletionTriggerKind = {
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
} as const;
const SignatureHelpTriggerKind = {
  Invoke: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
} as const;
const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;
const SymbolTag = { Deprecated: 1 } as const;
const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 } as const;
const CodeActionTriggerKind = { Invoke: 1, Automatic: 2 } as const;
const InlayHintKind = { Type: 1, Parameter: 2 } as const;
const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 } as const;
const TextDocumentChangeReason = { Undo: 1, Redo: 2 } as const;
const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 } as const;
// PRD Phase 7. Same rule as above: the numbers are the contract, not the names.
const TerminalLocation = { Panel: 1, Editor: 2 } as const;
const TerminalExitReason = {
  Unknown: 0,
  Shutdown: 1,
  Process: 2,
  User: 3,
  Extension: 4,
} as const;
const EnvironmentVariableMutatorType = { Replace: 1, Append: 2, Prepend: 3 } as const;
const TaskRevealKind = { Always: 1, Silent: 2, Never: 3 } as const;
const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 } as const;
const ShellQuoting = { Escape: 1, Strong: 2, Weak: 3 } as const;
const TaskScope = { Global: 1, Workspace: 2 } as const;
const DebugConsoleMode = { Separate: 0, MergeWithParent: 1 } as const;
const DebugConfigurationProviderTriggerKind = { Initial: 1, Dynamic: 2 } as const;
const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 } as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// State held for the lifetime of the process
// ---------------------------------------------------------------------------
let context: HostInit | null = null;
let configuration: Record<string, unknown> = {};
let activeEditorSnapshot: { path: string; languageId: string } | null = null;
const commands = new Map<string, (...args: unknown[]) => unknown>();
const globalStateValues = new Map<string, unknown>();
const workspaceStateValues = new Map<string, unknown>();
const configurationEmitter = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();
const activeEditorEmitter = new EventEmitter<unknown>();
let statusItemCount = 0;

function requireContext(): HostInit {
  if (context === null) throw new Error('The extension host was used before initialization.');
  return context;
}

/** Persist a memento scope back to Main, bounded so one extension cannot fill the disk. */
function persistState(scope: 'global' | 'workspace'): void {
  const source = scope === 'global' ? globalStateValues : workspaceStateValues;
  const values: Record<string, unknown> = {};
  for (const [key, value] of source) values[key] = value;
  const encoded = JSON.stringify(values);
  if (encoded.length > MAX_HOST_STATE_BYTES) {
    log('warn', `${scope} state exceeds ${MAX_HOST_STATE_BYTES} bytes and was not saved.`);
    return;
  }
  send({ t: 'state', scope, values });
}

function memento(scope: 'global' | 'workspace') {
  const source = scope === 'global' ? globalStateValues : workspaceStateValues;
  return {
    keys: (): readonly string[] => [...source.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      source.has(key) ? (source.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) source.delete(key);
      else source.set(key, value);
      persistState(scope);
    },
    setKeysForSync: (): void => {
      // AXIOM has no settings-sync service, so there is nothing to mark. Reporting this as
      // unimplemented would break activation for extensions that call it defensively, and
      // the call has no observable effect either way.
    },
  };
}

/** Read a dotted configuration key out of the flat snapshot Main supplied. */
function configurationValue(section: string, key: string): unknown {
  const full = section.length > 0 ? `${section}.${key}` : key;
  return configuration[full];
}

function configurationSection(section: string) {
  const prefix = section.length > 0 ? `${section}.` : '';
  const api = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const value = configurationValue(section, key);
      return value === undefined ? defaultValue : (value as T);
    },
    has: (key: string): boolean => configurationValue(section, key) !== undefined,
    inspect: <T>(key: string) => {
      const value = configurationValue(section, key) as T | undefined;
      return {
        key: `${prefix}${key}`,
        defaultValue: undefined,
        globalValue: value,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      };
    },
    update: async (key: string): Promise<void> => {
      // Refused rather than silently dropped. An extension that believes it wrote a setting
      // and then reads its own default back produces behaviour no author can explain, so the
      // refusal is explicit and names the key.
      throw new Error(
        `AXIOM does not let extensions write settings (${prefix}${key}). Ask the user to change it in Settings.`,
      );
    },
  };
  return new Proxy(api, {
    get(target, property, receiver) {
      if (property in target || typeof property === 'symbol') {
        return Reflect.get(target, property, receiver);
      }
      // VS Code's WorkspaceConfiguration is also a plain bag of the section's values.
      return configurationValue(section, String(property));
    },
  });
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------
function publishCommands(): void {
  send({ t: 'commands', commands: [...commands.keys()].slice(0, MAX_HOST_COMMANDS) });
}

const commandsNamespace = strictNamespace('commands', {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown): Disposable => {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('vscode.commands.registerCommand requires a command id.');
    }
    if (commands.size >= MAX_HOST_COMMANDS && !commands.has(command)) {
      throw new Error(`An extension may register at most ${MAX_HOST_COMMANDS} commands.`);
    }
    commands.set(command, callback);
    publishCommands();
    return new Disposable(() => {
      commands.delete(command);
      publishCommands();
    });
  },
  registerTextEditorCommand: (
    command: string,
    callback: (...args: unknown[]) => unknown,
  ): Disposable => commandsNamespace.registerCommand(command, callback),
  executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T | undefined> => {
    // `setContext` is a workbench built-in, not an extension command: upstream routes it through
    // `executeCommand` and so do extensions, so it is intercepted here and turned into the one
    // request that can write the context-key store.
    if (command === 'setContext') {
      await request('context.setKey', { key: args[0], value: args[1] });
      return undefined;
    }
    const local = commands.get(command);
    if (local) return (await local(...args)) as T;
    return request<T>('commands.execute', { command, args });
  },
  getCommands: async (): Promise<string[]> => {
    const known = await request<string[]>('commands.registered');
    return [...new Set([...commands.keys(), ...known])];
  },
});

interface StatusBarItemState {
  id: string;
  text: string;
  tooltip: string;
  command: string;
  alignment: 'left' | 'right';
  priority: number;
  visible: boolean;
}

function createStatusBarItem(alignment?: number, priority?: number) {
  if (statusItemCount >= MAX_HOST_STATUS_ITEMS) {
    throw new Error(`An extension may own at most ${MAX_HOST_STATUS_ITEMS} status bar items.`);
  }
  statusItemCount += 1;
  const state: StatusBarItemState = {
    id: `item-${statusItemCount}`,
    text: '',
    tooltip: '',
    command: '',
    alignment: alignment === StatusBarAlignment.Left ? 'left' : 'right',
    priority: typeof priority === 'number' ? priority : 0,
    visible: false,
  };
  const flush = (): void => {
    if (!state.visible) return;
    void request('window.setStatusBarItem', {
      id: state.id,
      text: state.text,
      tooltip: state.tooltip,
      command: state.command,
      alignment: state.alignment,
      priority: state.priority,
    }).catch((error: unknown) => log('warn', `status bar update failed: ${errorMessage(error)}`));
  };
  const item = {
    get text(): string {
      return state.text;
    },
    set text(value: string) {
      state.text = String(value ?? '');
      flush();
    },
    get tooltip(): string {
      return state.tooltip;
    },
    set tooltip(value: string | MarkdownString) {
      state.tooltip = value instanceof MarkdownString ? value.value : String(value ?? '');
      flush();
    },
    get command(): string {
      return state.command;
    },
    set command(value: string | { command: string }) {
      state.command = typeof value === 'string' ? value : (value?.command ?? '');
      flush();
    },
    alignment: state.alignment === 'left' ? StatusBarAlignment.Left : StatusBarAlignment.Right,
    priority: state.priority,
    // Accepted and ignored: AXIOM's status bar paints from its own theme, and honouring an
    // extension-chosen background would let one extension repaint a shared surface.
    backgroundColor: undefined as ThemeColor | undefined,
    color: undefined as string | ThemeColor | undefined,
    name: '',
    accessibilityInformation: undefined,
    id: state.id,
    show: (): void => {
      state.visible = true;
      flush();
    },
    hide: (): void => {
      state.visible = false;
      void request('window.removeStatusBarItem', { id: state.id }).catch(() => undefined);
    },
    dispose: (): void => {
      item.hide();
    },
  };
  return item;
}

function createOutputChannel(name: string) {
  const append = (text: string): void => {
    void request('window.appendOutput', { channel: name, text }).catch(() => undefined);
  };
  return {
    name,
    append,
    appendLine: (text: string): void => append(`${text}\n`),
    replace: (text: string): void => append(text),
    clear: (): void => {
      void request('window.appendOutput', { channel: name, text: '\u0000clear' }).catch(
        () => undefined,
      );
    },
    show: (): void => undefined,
    hide: (): void => undefined,
    dispose: (): void => undefined,
    // Log-style channels are the same sink with a level prefix, which is what the log
    // methods produce in VS Code's own output view.
    trace: (text: string): void => append(`[trace] ${text}\n`),
    debug: (text: string): void => append(`[debug] ${text}\n`),
    info: (text: string): void => append(`[info] ${text}\n`),
    warn: (text: string): void => append(`[warn] ${text}\n`),
    error: (text: string): void => append(`[error] ${text}\n`),
    logLevel: LogLevel.Info,
    onDidChangeLogLevel: new EventEmitter<number>().event,
  };
}

// ---------------------------------------------------------------------------
// Webviews (PRD Phase 4)
// ---------------------------------------------------------------------------
/**
 * The webview API as extensions see it.
 *
 * Three things shape this code. The upstream API is synchronous where it matters —
 * `panel.webview.html = …` and `webview.asWebviewUri(u)` both have to work in the same tick the
 * panel is created — so a webview's identity (its handle and its origin token) is minted here
 * with `randomBytes` and *declared* to Main, which accepts it only if nothing else holds it.
 * Every effect still belongs to Main: this file owns no document, serves no file and decides no
 * policy, it forwards. And order matters more than latency, so each webview funnels its requests
 * through one promise chain: `setHtml` can never overtake the `create` that registers the handle
 * it names, however Main schedules its own work.
 */
interface WebviewIdentity {
  handle: string;
  token: string;
}

function mintWebviewIdentity(): WebviewIdentity {
  return { handle: randomBytes(8).toString('hex'), token: randomBytes(16).toString('hex') };
}

interface WebviewOptionsInput {
  enableScripts?: boolean;
  enableForms?: boolean;
  enableCommandUris?: boolean | string[];
  localResourceRoots?: readonly Uri[];
}

interface WebviewPanelOptionsInput {
  enableFindWidget?: boolean;
  retainContextWhenHidden?: boolean;
}

/** Roots cross the port as plain paths; Main narrows them to what the extension may read. */
function serializeWebviewOptions(
  options: WebviewOptionsInput | undefined,
): Record<string, unknown> {
  const roots = options?.localResourceRoots;
  return {
    enableScripts: options?.enableScripts === true,
    enableForms: options?.enableForms ?? options?.enableScripts === true,
    enableCommandUris: options?.enableCommandUris ?? false,
    localResourceRoots: Array.isArray(roots)
      ? roots.map((root) => (root instanceof Uri ? root.fsPath : String(root)))
      : undefined,
  };
}

/** The frame's `setState` value, as a `WebviewPanelSerializer` expects to receive it. */
function parseWebviewState(state: string | null): unknown {
  if (state === null || state.length === 0) return undefined;
  try {
    return JSON.parse(state) as unknown;
  } catch {
    return undefined;
  }
}

class WebviewImpl {
  readonly handle: string;
  private readonly token: string;
  private htmlValue = '';
  private optionsValue: WebviewOptionsInput;
  private queue: Promise<unknown>;
  private closed = false;
  private readonly messageEmitter = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.messageEmitter.event;

  constructor(
    identity: WebviewIdentity,
    options: WebviewOptionsInput | undefined,
    created: Promise<unknown>,
  ) {
    this.handle = identity.handle;
    this.token = identity.token;
    this.optionsValue = { ...(options ?? {}) };
    // The chain starts at whatever made this webview exist in Main — a `create` request for a
    // panel, an already-settled promise for a view the workbench asked us to resolve.
    this.queue = created;
  }

  /**
   * One mutation, in the order the extension made it. Panels and views route through here too,
   * which is why it is not private: a `reveal` that outran its own `setHtml` would flash an
   * empty frame.
   */
  send(kind: HostRequestKind, payload: Record<string, unknown> = {}): Promise<unknown> {
    const next = this.queue.then(() =>
      this.closed ? null : request(kind, { handle: this.handle, ...payload }),
    );
    this.queue = next.catch(() => null);
    return next;
  }

  get html(): string {
    return this.htmlValue;
  }

  set html(value: string) {
    this.htmlValue = String(value ?? '');
    void this.send('webview.setHtml', { html: this.htmlValue }).catch((error: unknown) => {
      log('warn', `A webview would not take its HTML: ${errorMessage(error)}`);
    });
  }

  get options(): WebviewOptionsInput {
    return this.optionsValue;
  }

  set options(value: WebviewOptionsInput) {
    this.optionsValue = { ...(value ?? {}) };
    void this.send('webview.setOptions', {
      options: serializeWebviewOptions(this.optionsValue),
    }).catch(() => undefined);
  }

  /** What an extension puts in its own CSP `script-src`/`style-src`. Synchronous, as upstream. */
  get cspSource(): string {
    return webviewCspSource(this.token);
  }

  asWebviewUri(resource: unknown): Uri {
    const fsPath =
      resource instanceof Uri
        ? resource.fsPath
        : String((resource as { fsPath?: unknown } | null)?.fsPath ?? resource ?? '');
    return Uri.parse(webviewResourceUrl(this.token, fsPath));
  }

  async postMessage(message: unknown): Promise<boolean> {
    return (await this.send('webview.postMessage', { payload: message ?? null })) === true;
  }

  /** Frame → extension, already validated and origin-checked by the renderer and by Main. */
  receive(payload: unknown): void {
    this.messageEmitter.fire(payload);
  }

  /** The webview is gone. Later sends resolve to `null` rather than reaching a dead handle. */
  close(): void {
    this.closed = true;
    this.messageEmitter.dispose();
  }
}

/**
 * A panel, disposed exactly once whichever side starts it.
 *
 * `dispose()` from the extension and a `webviewDispose` from Main converge on `finish()`, so an
 * extension that closes a panel the user already closed gets the upstream no-op instead of an
 * error, and `onDidDispose` fires once either way.
 */
class WebviewPanelImpl {
  readonly viewType: string;
  readonly webview: WebviewImpl;
  readonly options: { enableFindWidget: boolean; retainContextWhenHidden: boolean };
  viewColumn: number;
  active = false;
  visible = false;
  private titleValue: string;
  private iconValue: unknown = undefined;
  private disposed = false;
  private readonly disposeEmitter = new EventEmitter<void>();
  private readonly stateEmitter = new EventEmitter<{ webviewPanel: WebviewPanelImpl }>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onDidChangeViewState = this.stateEmitter.event;

  constructor(
    viewType: string,
    title: string,
    viewColumn: number,
    webview: WebviewImpl,
    panelOptions: WebviewPanelOptionsInput | undefined,
  ) {
    this.viewType = viewType;
    this.titleValue = String(title ?? '');
    this.viewColumn = viewColumn;
    this.webview = webview;
    this.options = {
      enableFindWidget: panelOptions?.enableFindWidget === true,
      retainContextWhenHidden: panelOptions?.retainContextWhenHidden === true,
    };
  }

  get title(): string {
    return this.titleValue;
  }

  set title(value: string) {
    this.titleValue = String(value ?? '');
    void this.webview
      .send('webview.setTitle', { title: this.titleValue, description: '' })
      .catch(() => undefined);
  }

  get iconPath(): unknown {
    return this.iconValue;
  }

  set iconPath(value: unknown) {
    this.iconValue = value;
    const pair = value as { light?: unknown; dark?: unknown } | undefined;
    const light = value instanceof Uri ? value : pair?.light;
    const dark = value instanceof Uri ? value : (pair?.dark ?? pair?.light);
    void this.webview
      .send('webview.setIconPath', {
        light: light instanceof Uri ? light.fsPath : '',
        dark: dark instanceof Uri ? dark.fsPath : '',
      })
      .catch(() => undefined);
  }

  reveal(viewColumn?: number, preserveFocus?: boolean): void {
    if (this.disposed) return;
    if (typeof viewColumn === 'number') this.viewColumn = viewColumn;
    void this.webview
      .send('webview.reveal', {
        viewColumn: this.viewColumn,
        preserveFocus: preserveFocus === true,
      })
      .catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    void this.webview.send('webview.dispose').catch(() => undefined);
    this.finish();
  }

  /** Terminal state: the panel is gone, from either side. */
  finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.active = false;
    webviewEntries.delete(this.webview.handle);
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.stateEmitter.dispose();
    this.webview.close();
  }

  applyViewState(visible: boolean, active: boolean): void {
    if (this.disposed || (this.visible === visible && this.active === active)) return;
    this.visible = visible;
    this.active = active;
    this.stateEmitter.fire({ webviewPanel: this });
  }
}

/** A sidebar/panel view resolved by a `WebviewViewProvider`. Owned by the workbench, not by us. */
class WebviewViewImpl {
  readonly viewType: string;
  readonly webview: WebviewImpl;
  visible: boolean;
  private titleValue: string | undefined;
  private descriptionValue: string | undefined;
  private badgeValue: { value: number; tooltip: string } | undefined;
  private disposed = false;
  private readonly disposeEmitter = new EventEmitter<void>();
  private readonly visibilityEmitter = new EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  readonly onDidChangeVisibility = this.visibilityEmitter.event;

  constructor(viewType: string, webview: WebviewImpl, visible: boolean) {
    this.viewType = viewType;
    this.webview = webview;
    this.visible = visible;
  }

  get title(): string | undefined {
    return this.titleValue;
  }

  set title(value: string | undefined) {
    this.titleValue = value;
    this.pushTitle();
  }

  get description(): string | undefined {
    return this.descriptionValue;
  }

  set description(value: string | undefined) {
    this.descriptionValue = value;
    this.pushTitle();
  }

  get badge(): { value: number; tooltip: string } | undefined {
    return this.badgeValue;
  }

  set badge(value: { value: number; tooltip: string } | undefined) {
    this.badgeValue = value;
    void this.webview
      .send('webview.setBadge', {
        value: typeof value?.value === 'number' ? value.value : null,
        tooltip: typeof value?.tooltip === 'string' ? value.tooltip : '',
      })
      .catch(() => undefined);
  }

  private pushTitle(): void {
    void this.webview
      .send('webview.setTitle', {
        title: this.titleValue ?? '',
        description: this.descriptionValue ?? '',
      })
      .catch(() => undefined);
  }

  show(preserveFocus?: boolean): void {
    if (this.disposed) return;
    void this.webview
      .send('webview.reveal', { viewColumn: -1, preserveFocus: preserveFocus === true })
      .catch(() => undefined);
  }

  applyVisibility(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.visibilityEmitter.fire();
  }

  finish(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    webviewEntries.delete(this.webview.handle);
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.visibilityEmitter.dispose();
    this.webview.close();
  }
}

interface WebviewEntry {
  webview: WebviewImpl;
  panel: WebviewPanelImpl | null;
  view: WebviewViewImpl | null;
  /** The frame's last `setState`, kept so a serializer or a re-resolved view sees it. */
  state: string | null;
}

const webviewEntries = new Map<string, WebviewEntry>();
const webviewViewProviders = new Map<
  string,
  { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }
>();
const webviewSerializers = new Map<
  string,
  { deserializeWebviewPanel: (panel: unknown, state: unknown) => unknown }
>();

function createWebviewPanel(
  viewType: string,
  title: string,
  showOptions: unknown,
  options?: WebviewOptionsInput & WebviewPanelOptionsInput,
): WebviewPanelImpl {
  const column =
    typeof showOptions === 'number'
      ? showOptions
      : ((showOptions as { viewColumn?: number } | null)?.viewColumn ?? ViewColumn.Active);
  const preserveFocus =
    typeof showOptions === 'object' && showOptions !== null
      ? (showOptions as { preserveFocus?: boolean }).preserveFocus === true
      : false;
  const identity = mintWebviewIdentity();
  const created = request('webview.create', {
    surface: 'panel',
    viewType: String(viewType ?? ''),
    handle: identity.handle,
    token: identity.token,
    title: String(title ?? ''),
    viewColumn: column,
    preserveFocus,
    options: serializeWebviewOptions(options),
    panelOptions: {
      enableFindWidget: options?.enableFindWidget === true,
      retainContextWhenHidden: options?.retainContextWhenHidden === true,
    },
  });
  const webview = new WebviewImpl(identity, options, created);
  const panel = new WebviewPanelImpl(
    String(viewType ?? ''),
    String(title ?? ''),
    column,
    webview,
    options,
  );
  panel.visible = !preserveFocus;
  panel.active = !preserveFocus;
  webviewEntries.set(identity.handle, { webview, panel, view: null, state: null });
  // Main refusing a panel (its per-extension cap, a duplicate identity) is not an exception the
  // extension asked for: it gets the panel it was handed, already disposed, which is the one
  // shape every caller of `createWebviewPanel` already handles.
  created.catch((error: unknown) => {
    log('warn', `A webview panel could not be created: ${errorMessage(error)}`);
    panel.finish();
  });
  return panel;
}

function registerWebviewViewProvider(
  viewType: string,
  provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown },
  options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
): Disposable {
  const key = String(viewType ?? '');
  if (typeof provider?.resolveWebviewView !== 'function') {
    throw new Error('registerWebviewViewProvider needs a provider with resolveWebviewView.');
  }
  webviewViewProviders.set(key, provider);
  void request('webview.registerViewProvider', {
    viewType: key,
    retainContextWhenHidden: options?.webviewOptions?.retainContextWhenHidden === true,
  }).catch((error: unknown) => {
    log('warn', `A webview view provider was not accepted: ${errorMessage(error)}`);
  });
  return new Disposable(() => {
    if (webviewViewProviders.get(key) === provider) webviewViewProviders.delete(key);
    void request('webview.unregisterViewProvider', { viewType: key }).catch(() => undefined);
  });
}

function registerWebviewPanelSerializer(
  viewType: string,
  serializer: { deserializeWebviewPanel: (panel: unknown, state: unknown) => unknown },
): Disposable {
  const key = String(viewType ?? '');
  if (typeof serializer?.deserializeWebviewPanel !== 'function') {
    throw new Error('registerWebviewPanelSerializer needs deserializeWebviewPanel.');
  }
  webviewSerializers.set(key, serializer);
  void request('webview.registerSerializer', { viewType: key }).catch((error: unknown) => {
    log('warn', `A webview serializer was not accepted: ${errorMessage(error)}`);
  });
  return new Disposable(() => {
    if (webviewSerializers.get(key) === serializer) webviewSerializers.delete(key);
  });
}

/** The workbench is showing a view this extension contributes: resolve it, once. */
async function resolveWebviewViewRequest(message: {
  id: number;
  handle: string;
  token: string;
  viewType: string;
  state: string | null;
  visible: boolean;
}): Promise<void> {
  const provider = webviewViewProviders.get(message.viewType);
  if (provider === undefined) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: `This extension does not provide the view ${message.viewType}.`,
    });
    return;
  }
  // Main already created the record, so the chain starts settled: there is nothing to wait for
  // before the provider's first `webview.html = …`.
  const webview = new WebviewImpl(
    { handle: message.handle, token: message.token },
    undefined,
    Promise.resolve(null),
  );
  const view = new WebviewViewImpl(message.viewType, webview, message.visible);
  webviewEntries.set(message.handle, { webview, panel: null, view, state: message.state });
  const source = new CancellationTokenSource();
  try {
    await provider.resolveWebviewView(
      view,
      { state: parseWebviewState(message.state) },
      source.token,
    );
    send({ t: 'result', id: message.id, ok: true, value: null });
  } catch (error) {
    view.finish();
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/** A panel persisted from a previous session, handed back to its serializer on first reveal. */
async function restoreWebviewPanelRequest(message: {
  id: number;
  handle: string;
  token: string;
  viewType: string;
  title: string;
  state: string | null;
  viewColumn: number;
}): Promise<void> {
  const serializer = webviewSerializers.get(message.viewType);
  if (serializer === undefined) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: `This extension does not restore ${message.viewType}.`,
    });
    return;
  }
  const webview = new WebviewImpl(
    { handle: message.handle, token: message.token },
    undefined,
    Promise.resolve(null),
  );
  const panel = new WebviewPanelImpl(
    message.viewType,
    message.title,
    message.viewColumn,
    webview,
    undefined,
  );
  panel.visible = true;
  panel.active = true;
  webviewEntries.set(message.handle, { webview, panel, view: null, state: message.state });
  try {
    await serializer.deserializeWebviewPanel(panel, parseWebviewState(message.state));
    send({ t: 'result', id: message.id, ok: true, value: null });
  } catch (error) {
    panel.finish();
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  }
}

// ---------------------------------------------------------------------------
// Tree views
// ---------------------------------------------------------------------------
/**
 * The extension side of a tree view.
 *
 * The provider's elements stay here. What leaves this process is a `WireTreeItem` per node and
 * nothing else — no element, no closure, no `Uri` instance. `elements` maps the handle Main will
 * quote back to us onto the object the provider gave us, and `handles` is the reverse, which is
 * what `reveal(element)` needs.
 */
interface TreeProviderLike {
  getChildren(element?: unknown): unknown;
  getTreeItem(element: unknown): unknown;
  getParent?(element: unknown): unknown;
  resolveTreeItem?(item: unknown, element: unknown, token: unknown): unknown;
  onDidChangeTreeData?: (listener: (element: unknown) => void) => { dispose(): void };
}

interface TreeEntry {
  viewId: string;
  provider: TreeProviderLike;
  elements: Map<string, unknown>;
  handles: Map<unknown, string>;
  view: TreeViewImpl | null;
  subscription: { dispose(): void } | null;
}

const treeEntries = new Map<string, TreeEntry>();

/** Convert the shim's own value classes to plain data, then narrow with the shared normalizer. */
function toWireTreeItem(raw: unknown, handle: string): WireTreeItem {
  const item = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const iconPath = item.iconPath;
  let icon: unknown = iconPath;
  if (iconPath instanceof ThemeIcon) {
    icon = {
      id: iconPath.id,
      color: iconPath.color instanceof ThemeColor ? iconPath.color.id : null,
    };
  } else if (iconPath instanceof Uri) {
    icon = iconPath.fsPath;
  } else if (iconPath !== null && typeof iconPath === 'object') {
    const pair = iconPath as { light?: unknown; dark?: unknown };
    icon = {
      light: pair.light instanceof Uri ? pair.light.fsPath : pair.light,
      dark: pair.dark instanceof Uri ? pair.dark.fsPath : pair.dark,
    };
  }
  const tooltip = item.tooltip;
  const command = item.command;
  return normalizeTreeItem(
    {
      id: item.id,
      label: item.label,
      description: item.description,
      tooltip: tooltip instanceof MarkdownString ? { value: tooltip.value } : (tooltip as unknown),
      iconPath: icon,
      resourceUri: item.resourceUri instanceof Uri ? item.resourceUri.toString() : item.resourceUri,
      contextValue: item.contextValue,
      command:
        typeof command === 'string'
          ? { command, title: command, arguments: [] }
          : (command as unknown),
      collapsibleState: item.collapsibleState,
      checkboxState: item.checkboxState,
      accessibilityInformation: item.accessibilityInformation,
    },
    handle,
  );
}

/** `vscode.TreeView`. Every setter is a request; every event is fired from a Main message. */
class TreeViewImpl {
  readonly onDidChangeSelectionEmitter = new EventEmitter<{ selection: unknown[] }>();
  readonly onDidChangeVisibilityEmitter = new EventEmitter<{ visible: boolean }>();
  readonly onDidExpandElementEmitter = new EventEmitter<{ element: unknown }>();
  readonly onDidCollapseElementEmitter = new EventEmitter<{ element: unknown }>();
  readonly onDidChangeCheckboxStateEmitter = new EventEmitter<{
    items: Array<[unknown, number]>;
  }>();

  readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event;
  readonly onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event;
  readonly onDidExpandElement = this.onDidExpandElementEmitter.event;
  readonly onDidCollapseElement = this.onDidCollapseElementEmitter.event;
  readonly onDidChangeCheckboxState = this.onDidChangeCheckboxStateEmitter.event;

  selection: unknown[] = [];
  visible = false;
  activeItem: unknown = undefined;

  private titleValue: string | undefined;
  private descriptionValue: string | undefined;
  private messageValue: string | undefined;
  private badgeValue: { value: number; tooltip: string } | undefined;

  constructor(readonly viewId: string) {}

  get title(): string | undefined {
    return this.titleValue;
  }

  set title(value: string | undefined) {
    this.titleValue = value;
    void request('tree.setTitle', { viewId: this.viewId, title: value ?? null }).catch(
      () => undefined,
    );
  }

  get description(): string | undefined {
    return this.descriptionValue;
  }

  set description(value: string | undefined) {
    this.descriptionValue = value;
    void request('tree.setDescription', {
      viewId: this.viewId,
      description: value ?? null,
    }).catch(() => undefined);
  }

  get message(): string | undefined {
    return this.messageValue;
  }

  set message(value: string | undefined) {
    this.messageValue = value;
    void request('tree.setMessage', { viewId: this.viewId, message: value ?? null }).catch(
      () => undefined,
    );
  }

  get badge(): { value: number; tooltip: string } | undefined {
    return this.badgeValue;
  }

  set badge(value: { value: number; tooltip: string } | undefined) {
    this.badgeValue = value;
    void request('tree.setBadge', {
      viewId: this.viewId,
      value: value?.value ?? null,
      tooltip: value?.tooltip ?? '',
    }).catch(() => undefined);
  }

  /**
   * `reveal(element)`.
   *
   * The element must already be one this view has handed out, or carry a `TreeItem.id` — those are
   * the two cases where a handle exists. Upstream can also walk `getParent` up from an element it
   * has never seen; AXIOM does not, and says so rather than resolving to nothing: a `reveal` that
   * quietly did nothing would look like a broken view.
   */
  async reveal(
    element: unknown,
    options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
  ): Promise<void> {
    const entry = treeEntries.get(this.viewId);
    if (entry === undefined) return;
    let handle = entry.handles.get(element);
    if (handle === undefined) {
      const item = await entry.provider.getTreeItem(element);
      const id = (item as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && id.length > 0) handle = composeHandle(null, 0, id);
    }
    if (handle === undefined) {
      throw new Error(
        `reveal() could not locate that element in ${this.viewId}. AXIOM can reveal an element the view has already produced, or one whose TreeItem has an id.`,
      );
    }
    await request('tree.reveal', {
      viewId: this.viewId,
      handle,
      select: options?.select !== false,
      focus: options?.focus === true,
      expand: options?.expand ?? false,
    });
  }

  dispose(): void {
    disposeTreeEntry(this.viewId);
  }
}

function disposeTreeEntry(viewId: string): void {
  const entry = treeEntries.get(viewId);
  if (entry === undefined) return;
  treeEntries.delete(viewId);
  try {
    entry.subscription?.dispose();
  } catch {
    // A provider whose disposal throws must not strand the unregistration.
  }
  void request('tree.unregisterProvider', { viewId }).catch(() => undefined);
}

/**
 * Attach a provider to a contributed view.
 *
 * `onDidChangeTreeData` is subscribed here and translated into a `tree.refresh`: with an element,
 * that element's handle; without one, `null` for the whole view. The handle map for the affected
 * subtree is *not* cleared, because a refresh that returns the same nodes should keep the user's
 * expansion — Main drops the descendants it had and asks again.
 */
function attachTreeProvider(
  viewId: string,
  provider: TreeProviderLike,
  view: TreeViewImpl | null,
  options?: { canSelectMany?: boolean; showCollapseAll?: boolean },
): Disposable {
  if (typeof provider?.getChildren !== 'function' || typeof provider?.getTreeItem !== 'function') {
    throw new Error('A TreeDataProvider needs getChildren and getTreeItem.');
  }
  disposeTreeEntry(viewId);
  const entry: TreeEntry = {
    viewId,
    provider,
    elements: new Map(),
    handles: new Map(),
    view,
    subscription: null,
  };
  treeEntries.set(viewId, entry);

  if (typeof provider.onDidChangeTreeData === 'function') {
    try {
      entry.subscription = provider.onDidChangeTreeData((element: unknown) => {
        const handle =
          element === undefined || element === null ? null : entry.handles.get(element);
        void request('tree.refresh', {
          viewId,
          handles: handle === undefined || handle === null ? null : [handle],
        }).catch(() => undefined);
      });
    } catch (error) {
      log(
        'warn',
        `A tree provider's onDidChangeTreeData could not be subscribed: ${errorMessage(error)}`,
      );
    }
  }

  void request('tree.registerProvider', {
    viewId,
    canSelectMany: options?.canSelectMany === true,
    showCollapseAll: options?.showCollapseAll === true,
    hasResolve: typeof provider.resolveTreeItem === 'function',
    hasGetParent: typeof provider.getParent === 'function',
  }).catch((error: unknown) => {
    log('warn', `A tree data provider was not accepted: ${errorMessage(error)}`);
  });

  return new Disposable(() => disposeTreeEntry(viewId));
}

function registerTreeDataProvider(viewId: string, provider: TreeProviderLike): Disposable {
  return attachTreeProvider(String(viewId ?? ''), provider, null);
}

function createTreeView(
  viewId: string,
  options: {
    treeDataProvider: TreeProviderLike;
    canSelectMany?: boolean;
    showCollapseAll?: boolean;
  },
): TreeViewImpl {
  const id = String(viewId ?? '');
  const view = new TreeViewImpl(id);
  attachTreeProvider(id, options?.treeDataProvider, view, options);
  return view;
}

/** Main wants a node's children. This is the only place `getChildren` is ever called. */
async function treeChildrenRequest(message: {
  id: number;
  viewId: string;
  handle: string | null;
}): Promise<void> {
  const entry = treeEntries.get(message.viewId);
  if (entry === undefined) {
    send({ t: 'result', id: message.id, ok: false, error: `No provider for ${message.viewId}.` });
    return;
  }
  const parent = message.handle === null ? undefined : entry.elements.get(message.handle);
  if (message.handle !== null && parent === undefined) {
    send({ t: 'result', id: message.id, ok: false, error: 'That node is no longer known.' });
    return;
  }
  try {
    const children = (await entry.provider.getChildren(parent)) ?? [];
    const list = Array.isArray(children) ? children.slice(0, MAX_TREE_CHILDREN) : [];
    const items: WireTreeItem[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const element = list[index];
      const raw = await entry.provider.getTreeItem(element);
      const declaredId = (raw as { id?: unknown } | undefined)?.id;
      const handle = composeHandle(
        message.handle,
        index,
        typeof declaredId === 'string' && declaredId.length > 0 ? declaredId : null,
      );
      entry.elements.set(handle, element);
      entry.handles.set(element, handle);
      items.push(toWireTreeItem(raw, handle));
    }
    send({ t: 'result', id: message.id, ok: true, value: items });
  } catch (error) {
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  }
}

/** `resolveTreeItem`: the tooltip or command the provider deferred until the row was hovered. */
async function treeResolveRequest(message: {
  id: number;
  viewId: string;
  handle: string;
}): Promise<void> {
  const entry = treeEntries.get(message.viewId);
  const element = entry?.elements.get(message.handle);
  if (entry === undefined || element === undefined) {
    send({ t: 'result', id: message.id, ok: false, error: 'That node is no longer known.' });
    return;
  }
  const source = new CancellationTokenSource();
  try {
    const item = await entry.provider.getTreeItem(element);
    const resolved =
      typeof entry.provider.resolveTreeItem === 'function'
        ? ((await entry.provider.resolveTreeItem(item, element, source.token)) ?? item)
        : item;
    send({
      t: 'result',
      id: message.id,
      ok: true,
      value: toWireTreeItem(resolved, message.handle),
    });
  } catch (error) {
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/** Expansion, selection, visibility and checkbox events, translated back into elements. */
function deliverTreeEvent(
  message:
    | { t: 'treeExpansion'; viewId: string; handle: string; expanded: boolean }
    | { t: 'treeSelection'; viewId: string; handles: string[] }
    | { t: 'treeVisibility'; viewId: string; visible: boolean }
    | { t: 'treeCheckbox'; viewId: string; items: Array<{ handle: string; checked: boolean }> },
): void {
  const entry = treeEntries.get(message.viewId);
  if (entry === undefined) return;
  const view = entry.view;
  switch (message.t) {
    case 'treeExpansion': {
      const element = entry.elements.get(message.handle);
      if (element === undefined || view === null) return;
      if (message.expanded) view.onDidExpandElementEmitter.fire({ element });
      else view.onDidCollapseElementEmitter.fire({ element });
      return;
    }
    case 'treeSelection': {
      const selection = message.handles
        .map((handle) => entry.elements.get(handle))
        .filter((element) => element !== undefined);
      if (view === null) return;
      view.selection = selection;
      view.activeItem = selection[selection.length - 1];
      view.onDidChangeSelectionEmitter.fire({ selection });
      return;
    }
    case 'treeVisibility': {
      if (view === null) return;
      view.visible = message.visible;
      view.onDidChangeVisibilityEmitter.fire({ visible: message.visible });
      return;
    }
    case 'treeCheckbox': {
      if (view === null) return;
      const items: Array<[unknown, number]> = [];
      for (const change of message.items) {
        const element = entry.elements.get(change.handle);
        if (element === undefined) continue;
        items.push([element, change.checked ? 1 : 0]);
      }
      if (items.length > 0) view.onDidChangeCheckboxStateEmitter.fire({ items });
      return;
    }
  }
}

/**
 * Main → extension, for a handle this process owns.
 *
 * A handle that is unknown here is simply ignored: it belongs to a webview this extension has
 * already disposed, and the alternative — throwing — would turn a race into a crash.
 */
function deliverWebviewMessage(handle: string, payload: unknown): void {
  webviewEntries.get(handle)?.webview.receive(payload);
}

function recordWebviewState(handle: string, state: string | null): void {
  const entry = webviewEntries.get(handle);
  if (entry !== undefined) entry.state = state;
}

function applyWebviewVisibility(handle: string, visible: boolean, active: boolean): void {
  const entry = webviewEntries.get(handle);
  if (entry === undefined) return;
  entry.panel?.applyViewState(visible, active);
  entry.view?.applyVisibility(visible);
}

function finishWebview(handle: string): void {
  const entry = webviewEntries.get(handle);
  if (entry === undefined) return;
  entry.panel?.finish();
  entry.view?.finish();
  webviewEntries.delete(handle);
}

// ---------------------------------------------------------------------------
// Terminals (PRD Phase 7 §1)
// ---------------------------------------------------------------------------
/**
 * Handles are minted twice and the two numbers are not the same.
 *
 * `createTerminal()` returns a `Terminal`, not a promise, so this worker has to hand one back before
 * Main has been asked for anything; but the registry that decides which extension owns which pane is
 * in Main, shared by every host, and mints its own handle. So a terminal starts with
 * `_axiomHandle === 0` and every operation on it is held until the create reply lands. That queue is
 * what makes `createTerminal()` followed by `sendText()` in the same tick behave as it does upstream.
 *
 * A `Pseudoterminal` never leaves the worker: it is a bag of functions, and functions do not survive
 * the structured clone to Main. What crosses is `pty: {}` — presence, not the object — and Main routes
 * the pane's input, resize, open and close back here by handle.
 */
/** Operations held while one terminal waits for Main's handle. Bounded like every Phase 7 registry. */
const MAX_QUEUED_TERMINAL_OPS = 64;

/** The `ExtensionTerminalInfo` Main answers `terminal.create` with. Only these fields are read. */
interface TerminalCreateReply {
  handle: number;
  name?: string;
}

/** An extension-supplied `Pseudoterminal`. Every member is optional until it has been checked. */
interface PseudoterminalLike {
  onDidWrite?: unknown;
  onDidClose?: unknown;
  onDidChangeName?: unknown;
  open?: (initialDimensions?: { columns: number; rows: number }) => unknown;
  close?: () => unknown;
  handleInput?: (data: string) => unknown;
  setDimensions?: (dimensions: { columns: number; rows: number }) => unknown;
}

/**
 * Subscribe to an extension-supplied `Event`, defensively.
 *
 * A `Pseudoterminal` or a `DebugAdapter` is an object literal an extension wrote, so any of its events
 * may be missing, or may not be a function, or may throw when subscribed to. None of those may take the
 * host down.
 */
function subscribeForeignEvent<T>(
  event: unknown,
  listener: (value: T) => void,
): (() => void) | null {
  if (typeof event !== 'function') return null;
  try {
    const subscription = (event as (listener: (value: T) => void) => unknown)(listener);
    const dispose = (subscription as { dispose?: unknown } | null | undefined)?.dispose;
    if (typeof dispose !== 'function') return null;
    return () => {
      try {
        (subscription as { dispose: () => void }).dispose();
      } catch {
        // A disposal that throws is the extension's problem, not a reason to leak the rest.
      }
    };
  } catch (error) {
    log('warn', `An extension event could not be subscribed to: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Call one member of an object an extension supplied without letting it end the host.
 *
 * Shared by a `Pseudoterminal` — reached as a terminal (§1) and as a task's `CustomExecution` (§2) — and
 * by an inline debug adapter (§3). All of them are called from a message handler, where a throw would
 * escape into `parentPort.on('message')` and take the extension down with it.
 */
function guardExtensionCall(label: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    log('warn', `${label} threw: ${errorMessage(error)}`);
  }
}

/** Every terminal this extension created, in creation order, closed ones removed. */
const terminalList: TerminalImpl[] = [];
/** By Main's handle, for the messages Main addresses to one terminal. */
const terminalsByHandle = new Map<number, TerminalImpl>();
/** Local handles, so the create request can be answered about a terminal that has no Main handle. */
let terminalHandleSeq = 0;
let activeTerminal: TerminalImpl | undefined;

const onDidOpenTerminalEmitter = new EventEmitter<TerminalImpl>();
const onDidCloseTerminalEmitter = new EventEmitter<TerminalImpl>();
const onDidChangeActiveTerminalEmitter = new EventEmitter<TerminalImpl | undefined>();
const onDidChangeTerminalStateEmitter = new EventEmitter<TerminalImpl>();

/** `TerminalProfile`: the object a `TerminalProfileProvider` returns. */
class TerminalProfile {
  constructor(public options: Record<string, unknown>) {}
}

/**
 * `Terminal`, as the extension holds it.
 *
 * Upstream's object is a handle with methods, and so is this one: the pane, the shell and the
 * ownership check all live elsewhere. What it adds is the pre-handle queue described above and, for a
 * `Pseudoterminal`, the wiring that turns the extension's own emitters into `terminal.write` and
 * `terminal.setName` requests.
 */
class TerminalImpl {
  /** Main's handle. 0 until `terminal.create` replies; every operation is queued until then. */
  _axiomHandle = 0;
  readonly creationOptions: Readonly<Record<string, unknown>>;
  readonly _pty: PseudoterminalLike | null;
  private currentName: string;
  private queued: Array<(handle: number) => void> = [];
  private failed = false;
  private closed = false;
  private ptyOpened = false;
  private ptySubscriptions: Array<() => void> = [];
  private processIdValue: number | undefined;
  private processIdSettled = false;
  private processIdWaiters: Array<(value: number | undefined) => void> = [];
  private exitStatusValue: { code: number | undefined; reason: number } | undefined;
  private stateValue: { readonly isInteractedWith: boolean } = { isInteractedWith: false };
  private shellIntegrationAvailable = false;

  constructor(name: string, options: Record<string, unknown>, pty: PseudoterminalLike | null) {
    this.currentName = name;
    this.creationOptions = Object.freeze({ ...options });
    this._pty = pty;
  }

  get name(): string {
    return this.currentName;
  }

  /** Upstream returns a thenable that settles when the shell exists. A pty terminal has no process. */
  get processId(): Promise<number | undefined> {
    if (this.processIdSettled) return Promise.resolve(this.processIdValue);
    if (this.processIdWaiters.length >= MAX_QUEUED_TERMINAL_OPS) {
      return Promise.resolve(undefined);
    }
    return new Promise<number | undefined>((resolve) => {
      this.processIdWaiters.push(resolve);
    });
  }

  get state(): { readonly isInteractedWith: boolean } {
    return this.stateValue;
  }

  get exitStatus(): { code: number | undefined; reason: number } | undefined {
    return this.exitStatusValue;
  }

  /**
   * `Terminal.shellIntegration`, present only while AXIOM's terminal reports it.
   *
   * Upstream's contract is that the property is `undefined` until integration is detected, so the
   * absence is the signal an extension checks. `cwd` is undefined because Main does not report one,
   * and `executeCommand` throws the standard message rather than pretending: an extension that runs a
   * command through a stub and gets no output back is worse off than one told the member is missing.
   */
  get shellIntegration(): { readonly cwd: undefined; executeCommand: () => never } | undefined {
    if (!this.shellIntegrationAvailable) return undefined;
    return {
      cwd: undefined,
      executeCommand: (): never => notImplemented('Terminal.shellIntegration.executeCommand'),
    };
  }

  sendText(text: string, addNewLine = true): void {
    const payload = { text: typeof text === 'string' ? text : String(text ?? ''), addNewLine };
    this._afterHandle((handle) => {
      void request('terminal.sendText', { handle, ...payload }).catch((error: unknown) => {
        log('warn', `terminal.sendText failed: ${errorMessage(error)}`);
      });
    });
  }

  show(preserveFocus?: boolean): void {
    this._afterHandle((handle) => {
      void request('terminal.show', { handle, preserveFocus: preserveFocus === true }).catch(
        () => undefined,
      );
    });
  }

  hide(): void {
    this._afterHandle((handle) => {
      void request('terminal.hide', { handle }).catch(() => undefined);
    });
  }

  /**
   * `Terminal.dispose()`.
   *
   * The pane is asked to close, and that is all: `onDidCloseTerminal` fires when Main reports the pane
   * actually gone, so it carries the real exit code and fires once however the terminal died.
   */
  dispose(): void {
    this.disposeRequested = true;
    this._afterHandle((handle) => {
      void request('terminal.dispose', { handle }).catch(() => undefined);
    });
  }

  /** Run `action` now if Main's handle is known, or once it is. Dropped if the create failed. */
  _afterHandle(action: (handle: number) => void): void {
    if (this.failed || this.closed) return;
    if (this._axiomHandle > 0) {
      action(this._axiomHandle);
      return;
    }
    if (this.queued.length >= MAX_QUEUED_TERMINAL_OPS) {
      log(
        'warn',
        'Too many terminal operations queued before the terminal existed; one was dropped.',
      );
      return;
    }
    this.queued.push(action);
  }

  /** Main answered `terminal.create`: adopt its handle and drain whatever was held. */
  _adopt(reply: TerminalCreateReply): void {
    const handle = Number(reply?.handle ?? 0);
    if (!Number.isInteger(handle) || handle <= 0) {
      this._failCreate(new Error('Main did not return a terminal handle.'));
      return;
    }
    this._axiomHandle = handle;
    terminalsByHandle.set(handle, this);
    if (typeof reply.name === 'string' && reply.name.length > 0) this.currentName = reply.name;
    this._wirePty();
    const held = this.queued;
    this.queued = [];
    for (const action of held) {
      try {
        action(handle);
      } catch (error) {
        log('warn', `A queued terminal operation failed: ${errorMessage(error)}`);
      }
    }
  }

  /** Main refused the terminal. Nothing was ever shown, so no close event is owed. */
  _failCreate(error: unknown): void {
    this.failed = true;
    this.queued = [];
    this.settleProcessId(undefined);
    const index = terminalList.indexOf(this);
    if (index >= 0) terminalList.splice(index, 1);
    log('warn', `A terminal could not be created: ${errorMessage(error)}`);
  }

  /**
   * Turn a `Pseudoterminal`'s own emitters into requests.
   *
   * Subscribed as soon as Main's handle is known rather than at `open()`, because an extension that
   * writes its banner immediately would otherwise lose it: the renderer holds early writes for a pane
   * that has not mounted yet, but only for writes it has actually been given.
   */
  private _wirePty(): void {
    const pty = this._pty;
    if (pty === null || this.ptySubscriptions.length > 0) return;
    const handle = this._axiomHandle;
    const write = subscribeForeignEvent<string>(pty.onDidWrite, (data) => {
      if (typeof data !== 'string' || data.length === 0) return;
      void request('terminal.write', { handle, data }).catch(() => undefined);
    });
    const close = subscribeForeignEvent<number | void>(pty.onDidClose, () => {
      this.disposeRequested = true;
      void request('terminal.dispose', { handle }).catch(() => undefined);
    });
    const rename = subscribeForeignEvent<string>(pty.onDidChangeName, (name) => {
      if (typeof name !== 'string' || name.length === 0) return;
      this.currentName = name.slice(0, 200);
      void request('terminal.setName', { handle, name: this.currentName }).catch(() => undefined);
    });
    for (const off of [write, close, rename]) if (off !== null) this.ptySubscriptions.push(off);
  }

  private settleProcessId(value: number | undefined): void {
    if (this.processIdSettled) return;
    this.processIdSettled = true;
    this.processIdValue = value;
    const waiters = this.processIdWaiters;
    this.processIdWaiters = [];
    for (const resolve of waiters) resolve(value);
  }

  /** The pane exists and has a session. This is where `onDidOpenTerminal` fires, as upstream. */
  _opened(processId: number | null): void {
    this.settleProcessId(typeof processId === 'number' ? processId : undefined);
    onDidOpenTerminalEmitter.fire(this);
  }

  /** The pane is gone. Fires once: Main removes its record on the same report. */
  _closed(exitCode: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitStatusValue = {
      code: typeof exitCode === 'number' ? exitCode : undefined,
      reason: this.disposeRequested
        ? TerminalExitReason.Extension
        : typeof exitCode === 'number'
          ? TerminalExitReason.Process
          : TerminalExitReason.User,
    };
    this.settleProcessId(this.processIdValue);
    for (const off of this.ptySubscriptions) off();
    this.ptySubscriptions = [];
    this.queued = [];
    if (this._axiomHandle > 0) terminalsByHandle.delete(this._axiomHandle);
    const index = terminalList.indexOf(this);
    if (index >= 0) terminalList.splice(index, 1);
    if (activeTerminal === this) {
      activeTerminal = undefined;
      onDidChangeActiveTerminalEmitter.fire(undefined);
    }
    onDidCloseTerminalEmitter.fire(this);
  }

  _applyState(isInteractedWith: boolean, shellIntegration: boolean): void {
    if (
      this.stateValue.isInteractedWith === isInteractedWith &&
      this.shellIntegrationAvailable === shellIntegration
    ) {
      return;
    }
    this.stateValue = { isInteractedWith };
    this.shellIntegrationAvailable = shellIntegration;
    onDidChangeTerminalStateEmitter.fire(this);
  }

  /** Keystrokes in the pane, for a terminal the extension implements. */
  _handleInput(data: string): void {
    this.callPty('handleInput', () => this._pty?.handleInput?.(data));
  }

  _setDimensions(columns: number, rows: number): void {
    this.callPty('setDimensions', () => this._pty?.setDimensions?.({ columns, rows }));
  }

  /** `Pseudoterminal.open`. Once per terminal: the pane is drawn once. */
  _openPty(columns: number, rows: number): void {
    if (this.ptyOpened) return;
    this.ptyOpened = true;
    this.callPty('open', () =>
      this._pty?.open?.(columns > 0 && rows > 0 ? { columns, rows } : undefined),
    );
  }

  /** `Pseudoterminal.close`. Delivered before `terminalClosed`, so the pty tears down first. */
  _closePty(): void {
    if (!this.ptyOpened) this.ptyOpened = true;
    this.callPty('close', () => this._pty?.close?.());
  }

  /** Extension code, called from a message handler. A throw here must not reach `parentPort`. */
  private callPty(member: string, run: () => unknown): void {
    if (this._pty === null) return;
    guardExtensionCall(`Pseudoterminal.${member}`, run);
  }

  private disposeRequested = false;
}

/**
 * `window.createTerminal`, in all three upstream shapes: `(name, shellPath, shellArgs)`,
 * `(TerminalOptions)` and `(ExtensionTerminalOptions)`.
 *
 * The request is sent after the split parent has a handle, if there is one, so a terminal split off a
 * terminal created in the same tick still lands in the right tab rather than silently becoming a new
 * one. Everything else about the options is Main's to validate — `normalizeTerminalRequest` never
 * throws, and it is the only thing that decides what a terminal is allowed to be.
 */
function createTerminal(
  optionsOrName?: unknown,
  shellPath?: unknown,
  shellArgs?: unknown,
): TerminalImpl {
  const raw: Record<string, unknown> =
    typeof optionsOrName === 'object' && optionsOrName !== null
      ? { ...(optionsOrName as Record<string, unknown>) }
      : {
          ...(typeof optionsOrName === 'string' ? { name: optionsOrName } : {}),
          ...(typeof shellPath === 'string' ? { shellPath } : {}),
          ...(shellArgs === undefined ? {} : { shellArgs }),
        };
  const pty =
    typeof raw.pty === 'object' && raw.pty !== null ? (raw.pty as PseudoterminalLike) : null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, 200) : 'Terminal';
  const terminal = new TerminalImpl(name, raw, pty);
  terminalList.push(terminal);
  const localHandle = ++terminalHandleSeq;
  const dispatch = (): void => {
    void request<TerminalCreateReply>('terminal.create', {
      handle: localHandle,
      options: wireTerminalOptions(raw, pty !== null),
    })
      .then((reply) => terminal._adopt(reply))
      .catch((error: unknown) => terminal._failCreate(error));
  };
  const parent = readSplitParent(raw.location);
  if (parent !== null) parent._afterHandle(dispatch);
  else dispatch();
  return terminal;
}

/** The terminal a `TerminalSplitLocationOptions` names, if this extension owns it. */
function readSplitParent(location: unknown): TerminalImpl | null {
  if (typeof location !== 'object' || location === null) return null;
  const parent = (location as { parentTerminal?: unknown }).parentTerminal;
  return parent instanceof TerminalImpl ? parent : null;
}

/** A `ThemeIcon`/`ThemeColor` id, or a bare id. Main re-validates; this only makes it cloneable. */
function readThemeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * `TerminalOptions` reduced to something that survives the structured clone.
 *
 * A `Uri` loses `fsPath` on the way across — it is a prototype getter — and a `Pseudoterminal` loses
 * everything, so both are converted here rather than trusted to clone. Nothing is validated: Main
 * normalises the result, and duplicating its rules here would only let the two drift apart.
 */
function wireTerminalOptions(
  raw: Record<string, unknown>,
  isPty: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.name === 'string') out.name = raw.name;
  if (typeof raw.shellPath === 'string') out.shellPath = raw.shellPath;
  if (typeof raw.shellArgs === 'string') out.shellArgs = raw.shellArgs;
  else if (Array.isArray(raw.shellArgs)) {
    out.shellArgs = raw.shellArgs.filter((value): value is string => typeof value === 'string');
  }
  const cwd = raw.cwd;
  if (typeof cwd === 'string') out.cwd = cwd;
  else if (cwd instanceof Uri) out.cwd = cwd.fsPath;
  else if (typeof cwd === 'object' && cwd !== null) {
    const fsPath = (cwd as { fsPath?: unknown }).fsPath;
    if (typeof fsPath === 'string') out.cwd = fsPath;
  }
  if (typeof raw.env === 'object' && raw.env !== null) {
    const env: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (value === null) env[key] = null;
      else if (typeof value === 'string') env[key] = value;
    }
    out.env = env;
  }
  if (raw.strictEnv === true) out.strictEnv = true;
  if (raw.hideFromUser === true) out.hideFromUser = true;
  if (raw.isTransient === true) out.isTransient = true;
  const icon = readThemeId(raw.iconPath);
  if (icon !== null) out.iconPath = icon;
  const color = readThemeId(raw.color);
  if (color !== null) out.color = color;
  if (typeof raw.message === 'string') out.message = raw.message;
  const location = wireTerminalLocation(raw.location);
  if (location !== null) out.location = location;
  if (isPty) out.pty = {};
  return out;
}

/** `TerminalLocation`, `TerminalEditorLocationOptions` or `TerminalSplitLocationOptions`. */
function wireTerminalLocation(location: unknown): unknown {
  if (location === TerminalLocation.Editor || location === TerminalLocation.Panel) return location;
  if (typeof location !== 'object' || location === null) return null;
  const out: Record<string, unknown> = {};
  const parent = readSplitParent(location);
  if (parent !== null && parent._axiomHandle > 0) {
    out.parentTerminal = { _axiomHandle: parent._axiomHandle };
  }
  const viewColumn = (location as { viewColumn?: unknown }).viewColumn;
  if (typeof viewColumn === 'number') out.viewColumn = viewColumn;
  return Object.keys(out).length > 0 ? out : null;
}

/** Mirrors Main's per-extension limit, so a runaway registration loop is refused here too. */
const MAX_TERMINAL_PROFILE_PROVIDERS = 8;

interface TerminalProfileProviderLike {
  provideTerminalProfile?: (token: { isCancellationRequested: boolean }) => unknown;
}

const terminalProfileProviders = new Map<string, TerminalProfileProviderLike>();

/**
 * `window.registerTerminalProfileProvider`.
 *
 * The provider stays here; Main records only that this extension answers for that profile id, and
 * asks when the user picks it from the terminal dropdown.
 */
function registerTerminalProfileProvider(id: unknown, provider: unknown): Disposable {
  const profileId = typeof id === 'string' ? id.slice(0, 200) : '';
  if (profileId.length === 0 || typeof provider !== 'object' || provider === null) {
    throw new Error('registerTerminalProfileProvider needs a profile id and a provider.');
  }
  if (
    !terminalProfileProviders.has(profileId) &&
    terminalProfileProviders.size >= MAX_TERMINAL_PROFILE_PROVIDERS
  ) {
    throw new Error(
      `An extension may contribute at most ${MAX_TERMINAL_PROFILE_PROVIDERS} terminal profiles.`,
    );
  }
  terminalProfileProviders.set(profileId, provider as TerminalProfileProviderLike);
  void request('terminal.registerProfileProvider', { profileId }).catch((error: unknown) => {
    // Refused in Main — usually the id belongs to another extension. Forget it here too, so the
    // dropdown and this map cannot disagree about who owns the profile.
    terminalProfileProviders.delete(profileId);
    log('warn', `The terminal profile ${profileId} was refused: ${errorMessage(error)}`);
  });
  return new Disposable(() => {
    terminalProfileProviders.delete(profileId);
    void request('terminal.unregisterProfileProvider', { profileId }).catch(() => undefined);
  });
}

/**
 * Answer `terminalProvideProfile`: the user picked this extension's profile from the dropdown.
 *
 * The `pty` is deliberately not forwarded. A profile resolves into options that AXIOM's own terminal
 * subsystem spawns, and no extension owns the resulting pane, so a `Pseudoterminal` here would never
 * be called — the pane would stay blank forever. Degrading to the shell the profile names leaves the
 * user with a working terminal instead.
 */
async function provideTerminalProfile(id: number, profileId: string): Promise<void> {
  const provider = terminalProfileProviders.get(profileId);
  if (provider === undefined || typeof provider.provideTerminalProfile !== 'function') {
    send({ t: 'result', id, ok: false, error: `No terminal profile provider for ${profileId}.` });
    return;
  }
  const source = new CancellationTokenSource();
  try {
    const result = await provider.provideTerminalProfile(source.token);
    const options =
      result instanceof TerminalProfile
        ? result.options
        : ((result as { options?: unknown } | null | undefined)?.options ?? result);
    const value =
      typeof options === 'object' && options !== null
        ? { options: wireTerminalOptions(options as Record<string, unknown>, false) }
        : null;
    send({ t: 'result', id, ok: true, value });
  } catch (error) {
    send({ t: 'result', id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/** `window.activeTerminal` changed. A handle this extension does not own reads as undefined. */
function applyActiveTerminal(handle: number | null): void {
  const next = handle === null ? undefined : terminalsByHandle.get(handle);
  if (activeTerminal === next) return;
  activeTerminal = next;
  onDidChangeActiveTerminalEmitter.fire(next);
}

// ---------------------------------------------------------------------------
// Environment variable collections (PRD Phase 7 §1)
// ---------------------------------------------------------------------------
/**
 * `context.environmentVariableCollection`.
 *
 * The authority is Main — it owns the persisted file and applies the mutations when a terminal is
 * spawned — but upstream's API is synchronous: `replace()` then `get()` must return the mutator. So the
 * collection is mirrored here as it is written, and a mutation Main refuses is rolled back out of the
 * mirror rather than left to make the two disagree.
 */
interface EnvMutator {
  readonly value: string;
  readonly type: number;
  readonly options: { applyAtProcessCreation: boolean; applyAtShellIntegration: boolean };
}

/** Mirrors Main's per-extension cap; the mirror cannot outgrow what Main will accept. */
const MAX_ENV_MUTATIONS_MIRRORED = 64;
/** Scoped collections an extension may hold at once. `getScoped` is memoised, so this is a cap. */
const MAX_ENV_SCOPES = 16;

const envMirror = new Map<string, Map<string, EnvMutator>>();
const envScopedCollections = new Map<string, EnvironmentVariableCollectionImpl>();
let envPersistent = true;
let envDescription: string | undefined;

function envMirrorFor(scope: string): Map<string, EnvMutator> {
  const existing = envMirror.get(scope);
  if (existing !== undefined) return existing;
  const created = new Map<string, EnvMutator>();
  envMirror.set(scope, created);
  return created;
}

function envMirrorSize(): number {
  let total = 0;
  for (const entries of envMirror.values()) total += entries.size;
  return total;
}

/** The scope key an `EnvironmentVariableScope` names: a workspace folder path, or global. */
function readEnvScope(scope: unknown): string {
  if (typeof scope !== 'object' || scope === null) return '';
  const folder = (scope as { workspaceFolder?: unknown }).workspaceFolder;
  if (typeof folder !== 'object' || folder === null) return '';
  const uri = (folder as { uri?: unknown }).uri;
  if (uri instanceof Uri) return uri.fsPath;
  const fsPath =
    typeof uri === 'object' && uri !== null ? (uri as { fsPath?: unknown }).fsPath : '';
  return typeof fsPath === 'string' ? fsPath : '';
}

class EnvironmentVariableCollectionImpl {
  constructor(private readonly scope: string) {}

  get persistent(): boolean {
    return envPersistent;
  }

  set persistent(value: boolean) {
    envPersistent = value !== false;
    this.describe();
  }

  get description(): string | undefined {
    return envDescription;
  }

  set description(value: string | { value?: string } | undefined) {
    envDescription =
      typeof value === 'string'
        ? value
        : typeof value === 'object' && value !== null && typeof value.value === 'string'
          ? value.value
          : undefined;
    this.describe();
  }

  replace(variable: string, value: string, options?: unknown): void {
    this.mutate(variable, value, EnvironmentVariableMutatorType.Replace, 'replace', options);
  }

  append(variable: string, value: string, options?: unknown): void {
    this.mutate(variable, value, EnvironmentVariableMutatorType.Append, 'append', options);
  }

  prepend(variable: string, value: string, options?: unknown): void {
    this.mutate(variable, value, EnvironmentVariableMutatorType.Prepend, 'prepend', options);
  }

  get(variable: string): EnvMutator | undefined {
    return envMirrorFor(this.scope).get(String(variable));
  }

  forEach(
    callback: (variable: string, mutator: EnvMutator, collection: unknown) => unknown,
    thisArg?: unknown,
  ): void {
    if (typeof callback !== 'function') return;
    for (const [variable, mutator] of [...envMirrorFor(this.scope)]) {
      callback.call(thisArg, variable, mutator, this);
    }
  }

  delete(variable: string): void {
    const name = String(variable);
    const entries = envMirrorFor(this.scope);
    const previous = entries.get(name);
    entries.delete(name);
    void request('terminal.envMutate', {
      variable: name,
      value: '',
      type: 'replace',
      scope: this.scope,
      remove: true,
    }).catch((error: unknown) => {
      if (previous !== undefined) entries.set(name, previous);
      log('warn', `An environment variable could not be removed: ${errorMessage(error)}`);
    });
  }

  clear(): void {
    const entries = envMirrorFor(this.scope);
    const previous = new Map(entries);
    entries.clear();
    void request('terminal.envClear', { scope: this.scope }).catch((error: unknown) => {
      for (const [variable, mutator] of previous) entries.set(variable, mutator);
      log(
        'warn',
        `An environment variable collection could not be cleared: ${errorMessage(error)}`,
      );
    });
  }

  /** `GlobalEnvironmentVariableCollection.getScoped`. Memoised so identity is stable per scope. */
  getScoped(scope: unknown): EnvironmentVariableCollectionImpl {
    const key = readEnvScope(scope);
    if (key.length === 0) return globalEnvironmentCollection;
    const existing = envScopedCollections.get(key);
    if (existing !== undefined) return existing;
    if (envScopedCollections.size >= MAX_ENV_SCOPES) {
      throw new Error(`An extension may scope at most ${MAX_ENV_SCOPES} environment collections.`);
    }
    const created = new EnvironmentVariableCollectionImpl(key);
    envScopedCollections.set(key, created);
    return created;
  }

  private describe(): void {
    void request('terminal.envDescribe', {
      ...(envDescription === undefined ? {} : { description: envDescription }),
      persistent: envPersistent,
    }).catch(() => undefined);
  }

  private mutate(
    variable: string,
    value: string,
    type: number,
    wireType: 'replace' | 'append' | 'prepend',
    options: unknown,
  ): void {
    const name = String(variable);
    const text = typeof value === 'string' ? value : String(value ?? '');
    const applyAtProcessCreation =
      (options as { applyAtProcessCreation?: unknown } | undefined)?.applyAtProcessCreation !==
      false;
    const applyAtShellIntegration =
      (options as { applyAtShellIntegration?: unknown } | undefined)?.applyAtShellIntegration ===
      true;
    const entries = envMirrorFor(this.scope);
    if (!entries.has(name) && envMirrorSize() >= MAX_ENV_MUTATIONS_MIRRORED) {
      throw new Error(
        `An extension may set at most ${MAX_ENV_MUTATIONS_MIRRORED} environment variables.`,
      );
    }
    const previous = entries.get(name);
    entries.set(name, {
      value: text,
      type,
      options: { applyAtProcessCreation, applyAtShellIntegration },
    });
    void request('terminal.envMutate', {
      variable: name,
      value: text,
      type: wireType,
      scope: this.scope,
      applyAtProcessCreation,
      applyAtShellIntegration,
    }).catch((error: unknown) => {
      if (previous === undefined) entries.delete(name);
      else entries.set(name, previous);
      log('warn', `An environment variable could not be set: ${errorMessage(error)}`);
    });
  }
}

const globalEnvironmentCollection = new EnvironmentVariableCollectionImpl('');

// ---------------------------------------------------------------------------
// Tasks (PRD Phase 7 §2)
// ---------------------------------------------------------------------------
/**
 * `vscode.tasks`.
 *
 * A task is data everywhere but one place: a `CustomExecution` is a function, so it cannot cross the
 * port. Everything else — the definition, the command, the arguments, the scope — is serialised here and
 * validated by `normalizeTask` in Main, which owns the spawn and the concurrency limit.
 *
 * The callback stays in this worker, keyed by the task's identity string (`source.type.name`), because
 * that is the only name both ends share when Main asks for it: `taskCustomStart` is sent *before*
 * `tasks.execute` has replied, so the execution id does not exist on this side yet.
 *
 * Executions are objects with identity. Extensions write
 * `tasks.onDidEndTask(e => { if (e.execution === mine) … })`, so an execution seen first in a broadcast
 * event and then again in the `executeTask` reply must be one object: `executionFor` is the only place
 * one is minted.
 */
/** Task providers this extension may register. Mirrors `MAX_TASK_PROVIDERS` in Main. */
const MAX_TASK_PROVIDERS = 16;
/** Tasks one `provideTasks` may return. Mirrors `MAX_TASKS_PER_PROVIDER`. */
const MAX_PROVIDED_TASKS = 200;
/** Tasks one `fetchTasks` will build objects for, however many Main collected. */
const MAX_FETCHED_TASKS = 1_000;
/** Executions tracked here at once. Mirrors `MAX_TRACKED_EXECUTIONS`. */
const MAX_TRACKED_TASK_EXECUTIONS = 64;
/** Retained `CustomExecution` callbacks: one per task this extension offered or ran. */
const MAX_RETAINED_CUSTOM_EXECUTIONS = 64;
/** Longest string carried in any task field. Main clamps to the same width. */
const MAX_TASK_TEXT = 4_096;
/** Arguments, shell arguments and environment entries one execution may carry. */
const MAX_TASK_ARGUMENTS = 128;
const MAX_TASK_ENV_VARS = 64;

/**
 * Strip NULs and clamp, then treat the empty string as absent — `taskString`'s rule in Main.
 *
 * Shared with the debug surface (§3), which sanitises the identifiers it sends the same way.
 */
function wireText(value: unknown, max = MAX_TASK_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replaceAll('\u0000', '').slice(0, max);
  return cleaned.length === 0 ? null : cleaned;
}

/** Read a field that should be an object without trusting that it is one. */
function wireRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The classes an extension builds a task out of.
 *
 * `instanceof` is load-bearing here: upstream resolves `Task`'s two constructor shapes and decides what
 * kind of execution a task carries by testing the class, and extensions do the same on tasks they get
 * back from `fetchTasks`. `wireTaskExecution` is the one place the class becomes a wire kind.
 */
class TaskGroup {
  static readonly Clean = new TaskGroup('clean', 'Clean');
  static readonly Build = new TaskGroup('build', 'Build');
  static readonly Rebuild = new TaskGroup('rebuild', 'Rebuild');
  static readonly Test = new TaskGroup('test', 'Test');

  constructor(
    readonly id: string,
    readonly label: string,
    readonly isDefault?: boolean,
  ) {}
}

/** A `ShellQuotedString`, or a bare string the shell renderer will quote conservatively. */
type ShellArgument = string | { value: string; quoting?: number };

class ProcessExecution {
  process: string;
  args: string[];
  options: Record<string, unknown> | undefined;

  constructor(
    command: string,
    argsOrOptions?: readonly string[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) {
    this.process = command;
    const hasArgs = Array.isArray(argsOrOptions);
    this.args = hasArgs ? [...(argsOrOptions as readonly string[])] : [];
    this.options = hasArgs
      ? options
      : ((argsOrOptions as Record<string, unknown> | undefined) ?? options);
  }
}

/**
 * `ShellExecution`, in both upstream shapes.
 *
 * `new ShellExecution(commandLine, options?)` is one already-quoted string; `new ShellExecution(command,
 * args, options?)` is a command plus arguments AXIOM quotes itself. They are told apart by whether the
 * second argument is an array, which is how upstream distinguishes them too, and they stay distinct all
 * the way to the spawn: only the first form is handed to a shell verbatim.
 */
class ShellExecution {
  commandLine: string | undefined;
  command: ShellArgument | undefined;
  args: ShellArgument[];
  options: Record<string, unknown> | undefined;

  constructor(
    commandLineOrCommand: ShellArgument,
    argsOrOptions?: readonly ShellArgument[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.commandLine = undefined;
      this.command = commandLineOrCommand;
      this.args = [...(argsOrOptions as readonly ShellArgument[])];
      this.options = options;
      return;
    }
    const single = typeof commandLineOrCommand === 'string';
    this.commandLine = single ? commandLineOrCommand : undefined;
    this.command = single ? undefined : commandLineOrCommand;
    this.args = [];
    this.options = (argsOrOptions as Record<string, unknown> | undefined) ?? options;
  }
}

/**
 * `CustomExecution`: the extension *is* the task.
 *
 * The callback is unreachable from outside the class, as it is upstream, and it never leaves this
 * worker. `_resolve` is the only way in, called from `taskCustomStart`.
 */
class CustomExecution {
  constructor(
    private readonly callback: (
      definition: Record<string, unknown>,
    ) => PseudoterminalLike | Promise<PseudoterminalLike>,
  ) {}

  async _resolve(definition: Record<string, unknown>): Promise<PseudoterminalLike> {
    return await this.callback(definition);
  }
}

type TaskExecutionValue = ProcessExecution | ShellExecution | CustomExecution | undefined;

/**
 * `Task`, with both the current constructor and the deprecated one that omits the scope.
 *
 * Extensions in the wild still use the four-argument form, and telling them apart is unambiguous: the
 * second argument is a `TaskScope` number or a `WorkspaceFolder` in the current shape and the task's
 * name in the old one.
 */
class Task {
  definition: Record<string, unknown>;
  scope: unknown;
  name: string;
  source: string;
  execution: TaskExecutionValue;
  problemMatchers: string[];
  isBackground = false;
  detail: string | undefined;
  group: TaskGroup | undefined;
  presentationOptions: Record<string, unknown> = {};
  runOptions: Record<string, unknown> = {};

  constructor(
    definition: Record<string, unknown>,
    scopeOrName: unknown,
    nameOrSource?: string,
    sourceOrExecution?: unknown,
    executionOrMatchers?: unknown,
    problemMatchers?: string | readonly string[],
  ) {
    const deprecated = typeof scopeOrName === 'string';
    this.definition = wireRecord(definition);
    this.scope = deprecated ? TaskScope.Workspace : scopeOrName;
    this.name = deprecated ? scopeOrName : (nameOrSource ?? '');
    this.source = deprecated
      ? (nameOrSource ?? '')
      : ((sourceOrExecution as string | undefined) ?? '');
    this.execution = (deprecated ? sourceOrExecution : executionOrMatchers) as TaskExecutionValue;
    const matchers = deprecated ? executionOrMatchers : problemMatchers;
    this.problemMatchers =
      typeof matchers === 'string'
        ? [matchers]
        : Array.isArray(matchers)
          ? matchers.filter((entry): entry is string => typeof entry === 'string')
          : [];
  }
}

/**
 * A running task. Opaque upstream apart from `task` and `terminate()`.
 *
 * The execution id is Main's, not this worker's: an execution is a real process on the other side of the
 * port and there is nothing to mint locally. `terminate()` is therefore a request, and Main checks that
 * the extension asking is the one that started the task or the one that provided it.
 */
class TaskExecution {
  constructor(
    readonly task: Task,
    readonly _axiomExecutionId: number,
  ) {}

  terminate(): void {
    if (this._axiomExecutionId <= 0) return;
    void request('tasks.terminate', { executionId: this._axiomExecutionId }).catch(
      (error: unknown) => {
        log('warn', `A task could not be terminated: ${errorMessage(error)}`);
      },
    );
  }
}

interface TaskProviderLike {
  provideTasks?: (token: unknown) => unknown;
  resolveTask?: (task: unknown, token: unknown) => unknown;
}

/** Registered providers, by this worker's own token — the one `taskProvide` carries back. */
const taskProviders = new Map<number, { type: string; provider: TaskProviderLike }>();
let taskProviderTokenSeq = 0;
/** Live executions by Main's execution id, so one execution is one object everywhere. */
const taskExecutionRegistry = new Map<number, TaskExecution>();
/** `Task` objects this extension passed to `executeTask`, until the first event names them. */
const pendingTaskObjects = new Map<string, Task>();
/** `CustomExecution` callbacks, by task identity. The function that never crosses the port. */
const customTaskCallbacks = new Map<string, CustomExecution>();
/** Custom tasks currently running here, by execution id. */
const runningCustomTasks = new Map<
  number,
  { pty: PseudoterminalLike; unsubscribe: Array<() => void>; reportsClose: boolean }
>();
const onDidStartTaskEmitter = new EventEmitter<{ execution: TaskExecution }>();
const onDidEndTaskEmitter = new EventEmitter<{ execution: TaskExecution }>();
const onDidStartTaskProcessEmitter = new EventEmitter<{
  execution: TaskExecution;
  processId: number | undefined;
}>();
const onDidEndTaskProcessEmitter = new EventEmitter<{
  execution: TaskExecution;
  exitCode: number | undefined;
}>();

/** One argument, as `normalizeTaskArgument` reads it: a string, or `{value, quoting}`. */
function wireTaskArgument(value: unknown): ShellArgument | null {
  if (typeof value === 'string') return wireText(value);
  if (typeof value !== 'object' || value === null) return null;
  const text = wireText((value as { value?: unknown }).value);
  if (text === null) return null;
  const quoting = (value as { quoting?: unknown }).quoting;
  return { value: text, ...(typeof quoting === 'number' ? { quoting } : {}) };
}

function wireTaskArguments(args: unknown): ShellArgument[] {
  if (!Array.isArray(args)) return [];
  const out: ShellArgument[] = [];
  for (const entry of args.slice(0, MAX_TASK_ARGUMENTS)) {
    const arg = wireTaskArgument(entry);
    if (arg !== null) out.push(arg);
  }
  return out;
}

/**
 * `ProcessExecutionOptions` / `ShellExecutionOptions`, reduced to the fields Main reads.
 *
 * `cwd` is converted here rather than relying on structured clone: extensions pass a `Uri` as often as a
 * string, and `Uri.fsPath` is a prototype getter that would clone as an empty object.
 */
function wireTaskOptions(raw: unknown): Record<string, unknown> {
  const source = wireRecord(raw);
  const out: Record<string, unknown> = {};
  const cwd = source.cwd instanceof Uri ? wireText(source.cwd.fsPath) : wireText(source.cwd);
  if (cwd !== null) out.cwd = cwd;
  if (typeof source.env === 'object' && source.env !== null) {
    const env: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of Object.entries(source.env as Record<string, unknown>)) {
      if (count >= MAX_TASK_ENV_VARS) break;
      if (typeof value !== 'string') continue;
      env[key.slice(0, 200)] = value.slice(0, MAX_TASK_TEXT);
      count += 1;
    }
    out.env = env;
  }
  const executable = wireText(source.executable);
  if (executable !== null) out.executable = executable;
  if (Array.isArray(source.shellArgs)) {
    out.shellArgs = source.shellArgs
      .slice(0, MAX_TASK_ARGUMENTS)
      .filter((entry): entry is string => typeof entry === 'string');
  }
  return out;
}

/**
 * Which execution the task carries, as a wire kind.
 *
 * Anything that is not one of the three classes becomes no execution at all, which is what upstream does
 * with a duck-typed object: the task can still be listed, and `executeTask` refuses it. A
 * `CustomExecution` sends its presence and nothing else — the callback stays here.
 */
function wireTaskExecution(execution: unknown): Record<string, unknown> | null {
  if (execution instanceof CustomExecution) return { kind: 'custom', custom: true, options: {} };
  if (execution instanceof ProcessExecution) {
    const command = wireText(execution.process);
    return {
      kind: 'process',
      ...(command === null ? {} : { command }),
      args: wireTaskArguments(execution.args),
      options: wireTaskOptions(execution.options),
    };
  }
  if (execution instanceof ShellExecution) {
    const command = wireTaskArgument(execution.command);
    const commandLine = wireText(execution.commandLine);
    return {
      kind: 'shell',
      ...(command === null ? {} : { command }),
      ...(commandLine === null ? {} : { commandLine }),
      args: wireTaskArguments(execution.args),
      options: wireTaskOptions(execution.options),
    };
  }
  return null;
}

/** `TaskScope.Global` / `.Workspace` / a `WorkspaceFolder`, as `normalizeTaskScope` reads them. */
function wireTaskScope(scope: unknown): unknown {
  if (scope === TaskScope.Global || scope === TaskScope.Workspace) return scope;
  if (typeof scope === 'object' && scope !== null) {
    const uri = (scope as { uri?: unknown }).uri;
    const path = uri instanceof Uri ? wireText(uri.fsPath) : wireText(uri);
    if (path !== null) return { uri: path };
  }
  return TaskScope.Workspace;
}

function readTaskGroupId(value: unknown): string | null {
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? (value as { id?: unknown }).id
        : null;
  return typeof id === 'string' ? id : null;
}

/**
 * One task, on the wire.
 *
 * Only primitives are copied out of `definition`: it is the extension's own opaque object, and Main
 * copies primitives too, but the structured clone happens first — a definition holding a function would
 * fail the post rather than being filtered.
 */
function wireTask(task: unknown): Record<string, unknown> {
  const source = wireRecord(task);
  const definition: Record<string, unknown> = {};
  let fields = 0;
  for (const [key, value] of Object.entries(wireRecord(source.definition))) {
    if (fields >= 64) break;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      definition[key.slice(0, 200)] =
        typeof value === 'string' ? value.slice(0, MAX_TASK_TEXT) : value;
      fields += 1;
    }
  }
  const name = wireText(source.name, 300);
  const origin = wireText(source.source, 200);
  const detail = wireText(source.detail, 1_000);
  const group = readTaskGroupId(source.group);
  const matchers = source.problemMatchers;
  return {
    definition,
    name: name ?? 'task',
    ...(origin === null ? {} : { source: origin }),
    ...(detail === null ? {} : { detail }),
    ...(group === null ? {} : { group }),
    scope: wireTaskScope(source.scope),
    isBackground: source.isBackground === true,
    problemMatchers:
      typeof matchers === 'string'
        ? [matchers]
        : Array.isArray(matchers)
          ? matchers
              .filter((entry): entry is string => typeof entry === 'string')
              .slice(0, 32)
              .map((entry) => entry.slice(0, 200))
          : [],
    execution: wireTaskExecution(source.execution),
  };
}

/**
 * The identity Main will give this task: `source.type.name`.
 *
 * Recomputed here, from the wire shape and with the same defaults `normalizeTask` applies, because it is
 * the key a `CustomExecution` is retained under and the only name shared with `taskCustomStart`. The two
 * must agree exactly, which is why both sides clamp the same fields to the same widths.
 */
function taskWireId(wire: Record<string, unknown>): string {
  const name = typeof wire.name === 'string' ? wire.name : 'task';
  const type = wireText(wireRecord(wire.definition).type, 200) ?? 'axiom';
  const declared = wireText(wire.source, 200);
  const origin = declared ?? context?.extensionId ?? '';
  return `${origin.length === 0 ? 'Workspace' : origin}.${type}.${name}`;
}

/** Hold a `CustomExecution` for a task, bounded, oldest dropped first. */
function retainCustomExecution(id: string, execution: CustomExecution): void {
  if (id.length === 0) return;
  if (!customTaskCallbacks.has(id) && customTaskCallbacks.size >= MAX_RETAINED_CUSTOM_EXECUTIONS) {
    const oldest = customTaskCallbacks.keys().next().value;
    if (typeof oldest === 'string') customTaskCallbacks.delete(oldest);
  }
  customTaskCallbacks.set(id, execution);
}

/** A `TaskSpec` from Main, back into the classes an extension expects to receive. */
function executionFromSpec(raw: unknown): ProcessExecution | ShellExecution | undefined {
  const spec = wireRecord(raw);
  const options: Record<string, unknown> = {};
  if (typeof spec.cwd === 'string') options.cwd = spec.cwd;
  if (typeof spec.env === 'object' && spec.env !== null) options.env = spec.env;
  if (typeof spec.shellExecutable === 'string') options.executable = spec.shellExecutable;
  if (Array.isArray(spec.shellArgs)) options.shellArgs = spec.shellArgs;
  const args = Array.isArray(spec.args) ? spec.args.map((entry) => argumentFromSpec(entry)) : [];
  const command = typeof spec.command === 'string' ? spec.command : '';
  if (spec.kind === 'shell') {
    if (typeof spec.commandLine === 'string' && spec.commandLine.length > 0) {
      return new ShellExecution(spec.commandLine, options);
    }
    return new ShellExecution(command, args, options);
  }
  if (spec.kind === 'process') {
    return new ProcessExecution(
      command,
      args.map((entry) => (typeof entry === 'string' ? entry : entry.value)),
      options,
    );
  }
  return undefined;
}

/** `TaskArgument` (string quoting) back into a `ShellQuotedString` (enum quoting). */
function argumentFromSpec(raw: unknown): ShellArgument {
  const spec = wireRecord(raw);
  const value = typeof spec.value === 'string' ? spec.value : '';
  const quoting =
    spec.quoting === 'escape'
      ? ShellQuoting.Escape
      : spec.quoting === 'strong'
        ? ShellQuoting.Strong
        : spec.quoting === 'weak'
          ? ShellQuoting.Weak
          : null;
  return quoting === null ? value : { value, quoting };
}

/**
 * A `TaskSpec` from Main as a `Task`.
 *
 * Used for `fetchTasks`, for the task a lifecycle event names, and for the task handed to `resolveTask`.
 * A `custom` execution comes back without one: the callback belongs to whichever host created it, and
 * inventing a `CustomExecution` here would claim work this extension cannot do.
 */
function taskFromSpec(raw: unknown): Task {
  const spec = wireRecord(raw);
  const scopePath = typeof spec.scopePath === 'string' ? spec.scopePath : '';
  const scope =
    spec.scope === 'global'
      ? TaskScope.Global
      : spec.scope === 'folder' && scopePath.length > 0
        ? {
            uri: Uri.file(scopePath),
            name: scopePath.split(/[\\/]/).pop() ?? scopePath,
            index: 0,
          }
        : TaskScope.Workspace;
  const task = new Task(
    wireRecord(spec.definition),
    scope,
    typeof spec.name === 'string' ? spec.name : 'task',
    typeof spec.source === 'string' ? spec.source : '',
    executionFromSpec(spec.execution),
    Array.isArray(spec.problemMatchers)
      ? spec.problemMatchers.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  if (typeof spec.detail === 'string') task.detail = spec.detail;
  task.isBackground = spec.isBackground === true;
  const group = taskGroupFor(spec.group);
  if (group !== undefined) task.group = group;
  return task;
}

/** The shared `TaskGroup` instance for an id, so `task.group === TaskGroup.Build` holds. */
function taskGroupFor(value: unknown): TaskGroup | undefined {
  switch (value) {
    case 'build':
      return TaskGroup.Build;
    case 'test':
      return TaskGroup.Test;
    case 'clean':
      return TaskGroup.Clean;
    case 'rebuild':
      return TaskGroup.Rebuild;
    default:
      return undefined;
  }
}

/**
 * The one place a `TaskExecution` is minted.
 *
 * `taskEvent` reaches every host and arrives before `executeTask` resolves, so the requester sees its own
 * execution first as an event. Both routes come through here and the second finds what the first made,
 * which is what lets an extension compare executions by identity.
 */
function executionFor(executionId: number, task: Task): TaskExecution {
  const existing = taskExecutionRegistry.get(executionId);
  if (existing !== undefined) return existing;
  const created = new TaskExecution(task, executionId);
  if (executionId > 0) {
    if (taskExecutionRegistry.size >= MAX_TRACKED_TASK_EXECUTIONS) {
      const oldest = taskExecutionRegistry.keys().next().value;
      if (typeof oldest === 'number') taskExecutionRegistry.delete(oldest);
    }
    taskExecutionRegistry.set(executionId, created);
  }
  return created;
}

function registerTaskProvider(type: unknown, provider: unknown): Disposable {
  const kind = wireText(type, 200);
  if (kind === null) throw new Error('registerTaskProvider needs a task type.');
  if (typeof provider !== 'object' || provider === null) {
    throw new Error('registerTaskProvider needs a provider object.');
  }
  if (taskProviders.size >= MAX_TASK_PROVIDERS) {
    throw new Error(`An extension may register at most ${MAX_TASK_PROVIDERS} task providers.`);
  }
  taskProviderTokenSeq += 1;
  const token = taskProviderTokenSeq;
  taskProviders.set(token, { type: kind, provider: provider as TaskProviderLike });
  void request('tasks.registerProvider', { type: kind, token }).catch((error: unknown) => {
    taskProviders.delete(token);
    log('warn', `A task provider could not be registered: ${errorMessage(error)}`);
  });
  return new Disposable(() => {
    if (!taskProviders.delete(token)) return;
    void request('tasks.unregisterProvider', { token }).catch(() => undefined);
  });
}

/**
 * `tasks.fetchTasks`: the workspace's own tasks plus every provider's, from every extension.
 *
 * The list is Main's — it holds `.vscode/tasks.json` and it is the only side that may ask another
 * extension's provider for its tasks.
 */
async function fetchTasks(filter?: { type?: string }): Promise<Task[]> {
  const type = wireText(filter?.type, 200);
  const specs = await request<unknown>('tasks.fetch', { ...(type === null ? {} : { type }) });
  if (!Array.isArray(specs)) return [];
  return specs.slice(0, MAX_FETCHED_TASKS).map((spec) => taskFromSpec(spec));
}

/**
 * `tasks.executeTask`.
 *
 * A `CustomExecution` is retained *before* the request goes out, because Main asks for it while this call
 * is still in flight. The `Task` object is parked under the same key so the `onDidStartTask` that arrives
 * first carries the extension's own task rather than a copy rebuilt from the wire.
 */
async function executeTask(task: unknown): Promise<TaskExecution> {
  const wire = wireTask(task);
  const id = taskWireId(wire);
  const local =
    task instanceof Task
      ? task
      : new Task(
          wireRecord(wire.definition),
          wire.scope,
          typeof wire.name === 'string' ? wire.name : 'task',
          typeof wire.source === 'string' ? wire.source : '',
        );
  if (local.execution instanceof CustomExecution) retainCustomExecution(id, local.execution);
  if (pendingTaskObjects.size >= MAX_TRACKED_TASK_EXECUTIONS) pendingTaskObjects.clear();
  pendingTaskObjects.set(id, local);
  try {
    const info = await request<unknown>('tasks.execute', { task: wire });
    const executionId = Number(wireRecord(info).executionId);
    return executionFor(Number.isFinite(executionId) ? executionId : 0, local);
  } finally {
    pendingTaskObjects.delete(id);
  }
}

const tasksNamespace = strictNamespace('tasks', {
  registerTaskProvider,
  fetchTasks,
  executeTask,
  get taskExecutions(): readonly TaskExecution[] {
    return [...taskExecutionRegistry.values()];
  },
  onDidStartTask: onDidStartTaskEmitter.event,
  onDidEndTask: onDidEndTaskEmitter.event,
  onDidStartTaskProcess: onDidStartTaskProcessEmitter.event,
  onDidEndTaskProcess: onDidEndTaskProcessEmitter.event,
});

/**
 * `provideTasks` on one of this extension's providers.
 *
 * The reply is a raw array — Main takes `Array.isArray(value)` and normalises each entry itself — and it
 * is round-tripped through JSON first: `wireTask` copies only primitives out of a definition, but a
 * provider is free to return anything at all and a `DataCloneError` on the port would look like a crash
 * rather than a bad task.
 */
async function dispatchTaskProvide(id: number, providerToken: number): Promise<void> {
  const entry = taskProviders.get(providerToken);
  if (entry === undefined || typeof entry.provider.provideTasks !== 'function') {
    send({ t: 'result', id, ok: false, error: 'That task provider is no longer registered.' });
    return;
  }
  const source = new CancellationTokenSource();
  try {
    const result = await entry.provider.provideTasks(source.token);
    const provided = Array.isArray(result) ? result.slice(0, MAX_PROVIDED_TASKS) : [];
    const wire: unknown[] = [];
    for (const task of provided) {
      const one = wireTask(task);
      if (task instanceof Task && task.execution instanceof CustomExecution) {
        retainCustomExecution(taskWireId(one), task.execution);
      }
      wire.push(one);
    }
    send({ t: 'result', id, ok: true, value: JSON.parse(JSON.stringify(wire)) });
  } catch (error) {
    send({ t: 'result', id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/** `resolveTask`: a provider fills in the execution for a task it listed without one. */
async function dispatchTaskResolve(id: number, providerToken: number, raw: unknown): Promise<void> {
  const entry = taskProviders.get(providerToken);
  if (entry === undefined || typeof entry.provider.resolveTask !== 'function') {
    // Upstream treats a provider with no `resolveTask` as leaving the task unresolved, not as an error.
    send({ t: 'result', id, ok: true, value: null });
    return;
  }
  const source = new CancellationTokenSource();
  try {
    const result = await entry.provider.resolveTask(taskFromSpec(raw), source.token);
    if (typeof result !== 'object' || result === null) {
      send({ t: 'result', id, ok: true, value: null });
      return;
    }
    const wire = wireTask(result);
    if (result instanceof Task && result.execution instanceof CustomExecution) {
      retainCustomExecution(taskWireId(wire), result.execution);
    }
    send({ t: 'result', id, ok: true, value: JSON.parse(JSON.stringify(wire)) });
  } catch (error) {
    send({ t: 'result', id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/**
 * Run a `CustomExecution`: the extension supplies the `Pseudoterminal` that *is* the task.
 *
 * The callback is looked up by task identity, so a host that never held it — an extension executing a task
 * another one provided — answers with an error and Main ends the execution instead of waiting on it.
 *
 * AXIOM has no task pane, so `onDidWrite` is subscribed and discarded rather than left unsubscribed: a
 * `Pseudoterminal` that buffers until someone listens would otherwise never run at all. What ends the
 * execution is `onDidClose`, which is also what upstream uses.
 */
async function startCustomTask(id: number, executionId: number, raw: unknown): Promise<void> {
  const spec = wireRecord(raw);
  const key = typeof spec.id === 'string' ? spec.id : '';
  const execution = customTaskCallbacks.get(key);
  if (execution === undefined) {
    send({
      t: 'result',
      id,
      ok: false,
      error: 'This extension does not hold that CustomExecution.',
    });
    return;
  }
  try {
    const pty = await execution._resolve(wireRecord(spec.definition));
    if (typeof pty !== 'object' || pty === null) {
      throw new Error('A CustomExecution must resolve to a Pseudoterminal.');
    }
    const unsubscribe: Array<() => void> = [];
    const closed = subscribeForeignEvent<unknown>(pty.onDidClose, (code) => {
      finishCustomTask(executionId, typeof code === 'number' ? code : 0);
    });
    if (closed) unsubscribe.push(closed);
    const written = subscribeForeignEvent<unknown>(pty.onDidWrite, () => undefined);
    if (written) unsubscribe.push(written);
    runningCustomTasks.set(executionId, { pty, unsubscribe, reportsClose: closed !== null });
    send({ t: 'result', id, ok: true, value: true });
    // The reply goes first: `open` is the task's body and may not return for as long as the build takes.
    // A body that throws immediately ends the execution here, or it would hold a concurrency slot with
    // nothing left to close it.
    try {
      pty.open?.(undefined);
    } catch (error) {
      log('warn', `Pseudoterminal.open threw: ${errorMessage(error)}`);
      finishCustomTask(executionId, 1);
    }
  } catch (error) {
    send({ t: 'result', id, ok: false, error: errorMessage(error) });
  }
}

/** Stop tracking one custom task and unsubscribe from its terminal. */
function forgetCustomTask(executionId: number): void {
  const entry = runningCustomTasks.get(executionId);
  if (entry === undefined) return;
  runningCustomTasks.delete(executionId);
  for (const off of entry.unsubscribe) off();
}

/** The custom task ended: tell Main, which turns it into the two end events. */
function finishCustomTask(executionId: number, exitCode: number): void {
  if (!runningCustomTasks.has(executionId)) return;
  forgetCustomTask(executionId);
  void request('tasks.customDone', { executionId, exitCode }).catch((error: unknown) => {
    log('warn', `A custom task could not report its result: ${errorMessage(error)}`);
  });
}

/**
 * The user or the extension cancelled a custom task.
 *
 * `close()` is the request to stop, and a well-behaved `Pseudoterminal` answers it by firing `onDidClose`,
 * which reports the result. One that has no close event is reported here instead, because Main's impolite
 * timer would otherwise be the only thing that ended it.
 */
function cancelCustomTask(executionId: number): void {
  const entry = runningCustomTasks.get(executionId);
  if (entry === undefined) return;
  guardExtensionCall('Pseudoterminal.close', () => entry.pty.close?.());
  if (!entry.reportsClose) finishCustomTask(executionId, 1);
}

/**
 * One of the four lifecycle phases, from Main, for a task any extension started.
 *
 * The order is Main's, which is upstream's: `onDidStartTask` before the process starts,
 * `onDidEndTaskProcess` before `onDidEndTask`, and no process events at all for a `CustomExecution`.
 */
function applyTaskEvent(message: {
  phase: 'start' | 'processStart' | 'processEnd' | 'end';
  executionId: number;
  task: unknown;
  processId: number | null;
  exitCode: number | null;
}): void {
  const spec = wireRecord(message.task);
  const key = typeof spec.id === 'string' ? spec.id : '';
  const parked = pendingTaskObjects.get(key);
  const execution = executionFor(message.executionId, parked ?? taskFromSpec(spec));
  switch (message.phase) {
    case 'start':
      pendingTaskObjects.delete(key);
      onDidStartTaskEmitter.fire({ execution });
      return;
    case 'processStart':
      onDidStartTaskProcessEmitter.fire({
        execution,
        processId: message.processId ?? undefined,
      });
      return;
    case 'processEnd':
      onDidEndTaskProcessEmitter.fire({ execution, exitCode: message.exitCode ?? undefined });
      return;
    case 'end':
      taskExecutionRegistry.delete(message.executionId);
      forgetCustomTask(message.executionId);
      onDidEndTaskEmitter.fire({ execution });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Debugging (PRD Phase 7 §3)
// ---------------------------------------------------------------------------
/**
 * The debug surface: configuration providers, adapter descriptor factories, sessions and the console.
 *
 * Main owns every session — it starts the adapter, frames DAP, and decides which extension may address
 * which session — so nothing here holds a process or a socket. What lives in the worker is the part that
 * cannot leave it: an extension's provider objects, its descriptor factories, and the one descriptor that
 * *is* an object with methods on it, `DebugAdapterInlineImplementation`. That one is kept in a
 * session-keyed map and reached through `debugAdapterMessage`, because a function cannot be cloned onto
 * the port; every other descriptor is flattened to the record Main's normaliser reads.
 */
const MAX_DEBUG_CONFIG_PROVIDERS = 16;
const MAX_DEBUG_ADAPTER_FACTORIES = 16;
/** Sessions this worker has been told about. Bounded because a launch that fails after the descriptor
 * request is discarded by Main without a termination broadcast, so the map needs its own ceiling. */
const MAX_TRACKED_DEBUG_SESSIONS = 64;
const MAX_INLINE_ADAPTERS = 8;
/** How many configurations one `provideDebugConfigurations` call may contribute. */
const MAX_PROVIDED_DEBUG_CONFIGURATIONS = 64;

/** A `WorkspaceFolder` for a path Main named, in the shape `workspace.workspaceFolders` returns. */
function debugFolder(path: string | null): unknown {
  if (path === null || path.length === 0) return undefined;
  return { uri: Uri.file(path), name: path.split(/[\\/]/).pop() ?? path, index: 0 };
}

/**
 * Flatten a value an extension produced into something the port will carry.
 *
 * A configuration a provider rewrote can hold a `Uri`, a class instance or a cycle, and a DAP message an
 * inline adapter sends is whatever the extension built. JSON is the one conversion that reduces all of
 * them to what Main's own normalisers expect to receive, and a `DataCloneError` on the port would look
 * like a crash rather than a bad value.
 */
function debugClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return null;
  }
}

/**
 * `DebugSession`.
 *
 * One object per session id for as long as Main says the session exists, because extensions compare
 * sessions by identity and key maps on them. `customRequest` is the only member that leaves the worker,
 * and Main checks the session is this extension's before the request reaches an adapter.
 *
 * `parentSession` and `workspaceFolder` are settable because the session can be created here before Main
 * has announced it — a descriptor request names neither — and the announcement fills them in on the object
 * the extension already holds.
 */
class DebugSessionImpl {
  constructor(
    readonly id: string,
    readonly type: string,
    public name: string,
    readonly configuration: Record<string, unknown>,
    public parentSession: DebugSessionImpl | undefined,
    public workspaceFolder: unknown,
  ) {}

  async customRequest(command: string, args?: unknown): Promise<unknown> {
    const verb = typeof command === 'string' ? command.slice(0, 200) : '';
    if (verb.length === 0) throw new Error('DebugSession.customRequest needs a command.');
    return await request('debug.customRequest', {
      sessionId: this.id,
      command: verb,
      ...(args === undefined ? {} : { args: debugClone(args) }),
    });
  }
}

/**
 * `debug.activeDebugConsole`.
 *
 * Upstream's console always exists and always belongs to whichever session is active, so this is one
 * object rather than one per session: the empty session id is how Main is asked for the active one. A
 * write that lands while another extension's session is in front is dropped rather than raised — an
 * extension logging into the void is upstream's behaviour, an exception on a log call is not.
 */
class DebugConsoleImpl {
  append(value: unknown): void {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length === 0) return;
    void request('debug.appendConsole', { sessionId: '', text }).catch(() => undefined);
  }

  appendLine(value: unknown): void {
    this.append(`${typeof value === 'string' ? value : String(value ?? '')}\n`);
  }
}

/** `DebugAdapterExecutable`: the adapter is a program Main starts. */
class DebugAdapterExecutable {
  readonly args: string[];

  constructor(
    readonly command: string,
    args?: string[],
    readonly options?: { cwd?: string; env?: Record<string, string> },
  ) {
    this.args = Array.isArray(args) ? [...args] : [];
  }
}

/** `DebugAdapterServer`: the adapter already listens on a port. Main pins the host to loopback. */
class DebugAdapterServer {
  constructor(
    readonly port: number,
    readonly host?: string,
  ) {}
}

/** `DebugAdapterNamedPipeServer`: the adapter already listens on a pipe or socket path. */
class DebugAdapterNamedPipeServer {
  constructor(readonly path: string) {}
}

/**
 * `DebugAdapterInlineImplementation`: the extension *is* the adapter.
 *
 * The implementation never crosses the port. It stays here, keyed by session id, and Main routes the
 * session's DAP traffic to this worker instead of to a process.
 */
class DebugAdapterInlineImplementation {
  constructor(readonly implementation: DebugAdapterLike) {}
}

/** An extension-supplied `DebugAdapter`. Every member is optional until it has been checked. */
interface DebugAdapterLike {
  onDidSendMessage?: unknown;
  handleMessage?: (message: unknown) => unknown;
  dispose?: () => unknown;
}

/** An extension-supplied `DebugConfigurationProvider`. */
interface DebugConfigProviderLike {
  provideDebugConfigurations?: unknown;
  resolveDebugConfiguration?: unknown;
  resolveDebugConfigurationWithSubstitutedVariables?: unknown;
}

/** An extension-supplied `DebugAdapterDescriptorFactory`. */
interface DebugAdapterFactoryLike {
  createDebugAdapterDescriptor?: unknown;
}

/** Keyed by this worker's own token: Main translates to its own before it asks. */
const debugConfigProviders = new Map<
  number,
  { debugType: string; trigger: 'initial' | 'dynamic'; provider: DebugConfigProviderLike }
>();
let debugConfigTokenSeq = 0;

/** Keyed by this worker's own token; Main addresses `debugCreateAdapter` by debug type instead. */
const debugAdapterFactories = new Map<
  number,
  { debugType: string; factory: DebugAdapterFactoryLike }
>();
let debugAdapterTokenSeq = 0;

/** Every session Main has announced, in announcement order. Sessions are shared across extensions. */
const debugSessions = new Map<string, DebugSessionImpl>();
let activeDebugSessionId: string | null = null;

/** Inline adapters this extension is serving, keyed by the session each one belongs to. */
const inlineDebugAdapters = new Map<
  string,
  { implementation: DebugAdapterLike; unsubscribe: (() => void) | null }
>();

const onDidStartDebugSessionEmitter = new EventEmitter<DebugSessionImpl>();
const onDidTerminateDebugSessionEmitter = new EventEmitter<DebugSessionImpl>();
const onDidChangeActiveDebugSessionEmitter = new EventEmitter<DebugSessionImpl | undefined>();
const onDidReceiveDebugSessionCustomEventEmitter = new EventEmitter<{
  session: DebugSessionImpl;
  event: string;
  body: unknown;
}>();
const debugConsole = new DebugConsoleImpl();

/**
 * The one object for a session id, created the first time the session is mentioned.
 *
 * A session reaches the worker by one of two doors: `debugCreateAdapter`, when this extension's factory is
 * asked how the adapter starts and nobody has been told the session began yet, or the announcement that it
 * did. Both come through here, so `createDebugAdapterDescriptor` and `onDidStartDebugSession` are handed
 * the same object and an extension can key a map on it.
 */
function trackDebugSession(info: {
  sessionId: string;
  type: string;
  name: string;
  configuration: Record<string, unknown>;
  parentId: string | null;
  workspaceFolder: string | null;
}): DebugSessionImpl {
  const existing = debugSessions.get(info.sessionId);
  if (existing !== undefined) {
    if (info.name.length > 0) existing.name = info.name;
    // The descriptor request names no folder and no parent; the announcement does, and it is the same
    // object by then, so the two are filled in once rather than replaced on every mention.
    if (existing.workspaceFolder === undefined && info.workspaceFolder !== null) {
      existing.workspaceFolder = debugFolder(info.workspaceFolder);
    }
    if (existing.parentSession === undefined && info.parentId !== null) {
      existing.parentSession = debugSessions.get(info.parentId);
    }
    return existing;
  }
  if (debugSessions.size >= MAX_TRACKED_DEBUG_SESSIONS) {
    // A launch that fails after the descriptor request is discarded by Main without a termination
    // broadcast, so the oldest entry is dropped rather than waited for.
    const oldest = debugSessions.keys().next().value;
    if (oldest !== undefined) debugSessions.delete(oldest);
  }
  const session = new DebugSessionImpl(
    info.sessionId,
    info.type,
    info.name,
    info.configuration,
    info.parentId === null ? undefined : debugSessions.get(info.parentId),
    debugFolder(info.workspaceFolder),
  );
  debugSessions.set(info.sessionId, session);
  return session;
}

/**
 * Keep an inline adapter and start forwarding what it sends.
 *
 * Subscribing before the descriptor reply goes out is the point: Main opens the transport and sends
 * `initialize` as soon as it has the reply, and an adapter whose `onDidSendMessage` had no listener yet
 * would answer into nothing. Returning false means the descriptor cannot be honoured, and Main is told the
 * descriptor is unusable rather than being left with a session no adapter is behind.
 */
function retainInlineAdapter(sessionId: string, implementation: DebugAdapterLike): boolean {
  if (sessionId.length === 0) return false;
  dropInlineAdapter(sessionId);
  if (inlineDebugAdapters.size >= MAX_INLINE_ADAPTERS) {
    log('warn', `An extension may serve at most ${MAX_INLINE_ADAPTERS} inline debug adapters.`);
    return false;
  }
  const entry: { implementation: DebugAdapterLike; unsubscribe: (() => void) | null } = {
    implementation,
    unsubscribe: null,
  };
  inlineDebugAdapters.set(sessionId, entry);
  entry.unsubscribe = subscribeForeignEvent<unknown>(implementation.onDidSendMessage, (message) => {
    if (!inlineDebugAdapters.has(sessionId)) return;
    void request('debug.adapterMessage', { sessionId, message: debugClone(message) }).catch(
      (error: unknown) => {
        log('warn', `An inline debug adapter message was refused: ${errorMessage(error)}`);
      },
    );
  });
  return true;
}

/** Release an inline adapter: Main asked for it, or the session it served has ended. */
function dropInlineAdapter(sessionId: string): void {
  const entry = inlineDebugAdapters.get(sessionId);
  if (entry === undefined) return;
  inlineDebugAdapters.delete(sessionId);
  entry.unsubscribe?.();
  const dispose = entry.implementation.dispose;
  if (typeof dispose === 'function') {
    guardExtensionCall('DebugAdapter.dispose', () => dispose.call(entry.implementation));
  }
}

/**
 * The descriptor a factory returned, as the record Main's normaliser reads.
 *
 * Read by shape rather than by `instanceof`: an extension bundled against its own copy of the API returns
 * its own classes, and upstream reads the fields too. Anything unrecognised — including the `undefined` an
 * extension returns to mean "use the adapter contributed in package.json", which AXIOM has none of —
 * becomes null, and Main reports an unusable descriptor rather than guessing at what to start.
 */
function wireDebugDescriptor(value: unknown, sessionId: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const implementation = raw.implementation;
  if (typeof implementation === 'object' && implementation !== null) {
    return retainInlineAdapter(sessionId, implementation as DebugAdapterLike)
      ? { kind: 'inline' }
      : null;
  }
  if (typeof raw.command === 'string' && raw.command.length > 0) {
    const options =
      typeof raw.options === 'object' && raw.options !== null
        ? (raw.options as Record<string, unknown>)
        : {};
    return {
      kind: 'executable',
      command: raw.command,
      args: Array.isArray(raw.args)
        ? raw.args.filter((entry): entry is string => typeof entry === 'string')
        : [],
      options: {
        ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
        env: debugClone(options.env),
      },
    };
  }
  if (typeof raw.port === 'number' && Number.isFinite(raw.port)) {
    return {
      kind: 'server',
      port: Math.trunc(raw.port),
      ...(typeof raw.host === 'string' ? { host: raw.host } : {}),
    };
  }
  const pipe = typeof raw.path === 'string' ? raw.path : '';
  const named = pipe.length > 0 ? pipe : typeof raw.pipeName === 'string' ? raw.pipeName : '';
  return named.length > 0 ? { kind: 'namedPipe', path: named } : null;
}

/**
 * `debug.registerDebugConfigurationProvider`.
 *
 * The token is this worker's own, minted here so the `Disposable` can be returned synchronously; Main
 * keeps its own and translates. A registration Main refuses is rolled back out of the map, or a later
 * `debugResolveConfiguration` would find a provider Main does not believe exists.
 */
function registerDebugConfigurationProvider(
  debugType: unknown,
  provider: unknown,
  triggerKind?: unknown,
): Disposable {
  const kind = wireText(debugType, 200);
  if (kind === null) throw new Error('registerDebugConfigurationProvider needs a debug type.');
  if (typeof provider !== 'object' || provider === null) {
    throw new Error('registerDebugConfigurationProvider needs a provider object.');
  }
  if (debugConfigProviders.size >= MAX_DEBUG_CONFIG_PROVIDERS) {
    throw new Error(
      `An extension may register at most ${MAX_DEBUG_CONFIG_PROVIDERS} debug configuration providers.`,
    );
  }
  const trigger = triggerKind === 2 || triggerKind === 'dynamic' ? 'dynamic' : 'initial';
  debugConfigTokenSeq += 1;
  const token = debugConfigTokenSeq;
  debugConfigProviders.set(token, {
    debugType: kind,
    trigger,
    provider: provider as DebugConfigProviderLike,
  });
  void request('debug.registerConfigurationProvider', { debugType: kind, token, trigger }).catch(
    (error: unknown) => {
      debugConfigProviders.delete(token);
      log('warn', `A debug configuration provider could not be registered: ${errorMessage(error)}`);
    },
  );
  return new Disposable(() => {
    if (!debugConfigProviders.delete(token)) return;
    void request('debug.unregisterConfigurationProvider', { token }).catch(() => undefined);
  });
}

/**
 * `debug.registerDebugAdapterDescriptorFactory`.
 *
 * Main refuses a second factory for a type that already has one, so the rollback here is what keeps the
 * two sides agreeing about who answers for a type: the local entry goes only if Main accepted it.
 */
function registerDebugAdapterDescriptorFactory(debugType: unknown, factory: unknown): Disposable {
  const kind = wireText(debugType, 200);
  if (kind === null) {
    throw new Error('registerDebugAdapterDescriptorFactory needs a debug type.');
  }
  if (typeof factory !== 'object' || factory === null) {
    throw new Error('registerDebugAdapterDescriptorFactory needs a factory object.');
  }
  if (typeof (factory as DebugAdapterFactoryLike).createDebugAdapterDescriptor !== 'function') {
    throw new Error('That debug adapter factory has no createDebugAdapterDescriptor method.');
  }
  if (debugAdapterFactories.size >= MAX_DEBUG_ADAPTER_FACTORIES) {
    throw new Error(
      `An extension may register at most ${MAX_DEBUG_ADAPTER_FACTORIES} debug adapter factories.`,
    );
  }
  debugAdapterTokenSeq += 1;
  const token = debugAdapterTokenSeq;
  debugAdapterFactories.set(token, {
    debugType: kind,
    factory: factory as DebugAdapterFactoryLike,
  });
  void request('debug.registerAdapterFactory', { debugType: kind, token }).catch(
    (error: unknown) => {
      debugAdapterFactories.delete(token);
      log('warn', `A debug adapter factory could not be registered: ${errorMessage(error)}`);
    },
  );
  return new Disposable(() => {
    if (!debugAdapterFactories.delete(token)) return;
    void request('debug.unregisterAdapterFactory', { token }).catch(() => undefined);
  });
}

/** The path behind a `WorkspaceFolder`, a `Uri`, or a plain string, whoever's copy of the API built it. */
function debugFolderPath(value: unknown): string | null {
  if (typeof value === 'string') return wireText(value, 4_096);
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { fsPath?: unknown; uri?: { fsPath?: unknown } };
  if (typeof candidate.fsPath === 'string') return wireText(candidate.fsPath, 4_096);
  const nested = candidate.uri?.fsPath;
  return typeof nested === 'string' ? wireText(nested, 4_096) : null;
}

/** A `DebugSession` or a `DebugSessionOptions`: either names the session this one is a child of. */
function debugParentSessionId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { id?: unknown; parentSession?: { id?: unknown } };
  if (typeof candidate.id === 'string') return wireText(candidate.id, 200);
  const nested = candidate.parentSession?.id;
  return typeof nested === 'string' ? wireText(nested, 200) : null;
}

/** A session id from whatever the caller passed. The empty string is how Main is asked for the active one. */
function debugSessionId(value: unknown): string {
  if (value instanceof DebugSessionImpl) return value.id;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return wireText(id, 200) ?? '';
  }
  return '';
}

/**
 * `debug.startDebugging`.
 *
 * The configuration goes to Main, which authorises the folder, checks the workspace is trusted, runs every
 * registered provider over it and only then starts an adapter. The named form — a string naming an entry in
 * the user's `launch.json` — is refused rather than approximated: AXIOM's Main has no `launch.json` reader,
 * and a configuration assembled here would start a program under a name the user never described.
 */
async function startDebugging(
  folder: unknown,
  nameOrConfiguration: unknown,
  parentSessionOrOptions?: unknown,
): Promise<boolean> {
  if (typeof nameOrConfiguration === 'string') {
    throw new Error(
      'startDebugging with a named launch configuration is not supported by this build. Pass a DebugConfiguration object.',
    );
  }
  if (typeof nameOrConfiguration !== 'object' || nameOrConfiguration === null) {
    throw new Error('startDebugging needs a debug configuration.');
  }
  const folderPath = debugFolderPath(folder);
  const parentId = debugParentSessionId(parentSessionOrOptions);
  const started = await request<unknown>('debug.start', {
    configuration: debugClone(nameOrConfiguration),
    ...(folderPath === null ? {} : { folder: folderPath }),
    ...(parentId === null ? {} : { parentSessionId: parentId }),
  });
  return started === true;
}

/** `debug.stopDebugging`. No argument means the active session, as upstream's optional one does. */
async function stopDebugging(session?: unknown): Promise<void> {
  await request('debug.stop', { sessionId: debugSessionId(session) });
}

const debugNamespace = strictNamespace('debug', {
  get activeDebugSession(): DebugSessionImpl | undefined {
    return activeDebugSessionId === null ? undefined : debugSessions.get(activeDebugSessionId);
  },
  get activeDebugConsole(): DebugConsoleImpl {
    return debugConsole;
  },
  /**
   * AXIOM has no breakpoint UI, so there is nothing here for an extension to enumerate and nothing that
   * can change. An empty list is the truthful answer and reading it during activation is common enough
   * that throwing would be worse; `addBreakpoints` is deliberately absent instead, so an extension that
   * tries to *set* one is told the API is missing rather than having the call silently do nothing.
   */
  get breakpoints(): readonly unknown[] {
    return [];
  },
  onDidChangeBreakpoints: new EventEmitter<unknown>().event,
  registerDebugConfigurationProvider,
  registerDebugAdapterDescriptorFactory,
  startDebugging,
  stopDebugging,
  onDidStartDebugSession: onDidStartDebugSessionEmitter.event,
  onDidTerminateDebugSession: onDidTerminateDebugSessionEmitter.event,
  onDidChangeActiveDebugSession: onDidChangeActiveDebugSessionEmitter.event,
  onDidReceiveDebugSessionCustomEvent: onDidReceiveDebugSessionCustomEventEmitter.event,
});

/**
 * One `DebugConfigurationProvider` round trip.
 *
 * The reply shapes are Main's: an object without a `configuration` leaves it as it was, `cancelled` stops
 * the launch, and a bare null *also* stops it — which is why a provider that does not implement the hook
 * answers `{}` rather than nothing. Reading it the other way would veto launches on behalf of an extension
 * that never objected.
 */
async function dispatchDebugConfiguration(message: {
  id: number;
  providerToken: number;
  op: 'provide' | 'resolve' | 'resolveWithSubstituted';
  folder: string | null;
  configuration: unknown;
}): Promise<void> {
  const entry = debugConfigProviders.get(message.providerToken);
  if (entry === undefined) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: 'That debug configuration provider is no longer registered.',
    });
    return;
  }
  const hook =
    message.op === 'provide'
      ? entry.provider.provideDebugConfigurations
      : message.op === 'resolve'
        ? entry.provider.resolveDebugConfiguration
        : entry.provider.resolveDebugConfigurationWithSubstitutedVariables;
  if (typeof hook !== 'function') {
    send({ t: 'result', id: message.id, ok: true, value: {} });
    return;
  }
  const folder = debugFolder(message.folder);
  const source = new CancellationTokenSource();
  try {
    const args: unknown[] =
      message.op === 'provide'
        ? [folder, source.token]
        : [folder, message.configuration, source.token];
    const result: unknown = await Promise.resolve(
      (hook as (...values: unknown[]) => unknown).apply(entry.provider, args),
    );
    send({
      t: 'result',
      id: message.id,
      ok: true,
      value: debugConfigurationReply(message.op, result),
    });
  } catch (error) {
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  } finally {
    source.dispose();
  }
}

/**
 * Turn what a provider returned into the reply Main understands.
 *
 * Upstream distinguishes `null` (stop and open the launch configuration for editing) from `undefined`
 * (stop silently). AXIOM has no launch-configuration editor, so both are one veto.
 */
function debugConfigurationReply(
  op: 'provide' | 'resolve' | 'resolveWithSubstituted',
  result: unknown,
): unknown {
  if (op === 'provide') {
    const list = Array.isArray(result) ? result.slice(0, MAX_PROVIDED_DEBUG_CONFIGURATIONS) : [];
    return { configurations: debugClone(list) };
  }
  if (result === null || result === undefined) return { cancelled: true };
  if (typeof result !== 'object') return {};
  return { configuration: debugClone(result) };
}

/**
 * One `DebugAdapterDescriptorFactory` round trip.
 *
 * This arrives before the session has been announced, so the session object is created here and adopted
 * by the announcement: the factory and `onDidStartDebugSession` see the same `DebugSession`, which is what
 * an extension that stores per-session state off the object depends on.
 */
async function dispatchDebugAdapter(message: {
  id: number;
  debugType: string;
  sessionId: string;
  configuration: Record<string, unknown>;
}): Promise<void> {
  let found: { debugType: string; factory: DebugAdapterFactoryLike } | undefined;
  for (const entry of debugAdapterFactories.values()) {
    if (entry.debugType === message.debugType) {
      found = entry;
      break;
    }
  }
  const create = found?.factory.createDebugAdapterDescriptor;
  if (found === undefined || typeof create !== 'function') {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: `This extension provides no debug adapter for '${message.debugType}'.`,
    });
    return;
  }
  const name = message.configuration['name'];
  const session = trackDebugSession({
    sessionId: message.sessionId,
    type: message.debugType,
    name: typeof name === 'string' ? name : message.debugType,
    configuration: message.configuration,
    parentId: null,
    workspaceFolder: null,
  });
  try {
    // The second argument is the adapter declared in `package.json`. AXIOM resolves adapters through the
    // factory alone, so a factory that expects a declared executable to adjust gets `undefined` — the same
    // value upstream passes when the contribution declares no `program`.
    const descriptor: unknown = await Promise.resolve(
      (create as (session: unknown, executable: unknown) => unknown).call(
        found.factory,
        session,
        undefined,
      ),
    );
    send({
      t: 'result',
      id: message.id,
      ok: true,
      value: wireDebugDescriptor(descriptor, message.sessionId),
    });
  } catch (error) {
    dropInlineAdapter(message.sessionId);
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  }
}

/** A DAP message Main framed for this extension's inline adapter: `DebugAdapter.handleMessage`. */
function deliverInlineAdapterMessage(sessionId: string, message: unknown): void {
  const entry = inlineDebugAdapters.get(sessionId);
  if (entry === undefined) return;
  const handle = entry.implementation.handleMessage;
  if (typeof handle !== 'function') return;
  guardExtensionCall('DebugAdapter.handleMessage', () =>
    handle.call(entry.implementation, message),
  );
}

/** `onDidStartDebugSession`, for every extension — not only the one that owns the adapter. */
function applyDebugSessionStarted(message: {
  sessionId: string;
  type: string;
  name: string;
  configuration: Record<string, unknown>;
  parentId: string | null;
  workspaceFolder: string | null;
}): void {
  if (message.sessionId.length === 0) return;
  const session = trackDebugSession(message);
  onDidStartDebugSessionEmitter.fire(session);
}

/**
 * `onDidTerminateDebugSession`.
 *
 * `activeDebugSessionId` is deliberately left alone: Main sends the new active session straight after, and
 * clearing it here would swallow the `onDidChangeActiveDebugSession(undefined)` that ends a debug run. The
 * getter reads through the map, so a stale id resolves to `undefined` in the gap either way.
 */
function applyDebugSessionTerminated(sessionId: string): void {
  const session = debugSessions.get(sessionId);
  debugSessions.delete(sessionId);
  dropInlineAdapter(sessionId);
  if (session !== undefined) onDidTerminateDebugSessionEmitter.fire(session);
}

/** `onDidChangeActiveDebugSession`. Fires on a real change only, including the change to none. */
function applyDebugActiveSession(sessionId: string | null): void {
  const next = sessionId !== null && sessionId.length > 0 ? sessionId : null;
  if (activeDebugSessionId === next) return;
  activeDebugSessionId = next;
  onDidChangeActiveDebugSessionEmitter.fire(next === null ? undefined : debugSessions.get(next));
}

/** `onDidReceiveDebugSessionCustomEvent`. Dropped when the session was never announced to this worker. */
function applyDebugCustomEvent(message: { sessionId: string; event: string; body: unknown }): void {
  const session = debugSessions.get(message.sessionId);
  if (session === undefined || message.event.length === 0) return;
  onDidReceiveDebugSessionCustomEventEmitter.fire({
    session,
    event: message.event,
    body: message.body,
  });
}

const windowNamespace = strictNamespace('window', {
  get activeTextEditor(): unknown {
    return activeEditorSnapshot === null ? undefined : buildEditor(activeEditorSnapshot);
  },
  get visibleTextEditors(): unknown[] {
    return activeEditorSnapshot === null ? [] : [buildEditor(activeEditorSnapshot)];
  },
  get activeTerminal(): TerminalImpl | undefined {
    return activeTerminal;
  },
  get terminals(): readonly TerminalImpl[] {
    return [...terminalList];
  },
  state: { focused: true },
  onDidChangeActiveTextEditor: activeEditorEmitter.event,
  onDidChangeVisibleTextEditors: new EventEmitter<unknown>().event,
  onDidChangeTextEditorSelection: new EventEmitter<unknown>().event,
  onDidChangeWindowState: new EventEmitter<unknown>().event,
  onDidOpenTerminal: onDidOpenTerminalEmitter.event,
  onDidCloseTerminal: onDidCloseTerminalEmitter.event,
  onDidChangeActiveTerminal: onDidChangeActiveTerminalEmitter.event,
  onDidChangeTerminalState: onDidChangeTerminalStateEmitter.event,
  createTerminal,
  registerTerminalProfileProvider,
  showInformationMessage: (message: string, ...items: unknown[]): Promise<string | undefined> =>
    showMessage('info', message, items),
  showWarningMessage: (message: string, ...items: unknown[]): Promise<string | undefined> =>
    showMessage('warning', message, items),
  showErrorMessage: (message: string, ...items: unknown[]): Promise<string | undefined> =>
    showMessage('error', message, items),
  setStatusBarMessage: (text: string): Disposable => {
    const id = `message-${++statusItemCount}`;
    void request('window.setStatusBarItem', {
      id,
      text,
      tooltip: '',
      command: '',
      alignment: 'left',
      priority: 0,
    }).catch(() => undefined);
    return new Disposable(() => {
      void request('window.removeStatusBarItem', { id }).catch(() => undefined);
    });
  },
  createStatusBarItem,
  createOutputChannel,
  showQuickPick: async (
    itemsOrPromise: unknown,
    options?: { placeHolder?: string },
  ): Promise<unknown> => {
    const resolved = await Promise.resolve(itemsOrPromise);
    const list = Array.isArray(resolved) ? resolved : [];
    const labels = list.map((entry) =>
      typeof entry === 'string' ? entry : String((entry as { label?: unknown })?.label ?? ''),
    );
    const picked = await request<string | null>('window.showQuickPick', {
      items: labels,
      placeHolder: options?.placeHolder ?? '',
    });
    if (picked === null) return undefined;
    const index = labels.indexOf(picked);
    return index >= 0 ? list[index] : undefined;
  },
  showInputBox: async (options?: {
    prompt?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
  }): Promise<string | undefined> => {
    const entered = await request<string | null>('window.showInputBox', {
      prompt: options?.prompt ?? '',
      value: options?.value ?? '',
      placeHolder: options?.placeHolder ?? '',
      password: options?.password === true,
    });
    return entered === null ? undefined : entered;
  },
  showTextDocument: async (documentOrUri: unknown): Promise<unknown> => {
    const uri =
      documentOrUri instanceof Uri ? documentOrUri : (documentOrUri as { uri?: Uri })?.uri;
    if (!(uri instanceof Uri)) throw new Error('showTextDocument needs a document or a file URI.');
    await request('window.showTextDocument', { path: uri.fsPath });
    return windowNamespace.activeTextEditor;
  },
  withProgress: async <T>(
    options: { title?: string },
    task: (
      progress: { report: (value: { message?: string; increment?: number }) => void },
      token: { isCancellationRequested: boolean },
    ) => Promise<T>,
  ): Promise<T> => {
    // Real behaviour rather than a discarded progress object: the title and each report land
    // in the status bar, which is where AXIOM shows background work.
    const id = `progress-${++statusItemCount}`;
    const title = options?.title ?? 'Working…';
    const paint = (text: string): void => {
      void request('window.setStatusBarItem', {
        id,
        text,
        tooltip: '',
        command: '',
        alignment: 'left',
        priority: 0,
      }).catch(() => undefined);
    };
    paint(title);
    const source = new CancellationTokenSource();
    try {
      return await task(
        { report: (value) => paint(value.message ? `${title}: ${value.message}` : title) },
        source.token,
      );
    } finally {
      source.dispose();
      void request('window.removeStatusBarItem', { id }).catch(() => undefined);
    }
  },
  registerUriHandler: (handler: { handleUri: (uri: Uri) => unknown }): Disposable => {
    // Recorded in Main as well as here: a deep link or an OAuth redirect is routed by extension
    // id, and Main needs to know whether anyone is listening before it activates a host for one.
    uriHandler = handler;
    void request('window.registerUriHandler').catch(() => undefined);
    return new Disposable(() => {
      if (uriHandler === handler) uriHandler = null;
    });
  },
  createWebviewPanel,
  registerWebviewViewProvider,
  registerWebviewPanelSerializer,
  registerTreeDataProvider,
  createTreeView,
});

/** The extension's `UriHandler`, if it registered one. At most one, as upstream allows. */
let uriHandler: { handleUri: (uri: Uri) => unknown } | null = null;

async function showMessage(
  severity: 'info' | 'warning' | 'error',
  message: string,
  items: unknown[],
): Promise<string | undefined> {
  const labels = items.filter((item): item is string => typeof item === 'string').slice(0, 6);
  const chosen = await request<string | null>('window.showMessage', {
    message: String(message ?? ''),
    severity,
    items: labels,
  });
  return chosen === null ? undefined : chosen;
}

/** A text editor over a file, built on demand from the active-editor snapshot. */
function buildEditor(snapshot: { path: string; languageId: string }) {
  const uri = Uri.file(snapshot.path);
  return {
    document: buildDocument(uri, snapshot.languageId),
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    selections: [new Selection(new Position(0, 0), new Position(0, 0))],
    viewColumn: ViewColumn.One,
    options: {},
    // Editing through the extension host is not brokered in this build. Refusing loudly
    // beats accepting an edit that never appears in the user's buffer.
    edit: (): never => notImplemented('TextEditor.edit'),
    insertSnippet: (): never => notImplemented('TextEditor.insertSnippet'),
    setDecorations: (): void => undefined,
    revealRange: (): void => undefined,
  };
}

function buildDocument(uri: Uri, languageId: string) {
  let cached: string | null = null;
  const read = async (): Promise<string> => {
    if (cached !== null) return cached;
    const encoded = await request<string>('workspace.readFile', { path: uri.fsPath });
    cached = Buffer.from(encoded, 'base64').toString('utf8');
    return cached;
  };
  return {
    uri,
    fileName: uri.fsPath,
    languageId,
    version: 1,
    isDirty: false,
    isClosed: false,
    isUntitled: false,
    eol: EndOfLine.LF,
    encoding: 'utf8',
    save: async (): Promise<boolean> => false,
    /**
     * Synchronous in VS Code, and synchronous here only after the file has been read once.
     * The first call has nothing to return, so it returns empty rather than blocking the
     * process on a round trip — and `loadText()` is offered for the honest asynchronous path.
     */
    getText: (): string => cached ?? '',
    loadText: read,
    get lineCount(): number {
      return cached === null ? 0 : cached.split('\n').length;
    },
    lineAt: (lineOrPosition: number | Position) => {
      const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
      const text = (cached ?? '').split('\n')[line] ?? '';
      return {
        lineNumber: line,
        text,
        range: new Range(line, 0, line, text.length),
        rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
        firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
        isEmptyOrWhitespace: text.trim().length === 0,
      };
    },
    offsetAt: (position: Position): number => {
      const lines = (cached ?? '').split('\n').slice(0, position.line);
      return lines.reduce((total, line) => total + line.length + 1, 0) + position.character;
    },
    positionAt: (offset: number): Position => {
      const text = (cached ?? '').slice(0, Math.max(0, offset));
      const lines = text.split('\n');
      return new Position(lines.length - 1, (lines[lines.length - 1] ?? '').length);
    },
    getWordRangeAtPosition: (): undefined => undefined,
    validateRange: (range: Range): Range => range,
    validatePosition: (position: Position): Position => position,
  };
}

/**
 * Every live collection this extension owns.
 *
 * `languages.getDiagnostics()` reads the union of them, and `onDidChangeDiagnostics` fires when any
 * one flushes. Both are answered locally rather than round-tripping to Main: the collections are
 * owned by this process, so Main's copy can only ever be a slightly older version of what is here.
 */
interface WorkerDiagnosticCollection {
  name: string;
  get(uri: Uri): readonly Diagnostic[] | undefined;
  forEach(
    callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: unknown) => void,
  ): void;
}

const diagnosticCollections = new Set<WorkerDiagnosticCollection>();
const diagnosticsEmitter = new EventEmitter<{ uris: Uri[] }>();

function createDiagnosticCollection(name: string) {
  const entries = new Map<string, Diagnostic[]>();
  const flush = (): void => {
    const payload: unknown[] = [];
    for (const [path, diagnostics] of entries) {
      for (const diagnostic of diagnostics) {
        payload.push(toHostDiagnosticPayload(path, diagnostic, name));
      }
    }
    void request('languages.setDiagnostics', { owner: name, entries: payload }).catch(
      (error: unknown) => log('warn', `diagnostics update failed: ${errorMessage(error)}`),
    );
    diagnosticsEmitter.fire({
      uris: Array.from(entries.keys(), (path) => Uri.file(path)),
    });
  };
  const collection = {
    name,
    set: (
      uriOrEntries: Uri | Array<[Uri, Diagnostic[] | undefined]>,
      diagnostics?: Diagnostic[],
    ): void => {
      if (Array.isArray(uriOrEntries)) {
        for (const [uri, list] of uriOrEntries) {
          if (list === undefined || list.length === 0) entries.delete(uri.fsPath);
          else entries.set(uri.fsPath, list.slice());
        }
      } else if (diagnostics === undefined || diagnostics.length === 0) {
        entries.delete(uriOrEntries.fsPath);
      } else {
        entries.set(uriOrEntries.fsPath, diagnostics.slice());
      }
      flush();
    },
    delete: (uri: Uri): void => {
      entries.delete(uri.fsPath);
      flush();
    },
    clear: (): void => {
      entries.clear();
      flush();
    },
    forEach: (
      callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: unknown) => void,
    ): void => {
      for (const [path, diagnostics] of entries) callback(Uri.file(path), diagnostics, collection);
    },
    get: (uri: Uri): readonly Diagnostic[] | undefined => entries.get(uri.fsPath),
    has: (uri: Uri): boolean => entries.has(uri.fsPath),
    dispose: (): void => {
      entries.clear();
      diagnosticCollections.delete(collection);
      flush();
    },
  };
  diagnosticCollections.add(collection);
  return collection;
}

/**
 * One `Diagnostic` in the shape `normalizeHostDiagnostics` reads.
 *
 * `code` is three things in the published API — a string, a number, or `{value, target}` — and the
 * third form is the one that carries the documentation link. Flattening it here rather than in Main
 * keeps the URI stringification next to the object that knows what it is.
 */
function toHostDiagnosticPayload(
  path: string,
  diagnostic: Diagnostic,
  owner: string,
): Record<string, unknown> {
  const code = diagnostic.code as unknown;
  const codeValue =
    code !== null && typeof code === 'object'
      ? (code as { value?: unknown }).value
      : (code as unknown);
  const codeTarget =
    code !== null && typeof code === 'object' ? (code as { target?: unknown }).target : undefined;
  const related = Array.isArray((diagnostic as { relatedInformation?: unknown }).relatedInformation)
    ? ((diagnostic as { relatedInformation: unknown[] }).relatedInformation as Array<{
        location?: { uri?: Uri; range?: Range };
        message?: unknown;
      }>)
    : [];
  const tags = Array.isArray((diagnostic as { tags?: unknown }).tags)
    ? ((diagnostic as { tags: unknown[] }).tags
        .map((tag) =>
          tag === DiagnosticTag.Unnecessary
            ? 'unnecessary'
            : tag === DiagnosticTag.Deprecated
              ? 'deprecated'
              : null,
        )
        .filter((tag): tag is 'unnecessary' | 'deprecated' => tag !== null) as Array<
        'unnecessary' | 'deprecated'
      >)
    : [];
  return {
    path,
    startLine: diagnostic.range.start.line,
    startColumn: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line,
    endColumn: diagnostic.range.end.character,
    message: diagnostic.message,
    severity:
      diagnostic.severity === DiagnosticSeverity.Warning
        ? 'warning'
        : diagnostic.severity === DiagnosticSeverity.Information
          ? 'info'
          : diagnostic.severity === DiagnosticSeverity.Hint
            ? 'hint'
            : 'error',
    source: diagnostic.source ?? owner,
    code: codeValue === undefined || codeValue === null ? '' : String(codeValue),
    ...(codeTarget instanceof Uri ? { codeHref: codeTarget.toString() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(related.length > 0
      ? {
          relatedInformation: related
            .filter((item) => item?.location?.uri instanceof Uri && item.location.range)
            .slice(0, 32)
            .map((item) => ({
              path: (item.location as { uri: Uri }).uri.fsPath,
              startLine: (item.location as { range: Range }).range.start.line,
              startColumn: (item.location as { range: Range }).range.start.character,
              endLine: (item.location as { range: Range }).range.end.line,
              endColumn: (item.location as { range: Range }).range.end.character,
              message: String(item.message ?? ''),
            })),
        }
      : {}),
  };
}

const fileSystem = strictNamespace('workspace.fs', {
  readFile: async (uri: Uri): Promise<Uint8Array> => {
    const encoded = await request<string>('workspace.readFile', { path: uri.fsPath });
    return new Uint8Array(Buffer.from(encoded, 'base64'));
  },
  writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
    await request('workspace.writeFile', {
      path: uri.fsPath,
      content: Buffer.from(content).toString('base64'),
    });
  },
  readDirectory: async (uri: Uri): Promise<Array<[string, number]>> =>
    request('workspace.readDirectory', { path: uri.fsPath }),
  stat: async (uri: Uri): Promise<{ type: number; size: number; ctime: number; mtime: number }> =>
    request('workspace.stat', { path: uri.fsPath }),
  createDirectory: async (uri: Uri): Promise<void> => {
    await request('workspace.createDirectory', { path: uri.fsPath });
  },
  delete: async (uri: Uri, options?: { recursive?: boolean }): Promise<void> => {
    await request('workspace.delete', {
      path: uri.fsPath,
      recursive: options?.recursive === true,
    });
  },
  /**
   * `copy` and `rename`, which Phase 6 left unimplemented (PRD Phase 7 §4).
   *
   * Both are one request each; Main authorises both paths against the open workspace before it touches
   * the disk. Neither fires the workspace file-operation events — upstream reserves those for user
   * gestures and `applyEdit` — so an extension sees its own move as a watcher event.
   */
  copy: async (source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> => {
    await request('workspace.copyFile', {
      source: source.fsPath,
      target: target.fsPath,
      overwrite: options?.overwrite === true,
    });
  },
  rename: async (source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> => {
    await request('workspace.renameFile', {
      source: source.fsPath,
      target: target.fsPath,
      overwrite: options?.overwrite === true,
    });
  },
  isWritableFileSystem: (): boolean => true,
});

// ---------------------------------------------------------------------------
// Language platform: text document synchronisation (PRD Phase 6)
// ---------------------------------------------------------------------------
/**
 * The extension host's view of what is open.
 *
 * `common/vscodeDocumentSync.ts` owns the text and the versioning; this owns the `TextDocument`
 * objects extensions hold on to. The two are separate because identity matters: an extension stores
 * the document it saw in `onDidOpenTextDocument` and later compares it with `event.document`, so the
 * object handed out for one URI must be the *same* object for as long as that URI stays open, while
 * its contents change underneath. Hence live getters over the store rather than snapshots.
 */
const documentStore = new DocumentStore();
const liveDocuments = new Map<string, LiveTextDocument>();
const openTextDocumentEmitter = new EventEmitter<LiveTextDocument>();
const closeTextDocumentEmitter = new EventEmitter<LiveTextDocument>();
const saveTextDocumentEmitter = new EventEmitter<LiveTextDocument>();
const willSaveTextDocumentEmitter = new EventEmitter<unknown>();
const changeTextDocumentEmitter = new EventEmitter<{
  document: LiveTextDocument;
  contentChanges: Array<{ range: Range; rangeOffset: number; rangeLength: number; text: string }>;
  reason?: number;
}>();

/** The default word pattern, copied from upstream so `getWordRangeAtPosition` agrees with it. */
const DEFAULT_WORD_PATTERN = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

type LiveTextDocument = ReturnType<typeof createLiveDocument>;

/**
 * A `TextDocument` over a URI the store holds.
 *
 * Every field is a getter, so the object stays valid across edits and reports the version the store
 * reached rather than the version it was created at. A document whose URI has been closed reports
 * `isClosed` and keeps answering with its final text — an extension that held it must see a closed
 * document, not a throwing one.
 */
function createLiveDocument(uri: Uri, key: string, final?: DocumentSnapshot) {
  const read = (): DocumentSnapshot =>
    documentStore.get(key) ??
    final ?? {
      uri: key,
      languageId: '',
      version: 1,
      text: '',
      lineCount: 1,
      isDirty: false,
      isClosed: true,
      eol: '\n',
    };
  const document = {
    uri,
    get fileName(): string {
      return uri.fsPath;
    },
    get languageId(): string {
      return read().languageId;
    },
    get version(): number {
      return read().version;
    },
    get isDirty(): boolean {
      return read().isDirty;
    },
    get isClosed(): boolean {
      return !documentStore.has(key);
    },
    get isUntitled(): boolean {
      return uri.scheme === 'untitled';
    },
    get eol(): number {
      return read().eol === '\r\n' ? EndOfLine.CRLF : EndOfLine.LF;
    },
    encoding: 'utf8',
    get lineCount(): number {
      return read().lineCount;
    },
    save: async (): Promise<boolean> => {
      const snapshot = read();
      if (uri.scheme !== 'file') return false;
      try {
        await request('workspace.writeFile', {
          path: uri.fsPath,
          content: Buffer.from(snapshot.text, 'utf8').toString('base64'),
        });
        applyDocumentSave(key);
        return true;
      } catch (error) {
        log('warn', `document save failed: ${errorMessage(error)}`);
        return false;
      }
    },
    getText: (range?: Range): string => {
      const snapshot = read();
      if (!range) return snapshot.text;
      const start = offsetOf(snapshot.text, range.start);
      const end = offsetOf(snapshot.text, range.end);
      return snapshot.text.slice(Math.min(start, end), Math.max(start, end));
    },
    /** Kept from the pre-Phase-6 document shape: extensions built against it call it. */
    loadText: async (): Promise<string> => read().text,
    lineAt: (lineOrPosition: number | Position) => {
      const snapshot = read();
      const requested =
        typeof lineOrPosition === 'number' ? lineOrPosition : (lineOrPosition?.line ?? 0);
      const line = Math.max(0, Math.min(Math.floor(requested), snapshot.lineCount - 1));
      const text = lineTextOf(snapshot.text, line);
      return {
        lineNumber: line,
        text,
        range: new Range(line, 0, line, text.length),
        rangeIncludingLineBreak:
          line + 1 < snapshot.lineCount
            ? new Range(line, 0, line + 1, 0)
            : new Range(line, 0, line, text.length),
        firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
        isEmptyOrWhitespace: text.trim().length === 0,
      };
    },
    offsetAt: (position: Position): number => offsetOf(read().text, position),
    positionAt: (offset: number): Position => {
      const found = positionOf(read().text, offset);
      return new Position(found.line, found.character);
    },
    getWordRangeAtPosition: (position: Position, pattern?: RegExp): Range | undefined => {
      const snapshot = read();
      const line = Math.max(0, Math.min(position?.line ?? 0, snapshot.lineCount - 1));
      const text = lineTextOf(snapshot.text, line);
      const character = Math.max(0, Math.min(position?.character ?? 0, text.length));
      // A sticky or global regex would carry `lastIndex` between calls, so a fresh one is built
      // per call — upstream does the same, for the same reason.
      const source = pattern instanceof RegExp ? pattern.source : DEFAULT_WORD_PATTERN.source;
      let regex: RegExp;
      try {
        regex = new RegExp(source, 'g');
      } catch {
        return undefined;
      }
      let match = regex.exec(text);
      let guard = 0;
      while (match !== null && guard < 10_000) {
        const start = match.index;
        const end = start + match[0].length;
        if (start <= character && character <= end) return new Range(line, start, line, end);
        if (start > character) return undefined;
        if (regex.lastIndex === start) regex.lastIndex = start + 1;
        match = regex.exec(text);
        guard += 1;
      }
      return undefined;
    },
    validateRange: (range: Range): Range =>
      new Range(document.validatePosition(range.start), document.validatePosition(range.end)),
    validatePosition: (position: Position): Position => {
      const snapshot = read();
      const line = Math.max(0, Math.min(position?.line ?? 0, snapshot.lineCount - 1));
      const text = lineTextOf(snapshot.text, line);
      return new Position(line, Math.max(0, Math.min(position?.character ?? 0, text.length)));
    },
  };
  return document;
}

function offsetOf(text: string, position: { line: number; character: number } | undefined): number {
  return offsetInText(text, { line: position?.line ?? 0, character: position?.character ?? 0 });
}

function positionOf(text: string, offset: number): { line: number; character: number } {
  return positionInText(text, typeof offset === 'number' ? offset : 0);
}

function lineTextOf(text: string, line: number): string {
  const start = offsetInText(text, { line, character: 0 });
  const nextStart = offsetInText(text, { line: line + 1, character: 0 });
  let end = line + 1 <= countLines(text) ? nextStart : text.length;
  if (end > start && text.charCodeAt(end - 1) === 10) end -= 1;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  return text.slice(start, Math.max(start, end));
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      lines += 1;
    } else if (code === 10) lines += 1;
  }
  return lines;
}

/**
 * The document object for a URI, created on first sight and kept afterwards.
 *
 * Keyed on the URI string Main sent, not on `Uri.toString()`: percent-escapes survive the round trip
 * only in the original string, and a key that re-encodes differently would create a second document
 * object for the same file — which is exactly the identity break extensions notice.
 *
 * Called both from the synchronisation handlers and from provider dispatch, so a provider invoked for
 * a document the host has not announced still gets a usable `TextDocument` rather than `undefined`.
 */
function documentFor(key: string, final?: DocumentSnapshot): LiveTextDocument {
  const existing = liveDocuments.get(key);
  if (existing) return existing;
  const created = createLiveDocument(Uri.parse(key), key, final);
  liveDocuments.set(key, created);
  return created;
}

function applyDocumentOpen(message: {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  isDirty: boolean;
}): void {
  const event = documentStore.open({
    uri: message.uri,
    languageId: message.languageId,
    version: message.version,
    text: message.text,
    isDirty: message.isDirty,
  });
  if (!event) return;
  const document = documentFor(message.uri);
  openTextDocumentEmitter.fire(document);
}

/**
 * Apply a change batch, and ask for a full resend when it cannot be applied.
 *
 * The refusal path is the important one: a change that does not follow the version we hold means our
 * text is not the user's text, and every provider answer computed from it would be wrong at a
 * position the user can see. So we drop nothing silently — Main is told to resend.
 */
function applyDocumentChange(message: {
  uri: string;
  version: number;
  changes: DocumentContentChange[];
  isDirty: boolean;
}): void {
  const before = documentStore.get(message.uri);
  const result = documentStore.change(message.uri, message.version, message.changes, {
    isDirty: message.isDirty,
  });
  if (!result.ok) {
    if (result.reason !== 'stale') {
      void request('languages.refreshProvider', { uri: message.uri, reason: result.reason }).catch(
        () => undefined,
      );
    }
    return;
  }
  const document = documentFor(message.uri);
  const baseline = before?.text ?? '';
  let running = baseline;
  const contentChanges = message.changes.map((change) => {
    const range = change.range ?? {
      start: { line: 0, character: 0 },
      end: positionOf(running, running.length),
    };
    const rangeOffset = offsetOf(running, range.start);
    const rangeLength = Math.max(0, offsetOf(running, range.end) - rangeOffset);
    running =
      running.slice(0, rangeOffset) + change.text + running.slice(rangeOffset + rangeLength);
    return {
      range: new Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
      ),
      rangeOffset,
      rangeLength,
      text: change.text,
    };
  });
  changeTextDocumentEmitter.fire({ document, contentChanges });
}

function applyDocumentReplace(message: { uri: string; version: number; text: string }): void {
  const before = documentStore.get(message.uri);
  const event = documentStore.replace(message.uri, message.version, message.text);
  if (!event) {
    // Nothing held for this URI yet: treat a replace as the open it effectively is.
    applyDocumentOpen({
      uri: message.uri,
      languageId: before?.languageId ?? '',
      version: message.version,
      text: message.text,
      isDirty: false,
    });
    return;
  }
  const document = documentFor(message.uri);
  const previous = before?.text ?? '';
  changeTextDocumentEmitter.fire({
    document,
    contentChanges: [
      {
        range: (() => {
          const end = positionOf(previous, previous.length);
          return new Range(0, 0, end.line, end.character);
        })(),
        rangeOffset: 0,
        rangeLength: previous.length,
        text: message.text,
      },
    ],
  });
}

function applyDocumentSave(uri: string): void {
  const document = liveDocuments.get(uri);
  if (document) willSaveTextDocumentEmitter.fire({ document, reason: 1 });
  const event = documentStore.save(uri);
  if (!event) return;
  saveTextDocumentEmitter.fire(documentFor(uri));
}

function applyDocumentClose(uri: string): void {
  const event = documentStore.close(uri);
  if (!event) return;
  // The live object is kept for one last event so an extension holding it sees a closed document,
  // then dropped — keeping it forever is how a host leaks one object per file the user ever opened.
  const document = documentFor(uri, event.snapshot);
  closeTextDocumentEmitter.fire(document);
  liveDocuments.delete(uri);
}

/**
 * A language change is a close followed by an open, as upstream models it.
 *
 * Provider selection is keyed on the language, so every provider registered for the old one has to
 * stop being consulted and every provider for the new one has to start; the pair of events is what
 * makes extensions re-run their own registration logic.
 */
function applyDocumentLanguage(uri: string, languageId: string): void {
  const event = documentStore.setLanguage(uri, languageId);
  if (!event) return;
  const document = documentFor(uri);
  closeTextDocumentEmitter.fire(document);
  openTextDocumentEmitter.fire(document);
}

let untitledCounter = 0;

/**
 * Find an open document by filesystem path.
 *
 * Main keys documents by the URI string the editor uses, which may differ from `Uri.file(path)`'s
 * rendering in its percent-escapes and drive-letter case. Comparing resolved paths finds the document
 * anyway, which is the difference between `openTextDocument` returning the live object and returning a
 * second one that never receives change events.
 */
function findOpenUriForPath(fsPath: string): string | null {
  const target = fsPath.replaceAll('\\', '/').toLowerCase();
  if (target.length === 0) return null;
  for (const uri of documentStore.uris()) {
    if (Uri.parse(uri).fsPath.replaceAll('\\', '/').toLowerCase() === target) return uri;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File system watching (PRD Phase 7 §4)
// ---------------------------------------------------------------------------
/**
 * `workspace.createFileSystemWatcher`, over the watcher Main runs.
 *
 * The OS watch, the glob matching, the debounce and the workspace boundary all live in Main
 * (`services/extensionFileEvents.ts`), so a watcher here is three emitters and a token. The token is
 * minted by this worker and is what Main sends back on `watcherEvent`, which is why one extension can
 * never be handed another's events: Main only ever translates to the handles it recorded for that
 * extension.
 *
 * Registration is fire-and-forget because upstream's `createFileSystemWatcher` is synchronous. A watcher
 * Main refuses is dropped from the registry and stays inert rather than throwing out of an activation.
 */
const MAX_FILE_SYSTEM_WATCHERS = 32;

class FileSystemWatcherImpl {
  private readonly createEmitter = new EventEmitter<Uri>();
  private readonly changeEmitter = new EventEmitter<Uri>();
  private readonly deleteEmitter = new EventEmitter<Uri>();
  private disposed = false;

  constructor(
    private readonly token: number,
    readonly ignoreCreateEvents: boolean,
    readonly ignoreChangeEvents: boolean,
    readonly ignoreDeleteEvents: boolean,
  ) {}

  get onDidCreate(): (listener: (uri: Uri) => unknown) => Disposable {
    return this.createEmitter.event;
  }

  get onDidChange(): (listener: (uri: Uri) => unknown) => Disposable {
    return this.changeEmitter.event;
  }

  get onDidDelete(): (listener: (uri: Uri) => unknown) => Disposable {
    return this.deleteEmitter.event;
  }

  /** Main matched an event to this watcher. The flags are re-checked here as well as there. */
  _fire(kind: 'create' | 'change' | 'delete', path: string): void {
    if (this.disposed || path.length === 0) return;
    if (kind === 'create') {
      if (!this.ignoreCreateEvents) this.createEmitter.fire(Uri.file(path));
      return;
    }
    if (kind === 'change') {
      if (!this.ignoreChangeEvents) this.changeEmitter.fire(Uri.file(path));
      return;
    }
    if (!this.ignoreDeleteEvents) this.deleteEmitter.fire(Uri.file(path));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    fileSystemWatchers.delete(this.token);
    this.createEmitter.dispose();
    this.changeEmitter.dispose();
    this.deleteEmitter.dispose();
    if (this.token > 0) {
      void request('workspace.disposeWatcher', { token: this.token }).catch(() => undefined);
    }
  }
}

const fileSystemWatchers = new Map<number, FileSystemWatcherImpl>();
let fileSystemWatcherSeq = 0;

/**
 * Read a `GlobPattern` into what Main's normaliser takes.
 *
 * `RelativePattern` carries a `Uri` base, and a `Uri`'s `fsPath` is a prototype getter that does not
 * survive the structured clone onto the port — so the base is resolved to a plain string here rather
 * than being sent as an object Main would read as baseless.
 */
function watcherPattern(value: unknown): { pattern: string; base: string | null } | null {
  if (typeof value === 'string') {
    return value.length > 0 ? { pattern: value, base: null } : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const source = value as { pattern?: unknown; baseUri?: unknown; base?: unknown };
  if (typeof source.pattern !== 'string' || source.pattern.length === 0) return null;
  const baseUri = source.baseUri;
  const base =
    baseUri instanceof Uri
      ? baseUri.fsPath
      : typeof source.base === 'string' && source.base.length > 0
        ? source.base
        : null;
  return { pattern: source.pattern, base };
}

/**
 * `workspace.createFileSystemWatcher`.
 *
 * A watcher with an unusable pattern, or one over the per-extension ceiling, is returned inert: upstream
 * hands back a watcher object in every case, and an extension that subscribes to one during activation
 * must not have its activation fail because of it.
 */
function createFileSystemWatcher(
  pattern: unknown,
  ignoreCreateEvents?: unknown,
  ignoreChangeEvents?: unknown,
  ignoreDeleteEvents?: unknown,
): FileSystemWatcherImpl {
  const ignoreCreate = ignoreCreateEvents === true;
  const ignoreChange = ignoreChangeEvents === true;
  const ignoreDelete = ignoreDeleteEvents === true;
  const glob = watcherPattern(pattern);
  if (glob === null) {
    log('warn', 'createFileSystemWatcher was given no usable glob pattern.');
    return new FileSystemWatcherImpl(0, ignoreCreate, ignoreChange, ignoreDelete);
  }
  if (fileSystemWatchers.size >= MAX_FILE_SYSTEM_WATCHERS) {
    log('warn', `An extension may hold at most ${MAX_FILE_SYSTEM_WATCHERS} file system watchers.`);
    return new FileSystemWatcherImpl(0, ignoreCreate, ignoreChange, ignoreDelete);
  }
  fileSystemWatcherSeq += 1;
  const token = fileSystemWatcherSeq;
  const watcher = new FileSystemWatcherImpl(token, ignoreCreate, ignoreChange, ignoreDelete);
  fileSystemWatchers.set(token, watcher);
  void request('workspace.createWatcher', {
    token,
    pattern: { pattern: glob.pattern, ...(glob.base === null ? {} : { base: glob.base }) },
    ignoreCreateEvents: ignoreCreate,
    ignoreChangeEvents: ignoreChange,
    ignoreDeleteEvents: ignoreDelete,
  }).catch((error: unknown) => {
    fileSystemWatchers.delete(token);
    log('warn', `A file system watcher was refused: ${errorMessage(error)}`);
  });
  return watcher;
}

/** One debounced watcher event Main matched to this extension's watcher. */
function applyWatcherEvent(
  token: number,
  kind: 'create' | 'change' | 'delete',
  path: string,
): void {
  fileSystemWatchers.get(token)?._fire(kind, path);
}

// ---------------------------------------------------------------------------
// Workspace file operation events (PRD Phase 7 §5)
// ---------------------------------------------------------------------------
/**
 * `onDidCreateFiles`, `onDidRenameFiles` and `onDidDeleteFiles`.
 *
 * Main plans the ordering (`common/vscodeFileEvents.ts`) and broadcasts one message per event, so these
 * fire in upstream's order without the worker knowing what the order is. They report the user's and the
 * workbench's file operations; a `workspace.fs` call by an extension deliberately does not fire them,
 * exactly as upstream, and reaches extensions as a watcher event instead.
 */
const onDidCreateFilesEmitter = new EventEmitter<{ files: readonly Uri[] }>();
const onDidDeleteFilesEmitter = new EventEmitter<{ files: readonly Uri[] }>();
const onDidRenameFilesEmitter = new EventEmitter<{
  files: readonly { oldUri: Uri; newUri: Uri }[];
}>();

function applyFileOperation(message: {
  kind: 'create' | 'delete' | 'rename';
  entries: Array<{ oldPath: string | null; newPath: string | null }>;
}): void {
  if (!Array.isArray(message.entries) || message.entries.length === 0) return;
  if (message.kind === 'rename') {
    const files = message.entries
      .filter(
        (entry): entry is { oldPath: string; newPath: string } =>
          typeof entry.oldPath === 'string' &&
          entry.oldPath.length > 0 &&
          typeof entry.newPath === 'string' &&
          entry.newPath.length > 0,
      )
      .map((entry) => ({ oldUri: Uri.file(entry.oldPath), newUri: Uri.file(entry.newPath) }));
    if (files.length > 0) onDidRenameFilesEmitter.fire({ files });
    return;
  }
  const paths = message.entries
    .map((entry) => (message.kind === 'create' ? entry.newPath : entry.oldPath))
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (paths.length === 0) return;
  const files = paths.map((path) => Uri.file(path));
  if (message.kind === 'create') onDidCreateFilesEmitter.fire({ files });
  else onDidDeleteFilesEmitter.fire({ files });
}

const workspaceNamespace = strictNamespace('workspace', {
  get workspaceFolders(): unknown[] | undefined {
    const root = context?.workspaceRoot ?? null;
    if (root === null) return undefined;
    return [{ uri: Uri.file(root), name: root.split(/[\\/]/).pop() ?? root, index: 0 }];
  },
  get name(): string | undefined {
    const root = context?.workspaceRoot ?? null;
    return root === null ? undefined : (root.split(/[\\/]/).pop() ?? root);
  },
  get rootPath(): string | undefined {
    return context?.workspaceRoot ?? undefined;
  },
  get workspaceFile(): undefined {
    return undefined;
  },
  isTrusted: true,
  /**
   * The documents the host has been told about, in the order they opened.
   *
   * A getter, because extensions read `workspace.textDocuments` at arbitrary times and expect the
   * current set — an array captured at startup would be permanently empty.
   */
  get textDocuments(): unknown[] {
    return documentStore.uris().map((uri) => documentFor(uri));
  },
  fs: fileSystem,
  getConfiguration: (section?: string) => configurationSection(section ?? ''),
  onDidChangeConfiguration: configurationEmitter.event,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  onDidOpenTextDocument: openTextDocumentEmitter.event,
  onDidCloseTextDocument: closeTextDocumentEmitter.event,
  onDidChangeTextDocument: changeTextDocumentEmitter.event,
  onDidSaveTextDocument: saveTextDocumentEmitter.event,
  onWillSaveTextDocument: willSaveTextDocumentEmitter.event,
  onDidGrantWorkspaceTrust: new EventEmitter<void>().event,
  asRelativePath: (target: Uri | string): string => {
    const root = context?.workspaceRoot ?? null;
    const path = typeof target === 'string' ? target : target.fsPath;
    if (root === null) return path;
    const rel = relative(root, path);
    return rel.length === 0 || rel.startsWith('..') ? path : rel;
  },
  /**
   * Open a document, returning the one already open when there is one.
   *
   * Identity again: `openTextDocument` on a file the user already has open must hand back the same
   * object `workspace.textDocuments` contains, or an extension that keys a `Map` on the document ends
   * up with two entries for one file. A file not yet known is read through Main — which authorises
   * the path — and then entered into the store, so the open event fires exactly as upstream's does.
   */
  openTextDocument: async (
    target?: Uri | string | { content?: string; language?: string },
  ): Promise<unknown> => {
    if (
      target !== undefined &&
      target !== null &&
      typeof target === 'object' &&
      !(target instanceof Uri)
    ) {
      // The `{content, language}` form: an untitled document that exists only in the host.
      const options = target as { content?: string; language?: string };
      untitledCounter += 1;
      const key = `untitled:Untitled-${untitledCounter}`;
      documentStore.open({
        uri: key,
        languageId: typeof options.language === 'string' ? options.language : 'plaintext',
        version: 1,
        text: typeof options.content === 'string' ? options.content : '',
        isDirty: true,
      });
      const created = documentFor(key);
      openTextDocumentEmitter.fire(created);
      return created;
    }
    const uri = typeof target === 'string' ? Uri.file(target) : (target as Uri);
    const key = uri.toString();
    const known = documentStore.has(key) ? key : findOpenUriForPath(uri.fsPath);
    if (known !== null) return documentFor(known);
    const encoded = await request<string>('workspace.readFile', { path: uri.fsPath });
    const text = Buffer.from(encoded, 'base64').toString('utf8');
    documentStore.open({ uri: key, languageId: '', version: 1, text, isDirty: false });
    const document = documentFor(key);
    openTextDocumentEmitter.fire(document);
    return document;
  },
  findFiles: async (
    include: string | RelativePattern,
    _exclude?: unknown,
    maxResults?: number,
  ): Promise<Uri[]> => {
    const pattern = typeof include === 'string' ? include : include.pattern;
    const paths = await request<string[]>('workspace.findFiles', {
      include: pattern,
      maxResults: maxResults ?? 500,
    });
    return paths.map((path) => Uri.file(path));
  },
  createFileSystemWatcher,
  onDidCreateFiles: onDidCreateFilesEmitter.event,
  onDidDeleteFiles: onDidDeleteFilesEmitter.event,
  onDidRenameFiles: onDidRenameFilesEmitter.event,
  /**
   * Apply a `WorkspaceEdit`.
   *
   * The edit is normalised here — into the same wire shape a provider's `WorkspaceEdit` result takes —
   * and Main decides whether it may be applied. Resolving `false` rather than throwing is upstream's
   * contract, and extensions branch on it, so a refusal by policy and a failure to write both land on
   * the same `false` with the reason in the log.
   */
  applyEdit: async (edit: unknown): Promise<boolean> => {
    const wire = toWireWorkspaceEdit(edit);
    if (!wire || wire.entries.length === 0) return false;
    try {
      return (await request<boolean>('languages.applyWorkspaceEdit', { edit: wire })) === true;
    } catch (error) {
      log('warn', `workspace.applyEdit failed: ${errorMessage(error)}`);
      return false;
    }
  },
  registerTextDocumentContentProvider: (): Disposable => new Disposable(() => undefined),
  saveAll: async (): Promise<boolean> => false,
});

// ---------------------------------------------------------------------------
// Language platform: value types (PRD Phase 6)
// ---------------------------------------------------------------------------
/**
 * The classes a language provider builds its answers out of.
 *
 * These are data holders, deliberately. Extensions construct them, set fields on them, and hand them
 * back; nothing here calls into Main, and none of it is trusted afterwards — every instance is read
 * field by field by `normalizeProviderResult` before it crosses the port. The reason they exist as
 * real classes rather than plain objects is that extensions use `instanceof` on them constantly
 * (`result instanceof CompletionList`, `edit instanceof SnippetTextEdit`), and the API's own
 * overloads are resolved that way.
 */
class SnippetString {
  private tabstop = 1;

  constructor(public value = '') {}

  appendText(text: string): SnippetString {
    this.value += text.replace(/[$}\\]/g, '\\$&');
    return this;
  }

  appendTabstop(number = this.tabstop++): SnippetString {
    this.value += `$${number}`;
    return this;
  }

  appendPlaceholder(
    value: string | ((snippet: SnippetString) => void),
    number = this.tabstop++,
  ): SnippetString {
    if (typeof value === 'function') {
      const nested = new SnippetString();
      value(nested);
      this.value += `\${${number}:${nested.value}}`;
    } else {
      this.value += `\${${number}:${value.replace(/[$}\\]/g, '\\$&')}}`;
    }
    return this;
  }

  appendChoice(values: readonly string[], number = this.tabstop++): SnippetString {
    const choices = values.map((value) => value.replace(/[$}\\,|]/g, '\\$&')).join(',');
    this.value += `\${${number}|${choices}|}`;
    return this;
  }

  appendVariable(
    name: string,
    defaultValue: string | ((snippet: SnippetString) => void) = '',
  ): SnippetString {
    if (typeof defaultValue === 'function') {
      const nested = new SnippetString();
      defaultValue(nested);
      this.value += `\${${name}:${nested.value}}`;
    } else {
      this.value += defaultValue.length === 0 ? `\${${name}}` : `\${${name}:${defaultValue}}`;
    }
    return this;
  }
}

class TextEdit {
  newEol?: number;

  constructor(
    public range: Range,
    public newText: string,
  ) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }

  static setEndOfLine(eol: number): TextEdit {
    const edit = new TextEdit(new Range(0, 0, 0, 0), '');
    edit.newEol = eol;
    return edit;
  }
}

/** A `TextEdit` whose text is a snippet, so the consumer places tabstops instead of literal `$1`. */
class SnippetTextEdit {
  constructor(
    public range: Range,
    public snippet: SnippetString,
  ) {}

  static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(range, snippet);
  }

  static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
}

/** One recorded operation. `kind` and `options` are what `toWireWorkspaceEdit` reads back. */
interface WorkspaceEditOperation {
  kind: 'text' | 'create' | 'rename' | 'delete';
  uri: Uri;
  newUri?: Uri;
  edits?: Array<TextEdit | SnippetTextEdit>;
  options?: Record<string, unknown>;
  contents?: string;
  metadata?: unknown;
}

/**
 * `vscode.WorkspaceEdit`.
 *
 * Upstream keeps one ordered list of operations, and so does this: `set` on a file that already has
 * edits appends to that file's existing entry, but a `createFile` between two `set` calls stays
 * between them. The order is the extension's statement of intent — "create the file, then write to
 * it" — and a map keyed by URI would lose it.
 */
class WorkspaceEdit {
  readonly _operations: WorkspaceEditOperation[] = [];

  private textEntry(uri: Uri): WorkspaceEditOperation {
    // The last text entry for this URI, not any earlier one: an intervening file operation means the
    // edits after it apply to a different state of the file.
    for (let i = this._operations.length - 1; i >= 0; i -= 1) {
      const entry = this._operations[i];
      if (!entry) continue;
      if (entry.uri.toString() === uri.toString()) {
        if (entry.kind === 'text') return entry;
        break;
      }
    }
    const created: WorkspaceEditOperation = { kind: 'text', uri, edits: [] };
    this._operations.push(created);
    return created;
  }

  set(uri: Uri, edits: Array<TextEdit | SnippetTextEdit | null | undefined>): void {
    const entry = this.textEntry(uri);
    entry.edits = (edits ?? []).filter(
      (edit): edit is TextEdit | SnippetTextEdit => edit !== null && edit !== undefined,
    );
  }

  replace(uri: Uri, range: Range, newText: string): void {
    this.textEntry(uri).edits?.push(new TextEdit(range, newText));
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.textEntry(uri).edits?.push(TextEdit.insert(position, newText));
  }

  delete(uri: Uri, range: Range): void {
    this.textEntry(uri).edits?.push(TextEdit.delete(range));
  }

  createFile(uri: Uri, options?: Record<string, unknown>, metadata?: unknown): void {
    const contents = options?.contents;
    this._operations.push({
      kind: 'create',
      uri,
      options: options ?? {},
      ...(contents instanceof Uint8Array
        ? { contents: Buffer.from(contents).toString('utf8') }
        : typeof contents === 'string'
          ? { contents }
          : {}),
      metadata,
    });
  }

  renameFile(
    oldUri: Uri,
    newUri: Uri,
    options?: Record<string, unknown>,
    metadata?: unknown,
  ): void {
    this._operations.push({
      kind: 'rename',
      uri: oldUri,
      newUri,
      options: options ?? {},
      metadata,
    });
  }

  deleteFile(uri: Uri, options?: Record<string, unknown>, metadata?: unknown): void {
    this._operations.push({ kind: 'delete', uri, options: options ?? {}, metadata });
  }

  has(uri: Uri): boolean {
    return this._operations.some(
      (entry) => entry.kind === 'text' && entry.uri.toString() === uri.toString(),
    );
  }

  get(uri: Uri): Array<TextEdit | SnippetTextEdit> {
    const out: Array<TextEdit | SnippetTextEdit> = [];
    for (const entry of this._operations) {
      if (entry.kind === 'text' && entry.uri.toString() === uri.toString()) {
        out.push(...(entry.edits ?? []));
      }
    }
    return out;
  }

  entries(): Array<[Uri, Array<TextEdit | SnippetTextEdit>]> {
    const out: Array<[Uri, Array<TextEdit | SnippetTextEdit>]> = [];
    for (const entry of this._operations) {
      if (entry.kind === 'text') out.push([entry.uri, entry.edits ?? []]);
    }
    return out;
  }

  get size(): number {
    return new Set(
      this._operations
        .filter((entry) => entry.kind === 'text')
        .map((entry) => entry.uri.toString()),
    ).size;
  }
}

class CompletionItem {
  kind?: number;
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  command?: { command: string; title?: string; arguments?: unknown[] };
  tags?: number[];

  constructor(
    public label: string | { label: string; detail?: string; description?: string },
    kind?: number,
  ) {
    if (kind !== undefined) this.kind = kind;
  }
}

class CompletionList {
  constructor(
    public items: CompletionItem[] = [],
    public isIncomplete = false,
  ) {}
}

class Hover {
  contents: Array<string | MarkdownString>;

  constructor(
    contents: string | MarkdownString | Array<string | MarkdownString>,
    public range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

class ParameterInformation {
  constructor(
    public label: string | [number, number],
    public documentation?: string | MarkdownString,
  ) {}
}

class SignatureInformation {
  parameters: ParameterInformation[] = [];
  activeParameter?: number;

  constructor(
    public label: string,
    public documentation?: string | MarkdownString,
  ) {}
}

class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

class SymbolInformation {
  location: Location;
  tags?: number[];

  constructor(
    public name: string,
    public kind: number,
    rangeOrContainer: Range | string,
    locationOrUri?: Location | Uri,
    public containerName?: string,
  ) {
    if (typeof rangeOrContainer === 'string') {
      // `SymbolInformation(name, kind, containerName, location)` — the older overload.
      this.containerName = rangeOrContainer;
      this.location =
        locationOrUri instanceof Location
          ? locationOrUri
          : new Location(locationOrUri ?? Uri.file(''), new Range(0, 0, 0, 0));
    } else {
      const uri = locationOrUri instanceof Location ? locationOrUri.uri : (locationOrUri as Uri);
      this.location = new Location(uri ?? Uri.file(''), rangeOrContainer);
    }
  }
}

class DocumentSymbol {
  children: DocumentSymbol[] = [];
  tags?: number[];

  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range = range,
  ) {}
}

/**
 * `vscode.CodeActionKind`.
 *
 * A class, not an enum, because the kinds form a dotted hierarchy — `refactor.extract.function` is a
 * `refactor.extract` is a `refactor` — and the editor filters on that containment. `contains` and
 * `intersects` are what a `CodeActionProvider` uses to decide whether the editor is even asking for
 * the kind of action it produces.
 */
class CodeActionKind {
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  static readonly RefactorExtract = new CodeActionKind('refactor.extract');
  static readonly RefactorInline = new CodeActionKind('refactor.inline');
  static readonly RefactorMove = new CodeActionKind('refactor.move');
  static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
  static readonly Source = new CodeActionKind('source');
  static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
  static readonly SourceFixAll = new CodeActionKind('source.fixAll');
  static readonly Notebook = new CodeActionKind('notebook');

  constructor(readonly value: string) {}

  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value.length === 0 ? parts : `${this.value}.${parts}`);
  }

  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }

  contains(other: CodeActionKind): boolean {
    return (
      this.value.length === 0 ||
      this.value === other.value ||
      other.value.startsWith(`${this.value}.`)
    );
  }
}

class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: { command: string; title?: string; arguments?: unknown[] };
  isPreferred?: boolean;
  disabled?: { reason: string };

  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

class CodeLens {
  constructor(
    public range: Range,
    public command?: { command: string; title?: string; arguments?: unknown[] },
  ) {}

  get isResolved(): boolean {
    return this.command !== undefined;
  }
}

class DocumentLink {
  tooltip?: string;

  constructor(
    public range: Range,
    public target?: Uri,
  ) {}
}

class Color {
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha: number,
  ) {}
}

class ColorInformation {
  constructor(
    public range: Range,
    public color: Color,
  ) {}
}

class ColorPresentation {
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];

  constructor(public label: string) {}
}

class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: number = 0,
  ) {}
}

class SelectionRange {
  constructor(
    public range: Range,
    public parent?: SelectionRange,
  ) {}
}

class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: number,
  ) {}
}

class InlayHintLabelPart {
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: { command: string; title?: string; arguments?: unknown[] };

  constructor(public value: string) {}
}

class InlayHint {
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  textEdits?: TextEdit[];

  constructor(
    public position: Position,
    public label: string | InlayHintLabelPart[],
    public kind?: number,
  ) {}
}

class InlineValueText {
  constructor(
    public range: Range,
    public text: string,
  ) {}
}

class InlineValueVariableLookup {
  constructor(
    public range: Range,
    public variableName?: string,
    public caseSensitiveLookup: boolean = true,
  ) {}
}

class InlineValueEvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string,
  ) {}
}

/**
 * Hierarchy items carry their own identity across two calls.
 *
 * `prepare` returns items; `incoming`/`outgoing` (or `supertypes`/`subtypes`) are then called with one
 * of them. So the item has to survive a round trip through the wire unchanged in every field the
 * provider might read back — extensions routinely stash state on `detail` or compare `uri` and
 * `selectionRange` to find the symbol again.
 */
class CallHierarchyItem {
  detail?: string;
  tags?: readonly number[];

  constructor(
    public kind: number,
    public name: string,
    detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {
    this.detail = detail;
  }
}

class CallHierarchyIncomingCall {
  constructor(
    public from: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

class CallHierarchyOutgoingCall {
  constructor(
    public to: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

class TypeHierarchyItem {
  detail?: string;
  tags?: readonly number[];

  constructor(
    public kind: number,
    public name: string,
    detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {
    this.detail = detail;
  }
}

class LinkedEditingRanges {
  constructor(
    public ranges: Range[],
    public wordPattern?: RegExp,
  ) {}
}

class SemanticTokensLegend {
  constructor(
    readonly tokenTypes: string[],
    readonly tokenModifiers: string[] = [],
  ) {}
}

class SemanticTokens {
  constructor(
    readonly data: Uint32Array,
    readonly resultId?: string,
  ) {}
}

class SemanticTokensEdit {
  constructor(
    readonly start: number,
    readonly deleteCount: number,
    readonly data?: Uint32Array,
  ) {}
}

class SemanticTokensEdits {
  constructor(
    readonly edits: SemanticTokensEdit[],
    readonly resultId?: string,
  ) {}
}

/**
 * The builder extensions actually use, with the same two constructor shapes as upstream.
 *
 * Constructed with a legend, `push` takes names and resolves them; constructed without one it takes
 * the numeric type and modifier bitmask directly. Both forms are in the wild — the language-server
 * clients build tokens by name, hand-written providers by number — and a builder that only supports
 * one of them fails at `push` with a type error the extension cannot see coming.
 *
 * The relative encoding and the ordering are `common/vscodeSemanticTokens.ts`'s job; this class only
 * collects. That keeps one implementation of the delta encoding for both the builder and the raw
 * arrays a provider may return without it.
 */
class SemanticTokensBuilder {
  private readonly tokens: RawSemanticToken[] = [];
  private readonly legend: SemanticTokensLegendData | null;

  constructor(legend?: SemanticTokensLegend) {
    this.legend =
      legend && Array.isArray(legend.tokenTypes)
        ? {
            tokenTypes: legend.tokenTypes.slice(),
            tokenModifiers: Array.isArray(legend.tokenModifiers)
              ? legend.tokenModifiers.slice()
              : [],
          }
        : null;
  }

  push(
    line: number | Range,
    character?: number | string,
    length?: number | readonly string[],
    tokenType?: number | string,
    tokenModifiers?: number,
  ): void {
    if (line instanceof Range) {
      // push(range, tokenType, tokenModifiers?) — the legend form.
      const type = typeof character === 'string' ? character : '';
      const modifiers = Array.isArray(length) ? (length as readonly string[]) : [];
      if (!this.legend) return;
      const resolved = resolveTokenType(this.legend, type);
      if (resolved < 0) return;
      if (line.start.line !== line.end.line) return;
      this.tokens.push({
        line: line.start.line,
        character: line.start.character,
        length: line.end.character - line.start.character,
        tokenType: resolved,
        tokenModifiers: resolveTokenModifiers(this.legend, modifiers),
      });
      return;
    }
    // push(line, char, length, tokenType, tokenModifiers?) — the numeric form.
    const type =
      typeof tokenType === 'string'
        ? this.legend
          ? resolveTokenType(this.legend, tokenType)
          : -1
        : typeof tokenType === 'number'
          ? tokenType
          : -1;
    if (type < 0) return;
    this.tokens.push({
      line,
      character: typeof character === 'number' ? character : 0,
      length: typeof length === 'number' ? length : 0,
      tokenType: type,
      tokenModifiers: typeof tokenModifiers === 'number' ? tokenModifiers : 0,
    });
  }

  build(resultId?: string): SemanticTokens {
    return new SemanticTokens(new Uint32Array(encodeSemanticTokens(this.tokens)), resultId);
  }
}

// ---------------------------------------------------------------------------
// Language platform: provider registry and dispatch (PRD Phase 6)
// ---------------------------------------------------------------------------
/**
 * One registration, as this process holds it.
 *
 * The handle is minted here rather than in Main because the handle is what the extension's
 * `Disposable` closes over: an extension that disposes a provider must revoke *its* registration, and
 * a number Main chose would have to arrive before the `Disposable` could be returned — which
 * `register*Provider` cannot wait for, since it is synchronous in the published API.
 */
interface WorkerProviderRecord {
  handle: number;
  feature: LanguageFeature;
  provider: Record<string, unknown>;
  selector: DocumentSelector;
  /** Unsubscribe from the provider's own change event, when it has one. */
  unsubscribeChange?: () => void;
}

const workerProviders = new Map<number, WorkerProviderRecord>();
let nextProviderHandle = 1;

/** Objects handed out to Main by token, so a `resolve` call gets the extension's own instance. */
const mintedValues = new Map<number, unknown>();
let nextMintToken = 1;
/**
 * Minted objects kept at once.
 *
 * A completion list of 1,000 items mints 1,000 tokens, and the user opens the widget repeatedly, so
 * this has to be bounded. Eviction is oldest-first, which matches how resolution works in practice:
 * a token is redeemed within a keystroke or two of being minted, or never.
 */
const MAX_MINTED_VALUES = 20_000;

function mintValue(original: unknown): number {
  const token = nextMintToken;
  nextMintToken += 1;
  mintedValues.set(token, original);
  while (mintedValues.size > MAX_MINTED_VALUES) {
    const oldest = mintedValues.keys().next();
    if (oldest.done) break;
    mintedValues.delete(oldest.value);
  }
  return token;
}

function mintedValue(payload: Record<string, unknown>): unknown {
  const id = payload.id;
  return typeof id === 'number' ? mintedValues.get(id) : undefined;
}

/**
 * The wire context every provider result is normalised with.
 *
 * `allowCommands` is on because a language provider's markdown legitimately contains command links
 * (`[Fix all](command:eslint.executeAutofix)`) and the renderer enforces the allow-list on the other
 * side; `mint` is what makes `resolve` possible at all.
 */
const providerWireContext: WireContext = { mint: mintValue, allowCommands: true };

/**
 * Register one provider and tell Main about it.
 *
 * The `Disposable` is returned synchronously, before Main has acknowledged anything: that is what the
 * published API promises, and an extension that registers and immediately disposes (a common shape in
 * `onDidChangeConfiguration` handlers) must not have its dispose lost in the gap. The local record is
 * removed on dispose whether or not the unregister request succeeds, so a provider can never be called
 * after the extension believes it is gone.
 */
function registerLanguageProvider(
  feature: LanguageFeature,
  rawSelector: unknown,
  provider: unknown,
  metadata: Record<string, unknown> = {},
): Disposable {
  if (typeof provider !== 'object' || provider === null) {
    throw new Error(`languages.register*Provider for ${feature} requires a provider object.`);
  }
  const selector = rawSelector as DocumentSelector;
  const handle = nextProviderHandle;
  nextProviderHandle += 1;
  const record: WorkerProviderRecord = {
    handle,
    feature,
    provider: provider as Record<string, unknown>,
    selector,
  };
  workerProviders.set(handle, record);
  // The provider's own change event, forwarded verbatim. VS Code treats a fire as "your cached
  // answers for this provider are stale"; the renderer re-asks Monaco for exactly this handle.
  // The event is bound to the provider first: an extension is free to declare it as a prototype
  // method (`onDidChangeCodeLenses(listener) { return this._emitter.event(listener); }`), and an
  // unbound call would throw on the extension's own `this`.
  const changeEvent = providerChangeEventName(feature);
  if (changeEvent !== null) {
    const rawEvent = (provider as Record<string, unknown>)[changeEvent];
    const boundEvent =
      typeof rawEvent === 'function'
        ? (rawEvent as (listener: (value: unknown) => void) => unknown).bind(provider)
        : rawEvent;
    const unsubscribe = subscribeForeignEvent(boundEvent, () => {
      if (!workerProviders.has(handle)) return;
      void request('languages.providerChanged', { handle }).catch(() => undefined);
    });
    if (unsubscribe) record.unsubscribeChange = unsubscribe;
  }
  void request('languages.registerProvider', {
    handle,
    feature,
    selector,
    metadata: { ...metadata, ...detectProviderCapabilities(feature, provider) },
  }).catch((error: unknown) => {
    log('warn', `${feature} provider registration was refused: ${errorMessage(error)}`);
    workerProviders.delete(handle);
    record.unsubscribeChange?.();
  });
  return new Disposable(() => {
    if (!workerProviders.delete(handle)) return;
    record.unsubscribeChange?.();
    for (const [id, entry] of providerCalls) {
      if (entry.handle === handle) {
        // A provider disposed mid-flight has its outstanding calls cancelled, which is what upstream
        // does and what lets a provider free the work it started.
        entry.source.cancel();
        providerCalls.delete(id);
      }
    }
    void request('languages.unregisterProvider', { handle }).catch(() => undefined);
  });
}

/**
 * Which optional halves a provider actually implements.
 *
 * Advertised so Monaco does not offer an operation the provider cannot answer: registering a
 * completion provider as resolvable when it has no `resolveCompletionItem` produces a call that
 * returns `undefined` for every item and a documentation pane that never fills in.
 */
function detectProviderCapabilities(
  feature: LanguageFeature,
  provider: unknown,
): Record<string, unknown> {
  const has = (name: string): boolean =>
    typeof (provider as Record<string, unknown>)[name] === 'function';
  // A change event is orthogonal to the resolve/edits halves below, so it is folded in for every
  // feature that has one rather than repeated in each case.
  const changeEvent = providerChangeEventName(feature);
  const change: Record<string, unknown> =
    changeEvent !== null && has(changeEvent) ? { hasChangeEvent: true } : {};
  switch (feature) {
    case 'completion':
      return { hasResolve: has('resolveCompletionItem') };
    case 'codeAction':
      return { hasResolve: has('resolveCodeAction') };
    case 'codeLens':
      return { ...change, hasResolve: has('resolveCodeLens') };
    case 'documentLink':
      return { hasResolve: has('resolveDocumentLink') };
    case 'inlayHint':
      return { ...change, hasResolve: has('resolveInlayHint') };
    case 'workspaceSymbol':
      return { hasResolve: has('resolveWorkspaceSymbol') };
    case 'rename':
      return { hasPrepare: has('prepareRename') };
    case 'semanticTokens':
      return { ...change, hasEdits: has('provideDocumentSemanticTokensEdits') };
    case 'color':
      return { hasResolve: has('provideColorPresentations') };
    default:
      return change;
  }
}

/** Calls in flight, so `languageCancel` can reach the token the provider is holding. */
const providerCalls = new Map<number, { handle: number; source: CancellationTokenSource }>();

/** Provider calls this process will run at once. Past this, dispatch answers null rather than queue. */
const MAX_CONCURRENT_PROVIDER_CALLS = 64;

function positionFrom(value: unknown): Position {
  const source = (value ?? {}) as { line?: unknown; character?: unknown };
  return new Position(
    typeof source.line === 'number' ? source.line : 0,
    typeof source.character === 'number' ? source.character : 0,
  );
}

function rangeFrom(value: unknown): Range {
  const source = (value ?? {}) as { start?: unknown; end?: unknown };
  return new Range(positionFrom(source.start), positionFrom(source.end));
}

/** A wire diagnostic back into the class an extension expects to read. */
function diagnosticFrom(value: unknown): Diagnostic {
  const source = (value ?? {}) as Record<string, unknown>;
  const diagnostic = new Diagnostic(
    rangeFrom(source.range),
    typeof source.message === 'string' ? source.message : '',
    typeof source.severity === 'number' ? source.severity : DiagnosticSeverity.Error,
  );
  if (typeof source.source === 'string') diagnostic.source = source.source;
  if (typeof source.code === 'string' || typeof source.code === 'number') {
    diagnostic.code = source.code;
  }
  if (Array.isArray(source.tags)) {
    diagnostic.tags = source.tags.filter((tag): tag is number => typeof tag === 'number');
  }
  return diagnostic;
}

function formattingOptionsFrom(value: unknown): { tabSize: number; insertSpaces: boolean } {
  const source = (value ?? {}) as { tabSize?: unknown; insertSpaces?: unknown };
  return {
    tabSize: typeof source.tabSize === 'number' && source.tabSize > 0 ? source.tabSize : 4,
    insertSpaces: source.insertSpaces !== false,
  };
}

function call(provider: Record<string, unknown>, name: string, args: unknown[]): unknown {
  const method = provider[name];
  if (typeof method !== 'function') return undefined;
  return (method as (...values: unknown[]) => unknown).apply(provider, args);
}

/**
 * The adapter table: one entry per feature and operation, mirroring VS Code's own adapter classes.
 *
 * Each entry is the *only* place that knows a provider method's name and argument order, which is why
 * there are 40 short functions here rather than one clever dispatcher: the published signatures are
 * not uniform (`provideReferences` takes its context third, `provideOnTypeFormattingEdits` takes a
 * character, hierarchy traversals take an item rather than a document), and a generic dispatcher would
 * have to encode those exceptions anyway — less legibly, and in a place the next feature's author
 * would not look.
 */
type ProviderAdapter = (
  provider: Record<string, unknown>,
  payload: Record<string, unknown>,
  token: unknown,
  document: LiveTextDocument | null,
) => unknown;

const PROVIDER_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = {
  'completion:provide': (provider, payload, token, document) =>
    call(provider, 'provideCompletionItems', [
      document,
      positionFrom(payload.position),
      token,
      {
        triggerKind:
          typeof payload.triggerKind === 'number'
            ? payload.triggerKind
            : CompletionTriggerKind.Invoke,
        triggerCharacter:
          typeof payload.triggerCharacter === 'string' ? payload.triggerCharacter : undefined,
      },
    ]),
  'completion:resolve': (provider, payload, token) =>
    call(provider, 'resolveCompletionItem', [mintedValue(payload), token]),
  'hover:provide': (provider, payload, token, document) =>
    call(provider, 'provideHover', [document, positionFrom(payload.position), token]),
  'signatureHelp:provide': (provider, payload, token, document) =>
    call(provider, 'provideSignatureHelp', [
      document,
      positionFrom(payload.position),
      token,
      {
        triggerKind:
          typeof payload.triggerKind === 'number'
            ? payload.triggerKind
            : SignatureHelpTriggerKind.Invoke,
        triggerCharacter:
          typeof payload.triggerCharacter === 'string' ? payload.triggerCharacter : undefined,
        isRetrigger: payload.isRetrigger === true,
        activeSignatureHelp: mintedValue(payload) ?? undefined,
      },
    ]),
  'definition:provide': (provider, payload, token, document) =>
    call(provider, 'provideDefinition', [document, positionFrom(payload.position), token]),
  'typeDefinition:provide': (provider, payload, token, document) =>
    call(provider, 'provideTypeDefinition', [document, positionFrom(payload.position), token]),
  'implementation:provide': (provider, payload, token, document) =>
    call(provider, 'provideImplementation', [document, positionFrom(payload.position), token]),
  'declaration:provide': (provider, payload, token, document) =>
    call(provider, 'provideDeclaration', [document, positionFrom(payload.position), token]),
  'reference:provide': (provider, payload, token, document) =>
    call(provider, 'provideReferences', [
      document,
      positionFrom(payload.position),
      { includeDeclaration: payload.includeDeclaration !== false },
      token,
    ]),
  'rename:provide': (provider, payload, token, document) =>
    call(provider, 'provideRenameEdits', [
      document,
      positionFrom(payload.position),
      typeof payload.newName === 'string' ? payload.newName : '',
      token,
    ]),
  'rename:prepare': (provider, payload, token, document) =>
    call(provider, 'prepareRename', [document, positionFrom(payload.position), token]),
  'documentSymbol:provide': (provider, _payload, token, document) =>
    call(provider, 'provideDocumentSymbols', [document, token]),
  'workspaceSymbol:provide': (provider, payload, token) =>
    call(provider, 'provideWorkspaceSymbols', [
      typeof payload.query === 'string' ? payload.query : '',
      token,
    ]),
  'workspaceSymbol:resolve': (provider, payload, token) =>
    call(provider, 'resolveWorkspaceSymbol', [mintedValue(payload), token]),
  'formatting:provide': (provider, payload, token, document) =>
    call(provider, 'provideDocumentFormattingEdits', [
      document,
      formattingOptionsFrom(payload.options),
      token,
    ]),
  'rangeFormatting:provide': (provider, payload, token, document) =>
    call(provider, 'provideDocumentRangeFormattingEdits', [
      document,
      rangeFrom(payload.range),
      formattingOptionsFrom(payload.options),
      token,
    ]),
  'onTypeFormatting:provide': (provider, payload, token, document) =>
    call(provider, 'provideOnTypeFormattingEdits', [
      document,
      positionFrom(payload.position),
      typeof payload.ch === 'string' ? payload.ch : '',
      formattingOptionsFrom(payload.options),
      token,
    ]),
  'codeAction:provide': (provider, payload, token, document) =>
    call(provider, 'provideCodeActions', [
      document,
      rangeFrom(payload.range),
      {
        diagnostics: Array.isArray(payload.diagnostics)
          ? payload.diagnostics.map(diagnosticFrom)
          : [],
        only:
          typeof payload.only === 'string' && payload.only.length > 0
            ? new CodeActionKind(payload.only)
            : undefined,
        triggerKind:
          typeof payload.triggerKind === 'number'
            ? payload.triggerKind
            : CodeActionTriggerKind.Invoke,
      },
      token,
    ]),
  'codeAction:resolve': (provider, payload, token) =>
    call(provider, 'resolveCodeAction', [mintedValue(payload), token]),
  'codeLens:provide': (provider, _payload, token, document) =>
    call(provider, 'provideCodeLenses', [document, token]),
  'codeLens:resolve': (provider, payload, token) =>
    call(provider, 'resolveCodeLens', [mintedValue(payload), token]),
  'color:provide': (provider, _payload, token, document) =>
    call(provider, 'provideDocumentColors', [document, token]),
  'color:presentations': (provider, payload, token, document) => {
    const source = (payload.color ?? {}) as Record<string, number>;
    const color = new Color(
      Number(source.red ?? 0),
      Number(source.green ?? 0),
      Number(source.blue ?? 0),
      Number(source.alpha ?? 1),
    );
    return call(provider, 'provideColorPresentations', [
      color,
      { document, range: rangeFrom(payload.range) },
      token,
    ]);
  },
  'documentHighlight:provide': (provider, payload, token, document) =>
    call(provider, 'provideDocumentHighlights', [document, positionFrom(payload.position), token]),
  'documentLink:provide': (provider, _payload, token, document) =>
    call(provider, 'provideDocumentLinks', [document, token]),
  'documentLink:resolve': (provider, payload, token) =>
    call(provider, 'resolveDocumentLink', [mintedValue(payload), token]),
  'selectionRange:provide': (provider, payload, token, document) =>
    call(provider, 'provideSelectionRanges', [
      document,
      (Array.isArray(payload.positions) ? payload.positions : [payload.position]).map(positionFrom),
      token,
    ]),
  'foldingRange:provide': (provider, _payload, token, document) =>
    call(provider, 'provideFoldingRanges', [document, {}, token]),
  'linkedEditingRange:provide': (provider, payload, token, document) =>
    call(provider, 'provideLinkedEditingRanges', [document, positionFrom(payload.position), token]),
  'inlayHint:provide': (provider, payload, token, document) =>
    call(provider, 'provideInlayHints', [document, rangeFrom(payload.range), token]),
  'inlayHint:resolve': (provider, payload, token) =>
    call(provider, 'resolveInlayHint', [mintedValue(payload), token]),
  'inlineValue:provide': (provider, payload, token, document) =>
    call(provider, 'provideInlineValues', [
      document,
      rangeFrom(payload.range),
      {
        frameId: typeof payload.frameId === 'number' ? payload.frameId : 0,
        stoppedLocation: rangeFrom(payload.stoppedLocation ?? payload.range),
      },
      token,
    ]),
  'callHierarchy:prepare': (provider, payload, token, document) =>
    call(provider, 'prepareCallHierarchy', [document, positionFrom(payload.position), token]),
  'callHierarchy:incoming': (provider, payload, token) =>
    call(provider, 'provideCallHierarchyIncomingCalls', [
      mintedValue(payload) ?? hierarchyItemFrom(payload.item),
      token,
    ]),
  'callHierarchy:outgoing': (provider, payload, token) =>
    call(provider, 'provideCallHierarchyOutgoingCalls', [
      mintedValue(payload) ?? hierarchyItemFrom(payload.item),
      token,
    ]),
  'typeHierarchy:prepare': (provider, payload, token, document) =>
    call(provider, 'prepareTypeHierarchy', [document, positionFrom(payload.position), token]),
  'typeHierarchy:supertypes': (provider, payload, token) =>
    call(provider, 'provideTypeHierarchySupertypes', [
      mintedValue(payload) ?? hierarchyItemFrom(payload.item),
      token,
    ]),
  'typeHierarchy:subtypes': (provider, payload, token) =>
    call(provider, 'provideTypeHierarchySubtypes', [
      mintedValue(payload) ?? hierarchyItemFrom(payload.item),
      token,
    ]),
  'semanticTokens:provide': (provider, _payload, token, document) =>
    call(provider, 'provideDocumentSemanticTokens', [document, token]),
  'semanticTokens:edits': (provider, payload, token, document) =>
    call(provider, 'provideDocumentSemanticTokensEdits', [
      document,
      typeof payload.previousResultId === 'string' ? payload.previousResultId : '',
      token,
    ]),
  'semanticTokensRange:provide': (provider, payload, token, document) =>
    call(provider, 'provideDocumentRangeSemanticTokens', [
      document,
      rangeFrom(payload.range),
      token,
    ]),
};

/**
 * Rebuild a hierarchy item Main sent back.
 *
 * The minted original is preferred — an extension may have stashed state on the item it returned —
 * but a token can be evicted while a hierarchy view stays open for minutes, so the wire form is
 * reconstructed as the fallback rather than failing the traversal.
 */
function hierarchyItemFrom(value: unknown): CallHierarchyItem {
  const source = (value ?? {}) as Record<string, unknown>;
  return new CallHierarchyItem(
    typeof source.kind === 'number' ? source.kind : SymbolKind.Function,
    typeof source.name === 'string' ? source.name : '',
    typeof source.detail === 'string' ? source.detail : '',
    Uri.parse(typeof source.uri === 'string' ? source.uri : ''),
    rangeFrom(source.range),
    rangeFrom(source.selectionRange),
  );
}

/**
 * Run one provider call and reply.
 *
 * The `CancellationTokenSource` is created per request and recorded against the request id, because
 * that id is the only thing a `languageCancel` carries — the token the provider receives has to be
 * reachable from it. It is disposed in `finally` whether the provider resolved, threw, or was
 * cancelled, so a provider that ignores its token cannot leak the source.
 *
 * A cancelled call still replies. Main has already settled its side, so the reply is dropped there;
 * replying anyway means the worker has exactly one exit path per request and no state to reconcile if
 * the cancel and the result cross on the wire.
 */
async function dispatchLanguageProvide(message: {
  id: number;
  handle: number;
  feature: string;
  op: string;
  uri: string | null;
  payload: unknown;
}): Promise<void> {
  const fail = (error: string): void => {
    send({ t: 'result', id: message.id, ok: false, error });
  };
  const record = workerProviders.get(message.handle);
  if (!record || record.feature !== message.feature) {
    fail(`No ${message.feature} provider is registered for handle ${message.handle}.`);
    return;
  }
  const adapter = PROVIDER_ADAPTERS[`${message.feature}:${message.op}`];
  if (!adapter) {
    fail(`${message.feature} has no ${message.op} operation.`);
    return;
  }
  if (providerCalls.size >= MAX_CONCURRENT_PROVIDER_CALLS) {
    // Back-pressure rather than a queue: the workbench re-requests on the next keystroke anyway, and
    // a queue here would answer with results the user has already scrolled past.
    fail(`Too many language requests are already in flight (${MAX_CONCURRENT_PROVIDER_CALLS}).`);
    return;
  }

  let document: LiveTextDocument | null = null;
  if (typeof message.uri === 'string' && message.uri.length > 0) {
    if (!documentStore.has(message.uri)) {
      fail(`The document ${message.uri} is not open in this extension host.`);
      return;
    }
    document = documentFor(message.uri);
  }

  const source = new CancellationTokenSource();
  providerCalls.set(message.id, { handle: message.handle, source });
  try {
    const value = await adapter(
      record.provider,
      (message.payload ?? {}) as Record<string, unknown>,
      source.token,
      document,
    );
    if (source.token.isCancellationRequested) {
      fail('The request was cancelled.');
      return;
    }
    send({
      t: 'result',
      id: message.id,
      ok: true,
      value: normalizeProviderResult(
        record.feature,
        message.op as ProviderOp,
        value,
        providerWireContext,
      ),
    });
  } catch (error) {
    fail(errorMessage(error));
  } finally {
    providerCalls.delete(message.id);
    source.dispose();
  }
}

/** Trip the token for one in-flight call. Unknown ids are ignored: the call already finished. */
function cancelLanguageProvide(id: number): void {
  const entry = providerCalls.get(id);
  if (!entry) return;
  providerCalls.delete(id);
  entry.source.cancel();
}

/**
 * A code-action provider's `documentation`, reduced to command ids.
 *
 * The published shape carries a `Command` object; only its `command` and `title` survive the port,
 * because the arguments are re-supplied by the caller when the link is followed.
 */
function normalizeCodeActionDocumentation(
  value: unknown,
): Array<{ kind: string; title: string; command: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: string; title: string; command: string }> = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { kind?: unknown; command?: unknown };
    const kind = (entry.kind as { value?: unknown } | undefined)?.value ?? entry.kind;
    const command = entry.command as { command?: unknown; title?: unknown } | undefined;
    if (typeof kind !== 'string' || typeof command?.command !== 'string') continue;
    out.push({
      kind,
      title: typeof command.title === 'string' ? command.title : command.command,
      command: command.command,
    });
  }
  return out;
}

/** Validate a semantic-token legend at registration, where the extension can still be blamed. */
function requireSemanticTokensLegend(value: unknown): SemanticTokensLegendData {
  const legend = normalizeSemanticTokensLegend(value);
  if (!legend) {
    throw new Error(
      'registerDocumentSemanticTokensProvider requires a legend with at least one token type.',
    );
  }
  return legend;
}

/**
 * `vscode.languages`.
 *
 * Every `register*Provider` is the same three lines — mint a handle, tell Main what this provider can
 * answer, return a `Disposable` — because that is what upstream's `ExtHostLanguageFeatures` is once
 * the adapter classes are factored out. The differences that remain are the metadata each feature
 * needs before it is ever called: a completion provider's trigger characters decide *when* Monaco asks
 * it anything, and a semantic-token provider's legend decides what its answers mean, so both have to
 * cross at registration rather than with the first result.
 */
const languagesNamespace = strictNamespace('languages', {
  createDiagnosticCollection,
  onDidChangeDiagnostics: diagnosticsEmitter.event,

  /** What this extension itself published. Other extensions' diagnostics come from Main. */
  getDiagnostics: (uri?: Uri): unknown => {
    if (uri instanceof Uri) {
      const out: Diagnostic[] = [];
      for (const collection of diagnosticCollections) {
        const list = collection.get(uri);
        if (list) out.push(...list);
      }
      return out;
    }
    const grouped = new Map<string, Diagnostic[]>();
    for (const collection of diagnosticCollections) {
      collection.forEach((target, diagnostics) => {
        const key = target.toString();
        const bucket = grouped.get(key);
        if (bucket) bucket.push(...diagnostics);
        else grouped.set(key, [...diagnostics]);
      });
    }
    return Array.from(grouped, ([key, diagnostics]) => [Uri.parse(key), diagnostics]);
  },

  getLanguages: async (): Promise<string[]> => {
    try {
      const value = await request<unknown>('languages.getLanguages');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  },

  /**
   * Score a document against a selector — the same function the registry selects with, so an
   * extension that asks `match` gets the number that will actually decide whether it is called.
   */
  match: (selector: unknown, document: unknown): number => {
    const target = document as { uri?: Uri; languageId?: unknown } | null;
    if (!target || !(target.uri instanceof Uri)) return 0;
    return scoreDocumentSelector(
      selector as DocumentSelector,
      toDocumentCandidate({
        uri: target.uri.toString(),
        languageId: typeof target.languageId === 'string' ? target.languageId : '',
      }),
    );
  },

  registerLanguage: (definition: unknown): Disposable => {
    void request('languages.registerLanguage', { definition }).catch((error: unknown) =>
      log('warn', `languages.registerLanguage failed: ${errorMessage(error)}`),
    );
    // Upstream returns nothing from the contribution path; the disposable is ours so a dynamic
    // registration can be undone, and it is a no-op rather than a lie only because language ids
    // themselves are never unregistered in VS Code either.
    return new Disposable(() => undefined);
  },

  setLanguageConfiguration: (languageId: string, configuration: unknown): Disposable => {
    void request('languages.setLanguageConfiguration', { languageId, configuration }).catch(
      (error: unknown) =>
        log('warn', `languages.setLanguageConfiguration failed: ${errorMessage(error)}`),
    );
    return new Disposable(() => {
      void request('languages.setLanguageConfiguration', {
        languageId,
        configuration: {},
      }).catch(() => undefined);
    });
  },

  /**
   * `setTextDocumentLanguage` resolves with the document, as upstream does.
   *
   * Main answers with the new snapshot and also broadcasts a `documentLanguage` message, so the
   * object returned here is the same live document every other extension now sees.
   */
  setTextDocumentLanguage: async (document: unknown, languageId: string): Promise<unknown> => {
    const uri = (document as { uri?: Uri } | null)?.uri;
    if (!(uri instanceof Uri)) throw new Error('setTextDocumentLanguage requires a document.');
    const key = findOpenUriForPath(uri.fsPath) ?? uri.toString();
    await request('languages.setTextDocumentLanguage', { uri: key, languageId });
    return documentFor(key);
  },
  registerCompletionItemProvider: (
    selector: unknown,
    provider: unknown,
    ...triggerCharacters: string[]
  ): Disposable =>
    registerLanguageProvider('completion', selector, provider, {
      triggerCharacters: normalizeTriggerCharacters(triggerCharacters),
    }),

  registerHoverProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('hover', selector, provider),

  /**
   * Both published forms: variadic trigger characters, or a `SignatureHelpProviderMetadata`.
   *
   * The metadata form is the only way to declare *retrigger* characters, and an extension that uses it
   * would otherwise have its object read as a trigger character and get no signature help at all.
   */
  registerSignatureHelpProvider: (
    selector: unknown,
    provider: unknown,
    ...rest: unknown[]
  ): Disposable => {
    const first = rest[0];
    const metadata =
      first !== null && typeof first === 'object'
        ? (first as { triggerCharacters?: unknown; retriggerCharacters?: unknown })
        : { triggerCharacters: rest };
    return registerLanguageProvider('signatureHelp', selector, provider, {
      triggerCharacters: normalizeTriggerCharacters(metadata.triggerCharacters),
      retriggerCharacters: normalizeTriggerCharacters(metadata.retriggerCharacters),
    });
  },

  registerDefinitionProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('definition', selector, provider),

  registerTypeDefinitionProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('typeDefinition', selector, provider),

  registerImplementationProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('implementation', selector, provider),

  registerDeclarationProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('declaration', selector, provider),

  registerReferenceProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('reference', selector, provider),
  registerRenameProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('rename', selector, provider),

  registerDocumentSymbolProvider: (
    selector: unknown,
    provider: unknown,
    metadata?: unknown,
  ): Disposable =>
    registerLanguageProvider('documentSymbol', selector, provider, {
      displayName: (metadata as { label?: string } | undefined)?.label,
    }),

  registerWorkspaceSymbolProvider: (provider: unknown): Disposable =>
    // No selector: workspace symbols are not scoped to a document, so the provider is registered
    // against everything and Main asks every one of them.
    registerLanguageProvider('workspaceSymbol', [{ scheme: '*' }], provider),

  registerDocumentFormattingEditProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('formatting', selector, provider),

  registerDocumentRangeFormattingEditProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('rangeFormatting', selector, provider),

  registerOnTypeFormattingEditProvider: (
    selector: unknown,
    provider: unknown,
    firstTriggerCharacter: string,
    ...moreTriggerCharacter: string[]
  ): Disposable =>
    registerLanguageProvider('onTypeFormatting', selector, provider, {
      firstTriggerCharacter,
      moreTriggerCharacter: normalizeTriggerCharacters(moreTriggerCharacter),
    }),

  registerCodeActionsProvider: (
    selector: unknown,
    provider: unknown,
    metadata?: unknown,
  ): Disposable => {
    const meta = (metadata ?? {}) as {
      providedCodeActionKinds?: unknown;
      documentation?: unknown;
    };
    return registerLanguageProvider('codeAction', selector, provider, {
      codeActionKinds: Array.isArray(meta.providedCodeActionKinds)
        ? meta.providedCodeActionKinds.map((kind) =>
            String((kind as { value?: string })?.value ?? kind),
          )
        : [],
      documentation: normalizeCodeActionDocumentation(meta.documentation),
    });
  },
  registerCodeLensProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('codeLens', selector, provider),

  registerColorProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('color', selector, provider),

  registerDocumentColorProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('color', selector, provider),

  registerDocumentHighlightProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('documentHighlight', selector, provider),

  registerDocumentLinkProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('documentLink', selector, provider),

  registerSelectionRangeProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('selectionRange', selector, provider),

  registerFoldingRangeProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('foldingRange', selector, provider),

  registerLinkedEditingRangeProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('linkedEditingRange', selector, provider),

  registerInlayHintsProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('inlayHint', selector, provider),

  registerInlineValuesProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('inlineValue', selector, provider),

  registerTypeHierarchyProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('typeHierarchy', selector, provider),

  registerCallHierarchyProvider: (selector: unknown, provider: unknown): Disposable =>
    registerLanguageProvider('callHierarchy', selector, provider),

  /**
   * The legend is required, and it is validated here rather than at first use.
   *
   * A provider registered with a malformed legend would emit token types that resolve to nothing, and
   * the failure would surface as "this file is not coloured" hours later; refusing the registration
   * puts the error in the extension's own log at the moment it made the mistake.
   */
  registerDocumentSemanticTokensProvider: (
    selector: unknown,
    provider: unknown,
    legend: unknown,
  ): Disposable =>
    registerLanguageProvider('semanticTokens', selector, provider, {
      legend: requireSemanticTokensLegend(legend),
    }),
  /** Upstream's older name for the same registration, still used by shipped extensions. */
  registerSemanticTokensProvider: (
    selector: unknown,
    provider: unknown,
    legend: unknown,
  ): Disposable =>
    registerLanguageProvider('semanticTokens', selector, provider, {
      legend: requireSemanticTokensLegend(legend),
    }),

  registerDocumentRangeSemanticTokensProvider: (
    selector: unknown,
    provider: unknown,
    legend: unknown,
  ): Disposable =>
    registerLanguageProvider('semanticTokensRange', selector, provider, {
      legend: requireSemanticTokensLegend(legend),
    }),
});

const envNamespace = strictNamespace('env', {
  appName: 'AXIOM',
  appHost: 'desktop',
  appRoot: '',
  uriScheme: 'axiom',
  language: 'en',
  uiKind: UIKind.Desktop,
  isNewAppInstall: false,
  isTelemetryEnabled: false,
  onDidChangeTelemetryEnabled: new EventEmitter<boolean>().event,
  remoteName: undefined,
  shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  get machineId(): string {
    return 'axiom-local';
  },
  get sessionId(): string {
    return `axiom-${process.pid}`;
  },
  clipboard: {
    readText: (): Promise<string> => request('env.clipboardRead'),
    writeText: async (text: string): Promise<void> => {
      await request('env.clipboardWrite', { text });
    },
  },
  openExternal: async (target: Uri | string): Promise<boolean> => {
    const url = typeof target === 'string' ? target : target.toString();
    return request<boolean>('env.openExternal', { url });
  },
  asExternalUri: async (uri: Uri): Promise<Uri> =>
    Uri.parse(await request<string>('env.asExternalUri', { uri: uri.toString() })),
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
/**
 * `vscode.authentication`.
 *
 * A session is data, not an object with behaviour, so what crosses the port is what upstream's
 * `AuthenticationSession` declares and nothing more. The interesting half is the other
 * direction: an extension that *provides* authentication keeps its provider object here, and
 * Main calls into it with a `provider` message when some other extension asks for a session.
 */
interface WorkerAuthProvider {
  getSessions?: (scopes?: readonly string[]) => unknown;
  createSession?: (scopes: readonly string[]) => unknown;
  removeSession?: (sessionId: string) => unknown;
  onDidChangeSessions?: (listener: (event: unknown) => void) => { dispose?: () => void };
}

const authProviders = new Map<string, { label: string; provider: WorkerAuthProvider }>();
const sessionsChangedEmitter = new EventEmitter<{ provider: { id: string; label: string } }>();

const authenticationNamespace = strictNamespace('authentication', {
  onDidChangeSessions: sessionsChangedEmitter.event,
  getSession: async (
    providerId: string,
    scopes: readonly string[],
    options?: {
      createIfNone?: boolean;
      clearSessionPreference?: boolean;
      forceNewSession?: boolean | { detail?: string };
      silent?: boolean;
    },
  ): Promise<unknown> => {
    const session = await request<unknown>('authentication.getSession', {
      providerId,
      scopes: Array.isArray(scopes) ? scopes : [],
      createIfNone: options?.createIfNone === true,
      clearSessionPreference: options?.clearSessionPreference === true,
      forceNewSession: options?.forceNewSession !== undefined && options.forceNewSession !== false,
      silent: options?.silent === true,
    });
    return session === null ? undefined : session;
  },
  getAccounts: (providerId: string): Promise<unknown[]> =>
    request<unknown[]>('authentication.getAccounts', { providerId }),
  registerAuthenticationProvider: (
    id: string,
    label: string,
    provider: WorkerAuthProvider,
    options?: { supportsMultipleAccounts?: boolean },
  ): Disposable => {
    authProviders.set(id, { label, provider });
    void request('authentication.registerProvider', {
      providerId: id,
      label,
      supportsMultipleAccounts: options?.supportsMultipleAccounts === true,
    }).catch((error: unknown) => {
      authProviders.delete(id);
      log('warn', `registerAuthenticationProvider(${id}) was refused: ${errorMessage(error)}`);
    });
    // A provider announcing its own change is how a sign-out in one extension reaches every
    // other extension holding a session from it.
    let subscription: { dispose?: () => void } | undefined;
    try {
      subscription = provider.onDidChangeSessions?.(() => {
        void request('authentication.sessionsChanged', { providerId: id }).catch(() => undefined);
      });
    } catch (error) {
      log('warn', `A provider's onDidChangeSessions threw: ${errorMessage(error)}`);
    }
    return new Disposable(() => {
      authProviders.delete(id);
      try {
        subscription?.dispose?.();
      } catch {
        // A provider that throws while unsubscribing must not block disposal.
      }
      void request('authentication.unregisterProvider', { providerId: id }).catch(() => undefined);
    });
  },
});

/** Answer one `provider` call from Main, on behalf of a provider this extension registered. */
async function handleProviderCall(message: {
  id: number;
  providerId: string;
  op: 'getSessions' | 'createSession' | 'removeSession';
  scopes: string[];
  sessionId: string | null;
}): Promise<void> {
  const entry = authProviders.get(message.providerId);
  if (entry === undefined) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: `This extension does not provide ${message.providerId}.`,
    });
    return;
  }
  try {
    let value: unknown = null;
    if (message.op === 'getSessions') {
      value = await entry.provider.getSessions?.(
        message.scopes.length > 0 ? message.scopes : undefined,
      );
    } else if (message.op === 'createSession') {
      value = await entry.provider.createSession?.(message.scopes);
    } else {
      await entry.provider.removeSession?.(message.sessionId ?? '');
    }
    // Sessions are plain data in every real provider; a round trip through JSON both proves that
    // and strips anything that would not survive the port.
    let serializable: unknown = null;
    try {
      serializable = JSON.parse(JSON.stringify(value ?? null));
    } catch {
      serializable = null;
    }
    send({ t: 'result', id: message.id, ok: true, value: serializable });
  } catch (error) {
    send({ t: 'result', id: message.id, ok: false, error: errorMessage(error) });
  }
}

/** Fired when one of this extension's own secrets changed. */
const secretChangeEmitter = new EventEmitter<{ key: string }>();

const extensionsNamespace = strictNamespace('extensions', {
  getExtension: (id: string): unknown => {
    const current = context;
    if (current === null || current.extensionId.toLowerCase() !== id.toLowerCase())
      return undefined;
    return {
      id: current.extensionId,
      extensionPath: current.extensionPath,
      extensionUri: Uri.file(current.extensionPath),
      isActive: true,
      packageJSON: { name: current.extensionId, version: current.version_ },
      extensionKind: ExtensionKind.Workspace,
      exports: extensionExports,
      activate: async (): Promise<unknown> => extensionExports,
    };
  },
  get all(): unknown[] {
    const current = extensionsNamespace.getExtension(context?.extensionId ?? '');
    return current === undefined ? [] : [current];
  },
  onDidChange: new EventEmitter<void>().event,
});

let extensionExports: unknown = undefined;

// ---------------------------------------------------------------------------
// The module extensions import
// ---------------------------------------------------------------------------
const vscodeApi = {
  version: HOST_VSCODE_VERSION,
  commands: commandsNamespace,
  window: windowNamespace,
  workspace: workspaceNamespace,
  languages: languagesNamespace,
  tasks: tasksNamespace,
  debug: debugNamespace,
  env: envNamespace,
  extensions: extensionsNamespace,
  authentication: authenticationNamespace,
  Uri,
  Position,
  Range,
  Selection,
  Location,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  DiagnosticTag,
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  RelativePattern,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  StatusBarAlignment,
  ConfigurationTarget,
  ExtensionMode,
  ExtensionKind,
  ViewColumn,
  FileType,
  QuickPickItemKind,
  ProgressLocation,
  UIKind,
  LogLevel,
  EndOfLine,
  TextEditorRevealType,
  CompletionItemKind,
  CompletionItemTag,
  CompletionTriggerKind,
  CompletionItem,
  CompletionList,
  SnippetString,
  TextEdit,
  SnippetTextEdit,
  WorkspaceEdit,
  Hover,
  SignatureHelp,
  SignatureHelpTriggerKind,
  SignatureInformation,
  ParameterInformation,
  SymbolKind,
  SymbolTag,
  SymbolInformation,
  DocumentSymbol,
  CodeAction,
  CodeActionKind,
  CodeActionTriggerKind,
  CodeLens,
  DocumentLink,
  Color,
  ColorInformation,
  ColorPresentation,
  DocumentHighlight,
  DocumentHighlightKind,
  SelectionRange,
  FoldingRange,
  FoldingRangeKind,
  InlayHint,
  InlayHintKind,
  InlayHintLabelPart,
  InlineValueText,
  InlineValueVariableLookup,
  InlineValueEvaluatableExpression,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  TypeHierarchyItem,
  LinkedEditingRanges,
  SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensEdit,
  SemanticTokensEdits,
  SemanticTokensLegend,
  TextDocumentChangeReason,
  TextDocumentSaveReason,
  // PRD Phase 7 §1 — terminals.
  TerminalLocation,
  TerminalExitReason,
  TerminalProfile,
  EnvironmentVariableMutatorType,
  // PRD Phase 7 §2 — tasks.
  Task,
  TaskGroup,
  TaskScope,
  TaskRevealKind,
  TaskPanelKind,
  ProcessExecution,
  ShellExecution,
  CustomExecution,
  ShellQuoting,
  // PRD Phase 7 §3 — debugging.
  DebugAdapterExecutable,
  DebugAdapterServer,
  DebugAdapterNamedPipeServer,
  DebugAdapterInlineImplementation,
  DebugConsoleMode,
  DebugConfigurationProviderTriggerKind,
  // PRD Phase 7 §4 — file system watching.
  FileChangeType,
};

/**
 * Make `require('vscode')` resolve to the shim.
 *
 * Patching the loader is how VS Code does it too, and it is the only approach that works for
 * every packaging style extensions ship in — bundled, transpiled, or plain CommonJS — because
 * all of them end up at a `require('vscode')` call. Only that one specifier is intercepted;
 * an extension's own dependencies resolve normally from its own directory.
 */
function installVsCodeModule(): void {
  const moduleApi = createRequire(__filename)('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = moduleApi._load;
  moduleApi._load = (specifier: string, parent: unknown, isMain: boolean): unknown =>
    specifier === 'vscode' ? vscodeApi : original.call(moduleApi, specifier, parent, isMain);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let extensionModule: { activate?: unknown; deactivate?: unknown } | null = null;

function loadExtension(init: HostInit): void {
  const entry = resolve(init.mainFile);
  const root = resolve(init.extensionPath);
  const rel = relative(root, entry);
  if (!isAbsolute(entry) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('The extension entry point is outside its own directory.');
  }
  const load = createRequire(join(root, 'package.json'));
  extensionModule = load(entry) as { activate?: unknown; deactivate?: unknown };
}

async function activate(reason: string): Promise<void> {
  const init = requireContext();
  const started = Date.now();
  try {
    loadExtension(init);
  } catch (error) {
    send({
      t: 'failed',
      phase: 'load',
      message: errorMessage(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    return;
  }
  const activateFn = extensionModule?.activate;
  const extensionContext = {
    subscriptions: [] as Array<{ dispose: () => unknown }>,
    extensionPath: init.extensionPath,
    extensionUri: Uri.file(init.extensionPath),
    extensionMode: ExtensionMode.Production,
    globalState: memento('global'),
    workspaceState: memento('workspace'),
    storageUri: Uri.file(init.workspaceStoragePath),
    storagePath: init.workspaceStoragePath,
    globalStorageUri: Uri.file(init.globalStoragePath),
    globalStoragePath: init.globalStoragePath,
    logUri: Uri.file(init.logPath),
    logPath: init.logPath,
    asAbsolutePath: (relativePath: string): string => join(init.extensionPath, relativePath),
    // PRD Phase 7 §1: real, and persisted by Main. `getScoped` returns the collection for one
    // workspace folder; the object itself is the global one, exactly as upstream.
    environmentVariableCollection: globalEnvironmentCollection,
    // Real, and scoped to this extension: Main keys every secret by extension id, so one
    // extension can neither read nor overwrite another's token. Values are encrypted at rest
    // by the OS keychain; AXIOM's own credential store stays out of reach either way.
    secrets: {
      get: async (key: string): Promise<string | undefined> => {
        const value = await request<string | null>('secrets.get', { key });
        return value === null ? undefined : value;
      },
      store: async (key: string, value: string): Promise<void> => {
        await request<null>('secrets.store', { key, value });
      },
      delete: async (key: string): Promise<void> => {
        await request<null>('secrets.delete', { key });
      },
      onDidChange: secretChangeEmitter.event,
    },
    extension: extensionsNamespace.getExtension(init.extensionId),
    languageModelAccessInformation: {
      onDidChange: new EventEmitter<void>().event,
      canSendRequest: (): undefined => undefined,
    },
  };

  if (typeof activateFn !== 'function') {
    // A declarative-only extension with a main file that exports nothing is not an error;
    // it simply has no code to run.
    send({ t: 'activated', commands: [...commands.keys()], ms: Date.now() - started });
    return;
  }

  try {
    extensionExports = await (activateFn as (c: unknown) => unknown)(extensionContext);
    send({
      t: 'activated',
      commands: [...commands.keys()].slice(0, MAX_HOST_COMMANDS),
      ms: Date.now() - started,
    });
    log('info', `activated in ${Date.now() - started}ms (${reason})`);
  } catch (error) {
    send({
      t: 'failed',
      phase: 'activate',
      message: errorMessage(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
  }
}

async function deactivate(): Promise<void> {
  const deactivateFn = extensionModule?.deactivate;
  if (typeof deactivateFn === 'function') {
    try {
      await (deactivateFn as () => unknown)();
    } catch (error) {
      log('warn', `deactivate threw: ${errorMessage(error)}`);
    }
  }
  // Main tears the worker down after this reply, so no `debugAdapterStop` is coming for an adapter that
  // is still serving a session. Disposing here is the last moment an extension's own `dispose` can run
  // (PRD Phase 7 §6), and it is a no-op for an extension that served none.
  for (const sessionId of [...inlineDebugAdapters.keys()]) dropInlineAdapter(sessionId);
  send({ t: 'deactivated' });
}

async function invoke(id: number, command: string, args: unknown[]): Promise<void> {
  const handler = commands.get(command);
  if (!handler) {
    send({ t: 'result', id, ok: false, error: `${command} is not registered.` });
    return;
  }
  try {
    const value = await handler(...args);
    // Only structured-cloneable values can cross the port, and a command's return value is
    // usually ignored. Anything that will not serialize is reported as undefined rather than
    // failing a command that in fact succeeded.
    let serializable: unknown = undefined;
    try {
      serializable = JSON.parse(JSON.stringify(value ?? null));
    } catch {
      serializable = undefined;
    }
    send({ t: 'result', id, ok: true, value: serializable });
  } catch (error) {
    send({ t: 'result', id, ok: false, error: errorMessage(error) });
  }
}

function handleMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as MainToWorker;
  switch (message.t) {
    case 'init': {
      context = message;
      configuration = message.configuration ?? {};
      for (const [key, value] of Object.entries(message.globalState ?? {})) {
        globalStateValues.set(key, value);
      }
      for (const [key, value] of Object.entries(message.workspaceState ?? {})) {
        workspaceStateValues.set(key, value);
      }
      installVsCodeModule();
      send({ t: 'ready', version: HOST_PROTOCOL_VERSION });
      return;
    }
    case 'activate':
      void activate(message.reason);
      return;
    case 'deactivate':
      void deactivate();
      return;
    case 'invoke':
      void invoke(message.id, message.command, message.args);
      return;
    case 'configuration': {
      const previous = configuration;
      configuration = message.configuration ?? {};
      configurationEmitter.fire({
        affectsConfiguration: (section: string) =>
          Object.keys({ ...previous, ...configuration }).some(
            (key) => key === section || key.startsWith(`${section}.`),
          ),
      });
      return;
    }
    case 'editor': {
      const changed = message.editor?.path !== activeEditorSnapshot?.path;
      activeEditorSnapshot = message.editor;
      if (changed) activeEditorEmitter.fire(windowNamespace.activeTextEditor);
      return;
    }
    case 'reply': {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      return;
    }
    case 'uri': {
      // Deep link, usually the tail end of this extension's own OAuth round trip. An extension
      // that never registered a handler gets nothing rather than an error: the URI was already
      // accepted by Main, and there is no one here to tell.
      const handler = uriHandler;
      if (handler === null) return;
      try {
        void handler.handleUri(Uri.parse(message.uri));
      } catch (error) {
        log('warn', `A URI handler threw: ${errorMessage(error)}`);
      }
      return;
    }
    case 'secretChanged':
      secretChangeEmitter.fire({ key: message.key });
      return;
    case 'sessionsChanged': {
      const entry = authProviders.get(message.providerId);
      sessionsChangedEmitter.fire({
        provider: { id: message.providerId, label: entry?.label ?? message.providerId },
      });
      return;
    }
    case 'provider':
      void handleProviderCall(message);
      return;
    case 'webviewMessage':
      deliverWebviewMessage(message.handle, message.payload);
      return;
    case 'webviewState':
      recordWebviewState(message.handle, message.state);
      return;
    case 'webviewVisibility':
      applyWebviewVisibility(message.handle, message.visible, message.active);
      return;
    case 'webviewDispose':
      finishWebview(message.handle);
      return;
    case 'webviewResolveView':
      void resolveWebviewViewRequest(message);
      return;
    case 'webviewRestorePanel':
      void restoreWebviewPanelRequest(message);
      return;
    case 'treeGetChildren':
      void treeChildrenRequest(message);
      return;
    case 'treeResolveItem':
      void treeResolveRequest(message);
      return;
    case 'treeExpansion':
    case 'treeSelection':
    case 'treeVisibility':
    case 'treeCheckbox':
      deliverTreeEvent(message);
      return;
    case 'languageProvide':
      void dispatchLanguageProvide(message);
      return;
    case 'languageCancel':
      cancelLanguageProvide(message.id);
      return;
    case 'documentOpen':
      applyDocumentOpen(message);
      return;
    case 'documentChange':
      applyDocumentChange(message);
      return;
    case 'documentReplace':
      applyDocumentReplace(message);
      return;
    case 'documentSave':
      applyDocumentSave(message.uri);
      return;
    case 'documentClose':
      applyDocumentClose(message.uri);
      return;
    case 'documentLanguage':
      applyDocumentLanguage(message.uri, message.languageId);
      return;
    // -----------------------------------------------------------------------
    // PRD Phase 7 §1 — terminals. Every one of these is addressed by Main's handle.
    // -----------------------------------------------------------------------
    case 'terminalOpened':
      terminalsByHandle.get(message.handle)?._opened(message.processId);
      return;
    case 'terminalClosed':
      terminalsByHandle.get(message.handle)?._closed(message.exitCode);
      return;
    case 'terminalState':
      terminalsByHandle
        .get(message.handle)
        ?._applyState(message.isInteractedWith, message.shellIntegration);
      return;
    case 'terminalActive':
      applyActiveTerminal(message.handle);
      return;
    case 'terminalInput':
      terminalsByHandle.get(message.handle)?._handleInput(message.data);
      return;
    case 'terminalDimensions':
      terminalsByHandle.get(message.handle)?._setDimensions(message.columns, message.rows);
      return;
    case 'terminalOpenPty':
      terminalsByHandle.get(message.handle)?._openPty(message.columns, message.rows);
      return;
    case 'terminalClosePty':
      terminalsByHandle.get(message.handle)?._closePty();
      return;
    case 'terminalProvideProfile':
      void provideTerminalProfile(message.id, message.profileId);
      return;
    // -----------------------------------------------------------------------
    // PRD Phase 7 §2 — tasks. Providers are addressed by this worker's own token.
    // -----------------------------------------------------------------------
    case 'taskProvide':
      void dispatchTaskProvide(message.id, message.providerToken);
      return;
    case 'taskResolve':
      void dispatchTaskResolve(message.id, message.providerToken, message.task);
      return;
    case 'taskEvent':
      applyTaskEvent(message);
      return;
    case 'taskCustomStart':
      void startCustomTask(message.id, message.executionId, message.task);
      return;
    case 'taskCustomCancel':
      cancelCustomTask(message.executionId);
      return;
    // -----------------------------------------------------------------------
    // PRD Phase 7 §3 — debugging. Sessions are addressed by the id Main minted for them.
    // -----------------------------------------------------------------------
    case 'debugResolveConfiguration':
      void dispatchDebugConfiguration(message);
      return;
    case 'debugCreateAdapter':
      void dispatchDebugAdapter(message);
      return;
    case 'debugAdapterMessage':
      deliverInlineAdapterMessage(message.sessionId, message.message);
      return;
    case 'debugAdapterStop':
      dropInlineAdapter(message.sessionId);
      return;
    case 'debugSessionStarted':
      applyDebugSessionStarted(message);
      return;
    case 'debugSessionTerminated':
      applyDebugSessionTerminated(message.sessionId);
      return;
    case 'debugActiveSession':
      applyDebugActiveSession(message.sessionId);
      return;
    case 'debugCustomEvent':
      applyDebugCustomEvent(message);
      return;
    // -----------------------------------------------------------------------
    // PRD Phase 7 §4/§5 — watchers and workspace file operations.
    // -----------------------------------------------------------------------
    case 'watcherEvent':
      applyWatcherEvent(message.token, message.kind, message.path);
      return;
    case 'fileOperation':
      applyFileOperation(message);
      return;
    default:
      return;
  }
}

process.on('uncaughtException', (error) => {
  // Reported before the process dies so the supervisor can attribute the crash to this
  // extension rather than recording an anonymous exit code.
  send({
    t: 'failed',
    phase: 'activate',
    message: errorMessage(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('warn', `unhandled rejection: ${errorMessage(reason)}`);
});

if (parentPort) {
  parentPort.on('message', (event) => handleMessage(event.data));
  parentPort.start();
}
