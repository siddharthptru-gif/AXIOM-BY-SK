import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcessTree } from './processTree';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { buildChildProcessEnvironment } from './processEnvironment';
import { resolveExecutable } from './executables';
import { rootLogger } from '@axiom/shared';
import { serversForLanguage, type LspServerDefinition } from '../../common/lspServers';
import type {
  LspCodeAction,
  LspCommand,
  LspCompletionContext,
  LspCompletionItem,
  LspCompletionResult,
  LspContentChange,
  LspDiagnostic,
  LspDiagnosticRelated,
  LspDiagnosticsEvent,
  LspDidChangeInput,
  LspDidOpenInput,
  LspDocumentHighlight,
  LspDocumentHighlightResult,
  LspDocumentLink,
  LspDocumentSymbol,
  LspFoldingRange,
  LspHoverResult,
  LspInlayHint,
  LspLocation,
  LspLocationResult,
  LspLogEvent,
  LspPrepareRenameResult,
  LspRange,
  LspSemanticTokens,
  LspSemanticTokensLegend,
  LspServerStatus,
  LspSignature,
  LspSignatureHelp,
  LspSignatureParam,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from '../../common/ipc';

/**
 * LSP client (PRD Part VII §107 / Epoch D Phases 89–91, extended for the
 * IDE-grade code intelligence layer).
 *
 * Speaks LSP over Content-Length framed JSON-RPC on stdio to language servers
 * running as child processes of Main. Bundled servers are launched with AXIOM's
 * own Node so they work packaged and offline; external servers are detected on
 * the user's PATH and light their language up when present (see
 * common/lspServers.ts for the registry).
 *
 * What this layer guarantees:
 *   • Capabilities are NEGOTIATED, not assumed. The `initialize` result is read
 *     and every optional request is gated on the server actually advertising it,
 *     including `positionEncoding` (UTF-16 vs UTF-8 offsets).
 *   • Document sync is INCREMENTAL when the server supports it, with Main
 *     holding the authoritative text so a crashed server can be re-seeded.
 *   • Requests are CANCELLABLE (`$/cancelRequest`), not merely timed out.
 *   • A crashed server RESTARTS with bounded exponential backoff, reopens its
 *     documents, and reports its state to the renderer.
 *   • Several servers can serve one document at once (tsserver + ESLint +
 *     Tailwind on the same .tsx file); results are merged and diagnostics stay
 *     attributed per server so they never clobber each other.
 *
 * Degrades quietly (no-ops) when a server is unavailable so the editor is never
 * blocked (INV-1).
 */
const log = rootLogger.child('lsp');
const REQUEST_TIMEOUT_MS = 15_000;
/** Long-running project-wide requests (workspace symbol, first index) get more. */
const SLOW_REQUEST_TIMEOUT_MS = 60_000;
const MAX_LSP_HEADER_BYTES = 16 * 1024;
const MAX_LSP_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LSP_BUFFER_BYTES = MAX_LSP_HEADER_BYTES + MAX_LSP_BODY_BYTES;
/** Crash restarts allowed before a server is declared failed for the session. */
const MAX_RESTARTS = 4;
const RESTART_BASE_DELAY_MS = 750;
/** Uptime after which a server is considered healthy and its crash count resets. */
const HEALTHY_UPTIME_MS = 60_000;
/** Cap on retained resolve handles per server, so a long session cannot grow. */
const MAX_RESOLVE_HANDLES = 2_048;
const MAX_COMPLETION_ITEMS = 1_000;

/** Position encodings a server may select (LSP 3.17 `general.positionEncoding`). */
type PositionEncoding = 'utf-16' | 'utf-8' | 'utf-32';

interface LspMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Renderer-scoped cancellation key, when the caller supplied one. */
  cancelKey?: string;
}

/** What the server told us it can do. Everything optional is gated on this. */
interface Negotiated {
  positionEncoding: PositionEncoding;
  /** 0 none, 1 full, 2 incremental. */
  syncKind: 0 | 1 | 2;
  openClose: boolean;
  hover: boolean;
  completion: boolean;
  completionResolve: boolean;
  completionTriggers: string[];
  signatureHelp: boolean;
  signatureTriggers: string[];
  signatureRetriggers: string[];
  definition: boolean;
  declaration: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  documentHighlight: boolean;
  documentSymbol: boolean;
  codeAction: boolean;
  codeActionResolve: boolean;
  codeActionKinds: string[];
  documentLink: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  onTypeFormatting: { first: string; more: string[] } | null;
  rename: boolean;
  prepareRename: boolean;
  foldingRange: boolean;
  selectionRange: boolean;
  inlayHint: boolean;
  semanticTokens: {
    legend: LspSemanticTokensLegend;
    full: boolean;
    delta: boolean;
    range: boolean;
  } | null;
  pullDiagnostics: boolean;
  workspaceSymbol: boolean;
  executeCommands: string[];
}

function emptyNegotiated(): Negotiated {
  return {
    positionEncoding: 'utf-16',
    syncKind: 1,
    openClose: true,
    hover: false,
    completion: false,
    completionResolve: false,
    completionTriggers: [],
    signatureHelp: false,
    signatureTriggers: [],
    signatureRetriggers: [],
    definition: false,
    declaration: false,
    typeDefinition: false,
    implementation: false,
    references: false,
    documentHighlight: false,
    documentSymbol: false,
    codeAction: false,
    codeActionResolve: false,
    codeActionKinds: [],
    documentLink: false,
    formatting: false,
    rangeFormatting: false,
    onTypeFormatting: null,
    rename: false,
    prepareRename: false,
    foldingRange: false,
    selectionRange: false,
    inlayHint: false,
    semanticTokens: null,
    pullDiagnostics: false,
    workspaceSymbol: false,
    executeCommands: [],
  };
}

/** Main's authoritative copy of one synced document. */
interface TrackedDoc {
  languageId: string;
  version: number;
  text: string;
  /** Last `textDocument/diagnostic` result id, for pull-diagnostics deltas. */
  diagnosticResultId?: string;
  /** Last semantic-tokens result id, for delta requests. */
  semanticResultId?: string;
}

/** Reassembles bounded Content-Length framed LSP messages from a byte stream. */
class LspFramer {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private failed = false;

  constructor(
    private readonly onMessage: (msg: LspMessage) => void,
    private readonly onProtocolError: (error: Error) => void,
  ) {}

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
    this.onProtocolError(new Error(message));
  }

  append(chunk: Buffer): void {
    if (this.failed) return;
    if (chunk.byteLength > MAX_LSP_BUFFER_BYTES - this.buffer.byteLength) {
      this.fail('LSP frame exceeded the aggregate buffer limit.');
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (this.buffer.byteLength > MAX_LSP_HEADER_BYTES) {
            this.fail('LSP frame header exceeded the size limit.');
          }
          return;
        }
        if (headerEnd > MAX_LSP_HEADER_BYTES) {
          this.fail('LSP frame header exceeded the size limit.');
          return;
        }
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        if (lengths.length !== 1 || !lengths[0]?.[1]) {
          this.fail('LSP frame did not contain one valid Content-Length header.');
          return;
        }
        const contentLength = Number.parseInt(lengths[0][1], 10);
        if (
          !Number.isSafeInteger(contentLength) ||
          contentLength <= 0 ||
          contentLength > MAX_LSP_BODY_BYTES
        ) {
          this.fail('LSP frame body exceeded the size limit.');
          return;
        }
        this.contentLength = contentLength;
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }
      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength).toString('utf8');
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      try {
        this.onMessage(JSON.parse(body) as LspMessage);
      } catch {
        this.fail('LSP frame contained malformed JSON.');
        return;
      }
    }
  }
}

/**
 * Resolved external language servers, cached per launch so starting a server does
 * not re-probe the machine. Resolution itself lives in `executables.ts`, which asks
 * the OS resolver as well as scanning PATH — a PATH-only scan misses Windows app
 * execution aliases, which is how an installed tool gets reported as absent.
 */
const externalServerPaths = new Map<string, string | null>();

async function resolveExternalServer(
  commands: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const key = commands.join('\u0000');
  const cached = externalServerPaths.get(key);
  if (cached !== undefined) return cached;
  const resolved = await resolveExecutable(commands, ['--version'], env).catch(() => null);
  const path = resolved?.path ?? null;
  externalServerPaths.set(key, path);
  return path;
}

/**
 * A Windows `.cmd`/`.bat` shim cannot be executed by CreateProcess directly, so
 * npm-installed servers must go through the command interpreter. Building a
 * command line means string concatenation, so both the resolved path and every
 * argument are validated against a strict allowlist first: anything that could
 * introduce a second command is refused outright rather than escaped. All
 * arguments originate from AXIOM's own server registry, never from the renderer.
 */
const SAFE_SHIM_PATH = /^[A-Za-z]:\\[^"&|<>^\r\n%]*$/;
const SAFE_SHIM_ARG = /^[A-Za-z0-9._\-=/:]+$/;

function windowsShimCommandLine(executable: string, args: string[]): string | null {
  if (!SAFE_SHIM_PATH.test(executable)) return null;
  if (!args.every((arg) => SAFE_SHIM_ARG.test(arg))) return null;
  const parts = [`"${executable}"`, ...args];
  return `"${parts.join(' ')}"`;
}

class LspServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private framer: LspFramer | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Renderer cancellation key → in-flight JSON-RPC ids. */
  private readonly cancelKeys = new Map<string, Set<number>>();
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private disposed = false;
  private readonly docs = new Map<string, TrackedDoc>();
  private negotiated: Negotiated = emptyNegotiated();
  private diagnosticsHandler: ((evt: LspDiagnosticsEvent) => void) | null = null;
  private statusHandler: ((status: LspServerStatus) => void) | null = null;
  private logHandler: ((evt: LspLogEvent) => void) | null = null;
  private applyEditHandler: ((root: string, edit: LspWorkspaceEdit) => Promise<boolean>) | null =
    null;
  private state: LspServerStatus['state'] = 'stopped';
  private restarts = 0;
  private failureDetail: string | undefined;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unresolved completion items, keyed by the handle handed to the renderer. */
  private readonly completionHandles = new Map<number, unknown>();
  private readonly codeActionHandles = new Map<number, unknown>();
  private nextHandle = 1;

  constructor(
    private readonly config: LspServerDefinition,
    readonly rootPath: string,
  ) {}

  get id(): string {
    return this.config.id;
  }

  get capabilities(): Negotiated {
    return this.negotiated;
  }

  get isRunning(): boolean {
    return this.initialized;
  }

  setHandlers(handlers: {
    diagnostics?: (evt: LspDiagnosticsEvent) => void;
    status?: (status: LspServerStatus) => void;
    log?: (evt: LspLogEvent) => void;
    applyEdit?: (root: string, edit: LspWorkspaceEdit) => Promise<boolean>;
  }): void {
    if (handlers.diagnostics) this.diagnosticsHandler = handlers.diagnostics;
    if (handlers.status) this.statusHandler = handlers.status;
    if (handlers.log) this.logHandler = handlers.log;
    if (handlers.applyEdit) this.applyEditHandler = handlers.applyEdit;
  }

  status(): LspServerStatus {
    const status: LspServerStatus = {
      id: this.config.id,
      displayName: this.config.displayName,
      languageIds: [...this.config.languageIds],
      state: this.state,
      restarts: this.restarts,
      external: this.config.launch.kind === 'external',
    };
    if (this.failureDetail !== undefined) status.detail = this.failureDetail;
    return status;
  }

  private setState(state: LspServerStatus['state'], detail?: string): void {
    if (this.state === state && this.failureDetail === detail) return;
    this.state = state;
    this.failureDetail = detail;
    this.statusHandler?.(this.status());
  }

  /** Resolve a bundled server's Node entry point inside AXIOM's node_modules. */
  private resolveCli(cliPath: string[]): string | null {
    const roots = [join(app.getAppPath(), '..', '..'), app.getAppPath()];
    if (!app.isPackaged) roots.push(process.cwd());
    for (const r of roots) {
      const p = join(r, 'node_modules', ...cliPath);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /** True when the workspace has one of this server's required root markers. */
  private rootMarkersPresent(): boolean {
    const markers = this.config.rootMarkers;
    if (!markers || markers.length === 0) return true;
    return markers.some((marker) => existsSync(join(this.rootPath, marker)));
  }

  private async ensure(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.initialized) return true;
    if (this.state === 'failed') return false;
    if (!this.initializing) {
      this.initializing = this.start().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
    return this.initialized;
  }

  /** Build the spawn arguments for either launch kind, or null when unavailable. */
  private async resolveLaunch(
    env: NodeJS.ProcessEnv,
  ): Promise<{ command: string; args: string[]; verbatim: boolean } | null> {
    const launch = this.config.launch;
    if (launch.kind === 'bundled') {
      const cli = this.resolveCli(launch.cliPath);
      if (!cli) return null;
      // Bundled servers are Node programs; run them on AXIOM's own runtime so no
      // system Node install is required and the packaged app stays self-contained.
      return { command: process.execPath, args: [cli, ...launch.args], verbatim: false };
    }
    const executable = await resolveExternalServer(launch.commands, env);
    if (!executable) return null;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
      const commandLine = windowsShimCommandLine(executable, launch.args);
      const comspec = env.ComSpec ?? env.COMSPEC;
      if (!commandLine || !comspec) return null;
      return { command: comspec, args: ['/d', '/s', '/c', commandLine], verbatim: true };
    }
    return { command: executable, args: [...launch.args], verbatim: false };
  }

  private async start(): Promise<void> {
    if (!this.rootMarkersPresent()) {
      this.setState('stopped');
      return;
    }
    const env: NodeJS.ProcessEnv = {
      ...buildChildProcessEnvironment({ color: false }),
      ELECTRON_RUN_AS_NODE: '1',
    };
    const launch = await this.resolveLaunch(env);
    if (!launch) {
      const detail =
        this.config.launch.kind === 'external'
          ? `Install ${this.config.launch.commands[0]} and make sure it is on your PATH to enable ${this.config.displayName} support.`
          : `${this.config.displayName} language server is missing from this build.`;
      log.info('language server unavailable', { id: this.config.id, detail });
      this.setState('failed', detail);
      return;
    }
    this.setState('starting');

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(launch.command, launch.args, {
        env,
        cwd: this.rootPath,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setState('failed', detail);
      return;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this.framer = new LspFramer(
      (msg) => this.onMessage(msg),
      (error) => {
        log.warn('terminating language server after protocol violation', {
          server: this.config.id,
          error: error.message,
        });
        void this.restartAfterFailure(`Protocol violation: ${error.message}`, proc);
      },
    );
    proc.stdout.on('data', (chunk: Buffer) => this.framer?.append(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      log.debug(`lsp[${this.config.id}]: ${text}`);
      this.logHandler?.({ serverId: this.config.id, type: 4, message: text });
    });
    proc.on('exit', (code) => {
      log.warn('language server exited', { id: this.config.id, code });
      void this.restartAfterFailure(`Language server exited (code ${code ?? 'unknown'}).`, proc);
    });
    proc.on('error', (error: Error) => {
      log.error('language server spawn error', { id: this.config.id, error: error.message });
      void this.restartAfterFailure(error.message, proc);
    });

    const rootUri = pathToFileURL(this.rootPath).toString();
    const initializeResult = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Axiom', version: app.getVersion() },
        locale: 'en',
        rootUri,
        rootPath: this.rootPath,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.config.initializationOptions ?? {},
      },
      { timeoutMs: SLOW_REQUEST_TIMEOUT_MS },
    ).catch((error: unknown) => {
      log.warn('language server initialize failed', {
        id: this.config.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (this.proc !== proc || this.disposed) return; // exited or replaced during init

    this.negotiated = readServerCapabilities(initializeResult);
    this.notify('initialized', {});
    this.initialized = true;
    this.setState('running');
    // Push settings so servers that never call workspace/configuration still see them.
    if (this.config.settings) {
      this.notify('workspace/didChangeConfiguration', { settings: this.config.settings });
    }
    log.info('language server initialized', {
      id: this.config.id,
      rootPath: this.rootPath,
      positionEncoding: this.negotiated.positionEncoding,
      syncKind: this.negotiated.syncKind,
    });
  }

  /**
   * Handle a crash: tear the transport down, then restart with exponential
   * backoff and reopen every document that was synced, so the user's next
   * keystroke finds a working server instead of silence.
   */
  private async restartAfterFailure(
    reason: string,
    source: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (this.disposed || this.proc !== source) return;
    const reopen = [...this.docs.entries()].map(([uri, doc]) => ({ uri, doc }));
    // A server that ran healthily for a while has "earned back" its restarts.
    if (this.initialized && Date.now() - this.startedAt > HEALTHY_UPTIME_MS) this.restarts = 0;
    this.teardown(new Error(reason));

    if (this.restarts >= MAX_RESTARTS) {
      const detail = `${this.config.displayName} stopped responding after ${MAX_RESTARTS} restarts. ${reason}`;
      log.error('language server permanently failed', { id: this.config.id, reason });
      this.setState('failed', detail);
      return;
    }
    const attempt = this.restarts;
    this.restarts += 1;
    const delay = RESTART_BASE_DELAY_MS * 2 ** attempt;
    this.setState('starting', `Restarting ${this.config.displayName}…`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      void (async () => {
        const ok = await this.ensure();
        if (!ok) return;
        for (const { uri, doc } of reopen) {
          await this.didOpen({
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.text,
            rootPath: this.rootPath,
          }).catch(() => undefined);
        }
      })().catch(() => undefined);
    }, delay);
  }

  private onMessage(msg: LspMessage): void {
    // Server → client request (has both method and id).
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      void this.answerServerRequest(msg.method, msg.id, msg.params);
      return;
    }
    if (typeof msg.method === 'string') {
      this.handleNotification(msg.method, msg.params);
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      this.untrackCancel(msg.id, pending);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  private async answerServerRequest(
    method: string,
    id: number | string,
    rawParams: unknown,
  ): Promise<void> {
    let result: unknown = null;
    if (method === 'workspace/configuration') {
      const params = rawParams as { items?: unknown[] } | undefined;
      const items = Array.isArray(params?.items) ? params.items : [];
      result = items.map((item) => this.configurationFor(item));
    } else if (method === 'workspace/applyEdit') {
      const params = rawParams as { edit?: unknown } | undefined;
      const edit = { changes: mapWorkspaceEdit(params?.edit) };
      const applied = this.applyEditHandler
        ? await this.applyEditHandler(this.rootPath, edit).catch(() => false)
        : false;
      result = { applied };
    } else if (method === 'window/workDoneProgress/create') {
      result = null;
    } else if (method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      result = null;
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToFileURL(this.rootPath).toString(), name: 'workspace' }];
    } else if (method === 'window/showMessageRequest') {
      // Never block a server on a modal AXIOM does not show; decline politely.
      result = null;
    }
    this.send({ jsonrpc: '2.0', id, result });
  }

  /** Resolve one `workspace/configuration` item against this server's settings. */
  private configurationFor(item: unknown): unknown {
    const settings = this.config.settings;
    if (!settings) return {};
    const section = (item as { section?: unknown } | undefined)?.section;
    if (typeof section !== 'string' || section.length === 0) return settings;
    let cursor: unknown = settings;
    for (const part of section.split('.')) {
      if (!cursor || typeof cursor !== 'object') return null;
      cursor = (cursor as Record<string, unknown>)[part];
      if (cursor === undefined) {
        // Servers commonly ask for their own top-level id; fall back to the root.
        return section === this.config.id ? settings : null;
      }
    }
    return cursor ?? null;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      this.handleDiagnostics(params);
      return;
    }
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const p = params as { type?: unknown; message?: unknown } | undefined;
      if (typeof p?.message !== 'string') return;
      const type = typeof p.type === 'number' ? p.type : 4;
      this.logHandler?.({ serverId: this.config.id, type, message: p.message });
      return;
    }
    if (method === '$/progress') {
      const p = params as { value?: unknown } | undefined;
      const value = p?.value as { kind?: unknown; title?: unknown; message?: unknown } | undefined;
      if (!value || typeof value.kind !== 'string') return;
      const parts = [value.title, value.message].filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );
      if (parts.length === 0) return;
      this.logHandler?.({
        serverId: this.config.id,
        type: 4,
        message: `${value.kind === 'end' ? 'done: ' : ''}${parts.join(' — ')}`,
      });
      return;
    }
    if (method === 'textDocument/publishSemanticTokens') return;
  }

  private handleDiagnostics(params: unknown): void {
    const p = params as { uri?: unknown; diagnostics?: unknown } | undefined;
    if (!p || typeof p.uri !== 'string' || !Array.isArray(p.diagnostics)) return;
    this.diagnosticsHandler?.({
      uri: p.uri,
      diagnostics: mapDiagnostics(
        p.diagnostics,
        this.negotiated.positionEncoding,
        this.docs.get(p.uri)?.text,
      ),
      serverId: this.config.id,
    });
  }

  private send(msg: LspMessage): void {
    const proc = this.proc;
    if (!proc) return;
    const json = JSON.stringify(msg);
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    try {
      proc.stdin.write(payload);
    } catch {
      /* pipe closed — teardown handles cleanup */
    }
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private trackCancel(id: number, cancelKey: string): void {
    const set = this.cancelKeys.get(cancelKey) ?? new Set<number>();
    set.add(id);
    this.cancelKeys.set(cancelKey, set);
  }

  private untrackCancel(id: number, pending: Pending): void {
    if (!pending.cancelKey) return;
    const set = this.cancelKeys.get(pending.cancelKey);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.cancelKeys.delete(pending.cancelKey);
  }

  /**
   * Abandon every in-flight request under a renderer cancellation key and tell
   * the server to stop working on it. This is what makes typing feel immediate:
   * a superseded completion is not merely ignored, the server stops computing it.
   */
  cancel(cancelKey: string): void {
    const ids = this.cancelKeys.get(cancelKey);
    if (!ids) return;
    this.cancelKeys.delete(cancelKey);
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error('LSP request cancelled'));
      }
      this.notify('$/cancelRequest', { id });
    }
  }

  private request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; cancelKey?: string } = {},
  ): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('LSP not running'));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.untrackCancel(id, pending);
        this.notify('$/cancelRequest', { id });
        reject(new Error('LSP request timed out'));
      }, timeoutMs);
      const pending: Pending = { resolve, reject, timer };
      if (options.cancelKey !== undefined) {
        pending.cancelKey = options.cancelKey;
        this.trackCancel(id, options.cancelKey);
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Run a request only when the server advertised support; else a null result. */
  private async ask(
    supported: boolean,
    method: string,
    params: unknown,
    options: { timeoutMs?: number; cancelKey?: string } = {},
  ): Promise<unknown> {
    if (!this.initialized || !supported) return null;
    return this.request(method, params, options).catch(() => null);
  }

  private teardown(error: Error): void {
    this.initialized = false;
    this.proc = null;
    this.framer = null;
    this.negotiated = emptyNegotiated();
    this.completionHandles.clear();
    this.codeActionHandles.clear();
    this.cancelKeys.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // Documents stay tracked: they are what a restart replays.
  }

  // ---- Position encoding ---------------------------------------------------

  /**
   * Convert a UTF-16 (Monaco) position to the encoding the server negotiated.
   * Identity for utf-16, which is what every server AXIOM bundles selects; the
   * conversion exists so a utf-8 server (clangd, rust-analyzer) is correct on
   * lines containing non-ASCII text instead of subtly off by a few columns.
   */
  private encodePosition(
    uri: string,
    line: number,
    character: number,
  ): { line: number; character: number } {
    const encoding = this.negotiated.positionEncoding;
    if (encoding === 'utf-16') return { line, character };
    const text = this.docs.get(uri)?.text;
    if (text === undefined) return { line, character };
    const lineText = lineAt(text, line);
    if (lineText === null) return { line, character };
    const slice = lineText.slice(0, character);
    const converted = encoding === 'utf-8' ? Buffer.byteLength(slice, 'utf8') : [...slice].length;
    return { line, character: converted };
  }

  private encodeRange(uri: string, range: LspRange): LspRange {
    if (this.negotiated.positionEncoding === 'utf-16') return range;
    return {
      start: this.encodePosition(uri, range.start.line, range.start.character),
      end: this.encodePosition(uri, range.end.line, range.end.character),
    };
  }

  private position(
    uri: string,
    line: number,
    character: number,
  ): { line: number; character: number } {
    return this.encodePosition(uri, line, character);
  }

  /** The document text a decoder needs to map server offsets back to UTF-16. */
  private textFor(uri: string): string | undefined {
    return this.negotiated.positionEncoding === 'utf-16' ? undefined : this.docs.get(uri)?.text;
  }

  // ---- Document sync ------------------------------------------------------

  async didOpen(input: LspDidOpenInput): Promise<void> {
    if (!(await this.ensure())) return;
    const existing = this.docs.get(input.uri);
    if (existing) {
      existing.version = input.version;
      existing.text = input.text;
      this.sendFullChange(input.uri, input.version, input.text);
      return;
    }
    this.docs.set(input.uri, {
      languageId: input.languageId,
      version: input.version,
      text: input.text,
    });
    if (this.negotiated.openClose || this.negotiated.syncKind !== 0) {
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri: input.uri,
          languageId: input.languageId,
          version: input.version,
          text: input.text,
        },
      });
    }
  }

  private sendFullChange(uri: string, version: number, text: string): void {
    if (this.negotiated.syncKind === 0) return;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Apply incremental changes. Returns false when Main's copy of the document
   * drifted from the renderer's, which makes the caller resend the full text
   * rather than let a server operate on a document it no longer has.
   */
  didChange(input: LspDidChangeInput): boolean {
    const doc = this.docs.get(input.uri);
    if (!doc) return true;
    if (typeof input.text === 'string') {
      doc.text = input.text;
      doc.version = input.version;
      if (this.initialized) this.sendFullChange(input.uri, input.version, input.text);
      return true;
    }
    const changes = input.changes ?? [];
    if (changes.length === 0) return true;

    const next = applyContentChanges(doc.text, changes);
    if (next === null) return false;
    if (typeof input.length === 'number' && next.length !== input.length) return false;
    doc.text = next;
    doc.version = input.version;
    if (!this.initialized) return true;

    if (this.negotiated.syncKind === 2) {
      this.notify('textDocument/didChange', {
        textDocument: { uri: input.uri, version: input.version },
        contentChanges: changes.map((change) => {
          if (!change.range) return { text: change.text };
          const encoded = this.encodeRange(input.uri, change.range);
          const entry: { range: LspRange; rangeLength?: number; text: string } = {
            range: encoded,
            text: change.text,
          };
          if (typeof change.rangeLength === 'number') entry.rangeLength = change.rangeLength;
          return entry;
        }),
      });
    } else {
      this.sendFullChange(input.uri, input.version, next);
    }
    return true;
  }

  /** Re-seed a document after drift was detected. */
  resync(uri: string, version: number, text: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc.text = text;
    doc.version = version;
    delete doc.diagnosticResultId;
    delete doc.semanticResultId;
    if (this.initialized) this.sendFullChange(uri, version, text);
  }

  didSave(uri: string, text: string): void {
    if (!this.initialized || !this.docs.has(uri)) return;
    this.notify('textDocument/didSave', { textDocument: { uri }, text });
  }

  didClose(uri: string): void {
    if (!this.docs.delete(uri)) return;
    if (!this.initialized) return;
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  hasDoc(uri: string): boolean {
    return this.docs.has(uri);
  }

  // ---- Language features --------------------------------------------------

  async hover(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspHoverResult> {
    const res = await this.ask(
      this.negotiated.hover,
      'textDocument/hover',
      { textDocument: { uri }, position: this.position(uri, line, character) },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapHover(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async completion(
    uri: string,
    line: number,
    character: number,
    context?: LspCompletionContext,
    cancelKey?: string,
  ): Promise<LspCompletionResult> {
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: this.position(uri, line, character),
    };
    if (context) {
      params.context =
        context.triggerCharacter === undefined
          ? { triggerKind: context.triggerKind }
          : { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter };
    }
    const res = await this.ask(
      this.negotiated.completion,
      'textDocument/completion',
      params,
      cancelKey === undefined ? {} : { cancelKey },
    );
    return this.registerCompletions(res, uri);
  }

  /**
   * Normalize a completion response and retain each raw item so
   * `completionItem/resolve` can be issued later. Resolution is what supplies
   * documentation and the `additionalTextEdits` that make auto-import work, and
   * servers only do that work for the item the user actually highlights.
   */
  private registerCompletions(res: unknown, uri: string): LspCompletionResult {
    const raw = Array.isArray(res)
      ? res
      : res && typeof res === 'object'
        ? (res as { items?: unknown }).items
        : null;
    const isIncomplete =
      res && typeof res === 'object' && !Array.isArray(res)
        ? (res as { isIncomplete?: unknown }).isIncomplete === true
        : false;
    if (!Array.isArray(raw)) return { items: [], isIncomplete };

    // A fresh list makes the previous handles unreachable; drop them first so a
    // long editing session cannot accumulate them.
    if (this.completionHandles.size > MAX_RESOLVE_HANDLES) this.completionHandles.clear();

    const encoding = this.negotiated.positionEncoding;
    const text = this.textFor(uri);
    const items: LspCompletionItem[] = [];
    for (const entry of raw.slice(0, MAX_COMPLETION_ITEMS)) {
      const item = mapCompletionItem(entry, encoding, text);
      if (!item) continue;
      if (this.negotiated.completionResolve) {
        const handle = this.nextHandle++;
        this.completionHandles.set(handle, entry);
        item.id = handle;
      }
      items.push(item);
    }
    return { items, isIncomplete };
  }

  async resolveCompletion(uri: string, id: number): Promise<LspCompletionItem | null> {
    const raw = this.completionHandles.get(id);
    if (raw === undefined) return null;
    if (!this.initialized || !this.negotiated.completionResolve) {
      return mapCompletionItem(raw, this.negotiated.positionEncoding, this.textFor(uri));
    }
    const res = await this.request('completionItem/resolve', raw).catch(() => null);
    const resolved = mapCompletionItem(
      res ?? raw,
      this.negotiated.positionEncoding,
      this.textFor(uri),
    );
    if (resolved) resolved.id = id;
    return resolved;
  }

  async signatureHelp(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspSignatureHelp> {
    const res = await this.ask(
      this.negotiated.signatureHelp,
      'textDocument/signatureHelp',
      { textDocument: { uri }, position: this.position(uri, line, character) },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapSignatureHelp(res);
  }

  private async locations(
    supported: boolean,
    method: string,
    uri: string,
    line: number,
    character: number,
    extra: Record<string, unknown> = {},
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    const res = await this.ask(
      supported,
      method,
      { textDocument: { uri }, position: this.position(uri, line, character), ...extra },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return { locations: mapLocations(res) };
  }

  definition(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    return this.locations(
      this.negotiated.definition,
      'textDocument/definition',
      uri,
      line,
      character,
      {},
      cancelKey,
    );
  }

  declaration(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    return this.locations(
      this.negotiated.declaration,
      'textDocument/declaration',
      uri,
      line,
      character,
      {},
      cancelKey,
    );
  }

  typeDefinition(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    return this.locations(
      this.negotiated.typeDefinition,
      'textDocument/typeDefinition',
      uri,
      line,
      character,
      {},
      cancelKey,
    );
  }

  implementation(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    return this.locations(
      this.negotiated.implementation,
      'textDocument/implementation',
      uri,
      line,
      character,
      {},
      cancelKey,
    );
  }

  references(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspLocationResult> {
    return this.locations(
      this.negotiated.references,
      'textDocument/references',
      uri,
      line,
      character,
      { context: { includeDeclaration: true } },
      cancelKey,
    );
  }

  async documentHighlight(
    uri: string,
    line: number,
    character: number,
    cancelKey?: string,
  ): Promise<LspDocumentHighlightResult> {
    const res = await this.ask(
      this.negotiated.documentHighlight,
      'textDocument/documentHighlight',
      { textDocument: { uri }, position: this.position(uri, line, character) },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return { highlights: mapHighlights(res) };
  }

  async prepareRename(
    uri: string,
    line: number,
    character: number,
  ): Promise<LspPrepareRenameResult> {
    if (!this.negotiated.rename) return { range: null };
    if (!this.negotiated.prepareRename) {
      // The server renames but cannot pre-validate; let Monaco use its own word range.
      return { range: null, placeholder: '' };
    }
    const res = await this.ask(true, 'textDocument/prepareRename', {
      textDocument: { uri },
      position: this.position(uri, line, character),
    });
    if (!res || typeof res !== 'object') return { range: null };
    const encoding = this.negotiated.positionEncoding;
    const text = this.textFor(uri);
    const record = res as Record<string, unknown>;
    const direct = decodeRange(mapRange(record.range) ?? mapRange(res), encoding, text);
    const out: LspPrepareRenameResult = { range: direct };
    if (typeof record.placeholder === 'string') out.placeholder = record.placeholder;
    if (record.defaultBehavior === true && !direct) out.placeholder = '';
    return out;
  }

  async rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit> {
    const res = await this.ask(this.negotiated.rename, 'textDocument/rename', {
      textDocument: { uri },
      position: this.position(uri, line, character),
      newName,
    });
    return { changes: mapWorkspaceEdit(res) };
  }

  async codeAction(
    uri: string,
    range: LspRange,
    diagnostics: LspDiagnostic[],
    only?: string[],
    cancelKey?: string,
  ): Promise<LspCodeAction[]> {
    const context: Record<string, unknown> = { diagnostics };
    if (only && only.length > 0) context.only = only;
    const res = await this.ask(
      this.negotiated.codeAction,
      'textDocument/codeAction',
      { textDocument: { uri }, range: this.encodeRange(uri, range), context },
      cancelKey === undefined ? {} : { cancelKey },
    );
    if (!Array.isArray(res)) return [];
    if (this.codeActionHandles.size > MAX_RESOLVE_HANDLES) this.codeActionHandles.clear();
    const out: LspCodeAction[] = [];
    for (const entry of res) {
      const action = mapCodeAction(entry);
      if (!action) continue;
      // Every action keeps its raw form on the Main side. That is what lets an
      // edit-less action be resolved later, and what lets a command-backed one be
      // executed WITHOUT the renderer ever handing us a command payload to run.
      const handle = this.nextHandle++;
      this.codeActionHandles.set(handle, entry);
      action.id = handle;
      out.push(action);
    }
    return out;
  }

  async resolveCodeAction(id: number): Promise<LspCodeAction | null> {
    const raw = this.codeActionHandles.get(id);
    if (raw === undefined) return null;
    if (!this.initialized || !this.negotiated.codeActionResolve) return mapCodeAction(raw);
    const res = await this.request('codeAction/resolve', raw).catch(() => null);
    if (res && typeof res === 'object') this.codeActionHandles.set(id, res);
    const resolved = mapCodeAction(res ?? raw);
    if (resolved) resolved.id = id;
    return resolved;
  }

  /**
   * Run the command belonging to a previously returned code action.
   *
   * This is the half of code actions AXIOM used to discard: tsserver's
   * organize-imports, "add all missing imports", and most refactors arrive as
   * commands rather than edits, and the server answers by sending
   * `workspace/applyEdit` back to us. The command and its arguments come from
   * Main's retained copy of the action, never from the renderer, so the renderer
   * cannot ask a language server to run something it was never offered.
   */
  async executeCodeActionCommand(id: number): Promise<boolean> {
    let raw = this.codeActionHandles.get(id);
    if (raw === undefined || !this.initialized) return false;
    let command = mapCodeAction(raw)?.command ?? null;
    if (!command && this.negotiated.codeActionResolve) {
      const resolved = await this.request('codeAction/resolve', raw).catch(() => null);
      if (resolved && typeof resolved === 'object') {
        raw = resolved;
        this.codeActionHandles.set(id, resolved);
        command = mapCodeAction(resolved)?.command ?? null;
      }
    }
    if (!command) return false;
    return this.runCommand(command);
  }

  /** Run the command attached to a completion item (tsserver's import fixers). */
  async executeCompletionCommand(id: number): Promise<boolean> {
    const raw = this.completionHandles.get(id);
    if (raw === undefined || !this.initialized) return false;
    const command = mapCompletionItem(raw, this.negotiated.positionEncoding, undefined)?.command;
    if (!command) return false;
    return this.runCommand(command);
  }

  private async runCommand(command: LspCommand): Promise<boolean> {
    const commands = this.negotiated.executeCommands;
    if (commands.length > 0 && !commands.includes(command.command)) return false;
    const params: Record<string, unknown> = { command: command.command };
    if (command.arguments) params.arguments = command.arguments;
    const res = await this.request('workspace/executeCommand', params, {
      timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
    }).catch(() => undefined);
    return res !== undefined;
  }

  async documentSymbol(uri: string, cancelKey?: string): Promise<LspDocumentSymbol[]> {
    const res = await this.ask(
      this.negotiated.documentSymbol,
      'textDocument/documentSymbol',
      { textDocument: { uri } },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapDocumentSymbols(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async workspaceSymbol(query: string, cancelKey?: string): Promise<LspSymbolInformation[]> {
    const res = await this.ask(
      this.negotiated.workspaceSymbol,
      'workspace/symbol',
      { query },
      cancelKey === undefined
        ? { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }
        : { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, cancelKey },
    );
    return mapSymbolInformation(res);
  }

  async inlayHint(uri: string, range: LspRange, cancelKey?: string): Promise<LspInlayHint[]> {
    const res = await this.ask(
      this.negotiated.inlayHint,
      'textDocument/inlayHint',
      { textDocument: { uri }, range: this.encodeRange(uri, range) },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapInlayHints(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async foldingRange(uri: string, cancelKey?: string): Promise<LspFoldingRange[]> {
    const res = await this.ask(
      this.negotiated.foldingRange,
      'textDocument/foldingRange',
      { textDocument: { uri } },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapFoldingRanges(res);
  }

  async selectionRange(
    uri: string,
    positions: Array<{ line: number; character: number }>,
  ): Promise<LspRange[]> {
    const res = await this.ask(this.negotiated.selectionRange, 'textDocument/selectionRange', {
      textDocument: { uri },
      positions: positions.map((p) => this.position(uri, p.line, p.character)),
    });
    return mapSelectionRanges(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async documentLink(uri: string, cancelKey?: string): Promise<LspDocumentLink[]> {
    const res = await this.ask(
      this.negotiated.documentLink,
      'textDocument/documentLink',
      { textDocument: { uri } },
      cancelKey === undefined ? {} : { cancelKey },
    );
    return mapDocumentLinks(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  semanticTokensLegend(): LspSemanticTokensLegend | null {
    return this.negotiated.semanticTokens?.legend ?? null;
  }

  async semanticTokens(uri: string, cancelKey?: string): Promise<LspSemanticTokens | null> {
    const caps = this.negotiated.semanticTokens;
    if (!caps?.full) return null;
    const res = await this.ask(
      true,
      'textDocument/semanticTokens/full',
      { textDocument: { uri } },
      cancelKey === undefined
        ? { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }
        : { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, cancelKey },
    );
    const tokens = mapSemanticTokens(res);
    if (tokens?.resultId) {
      const doc = this.docs.get(uri);
      if (doc) doc.semanticResultId = tokens.resultId;
    }
    return tokens;
  }

  /**
   * Pull diagnostics (`textDocument/diagnostic`). Modern servers prefer this to
   * pushing: the editor asks for the file it is showing, so results arrive for
   * the document the user is actually looking at.
   */
  async pullDiagnostics(uri: string, cancelKey?: string): Promise<LspDiagnostic[] | null> {
    if (!this.negotiated.pullDiagnostics) return null;
    const doc = this.docs.get(uri);
    const params: Record<string, unknown> = { textDocument: { uri } };
    if (doc?.diagnosticResultId) params.previousResultId = doc.diagnosticResultId;
    const res = await this.ask(
      true,
      'textDocument/diagnostic',
      params,
      cancelKey === undefined ? {} : { cancelKey },
    );
    if (!res || typeof res !== 'object') return null;
    const report = res as Record<string, unknown>;
    if (typeof report.resultId === 'string' && doc) doc.diagnosticResultId = report.resultId;
    // 'unchanged' means keep what we already published.
    if (report.kind === 'unchanged') return null;
    if (!Array.isArray(report.items)) return null;
    return mapDiagnostics(report.items, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async formatting(uri: string, tabSize: number, insertSpaces: boolean): Promise<LspTextEdit[]> {
    const res = await this.ask(this.negotiated.formatting, 'textDocument/formatting', {
      textDocument: { uri },
      options: formattingOptions(tabSize, insertSpaces),
    });
    return mapTextEdits(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async rangeFormatting(
    uri: string,
    range: LspRange,
    tabSize: number,
    insertSpaces: boolean,
  ): Promise<LspTextEdit[]> {
    const res = await this.ask(this.negotiated.rangeFormatting, 'textDocument/rangeFormatting', {
      textDocument: { uri },
      range: this.encodeRange(uri, range),
      options: formattingOptions(tabSize, insertSpaces),
    });
    return mapTextEdits(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  onTypeTriggers(): string[] {
    const caps = this.negotiated.onTypeFormatting;
    return caps ? [caps.first, ...caps.more] : [];
  }

  async onTypeFormatting(
    uri: string,
    line: number,
    character: number,
    ch: string,
    tabSize: number,
    insertSpaces: boolean,
  ): Promise<LspTextEdit[]> {
    const caps = this.negotiated.onTypeFormatting;
    if (!caps || (caps.first !== ch && !caps.more.includes(ch))) return [];
    const res = await this.ask(true, 'textDocument/onTypeFormatting', {
      textDocument: { uri },
      position: this.position(uri, line, character),
      ch,
      options: formattingOptions(tabSize, insertSpaces),
    });
    return mapTextEdits(res, this.negotiated.positionEncoding, this.textFor(uri));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.docs.clear();
    const proc = this.proc;
    this.setState('stopped');
    if (!proc) return;
    if (this.initialized) {
      await Promise.race([
        this.request('shutdown', null).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (this.proc === proc) {
        try {
          this.notify('exit', undefined);
        } catch {
          // The server may have closed its pipe after shutdown.
        }
      }
    }
    this.teardown(new Error('LSP disposed'));
    await terminateProcessTree(proc);
  }
}

// ---- Client capabilities ----------------------------------------------------

/**
 * What AXIOM tells servers it can do.
 *
 * This is deliberately complete: an under-declared client is the single most
 * common reason a language server silently withholds features. Every entry here
 * corresponds to something the editor actually renders — nothing is advertised
 * that the renderer cannot honour.
 */
const CLIENT_CAPABILITIES = {
  general: {
    positionEncodings: ['utf-16', 'utf-8', 'utf-32'],
    markdown: { parser: 'marked', version: '1.1.0' },
    staleRequestSupport: { cancel: true, retryOnContentModified: [] },
    regularExpressions: { engine: 'ECMAScript', version: 'ES2020' },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    completion: {
      dynamicRegistration: false,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: false,
        resolveSupport: {
          properties: ['documentation', 'detail', 'additionalTextEdits', 'command'],
        },
        insertTextModeSupport: { valueSet: [1, 2] },
        labelDetailsSupport: true,
      },
      completionItemKind: {
        valueSet: Array.from({ length: 25 }, (_, index) => index + 1),
      },
      completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'data'] },
    },
    signatureHelp: {
      dynamicRegistration: false,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
      contextSupport: true,
    },
    declaration: { dynamicRegistration: false, linkSupport: true },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentHighlight: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
      labelSupport: true,
    },
    codeAction: {
      dynamicRegistration: false,
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      honorsChangeAnnotations: false,
      resolveSupport: { properties: ['edit', 'command'] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            '',
            'quickfix',
            'refactor',
            'refactor.extract',
            'refactor.inline',
            'refactor.rewrite',
            'source',
            'source.organizeImports',
            'source.fixAll',
          ],
        },
      },
    },
    codeLens: { dynamicRegistration: false },
    documentLink: { dynamicRegistration: false, tooltipSupport: true },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    onTypeFormatting: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: true, honorsChangeAnnotations: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: false,
      codeDescriptionSupport: true,
      dataSupport: true,
      tagSupport: { valueSet: [1, 2] },
    },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    foldingRange: {
      dynamicRegistration: false,
      lineFoldingOnly: true,
      rangeLimit: 5_000,
      foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] },
      foldingRange: { collapsedText: false },
    },
    selectionRange: { dynamicRegistration: false },
    linkedEditingRange: { dynamicRegistration: false },
    callHierarchy: { dynamicRegistration: false },
    typeHierarchy: { dynamicRegistration: false },
    semanticTokens: {
      dynamicRegistration: false,
      requests: { range: true, full: { delta: true } },
      tokenTypes: [
        'namespace',
        'type',
        'class',
        'enum',
        'interface',
        'struct',
        'typeParameter',
        'parameter',
        'variable',
        'property',
        'enumMember',
        'event',
        'function',
        'method',
        'macro',
        'keyword',
        'modifier',
        'comment',
        'string',
        'number',
        'regexp',
        'operator',
        'decorator',
      ],
      tokenModifiers: [
        'declaration',
        'definition',
        'readonly',
        'static',
        'deprecated',
        'abstract',
        'async',
        'modification',
        'documentation',
        'defaultLibrary',
      ],
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
      serverCancelSupport: true,
      augmentsSyntaxTokens: true,
    },
    inlayHint: {
      dynamicRegistration: false,
      resolveSupport: { properties: ['tooltip', 'label.tooltip'] },
    },
    inlineValue: { dynamicRegistration: false },
    moniker: { dynamicRegistration: false },
  },
  workspace: {
    applyEdit: true,
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: false, relativePatternSupport: false },
    executeCommand: { dynamicRegistration: false },
    symbol: {
      dynamicRegistration: false,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
      resolveSupport: { properties: ['location.range'] },
    },
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ['create', 'rename', 'delete'],
      failureHandling: 'textOnlyTransactional',
      normalizesLineEndings: true,
      changeAnnotationSupport: { groupsOnLabel: false },
    },
    semanticTokens: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
    diagnostics: { refreshSupport: true },
    codeLens: { refreshSupport: false },
    fileOperations: {
      dynamicRegistration: false,
      didCreate: false,
      didRename: false,
      didDelete: false,
    },
  },
  window: {
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
    showDocument: { support: false },
  },
} as const;

/** Read the negotiated capability set out of an `initialize` result. */
function readServerCapabilities(result: unknown): Negotiated {
  const out = emptyNegotiated();
  if (!result || typeof result !== 'object') return out;
  const root = result as Record<string, unknown>;
  const encoding = root.positionEncoding;
  if (encoding === 'utf-8' || encoding === 'utf-32' || encoding === 'utf-16') {
    out.positionEncoding = encoding;
  }
  const caps = root.capabilities;
  if (!caps || typeof caps !== 'object') return out;
  const c = caps as Record<string, unknown>;

  // Document sync: either a bare kind or an options object.
  const sync = c.textDocumentSync;
  if (typeof sync === 'number') {
    out.syncKind = sync === 0 ? 0 : sync === 2 ? 2 : 1;
    out.openClose = sync !== 0;
  } else if (sync && typeof sync === 'object') {
    const s = sync as Record<string, unknown>;
    const kind = typeof s.change === 'number' ? s.change : 1;
    out.syncKind = kind === 0 ? 0 : kind === 2 ? 2 : 1;
    out.openClose = s.openClose !== false;
  }

  const enabled = (value: unknown): boolean =>
    value === true ||
    (value !== undefined && value !== null && value !== false && typeof value === 'object');

  out.hover = enabled(c.hoverProvider);
  out.definition = enabled(c.definitionProvider);
  out.declaration = enabled(c.declarationProvider);
  out.typeDefinition = enabled(c.typeDefinitionProvider);
  out.implementation = enabled(c.implementationProvider);
  out.references = enabled(c.referencesProvider);
  out.documentHighlight = enabled(c.documentHighlightProvider);
  out.documentSymbol = enabled(c.documentSymbolProvider);
  out.documentLink = enabled(c.documentLinkProvider);
  out.formatting = enabled(c.documentFormattingProvider);
  out.rangeFormatting = enabled(c.documentRangeFormattingProvider);
  out.foldingRange = enabled(c.foldingRangeProvider);
  out.selectionRange = enabled(c.selectionRangeProvider);
  out.inlayHint = enabled(c.inlayHintProvider);
  out.workspaceSymbol = enabled(c.workspaceSymbolProvider);
  out.pullDiagnostics = enabled(c.diagnosticProvider);

  const completion = c.completionProvider;
  if (enabled(completion)) {
    out.completion = true;
    if (completion && typeof completion === 'object') {
      const cp = completion as Record<string, unknown>;
      out.completionResolve = cp.resolveProvider === true;
      out.completionTriggers = stringArray(cp.triggerCharacters);
    }
  }

  const signature = c.signatureHelpProvider;
  if (enabled(signature)) {
    out.signatureHelp = true;
    if (signature && typeof signature === 'object') {
      const sp = signature as Record<string, unknown>;
      out.signatureTriggers = stringArray(sp.triggerCharacters);
      out.signatureRetriggers = stringArray(sp.retriggerCharacters);
    }
  }

  const rename = c.renameProvider;
  if (enabled(rename)) {
    out.rename = true;
    if (rename && typeof rename === 'object') {
      out.prepareRename = (rename as Record<string, unknown>).prepareProvider === true;
    }
  }

  const codeAction = c.codeActionProvider;
  if (enabled(codeAction)) {
    out.codeAction = true;
    if (codeAction && typeof codeAction === 'object') {
      const ca = codeAction as Record<string, unknown>;
      out.codeActionResolve = ca.resolveProvider === true;
      out.codeActionKinds = stringArray(ca.codeActionKinds);
    }
  }

  const onType = c.documentOnTypeFormattingProvider;
  if (onType && typeof onType === 'object') {
    const ot = onType as Record<string, unknown>;
    if (typeof ot.firstTriggerCharacter === 'string') {
      out.onTypeFormatting = {
        first: ot.firstTriggerCharacter,
        more: stringArray(ot.moreTriggerCharacter),
      };
    }
  }

  const semantic = c.semanticTokensProvider;
  if (semantic && typeof semantic === 'object') {
    const sp = semantic as Record<string, unknown>;
    const legend = sp.legend as Record<string, unknown> | undefined;
    const tokenTypes = stringArray(legend?.tokenTypes);
    if (tokenTypes.length > 0) {
      const full = sp.full;
      out.semanticTokens = {
        legend: { tokenTypes, tokenModifiers: stringArray(legend?.tokenModifiers) },
        full: full === true || (full !== undefined && typeof full === 'object'),
        delta: Boolean(
          full && typeof full === 'object' && (full as Record<string, unknown>).delta === true,
        ),
        range: enabled(sp.range),
      };
    }
  }

  const execute = c.executeCommandProvider;
  if (execute && typeof execute === 'object') {
    out.executeCommands = stringArray((execute as Record<string, unknown>).commands);
  }

  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function formattingOptions(tabSize: number, insertSpaces: boolean): Record<string, unknown> {
  return {
    tabSize,
    insertSpaces,
    trimTrailingWhitespace: true,
    insertFinalNewline: true,
    trimFinalNewlines: true,
  };
}

// ---- Text utilities --------------------------------------------------------

/**
 * Line-start offsets for `text`. Memoized on the last string seen, which is all
 * that is needed: position mapping happens in bursts against one document.
 */
let lastLineStartsKey: string | null = null;
let lastLineStarts: number[] | null = null;

function lineStarts(text: string): number[] {
  if (lastLineStartsKey === text && lastLineStarts) return lastLineStarts;
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  lastLineStartsKey = text;
  lastLineStarts = starts;
  return starts;
}

function lineAt(text: string, line: number): string | null {
  const starts = lineStarts(text);
  const start = starts[line];
  if (start === undefined) return null;
  const nextStart = starts[line + 1];
  const end = nextStart === undefined ? text.length : nextStart - 1;
  return text.slice(start, Math.max(start, end));
}

function offsetAt(text: string, line: number, character: number): number {
  const starts = lineStarts(text);
  if (line < 0) return 0;
  if (line >= starts.length) return text.length;
  const start = starts[line] ?? 0;
  const nextStart = starts[line + 1];
  const lineEnd = nextStart === undefined ? text.length : nextStart;
  return Math.min(start + Math.max(0, character), lineEnd);
}

/**
 * Apply incremental content changes in order, exactly as LSP defines it: each
 * change applies to the document produced by the previous one. Returns null if a
 * change is not applicable, which triggers a full resync instead of silently
 * corrupting Main's copy.
 */
function applyContentChanges(text: string, changes: LspContentChange[]): string | null {
  let result = text;
  for (const change of changes) {
    if (!change.range) {
      result = change.text;
      continue;
    }
    const start = offsetAt(result, change.range.start.line, change.range.start.character);
    const end = offsetAt(result, change.range.end.line, change.range.end.character);
    if (start > end || end > result.length) return null;
    result = result.slice(0, start) + change.text + result.slice(end);
  }
  return result;
}

/**
 * Convert a server position back to UTF-16 (what Monaco needs). `text` is only
 * supplied when the negotiated encoding is not already UTF-16.
 */
function decodeCharacter(
  text: string | undefined,
  encoding: PositionEncoding,
  line: number,
  character: number,
): number {
  if (encoding === 'utf-16' || text === undefined) return character;
  const lineText = lineAt(text, line);
  if (lineText === null) return character;
  if (encoding === 'utf-8') {
    let bytes = 0;
    for (let i = 0; i < lineText.length;) {
      if (bytes >= character) return i;
      const codePoint = lineText.codePointAt(i);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      bytes += Buffer.byteLength(lineText.slice(i, i + width), 'utf8');
      i += width;
    }
    return lineText.length;
  }
  // utf-32: one unit per code point.
  let units = 0;
  for (let i = 0; i < lineText.length;) {
    if (units >= character) return i;
    const codePoint = lineText.codePointAt(i);
    if (codePoint === undefined) break;
    i += codePoint > 0xffff ? 2 : 1;
    units += 1;
  }
  return lineText.length;
}

function decodeRange(
  range: LspRange | null,
  encoding: PositionEncoding,
  text: string | undefined,
): LspRange | null {
  if (!range) return null;
  if (encoding === 'utf-16' || text === undefined) return range;
  return {
    start: {
      line: range.start.line,
      character: decodeCharacter(text, encoding, range.start.line, range.start.character),
    },
    end: {
      line: range.end.line,
      character: decodeCharacter(text, encoding, range.end.line, range.end.character),
    },
  };
}

// ---- LSP → internal shape mappers ------------------------------------------

function mapRange(value: unknown): LspRange | null {
  const r = value as { start?: unknown; end?: unknown } | undefined;
  if (!r) return null;
  const s = r.start as { line?: unknown; character?: unknown } | undefined;
  const e = r.end as { line?: unknown; character?: unknown } | undefined;
  if (
    !s ||
    !e ||
    typeof s.line !== 'number' ||
    typeof s.character !== 'number' ||
    typeof e.line !== 'number' ||
    typeof e.character !== 'number'
  ) {
    return null;
  }
  return {
    start: { line: s.line, character: s.character },
    end: { line: e.line, character: e.character },
  };
}

function normalizeMarkup(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeMarkup).filter(Boolean).join('\n\n');
  const v = value as { value?: unknown; language?: unknown };
  if (typeof v.value === 'string') {
    return typeof v.language === 'string' && v.language.length > 0
      ? `\`\`\`${v.language}\n${v.value}\n\`\`\``
      : v.value;
  }
  return '';
}

function isMarkdown(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === 'markdown';
}

function mapDiagnostics(
  raw: unknown[],
  encoding: PositionEncoding,
  text: string | undefined,
): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  for (const entry of raw) {
    const d = entry as Record<string, unknown>;
    const range = decodeRange(mapRange(d.range), encoding, text);
    if (!range || typeof d.message !== 'string') continue;
    const diag: LspDiagnostic = {
      range,
      message: d.message,
      severity: typeof d.severity === 'number' ? d.severity : 1,
    };
    if (typeof d.source === 'string') diag.source = d.source;
    if (typeof d.code === 'string' || typeof d.code === 'number') diag.code = String(d.code);
    else if (d.code && typeof d.code === 'object') {
      const value = (d.code as { value?: unknown }).value;
      if (typeof value === 'string' || typeof value === 'number') diag.code = String(value);
    }
    const description = (d.codeDescription as { href?: unknown } | undefined)?.href;
    if (typeof description === 'string') diag.codeDescription = description;
    const tags = Array.isArray(d.tags)
      ? d.tags.filter((tag): tag is number => typeof tag === 'number')
      : [];
    if (tags.length > 0) diag.tags = tags;
    if (Array.isArray(d.relatedInformation)) {
      const related: LspDiagnosticRelated[] = [];
      for (const item of d.relatedInformation) {
        const r = item as Record<string, unknown>;
        const loc = r.location as { uri?: unknown; range?: unknown } | undefined;
        const locRange = decodeRange(mapRange(loc?.range), encoding, text);
        if (typeof loc?.uri !== 'string' || !locRange || typeof r.message !== 'string') continue;
        related.push({ location: { uri: loc.uri, range: locRange }, message: r.message });
      }
      if (related.length > 0) diag.relatedInformation = related;
    }
    // `data` is the server's opaque round-trip token; quick fixes need it back.
    if (d.data !== undefined) diag.data = d.data as LspDiagnostic['data'];
    diagnostics.push(diag);
  }
  return diagnostics;
}

function mapHover(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspHoverResult {
  if (!res || typeof res !== 'object') return { contents: '' };
  const r = res as { contents?: unknown; range?: unknown };
  const out: LspHoverResult = { contents: normalizeMarkup(r.contents) };
  const range = decodeRange(mapRange(r.range), encoding, text);
  if (range) out.range = range;
  return out;
}

function mapTextEdit(
  value: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspTextEdit | null {
  const o = value as Record<string, unknown> | undefined;
  if (!o || typeof o.newText !== 'string') return null;
  const range = decodeRange(
    mapRange(o.range) ?? mapRange(o.replace) ?? mapRange(o.insert),
    encoding,
    text,
  );
  if (!range) return null;
  return { range, newText: o.newText };
}

function mapCompletionItem(
  entry: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspCompletionItem | null {
  const c = entry as Record<string, unknown> | undefined;
  if (!c || typeof c.label !== 'string') return null;
  const item: LspCompletionItem = { label: c.label };
  if (typeof c.kind === 'number') item.kind = c.kind;
  if (typeof c.detail === 'string') item.detail = c.detail;
  const labelDetails = c.labelDetails as Record<string, unknown> | undefined;
  if (labelDetails) {
    if (typeof labelDetails.detail === 'string') item.labelDetail = labelDetails.detail;
    if (typeof labelDetails.description === 'string') {
      item.labelDescription = labelDetails.description;
    }
  }
  if (typeof c.insertText === 'string') item.insertText = c.insertText;
  if (typeof c.insertTextFormat === 'number') item.insertTextFormat = c.insertTextFormat;
  if (typeof c.sortText === 'string') item.sortText = c.sortText;
  if (typeof c.filterText === 'string') item.filterText = c.filterText;
  if (c.preselect === true) item.preselect = true;
  if (c.deprecated === true) item.deprecated = true;
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.includes(1)) item.deprecated = true;
  const commitCharacters = stringArray(c.commitCharacters);
  if (commitCharacters.length > 0) item.commitCharacters = commitCharacters;
  const doc = c.documentation;
  const documentation = normalizeMarkup(doc);
  if (documentation.length > 0) {
    item.documentation = documentation;
    if (isMarkdown(doc)) item.documentationIsMarkdown = true;
  }
  const textEdit = mapTextEdit(c.textEdit, encoding, text);
  if (textEdit) item.textEdit = textEdit;
  if (Array.isArray(c.additionalTextEdits)) {
    const extra: LspTextEdit[] = [];
    for (const edit of c.additionalTextEdits) {
      const mapped = mapTextEdit(edit, encoding, text);
      if (mapped) extra.push(mapped);
    }
    if (extra.length > 0) item.additionalTextEdits = extra;
  }
  const command = mapCommand(c.command);
  if (command) item.command = command;
  return item;
}

function mapCommand(value: unknown): LspCommand | null {
  const o = value as Record<string, unknown> | undefined;
  if (!o || typeof o.command !== 'string') return null;
  const command: LspCommand = {
    title: typeof o.title === 'string' ? o.title : o.command,
    command: o.command,
  };
  if (Array.isArray(o.arguments)) command.arguments = o.arguments;
  return command;
}

function mapLocations(res: unknown): LspLocation[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: LspLocation[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    // Location has `uri`+`range`; LocationLink has `targetUri`+`targetSelectionRange`.
    const uri =
      typeof o.uri === 'string' ? o.uri : typeof o.targetUri === 'string' ? o.targetUri : null;
    const range = mapRange(o.range) ?? mapRange(o.targetSelectionRange) ?? mapRange(o.targetRange);
    if (uri && range) out.push({ uri, range });
  }
  return out;
}

function mapHighlights(res: unknown): LspDocumentHighlight[] {
  if (!Array.isArray(res)) return [];
  const out: LspDocumentHighlight[] = [];
  for (const entry of res) {
    const o = entry as Record<string, unknown>;
    const range = mapRange(o.range);
    if (range) out.push({ range, kind: typeof o.kind === 'number' ? o.kind : 1 });
  }
  return out;
}

/** Normalize an LSP WorkspaceEdit (`changes` map or `documentChanges`) → uri→edits. */
function mapWorkspaceEdit(res: unknown): Record<string, LspTextEdit[]> {
  const out: Record<string, LspTextEdit[]> = {};
  if (!res || typeof res !== 'object') return out;
  const we = res as { changes?: unknown; documentChanges?: unknown };
  const add = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits)) return;
    const mapped: LspTextEdit[] = [];
    for (const e of edits) {
      const o = e as Record<string, unknown>;
      const range = mapRange(o.range);
      if (range && typeof o.newText === 'string') mapped.push({ range, newText: o.newText });
    }
    if (mapped.length > 0) out[uri] = (out[uri] ?? []).concat(mapped);
  };
  if (we.changes && typeof we.changes === 'object') {
    for (const [uri, edits] of Object.entries(we.changes as Record<string, unknown>)) {
      add(uri, edits);
    }
  }
  if (Array.isArray(we.documentChanges)) {
    for (const dc of we.documentChanges) {
      const d = dc as { textDocument?: { uri?: unknown }; edits?: unknown };
      const uri = d.textDocument?.uri;
      if (typeof uri === 'string') add(uri, d.edits);
    }
  }
  return out;
}

function mapTextEdits(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspTextEdit[] {
  if (!Array.isArray(res)) return [];
  const out: LspTextEdit[] = [];
  for (const e of res) {
    const mapped = mapTextEdit(e, encoding, text);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapSignatureHelp(res: unknown): LspSignatureHelp {
  const r = res as
    { signatures?: unknown; activeSignature?: unknown; activeParameter?: unknown } | undefined;
  if (!r || !Array.isArray(r.signatures)) return { signatures: [] };
  const signatures: LspSignature[] = [];
  for (const s of r.signatures) {
    const so = s as Record<string, unknown>;
    if (typeof so.label !== 'string') continue;
    const parameters: LspSignatureParam[] = [];
    if (Array.isArray(so.parameters)) {
      for (const p of so.parameters) {
        const po = p as Record<string, unknown>;
        // `label` may be a [start, end) offset pair into the signature label.
        let label = '';
        if (typeof po.label === 'string') label = po.label;
        else if (
          Array.isArray(po.label) &&
          typeof po.label[0] === 'number' &&
          typeof po.label[1] === 'number'
        ) {
          label = so.label.slice(po.label[0], po.label[1]);
        }
        const param: LspSignatureParam = { label };
        const doc = normalizeMarkup(po.documentation);
        if (doc) param.documentation = doc;
        parameters.push(param);
      }
    }
    const sig: LspSignature = { label: so.label, parameters };
    const doc = normalizeMarkup(so.documentation);
    if (doc) sig.documentation = doc;
    if (typeof so.activeParameter === 'number') sig.activeParameter = so.activeParameter;
    signatures.push(sig);
  }
  const out: LspSignatureHelp = { signatures };
  if (typeof r.activeSignature === 'number') out.activeSignature = r.activeSignature;
  if (typeof r.activeParameter === 'number') out.activeParameter = r.activeParameter;
  return out;
}

/**
 * Map one code action. Unlike the previous implementation this keeps actions
 * that carry only a command and actions that carry neither (resolvable ones) —
 * dropping those is what hid organize-imports and every tsserver refactor.
 */
function mapCodeAction(entry: unknown): LspCodeAction | null {
  const o = entry as Record<string, unknown> | undefined;
  if (!o) return null;
  // A bare Command (no `title`+`kind` literal) is also a valid code-action entry.
  if (typeof o.title !== 'string') return null;
  const action: LspCodeAction = { title: o.title };
  if (typeof o.kind === 'string') action.kind = o.kind;
  if (o.isPreferred === true) action.isPreferred = true;
  const disabled = o.disabled as { reason?: unknown } | undefined;
  if (disabled && typeof disabled.reason === 'string') action.disabledReason = disabled.reason;
  if (o.edit && typeof o.edit === 'object') {
    const changes = mapWorkspaceEdit(o.edit);
    if (Object.keys(changes).length > 0) action.edit = { changes };
  }
  // `command` is either a nested Command object or, for a bare Command entry,
  // this object itself.
  const command = mapCommand(o.command) ?? (typeof o.command === 'string' ? mapCommand(o) : null);
  if (command) action.command = command;
  return action;
}

function mapDocumentSymbols(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspDocumentSymbol[] {
  if (!Array.isArray(res)) return [];
  const out: LspDocumentSymbol[] = [];
  for (const s of res) {
    const o = s as Record<string, unknown>;
    const loc = o.location as { range?: unknown } | undefined;
    const range = decodeRange(mapRange(o.range) ?? mapRange(loc?.range), encoding, text);
    const selectionRange = decodeRange(mapRange(o.selectionRange), encoding, text) ?? range;
    if (typeof o.name !== 'string' || !range || !selectionRange) continue;
    const sym: LspDocumentSymbol = {
      name: o.name,
      kind: typeof o.kind === 'number' ? o.kind : 0,
      range,
      selectionRange,
      children: mapDocumentSymbols(o.children, encoding, text),
    };
    if (typeof o.detail === 'string') sym.detail = o.detail;
    out.push(sym);
  }
  return out;
}

function mapSymbolInformation(res: unknown): LspSymbolInformation[] {
  if (!Array.isArray(res)) return [];
  const out: LspSymbolInformation[] = [];
  for (const entry of res) {
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string') continue;
    const loc = o.location as { uri?: unknown; range?: unknown } | undefined;
    const range = mapRange(loc?.range);
    if (typeof loc?.uri !== 'string' || !range) continue;
    const symbol: LspSymbolInformation = {
      name: o.name,
      kind: typeof o.kind === 'number' ? o.kind : 0,
      location: { uri: loc.uri, range },
    };
    if (typeof o.containerName === 'string') symbol.containerName = o.containerName;
    out.push(symbol);
  }
  return out;
}

function mapInlayHints(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspInlayHint[] {
  if (!Array.isArray(res)) return [];
  const out: LspInlayHint[] = [];
  for (const h of res) {
    const o = h as Record<string, unknown>;
    const pos = o.position as { line?: unknown; character?: unknown } | undefined;
    if (!pos || typeof pos.line !== 'number' || typeof pos.character !== 'number') continue;
    let label = '';
    if (typeof o.label === 'string') {
      label = o.label;
    } else if (Array.isArray(o.label)) {
      label = o.label
        .map((p) => {
          const v = (p as { value?: unknown }).value;
          return typeof v === 'string' ? v : '';
        })
        .join('');
    }
    const hint: LspInlayHint = {
      position: {
        line: pos.line,
        character: decodeCharacter(text, encoding, pos.line, pos.character),
      },
      label,
    };
    if (typeof o.kind === 'number') hint.kind = o.kind;
    if (typeof o.paddingLeft === 'boolean') hint.paddingLeft = o.paddingLeft;
    if (typeof o.paddingRight === 'boolean') hint.paddingRight = o.paddingRight;
    out.push(hint);
  }
  return out;
}

function mapFoldingRanges(res: unknown): LspFoldingRange[] {
  if (!Array.isArray(res)) return [];
  const out: LspFoldingRange[] = [];
  for (const entry of res) {
    const o = entry as Record<string, unknown>;
    if (typeof o.startLine !== 'number' || typeof o.endLine !== 'number') continue;
    const range: LspFoldingRange = { startLine: o.startLine, endLine: o.endLine };
    if (typeof o.startCharacter === 'number') range.startCharacter = o.startCharacter;
    if (typeof o.endCharacter === 'number') range.endCharacter = o.endCharacter;
    if (typeof o.kind === 'string') range.kind = o.kind;
    out.push(range);
  }
  return out;
}

/** Flatten the server's nested selection-range chain, innermost first. */
function mapSelectionRanges(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspRange[] {
  if (!Array.isArray(res) || res.length === 0) return [];
  const out: LspRange[] = [];
  let cursor = res[0] as Record<string, unknown> | undefined;
  const seen = new Set<unknown>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const range = decodeRange(mapRange(cursor.range), encoding, text);
    if (range) out.push(range);
    cursor = cursor.parent as Record<string, unknown> | undefined;
    if (out.length > 64) break;
  }
  return out;
}

function mapDocumentLinks(
  res: unknown,
  encoding: PositionEncoding,
  text: string | undefined,
): LspDocumentLink[] {
  if (!Array.isArray(res)) return [];
  const out: LspDocumentLink[] = [];
  for (const entry of res) {
    const o = entry as Record<string, unknown>;
    const range = decodeRange(mapRange(o.range), encoding, text);
    if (!range) continue;
    const link: LspDocumentLink = { range };
    if (typeof o.target === 'string') link.target = o.target;
    if (typeof o.tooltip === 'string') link.tooltip = o.tooltip;
    out.push(link);
  }
  return out;
}

function mapSemanticTokens(res: unknown): LspSemanticTokens | null {
  if (!res || typeof res !== 'object') return null;
  const o = res as Record<string, unknown>;
  if (!Array.isArray(o.data)) return null;
  const data: number[] = [];
  for (const value of o.data) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    data.push(value);
  }
  if (data.length % 5 !== 0) return null;
  const tokens: LspSemanticTokens = { data };
  if (typeof o.resultId === 'string') tokens.resultId = o.resultId;
  return tokens;
}

// ---- Public API (used by IPC handlers) -------------------------------------

// A server instance per definition and canonical workspace root, plus a uri→servers
// map so every per-document request routes to the exact workspace-bound servers.
const servers = new Map<string, LspServer>();
const uriToServers = new Map<string, LspServer[]>();
let diagnosticsHandler: ((evt: LspDiagnosticsEvent) => void) | null = null;
let statusHandler: ((status: LspServerStatus) => void) | null = null;
let logHandler: ((evt: LspLogEvent) => void) | null = null;
let applyEditHandler: ((root: string, edit: LspWorkspaceEdit) => Promise<boolean>) | null = null;

function pathKey(path: string): string {
  const value = normalize(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function attachHandlers(server: LspServer): void {
  const handlers: Parameters<LspServer['setHandlers']>[0] = {};
  if (diagnosticsHandler) handlers.diagnostics = diagnosticsHandler;
  if (statusHandler) handlers.status = statusHandler;
  if (logHandler) handlers.log = logHandler;
  if (applyEditHandler) handlers.applyEdit = applyEditHandler;
  server.setHandlers(handlers);
}

/** Every server (bundled + detected) that should serve a language in this root. */
function serversFor(languageId: string, rootPath: string | null): LspServer[] {
  if (!rootPath) return [];
  const out: LspServer[] = [];
  for (const config of serversForLanguage(languageId)) {
    const key = `${config.id}\0${pathKey(rootPath)}`;
    let server = servers.get(key);
    if (!server) {
      server = new LspServer(config, rootPath);
      attachHandlers(server);
      servers.set(key, server);
    }
    out.push(server);
  }
  return out;
}

function bound(uri: string): LspServer[] {
  return uriToServers.get(uri) ?? [];
}

/** The first server whose result is non-empty, evaluated in registry order. */
async function firstNonEmpty<T>(
  uri: string,
  run: (server: LspServer) => Promise<T>,
  isEmpty: (value: T) => boolean,
  fallback: T,
): Promise<T> {
  for (const server of bound(uri)) {
    if (!server.isRunning) continue;
    const value = await run(server).catch(() => null);
    if (value !== null && !isEmpty(value)) return value;
  }
  return fallback;
}

/** Merge every server's contribution. Used where more results are strictly better. */
async function mergeAll<T>(uri: string, run: (server: LspServer) => Promise<T[]>): Promise<T[]> {
  const running = bound(uri).filter((server) => server.isRunning);
  if (running.length === 0) return [];
  const results = await Promise.all(running.map((server) => run(server).catch(() => [] as T[])));
  return results.flat();
}

export async function lspDidOpen(input: LspDidOpenInput): Promise<void> {
  if (!input.rootPath) {
    throw new Error('A workspace root is required to start a language server.');
  }
  const candidates = serversFor(input.languageId, input.rootPath);
  if (candidates.length === 0) return;
  uriToServers.set(input.uri, candidates);
  await Promise.all(candidates.map((server) => server.didOpen(input).catch(() => undefined)));
}

/**
 * Forward incremental changes. `resync: true` tells the renderer that Main's
 * copy drifted and it must resend the full text — the sync is never allowed to
 * be silently wrong.
 */
export function lspDidChange(input: LspDidChangeInput): { resync: boolean } {
  let resync = false;
  for (const server of bound(input.uri)) {
    if (!server.didChange(input)) resync = true;
  }
  return { resync };
}

export function lspResync(uri: string, version: number, text: string): void {
  for (const server of bound(uri)) server.resync(uri, version, text);
}

export function lspDidSave(uri: string, text: string): void {
  for (const server of bound(uri)) server.didSave(uri, text);
}

export function lspDidClose(uri: string): void {
  const bindings = uriToServers.get(uri);
  uriToServers.delete(uri);
  for (const server of bindings ?? []) server.didClose(uri);
}

export function lspCancel(cancelKey: string): void {
  for (const server of servers.values()) server.cancel(cancelKey);
}

/** Hover from every server, concatenated — tsserver types plus ESLint rule docs. */
export async function lspHover(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspHoverResult> {
  const running = bound(uri).filter((server) => server.isRunning);
  const results = await Promise.all(
    running.map((server) => server.hover(uri, line, character, cancelKey).catch(() => null)),
  );
  const parts: string[] = [];
  let range: LspRange | undefined;
  for (const result of results) {
    if (!result || result.contents.length === 0) continue;
    parts.push(result.contents);
    if (!range && result.range) range = result.range;
  }
  const out: LspHoverResult = { contents: parts.join('\n\n---\n\n') };
  if (range) out.range = range;
  return out;
}

export async function lspCompletion(
  uri: string,
  line: number,
  character: number,
  context?: LspCompletionContext,
  cancelKey?: string,
): Promise<LspCompletionResult> {
  const running = bound(uri).filter((server) => server.isRunning);
  if (running.length === 0) return { items: [] };
  const results = await Promise.all(
    running.map((server) =>
      server
        .completion(uri, line, character, context, cancelKey)
        .then((result) => ({ serverId: server.id, result }))
        .catch(() => null),
    ),
  );
  const items: LspCompletionItem[] = [];
  let isIncomplete = false;
  for (const entry of results) {
    if (!entry) continue;
    if (entry.result.isIncomplete) isIncomplete = true;
    for (const item of entry.result.items) {
      // Tag the handle with its owning server so resolve routes back correctly.
      if (item.id !== undefined) item.id = encodeHandle(entry.serverId, item.id);
      items.push(item);
    }
  }
  return { items, isIncomplete };
}

/**
 * Handles cross the IPC boundary as plain numbers, so the owning server id is
 * packed into the value rather than trusted from the renderer.
 */
const handleServers: string[] = [];
function encodeHandle(serverId: string, localId: number): number {
  let index = handleServers.indexOf(serverId);
  if (index < 0) {
    handleServers.push(serverId);
    index = handleServers.length - 1;
  }
  return index * 1_000_000 + (localId % 1_000_000);
}
function decodeHandle(handle: number): { serverId: string; localId: number } | null {
  if (!Number.isSafeInteger(handle) || handle < 0) return null;
  const serverId = handleServers[Math.floor(handle / 1_000_000)];
  if (serverId === undefined) return null;
  return { serverId, localId: handle % 1_000_000 };
}

export async function lspResolveCompletion(
  uri: string,
  handle: number,
): Promise<LspCompletionItem | null> {
  const decoded = decodeHandle(handle);
  if (!decoded) return null;
  const server = bound(uri).find((entry) => entry.id === decoded.serverId);
  if (!server) return null;
  const resolved = await server.resolveCompletion(uri, decoded.localId).catch(() => null);
  if (resolved && resolved.id !== undefined) resolved.id = handle;
  return resolved;
}

export function lspDefinition(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspLocationResult> {
  return firstNonEmpty(
    uri,
    (server) => server.definition(uri, line, character, cancelKey),
    (value) => value.locations.length === 0,
    { locations: [] },
  );
}

export function lspDeclaration(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspLocationResult> {
  return firstNonEmpty(
    uri,
    (server) => server.declaration(uri, line, character, cancelKey),
    (value) => value.locations.length === 0,
    { locations: [] },
  );
}

export function lspTypeDefinition(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspLocationResult> {
  return firstNonEmpty(
    uri,
    (server) => server.typeDefinition(uri, line, character, cancelKey),
    (value) => value.locations.length === 0,
    { locations: [] },
  );
}

export function lspImplementation(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspLocationResult> {
  return firstNonEmpty(
    uri,
    (server) => server.implementation(uri, line, character, cancelKey),
    (value) => value.locations.length === 0,
    { locations: [] },
  );
}

export function lspReferences(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspLocationResult> {
  return firstNonEmpty(
    uri,
    (server) => server.references(uri, line, character, cancelKey),
    (value) => value.locations.length === 0,
    { locations: [] },
  );
}

export function lspDocumentHighlight(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspDocumentHighlightResult> {
  return firstNonEmpty(
    uri,
    (server) => server.documentHighlight(uri, line, character, cancelKey),
    (value) => value.highlights.length === 0,
    { highlights: [] },
  );
}

export function lspPrepareRename(
  uri: string,
  line: number,
  character: number,
): Promise<LspPrepareRenameResult> {
  return firstNonEmpty(
    uri,
    (server) => server.prepareRename(uri, line, character),
    (value) => value.range === null && value.placeholder === undefined,
    { range: null },
  );
}

export function lspRename(
  uri: string,
  line: number,
  character: number,
  newName: string,
): Promise<LspWorkspaceEdit> {
  return firstNonEmpty(
    uri,
    (server) => server.rename(uri, line, character, newName),
    (value) => Object.keys(value.changes).length === 0,
    { changes: {} },
  );
}

export function lspSignatureHelp(
  uri: string,
  line: number,
  character: number,
  cancelKey?: string,
): Promise<LspSignatureHelp> {
  return firstNonEmpty(
    uri,
    (server) => server.signatureHelp(uri, line, character, cancelKey),
    (value) => value.signatures.length === 0,
    { signatures: [] },
  );
}

export async function lspCodeAction(
  uri: string,
  range: LspRange,
  diagnostics: LspDiagnostic[],
  only?: string[],
  cancelKey?: string,
): Promise<LspCodeAction[]> {
  const running = bound(uri).filter((server) => server.isRunning);
  if (running.length === 0) return [];
  const results = await Promise.all(
    running.map((server) =>
      server
        .codeAction(uri, range, diagnostics, only, cancelKey)
        .then((actions) => ({ serverId: server.id, actions }))
        .catch(() => null),
    ),
  );
  const out: LspCodeAction[] = [];
  for (const entry of results) {
    if (!entry) continue;
    for (const action of entry.actions) {
      if (action.id !== undefined) action.id = encodeHandle(entry.serverId, action.id);
      out.push(action);
    }
  }
  return out;
}

export async function lspResolveCodeAction(
  uri: string,
  handle: number,
): Promise<LspCodeAction | null> {
  const decoded = decodeHandle(handle);
  if (!decoded) return null;
  const server = bound(uri).find((entry) => entry.id === decoded.serverId);
  if (!server) return null;
  const resolved = await server.resolveCodeAction(decoded.localId).catch(() => null);
  if (resolved && resolved.id !== undefined) resolved.id = handle;
  return resolved;
}

/**
 * Execute the command belonging to a code action the renderer was previously
 * offered. The handle identifies Main's retained copy, so the renderer chooses
 * WHICH action runs but never dictates WHAT runs.
 */
export async function lspExecuteCodeAction(uri: string, handle: number): Promise<boolean> {
  const decoded = decodeHandle(handle);
  if (!decoded) return false;
  const server = bound(uri).find((entry) => entry.id === decoded.serverId);
  if (!server || !server.isRunning) return false;
  return server.executeCodeActionCommand(decoded.localId).catch(() => false);
}

/** Same contract for the command a completion item carries (auto-import fixers). */
export async function lspExecuteCompletionCommand(uri: string, handle: number): Promise<boolean> {
  const decoded = decodeHandle(handle);
  if (!decoded) return false;
  const server = bound(uri).find((entry) => entry.id === decoded.serverId);
  if (!server || !server.isRunning) return false;
  return server.executeCompletionCommand(decoded.localId).catch(() => false);
}

export function lspDocumentSymbol(uri: string, cancelKey?: string): Promise<LspDocumentSymbol[]> {
  return firstNonEmpty(
    uri,
    (server) => server.documentSymbol(uri, cancelKey),
    (value) => value.length === 0,
    [],
  );
}

export async function lspWorkspaceSymbol(
  uri: string,
  query: string,
  cancelKey?: string,
): Promise<LspSymbolInformation[]> {
  return mergeAll(uri, (server) => server.workspaceSymbol(query, cancelKey));
}

export function lspInlayHint(
  uri: string,
  range: LspRange,
  cancelKey?: string,
): Promise<LspInlayHint[]> {
  return mergeAll(uri, (server) => server.inlayHint(uri, range, cancelKey));
}

export function lspFoldingRange(uri: string, cancelKey?: string): Promise<LspFoldingRange[]> {
  return firstNonEmpty(
    uri,
    (server) => server.foldingRange(uri, cancelKey),
    (value) => value.length === 0,
    [],
  );
}

export function lspSelectionRange(
  uri: string,
  positions: Array<{ line: number; character: number }>,
): Promise<LspRange[]> {
  return firstNonEmpty(
    uri,
    (server) => server.selectionRange(uri, positions),
    (value) => value.length === 0,
    [],
  );
}

export function lspDocumentLink(uri: string, cancelKey?: string): Promise<LspDocumentLink[]> {
  return mergeAll(uri, (server) => server.documentLink(uri, cancelKey));
}

/** The merged legend across bound servers, plus the id of the one providing it. */
export function lspSemanticTokensLegend(uri: string): LspSemanticTokensLegend | null {
  for (const server of bound(uri)) {
    const legend = server.semanticTokensLegend();
    if (legend) return legend;
  }
  return null;
}

export async function lspSemanticTokens(
  uri: string,
  cancelKey?: string,
): Promise<LspSemanticTokens | null> {
  for (const server of bound(uri)) {
    if (!server.isRunning || !server.semanticTokensLegend()) continue;
    const tokens = await server.semanticTokens(uri, cancelKey).catch(() => null);
    if (tokens) return tokens;
  }
  return null;
}

/** Pull diagnostics from every server that supports them, tagged per server. */
export async function lspPullDiagnostics(
  uri: string,
  cancelKey?: string,
): Promise<LspDiagnosticsEvent[]> {
  const running = bound(uri).filter((server) => server.isRunning);
  const out: LspDiagnosticsEvent[] = [];
  await Promise.all(
    running.map(async (server) => {
      const diagnostics = await server.pullDiagnostics(uri, cancelKey).catch(() => null);
      if (diagnostics) out.push({ uri, diagnostics, serverId: server.id });
    }),
  );
  return out;
}

/**
 * Formatting order matters: a project that configures Prettier or ESLint expects
 * those to win over the language server's built-in formatter.
 */
const FORMATTER_PRIORITY = ['prettier', 'eslint'];

function formattingOrder(uri: string): LspServer[] {
  return [...bound(uri)].sort((a, b) => {
    const ai = FORMATTER_PRIORITY.indexOf(a.id);
    const bi = FORMATTER_PRIORITY.indexOf(b.id);
    return (ai < 0 ? FORMATTER_PRIORITY.length : ai) - (bi < 0 ? FORMATTER_PRIORITY.length : bi);
  });
}

export async function lspFormatting(
  uri: string,
  tabSize: number,
  insertSpaces: boolean,
): Promise<LspTextEdit[]> {
  for (const server of formattingOrder(uri)) {
    if (!server.isRunning) continue;
    const edits = await server.formatting(uri, tabSize, insertSpaces).catch(() => []);
    if (edits.length > 0) return edits;
  }
  return [];
}

export async function lspRangeFormatting(
  uri: string,
  range: LspRange,
  tabSize: number,
  insertSpaces: boolean,
): Promise<LspTextEdit[]> {
  for (const server of formattingOrder(uri)) {
    if (!server.isRunning) continue;
    const edits = await server.rangeFormatting(uri, range, tabSize, insertSpaces).catch(() => []);
    if (edits.length > 0) return edits;
  }
  return [];
}

export async function lspOnTypeFormatting(
  uri: string,
  line: number,
  character: number,
  ch: string,
  tabSize: number,
  insertSpaces: boolean,
): Promise<LspTextEdit[]> {
  for (const server of formattingOrder(uri)) {
    if (!server.isRunning) continue;
    const edits = await server
      .onTypeFormatting(uri, line, character, ch, tabSize, insertSpaces)
      .catch(() => []);
    if (edits.length > 0) return edits;
  }
  return [];
}

/**
 * Running servers that actually negotiated document formatting.
 *
 * Read from the live `initialize` result rather than from the static catalog, because
 * whether a server formats depends on the server build and the project — the catalog only
 * says which server *might* answer for a language. The AI capability context uses this to
 * say "formatting is already available" without guessing.
 */
export function lspFormattingProviders(
  rootPath: string | null,
): Array<{ id: string; displayName: string; languageIds: string[] }> {
  const rootKey = rootPath ? pathKey(rootPath) : null;
  const out: Array<{ id: string; displayName: string; languageIds: string[] }> = [];
  for (const server of servers.values()) {
    if (rootKey && pathKey(server.rootPath) !== rootKey) continue;
    if (!server.isRunning) continue;
    const negotiated = server.capabilities;
    if (negotiated.formatting !== true && negotiated.rangeFormatting !== true) continue;
    const status = server.status();
    out.push({ id: status.id, displayName: status.displayName, languageIds: status.languageIds });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Every server instance's health, for the status bar and output view. */
export function lspServerStatuses(rootPath: string | null): LspServerStatus[] {
  const rootKey = rootPath ? pathKey(rootPath) : null;
  const out: LspServerStatus[] = [];
  for (const server of servers.values()) {
    if (rootKey && pathKey(server.rootPath) !== rootKey) continue;
    out.push(server.status());
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Restart one server on demand (the user-facing recovery path). */
export async function lspRestartServer(rootPath: string, serverId: string): Promise<void> {
  const key = `${serverId}\0${pathKey(rootPath)}`;
  const server = servers.get(key);
  if (!server) return;
  const uris: string[] = [];
  for (const [uri, owners] of uriToServers) {
    if (owners.includes(server)) uris.push(uri);
  }
  servers.delete(key);
  for (const uri of uris) {
    const owners = (uriToServers.get(uri) ?? []).filter((entry) => entry !== server);
    if (owners.length > 0) uriToServers.set(uri, owners);
    else uriToServers.delete(uri);
  }
  await server.dispose();
  statusHandler?.({ ...server.status(), state: 'stopped', restarts: 0 });
}

export function onLspDiagnostics(handler: (evt: LspDiagnosticsEvent) => void): void {
  diagnosticsHandler = handler;
  for (const server of servers.values()) server.setHandlers({ diagnostics: handler });
}

export function onLspServerStatus(handler: (status: LspServerStatus) => void): void {
  statusHandler = handler;
  for (const server of servers.values()) server.setHandlers({ status: handler });
}

export function onLspLog(handler: (evt: LspLogEvent) => void): void {
  logHandler = handler;
  for (const server of servers.values()) server.setHandlers({ log: handler });
}

/**
 * Register the handler that applies a server-requested `workspace/applyEdit`.
 * Main validates and routes it; the renderer never receives a raw server edit.
 */
export function onLspApplyEdit(
  handler: (root: string, edit: LspWorkspaceEdit) => Promise<boolean>,
): void {
  applyEditHandler = handler;
  for (const server of servers.values()) server.setHandlers({ applyEdit: handler });
}

export async function disposeLspForWorkspace(root: string): Promise<void> {
  const rootKey = pathKey(root);
  const disposals: Promise<void>[] = [];
  for (const [key, server] of servers) {
    if (pathKey(server.rootPath) !== rootKey) continue;
    for (const [uri, owners] of uriToServers) {
      const remaining = owners.filter((entry) => entry !== server);
      if (remaining.length === 0) uriToServers.delete(uri);
      else uriToServers.set(uri, remaining);
    }
    servers.delete(key);
    disposals.push(server.dispose());
  }
  await Promise.all(disposals);
}

export async function disposeLsp(): Promise<void> {
  const disposals = [...servers.values()].map((server) => server.dispose());
  servers.clear();
  uriToServers.clear();
  await Promise.all(disposals);
}
