/**
 * VS Code terminal runtime (PRD Phase 7 — §1 Terminal API).
 *
 * PURE module: no I/O, no Electron, no node-pty. Everything an extension's `window.createTerminal`
 * call means *before* a process exists lives here — option validation, the terminal registry, the
 * environment-variable collections, the profile registry, and the state each terminal reports.
 *
 * Why a separate module rather than logic inside the service: the pty itself is owned by AXIOM's
 * existing terminal subsystem (renderer-created, Main-spawned), which Phase 7 deliberately does not
 * rewrite. What was missing was the *bookkeeping* upstream does around it — names, icons, split
 * parents, shell integration, `EnvironmentVariableCollection` persistence, `TerminalState` — and all
 * of that is decidable without touching a process, so it is testable in-process by the validators.
 */

/** Terminals one extension may own at once. A registry, not a resource pool: bounded on purpose. */
export const MAX_TERMINALS_PER_EXTENSION = 16;
/** Terminals AXIOM will track for extensions in total, across every host. */
export const MAX_EXTENSION_TERMINALS = 64;
/** Longest text one `sendText` may carry. Matches the host protocol's string limit. */
export const MAX_SEND_TEXT = 8 * 1024;
/** Environment variable mutations one extension may declare. */
export const MAX_ENV_MUTATIONS = 64;
/** Terminal profile providers one extension may register. */
export const MAX_PROFILE_PROVIDERS = 8;
/** Longest terminal name AXIOM will show. */
export const MAX_TERMINAL_NAME = 200;

/** Where a terminal is drawn. `panel` is the terminal panel; `editor` is an editor tab. */
export type TerminalLocationKind = 'panel' | 'editor';

/** What an extension asked for. Validated; never trusted as written. */
export interface TerminalRequest {
  name: string;
  shellPath: string | null;
  shellArgs: string[];
  cwd: string | null;
  env: Record<string, string | null>;
  strictEnv: boolean;
  hideFromUser: boolean;
  isTransient: boolean;
  iconPath: string | null;
  color: string | null;
  message: string | null;
  location: TerminalLocationKind;
  /** Handle of the terminal this one splits from, when `location` was a split request. */
  splitParent: number | null;
  /** True when the extension supplied a `Pseudoterminal` — the extension writes the output. */
  extensionPty: boolean;
}

/** `Terminal.state`, as upstream reports it. */
export interface TerminalStateData {
  isInteractedWith: boolean;
  shellIntegration: boolean;
}

/** One tracked terminal. `processId` stays null until the pty reports it. */
export interface TerminalRecord {
  handle: number;
  extensionId: string;
  request: TerminalRequest;
  /** The id AXIOM's own terminal subsystem knows this session by, once it has one. */
  sessionId: string | null;
  processId: number | null;
  exitCode: number | null;
  state: TerminalStateData;
  disposed: boolean;
}

function clampString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, limit);
  return trimmed.length === 0 ? null : trimmed;
}

function stringList(value: unknown, limit: number, each: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, limit)) {
    if (typeof entry === 'string') out.push(entry.slice(0, each));
  }
  return out;
}

/**
 * Environment an extension may hand a terminal.
 *
 * A `null` value is upstream's "unset this variable", which is meaningful and kept. Keys are
 * restricted to the portable environment-variable grammar so a crafted name cannot be used to
 * smuggle a shell fragment through a spawn that later interpolates it.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeTerminalEnv(value: unknown): Record<string, string | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | null> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_ENV_MUTATIONS) break;
    if (!ENV_NAME_RE.test(key)) continue;
    if (entry === null) {
      out[key] = null;
      count += 1;
      continue;
    }
    if (typeof entry !== 'string') continue;
    out[key] = entry.slice(0, 4_096);
    count += 1;
  }
  return out;
}

/**
 * A colour an extension asked a terminal tab to take.
 *
 * Only theme colour *ids* are accepted, never CSS. The renderer resolves the id against the active
 * theme, so an extension cannot inject a colour value — or anything that parses as one — into a
 * stylesheet.
 */
const THEME_COLOR_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

export function normalizeThemeColorId(value: unknown): string | null {
  if (typeof value === 'string') {
    return THEME_COLOR_RE.test(value) && value.length <= 120 ? value : null;
  }
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && THEME_COLOR_RE.test(id) && id.length <= 120) return id;
  }
  return null;
}

/** A `ThemeIcon` id, or null. Files are refused here: the tab strip draws codicons only. */
const ICON_ID_RE = /^[a-z][a-z0-9-]{0,60}$/;

export function normalizeTerminalIcon(value: unknown): string | null {
  if (typeof value === 'string') return ICON_ID_RE.test(value) ? value : null;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && ICON_ID_RE.test(id)) return id;
  }
  return null;
}

/**
 * Validate `TerminalOptions` / `ExtensionTerminalOptions` into a `TerminalRequest`.
 *
 * Never throws: an unusable field falls back to the default rather than failing the call, because
 * upstream creates the terminal regardless and an extension that asked for a colour AXIOM cannot
 * draw should still get its terminal. The one thing this cannot decide is whether `cwd` is inside the
 * workspace — that needs the roots, so the service decides it.
 */
export function normalizeTerminalRequest(raw: unknown): TerminalRequest {
  const options = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const locationRaw = options.location;
  let location: TerminalLocationKind = 'panel';
  let splitParent: number | null = null;
  if (locationRaw === 2) location = 'editor';
  else if (typeof locationRaw === 'object' && locationRaw !== null) {
    const parent = (locationRaw as { parentTerminal?: unknown }).parentTerminal;
    const handle =
      typeof parent === 'object' && parent !== null
        ? (parent as { _axiomHandle?: unknown })._axiomHandle
        : undefined;
    if (typeof handle === 'number' && Number.isInteger(handle) && handle > 0) splitParent = handle;
    if ((locationRaw as { viewColumn?: unknown }).viewColumn !== undefined) location = 'editor';
  }
  return {
    name: clampString(options.name, MAX_TERMINAL_NAME) ?? 'Terminal',
    shellPath: clampString(options.shellPath, 4_096),
    shellArgs:
      typeof options.shellArgs === 'string'
        ? [options.shellArgs.slice(0, 4_096)]
        : stringList(options.shellArgs, 32, 4_096),
    cwd: clampString(readCwd(options.cwd), 4_096),
    env: normalizeTerminalEnv(options.env),
    strictEnv: options.strictEnv === true,
    hideFromUser: options.hideFromUser === true,
    isTransient: options.isTransient === true,
    iconPath: normalizeTerminalIcon(options.iconPath),
    color: normalizeThemeColorId(options.color),
    message: clampString(options.message, 2_000),
    location,
    splitParent,
    extensionPty: typeof options.pty === 'object' && options.pty !== null,
  };
}

/** `cwd` may be a string or a `Uri`; both reduce to a filesystem path here. */
function readCwd(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const fsPath = (value as { fsPath?: unknown }).fsPath;
    if (typeof fsPath === 'string') return fsPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
/**
 * Every extension-created terminal AXIOM is tracking.
 *
 * Bounded twice — per extension and in total — because a terminal is a real OS process and a loop
 * that creates them is the cheapest denial of service an extension has. Exceeding either limit
 * throws, so the extension sees the refusal instead of silently getting no terminal.
 */
export class TerminalRegistry {
  private readonly records = new Map<number, TerminalRecord>();
  private nextHandle = 1;
  private activeHandle: number | null = null;

  create(extensionId: string, request: TerminalRequest): TerminalRecord {
    if (this.records.size >= MAX_EXTENSION_TERMINALS) {
      throw new Error(`AXIOM tracks at most ${MAX_EXTENSION_TERMINALS} extension terminals.`);
    }
    if (this.countFor(extensionId) >= MAX_TERMINALS_PER_EXTENSION) {
      throw new Error(
        `An extension may own at most ${MAX_TERMINALS_PER_EXTENSION} terminals at once.`,
      );
    }
    const handle = this.nextHandle++;
    const record: TerminalRecord = {
      handle,
      extensionId,
      request,
      sessionId: null,
      processId: null,
      exitCode: null,
      state: { isInteractedWith: false, shellIntegration: false },
      disposed: false,
    };
    this.records.set(handle, record);
    return record;
  }

  get(handle: number): TerminalRecord | undefined {
    return this.records.get(handle);
  }

  /**
   * Find by the session id AXIOM's terminal subsystem uses, which is what events carry.
   *
   * An empty id matches nothing on purpose: `sessionId` is null until a pane is adopted, and an
   * empty string arriving from a report must not resolve to whichever terminal is still waiting.
   */
  bySession(sessionId: string): TerminalRecord | undefined {
    if (sessionId.length === 0) return undefined;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  /**
   * Bind a terminal to the pane that adopted it. One pane per terminal, once.
   *
   * A second attach is refused rather than honoured, so a duplicate report — two windows adopting
   * the same `create`, or a repeated `opened` — cannot move a live terminal onto another pane.
   */
  attachSession(handle: number, sessionId: string, processId: number | null): boolean {
    const record = this.records.get(handle);
    if (!record || record.disposed) return false;
    if (sessionId.length === 0 || record.sessionId !== null) return false;
    record.sessionId = sessionId;
    record.processId = processId;
    return true;
  }

  /** Mark a terminal interacted with. Idempotent; returns true only on the transition. */
  markInteracted(handle: number): boolean {
    const record = this.records.get(handle);
    if (!record || record.state.isInteractedWith) return false;
    record.state.isInteractedWith = true;
    return true;
  }

  markShellIntegration(handle: number, available: boolean): boolean {
    const record = this.records.get(handle);
    if (!record || record.state.shellIntegration === available) return false;
    record.state.shellIntegration = available;
    return true;
  }

  setActive(handle: number | null): boolean {
    if (handle !== null && !this.records.has(handle)) return false;
    if (this.activeHandle === handle) return false;
    this.activeHandle = handle;
    return true;
  }

  active(): TerminalRecord | null {
    if (this.activeHandle === null) return null;
    return this.records.get(this.activeHandle) ?? null;
  }

  /** Close a terminal. Returns the record so the caller can fire `onDidCloseTerminal` once. */
  dispose(handle: number, exitCode: number | null): TerminalRecord | undefined {
    const record = this.records.get(handle);
    if (!record) return undefined;
    record.disposed = true;
    record.exitCode = exitCode;
    this.records.delete(handle);
    if (this.activeHandle === handle) this.activeHandle = null;
    return record;
  }

  /** Everything one extension owns, for deactivation and for crash teardown. */
  removeExtension(extensionId: string): TerminalRecord[] {
    const removed: TerminalRecord[] = [];
    for (const [handle, record] of [...this.records]) {
      if (record.extensionId !== extensionId) continue;
      record.disposed = true;
      this.records.delete(handle);
      if (this.activeHandle === handle) this.activeHandle = null;
      removed.push(record);
    }
    return removed;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.extensionId === extensionId) count += 1;
    }
    return count;
  }

  get size(): number {
    return this.records.size;
  }

  list(): TerminalRecord[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
    this.activeHandle = null;
  }
}

// ---------------------------------------------------------------------------
// sendText
// ---------------------------------------------------------------------------
const NUL_RE = new RegExp(String.fromCharCode(0), 'g');

/**
 * What `Terminal.sendText(text, addNewLine)` actually puts on the pty's stdin.
 *
 * Upstream appends a newline when `addNewLine` is omitted or true, and sends the text verbatim
 * otherwise. Two details matter here and nowhere else: the newline is a carriage return (a pty reads
 * CR as Enter — LF alone leaves the shell waiting), and NUL bytes are stripped, because a NUL
 * truncates the string at the C boundary inside the pty and would silently drop the rest of a line.
 *
 * The text is *not* escaped or quoted. `sendText` is upstream's "type this at the prompt" primitive
 * and an extension may legitimately send a pipeline; the security boundary for terminals is the cwd
 * and the environment, both validated elsewhere, not the keystrokes.
 */
export function normalizeSendText(raw: unknown, addNewLine: unknown): string {
  const text = typeof raw === 'string' ? raw.slice(0, MAX_SEND_TEXT).replace(NUL_RE, '') : '';
  const newline = addNewLine === undefined || addNewLine === true;
  if (!newline) return text;
  return text.endsWith('\r') || text.endsWith('\n') ? text : `${text}\r`;
}

// ---------------------------------------------------------------------------
// EnvironmentVariableCollection
// ---------------------------------------------------------------------------
/** How a mutation combines with the value already in the environment. Upstream's enum values. */
export type EnvMutationType = 'replace' | 'append' | 'prepend';

export interface EnvMutation {
  variable: string;
  value: string;
  type: EnvMutationType;
  /** Upstream's `EnvironmentVariableMutatorOptions`. Both default to false. */
  applyAtProcessCreation: boolean;
  applyAtShellIntegration: boolean;
}

/** One extension's collection, plus the per-scope collections it asked for. */
export interface EnvCollectionData {
  description: string | null;
  persistent: boolean;
  mutations: EnvMutation[];
  /** Scoped collections, keyed by the scope's stable key. Upstream: `getScoped`. */
  scoped: Record<string, EnvMutation[]>;
}

export function normalizeEnvMutationType(value: unknown): EnvMutationType {
  if (value === 1 || value === 'replace') return 'replace';
  if (value === 2 || value === 'append') return 'append';
  if (value === 3 || value === 'prepend') return 'prepend';
  return 'replace';
}

/**
 * A scope key an extension may ask for. Only a workspace folder path scopes a collection.
 *
 * Both shapes reduce here: the `EnvironmentVariableScope` an extension passes to `getScoped()`, and
 * the folder path the IPC layer has already clamped it to. The string form is the one that arrives in
 * practice — the payload validator flattens the scope to a path before the service sees it — and
 * accepting only the object form would silently turn every scoped collection into the global one.
 */
export function envScopeKey(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 4_096);
  if (typeof value !== 'object' || value === null) return '';
  const folder = (value as { workspaceFolder?: unknown }).workspaceFolder;
  if (typeof folder !== 'object' || folder === null) return '';
  const uri = (folder as { uri?: unknown }).uri;
  const fsPath =
    typeof uri === 'object' && uri !== null ? (uri as { fsPath?: unknown }).fsPath : undefined;
  return typeof fsPath === 'string' ? fsPath.slice(0, 4_096) : '';
}

/**
 * The per-extension environment-variable collections.
 *
 * Upstream keeps these alive across restarts when `persistent` is true, which is why the store is
 * serialisable rather than a set of closures: the service writes `serialize()` to disk on change and
 * feeds `restore()` back at startup. A non-persistent collection is dropped on restore, which is
 * exactly what upstream's flag means.
 *
 * Mutations are bounded per extension. An unbounded collection is not a crash but it is a way to
 * grow every future terminal's environment without limit, and the pty spawn pays for it.
 */
export class EnvCollectionStore {
  private readonly byExtension = new Map<string, EnvCollectionData>();

  private collection(extensionId: string): EnvCollectionData {
    const existing = this.byExtension.get(extensionId);
    if (existing) return existing;
    const created: EnvCollectionData = {
      description: null,
      persistent: true,
      mutations: [],
      scoped: {},
    };
    this.byExtension.set(extensionId, created);
    return created;
  }

  /** Replace/append/prepend one variable. Returns false when the name or the cap refuses it. */
  mutate(
    extensionId: string,
    scope: string,
    variable: string,
    value: string,
    type: EnvMutationType,
    options: { applyAtProcessCreation?: boolean; applyAtShellIntegration?: boolean } = {},
  ): boolean {
    if (!ENV_NAME_RE.test(variable)) return false;
    const collection = this.collection(extensionId);
    const list = scope === '' ? collection.mutations : (collection.scoped[scope] ??= []);
    const mutation: EnvMutation = {
      variable,
      value: value.slice(0, 4_096),
      type,
      applyAtProcessCreation: options.applyAtProcessCreation !== false,
      applyAtShellIntegration: options.applyAtShellIntegration === true,
    };
    const index = list.findIndex((entry) => entry.variable === variable);
    if (index >= 0) {
      list[index] = mutation;
      return true;
    }
    if (this.countFor(extensionId) >= MAX_ENV_MUTATIONS) return false;
    list.push(mutation);
    return true;
  }

  get(extensionId: string, scope: string, variable: string): EnvMutation | undefined {
    const collection = this.byExtension.get(extensionId);
    if (!collection) return undefined;
    const list = scope === '' ? collection.mutations : collection.scoped[scope];
    return list?.find((entry) => entry.variable === variable);
  }

  delete(extensionId: string, scope: string, variable: string): boolean {
    const collection = this.byExtension.get(extensionId);
    if (!collection) return false;
    const list = scope === '' ? collection.mutations : collection.scoped[scope];
    if (!list) return false;
    const index = list.findIndex((entry) => entry.variable === variable);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  }

  /** `clear()` on the collection: drop the scope's mutations, or all of them for the root scope. */
  clearScope(extensionId: string, scope: string): boolean {
    const collection = this.byExtension.get(extensionId);
    if (!collection) return false;
    if (scope === '') {
      collection.mutations = [];
      collection.scoped = {};
      return true;
    }
    if (collection.scoped[scope] === undefined) return false;
    delete collection.scoped[scope];
    return true;
  }

  setDescription(extensionId: string, description: string | null): void {
    this.collection(extensionId).description = description;
  }

  setPersistent(extensionId: string, persistent: boolean): void {
    this.collection(extensionId).persistent = persistent;
  }

  data(extensionId: string): EnvCollectionData | undefined {
    return this.byExtension.get(extensionId);
  }

  countFor(extensionId: string): number {
    const collection = this.byExtension.get(extensionId);
    if (!collection) return 0;
    let count = collection.mutations.length;
    for (const list of Object.values(collection.scoped)) count += list.length;
    return count;
  }

  removeExtension(extensionId: string): boolean {
    return this.byExtension.delete(extensionId);
  }

  /** Persistable state: only the collections whose owner asked for persistence. */
  serialize(): Record<string, EnvCollectionData> {
    const out: Record<string, EnvCollectionData> = {};
    for (const [extensionId, collection] of this.byExtension) {
      if (!collection.persistent) continue;
      out[extensionId] = collection;
    }
    return out;
  }

  /**
   * Every collection, persistent or not.
   *
   * What a terminal is actually spawned with. Kept separate from {@link serialize} because the two
   * questions differ: a non-persistent collection still applies to the terminals of this session,
   * it just is not written to disk. Folding them into one method is how a non-persistent collection
   * ends up either ignored while the app runs or resurrected after a restart.
   */
  all(): Record<string, EnvCollectionData> {
    const out: Record<string, EnvCollectionData> = {};
    for (const [extensionId, collection] of this.byExtension) out[extensionId] = collection;
    return out;
  }

  /** Rehydrate from `serialize()`. Anything malformed is dropped rather than trusted. */
  restore(raw: unknown): number {
    if (typeof raw !== 'object' || raw === null) return 0;
    let restored = 0;
    for (const [extensionId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const source = value as Partial<EnvCollectionData>;
      if (source.persistent === false) continue;
      const collection = this.collection(extensionId);
      collection.description = clampString(source.description, 500);
      collection.persistent = true;
      collection.mutations = restoreMutations(source.mutations);
      collection.scoped = {};
      if (typeof source.scoped === 'object' && source.scoped !== null) {
        for (const [scope, list] of Object.entries(source.scoped)) {
          collection.scoped[scope.slice(0, 4_096)] = restoreMutations(list);
        }
      }
      restored += 1;
    }
    return restored;
  }

  clear(): void {
    this.byExtension.clear();
  }
}

function restoreMutations(raw: unknown): EnvMutation[] {
  if (!Array.isArray(raw)) return [];
  const out: EnvMutation[] = [];
  for (const entry of raw.slice(0, MAX_ENV_MUTATIONS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.variable !== 'string' || !ENV_NAME_RE.test(record.variable)) continue;
    out.push({
      variable: record.variable,
      value: typeof record.value === 'string' ? record.value.slice(0, 4_096) : '',
      type: normalizeEnvMutationType(record.type),
      applyAtProcessCreation: record.applyAtProcessCreation !== false,
      applyAtShellIntegration: record.applyAtShellIntegration === true,
    });
  }
  return out;
}

/**
 * Fold every extension's collection into the environment a terminal will actually be spawned with.
 *
 * Only mutations marked `applyAtProcessCreation` participate — the shell-integration ones are
 * applied by the integration script inside the shell, which AXIOM does not run, so applying them
 * here would change the environment at a point upstream does not. Extensions are folded in id order
 * so the result is deterministic when two of them touch the same variable.
 */
export function applyEnvCollections(
  base: Record<string, string>,
  collections: Record<string, EnvCollectionData>,
  scope: string,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const extensionId of Object.keys(collections).sort()) {
    const collection = collections[extensionId];
    if (!collection) continue;
    const lists = [collection.mutations, scope === '' ? [] : (collection.scoped[scope] ?? [])];
    for (const list of lists) {
      for (const mutation of list) {
        if (!mutation.applyAtProcessCreation) continue;
        const current = out[mutation.variable] ?? '';
        if (mutation.type === 'append') out[mutation.variable] = `${current}${mutation.value}`;
        else if (mutation.type === 'prepend')
          out[mutation.variable] = `${mutation.value}${current}`;
        else out[mutation.variable] = mutation.value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminal profiles
// ---------------------------------------------------------------------------
/** A profile an extension contributes. `id` is the `terminal.profiles` contribution id. */
export interface TerminalProfileRecord {
  id: string;
  extensionId: string;
}

/**
 * Which extension answers which contributed terminal profile.
 *
 * A registry rather than a map of callbacks because the callback lives in the worker: resolving a
 * profile is a round trip, and all this side needs is who to ask. Re-registering the same id from the
 * same extension replaces it (upstream disposes and re-registers on configuration change); a second
 * extension claiming an id already taken is refused, so a late loader cannot hijack a profile.
 */
export class TerminalProfileRegistry {
  private readonly byId = new Map<string, TerminalProfileRecord>();

  register(extensionId: string, id: string): boolean {
    const existing = this.byId.get(id);
    if (existing && existing.extensionId !== extensionId) return false;
    if (!existing && this.countFor(extensionId) >= MAX_PROFILE_PROVIDERS) return false;
    this.byId.set(id, { id, extensionId });
    return true;
  }

  unregister(extensionId: string, id: string): boolean {
    const existing = this.byId.get(id);
    if (!existing || existing.extensionId !== extensionId) return false;
    return this.byId.delete(id);
  }

  owner(id: string): string | null {
    return this.byId.get(id)?.extensionId ?? null;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const record of this.byId.values()) {
      if (record.extensionId === extensionId) count += 1;
    }
    return count;
  }

  removeExtension(extensionId: string): string[] {
    const removed: string[] = [];
    for (const [id, record] of [...this.byId]) {
      if (record.extensionId !== extensionId) continue;
      this.byId.delete(id);
      removed.push(id);
    }
    return removed;
  }

  list(): TerminalProfileRecord[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}
