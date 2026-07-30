/**
 * Extension file watching and workspace file events (PRD Phase 7 — §4 FileSystemWatcher, §5 events).
 *
 * PURE module: no `fs`, no watch handles. It answers the questions the service cannot answer while
 * holding a watch handle — which watchers a changed path belongs to, whether that path is inside the
 * workspace at all, and which of a burst of raw filesystem events an extension should actually see.
 *
 * Phase 6 shipped `createFileSystemWatcher` as a disposable that never fired. The reason it stayed
 * inert was not the watch handle (Node gives that away for free) but everything around it: a recursive
 * watch reports a churn of raw events, most of them duplicates and many of them for paths no watcher
 * asked about, and forwarding that churn into every extension host is a worse outcome than firing
 * nothing. So the fan-out decision and the coalescing rules are here, where they are exercised
 * directly, and the service is left holding one shared watch per workspace root.
 *
 * `no polling` in the PRD is a property of the service, but it is a property this module makes
 * affordable: one OS-level recursive watch per root, fanned out in memory to as many watchers as
 * extensions asked for, is what makes 30 watchers cost the same as one.
 */

import { matchesRelativePattern, matchesVsCodeGlob, normalizeGlobPath } from './vscodeGlob';

/** Watchers one extension may hold at once. */
export const MAX_WATCHERS_PER_EXTENSION = 32;
/** Watchers AXIOM will track in total. */
export const MAX_WATCHERS = 128;
/** How long raw filesystem events are collected before being fanned out. */
export const WATCH_DEBOUNCE_MS = 50;
/** Raw events buffered inside one debounce window before the excess is dropped. */
export const MAX_PENDING_EVENTS = 5_000;
/** Longest watch pattern accepted. Matches `vscodeGlob`'s own limit. */
export const MAX_WATCH_PATTERN = 1_024;

/** The three things that can happen to a file. Ordered as upstream orders them within a batch. */
export type FileEventKind = 'create' | 'change' | 'delete';

/** A validated `createFileSystemWatcher` request. */
export interface WatcherSpec {
  token: number;
  extensionId: string;
  /**
   * Absolute directory the watch is rooted at. Always inside the workspace: a watcher whose base
   * resolved outside it is refused at registration rather than filtered per event.
   */
  base: string;
  /** The glob, relative to `base`. `**​/*` when the extension passed a bare pattern. */
  pattern: string;
  recursive: boolean;
  ignoreCreateEvents: boolean;
  ignoreChangeEvents: boolean;
  ignoreDeleteEvents: boolean;
}

/** One event, after coalescing, as it will be delivered. */
export interface FileEvent {
  kind: FileEventKind;
  /** Absolute path, forward-slash normalised. */
  path: string;
}

/** An event addressed to one watcher. */
export interface WatcherDelivery {
  token: number;
  extensionId: string;
  event: FileEvent;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * A directory in the form the registry stores and compares it: forward slashes, no trailing
 * separator.
 *
 * Normalise *before* trimming. `trimTrailingSlash` only sees forward slashes, so a Windows path
 * that arrives as `C:\repo\` — which is what `RelativePattern` carries when an extension builds one
 * from a path it joined itself — would otherwise keep its separator and read as a second, distinct
 * root from `C:\repo`, giving two OS watchers on one directory.
 */
function normalizeRoot(path: string): string {
  return trimTrailingSlash(normalizeGlobPath(path));
}

/**
 * Is `path` inside `root`?
 *
 * Compared on normalised, slash-trimmed strings with a separator appended, so `/work` does not
 * contain `/workspace-other`. Case is folded because the two platforms AXIOM ships on both have
 * case-insensitive filesystems by default, and a watcher registered as `C:/Work` must still match an
 * event reported as `c:/work/src/a.ts`.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizeRoot(root).toLowerCase();
  const normalizedPath = normalizeGlobPath(path).toLowerCase();
  if (normalizedRoot.length === 0) return false;
  if (normalizedPath === normalizedRoot) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** The first workspace root that contains `path`, or null when none does. */
export function rootContaining(roots: readonly string[], path: string): string | null {
  for (const root of roots) {
    if (isInsideRoot(root, path)) return normalizeRoot(root);
  }
  return null;
}

/** What an extension asked for, before the roots are consulted. */
export interface WatcherRequest {
  base: string | null;
  pattern: string;
  ignoreCreateEvents: boolean;
  ignoreChangeEvents: boolean;
  ignoreDeleteEvents: boolean;
}

/**
 * Decode `createFileSystemWatcher(globPattern, ignoreCreate?, ignoreChange?, ignoreDelete?)`.
 *
 * `globPattern` is either a bare string — matched against every root — or a `RelativePattern`, whose
 * base pins the watch to one directory. A `RelativePattern` may carry `base` (a string), `baseUri`, or
 * an older `base` that is itself a `WorkspaceFolder`; all three appear in extensions in the wild, so
 * all three are read. A pattern with no wildcard is left as it is: watching one exact file is a real
 * use (`.env`, `tsconfig.json`) and rewriting it to a recursive glob would fire for a directory.
 */
export function normalizeWatcherRequest(
  globPattern: unknown,
  ignoreCreate: unknown,
  ignoreChange: unknown,
  ignoreDelete: unknown,
): WatcherRequest | null {
  let base: string | null = null;
  let pattern: string | null = null;
  if (typeof globPattern === 'string') {
    pattern = globPattern;
  } else if (typeof globPattern === 'object' && globPattern !== null) {
    const source = globPattern as Record<string, unknown>;
    if (typeof source.pattern === 'string') pattern = source.pattern;
    base = readBase(source.baseUri) ?? readBase(source.base) ?? readBase(source.baseFolder);
  }
  if (pattern === null) return null;
  const cleaned = pattern.slice(0, MAX_WATCH_PATTERN);
  if (cleaned.length === 0) return null;
  return {
    base,
    pattern: normalizeGlobPath(cleaned),
    ignoreCreateEvents: ignoreCreate === true,
    ignoreChangeEvents: ignoreChange === true,
    ignoreDeleteEvents: ignoreDelete === true,
  };
}

function readBase(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    if (typeof source.fsPath === 'string') return source.fsPath;
    if (typeof source.path === 'string') return source.path;
    const uri = source.uri;
    if (typeof uri === 'object' && uri !== null) {
      const fsPath = (uri as { fsPath?: unknown }).fsPath;
      if (typeof fsPath === 'string') return fsPath;
    }
  }
  return null;
}

/** Does this watcher want to hear about `path`? Pattern *and* boundary, both. */
export function watcherMatches(spec: WatcherSpec, kind: FileEventKind, path: string): boolean {
  if (kind === 'create' && spec.ignoreCreateEvents) return false;
  if (kind === 'change' && spec.ignoreChangeEvents) return false;
  if (kind === 'delete' && spec.ignoreDeleteEvents) return false;
  if (!isInsideRoot(spec.base, path)) return false;
  if (!spec.recursive) {
    const relative = normalizeGlobPath(path).slice(normalizeRoot(spec.base).length + 1);
    if (relative.includes('/')) return false;
  }
  return matchesRelativePattern(spec.base, spec.pattern, path);
}

/**
 * Match a path against an include pattern and an optional exclude, the way `findFiles` does.
 *
 * Kept here next to the watcher matcher because the two must agree: an extension that watches
 * `**​/*.ts` and searches `**​/*.ts` would otherwise see a file in one and not the other.
 */
export function matchesWorkspacePattern(
  relativePath: string,
  include: string,
  exclude: string | null,
): boolean {
  const path = normalizeGlobPath(relativePath);
  if (!matchesVsCodeGlob(include, path)) return false;
  if (exclude !== null && exclude.length > 0 && matchesVsCodeGlob(exclude, path)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
/**
 * Every extension watcher, and the set of roots the service must actually watch.
 *
 * `roots()` is the point of the whole class: however many watchers exist, the service holds one
 * recursive watch per distinct root, and `deliveriesFor` fans one raw event out to whichever watchers
 * asked for it. Registration resolves the base against the workspace roots *once*, so the per-event
 * path is a string comparison and a compiled (memoised) glob test rather than a workspace lookup.
 */
export class WatcherRegistry {
  private readonly specs = new Map<number, WatcherSpec>();
  private nextToken = 1;

  /**
   * Register a watcher. Throws when the request is outside the workspace or over a limit — the
   * extension sees the refusal, rather than holding a watcher that silently never fires, which is
   * precisely the Phase 6 behaviour this phase replaces.
   */
  register(extensionId: string, request: WatcherRequest, roots: readonly string[]): WatcherSpec {
    if (this.specs.size >= MAX_WATCHERS) {
      throw new Error(`AXIOM tracks at most ${MAX_WATCHERS} file system watchers.`);
    }
    if (this.countFor(extensionId) >= MAX_WATCHERS_PER_EXTENSION) {
      throw new Error(`An extension may hold at most ${MAX_WATCHERS_PER_EXTENSION} watchers.`);
    }
    if (roots.length === 0) throw new Error('No workspace is open to watch.');
    let base: string;
    if (request.base === null) {
      base = normalizeRoot(roots[0] ?? '');
    } else {
      const owner = rootContaining(roots, request.base);
      if (owner === null) {
        throw new Error('A file system watcher must be rooted inside the workspace.');
      }
      base = normalizeRoot(request.base);
    }
    const token = this.nextToken++;
    const spec: WatcherSpec = {
      token,
      extensionId,
      base,
      pattern: request.pattern,
      recursive: request.pattern.includes('**') || request.pattern.includes('/'),
      ignoreCreateEvents: request.ignoreCreateEvents,
      ignoreChangeEvents: request.ignoreChangeEvents,
      ignoreDeleteEvents: request.ignoreDeleteEvents,
    };
    this.specs.set(token, spec);
    return spec;
  }

  unregister(token: number): WatcherSpec | undefined {
    const spec = this.specs.get(token);
    if (spec) this.specs.delete(token);
    return spec;
  }

  get(token: number): WatcherSpec | undefined {
    return this.specs.get(token);
  }

  /** The distinct directories the service needs an OS watch on. */
  roots(): string[] {
    const seen = new Set<string>();
    for (const spec of this.specs.values()) seen.add(spec.base);
    return [...seen];
  }

  /** Fan one event out to the watchers that asked for it. */
  deliveriesFor(event: FileEvent): WatcherDelivery[] {
    const out: WatcherDelivery[] = [];
    for (const spec of this.specs.values()) {
      if (!watcherMatches(spec, event.kind, event.path)) continue;
      out.push({ token: spec.token, extensionId: spec.extensionId, event });
    }
    return out;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const spec of this.specs.values()) {
      if (spec.extensionId === extensionId) count += 1;
    }
    return count;
  }

  removeExtension(extensionId: string): WatcherSpec[] {
    const removed: WatcherSpec[] = [];
    for (const [token, spec] of [...this.specs]) {
      if (spec.extensionId !== extensionId) continue;
      this.specs.delete(token);
      removed.push(spec);
    }
    return removed;
  }

  get size(): number {
    return this.specs.size;
  }

  list(): WatcherSpec[] {
    return [...this.specs.values()];
  }

  clear(): void {
    this.specs.clear();
  }
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------
/**
 * Collapse a burst of raw filesystem events into the set an extension should see.
 *
 * A single editor save produces several raw events on both platforms (a rename of a temporary file, a
 * write, an attribute change), and a `git checkout` produces thousands. Upstream applies the same four
 * rules per path, and matching them matters because extensions are written against them:
 *
 * - repeated events of the same kind collapse to one;
 * - create followed by change stays a create — the file is new, and a linter that treats change as
 *   "re-lint an open document" would otherwise look for a document that was never opened;
 * - create followed by delete cancels out entirely: the file never existed as far as anyone watching
 *   is concerned (a temporary file);
 * - delete followed by create becomes a change, which is what an atomic save looks like from outside.
 *
 * Order is preserved by first occurrence, so a batch touching many files is delivered in the order the
 * filesystem reported them.
 */
export function coalesceFileEvents(events: readonly FileEvent[]): FileEvent[] {
  const order: string[] = [];
  const byPath = new Map<string, FileEventKind | null>();
  for (const event of events) {
    const path = normalizeGlobPath(event.path);
    const existing = byPath.get(path);
    if (existing === undefined) {
      order.push(path);
      byPath.set(path, event.kind);
      continue;
    }
    if (existing === null) {
      // The path already cancelled out; a later event starts it again.
      byPath.set(path, event.kind);
      continue;
    }
    if (existing === event.kind) continue;
    if (existing === 'create' && event.kind === 'change') continue;
    if (existing === 'create' && event.kind === 'delete') {
      byPath.set(path, null);
      continue;
    }
    if (existing === 'delete' && event.kind === 'create') {
      byPath.set(path, 'change');
      continue;
    }
    // change → delete, change → create, delete → change: the later kind is the truth.
    byPath.set(path, event.kind);
  }
  const out: FileEvent[] = [];
  for (const path of order) {
    const kind = byPath.get(path);
    if (kind === null || kind === undefined) continue;
    out.push({ kind, path });
  }
  return out;
}

/**
 * A bounded queue of raw events waiting for the debounce window to close.
 *
 * The bound is the reason this is a class rather than an array: a `git checkout` of a large repository
 * can report more events in 50 ms than there is any value in delivering, and the honest failure is to
 * stop collecting and say so (`overflowed`) rather than to grow without limit. The service reports an
 * overflow as a change on the root, which is what upstream does when its own watcher overflows.
 */
export class FileEventQueue {
  private events: FileEvent[] = [];
  private overflow = false;

  push(kind: FileEventKind, path: string): boolean {
    if (this.events.length >= MAX_PENDING_EVENTS) {
      this.overflow = true;
      return false;
    }
    this.events.push({ kind, path: normalizeGlobPath(path) });
    return true;
  }

  get size(): number {
    return this.events.length;
  }

  get overflowed(): boolean {
    return this.overflow;
  }

  /** Take the coalesced batch and reset. */
  drain(): { events: FileEvent[]; overflowed: boolean } {
    const events = coalesceFileEvents(this.events);
    const overflowed = this.overflow;
    this.events = [];
    this.overflow = false;
    return { events, overflowed };
  }
}

// ---------------------------------------------------------------------------
// Workspace file operations
// ---------------------------------------------------------------------------
/** A file operation the workbench performed, as `workspace.onDid*Files` reports it. */
export type FileOperationKind = 'create' | 'delete' | 'rename' | 'copy';

/** One `{ oldUri, newUri }` pair. `oldPath` is null for a create. */
export interface FileOperationEntry {
  oldPath: string | null;
  newPath: string | null;
}

/** An event the host must emit, in order, for one operation. */
export interface PlannedEvent {
  event:
    | 'workspace.onDidCreateFiles'
    | 'workspace.onDidDeleteFiles'
    | 'workspace.onDidRenameFiles'
    | 'workspace.onDidCloseTextDocument'
    | 'workspace.onDidOpenTextDocument';
  paths: string[];
}

/**
 * The order Phase 7 fires workspace file events in.
 *
 * "Event ordering must match VS Code" is a requirement that only means something written down, so it
 * is written down here and asserted by the validators rather than left implicit in the order two
 * services happen to be called. The rules that matter to real extensions:
 *
 * - the `onDid*Files` event fires *after* the operation has happened on disk, so an extension that
 *   reads the new path in its handler finds it there;
 * - a rename reports the pair in one event, not a delete plus a create, because that is how an
 *   extension moves its own per-file state across;
 * - document lifecycle follows the file event: a deleted file's document closes after
 *   `onDidDeleteFiles`, and a renamed file's document closes and reopens under the new path, so an
 *   extension keyed on `document.uri` ends up consistent either way;
 * - a copy is a create. Upstream has no `onDidCopyFiles`.
 *
 * Watcher events are deliberately not in this plan: they arrive on the debounce window from the
 * filesystem itself, so an operation the workbench performed shows up twice — once as the workspace
 * event, once as the watcher event — which is exactly what upstream does.
 */
export function planFileOperationEvents(
  kind: FileOperationKind,
  entries: readonly FileOperationEntry[],
  openDocuments: readonly string[] = [],
): PlannedEvent[] {
  const isOpen = (path: string | null): boolean =>
    path !== null &&
    openDocuments.some(
      (doc) => normalizeGlobPath(doc).toLowerCase() === normalizeGlobPath(path).toLowerCase(),
    );
  const oldPaths = entries
    .map((entry) => entry.oldPath)
    .filter((path): path is string => path !== null);
  const newPaths = entries
    .map((entry) => entry.newPath)
    .filter((path): path is string => path !== null);
  const plan: PlannedEvent[] = [];
  if (kind === 'create' || kind === 'copy') {
    if (newPaths.length > 0) plan.push({ event: 'workspace.onDidCreateFiles', paths: newPaths });
    return plan;
  }
  if (kind === 'delete') {
    if (oldPaths.length > 0) plan.push({ event: 'workspace.onDidDeleteFiles', paths: oldPaths });
    const closing = oldPaths.filter((path) => isOpen(path));
    if (closing.length > 0) {
      plan.push({ event: 'workspace.onDidCloseTextDocument', paths: closing });
    }
    return plan;
  }
  if (entries.length > 0) {
    plan.push({
      event: 'workspace.onDidRenameFiles',
      paths: entries.map((entry) => `${entry.oldPath ?? ''}→${entry.newPath ?? ''}`),
    });
  }
  const moved = entries.filter((entry) => isOpen(entry.oldPath));
  if (moved.length > 0) {
    plan.push({
      event: 'workspace.onDidCloseTextDocument',
      paths: moved.map((entry) => entry.oldPath ?? ''),
    });
    plan.push({
      event: 'workspace.onDidOpenTextDocument',
      paths: moved.map((entry) => entry.newPath ?? ''),
    });
  }
  return plan;
}
