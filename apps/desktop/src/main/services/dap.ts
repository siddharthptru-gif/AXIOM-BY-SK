import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Socket } from 'node:net';
import { buildChildProcessEnvironment } from './processEnvironment';
import { terminateProcessTree } from './processTree';
import { rootLogger } from '@axiom/shared';
import type {
  DebugControlAction,
  DebugBreakpoint,
  DebugEvalResult,
  DebugEvent,
  DebugLaunchConfig,
  DebugScope,
  DebugStackFrame,
  DebugStartResult,
  DebugState,
  DebugVariable,
} from '../../common/ipc';

/**
 * Debug Adapter Protocol client + session (PRD Epoch D, Phases 96–101). Drives the
 * initialize → launch → setBreakpoints → configurationDone handshake, forwards
 * stopped/output/terminated events to the renderer, and exposes stepping +
 * stack/scope/variable queries. Adapter-agnostic — the config supplies the command,
 * so any DAP adapter (debugpy, js-debug, …) can be wired in.
 *
 * Two transports, because real adapters are split between them:
 *  - `stdio`  — the adapter speaks DAP on its own stdin/stdout (debugpy).
 *  - `server` — the adapter listens for DAP on a TCP port (js-debug, the standard
 *    Node/TypeScript debugger). We reserve a free LOOPBACK port, hand it to the
 *    adapter, and connect to 127.0.0.1 only. Nothing binds a routable interface.
 *
 * Multi-target adapters (js-debug) do not debug the program on the session you
 * launched: they ask the client, via the reverse `startDebugging` request, to open a
 * CHILD session where the real debuggee lives. That is where breakpoints bind and
 * `stopped` fires, so this client implements the reverse request and routes
 * stepping/inspection to the child that last stopped. Without it, Node debugging
 * connects and then silently never hits a breakpoint.
 */
const log = rootLogger.child('dap');
const REQUEST_TIMEOUT_MS = 20_000;
/** How long an adapter may take to start listening before we give up. */
const ADAPTER_LISTEN_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 120;
const MAX_CHILD_SESSIONS = 8;
const LOOPBACK_HOST = '127.0.0.1';
/** Placeholder an adapter's args may use for the port we reserved. */
const PORT_TOKEN = '${port}';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function toDapBreakpoints(bps: DebugBreakpoint[]): Array<Record<string, unknown>> {
  return bps.map((b) => ({
    line: b.line,
    ...(b.condition ? { condition: b.condition } : {}),
    ...(b.logMessage ? { logMessage: b.logMessage } : {}),
  }));
}

/**
 * Client capabilities. `supportsStartDebuggingRequest` is required for js-debug to
 * ever reach the debuggee, and is safe for single-session adapters (they ignore it).
 */
const INITIALIZE_ARGS: Record<string, unknown> = {
  clientID: 'axiom',
  clientName: 'Axiom',
  adapterID: 'axiom',
  locale: 'en',
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: 'path',
  supportsRunInTerminalRequest: false,
  supportsStartDebuggingRequest: true,
  supportsVariableType: true,
  supportsVariablePaging: false,
  supportsProgressReporting: false,
  supportsMemoryReferences: false,
};

type EventSink = (event: DebugEvent) => void;

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Reserve a free loopback port by binding it, reading it back, then releasing it. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: Error) => reject(error));
    probe.listen({ port: 0, host: LOOPBACK_HOST, exclusive: true }, () => {
      const address = probe.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('Could not reserve a loopback port for the debug adapter.'));
      });
    });
  });
}

/** Connect to the adapter's loopback port, retrying while it boots. */
function connectLoopback(port: number, timeoutMs: number, aborted: () => boolean): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<Socket>((resolve, reject) => {
    const attempt = (): void => {
      if (aborted()) {
        reject(new Error('The debug adapter exited before it accepted a connection.'));
        return;
      }
      const socket = connect({ port, host: LOOPBACK_HOST });
      const onError = (): void => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`The debug adapter never listened on ${LOOPBACK_HOST}:${port}.`));
        } else {
          setTimeout(attempt, CONNECT_RETRY_MS);
        }
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        socket.setNoDelay(true);
        resolve(socket);
      });
    };
    attempt();
  });
}

/** Substitute the reserved port into the adapter args, or append it. */
function substitutePort(args: readonly string[], port: number): string[] {
  const replaced = args.map((arg) => arg.split(PORT_TOKEN).join(String(port)));
  const changed = replaced.some((arg, index) => arg !== args[index]);
  return changed ? replaced : [...replaced, String(port)];
}

// ---- wire framing ------------------------------------------------------------

/** DAP message framing (Content-Length headers, like LSP) over any byte stream. */
class DapWire {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;

  constructor(
    private readonly out: (chunk: Buffer) => void,
    private readonly onMessage: (message: Record<string, unknown>) => void,
  ) {}

  send(message: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(message), 'utf-8');
    this.out(Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'));
    this.out(payload);
  }

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /content-length:\s*(\d+)/i.exec(header);
        this.contentLength = match?.[1] ? Number.parseInt(match[1], 10) : 0;
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }
      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength).toString('utf-8');
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      let parsed: Record<string, unknown>;
      try {
        parsed = asObj(JSON.parse(body));
      } catch {
        continue;
      }
      this.onMessage(parsed);
    }
  }
}

interface ConnectionHooks {
  onEvent: (connection: DapConnection, event: string, body: Record<string, unknown>) => void;
  onReverseRequest: (
    connection: DapConnection,
    requestSeq: number,
    command: string,
    args: Record<string, unknown>,
  ) => void;
}

/** One DAP conversation (root adapter session or a child target session). */
class DapConnection {
  private seq = 1;
  private disposed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly wire: DapWire;

  constructor(
    readonly label: string,
    out: (chunk: Buffer) => void,
    private readonly hooks: ConnectionHooks,
  ) {
    this.wire = new DapWire(out, (message) => this.dispatch(message));
  }

  feed(chunk: Buffer): void {
    if (!this.disposed) this.wire.feed(chunk);
  }

  private dispatch(message: Record<string, unknown>): void {
    const type = str(message.type);
    if (type === 'response') {
      const requestSeq = num(message.request_seq);
      const pending = this.pending.get(requestSeq);
      if (!pending) return;
      this.pending.delete(requestSeq);
      clearTimeout(pending.timer);
      if (message.success === true) pending.resolve(message.body);
      else pending.reject(new Error(str(message.message, `${str(message.command)} failed`)));
      return;
    }
    if (type === 'event') {
      this.hooks.onEvent(this, str(message.event), asObj(message.body));
      return;
    }
    if (type === 'request') {
      this.hooks.onReverseRequest(
        this,
        num(message.seq),
        str(message.command),
        asObj(message.arguments),
      );
    }
  }

  request(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('debug session ended'));
    const seq = this.seq++;
    this.wire.send({ seq, type: 'request', command, arguments: args });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(seq)) reject(new Error(`DAP ${command} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
    });
  }

  /** Answer an adapter-initiated (reverse) request so the adapter never stalls. */
  respond(requestSeq: number, command: string, success: boolean, message?: string): void {
    if (this.disposed) return;
    this.wire.send({
      seq: this.seq++,
      type: 'response',
      request_seq: requestSeq,
      command,
      success,
      ...(message !== undefined ? { message } : {}),
    });
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// ---- session -----------------------------------------------------------------

class DapSession {
  private proc: ChildProcess | null = null;
  private rootConn: DapConnection | null = null;
  private activeConn: DapConnection | null = null;
  private readonly children = new Set<DapConnection>();
  private readonly sockets = new Set<Socket>();
  private serverPort: number | null = null;
  private breakpoints = new Map<string, DebugBreakpoint[]>();
  private tearingDown = false;
  private readonly sink: EventSink;
  state: DebugState = 'inactive';

  private readonly hooks: ConnectionHooks = {
    onEvent: (connection, event, body) => this.onEvent(connection, event, body),
    onReverseRequest: (connection, requestSeq, command, args) =>
      this.onReverseRequest(connection, requestSeq, command, args),
  };

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  /** The session that stepping / inspection applies to: the target that stopped. */
  private target(): DapConnection | null {
    return this.activeConn ?? this.rootConn;
  }

  private setState(
    state: DebugState,
    reason: string | null = null,
    threadId: number | null = null,
  ): void {
    this.state = state;
    this.sink({ kind: 'state', state, threadId, reason });
  }

  private output(category: string, output: string): void {
    this.sink({ kind: 'output', category, output });
  }

  private procExited(): boolean {
    const proc = this.proc;
    return proc === null || proc.exitCode !== null || proc.signalCode !== null;
  }

  // ---- events -------------------------------------------------------------
  private onEvent(connection: DapConnection, event: string, body: Record<string, unknown>): void {
    switch (event) {
      case 'initialized':
        void this.configure(connection);
        break;
      case 'stopped':
        // The target that stopped owns the stack the user is about to inspect.
        this.activeConn = connection;
        this.setState(
          'stopped',
          str(body.reason, 'stopped'),
          body.threadId == null ? null : num(body.threadId),
        );
        break;
      case 'continued':
        this.setState('running');
        break;
      case 'output':
        this.output(str(body.category, 'console'), str(body.output));
        break;
      case 'terminated':
      case 'exited':
        this.onConnectionEnded(connection);
        break;
      default:
        break;
    }
  }

  /** A target finished. The run is over once no child target remains. */
  private onConnectionEnded(connection: DapConnection): void {
    if (this.tearingDown) return;
    if (this.children.delete(connection)) {
      connection.dispose('debug session ended');
      if (this.activeConn === connection) this.activeConn = null;
      if (this.children.size > 0) return;
    }
    if (this.state !== 'terminated') this.setState('terminated');
    void this.teardown();
  }

  private async configure(connection: DapConnection): Promise<void> {
    for (const [path, bps] of this.breakpoints) {
      await connection
        .request('setBreakpoints', { source: { path }, breakpoints: toDapBreakpoints(bps) })
        .catch(() => undefined);
    }
    await connection.request('configurationDone', {}).catch(() => undefined);
  }

  private onReverseRequest(
    connection: DapConnection,
    requestSeq: number,
    command: string,
    args: Record<string, unknown>,
  ): void {
    if (command === 'startDebugging') {
      void this.startChildSession(connection, requestSeq, args);
      return;
    }
    if (command === 'runInTerminal') {
      connection.respond(
        requestSeq,
        command,
        false,
        'Axiom runs debuggees on the internal console; set console to "internalConsole".',
      );
      return;
    }
    // Decline anything else explicitly rather than leaving the adapter waiting.
    connection.respond(requestSeq, command, false, `Unsupported reverse request: ${command}`);
  }

  /**
   * Open the child session a multi-target adapter asked for. The child carries the
   * real debuggee, so it becomes the active target for stepping and inspection.
   */
  private async startChildSession(
    parent: DapConnection,
    requestSeq: number,
    args: Record<string, unknown>,
  ): Promise<void> {
    const port = this.serverPort;
    if (port === null) {
      parent.respond(
        requestSeq,
        'startDebugging',
        false,
        'Child debug sessions require a server-transport adapter.',
      );
      return;
    }
    if (this.children.size >= MAX_CHILD_SESSIONS) {
      parent.respond(requestSeq, 'startDebugging', false, 'Child debug session limit reached.');
      return;
    }
    const configuration = asObj(args.configuration);
    const request = args.request === 'attach' ? 'attach' : 'launch';
    try {
      const connection = await this.openServerConnection(port, `child-${this.children.size + 1}`);
      this.children.add(connection);
      this.activeConn = connection;
      parent.respond(requestSeq, 'startDebugging', true);
      await connection.request('initialize', INITIALIZE_ARGS);
      void connection.request(request, configuration).catch((error: Error) => {
        this.output('stderr', `child ${request} failed: ${error.message}\n`);
      });
    } catch (error) {
      parent.respond(
        requestSeq,
        'startDebugging',
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ---- transports ---------------------------------------------------------
  private spawnAdapter(config: DebugLaunchConfig, args: string[]): ChildProcess {
    const proc = spawn(config.adapterCommand, args, {
      cwd: config.cwd,
      env: buildChildProcessEnvironment({ color: false }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.proc = proc;
    proc.on('error', (error: Error) => {
      this.output('stderr', `adapter error: ${error.message}\n`);
      if (this.state !== 'terminated') this.setState('terminated');
      void this.teardown();
    });
    proc.on('exit', () => {
      if (this.state !== 'terminated') this.setState('terminated');
      void this.teardown();
    });
    return proc;
  }

  private async openServerConnection(port: number, label: string): Promise<DapConnection> {
    const socket = await connectLoopback(
      port,
      ADAPTER_LISTEN_TIMEOUT_MS,
      () => this.tearingDown || this.procExited(),
    );
    this.sockets.add(socket);
    const connection = new DapConnection(
      label,
      (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      },
      this.hooks,
    );
    socket.on('data', (chunk: Buffer) => connection.feed(chunk));
    // Socket faults surface through 'close' below; swallow to avoid an unhandled throw.
    socket.on('error', () => undefined);
    socket.once('close', () => {
      this.sockets.delete(socket);
      connection.dispose('debug connection closed');
      this.onConnectionEnded(connection);
    });
    return connection;
  }

  private async startStdio(config: DebugLaunchConfig): Promise<void> {
    const proc = this.spawnAdapter(config, [...config.adapterArgs]);
    const { stdin, stdout, stderr } = proc;
    if (!stdin || !stdout) {
      throw new Error('The debug adapter did not expose a stdio channel.');
    }
    const connection = new DapConnection(
      'adapter',
      (chunk) => {
        if (stdin.writable) stdin.write(chunk);
      },
      this.hooks,
    );
    this.rootConn = connection;
    this.activeConn = connection;
    stdout.on('data', (chunk: Buffer) => connection.feed(chunk));
    stderr?.on('data', (chunk: Buffer) => this.output('stderr', chunk.toString('utf-8')));
    await this.handshake(connection, config);
  }

  private async startServer(config: DebugLaunchConfig): Promise<void> {
    const port = await reserveLoopbackPort();
    this.serverPort = port;
    const proc = this.spawnAdapter(config, substitutePort(config.adapterArgs, port));
    // On this transport the adapter's own stdio is just its log; DAP runs on the socket.
    proc.stdout?.on('data', (chunk: Buffer) => this.output('console', chunk.toString('utf-8')));
    proc.stderr?.on('data', (chunk: Buffer) => this.output('stderr', chunk.toString('utf-8')));
    const connection = await this.openServerConnection(port, 'adapter');
    this.rootConn = connection;
    this.activeConn = connection;
    await this.handshake(connection, config);
  }

  private async handshake(connection: DapConnection, config: DebugLaunchConfig): Promise<void> {
    this.setState('initializing');
    await connection.request('initialize', INITIALIZE_ARGS);
    // Fire launch/attach; its response arrives after configurationDone (sent on the
    // 'initialized' event), so we must not await it here (would deadlock).
    void connection.request(config.request, config.launchArgs).catch((error: Error) => {
      this.output('stderr', `${config.request} failed: ${error.message}\n`);
      if (this.state !== 'terminated') this.setState('terminated');
      void this.teardown();
    });
    this.setState('running');
  }

  // ---- lifecycle ----------------------------------------------------------
  async start(
    config: DebugLaunchConfig,
    breakpoints: Record<string, DebugBreakpoint[]>,
  ): Promise<void> {
    this.breakpoints = new Map(Object.entries(breakpoints));
    if (config.transport === 'server') await this.startServer(config);
    else await this.startStdio(config);
  }

  private connections(): DapConnection[] {
    const all: DapConnection[] = [...this.children];
    if (this.rootConn) all.push(this.rootConn);
    return all;
  }

  async setBreakpoints(path: string, breakpoints: DebugBreakpoint[]): Promise<void> {
    this.breakpoints.set(path, breakpoints);
    for (const connection of this.connections()) {
      await connection
        .request('setBreakpoints', { source: { path }, breakpoints: toDapBreakpoints(breakpoints) })
        .catch(() => undefined);
    }
  }

  async evaluate(
    expression: string,
    frameId: number | null,
    context: string,
  ): Promise<DebugEvalResult> {
    const connection = this.target();
    if (!connection) {
      return { result: 'no active debug session', variablesReference: 0, ok: false };
    }
    try {
      const args: Record<string, unknown> = { expression, context };
      if (frameId != null) args.frameId = frameId;
      const body = asObj(await connection.request('evaluate', args));
      return {
        result: str(body.result),
        variablesReference: num(body.variablesReference),
        ok: true,
      };
    } catch (e) {
      return {
        result: e instanceof Error ? e.message : 'evaluation failed',
        variablesReference: 0,
        ok: false,
      };
    }
  }

  async control(action: DebugControlAction, threadId: number): Promise<void> {
    const connection = this.target();
    if (!connection) return;
    if (action === 'continue') this.setState('running');
    await connection
      .request(action, { threadId })
      .catch((e: Error) => log.debug('control failed', { action, error: e.message }));
  }

  private async query(
    command: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const connection = this.target();
    if (!connection) return {};
    return asObj(await connection.request(command, args).catch(() => ({})));
  }

  async threads(): Promise<Array<{ id: number; name: string }>> {
    const body = await this.query('threads', {});
    return asArr(body.threads).map((t) => {
      const o = asObj(t);
      return { id: num(o.id), name: str(o.name, `Thread ${num(o.id)}`) };
    });
  }

  async stackTrace(threadId: number): Promise<DebugStackFrame[]> {
    const body = await this.query('stackTrace', { threadId, startFrame: 0, levels: 20 });
    return asArr(body.stackFrames).map((f) => {
      const o = asObj(f);
      const source = asObj(o.source);
      return {
        id: num(o.id),
        name: str(o.name),
        path: typeof source.path === 'string' ? source.path : null,
        line: num(o.line),
        column: num(o.column),
      };
    });
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const body = await this.query('scopes', { frameId });
    return asArr(body.scopes).map((s) => {
      const o = asObj(s);
      return {
        name: str(o.name),
        variablesReference: num(o.variablesReference),
        expensive: o.expensive === true,
      };
    });
  }

  async variables(variablesReference: number): Promise<DebugVariable[]> {
    const body = await this.query('variables', { variablesReference });
    return asArr(body.variables).map((v) => {
      const o = asObj(v);
      return {
        name: str(o.name),
        value: str(o.value),
        type: typeof o.type === 'string' ? o.type : null,
        variablesReference: num(o.variablesReference),
      };
    });
  }

  async stop(): Promise<void> {
    const connections = this.connections();
    if (connections.length > 0) {
      await Promise.race([
        Promise.allSettled(
          connections.map((connection) =>
            connection.request('disconnect', { terminateDebuggee: true }),
          ),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    await this.teardown();
    if (this.state !== 'terminated') this.setState('terminated');
  }

  private async teardown(): Promise<void> {
    if (this.tearingDown) return;
    this.tearingDown = true;
    for (const connection of this.children) connection.dispose('debug session ended');
    this.children.clear();
    this.rootConn?.dispose('debug session ended');
    this.rootConn = null;
    this.activeConn = null;
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // Already closed.
      }
    }
    this.sockets.clear();
    this.serverPort = null;
    const proc = this.proc;
    this.proc = null;
    if (proc) await terminateProcessTree(proc);
  }
}

// ---- module-level session manager -------------------------------------------

let session: DapSession | null = null;
let sink: EventSink = () => undefined;

export function setDebugEventSink(fn: EventSink): void {
  sink = fn;
}

export async function debugStart(
  config: DebugLaunchConfig,
  breakpoints: Record<string, DebugBreakpoint[]>,
): Promise<DebugStartResult> {
  if (session) await session.stop().catch(() => undefined);
  const next = new DapSession((e) => sink(e));
  session = next;
  try {
    await next.start(config, breakpoints);
    return { ok: true };
  } catch (e) {
    await next.stop().catch(() => undefined);
    if (session === next) session = null;
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function debugControl(action: DebugControlAction, threadId: number): Promise<void> {
  return session?.control(action, threadId) ?? Promise.resolve();
}
export function debugSetBreakpoints(path: string, breakpoints: DebugBreakpoint[]): Promise<void> {
  return session?.setBreakpoints(path, breakpoints) ?? Promise.resolve();
}
export function debugEvaluate(
  expression: string,
  frameId: number | null,
): Promise<DebugEvalResult> {
  return (
    session?.evaluate(expression, frameId, 'watch') ??
    Promise.resolve({ result: '', variablesReference: 0, ok: false })
  );
}
export function debugStackTrace(threadId: number): Promise<DebugStackFrame[]> {
  return session?.stackTrace(threadId) ?? Promise.resolve([]);
}
export function debugScopes(frameId: number): Promise<DebugScope[]> {
  return session?.scopes(frameId) ?? Promise.resolve([]);
}
export function debugVariables(ref: number): Promise<DebugVariable[]> {
  return session?.variables(ref) ?? Promise.resolve([]);
}
export async function debugStop(): Promise<void> {
  if (session) {
    await session.stop().catch(() => undefined);
    session = null;
  }
}
export function disposeDebug(): Promise<void> {
  return debugStop();
}
