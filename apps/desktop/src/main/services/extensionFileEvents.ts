/**
 * The extension file watching and workspace file event runtime (PRD Phase 7 §4 and §5).
 *
 * Phase 6 accepted `createFileSystemWatcher` and returned a disposable that never fired. That is worse
 * than refusing: Prettier waits for `.prettierrc` to change, ESLint waits for its config, GitLens
 * watches `.git`, and the Python extension watches for interpreters, so all four activate, register a
 * watcher, and then quietly never react. This file makes the watcher real.
 *
 * The shape of it:
 *
 *   - an extension calls `createFileSystemWatcher`, minting a handle in its own worker;
 *   - `WatcherRegistry` (pure, in `common/vscodeFileWatch.ts`) resolves the glob against the open
 *     workspace roots, refuses anything outside them, and caps how many watchers exist;
 *   - this file keeps **one** recursive `fs.watch` per distinct watched directory, no matter how many
 *     extensions asked. Twelve extensions watching the workspace root cost one OS watch, not twelve;
 *   - raw events land in a `FileEventQueue`, are coalesced on a 50 ms debounce, and are then fanned out
 *     only to the watchers whose glob matches. No polling, and no `stat` for an event nobody wants.
 *
 * The workspace file events (`onDidCreateFiles`, `onDidRenameFiles`, `onDidDeleteFiles`) are a separate
 * thing that upstream is precise about: they fire for *user gestures* and `applyEdit`, not for
 * `workspace.fs` calls, and not for changes another program made — those arrive as watcher events
 * instead. So the workbench's own explorer operations call `notifyFileOperation` here, and
 * `planFileOperationEvents` (pure) decides what is emitted in what order.
 *
 * What this file deliberately does not do: watch anything outside a workspace root, walk the workspace
 * to seed an index, or hold an unbounded queue. A `git checkout` of a large repository is the event
 * storm this has to survive, and it survives it by dropping to one "the root changed" event rather than
 * by growing.
 */
import { rootLogger } from '@axiom/shared';
import { watch, type FSWatcher } from 'node:fs';
import { constants, copyFile, cp, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  FileEventQueue,
  MAX_PENDING_EVENTS,
  WATCH_DEBOUNCE_MS,
  WatcherRegistry,
  normalizeWatcherRequest,
  planFileOperationEvents,
  watcherMatches,
  type FileEventKind,
  type FileOperationEntry,
  type FileOperationKind,
  type PlannedEvent,
} from '../../common/vscodeFileWatch';
import { appendAudit } from './audit';
import { assertAuthorizedMutationPath, assertAuthorizedPath } from './pathAuthorization';

const log = rootLogger.child('extension-file-events');

/**
 * How recently a file must have been created for a `rename` event to mean "created".
 *
 * The OS reports a rename, not a verb: a new file, a deleted file and an atomic save (write to a
 * temporary file, rename over the target) are all `rename`. The path either exists afterwards or it
 * does not, which settles delete. For the ones that exist, a file this process has already reported on
 * is a change, and so is a file whose creation timestamp is older than this window — which is what
 * makes the first save of a pre-existing file a change rather than a create.
 */
const CREATE_WINDOW_MS = 2_000;

/** How long to wait before re-establishing a watch the OS dropped. */
const REWATCH_DELAY_MS = 1_000;

/** Paths remembered as "already reported", so a second event on one is a change. Bounded. */
const MAX_KNOWN_PATHS = 20_000;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts
// ---------------------------------------------------------------------------
export interface FileEventsHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Post to every running host. */
  broadcast(message: MainToWorker): void;
  /** Absolute workspace folder paths. The only directories a watcher may be rooted in. */
  workspaceRoots(): string[];
}

let bridge: FileEventsHostBridge | null = null;

export function configureExtensionFileEvents(next: FileEventsHostBridge): void {
  bridge = next;
}

function requireBridge(): FileEventsHostBridge {
  if (bridge === null) throw new Error('The extension file event runtime is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface TokenOwner {
  extensionId: string;
  workerToken: number;
}

const watchers = new WatcherRegistry();
/** Main's watcher token → the handle the worker minted for it. */
const workerTokens = new Map<number, TokenOwner>();
/** One OS watch per distinct watched directory, keyed by that directory. */
const handles = new Map<string, FSWatcher>();
/** Directories whose watch failed and is waiting to be re-established. */
const rewatching = new Set<string>();
const queue = new FileEventQueue();
const known = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
/** Bumped on every registration change, so a stale snapshot can be recognised as stale. */
let revision = 1;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
const FILE_EVENT_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
  'workspace.createWatcher',
  'workspace.disposeWatcher',
  'workspace.copyFile',
  'workspace.renameFile',
]);

export function isFileEventsRequestKind(kind: string): boolean {
  return FILE_EVENT_REQUEST_KINDS.has(kind);
}

function handleOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function handleFileEventsRequest(
  extensionId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'workspace.createWatcher':
      return createWatcher(extensionId, payload);
    case 'workspace.disposeWatcher':
      return disposeWatcher(extensionId, handleOf(payload.token));
    case 'workspace.copyFile':
      return performOperation(extensionId, 'copy', payload);
    case 'workspace.renameFile':
      return performOperation(extensionId, 'rename', payload);
    default:
      throw new Error(`${kind} is not a file event request.`);
  }
}

// ---------------------------------------------------------------------------
// Watcher registration
// ---------------------------------------------------------------------------
/**
 * Find main's token for a handle the worker minted, among that extension's own watchers only.
 *
 * The scoping is the isolation: an extension that guesses another extension's handle finds nothing,
 * because the search never leaves its own registrations.
 */
function mainToken(extensionId: string, workerToken: number): number | null {
  for (const [token, owner] of workerTokens) {
    if (owner.extensionId === extensionId && owner.workerToken === workerToken) return token;
  }
  return null;
}

function createWatcher(extensionId: string, payload: Record<string, unknown>): boolean {
  const host = requireBridge();
  const workerToken = handleOf(payload.token);
  if (workerToken === 0) throw new Error('A file system watcher needs a handle.');
  const request = normalizeWatcherRequest(
    payload.pattern,
    payload.ignoreCreateEvents,
    payload.ignoreChangeEvents,
    payload.ignoreDeleteEvents,
  );
  if (request === null) throw new Error('That file system watcher has no usable glob pattern.');
  // A worker that re-sends a handle it already registered gets the registration it already has,
  // rather than a second watcher that would fire twice for one event.
  if (mainToken(extensionId, workerToken) !== null) return true;
  const spec = watchers.register(extensionId, request, host.workspaceRoots());
  workerTokens.set(spec.token, { extensionId, workerToken });
  revision += 1;
  syncWatches();
  log.debug('An extension registered a file system watcher', {
    extensionId,
    base: spec.base,
    pattern: spec.pattern,
    recursive: spec.recursive,
  });
  return true;
}

function disposeWatcher(extensionId: string, workerToken: number): boolean {
  const token = mainToken(extensionId, workerToken);
  if (token === null) return false;
  watchers.unregister(token);
  workerTokens.delete(token);
  revision += 1;
  syncWatches();
  return true;
}

// ---------------------------------------------------------------------------
// The OS watches
// ---------------------------------------------------------------------------
/**
 * Bring the set of OS watches in line with the set of registered watchers.
 *
 * Called after every registration and disposal, and it is the only place a watch is opened or closed.
 * Watches are keyed by directory, so the cost is the number of *distinct* watched directories — which
 * for a normal session is one, the workspace root.
 */
function syncWatches(): void {
  const wanted = new Set(watchers.roots());
  for (const [root, handle] of [...handles]) {
    if (wanted.has(root)) continue;
    handles.delete(root);
    closeHandle(root, handle);
  }
  for (const root of wanted) {
    if (handles.has(root) || rewatching.has(root)) continue;
    startWatch(root);
  }
}

function closeHandle(root: string, handle: FSWatcher): void {
  try {
    handle.close();
  } catch (error) {
    log.warn('Closing a file system watch failed', { root, error: String(error) });
  }
}

/**
 * Open one recursive watch on a directory.
 *
 * `recursive` is native on Windows and macOS and has been native on Linux since Node 20; where the
 * platform refuses it, the watch is opened non-recursively rather than replaced by a polling loop,
 * because "no polling" is a Phase 7 requirement and a shallow watch is an honest partial answer. The
 * watch is not `persistent`: an OS watch must never be the reason the process stays alive.
 */
function startWatch(root: string): void {
  const open = (recursive: boolean): FSWatcher =>
    watch(root, { recursive, persistent: false }, (event, filename) => {
      onRawEvent(root, event, typeof filename === 'string' ? filename : null);
    });
  let handle: FSWatcher;
  try {
    handle = open(true);
  } catch (error) {
    log.warn('A recursive file system watch is unavailable; watching one level', {
      root,
      error: String(error),
    });
    try {
      handle = open(false);
    } catch (fallbackError) {
      log.warn('Watching a workspace directory failed', {
        root,
        error: String(fallbackError),
      });
      return;
    }
  }
  handle.on('error', (error) => {
    onWatchError(root, error);
  });
  handles.set(root, handle);
}

/**
 * An OS watch died — the directory was renamed, a network share dropped, or the descriptor limit was
 * hit. One retry is scheduled, once, and the watchers themselves are left registered: an extension
 * that asked to watch the workspace should keep working when the workspace comes back, and it has no
 * way to re-register on its own because nothing told it anything was wrong.
 */
function onWatchError(root: string, error: unknown): void {
  const handle = handles.get(root);
  if (handle) {
    handles.delete(root);
    closeHandle(root, handle);
  }
  if (rewatching.has(root)) return;
  rewatching.add(root);
  log.warn('A file system watch failed; retrying', { root, error: String(error) });
  const timer = setTimeout(() => {
    rewatching.delete(root);
    if (watchers.roots().includes(root)) startWatch(root);
  }, REWATCH_DELAY_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Raw events
// ---------------------------------------------------------------------------
/** Is any registered watcher interested in this path, for any of the three kinds? */
function anyoneWants(path: string): boolean {
  for (const spec of watchers.list()) {
    const kinds: FileEventKind[] = ['create', 'change', 'delete'];
    if (kinds.some((kind) => watcherMatches(spec, kind, path))) return true;
  }
  return false;
}

function remember(path: string): void {
  if (known.size >= MAX_KNOWN_PATHS) known.clear();
  known.add(path);
}

function slashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function enqueue(kind: FileEventKind, path: string): void {
  queue.push(kind, path);
  schedule();
}

/**
 * One raw event from the OS.
 *
 * `change` is already a verb. `rename` is not: a create, a delete and an atomic save all arrive as
 * `rename`, and only a `stat` can tell them apart. That `stat` is a syscall per event, and a
 * `git checkout` produces thousands, so the glob is checked *first* — a string comparison against the
 * registered watchers — and a path nobody asked about costs nothing at all.
 */
function onRawEvent(root: string, event: string, filename: string | null): void {
  // Windows reports some events on the directory itself with no filename. There is nothing to match a
  // pattern against, so the directory is reported as changed rather than guessed about.
  if (filename === null || filename.length === 0) {
    enqueue('change', slashes(root));
    return;
  }
  const path = slashes(join(root, filename));
  if (event === 'change') {
    remember(path);
    enqueue('change', path);
    return;
  }
  if (!anyoneWants(path)) return;
  // Already at the cap: the batch is going to collapse to one root change anyway, so skip the syscall
  // and let the queue record the overflow.
  if (queue.size >= MAX_PENDING_EVENTS) {
    enqueue('change', path);
    return;
  }
  void classify(path);
}

/** Turn a `rename` into create, change or delete. See `CREATE_WINDOW_MS` for why change is possible. */
async function classify(path: string): Promise<void> {
  let kind: FileEventKind = 'delete';
  try {
    const stats = await stat(path);
    const born = stats.birthtimeMs;
    const seen = known.has(path) || (born > 0 && Date.now() - born > CREATE_WINDOW_MS);
    kind = seen ? 'change' : 'create';
    remember(path);
  } catch {
    known.delete(path);
  }
  enqueue(kind, path);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
function schedule(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  flushTimer.unref();
}

/**
 * Deliver one debounced batch.
 *
 * The batch is coalesced first (a save is several raw events, and an extension should see one), then
 * each event is offered to every watcher whose glob matches. The token that goes on the wire is the
 * *worker's* handle, translated here, because the worker knows nothing about main's registry — which is
 * also why one extension can never receive an event for another extension's watcher.
 */
function flush(): void {
  flushTimer = null;
  const { events, overflowed } = queue.drain();
  const batch = overflowed
    ? [
        ...events,
        ...watchers.roots().map((root) => ({ kind: 'change' as FileEventKind, path: root })),
      ]
    : events;
  if (overflowed) {
    log.warn('A file event burst exceeded the queue; reporting the roots as changed', {
      dropped: MAX_PENDING_EVENTS,
    });
  }
  for (const event of batch) {
    for (const delivery of watchers.deliveriesFor(event)) {
      const owner = workerTokens.get(delivery.token);
      if (owner === undefined) continue;
      bridge?.deliver(delivery.extensionId, {
        t: 'watcherEvent',
        token: owner.workerToken,
        kind: event.kind,
        path: event.path,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// workspace.fs.copy and workspace.fs.rename
// ---------------------------------------------------------------------------
/**
 * Complete `workspace.fs`, which Phase 6 left without copy and rename.
 *
 * Both paths go through `pathAuthorization` — the same gate the Phase 6 `readFile`, `writeFile` and
 * `delete` handlers use — so an extension can move a file inside the open workspace and nowhere else.
 * The source of a rename is authorised with the mutation variant, which does not follow a final
 * symlink: renaming a link must move the link, not whatever it points at outside the workspace.
 *
 * Upstream does not fire `onDidRenameFiles` or `onDidCreateFiles` for `workspace.fs` calls — those
 * belong to user gestures and `applyEdit` — so neither does this. The change still reaches extensions,
 * the way upstream delivers it: as a watcher event, from the filesystem.
 */
async function performOperation(
  extensionId: string,
  kind: 'copy' | 'rename',
  payload: Record<string, unknown>,
): Promise<boolean> {
  const source = text(payload.source);
  const target = text(payload.target);
  if (source.length === 0 || target.length === 0) {
    throw new Error(`A ${kind} needs a source and a target path.`);
  }
  const overwrite = payload.overwrite === true;
  const from =
    kind === 'rename'
      ? await assertAuthorizedMutationPath(source)
      : await assertAuthorizedPath(source);
  const to = await assertAuthorizedPath(target, { allowMissing: true });
  if (!overwrite && (await exists(to))) throw new Error('The target already exists.');
  await mkdir(dirname(to), { recursive: true });
  if (kind === 'rename') {
    await rename(from, to);
  } else if ((await stat(from)).isDirectory()) {
    await cp(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  } else {
    await copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL);
  }
  await appendAudit(
    `extension.host.${kind}`,
    `${extensionId} ${kind === 'copy' ? 'copied' : 'renamed'} ${from} to ${to}`,
  );
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// workspace.onDidCreateFiles / onDidRenameFiles / onDidDeleteFiles
// ---------------------------------------------------------------------------
/**
 * Which wire event a planned event becomes, or null when it is not ours to send.
 *
 * The plan also contains document lifecycle steps, and those are deliberately dropped here: AXIOM
 * already has one owner for `onDidOpenTextDocument`/`onDidCloseTextDocument` — the document tracker that
 * follows the editor — and a second sender would double-fire them. The plan states the ordering, the
 * validators assert it, and this function sends the three file events it is responsible for.
 */
function wireKind(event: PlannedEvent['event']): 'create' | 'delete' | 'rename' | null {
  if (event === 'workspace.onDidCreateFiles') return 'create';
  if (event === 'workspace.onDidDeleteFiles') return 'delete';
  if (event === 'workspace.onDidRenameFiles') return 'rename';
  return null;
}

function wireEntries(
  wire: 'create' | 'delete' | 'rename',
  entries: readonly FileOperationEntry[],
): Array<{ oldPath: string | null; newPath: string | null }> {
  if (wire === 'create') {
    return entries
      .filter((entry) => entry.newPath !== null)
      .map((entry) => ({ oldPath: null, newPath: entry.newPath }));
  }
  if (wire === 'delete') {
    return entries
      .filter((entry) => entry.oldPath !== null)
      .map((entry) => ({ oldPath: entry.oldPath, newPath: null }));
  }
  return entries
    .filter((entry) => entry.oldPath !== null && entry.newPath !== null)
    .map((entry) => ({ oldPath: entry.oldPath, newPath: entry.newPath }));
}

/**
 * The workbench performed a file operation: tell every running extension host.
 *
 * This is the one entry point for `workspace.onDidCreateFiles`, `onDidRenameFiles` and
 * `onDidDeleteFiles`, and it is called from the existing explorer file operation handlers — the user
 * gestures upstream fires these events for. It is additive: a caller that ignores it changes nothing,
 * and a host that is not running is simply not told.
 */
export function notifyFileOperation(
  kind: FileOperationKind,
  entries: readonly FileOperationEntry[],
): void {
  if (entries.length === 0 || bridge === null) return;
  for (const step of planFileOperationEvents(kind, entries)) {
    const wire = wireKind(step.event);
    if (wire === null) continue;
    const wired = wireEntries(wire, entries);
    if (wired.length === 0) continue;
    bridge.broadcast({ t: 'fileOperation', kind: wire, entries: wired });
  }
}

// ---------------------------------------------------------------------------
// Teardown, state and testing
// ---------------------------------------------------------------------------
/**
 * An extension stopped, crashed or was uninstalled: drop its watchers.
 *
 * `syncWatches` then closes any OS watch that was only there for those watchers, which is what keeps a
 * crash loop from leaking descriptors. The pending queue is left alone: it may hold events another
 * extension is still waiting for, and the fan-out skips tokens that no longer exist.
 */
export function disposeFileEventsForExtension(extensionId: string): number {
  const removed = watchers.removeExtension(extensionId);
  if (removed.length === 0) return 0;
  for (const spec of removed) workerTokens.delete(spec.token);
  revision += 1;
  syncWatches();
  log.info('Released the file system watchers of an extension', {
    extensionId,
    watchers: removed.length,
  });
  return removed.length;
}

/** What the validators and the diagnostics read. Counts only: a path is not a health metric. */
export function extensionFileEventsState(): {
  watchers: number;
  watches: number;
  pending: number;
  overflowed: boolean;
  revision: number;
} {
  return {
    watchers: watchers.size,
    watches: handles.size,
    pending: queue.size,
    overflowed: queue.overflowed,
    revision,
  };
}

/** Close every watch and forget every registration. Used by the validators and by a full host reset. */
export function resetExtensionFileEventsForTesting(): void {
  for (const [root, handle] of [...handles]) {
    handles.delete(root);
    closeHandle(root, handle);
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  rewatching.clear();
  workerTokens.clear();
  watchers.clear();
  known.clear();
  queue.drain();
  revision = 1;
  bridge = null;
}
