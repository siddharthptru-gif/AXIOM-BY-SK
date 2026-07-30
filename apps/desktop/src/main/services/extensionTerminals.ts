/**
 * The extension terminal runtime (PRD Phase 7 §1).
 *
 * AXIOM already has an integrated terminal: `main/services/terminal.ts` owns every pty, and the
 * renderer owns creation because xterm.js is where the bytes are drawn. Phase 7 does not add a second
 * terminal subsystem. It *adopts* extension terminals into the one that exists:
 *
 *   - an extension calls `window.createTerminal`, which mints a handle in its own worker;
 *   - this file validates the request, folds in the environment variable collections, and asks the
 *     renderer to create the pane through the same `term:create` path a user's terminal takes;
 *   - the renderer reports back the session id it minted, and from then on the pane is an ordinary
 *     terminal that happens to have an owner.
 *
 * A `Pseudoterminal` is the one case with no pty at all: the extension *is* the process, so the
 * renderer opens a pane with no shell and the bytes flow `terminal.write` → renderer, and renderer →
 * `terminalInput` → the extension's `handleInput`. Nothing about that path can reach a real process,
 * which is why it is safe to let escape sequences through it.
 *
 * What this file deliberately does not do: spawn anything, hold a pty, or touch `terminal.ts`. The
 * protected subsystem keeps its single owner, and an extension gets a terminal by asking the same
 * question a user does.
 */
import { rootLogger } from '@axiom/shared';
import { isAbsolute, relative } from 'node:path';

import type { ExtensionTerminalCommand, ExtensionTerminalInfo } from '../../common/ipc';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  EnvCollectionStore,
  MAX_PROFILE_PROVIDERS,
  TerminalProfileRegistry,
  TerminalRegistry,
  applyEnvCollections,
  envScopeKey,
  normalizeEnvMutationType,
  normalizeSendText,
  normalizeTerminalRequest,
  type TerminalProfileRecord,
  type TerminalRecord,
  type TerminalRequest,
} from '../../common/vscodeTerminalRuntime';
import { assertAuthorizedPath } from './pathAuthorization';

const log = rootLogger.child('extension-terminals');

/** How long a contributed terminal profile provider gets to answer. */
const PROFILE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts and the workbench
// ---------------------------------------------------------------------------
export interface TerminalsHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Post to every running host. */
  broadcast(message: MainToWorker): void;
  /** Call into a worker and await its reply. */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The terminal list changed: the workbench must re-read it. */
  notifyChanged(): void;
  /** Ask the renderer to create, show, hide, rename, write to or close a pane. */
  command(command: ExtensionTerminalCommand): void;
  /** Absolute workspace folder paths, for the `cwd` boundary check. */
  workspaceRoots(): string[];
  /** The environment a child process would be spawned with, before the collections are folded in. */
  baseEnvironment(): Record<string, string>;
  /** Persist the environment variable collections that asked to survive a restart. */
  persistEnvCollections(state: Record<string, unknown>): void;
}

let bridge: TerminalsHostBridge | null = null;

export function configureExtensionTerminals(next: TerminalsHostBridge): void {
  bridge = next;
}

function requireBridge(): TerminalsHostBridge {
  if (bridge === null) throw new Error('The extension terminal runtime is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const terminals = new TerminalRegistry();
const profiles = new TerminalProfileRegistry();
const environments = new EnvCollectionStore();
/** Bumped on every change so a stale snapshot in the renderer can be recognised as stale. */
let revision = 1;

/**
 * How a pane the renderer has not created yet must be spawned.
 *
 * The shell, the directory and the environment stay in Main. The renderer is told to create a pane
 * for a handle and nothing else: it passes the handle back on `term:create`, and Main reads the
 * spec out of here. Sending the environment to the renderer instead would hand it the contents of
 * the process environment — the very thing the preload boundary exists to keep out of it.
 *
 * One entry per pending pty-backed terminal, so it is bounded by the terminal registry's own cap,
 * and read exactly once: a renderer that replayed a handle would find nothing to spawn from.
 */
interface TerminalSpawnSpec {
  shell: string;
  cwd: string;
  env: Record<string, string>;
}

const pendingSpawns = new Map<number, TerminalSpawnSpec>();

/**
 * Shell ids AXIOM knows how to spawn, keyed by what an extension might name.
 *
 * `TerminalOptions.shellPath` is a path to an executable upstream, and honouring it verbatim would
 * mean spawning a binary an extension chose. AXIOM spawns from a closed set instead: a `shellPath`
 * that names one of them is honoured, and anything else falls back to the workbench default.
 */
const SHELL_IDS: Readonly<Record<string, string>> = {
  cmd: 'cmd',
  bash: 'gitbash',
  sh: 'gitbash',
  'git-bash': 'gitbash',
  wsl: 'wsl',
  pwsh: 'pwsh',
  powershell: 'powershell',
};

function shellIdFor(shellPath: string | null): string {
  if (shellPath === null) return '';
  const base = shellPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
  return SHELL_IDS[name] ?? '';
}

/**
 * The spawn spec for a pane the renderer is creating, consumed on read.
 *
 * Returns null for a handle that is not waiting to be spawned — an unknown handle, a second
 * `term:create` for the same one, or a `Pseudoterminal`, which has no process to spawn at all.
 */
export function extensionTerminalSpawnSpec(handle: number): TerminalSpawnSpec | null {
  const spec = pendingSpawns.get(handle);
  if (!spec) return null;
  pendingSpawns.delete(handle);
  return spec;
}

function changed(): void {
  revision += 1;
  bridge?.notifyChanged();
}

/** Is `path` inside `root`? Asked on already-canonical paths, so `relative` is the whole answer. */
function contains(root: string, path: string): boolean {
  if (root.length === 0) return false;
  const rest = relative(root, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** The shape the workbench draws a pane from. Never carries a path, a URL or a CSS colour. */
function describe(record: TerminalRecord): ExtensionTerminalInfo {
  return {
    handle: record.handle,
    extensionId: record.extensionId,
    name: record.request.name,
    sessionId: record.sessionId ?? '',
    extensionPty: record.request.extensionPty,
    location: record.request.location,
    splitParent: record.request.splitParent ?? 0,
    iconId: record.request.iconPath ?? '',
    colorId: record.request.color ?? '',
    hideFromUser: record.request.hideFromUser,
    isInteractedWith: record.state.isInteractedWith,
    shellIntegration: record.state.shellIntegration,
  };
}

/** Every extension terminal, for the workbench's pull channel. */
export function extensionTerminalList(): { revision: number; terminals: ExtensionTerminalInfo[] } {
  return { revision, terminals: terminals.list().map(describe) };
}

// ---------------------------------------------------------------------------
// Requests from the extension hosts
// ---------------------------------------------------------------------------
const TERMINAL_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
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
]);

export function isTerminalsRequestKind(kind: HostRequestKind): boolean {
  return TERMINAL_REQUEST_KINDS.has(kind);
}

export async function handleTerminalsRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'terminal.create':
      // The worker's own handle rides along in the payload but is deliberately not adopted: handles
      // index one registry shared by every host, so main mints them and the reply carries the real
      // one back.
      return createTerminal(extensionId, payload.options);
    case 'terminal.dispose':
      return disposeTerminal(extensionId, Number(payload.handle));
    case 'terminal.sendText':
      return sendText(extensionId, Number(payload.handle), payload.text, payload.addNewLine);
    case 'terminal.show':
      return showTerminal(extensionId, Number(payload.handle), payload.preserveFocus === true);
    case 'terminal.hide':
      return hideTerminal(extensionId, Number(payload.handle));
    case 'terminal.setName':
      return renameTerminal(extensionId, Number(payload.handle), String(payload.name));
    case 'terminal.write':
      return writeToPty(extensionId, Number(payload.handle), String(payload.data));
    case 'terminal.registerProfileProvider':
      return registerProfileProvider(extensionId, String(payload.profileId));
    case 'terminal.unregisterProfileProvider':
      return profiles.unregister(extensionId, String(payload.profileId));
    case 'terminal.envMutate':
      return mutateEnvironment(extensionId, payload);
    case 'terminal.envClear':
      return clearEnvironment(extensionId, envScopeKey(payload.scope));
    case 'terminal.envDescribe':
      return describeEnvironment(extensionId, payload);
    default:
      throw new Error(`${kind} is not a terminal request.`);
  }
}

/**
 * The terminal named by `handle`, if this extension owns it.
 *
 * Every request re-checks ownership rather than trusting the handle, because handles are integers
 * minted by the worker: an extension that guessed one belonging to another extension would
 * otherwise be able to type into its shell. That is the whole boundary, so it is one function.
 */
function owned(extensionId: string, handle: number): TerminalRecord {
  const record = terminals.get(handle);
  if (!record || record.extensionId !== extensionId) {
    throw new Error('That terminal does not belong to this extension.');
  }
  if (record.disposed) throw new Error('That terminal has been closed.');
  return record;
}

/**
 * `window.createTerminal`.
 *
 * The `cwd` is authorised against the workspace before the renderer is asked for anything: a
 * terminal is a shell in a directory, so an unauthorised `cwd` is an escape from the workspace
 * with a prompt attached. A request that names one is refused outright rather than quietly
 * rewritten to the root, so the extension is not left believing it got what it asked for.
 */
async function createTerminal(
  extensionId: string,
  rawOptions: unknown,
): Promise<ExtensionTerminalInfo> {
  const host = requireBridge();
  const request = normalizeTerminalRequest(rawOptions);
  const roots = host.workspaceRoots();
  let cwd = roots[0] ?? '';
  if (request.cwd !== null) {
    cwd = await assertAuthorizedPath(request.cwd, { directory: true });
  }
  if (cwd.length === 0) throw new Error('No workspace is open, so a terminal has no directory.');
  if (request.splitParent !== null) {
    // Splitting is only meaningful against a pane this extension already owns; a foreign handle
    // here would let one extension place a pane inside another's.
    owned(extensionId, request.splitParent);
  }
  const record = terminals.create(extensionId, request);
  const info = describe(record);
  // A scoped collection is keyed by the workspace folder path, so the scope a terminal resolves
  // against is the root that contains its directory, not the directory itself.
  const scope = roots.find((root) => contains(root, cwd)) ?? '';
  if (!request.extensionPty) {
    pendingSpawns.set(record.handle, {
      shell: shellIdFor(request.shellPath),
      cwd,
      env: environmentFor(request.strictEnv ? {} : host.baseEnvironment(), request.env, scope),
    });
  }
  host.command({ op: 'create', handle: record.handle, extensionId, terminal: info });
  changed();
  log.info('An extension asked for a terminal', {
    id: extensionId,
    handle: record.handle,
    pty: request.extensionPty,
  });
  return info;
}

/**
 * The environment one terminal is spawned with.
 *
 * Three layers, in upstream's order: the process environment (or nothing at all when the extension
 * asked for `strictEnv`), then every extension's `EnvironmentVariableCollection`, then the
 * `env` the caller passed, which wins because it is the most specific. A `null` in `env` is
 * upstream's "unset", and is honoured by deleting the key rather than setting an empty string.
 */
function environmentFor(
  base: Record<string, string>,
  env: Record<string, string | null>,
  scopePath: string,
): Record<string, string> {
  const withCollections = applyEnvCollections(base, environments.all(), scopePath);
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete withCollections[key];
    else withCollections[key] = value;
  }
  return withCollections;
}

/** `Terminal.dispose()`. The pane closes; `onDidCloseTerminal` fires when the renderer confirms. */
function disposeTerminal(extensionId: string, handle: number): boolean {
  const record = owned(extensionId, handle);
  requireBridge().command({ op: 'dispose', handle: record.handle, extensionId });
  // The record is not removed here: it is removed when the renderer reports the pane closed, so
  // `onDidCloseTerminal` carries the real exit code and fires exactly once.
  return true;
}

/**
 * `Terminal.sendText()`.
 *
 * For a pty-backed terminal this is keystrokes into a live shell, which is the most consequential
 * thing in this file: whatever is sent runs. NUL bytes are stripped and the length is capped by
 * `normalizeSendText`, and the text is delivered as *input* to the pane the extension owns — it is
 * never interpreted here, and it cannot be addressed to a terminal the extension did not create.
 */
function sendText(
  extensionId: string,
  handle: number,
  rawText: unknown,
  addNewLine: unknown,
): boolean {
  const record = owned(extensionId, handle);
  const text = normalizeSendText(rawText, addNewLine);
  if (record.request.extensionPty) {
    // A `Pseudoterminal` has no shell to type into. Upstream routes this to `handleInput`, so the
    // extension sees its own text arrive exactly as a user's would.
    requireBridge().deliver(extensionId, { t: 'terminalInput', handle: record.handle, data: text });
    return true;
  }
  requireBridge().command({ op: 'write', handle: record.handle, extensionId, data: text });
  return true;
}

/** `Terminal.show()`. `preserveFocus` is passed through rather than decided here. */
function showTerminal(extensionId: string, handle: number, preserveFocus: boolean): boolean {
  const record = owned(extensionId, handle);
  requireBridge().command({ op: 'show', handle: record.handle, extensionId, preserveFocus });
  return true;
}

/** `Terminal.hide()`. */
function hideTerminal(extensionId: string, handle: number): boolean {
  const record = owned(extensionId, handle);
  requireBridge().command({ op: 'hide', handle: record.handle, extensionId });
  return true;
}

/** A name change from `Pseudoterminal.onDidChangeName` or a `TerminalOptions` update. */
function renameTerminal(extensionId: string, handle: number, name: string): boolean {
  const record = owned(extensionId, handle);
  record.request.name = name.slice(0, 200);
  requireBridge().command({
    op: 'name',
    handle: record.handle,
    extensionId,
    name: record.request.name,
  });
  changed();
  return true;
}

/**
 * A `Pseudoterminal` writing its own output.
 *
 * Only legal for a terminal the extension declared as an extension pty. Allowing it for a
 * pty-backed terminal would let an extension forge output that appears to come from the user's
 * shell — the pane would show text the shell never printed, which is a convincing place to put a
 * fake prompt.
 */
function writeToPty(extensionId: string, handle: number, data: string): boolean {
  const record = owned(extensionId, handle);
  if (!record.request.extensionPty) {
    throw new Error('Only a Pseudoterminal may write its own output.');
  }
  requireBridge().command({ op: 'write', handle: record.handle, extensionId, data });
  return true;
}

// ---------------------------------------------------------------------------
// Contributed terminal profiles
// ---------------------------------------------------------------------------
/**
 * `window.registerTerminalProfileProvider`.
 *
 * The provider stays in the worker; what is registered here is *who to ask* when the user picks that
 * profile from the terminal dropdown. An id another extension already owns is refused rather than
 * silently shadowed, so a late-loading extension cannot take over a profile already in use.
 */
function registerProfileProvider(extensionId: string, profileId: string): boolean {
  if (!profiles.register(extensionId, profileId)) {
    throw new Error(
      `The terminal profile ${profileId} belongs to another extension, or this extension already has ${MAX_PROFILE_PROVIDERS} profile providers.`,
    );
  }
  changed();
  return true;
}

/**
 * Resolve a contributed profile into terminal options, for the terminal dropdown.
 *
 * Bounded on purpose: an extension that never answers `provideTerminalProfile` must not leave the
 * dropdown waiting, so the call times out and the profile is reported as unavailable. The answer is
 * re-normalised on the way back, because it is extension-supplied options arriving on the one path
 * where the *user*, not the extension, asked for the terminal.
 */
export async function resolveTerminalProfile(profileId: string): Promise<TerminalRequest | null> {
  const owner = profiles.owner(profileId);
  if (owner === null) return null;
  const answer = await requireBridge().call(
    owner,
    (id) => ({ t: 'terminalProvideProfile', id, profileId, token: `profile:${profileId}` }),
    PROFILE_TIMEOUT_MS,
  );
  if (typeof answer !== 'object' || answer === null) return null;
  const options = (answer as { options?: unknown }).options;
  return normalizeTerminalRequest(options ?? answer);
}

/** The profiles extensions have contributed, for the terminal dropdown. */
export function extensionTerminalProfiles(): TerminalProfileRecord[] {
  return profiles.list();
}

// ---------------------------------------------------------------------------
// Environment variable collections
// ---------------------------------------------------------------------------
/** `context.environmentVariableCollection.replace/append/prepend`, and `delete`. */
function mutateEnvironment(extensionId: string, payload: Record<string, unknown>): boolean {
  const variable = String(payload.variable);
  const scope = envScopeKey(payload.scope);
  if (payload.remove === true) {
    const removed = environments.delete(extensionId, scope, variable);
    if (removed) persist();
    return removed;
  }
  const applied = environments.mutate(
    extensionId,
    scope,
    variable,
    String(payload.value),
    normalizeEnvMutationType(payload.type),
    {
      applyAtProcessCreation: payload.applyAtProcessCreation !== false,
      applyAtShellIntegration: payload.applyAtShellIntegration === true,
    },
  );
  if (!applied) {
    throw new Error(
      'The environment variable could not be set: the name is not a portable variable name, or the collection is full.',
    );
  }
  persist();
  return true;
}

function clearEnvironment(extensionId: string, scope: string): boolean {
  const cleared = environments.clearScope(extensionId, scope);
  if (cleared) persist();
  return cleared;
}

function describeEnvironment(extensionId: string, payload: Record<string, unknown>): boolean {
  const description = payload.description;
  environments.setDescription(extensionId, typeof description === 'string' ? description : null);
  environments.setPersistent(extensionId, payload.persistent !== false);
  persist();
  return true;
}

/**
 * Write the persistent collections out.
 *
 * Upstream keeps these across restarts, and an extension that sets `PATH` on activation and is then
 * disabled would otherwise leave every future terminal with a stale `PATH` — or, worse, lose the
 * mutation the user's build depends on. Only `persistent` collections are written, which is what the
 * flag means.
 */
function persist(): void {
  bridge?.persistEnvCollections(environments.serialize());
}

/** Rehydrate the persistent collections at startup. Returns how many mutations came back. */
export function restoreEnvironmentCollections(raw: unknown): number {
  return environments.restore(raw);
}

// ---------------------------------------------------------------------------
// Reports from the renderer
// ---------------------------------------------------------------------------
/**
 * The pane exists and AXIOM's terminal subsystem minted a session id for it.
 *
 * This is where an extension terminal stops being a request and becomes a terminal: until the session
 * id arrives there is no pty, so `onDidOpenTerminal` fires here rather than in `createTerminal`. A
 * `Pseudoterminal` has no pty at all, and gets its `open` call here too — the pane being drawn is the
 * only thing upstream's `open` actually means.
 */
export function reportTerminalOpened(
  handle: number,
  sessionId: string,
  processId: number | null,
  columns: number,
  rows: number,
): void {
  const host = requireBridge();
  const record = terminals.get(handle);
  if (!record || record.disposed) return;
  if (!terminals.attachSession(handle, sessionId, processId)) return;
  host.deliver(record.extensionId, { t: 'terminalOpened', handle, sessionId, processId });
  if (record.request.extensionPty) {
    host.deliver(record.extensionId, { t: 'terminalOpenPty', handle, columns, rows });
  }
  changed();
}

/**
 * The pane closed: a `dispose`, the shell exiting, or the user closing the tab.
 *
 * Every route ends here, and the record is removed *here* rather than in `disposeTerminal`, so
 * `onDidCloseTerminal` fires exactly once and carries the real exit code however the terminal died.
 */
export function reportTerminalClosed(handle: number, exitCode: number | null): void {
  const host = requireBridge();
  const record = terminals.dispose(handle, exitCode);
  if (!record) return;
  // A pane that closed will never call `term:create`, so a spec left here would be a leak.
  pendingSpawns.delete(handle);
  if (record.request.extensionPty) {
    host.deliver(record.extensionId, { t: 'terminalClosePty', handle });
  }
  host.deliver(record.extensionId, { t: 'terminalClosed', handle, exitCode });
  changed();
}

/**
 * Keystrokes in a pane, on their way to `Pseudoterminal.handleInput`.
 *
 * Only for a terminal the extension implements. A pty-backed terminal's keystrokes are the user
 * typing into their own shell, and forwarding them would hand every extension that created a terminal
 * a keylogger for it — upstream gives an extension no such callback, and neither does this.
 */
export function reportTerminalInput(handle: number, data: string): void {
  const host = requireBridge();
  const record = terminals.get(handle);
  if (!record || record.disposed || !record.request.extensionPty) return;
  host.deliver(record.extensionId, { t: 'terminalInput', handle, data });
}

/** The pane was resized: `Pseudoterminal.setDimensions`. Only an extension pty is told. */
export function reportTerminalDimensions(handle: number, columns: number, rows: number): void {
  const host = requireBridge();
  const record = terminals.get(handle);
  if (!record || record.disposed || !record.request.extensionPty) return;
  host.deliver(record.extensionId, { t: 'terminalDimensions', handle, columns, rows });
}

/**
 * The active terminal changed, reported by the renderer as one of its own session ids.
 *
 * The session may well be a terminal no extension owns — the user's own shell — and a handle means
 * something only to the extension that minted it. So the event goes to the owner that gained the
 * active terminal and to the owner that lost it, and to nobody else: upstream reports
 * `activeTerminal` as undefined when the active terminal is not one the extension can see, which is
 * exactly what the losing owner is being told.
 */
export function reportActiveTerminal(sessionId: string | null): void {
  const host = requireBridge();
  const next = sessionId === null ? undefined : terminals.bySession(sessionId);
  const previous = terminals.active();
  if (!terminals.setActive(next ? next.handle : null)) return;
  if (previous && previous.extensionId !== next?.extensionId) {
    host.deliver(previous.extensionId, { t: 'terminalActive', handle: null });
  }
  if (next) host.deliver(next.extensionId, { t: 'terminalActive', handle: next.handle });
  changed();
}

/** `TerminalState.isInteractedWith`. One transition, one event: the flag never goes back. */
export function reportTerminalInteracted(handle: number): void {
  const host = requireBridge();
  if (!terminals.markInteracted(handle)) return;
  deliverState(host, handle);
}

/** Shell integration became available (or went away) for one terminal. */
export function reportTerminalShellIntegration(handle: number, available: boolean): void {
  const host = requireBridge();
  if (!terminals.markShellIntegration(handle, available)) return;
  deliverState(host, handle);
}

function deliverState(host: TerminalsHostBridge, handle: number): void {
  const record = terminals.get(handle);
  if (!record) return;
  host.deliver(record.extensionId, {
    t: 'terminalState',
    handle,
    isInteractedWith: record.state.isInteractedWith,
    shellIntegration: record.state.shellIntegration,
  });
  changed();
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
/**
 * Everything one extension owns, released.
 *
 * Called on deactivation, on removal, and after a host crash, which is why it asks the renderer to
 * close the panes rather than merely forgetting them: a crashed extension's terminal would otherwise
 * stay on screen with nothing behind it and no way to close it through the API. No `terminalClosed` is
 * delivered — the host it would be delivered to is the one going away.
 *
 * The environment variable collections deliberately survive. They are persistent state keyed by
 * extension id, and upstream re-applies them to new terminals before the owning extension has
 * activated; dropping them here would make `persistent` mean "until the next deactivation".
 */
export function disposeTerminalsForExtension(extensionId: string): number {
  const removed = terminals.removeExtension(extensionId);
  for (const record of removed) {
    pendingSpawns.delete(record.handle);
    bridge?.command({ op: 'dispose', handle: record.handle, extensionId });
  }
  const providers = profiles.removeExtension(extensionId).length;
  if (removed.length > 0 || providers > 0) changed();
  return removed.length;
}

/**
 * Forget an extension's environment variable collections outright.
 *
 * The removal path, not the deactivation path. An extension that is gone must not keep prepending to
 * `PATH` for every terminal the user opens afterwards, and there is nothing left to re-apply it.
 */
export function forgetTerminalEnvironment(extensionId: string): boolean {
  if (!environments.removeExtension(extensionId)) return false;
  persist();
  changed();
  return true;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------
/** Counters for the extension host status surface and the validators. */
export function extensionTerminalsState(): {
  terminals: number;
  profiles: number;
  mutations: number;
  revision: number;
} {
  let mutations = 0;
  for (const extensionId of Object.keys(environments.all())) {
    mutations += environments.countFor(extensionId);
  }
  return { terminals: terminals.size, profiles: profiles.size, mutations, revision };
}

/** Drop every terminal, profile and collection. For the validators and for a workspace change. */
export function resetExtensionTerminalsForTesting(): void {
  terminals.clear();
  profiles.clear();
  environments.clear();
  pendingSpawns.clear();
  revision = 1;
  bridge = null;
}
