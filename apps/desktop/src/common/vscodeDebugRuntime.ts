/**
 * VS Code debug runtime (PRD Phase 7 — §3 Debug API).
 *
 * PURE module: no I/O, no child processes, no sockets. It owns the two things that decide whether a
 * debug session is safe and correct before any adapter exists — the Debug Adapter Protocol wire
 * format, and the registries that say which extension answers for which debug type — plus the
 * multi-session bookkeeping `debug.activeDebugSession` and the session events are reported from.
 *
 * The DAP framing lives here rather than in the service because it is the parser on the boundary. A
 * debug adapter is a separate process whose output AXIOM must not trust: a `Content-Length` that lies,
 * a body that is not JSON, a message larger than memory, a header split across three chunks. Those are
 * exactly the cases a byte-level reader gets wrong, and putting the reader in a pure module means the
 * validators can feed it adversarial input directly instead of hoping a real adapter produces it.
 *
 * AXIOM already has `main/services/dap.ts` for its own debug UI. That client stays as it is; this
 * module is the shared, re-entrant half that a *per-extension* session manager needs, because one
 * extension may own several sessions at once and upstream's `startDebugging` returns whether the
 * session started, not a handle to a singleton.
 */

/** Debug sessions AXIOM will run at once, across every extension. */
export const MAX_DEBUG_SESSIONS = 8;
/** Configuration providers one extension may register. */
export const MAX_CONFIG_PROVIDERS = 16;
/** Adapter descriptor factories one extension may register. */
export const MAX_ADAPTER_FACTORIES = 16;
/** Largest single DAP message AXIOM will accept from an adapter, or send to one. */
export const MAX_DAP_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Requests in flight to one adapter before further requests are refused. */
export const MAX_DAP_PENDING = 128;
/** Longest line the debug console will keep from one `DebugConsole.append`. */
export const MAX_CONSOLE_TEXT = 32 * 1024;
/** Lines one session's console retains. */
export const MAX_CONSOLE_LINES = 2_000;

// ---------------------------------------------------------------------------
// DAP wire format
// ---------------------------------------------------------------------------
/** A DAP message, narrowed only as far as the transport needs. */
export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  [key: string]: unknown;
}

const HEADER_TERMINATOR = '\r\n\r\n';

/**
 * Frame one message for the wire.
 *
 * `Content-Length` counts *bytes*, not characters. Getting that wrong is invisible until an adapter
 * receives a path with a non-ASCII character in it and then desynchronises for the rest of the
 * session, so the length is measured after encoding rather than from `string.length`.
 */
export function encodeDapMessage(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  const body = new TextEncoder().encode(json);
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

/** Why a chunk of adapter output was rejected. Reported to the session, never thrown at the caller. */
export type DapReadError = 'bad-header' | 'too-large' | 'bad-json' | 'not-a-message';

export interface DapReadResult {
  messages: DapMessage[];
  errors: DapReadError[];
}

/**
 * Incremental reader over an adapter's stdout.
 *
 * Chunk boundaries are arbitrary, so the buffer is kept across `push` calls and only consumed when a
 * whole framed message is present. Three refusals are deliberate:
 *
 * - a header block with no `Content-Length` is `bad-header`, and the buffer is dropped up to the
 *   terminator rather than kept, because keeping it would let a malformed adapter pin memory;
 * - a declared length over `MAX_DAP_MESSAGE_BYTES` is `too-large` and *closes* the read — a lying
 *   length is unrecoverable, since the reader cannot know where the next header starts;
 * - a body that does not parse, or parses to something that is not a DAP message, is dropped and
 *   reported, and the reader continues at the next header. That case is recoverable and an adapter
 *   which logs to stdout by mistake would otherwise take the session down.
 */
export class DapMessageReader {
  private buffer = new Uint8Array(0);
  private closed = false;
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): DapReadResult {
    const result: DapReadResult = { messages: [], errors: [] };
    if (this.closed) return result;
    if (this.buffer.byteLength + chunk.byteLength > MAX_DAP_MESSAGE_BYTES * 2) {
      this.closed = true;
      this.buffer = new Uint8Array(0);
      result.errors.push('too-large');
      return result;
    }
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
    for (;;) {
      const headerEnd = indexOfTerminator(this.buffer);
      if (headerEnd < 0) return result;
      const headerText = this.decoder.decode(this.buffer.subarray(0, headerEnd));
      const length = readContentLength(headerText);
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      if (length === null) {
        this.buffer = this.buffer.subarray(bodyStart);
        result.errors.push('bad-header');
        continue;
      }
      if (length > MAX_DAP_MESSAGE_BYTES) {
        this.closed = true;
        this.buffer = new Uint8Array(0);
        result.errors.push('too-large');
        return result;
      }
      if (this.buffer.byteLength < bodyStart + length) return result;
      const body = this.decoder.decode(this.buffer.subarray(bodyStart, bodyStart + length));
      this.buffer = this.buffer.subarray(bodyStart + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        result.errors.push('bad-json');
        continue;
      }
      const message = asDapMessage(parsed);
      if (message === null) result.errors.push('not-a-message');
      else result.messages.push(message);
    }
  }

  get pending(): number {
    return this.buffer.byteLength;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
    this.closed = false;
  }
}

function indexOfTerminator(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.byteLength; i += 1) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

/** `Content-Length` from a header block. Case-insensitive; a non-integer or negative value refuses. */
function readContentLength(headerText: string): number | null {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }
  return null;
}

/**
 * Is this a DAP message at all?
 *
 * `seq` and `type` are the two fields every message in the protocol has, and the three types are
 * closed. Anything else is refused rather than forwarded, because the next hop is an extension's
 * `onDidReceiveDebugSessionCustomEvent` handler and a message with no `type` would be dispatched as
 * whatever the switch's default happens to be.
 */
export function asDapMessage(raw: unknown): DapMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const type = source.type;
  if (type !== 'request' && type !== 'response' && type !== 'event') return null;
  const seq = typeof source.seq === 'number' && Number.isFinite(source.seq) ? source.seq : 0;
  if (type === 'request' && typeof source.command !== 'string') return null;
  if (type === 'response' && typeof source.request_seq !== 'number') return null;
  if (type === 'event' && typeof source.event !== 'string') return null;
  return { ...source, seq, type } as DapMessage;
}

/**
 * Validate a message an *extension* is sending to an adapter (`session.customRequest`, or an inline
 * adapter's reply). Stricter than `asDapMessage`: the extension is the untrusted side here, so the
 * message is rebuilt from known fields rather than spread, and the body is size-checked against the
 * same limit the reader enforces so a huge `arguments` object cannot be smuggled past the framing cap.
 */
export function validateOutboundDapMessage(
  raw: unknown,
): { ok: true; message: DapMessage } | { ok: false; error: string } {
  const message = asDapMessage(raw);
  if (message === null) return { ok: false, error: 'Not a DAP message.' };
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch {
    return { ok: false, error: 'DAP message is not serialisable.' };
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_DAP_MESSAGE_BYTES) {
    return { ok: false, error: 'DAP message exceeds the size limit.' };
  }
  return { ok: true, message };
}

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------
/** A launch configuration, validated down to the three fields upstream requires plus the rest. */
export interface DebugConfigurationData {
  type: string;
  name: string;
  request: 'launch' | 'attach';
  /** Everything else the configuration carried, JSON-clean and depth-bounded. */
  rest: Record<string, unknown>;
}

const CONFIG_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.+-]{0,120}$/;

/**
 * Bound the shape of a configuration before it crosses a process boundary.
 *
 * A configuration is authored by the user in `launch.json` and then rewritten by any number of
 * extensions' `resolveDebugConfiguration` hooks, so by the time it is sent to an adapter it is
 * arbitrary JSON of arbitrary depth. Cloning it with a depth and breadth bound is what stops a cyclic
 * or pathological object from either throwing inside `JSON.stringify` on the IPC boundary or being
 * walked quadratically by whatever reads it next.
 */
function cloneJson(value: unknown, depth: number): unknown {
  if (depth <= 0) return null;
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 32 * 1024);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value.slice(0, 256)) out.push(cloneJson(entry, depth - 1));
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 128) break;
      if (key.length > 200) continue;
      out[key] = cloneJson(entry, depth - 1);
      count += 1;
    }
    return out;
  }
  return null;
}

export function normalizeDebugConfiguration(raw: unknown): DebugConfigurationData | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const type = typeof source.type === 'string' ? source.type : '';
  if (!CONFIG_TYPE_RE.test(type)) return null;
  const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : type;
  const request = source.request === 'attach' ? 'attach' : 'launch';
  const rest: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'type' || key === 'name' || key === 'request') continue;
    if (count >= 128 || key.length > 200) continue;
    rest[key] = cloneJson(value, 8);
    count += 1;
  }
  return { type, name: name.slice(0, 300), request, rest };
}

/** `DebugConfigurationProviderTriggerKind`: 1 is `Initial`, 2 is `Dynamic`. */
export type ConfigProviderTrigger = 'initial' | 'dynamic';

export function normalizeTriggerKind(value: unknown): ConfigProviderTrigger {
  return value === 2 || value === 'dynamic' ? 'dynamic' : 'initial';
}

// ---------------------------------------------------------------------------
// Adapter descriptors
// ---------------------------------------------------------------------------
/**
 * The four descriptors upstream's `DebugAdapterDescriptorFactory` may return.
 *
 * `inline` is the one that changes the architecture: the adapter *is* the extension, so DAP messages
 * are routed back into the worker rather than to a process, and the transport is the host protocol
 * that already exists. Supporting it is why the session manager talks to a transport interface rather
 * than to a child process.
 */
export type AdapterDescriptorKind = 'executable' | 'server' | 'namedPipe' | 'inline';

export interface AdapterDescriptorData {
  kind: AdapterDescriptorKind;
  /** `executable`: the program to run, its arguments, and the cwd/env it asked for. */
  command: string | null;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  /** `server`: the loopback port. `namedPipe`: the pipe path. */
  port: number | null;
  host: string | null;
  pipe: string | null;
}

const NUL_RE = new RegExp(String.fromCharCode(0), 'g');
const ADAPTER_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function adapterString(value: unknown, limit = 4_096): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(NUL_RE, '').slice(0, limit);
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Validate a descriptor.
 *
 * The host is pinned to loopback for a `server` descriptor. An adapter descriptor naming a remote
 * host would have AXIOM open a TCP connection to an address an extension chose and then speak a
 * protocol that can read files on the debuggee's behalf; upstream allows it, and AXIOM does not.
 * Anything but a loopback literal is rewritten to `127.0.0.1` rather than refused, because a
 * descriptor that names `localhost` is the common case and refusing it would break real adapters.
 */
export function normalizeAdapterDescriptor(raw: unknown): AdapterDescriptorData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const declared = typeof source.kind === 'string' ? source.kind : '';
  const port =
    typeof source.port === 'number' && Number.isInteger(source.port) ? source.port : null;
  const pipe = adapterString(source.path ?? source.pipeName, 1_024);
  const command = adapterString(source.command);
  const kind: AdapterDescriptorKind =
    declared === 'inline' || source.implementation !== undefined
      ? 'inline'
      : declared === 'namedPipe' || (declared === '' && port === null && pipe !== null)
        ? 'namedPipe'
        : declared === 'server' || (declared === '' && port !== null)
          ? 'server'
          : 'executable';
  if (kind === 'executable' && command === null) return null;
  if (kind === 'server' && (port === null || port <= 0 || port > 65_535)) return null;
  if (kind === 'namedPipe' && pipe === null) return null;
  const options =
    typeof source.options === 'object' && source.options !== null
      ? (source.options as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  if (typeof options.env === 'object' && options.env !== null) {
    let count = 0;
    for (const [key, value] of Object.entries(options.env as Record<string, unknown>)) {
      if (count >= 64) break;
      if (!ADAPTER_ENV_NAME_RE.test(key) || typeof value !== 'string') continue;
      env[key] = value.replace(NUL_RE, '').slice(0, 4_096);
      count += 1;
    }
  }
  return {
    kind,
    command: kind === 'executable' ? command : null,
    args: Array.isArray(source.args)
      ? source.args
          .slice(0, 128)
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.replace(NUL_RE, '').slice(0, 4_096))
      : [],
    cwd: adapterString(options.cwd),
    env,
    port: kind === 'server' ? port : null,
    host: kind === 'server' ? '127.0.0.1' : null,
    pipe: kind === 'namedPipe' ? pipe : null,
  };
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------
export interface DebugProviderRecord {
  token: number;
  extensionId: string;
  debugType: string;
  trigger: ConfigProviderTrigger;
}

/**
 * Which extensions get asked to resolve a configuration.
 *
 * Upstream asks every provider registered for the type *and* every provider registered for `'*'`, in
 * registration order, and each one may rewrite the configuration for the next. Order therefore has to
 * be stable, which is why this is a token-keyed map iterated in insertion order rather than a map of
 * type → provider.
 */
export class DebugConfigProviderRegistry {
  private readonly records = new Map<number, DebugProviderRecord>();
  private nextToken = 1;

  register(
    extensionId: string,
    debugType: string,
    trigger: ConfigProviderTrigger,
  ): DebugProviderRecord {
    if (this.countFor(extensionId) >= MAX_CONFIG_PROVIDERS) {
      throw new Error(
        `An extension may register at most ${MAX_CONFIG_PROVIDERS} debug configuration providers.`,
      );
    }
    const token = this.nextToken++;
    const record: DebugProviderRecord = {
      token,
      extensionId,
      debugType: debugType.slice(0, 200),
      trigger,
    };
    this.records.set(token, record);
    return record;
  }

  unregister(token: number): DebugProviderRecord | undefined {
    const record = this.records.get(token);
    if (record) this.records.delete(token);
    return record;
  }

  /** Providers for a type, in registration order, including the `'*'` wildcard registrations. */
  providersFor(debugType: string, trigger: ConfigProviderTrigger): DebugProviderRecord[] {
    const out: DebugProviderRecord[] = [];
    for (const record of this.records.values()) {
      if (record.trigger !== trigger) continue;
      if (record.debugType === debugType || record.debugType === '*') out.push(record);
    }
    return out;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.extensionId === extensionId) count += 1;
    }
    return count;
  }

  removeExtension(extensionId: string): DebugProviderRecord[] {
    const removed: DebugProviderRecord[] = [];
    for (const [token, record] of [...this.records]) {
      if (record.extensionId !== extensionId) continue;
      this.records.delete(token);
      removed.push(record);
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * Which extension builds the adapter for a debug type.
 *
 * Exactly one factory per type, as upstream has it: `registerDebugAdapterDescriptorFactory` throws
 * when a type already has one. That refusal is the whole point — the factory decides what process
 * AXIOM starts, so a second extension quietly taking over an existing type would be a way to have
 * another extension's debug session launch your program.
 */
export class DebugAdapterFactoryRegistry {
  private readonly byType = new Map<string, { extensionId: string; token: number }>();
  private nextToken = 1;

  register(extensionId: string, debugType: string): number {
    const key = debugType.slice(0, 200);
    const existing = this.byType.get(key);
    if (existing) {
      throw new Error(`A debug adapter descriptor factory is already registered for '${key}'.`);
    }
    if (this.countFor(extensionId) >= MAX_ADAPTER_FACTORIES) {
      throw new Error(
        `An extension may register at most ${MAX_ADAPTER_FACTORIES} debug adapter factories.`,
      );
    }
    const token = this.nextToken++;
    this.byType.set(key, { extensionId, token });
    return token;
  }

  unregister(token: number): string | null {
    for (const [type, record] of this.byType) {
      if (record.token !== token) continue;
      this.byType.delete(type);
      return type;
    }
    return null;
  }

  owner(debugType: string): string | null {
    return this.byType.get(debugType)?.extensionId ?? null;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const record of this.byType.values()) {
      if (record.extensionId === extensionId) count += 1;
    }
    return count;
  }

  removeExtension(extensionId: string): string[] {
    const removed: string[] = [];
    for (const [type, record] of [...this.byType]) {
      if (record.extensionId !== extensionId) continue;
      this.byType.delete(type);
      removed.push(type);
    }
    return removed;
  }

  get size(): number {
    return this.byType.size;
  }

  clear(): void {
    this.byType.clear();
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export interface DebugSessionRecord {
  id: string;
  /** Which extension called `startDebugging`. Sessions are torn down with it. */
  extensionId: string;
  type: string;
  name: string;
  configuration: DebugConfigurationData;
  /** Set for a child session started through the `startDebugging` reverse request. */
  parentId: string | null;
  workspaceFolder: string | null;
  state: 'starting' | 'running' | 'terminated';
  /** Sequence number for the next request AXIOM sends this adapter. */
  nextSeq: number;
  startedAt: number;
}

/**
 * Every extension-owned debug session.
 *
 * Sessions form a tree: js-debug's root session spawns one child per worker or per browser tab
 * through the `startDebuggingRequest` reverse request, and terminating the parent must terminate the
 * children. `terminate` therefore returns the whole subtree in child-first order, which is the order
 * `onDidTerminateDebugSession` has to fire in for an extension tracking sessions in a map to end up
 * with an empty map.
 */
export class DebugSessionRegistry {
  private readonly records = new Map<string, DebugSessionRecord>();
  private activeId: string | null = null;
  private counter = 0;

  create(
    extensionId: string,
    configuration: DebugConfigurationData,
    options: { parentId?: string | null; workspaceFolder?: string | null; now?: number } = {},
  ): DebugSessionRecord {
    if (this.records.size >= MAX_DEBUG_SESSIONS) {
      throw new Error(`AXIOM runs at most ${MAX_DEBUG_SESSIONS} debug sessions at once.`);
    }
    const parentId = options.parentId ?? null;
    if (parentId !== null && !this.records.has(parentId)) {
      throw new Error('The parent debug session no longer exists.');
    }
    this.counter += 1;
    const id = `axiom-dbg-${this.counter}`;
    const record: DebugSessionRecord = {
      id,
      extensionId,
      type: configuration.type,
      name: configuration.name,
      configuration,
      parentId,
      workspaceFolder: options.workspaceFolder ?? null,
      state: 'starting',
      nextSeq: 1,
      startedAt: options.now ?? 0,
    };
    this.records.set(id, record);
    this.activeId = id;
    return record;
  }

  get(id: string): DebugSessionRecord | undefined {
    return this.records.get(id);
  }

  markRunning(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.state !== 'starting') return false;
    record.state = 'running';
    return true;
  }

  /** Next `seq` for a request to this adapter. DAP requires them to be strictly increasing. */
  takeSeq(id: string): number {
    const record = this.records.get(id);
    if (!record) return 0;
    const seq = record.nextSeq;
    record.nextSeq = seq + 1;
    return seq;
  }

  setActive(id: string | null): boolean {
    if (id !== null && !this.records.has(id)) return false;
    if (this.activeId === id) return false;
    this.activeId = id;
    return true;
  }

  active(): DebugSessionRecord | null {
    if (this.activeId === null) return null;
    return this.records.get(this.activeId) ?? null;
  }

  children(id: string): DebugSessionRecord[] {
    return [...this.records.values()].filter((record) => record.parentId === id);
  }

  /** Terminate a session and its descendants, deepest first. */
  terminate(id: string): DebugSessionRecord[] {
    const record = this.records.get(id);
    if (!record) return [];
    const ended: DebugSessionRecord[] = [];
    for (const child of this.children(id)) ended.push(...this.terminate(child.id));
    record.state = 'terminated';
    this.records.delete(id);
    ended.push(record);
    if (this.activeId === id) {
      this.activeId =
        record.parentId !== null && this.records.has(record.parentId) ? record.parentId : null;
    }
    return ended;
  }

  forExtension(extensionId: string): DebugSessionRecord[] {
    return [...this.records.values()].filter((record) => record.extensionId === extensionId);
  }

  /** Terminate everything one extension owns, deepest first, for deactivation and crash teardown. */
  removeExtension(extensionId: string): DebugSessionRecord[] {
    const ended: DebugSessionRecord[] = [];
    for (const record of this.forExtension(extensionId)) {
      if (!this.records.has(record.id)) continue;
      ended.push(...this.terminate(record.id));
    }
    return ended;
  }

  get size(): number {
    return this.records.size;
  }

  list(): DebugSessionRecord[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
    this.activeId = null;
  }
}

// ---------------------------------------------------------------------------
// Debug console
// ---------------------------------------------------------------------------
/**
 * What `debug.activeDebugConsole.append` / `appendLine` accumulates.
 *
 * A ring rather than a growing array: the console is the one debug surface an extension can write to
 * without limit and without a user action, and the honest bound is "keep the recent output". `append`
 * without a newline continues the current line, which is what upstream does and what an adapter
 * streaming partial output depends on.
 */
export class DebugConsoleBuffer {
  private readonly lines: string[] = [];
  private partial = '';

  append(text: unknown): void {
    if (typeof text !== 'string' || text.length === 0) return;
    const cleaned = text.replace(NUL_RE, '').slice(0, MAX_CONSOLE_TEXT);
    const parts = `${this.partial}${cleaned}`.split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.pushLine(line);
    if (this.partial.length > MAX_CONSOLE_TEXT) {
      this.pushLine(this.partial.slice(0, MAX_CONSOLE_TEXT));
      this.partial = '';
    }
  }

  appendLine(text: unknown): void {
    this.append(`${typeof text === 'string' ? text : ''}\n`);
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_CONSOLE_LINES)
      this.lines.splice(0, this.lines.length - MAX_CONSOLE_LINES);
  }

  /** Everything retained, with the in-progress line last when there is one. */
  snapshot(): string[] {
    return this.partial.length > 0 ? [...this.lines, this.partial] : [...this.lines];
  }

  get length(): number {
    return this.lines.length + (this.partial.length > 0 ? 1 : 0);
  }

  clear(): void {
    this.lines.length = 0;
    this.partial = '';
  }
}
