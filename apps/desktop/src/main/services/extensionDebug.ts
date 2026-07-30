/**
 * The extension debug runtime (PRD Phase 7 §3).
 *
 * A debug adapter is a program AXIOM starts on an extension's word and then speaks a protocol to that
 * can read files, evaluate expressions and launch further programs on the debuggee's behalf. So this
 * file is arranged around the transport, and everything decidable without one lives in
 * `common/vscodeDebugRuntime` — the DAP framing, the configuration and descriptor validation, the
 * registries, the session tree, the console ring.
 *
 * What is left here is the part that has I/O in it, in this order:
 *
 *   1. the workspace must be trusted before any adapter starts (the gate tasks and terminals use);
 *   2. a `startDebugging` folder must be inside the workspace;
 *   3. the configuration is resolved by every provider registered for the type, in upstream's order;
 *   4. the extension that registered the factory for the type says how the adapter is started;
 *   5. only then is a process spawned, a loopback socket opened, or — for an inline adapter — nothing
 *      started at all, because the extension itself is the adapter.
 *
 * Four transports, one interface. `AdapterDescriptorKind` is the only thing the rest of the file knows
 * about how a session's bytes move, which is what keeps `DebugAdapterInlineImplementation` — an adapter
 * with no process anywhere — from being a special case in every function.
 *
 * AXIOM's own debug UI keeps its client (`main/services/dap.ts`, one session, driven by the workbench).
 * This is the multi-session half extensions need, and the two do not share state: an extension's
 * sessions are torn down with the extension, and the workbench's session is not an extension's to stop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';

import { rootLogger } from '@axiom/shared';
import type { ExtensionDebugSessionInfo } from '../../common/ipc';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  DebugAdapterFactoryRegistry,
  DebugConfigProviderRegistry,
  DebugConsoleBuffer,
  DebugSessionRegistry,
  DapMessageReader,
  MAX_DAP_PENDING,
  encodeDapMessage,
  normalizeAdapterDescriptor,
  normalizeDebugConfiguration,
  normalizeTriggerKind,
  validateOutboundDapMessage,
  type AdapterDescriptorData,
  type AdapterDescriptorKind,
  type DapMessage,
  type DebugConfigurationData,
  type DebugSessionRecord,
} from '../../common/vscodeDebugRuntime';
import { assertAuthorizedPath } from './pathAuthorization';
import { buildChildProcessEnvironment } from './processEnvironment';
import { terminateProcessTree } from './processTree';
import { assertWorkspaceTrusted } from './workspaceTrust';

const log = rootLogger.child('extension-debug');

/** How long a `provideDebugConfigurations` / `resolveDebugConfiguration` round trip gets. */
const RESOLVE_TIMEOUT_MS = 15_000;
/** How long `createDebugAdapterDescriptor` gets to say how the adapter is started. */
const DESCRIPTOR_TIMEOUT_MS = 15_000;
/** How long a `server` or `namedPipe` adapter gets to accept a connection. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Delay between connection attempts while an adapter is still coming up. */
const CONNECT_RETRY_MS = 120;
/** How long a DAP request AXIOM sent waits for its response. */
const REQUEST_TIMEOUT_MS = 20_000;
/** Grace given to `disconnect` before the adapter process is terminated outright. */
const DISCONNECT_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts and the workbench
// ---------------------------------------------------------------------------
export interface DebugHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Post to every running host: the session events every extension may observe. */
  broadcast(message: MainToWorker): void;
  /** Call into a worker and await its reply. */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The session list changed: the workbench must re-read it. */
  notifyChanged(): void;
  /** A session's console gained output. Goes to the workbench's debug console only. */
  console(sessionId: string, text: string): void;
  /** Absolute workspace folder paths. */
  workspaceRoots(): string[];
}

let bridge: DebugHostBridge | null = null;

export function configureExtensionDebug(next: DebugHostBridge): void {
  bridge = next;
}

function requireBridge(): DebugHostBridge {
  if (bridge === null) throw new Error('The extension debug runtime is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
/**
 * How one session's DAP messages move.
 *
 * The interface is three methods wide on purpose: an inline adapter has no process, no socket and no
 * framing, so anything wider would have to be stubbed for it. `stop` is idempotent — a session can end
 * because the adapter exited, because the extension stopped it, or because the extension was removed,
 * and all three paths converge here.
 */
interface SessionTransport {
  kind: AdapterDescriptorKind;
  send(message: DapMessage): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const configProviders = new DebugConfigProviderRegistry();
const adapterFactories = new DebugAdapterFactoryRegistry();
const sessions = new DebugSessionRegistry();
/** One transport per live session. Absent while a session is still starting. */
const transports = new Map<string, SessionTransport>();
/** `debug.activeDebugConsole`, per session. */
const consoles = new Map<string, DebugConsoleBuffer>();
/** Requests AXIOM sent an adapter and has not had a response to, by session then by seq. */
const pending = new Map<string, Map<number, PendingRequest>>();
/** DAP framing state for the two byte-stream transports. Inline adapters have none: they pass objects. */
const readers = new Map<string, DapMessageReader>();
/** What each adapter said it can do, from its `initialize` response. */
const capabilities = new Map<string, Record<string, unknown>>();
/**
 * Main's provider tokens mapped back to the worker's, for both registries.
 *
 * The worker mints its own token because `registerDebugConfigurationProvider` returns a `Disposable`
 * synchronously, so two extensions both own a token `1`. Main keeps its own and translates on the way
 * out; the owner is recorded next to it so a disposal can be checked before it is performed, which is
 * what stops one extension from disposing another's provider.
 */
const configWorkerTokens = new Map<number, TokenOwner>();
const factoryWorkerTokens = new Map<number, TokenOwner>();
let revision = 1;

interface TokenOwner {
  extensionId: string;
  workerToken: number;
}

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function changed(): void {
  revision += 1;
  bridge?.notifyChanged();
}

/** How the workbench draws one session. Carries no configuration: a launch config holds paths and args. */
function describe(record: DebugSessionRecord): ExtensionDebugSessionInfo {
  return {
    sessionId: record.id,
    extensionId: record.extensionId,
    type: record.type,
    name: record.name,
    parentId: record.parentId,
    state: record.state,
    transport: transports.get(record.id)?.kind ?? 'none',
  };
}

/** Every live extension debug session, for the workbench's pull channel. */
export function extensionDebugSessionList(): {
  revision: number;
  sessions: ExtensionDebugSessionInfo[];
} {
  return { revision, sessions: sessions.list().map(describe) };
}

/** One session's retained console output, for the workbench's debug console. */
export function extensionDebugConsoleLines(sessionId: string): string[] {
  return consoles.get(sessionId)?.snapshot() ?? [];
}

// ---------------------------------------------------------------------------
// Requests from the extension hosts
// ---------------------------------------------------------------------------
const DEBUG_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
  'debug.registerConfigurationProvider',
  'debug.unregisterConfigurationProvider',
  'debug.registerAdapterFactory',
  'debug.unregisterAdapterFactory',
  'debug.start',
  'debug.stop',
  'debug.customRequest',
  'debug.adapterMessage',
  'debug.appendConsole',
]);

export function isDebugRequestKind(kind: HostRequestKind): boolean {
  return DEBUG_REQUEST_KINDS.has(kind);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function handleDebugRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'debug.registerConfigurationProvider':
      return registerConfigProvider(
        extensionId,
        text(payload.debugType),
        normalizeTriggerKind(payload.trigger),
        Number(payload.token),
      );
    case 'debug.unregisterConfigurationProvider':
      return unregisterConfigProvider(extensionId, Number(payload.token));
    case 'debug.registerAdapterFactory':
      return registerAdapterFactory(extensionId, text(payload.debugType), Number(payload.token));
    case 'debug.unregisterAdapterFactory':
      return unregisterAdapterFactory(extensionId, Number(payload.token));
    case 'debug.start':
      return startDebugging(
        extensionId,
        payload.configuration,
        text(payload.folder),
        text(payload.parentSessionId),
      );
    case 'debug.stop':
      return stopDebugging(extensionId, text(payload.sessionId));
    case 'debug.customRequest':
      return customRequest(
        extensionId,
        text(payload.sessionId),
        text(payload.command),
        payload.args,
      );
    case 'debug.adapterMessage':
      return inlineAdapterMessage(extensionId, text(payload.sessionId), payload.message);
    case 'debug.appendConsole':
      return appendConsole(extensionId, text(payload.sessionId), text(payload.text));
    default:
      throw new Error(`${kind} is not a debug request.`);
  }
}

// ---------------------------------------------------------------------------
// Providers and factories
// ---------------------------------------------------------------------------
function registerConfigProvider(
  extensionId: string,
  debugType: string,
  trigger: 'initial' | 'dynamic',
  workerToken: number,
): number {
  const record = configProviders.register(extensionId, debugType, trigger);
  configWorkerTokens.set(record.token, { extensionId, workerToken });
  changed();
  return record.token;
}

/** Find main's token for a worker's, but only among the tokens that extension actually owns. */
function mainToken(
  map: Map<number, TokenOwner>,
  extensionId: string,
  workerToken: number,
): number | null {
  for (const [token, owner] of map) {
    if (owner.extensionId === extensionId && owner.workerToken === workerToken) return token;
  }
  return null;
}

function unregisterConfigProvider(extensionId: string, workerToken: number): boolean {
  const token = mainToken(configWorkerTokens, extensionId, workerToken);
  if (token === null) return false;
  configProviders.unregister(token);
  configWorkerTokens.delete(token);
  changed();
  return true;
}

/**
 * `registerDebugAdapterDescriptorFactory`.
 *
 * The registry refuses a second factory for a type that already has one, as upstream does, and the
 * refusal is the point: the factory decides what program AXIOM starts, so an extension quietly taking
 * over `node` or `python` would be a way to have someone else's debug session launch its code.
 */
function registerAdapterFactory(
  extensionId: string,
  debugType: string,
  workerToken: number,
): number {
  const token = adapterFactories.register(extensionId, debugType);
  factoryWorkerTokens.set(token, { extensionId, workerToken });
  changed();
  return token;
}

function unregisterAdapterFactory(extensionId: string, workerToken: number): boolean {
  const token = mainToken(factoryWorkerTokens, extensionId, workerToken);
  if (token === null) return false;
  adapterFactories.unregister(token);
  factoryWorkerTokens.delete(token);
  changed();
  return true;
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------
/** The configuration flattened back to the object an adapter or an extension expects. */
function wireConfiguration(config: DebugConfigurationData): Record<string, unknown> {
  return { type: config.type, name: config.name, request: config.request, ...config.rest };
}

/**
 * The configuration as it may be broadcast to every extension host.
 *
 * `DebugSession.configuration` is upstream API and extensions read it to recognise their own sessions,
 * so it is carried — minus `env`. A launch configuration's environment is where a user keeps the token
 * the program under debug needs, and `onDidStartDebugSession` fires in every installed extension. The
 * adapter still receives the real thing, because it is the one process that needs it.
 */
function publicConfiguration(config: DebugConfigurationData): Record<string, unknown> {
  const out = wireConfiguration(config);
  if ('env' in out) delete out.env;
  if ('envFile' in out) delete out.envFile;
  return out;
}

/**
 * Resolve a configuration the way upstream does.
 *
 * Every provider registered for the type — and every `'*'` provider — is asked in registration order,
 * and each may rewrite what the next one sees. `resolveDebugConfiguration` runs over all of them before
 * `resolveDebugConfigurationWithSubstitutedVariables` runs over any, which is the order extensions like
 * the Python and C++ debuggers depend on. The trigger kind selects which providers *offer*
 * configurations, not which ones resolve them, so both kinds are asked here.
 */
async function resolveConfiguration(
  config: DebugConfigurationData,
  folder: string,
): Promise<DebugConfigurationData | null> {
  let current = config;
  for (const op of ['resolve', 'resolveWithSubstituted'] as const) {
    for (const record of [
      ...configProviders.providersFor(current.type, 'initial'),
      ...configProviders.providersFor(current.type, 'dynamic'),
    ]) {
      const next = await askProvider(record.token, record.extensionId, op, folder, current);
      if (next === null) return null;
      current = next;
    }
  }
  return current;
}

/**
 * One provider round trip.
 *
 * A provider that cancels — upstream's `resolveDebugConfiguration` returning `null` or `undefined` — stops
 * the launch, and that veto is the whole point of the API. A provider that throws or never answers stops
 * it too: the alternative is starting an adapter with a configuration only half filled in, which fails
 * later and further from the cause. Anything else leaves the configuration as it was.
 */
async function askProvider(
  token: number,
  extensionId: string,
  op: 'resolve' | 'resolveWithSubstituted',
  folder: string,
  config: DebugConfigurationData,
): Promise<DebugConfigurationData | null> {
  const answer = await requireBridge().call(
    extensionId,
    (id) => ({
      t: 'debugResolveConfiguration',
      id,
      token: `debug:${token}`,
      providerToken: configWorkerTokens.get(token)?.workerToken ?? 0,
      op,
      folder: folder.length > 0 ? folder : null,
      configuration: wireConfiguration(config),
    }),
    RESOLVE_TIMEOUT_MS,
  );
  if (answer === null || answer === undefined) return null;
  if (typeof answer !== 'object') return config;
  const reply = answer as Record<string, unknown>;
  if (reply.cancelled === true) return null;
  if (!('configuration' in reply)) return config;
  return normalizeDebugConfiguration(reply.configuration) ?? config;
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------
/**
 * `debug.startDebugging()`.
 *
 * The gates run in this order: the folder has to be one AXIOM is allowed to touch, its workspace has to
 * be trusted, the configuration has to survive normalisation, and a parent session named by the caller
 * has to be the caller's own. All of that happens before a session exists, so a refusal leaves no record
 * and no process behind.
 */
async function startDebugging(
  extensionId: string,
  rawConfiguration: unknown,
  folder: string,
  parentSessionId: string,
): Promise<boolean> {
  const scope = await resolveScope(folder);
  await assertWorkspaceTrusted(scope);
  const requested = normalizeDebugConfiguration(rawConfiguration);
  if (requested === null) {
    throw new Error('That debug configuration has no usable type, name and request.');
  }
  const parentId = parentSessionId.length > 0 ? parentSessionId : null;
  if (parentId !== null && sessions.get(parentId)?.extensionId !== extensionId) {
    throw new Error('That parent debug session does not belong to this extension.');
  }
  const resolved = await resolveConfiguration(requested, scope);
  if (resolved === null) {
    log.info('A configuration provider cancelled a debug session', {
      id: extensionId,
      type: requested.type,
    });
    return false;
  }
  return beginSession(extensionId, resolved, scope, parentId);
}

/** The folder a session runs in: the one asked for, else the first workspace root. */
async function resolveScope(folder: string): Promise<string> {
  if (folder.length > 0) return assertAuthorizedPath(folder, { directory: true });
  const root = requireBridge().workspaceRoots()[0];
  if (root === undefined || root.length === 0) {
    throw new Error('No workspace is open, so there is nothing to debug.');
  }
  return root;
}

/**
 * Create the session, start its adapter, run the handshake.
 *
 * The record exists before the adapter does, because the descriptor request carries the session id to the
 * extension and js-debug addresses its child sessions by it. Anything that fails before the session has
 * been announced tears the record down again, so a refused launch cannot leave a row in the session list,
 * an open socket or a live process behind.
 */
async function beginSession(
  extensionId: string,
  configuration: DebugConfigurationData,
  scope: string,
  parentId: string | null,
): Promise<boolean> {
  const record = sessions.create(extensionId, configuration, {
    parentId,
    workspaceFolder: scope,
    now: Date.now(),
  });
  consoles.set(record.id, new DebugConsoleBuffer());
  try {
    const descriptor = await requestDescriptor(record);
    transports.set(record.id, await openTransport(record, descriptor));
  } catch (error) {
    discard(record.id);
    throw error instanceof Error ? error : new Error(String(error));
  }
  announce(record);
  log.info('An extension started a debug session', {
    id: extensionId,
    session: record.id,
    type: record.type,
    transport: transports.get(record.id)?.kind ?? 'none',
  });
  try {
    await handshake(record);
  } catch (error) {
    consoleWrite(record.id, `${String(error)}\n`);
    log.warn('A debug adapter did not complete the handshake', {
      session: record.id,
      error: String(error),
    });
    endSession(record.id, 'The debug adapter did not start.');
    return false;
  }
  return true;
}

/** Ask the extension that registered the factory for this type how its adapter is started. */
async function requestDescriptor(record: DebugSessionRecord): Promise<AdapterDescriptorData> {
  const owner = adapterFactories.owner(record.type);
  if (owner === null) {
    throw new Error(`No extension provides a debug adapter for '${record.type}'.`);
  }
  const answer = await requireBridge().call(
    owner,
    (id) => ({
      t: 'debugCreateAdapter',
      id,
      token: `debug:${record.type}`,
      debugType: record.type,
      sessionId: record.id,
      configuration: wireConfiguration(record.configuration),
    }),
    DESCRIPTOR_TIMEOUT_MS,
  );
  const descriptor = normalizeAdapterDescriptor(answer);
  if (descriptor === null) {
    throw new Error(`The debug adapter descriptor for '${record.type}' is not usable.`);
  }
  return descriptor;
}

/** `onDidStartDebugSession` then `debug.activeDebugSession`, in that order, in every host. */
function announce(record: DebugSessionRecord): void {
  const host = requireBridge();
  host.broadcast({
    t: 'debugSessionStarted',
    sessionId: record.id,
    type: record.type,
    name: record.name,
    configuration: publicConfiguration(record.configuration),
    parentId: record.parentId,
    workspaceFolder: record.workspaceFolder,
  });
  host.broadcast({ t: 'debugActiveSession', sessionId: sessions.active()?.id ?? null });
  changed();
}

/** Drop a session that never started: nobody was told it began, so nobody is told it ended. */
function discard(sessionId: string): void {
  for (const record of sessions.terminate(sessionId)) {
    transports.get(record.id)?.stop();
    transports.delete(record.id);
    readers.delete(record.id);
    consoles.delete(record.id);
    capabilities.delete(record.id);
  }
  changed();
}

// ---------------------------------------------------------------------------
// Starting an adapter
// ---------------------------------------------------------------------------
/** Start whatever the descriptor describes, behind the one interface the rest of the file knows. */
async function openTransport(
  record: DebugSessionRecord,
  descriptor: AdapterDescriptorData,
): Promise<SessionTransport> {
  if (descriptor.kind === 'inline') return inlineTransport(record);
  if (descriptor.kind === 'executable') return executableTransport(record, descriptor);
  return await socketTransport(record, descriptor);
}

/**
 * `DebugAdapterExecutable`: one child process speaking DAP over its own stdio.
 *
 * The environment is built the way every other AXIOM child gets one — from an allowlist, never
 * `process.env` — with the descriptor's own variables layered on top, because an adapter usually needs one
 * or two of its own. The working directory is not put through the workspace gate: the program is one the
 * extension ships and could change directory itself, so the gate would cost compatibility and buy nothing.
 * On POSIX the child leads a process group, so ending the session can take the debuggee with it.
 */
function executableTransport(
  record: DebugSessionRecord,
  descriptor: AdapterDescriptorData,
): SessionTransport {
  if (descriptor.command === null || descriptor.command.length === 0) {
    throw new Error('That debug adapter descriptor names no program to start.');
  }
  const child = spawn(descriptor.command, [...descriptor.args], {
    ...(descriptor.cwd !== null ? { cwd: descriptor.cwd } : {}),
    env: { ...buildChildProcessEnvironment(), ...descriptor.env },
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (chunk: Buffer) => feed(record.id, chunk));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => consoleWrite(record.id, chunk));
  child.on('error', (error: Error) => {
    consoleWrite(record.id, `${error.message}\n`);
    endSession(record.id, error.message);
  });
  child.on('close', () => endSession(record.id, 'The debug adapter exited.'));
  return {
    kind: 'executable',
    send: (message) => void child.stdin?.write(encodeDapMessage(message)),
    stop: () => stopChild(child),
  };
}

/** The process-tree teardown, in one place, so `stop` stays synchronous and idempotent. */
function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  void terminateProcessTree(child, DISCONNECT_GRACE_MS).catch((error: unknown) => {
    log.warn('A debug adapter process tree could not be terminated', {
      pid: child.pid ?? 0,
      error: String(error),
    });
  });
}

/**
 * `DebugAdapterServer` and `DebugAdapterNamedPipeServer`: the adapter is already running.
 *
 * Both are the extension's own server — js-debug listens on a loopback port and hands AXIOM the number —
 * so the one thing worth policing is where AXIOM will connect, and `normalizeAdapterDescriptor` has
 * already pinned the host to loopback: a descriptor naming another machine cannot reach this far. The
 * retry loop is here because a descriptor is usually handed over the instant `listen` was called, so the
 * first `connect` can arrive before the server is accepting.
 */
async function socketTransport(
  record: DebugSessionRecord,
  descriptor: AdapterDescriptorData,
): Promise<SessionTransport> {
  if (descriptor.kind === 'server' && (descriptor.port === null || descriptor.port <= 0)) {
    throw new Error('That debug adapter descriptor names no port.');
  }
  if (
    descriptor.kind === 'namedPipe' &&
    (descriptor.pipe === null || descriptor.pipe.length === 0)
  ) {
    throw new Error('That debug adapter descriptor names no pipe.');
  }
  const socket = await connectWithRetry(descriptor);
  socket.on('data', (chunk: Buffer) => feed(record.id, chunk));
  socket.on('error', (error: Error) => consoleWrite(record.id, `${error.message}\n`));
  socket.on('close', () => endSession(record.id, 'The debug adapter closed the connection.'));
  return {
    kind: descriptor.kind,
    send: (message) => void socket.write(encodeDapMessage(message)),
    stop: () => socket.destroy(),
  };
}

/** Connect, retrying while the adapter is still coming up, until the deadline passes. */
async function connectWithRetry(descriptor: AdapterDescriptorData): Promise<Socket> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let last = 'The debug adapter did not accept a connection.';
  for (;;) {
    try {
      return await connectOnce(descriptor);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) throw new Error(last);
      await delay(CONNECT_RETRY_MS);
    }
  }
}

function connectOnce(descriptor: AdapterDescriptorData): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket =
      descriptor.kind === 'namedPipe'
        ? connect(descriptor.pipe ?? '')
        : connect({ host: descriptor.host ?? '127.0.0.1', port: descriptor.port ?? 0 });
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (error: Error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * `DebugAdapterInlineImplementation`: the extension *is* the adapter.
 *
 * No process, no socket, no framing — the messages are objects posted to the host that owns the session,
 * and its replies come back through `debug.adapterMessage`. The cheapest transport, and the one that needs
 * the most care on the way in, because the sender is an extension rather than a program AXIOM started;
 * that check lives in `inlineAdapterMessage`.
 */
function inlineTransport(record: DebugSessionRecord): SessionTransport {
  return {
    kind: 'inline',
    send: (message) => {
      const delivered = bridge?.deliver(record.extensionId, {
        t: 'debugAdapterMessage',
        sessionId: record.id,
        message,
      });
      if (delivered !== true) {
        endSession(record.id, 'The extension hosting that inline debug adapter is gone.');
      }
    },
    stop: () =>
      void bridge?.deliver(record.extensionId, { t: 'debugAdapterStop', sessionId: record.id }),
  };
}

// ---------------------------------------------------------------------------
// Framing and routing
// ---------------------------------------------------------------------------
/**
 * Bytes in, from a process or a socket.
 *
 * A body that does not parse is reported and skipped, because an adapter that logs a stray line to stdout
 * is common and recoverable. A length the reader cannot trust is not: it closes the stream, since nothing
 * after it can be located, and the session ends with a line in its console rather than by silently
 * dropping every message that follows.
 */
function feed(sessionId: string, chunk: Uint8Array): void {
  const reader = readerFor(sessionId);
  const result = reader.push(chunk);
  for (const message of result.messages) onAdapterMessage(sessionId, message);
  for (const error of result.errors) {
    consoleWrite(sessionId, `AXIOM could not read a message from the debug adapter (${error}).\n`);
  }
  if (reader.isClosed) endSession(sessionId, 'The debug adapter protocol stream is unusable.');
}

function readerFor(sessionId: string): DapMessageReader {
  const existing = readers.get(sessionId);
  if (existing !== undefined) return existing;
  const reader = new DapMessageReader();
  readers.set(sessionId, reader);
  return reader;
}

/** Adapter output: into the session's `DebugConsole`, and on to the workbench's panel. */
function consoleWrite(sessionId: string, chunk: string): void {
  consoles.get(sessionId)?.append(chunk);
  bridge?.console(sessionId, chunk);
}

/**
 * Send a request and wait for the adapter's response.
 *
 * The in-flight map is bounded per session by `MAX_DAP_PENDING` and every entry carries a timer, so an
 * adapter that stops answering can neither pin memory nor leave an extension's `customRequest` promise
 * hanging. Sequence numbers come from the session record because DAP requires them to increase within a
 * session, and the reverse-request responses draw from the same counter.
 */
function sendRequest(sessionId: string, command: string, args: unknown): Promise<unknown> {
  const transport = transports.get(sessionId);
  if (transport === undefined) {
    return Promise.reject(new Error('That debug session has no adapter to talk to.'));
  }
  const inflight = pending.get(sessionId) ?? new Map<number, PendingRequest>();
  pending.set(sessionId, inflight);
  if (inflight.size >= MAX_DAP_PENDING) {
    return Promise.reject(
      new Error(`A debug session allows ${MAX_DAP_PENDING} requests in flight.`),
    );
  }
  const seq = sessions.takeSeq(sessionId);
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(seq);
      reject(new Error(`The debug adapter did not answer '${command}'.`));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    inflight.set(seq, { resolve, reject, timer });
    transport.send({ seq, type: 'request', command, arguments: args });
  });
}

/** A response: hand the body to whoever asked, or the failure it reported. */
function settle(sessionId: string, message: DapMessage): void {
  const requestSeq = typeof message.request_seq === 'number' ? message.request_seq : -1;
  const inflight = pending.get(sessionId);
  const waiting = inflight?.get(requestSeq);
  if (inflight === undefined || waiting === undefined) return;
  clearTimeout(waiting.timer);
  inflight.delete(requestSeq);
  if (message.success === true) waiting.resolve(message.body);
  else {
    const detail = text(message.message);
    waiting.reject(
      new Error(
        detail.length > 0 ? detail : `The debug adapter refused '${text(message.command)}'.`,
      ),
    );
  }
}

/** Fail everything still in flight for a session that has ended. */
function rejectPending(sessionId: string, reason: string): void {
  const inflight = pending.get(sessionId);
  pending.delete(sessionId);
  if (inflight === undefined) return;
  for (const waiting of inflight.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(new Error(reason));
  }
  inflight.clear();
}

/**
 * `initialize`, then `launch` or `attach`.
 *
 * The order is the protocol's. The `initialized` *event* usually arrives between the two and is what
 * triggers `configurationDone`, so that lives in the event router rather than here. AXIOM declares no
 * support for `runInTerminal`, which is what lets an adapter use its own terminal handling instead of
 * waiting on a reverse request this runtime does not serve.
 */
async function handshake(record: DebugSessionRecord): Promise<void> {
  const answer = await sendRequest(record.id, 'initialize', {
    clientID: 'axiom',
    clientName: 'AXIOM',
    adapterID: record.type,
    locale: 'en',
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: false,
    supportsProgressReporting: false,
    supportsStartDebuggingRequest: true,
  });
  if (typeof answer === 'object' && answer !== null) {
    capabilities.set(record.id, answer as Record<string, unknown>);
  }
  await sendRequest(
    record.id,
    record.configuration.request,
    wireConfiguration(record.configuration),
  );
  sessions.markRunning(record.id);
  changed();
}

/** Everything an adapter sends, sorted into the three DAP message types. */
function onAdapterMessage(sessionId: string, message: DapMessage): void {
  if (message.type === 'response') settle(sessionId, message);
  else if (message.type === 'event') onAdapterEvent(sessionId, message);
  else onAdapterRequest(sessionId, message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The events the debug service consumes itself.
 *
 * `onDidReceiveDebugSessionCustomEvent` carries an adapter's *own* events, so the protocol's vocabulary is
 * filtered out of it — an extension listening there for `stopped` would be disappointed upstream too.
 * Anything not named here is forwarded to every host.
 */
const STANDARD_DAP_EVENTS: ReadonlySet<string> = new Set([
  'initialized',
  'stopped',
  'continued',
  'exited',
  'terminated',
  'thread',
  'output',
  'breakpoint',
  'module',
  'loadedSource',
  'process',
  'capabilities',
  'progressStart',
  'progressUpdate',
  'progressEnd',
  'invalidated',
  'memory',
]);

function onAdapterEvent(sessionId: string, message: DapMessage): void {
  const event = text(message.event);
  if (event === 'output') {
    const chunk = text(asRecord(message.body).output);
    if (chunk.length > 0) consoleWrite(sessionId, chunk);
    return;
  }
  if (event === 'initialized') {
    // Deferred one turn: when the response and this event arrive in the same chunk, the capabilities
    // from `initialize` are recorded in the continuation that has not run yet.
    queueMicrotask(() => void sendConfigurationDone(sessionId));
    return;
  }
  if (event === 'terminated') {
    endSession(sessionId, 'The debug adapter ended the session.');
    return;
  }
  if (STANDARD_DAP_EVENTS.has(event)) return;
  bridge?.broadcast({ t: 'debugCustomEvent', sessionId, event, body: message.body });
}

/** `configurationDone`, but only for an adapter that asked for one. */
async function sendConfigurationDone(sessionId: string): Promise<void> {
  if (capabilities.get(sessionId)?.supportsConfigurationDoneRequest !== true) return;
  try {
    await sendRequest(sessionId, 'configurationDone', {});
  } catch (error) {
    consoleWrite(sessionId, `${String(error)}\n`);
  }
}

/**
 * A reverse request: the adapter asking AXIOM for something.
 *
 * `startDebugging` is served, because js-debug uses it for every child session — one per worker, one per
 * browser tab — and the session tree exists for exactly that. The child's configuration is used as the
 * adapter wrote it, without a second pass through the configuration providers: the parent's was already
 * resolved, and re-resolving a configuration an adapter authored is how a provider that is not idempotent
 * corrupts a child session. `runInTerminal` is refused — PRD Phase 7 §3 does not list it, and serving it
 * would mean launching a program in a terminal on an adapter's word. Everything else is refused too, with
 * a protocol-correct failure rather than silence, so no adapter waits on a response that never comes.
 */
function onAdapterRequest(sessionId: string, message: DapMessage): void {
  const parent = sessions.get(sessionId);
  const command = text(message.command);
  if (parent === undefined) return;
  if (command !== 'startDebugging') {
    log.info('A debug adapter reverse request was refused', { session: sessionId, command });
    respond(sessionId, message, false, undefined, `AXIOM does not serve the '${command}' request.`);
    return;
  }
  const args = asRecord(message.arguments);
  const child = normalizeDebugConfiguration({
    type: parent.type,
    name: parent.name,
    request: text(args.request) === 'attach' ? 'attach' : 'launch',
    ...asRecord(args.configuration),
  });
  if (child === null) {
    respond(sessionId, message, false, undefined, 'That child configuration is not usable.');
    return;
  }
  void beginSession(parent.extensionId, child, parent.workspaceFolder ?? '', sessionId).then(
    (started) =>
      respond(
        sessionId,
        message,
        started,
        undefined,
        started ? undefined : 'That child debug session did not start.',
      ),
    (error: unknown) => respond(sessionId, message, false, undefined, String(error)),
  );
}

/** A response to a reverse request, framed the way the adapter expects it. */
function respond(
  sessionId: string,
  request: DapMessage,
  success: boolean,
  body?: unknown,
  failure?: string,
): void {
  const transport = transports.get(sessionId);
  if (transport === undefined) return;
  transport.send({
    seq: sessions.takeSeq(sessionId),
    type: 'response',
    request_seq: request.seq,
    command: text(request.command),
    success,
    ...(body === undefined ? {} : { body }),
    ...(failure === undefined ? {} : { message: failure }),
  });
}

// ---------------------------------------------------------------------------
// Ending a session
// ---------------------------------------------------------------------------
/**
 * `debug.stopDebugging()`.
 *
 * An empty session id means the active session, the way upstream's optional argument does. Whichever
 * session that turns out to be has to be the caller's: the workbench's own session and another
 * extension's are not an extension's to stop.
 */
async function stopDebugging(extensionId: string, sessionId: string): Promise<boolean> {
  const record = sessionId.length > 0 ? sessions.get(sessionId) : (sessions.active() ?? undefined);
  if (record === undefined) return false;
  if (record.extensionId !== extensionId) {
    throw new Error('That debug session does not belong to this extension.');
  }
  await requestDisconnect(record.id);
  endSession(record.id, 'The extension stopped the session.');
  return true;
}

/**
 * Ask the adapter to disconnect, then stop waiting.
 *
 * A well-behaved adapter answers and exits, and its exit ends the session through its transport. A hung one
 * gets `DISCONNECT_GRACE_MS` and is then torn down anyway: the grace is there so a debuggee is detached
 * cleanly when it can be, not so a broken adapter can keep a session alive.
 */
async function requestDisconnect(sessionId: string): Promise<void> {
  if (!transports.has(sessionId)) return;
  const request = sendRequest(sessionId, 'disconnect', {
    restart: false,
    terminateDebuggee: true,
  }).then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([request, delay(DISCONNECT_GRACE_MS)]);
}

/**
 * End a session and its children, in the order an extension can follow.
 *
 * `terminate` hands back the subtree deepest-first, and each session is finished before the next: pending
 * requests failed, transport stopped, console dropped, `onDidTerminateDebugSession` fired. Everything that
 * can end a session — the adapter exiting, a `terminated` event, `stopDebugging`, an extension being
 * removed, a framing failure — arrives here, so there is one place where a session's resources are released
 * and calling it twice is safe.
 */
function endSession(sessionId: string, reason: string): void {
  const ended = sessions.terminate(sessionId);
  if (ended.length === 0) return;
  for (const record of ended) {
    const transport = transports.get(record.id);
    transports.delete(record.id);
    readers.delete(record.id);
    capabilities.delete(record.id);
    consoles.delete(record.id);
    rejectPending(record.id, reason);
    transport?.stop();
    bridge?.broadcast({ t: 'debugSessionTerminated', sessionId: record.id });
  }
  bridge?.broadcast({ t: 'debugActiveSession', sessionId: sessions.active()?.id ?? null });
  changed();
}

// ---------------------------------------------------------------------------
// Talking to a running session
// ---------------------------------------------------------------------------
/** The session an extension named, once it is settled that the extension owns it. */
function ownedSession(extensionId: string, sessionId: string): DebugSessionRecord {
  const record = sessionId.length > 0 ? sessions.get(sessionId) : (sessions.active() ?? undefined);
  if (record === undefined) throw new Error('That debug session no longer exists.');
  if (record.extensionId !== extensionId) {
    throw new Error('That debug session does not belong to this extension.');
  }
  return record;
}

/**
 * `DebugSession.customRequest()`.
 *
 * Ownership is checked rather than assumed. Session ids are short predictable strings, and without the
 * check an extension could drive another extension's adapter: set a breakpoint, evaluate an expression
 * inside someone else's debuggee, read a variable out of a process it has nothing to do with.
 */
async function customRequest(
  extensionId: string,
  sessionId: string,
  command: string,
  args: unknown,
): Promise<unknown> {
  const record = ownedSession(extensionId, sessionId);
  if (command.length === 0) throw new Error('A custom debug request needs a command.');
  return await sendRequest(record.id, command, args);
}

/**
 * A message from an extension's inline adapter.
 *
 * Three checks, and each one earns its place: the extension owns the session, the session's transport *is*
 * inline, and the message is a DAP message. Without the second an extension could inject responses into a
 * session backed by a socket or a process — answering, in the real adapter's name, requests the real
 * adapter has not answered yet.
 */
function inlineAdapterMessage(extensionId: string, sessionId: string, raw: unknown): boolean {
  const record = ownedSession(extensionId, sessionId);
  if (transports.get(record.id)?.kind !== 'inline') {
    throw new Error('That debug session is not served by an inline adapter.');
  }
  const checked = validateOutboundDapMessage(raw);
  if (!checked.ok) throw new Error(`That is not a usable debug message: ${checked.error}.`);
  onAdapterMessage(record.id, checked.message);
  return true;
}

/**
 * `debug.activeDebugConsole.append()`.
 *
 * Upstream's active console always exists, so a write that lands while someone else's session is active is
 * dropped rather than raised: an extension logging into the void is upstream's behaviour there, and an
 * exception on a log call is not.
 */
function appendConsole(extensionId: string, sessionId: string, chunk: string): boolean {
  const record = sessionId.length > 0 ? sessions.get(sessionId) : (sessions.active() ?? undefined);
  if (record === undefined || record.extensionId !== extensionId) return false;
  consoleWrite(record.id, chunk);
  return true;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
/**
 * Everything one extension owns, released.
 *
 * Called when an extension is deactivated, uninstalled, or its host crashes. The order matters: the
 * registrations go first, so nothing new can start while the sessions are being ended, and then each
 * session ends through the same path a normal termination takes — the extensions still running see exactly
 * the events they would have seen if the debuggee had exited on its own.
 */
export function disposeDebugForExtension(extensionId: string): number {
  for (const [token, owner] of [...configWorkerTokens]) {
    if (owner.extensionId === extensionId) configWorkerTokens.delete(token);
  }
  configProviders.removeExtension(extensionId);
  for (const [token, owner] of [...factoryWorkerTokens]) {
    if (owner.extensionId === extensionId) factoryWorkerTokens.delete(token);
  }
  adapterFactories.removeExtension(extensionId);
  const owned = sessions.forExtension(extensionId);
  for (const record of owned) endSession(record.id, 'The extension was stopped.');
  if (owned.length > 0) {
    log.info('Debug sessions ended with their extension', { id: extensionId, count: owned.length });
  }
  changed();
  return owned.length;
}

/** Counters for the validators and the workbench's diagnostics. */
export function extensionDebugState(): {
  configProviders: number;
  adapterFactories: number;
  sessions: number;
  transports: number;
  pending: number;
  consoles: number;
  revision: number;
} {
  let inflight = 0;
  for (const map of pending.values()) inflight += map.size;
  return {
    configProviders: configProviders.size,
    adapterFactories: adapterFactories.size,
    sessions: sessions.size,
    transports: transports.size,
    pending: inflight,
    consoles: consoles.size,
    revision,
  };
}

/** Drop every session, adapter and registration: for the validators and for a full host restart. */
export function resetExtensionDebugForTesting(): void {
  for (const [sessionId, transport] of [...transports]) {
    rejectPending(sessionId, 'The debug runtime was reset.');
    transport.stop();
  }
  transports.clear();
  readers.clear();
  capabilities.clear();
  consoles.clear();
  pending.clear();
  configProviders.clear();
  adapterFactories.clear();
  sessions.clear();
  configWorkerTokens.clear();
  factoryWorkerTokens.clear();
  revision = 1;
  bridge = null;
}
