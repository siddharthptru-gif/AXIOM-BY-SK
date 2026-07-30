/**
 * The workbench view runtime: activity bar containers, tree views, menus and context keys.
 *
 * Phase 4 gave contributed *webviews* a home. This is the other half of the sidebar: the views an
 * extension declares in `contributes.views`, the containers it declares in
 * `contributes.viewsContainers`, the trees it fills through `TreeDataProvider`, the menus gated by
 * `when` clauses, and the store those clauses read.
 *
 * The division of labour, which follows Phase 4's exactly:
 *
 *   - `common/vscodeViews.ts`, `common/vscodeTree.ts`, `common/vscodeMenus.ts` and
 *     `common/vscodeContextKeys.ts` are pure. Registry building, item normalisation, flattening,
 *     virtualisation, menu resolution and clause evaluation live there and are validated there.
 *   - This file owns the state, the I/O and the extension hosts: which view is loaded, which node
 *     the user expanded, what is on disk, and every round trip into a worker.
 *   - The renderer reads snapshots and sends intents. It never sees an element, a provider, or a
 *     filesystem path — icons arrive as `data:` URLs, nodes as opaque handles.
 *
 * Nothing here calls a provider directly: `bridge.call` posts a `treeGetChildren` into the worker
 * that owns the view and awaits its reply, so a provider that hangs times out instead of blocking
 * the window.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { app } from 'electron';

import { rootLogger } from '@axiom/shared';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import { ContextKeyStore, compileWhen, whenReadsAnyOf } from '../../common/vscodeContextKeys';
import {
  DEFAULT_ROW_HEIGHT,
  TreeModel,
  normalizeTreeItem,
  treeKeyAction,
  treeRowAriaLabel,
  visibleWindow,
  type TreeRow,
  type WireIcon,
  type WireTreeItem,
} from '../../common/vscodeTree';
import {
  buildMenuRegistry,
  resolveMenu,
  type MenuCommandInfo,
  type MenuRegistry,
  type ResolvedMenuGroup,
} from '../../common/vscodeMenus';
import {
  activityBarContainers,
  buildViewRegistry,
  builtInViewsOf,
  emptyViewState,
  emptyWorkbenchState,
  panelContainers,
  parseWorkbenchState,
  pruneWorkbenchState,
  resolveWelcome,
  visibleViewsOf,
  type PersistedViewState,
  type PersistedWorkbenchState,
  type RegisteredContainer,
  type RegisteredView,
  type TreeRowSnapshot,
  type TreeViewSnapshot,
  type ViewContributor,
  type ViewRegistry,
  type ContainerSnapshot,
  type ViewSummary,
  type WorkbenchSnapshot,
} from '../../common/vscodeViews';

const log = rootLogger.child('extension-views');

/** How long a provider gets to answer one `getChildren`. GitLens's first graph load is slow. */
const CHILDREN_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const PERSIST_DELAY_MS = 1_000;
/** Expansions replayed when a view first loads. Bounds a deep restored tree's startup cost. */
const MAX_RESTORE_LOADS = 200;
/** Largest container or view icon read off disk. */
const MAX_VIEW_ICON_BYTES = 256 * 1024;
/** Distinct `TreeItem.iconPath` files held as bytes at once, across all views. */
const MAX_ITEM_ICON_CACHE = 512;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts and the workbench
// ---------------------------------------------------------------------------
export interface ViewsHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Call into a worker and await its reply, on the host's own invocation id space. */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The workbench model changed: the renderer should re-read it. */
  notifyChanged(): void;
  /** Run a command id, through the same path `commands.execute` uses. */
  runCommand(command: string, args: unknown[]): Promise<void>;
  /** Fire `onView:<viewId>` for the extension that contributed a view. */
  activateForView(viewId: string): Promise<void>;
  /** Every enabled extension's workbench contributions, in a stable order. */
  contributors(): Promise<ViewContributor[]>;
  /** What the command registry knows, for menu titles, icons and enablement. */
  commands(): Map<string, MenuCommandInfo>;
}

let bridge: ViewsHostBridge | null = null;

export function configureExtensionViews(next: ViewsHostBridge): void {
  bridge = next;
}

function requireBridge(): ViewsHostBridge {
  if (bridge === null) throw new Error('The workbench view runtime is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** One contributed view that has, or could have, a tree. */
interface TreeState {
  viewId: string;
  /** The extension that *contributed* the view, which is the one that may provide for it. */
  extensionId: string;
  model: TreeModel;
  registered: boolean;
  canSelectMany: boolean;
  showCollapseAll: boolean;
  hasResolve: boolean;
  title: string | null;
  description: string | null;
  message: string | null;
  badge: { value: number; tooltip: string } | null;
  visible: boolean;
  scrollTop: number;
  collapsed: boolean;
  size: number | null;
  /** Set while a load is in flight, so two scrolls do not fetch the same children twice. */
  loading: Set<string>;
  rootsLoading: boolean;
  /** Handles whose `resolveTreeItem` has already been asked for. */
  resolved: Set<string>;
  lastError: string | null;
}

let registry: ViewRegistry = buildViewRegistry([]);
let menus: MenuRegistry = buildMenuRegistry([]);
const trees = new Map<string, TreeState>();
const contextKeys = new ContextKeyStore();
/**
 * Keys that describe the process rather than the window (PRD Phase 5 §5).
 *
 * Upstream sets these once at startup and extensions gate real contributions on them — GitLens
 * hides its terminal links on the web, Docker branches its socket path on `isWindows`. They are
 * constants here, so they are re-applied with every workbench write instead of being stored once.
 */
const PLATFORM_CONTEXT: Readonly<Record<string, unknown>> = {
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  isLinux: process.platform !== 'win32' && process.platform !== 'darwin',
  isWeb: false,
  isDevelopment: !app.isPackaged,
};
/** The last set of window-owned keys, replayed whenever the platform keys are re-applied. */
let workbenchContext: Record<string, unknown> = {};
/** Container id → `data:` URL, resolved once per registry build. */
const containerIcons = new Map<string, string>();
/** Extension id → its packaged directory, so a `TreeItem.iconPath` can be resolved to bytes. */
const extensionDirs = new Map<string, string>();
/** `extensionId iconPath` → `data:` URL, or null when the file could not be used. */
const itemIcons = new Map<string, string | null>();
let workbenchState: PersistedWorkbenchState = emptyWorkbenchState();
let stateLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let activeContainer: string | null = null;
/** False until the first registry build, so the first snapshot request triggers one. */
let registryBuilt = false;

/** Build the registry if nothing has yet. The renderer's first read goes through this. */
export async function ensureViewRegistry(): Promise<void> {
  if (registryBuilt) return;
  await refreshViewRegistry();
}

function changed(): void {
  bridge?.notifyChanged();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const ICON_MIME: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Turn a packaged-relative icon path into a `data:` URL.
 *
 * The same rule as Phase 4's webview icons: the path is resolved inside the extension's own
 * directory and refused if it escapes, the file is size-capped, and what reaches the renderer is
 * bytes. A path never becomes a `src` attribute, so a crafted icon path cannot make the workbench
 * read something outside the extension.
 */
async function resolveIcon(directory: string, iconPath: string): Promise<string | null> {
  if (iconPath.length === 0) return null;
  const root = resolve(directory);
  const target = resolve(root, normalize(iconPath));
  if (!isAbsolute(target)) return null;
  if (target !== root && !target.startsWith(root + sep)) return null;
  const mime = ICON_MIME[extname(target).toLowerCase()];
  if (mime === undefined) return null;
  try {
    const bytes = await readFile(target);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIEW_ICON_BYTES) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Rebuild the workbench model from the enabled extensions.
 *
 * Called after an install, an uninstall, an enable or a disable. Tree state for views that are
 * still present is kept — reinstalling an extension should not collapse the user's sidebar — and
 * state for views that are gone is dropped on the next write.
 */
export async function refreshViewRegistry(): Promise<void> {
  registryBuilt = true;
  const contributors = await requireBridge().contributors();
  registry = buildViewRegistry(contributors);
  menus = buildMenuRegistry(
    contributors.map((contributor) => ({
      extensionId: contributor.extensionId,
      menus: contributor.menus,
      submenus: contributor.submenus,
    })),
  );

  containerIcons.clear();
  extensionDirs.clear();
  itemIcons.clear();
  for (const contributor of contributors) {
    extensionDirs.set(contributor.extensionId, contributor.directory);
  }
  for (const container of registry.containers) {
    if (container.icon === null) continue;
    const url = await resolveIcon(container.directory, container.icon);
    if (url !== null) containerIcons.set(container.id, url);
  }

  // Compile every clause now rather than on the first render. The cache is keyed by the clause text,
  // so this is the "parse once" the workbench relies on: after this loop a context-key change
  // re-evaluates ASTs and never re-parses.
  for (const view of registry.views) compileWhen(view.when);
  for (const entry of registry.welcome) {
    compileWhen(entry.when);
    compileWhen(entry.enablement ?? null);
  }
  for (const items of menus.byLocation.values()) {
    for (const item of items) compileWhen(item.when ?? null);
  }

  await ensureStateLoaded();

  const known = new Set(registry.views.map((view) => view.id));
  for (const viewId of [...trees.keys()]) {
    if (!known.has(viewId)) trees.delete(viewId);
  }
  for (const view of registry.views) {
    const existing = trees.get(view.id);
    if (existing !== undefined) {
      existing.extensionId = view.extensionId;
      continue;
    }
    if (view.type !== 'tree') continue;
    trees.set(view.id, newTreeState(view));
  }

  if (activeContainer === null) activeContainer = workbenchState.activeContainer;
  // Platform keys exist before any window has reported anything, so an extension activated by a
  // `when` clause on `isWindows` does not have to wait for the first renderer push.
  contextKeys.applyWorkbench({ ...PLATFORM_CONTEXT, ...workbenchContext });
  if (registry.orphanViews.length > 0) {
    log.info('Some contributed views target a container this build does not have', {
      count: registry.orphanViews.length,
      containers: [...new Set(registry.orphanViews.map((entry) => entry.container))].slice(0, 10),
    });
  }
  changed();
}

function newTreeState(view: RegisteredView): TreeState {
  const persisted = workbenchState.views[view.id] ?? emptyViewState();
  const model = new TreeModel();
  model.restoreExpanded(persisted.expanded);
  return {
    viewId: view.id,
    extensionId: view.extensionId,
    model,
    registered: false,
    canSelectMany: false,
    showCollapseAll: false,
    hasResolve: false,
    title: null,
    description: null,
    message: null,
    badge: null,
    visible: false,
    scrollTop: persisted.scrollTop,
    collapsed: persisted.collapsed || view.visibility === 'collapsed',
    size: persisted.size ?? view.initialSize,
    loading: new Set(),
    rootsLoading: false,
    resolved: new Set(),
    lastError: null,
  };
}

export function viewRegistrySnapshot(): ViewRegistry {
  return registry;
}

// ---------------------------------------------------------------------------
// Requests from an extension host
// ---------------------------------------------------------------------------
const VIEW_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
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
]);

export function isViewsRequestKind(kind: HostRequestKind): boolean {
  return VIEW_REQUEST_KINDS.has(kind);
}

/**
 * An extension may only speak about a view it contributed.
 *
 * `contributes.views` is the claim; the running host is the claimant. Without this check any
 * extension could register a provider for GitLens's commit view and replace its content, which is
 * the tree-view equivalent of overwriting another extension's webview.
 */
function ownView(extensionId: string, viewId: string): TreeState | null {
  const declared = registry.views.find((view) => view.id === viewId);
  if (declared === undefined || declared.extensionId !== extensionId) return null;
  const existing = trees.get(viewId);
  if (existing !== undefined) return existing;
  const created = newTreeState(declared);
  trees.set(viewId, created);
  return created;
}

export async function handleViewsRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (kind === 'context.setKey') {
    const key = payload.key as string;
    const result = contextKeys.set(
      key,
      payload.remove === true ? undefined : payload.value,
      extensionId,
    );
    if (result === 'reserved') {
      throw new Error(
        `${key} is computed by the workbench from the state of the window; an extension cannot set it. Use a key of your own.`,
      );
    }
    if (result === 'full') throw new Error('The context key store is full.');
    if (result === 'invalid-key' || result === 'invalid-value') {
      throw new Error(
        `setContext could not accept that ${result === 'invalid-key' ? 'key' : 'value'}.`,
      );
    }
    if (result !== 'unchanged') changed();
    return null;
  }

  const viewId = payload.viewId as string;
  const state = ownView(extensionId, viewId);
  if (state === null) {
    throw new Error(
      `${extensionId} does not contribute the view ${viewId}. Declare it in contributes.views first.`,
    );
  }

  switch (kind) {
    case 'tree.registerProvider':
      state.registered = true;
      state.canSelectMany = payload.canSelectMany === true;
      state.showCollapseAll = payload.showCollapseAll === true;
      state.hasResolve = payload.hasResolve === true;
      state.lastError = null;
      // The provider may have registered while the view was already on screen — a lazily
      // activated extension always does — so load now rather than waiting for another reveal.
      if (state.visible) void ensureRootsLoaded(state);
      changed();
      return null;
    case 'tree.unregisterProvider':
      state.registered = false;
      state.model.invalidate(null);
      changed();
      return null;
    case 'tree.refresh': {
      const handles = payload.handles as string[] | null;
      if (handles === null || handles.length === 0) {
        state.model.invalidate(null);
        state.resolved.clear();
        if (state.visible) void ensureRootsLoaded(state);
      } else {
        for (const handle of handles) {
          state.model.invalidate(handle);
          state.resolved.delete(handle);
          if (state.visible && state.model.isExpanded(handle)) void loadChildren(state, handle);
        }
      }
      changed();
      return null;
    }
    case 'tree.setTitle':
      state.title = (payload.title as string | null) ?? null;
      changed();
      return null;
    case 'tree.setDescription':
      state.description = (payload.description as string | null) ?? null;
      changed();
      return null;
    case 'tree.setMessage':
      state.message = (payload.message as string | null) ?? null;
      changed();
      return null;
    case 'tree.setBadge': {
      const value = payload.value as number | null;
      state.badge = value === null ? null : { value, tooltip: (payload.tooltip as string) ?? '' };
      changed();
      return null;
    }
    case 'tree.setSelection':
      state.model.setSelection(payload.handles as string[]);
      schedulePersist();
      changed();
      return null;
    case 'tree.reveal':
      await revealHandle(state, {
        handle: payload.handle as string,
        select: payload.select === true,
        focus: payload.focus === true,
        expand: (payload.expand as number) ?? 0,
      });
      return null;
    default:
      throw new Error(`${kind} is not a workbench view request.`);
  }
}

// ---------------------------------------------------------------------------
// Loading children
// ---------------------------------------------------------------------------
/**
 * Turn the icon paths on a batch of items into `data:` URLs.
 *
 * A `TreeItem.iconPath` is a path inside the extension's package, and a path must not reach the
 * renderer: it would become an `<img src>` pointing at the local filesystem. The bytes are read
 * here under the same containment rule as container icons and cached per extension, because a
 * thousand-node tree usually names a dozen distinct icons.
 */
async function resolveItemIcons(extensionId: string, items: WireTreeItem[]): Promise<void> {
  const directory = extensionDirs.get(extensionId);
  for (const item of items) {
    const icon = item.icon;
    if (icon === null || icon.kind !== 'path') continue;
    const light = await cachedItemIcon(extensionId, directory, icon.light);
    const dark = await cachedItemIcon(extensionId, directory, icon.dark);
    const next: WireIcon =
      light === null && dark === null
        ? null
        : { kind: 'path', light: light ?? dark ?? '', dark: dark ?? light ?? '' };
    item.icon = next;
  }
}

async function cachedItemIcon(
  extensionId: string,
  directory: string | undefined,
  iconPath: string,
): Promise<string | null> {
  if (directory === undefined || iconPath.length === 0) return null;
  const key = `${extensionId}|${iconPath}`;
  const hit = itemIcons.get(key);
  if (hit !== undefined) return hit;
  // A tree can name more icons than it is worth holding bytes for; the cache is dropped whole
  // rather than evicted one entry at a time, which costs a re-read and never unbounded memory.
  if (itemIcons.size >= MAX_ITEM_ICON_CACHE) itemIcons.clear();
  const url = await resolveIcon(directory, iconPath);
  itemIcons.set(key, url);
  return url;
}

/** `resolveItemIcons`, threaded so a loader reads as one expression. */
async function withIcons(state: TreeState, items: WireTreeItem[]): Promise<WireTreeItem[]> {
  await resolveItemIcons(state.extensionId, items);
  return items;
}

/**
 * Re-validate what a worker sent.
 *
 * The worker already normalised these, but it is running third-party code and Main does not trust
 * its own children: every item is put back through the shared normaliser here, so a compromised
 * host cannot hand the renderer a field the model never allowed.
 */
function readWireItems(raw: unknown): WireTreeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WireTreeItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const handle = (entry as { handle?: unknown }).handle;
    if (typeof handle !== 'string' || handle.length === 0) continue;
    out.push(normalizeWireItem(entry as Record<string, unknown>, handle));
  }
  return out;
}

function normalizeWireItem(entry: Record<string, unknown>, handle: string): WireTreeItem {
  // `normalizeTreeItem` accepts the loose provider shape, and the wire shape is a subset of it:
  // an icon that is already `{kind:'theme'|'path'}` is handed back through the same narrowing.
  const icon = entry.icon as Record<string, unknown> | null | undefined;
  const iconPath =
    icon === null || icon === undefined
      ? undefined
      : icon.kind === 'theme'
        ? { id: icon.id, color: icon.color }
        : { light: icon.light, dark: icon.dark };
  const command = entry.command as Record<string, unknown> | null | undefined;
  return normalizeTreeItem(
    {
      id: entry.id,
      label:
        entry.highlights === null || entry.highlights === undefined
          ? entry.label
          : { label: entry.label, highlights: entry.highlights },
      description: entry.description,
      tooltip: entry.tooltipIsMarkdown === true ? { value: entry.tooltip } : entry.tooltip,
      iconPath,
      resourceUri: entry.resourceUri,
      contextValue: entry.contextValue,
      command: command ?? undefined,
      collapsibleState: entry.collapsibleState,
      checkboxState:
        entry.checkboxState === null || entry.checkboxState === undefined
          ? undefined
          : { state: entry.checkboxState === 'checked' ? 1 : 0, tooltip: entry.checkboxTooltip },
      accessibilityInformation: {
        label: entry.accessibilityLabel,
        role: entry.accessibilityRole,
      },
    },
    handle,
  );
}

/** Ask the owning host for the roots, once. */
async function ensureRootsLoaded(state: TreeState): Promise<void> {
  if (state.model.rootsLoaded || state.rootsLoading) return;
  if (!state.registered) {
    // No provider yet: the contributing extension may not be activated. `onView:` is the event
    // upstream fires here, and Main's activation index already understands it.
    void requireBridge()
      .activateForView(state.viewId)
      .catch(() => undefined);
    return;
  }
  state.rootsLoading = true;
  changed();
  try {
    const value = await requireBridge().call(
      state.extensionId,
      (id) => ({ t: 'treeGetChildren', id, viewId: state.viewId, handle: null }),
      CHILDREN_TIMEOUT_MS,
    );
    state.model.setRoots(await withIcons(state, readWireItems(value)));
    state.lastError = null;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    log.warn('A tree view could not load its roots', {
      viewId: state.viewId,
      error: state.lastError,
    });
  } finally {
    state.rootsLoading = false;
    changed();
  }
  await replayExpansion(state);
}

async function loadChildren(state: TreeState, handle: string): Promise<void> {
  if (state.loading.has(handle) || !state.registered) return;
  state.loading.add(handle);
  changed();
  try {
    const value = await requireBridge().call(
      state.extensionId,
      (id) => ({ t: 'treeGetChildren', id, viewId: state.viewId, handle }),
      CHILDREN_TIMEOUT_MS,
    );
    const outcome = state.model.setChildren(handle, await withIcons(state, readWireItems(value)));
    if (outcome === 'full') {
      state.lastError = 'This view has reached the node limit for one tree.';
    } else if (outcome === 'too-deep') {
      state.lastError = 'This view is nested deeper than AXIOM draws.';
    }
  } catch (error) {
    // A failed expansion must not leave a permanent spinner: the node goes back to unloaded, so
    // the user can try again, and the reason is surfaced on the view.
    state.model.setChildren(handle, []);
    state.model.invalidate(handle);
    state.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading.delete(handle);
    changed();
  }
}

/**
 * Replay the expansion the user left behind.
 *
 * Bounded, and breadth-first by construction: each pass expands the handles that are now visible
 * and were expanded before, and the loop stops when a pass loads nothing. A restored tree that no
 * longer contains a handle simply stops unfolding there.
 */
async function replayExpansion(state: TreeState): Promise<void> {
  const wanted = new Set(workbenchState.views[state.viewId]?.expanded ?? []);
  if (wanted.size === 0) return;
  for (let pass = 0; pass < MAX_RESTORE_LOADS; pass += 1) {
    const pending = state.model
      .flattenVisible()
      .filter((row) => wanted.has(row.handle) && row.expandable)
      .map((row) => row.handle)
      .filter((handle) => state.model.node(handle)?.children === null);
    if (pending.length === 0) break;
    for (const handle of pending.slice(0, 20)) {
      state.model.expand(handle);
      await loadChildren(state, handle);
    }
  }
  const selection = workbenchState.views[state.viewId]?.selected ?? [];
  if (selection.length > 0) state.model.setSelection(selection);
  changed();
}

// ---------------------------------------------------------------------------
// reveal
// ---------------------------------------------------------------------------
/**
 * The ancestor chain a handle implies, without needing the nodes to be loaded.
 *
 * Positional handles are paths (`/3/1/0`), so a prefix *is* the parent, which is what makes
 * `reveal()` on a node the user has never expanded possible: Main walks the prefixes, loading each
 * level, until the target appears. A handle that came from `TreeItem.id` (`#gitlens:branch:main`)
 * carries no parentage, so for those the chain is whatever the model already knows.
 */
function handleAncestors(handle: string): string[] {
  const out: string[] = [];
  let cursor = handle;
  for (let guard = 0; guard < 128; guard += 1) {
    const cut = cursor.lastIndexOf('/');
    if (cut <= 0) break;
    cursor = cursor.slice(0, cut);
    out.unshift(cursor);
  }
  return out;
}

export interface RevealOptions {
  handle: string;
  select: boolean;
  focus: boolean;
  /** 0–3, as upstream: how many levels below the target to open. */
  expand: number;
}

async function revealHandle(state: TreeState, options: RevealOptions): Promise<void> {
  await ensureRootsLoaded(state);
  const known = state.model.node(options.handle);
  const chain =
    known !== undefined ? state.model.ancestorsOf(options.handle) : handleAncestors(options.handle);
  for (const ancestor of chain) {
    if (state.model.node(ancestor) === undefined) break;
    if (state.model.expand(ancestor) === 'needs-children') await loadChildren(state, ancestor);
    else state.model.expand(ancestor);
  }
  if (state.model.node(options.handle) === undefined) {
    // Not reachable: either the provider changed under us or the element was never returned by
    // `getChildren`. Upstream throws in the extension; here the request already resolved, so this
    // is recorded on the view instead of crashing the host.
    state.lastError = `reveal could not find ${options.handle} in ${state.viewId}.`;
    changed();
    return;
  }
  await expandLevels(state, options.handle, Math.min(3, Math.max(0, options.expand)));
  if (options.select) state.model.setSelection([options.handle]);
  if (options.focus || options.select) state.model.setFocus(options.handle);
  state.collapsed = false;
  schedulePersist();
  changed();
}

/** Open `levels` levels below (and including) a node, loading each as it goes. */
async function expandLevels(state: TreeState, handle: string, levels: number): Promise<void> {
  if (levels <= 0) return;
  if (state.model.expand(handle) === 'needs-children') await loadChildren(state, handle);
  const children = state.model.node(handle)?.children ?? [];
  for (const child of children.slice(0, 50)) {
    await expandLevels(state, child, levels - 1);
  }
}

/**
 * `resolveTreeItem`, once per node.
 *
 * Upstream calls it lazily — on hover, or when the row scrolls into view — because it is where
 * extensions do expensive work (GitLens hydrates commit tooltips here). The `resolved` set makes it
 * at-most-once per node per refresh; `tree.refresh` clears it.
 */
export async function resolveTreeRow(viewId: string, handle: string): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined || !state.registered || !state.hasResolve) return;
  if (state.resolved.has(handle) || state.model.node(handle) === undefined) return;
  state.resolved.add(handle);
  try {
    const value = await requireBridge().call(
      state.extensionId,
      (id) => ({ t: 'treeResolveItem', id, viewId, handle }),
      RESOLVE_TIMEOUT_MS,
    );
    const items = readWireItems(Array.isArray(value) ? value : [value]);
    const resolved = (await withIcons(state, items))[0];
    if (resolved !== undefined) {
      state.model.updateItem(resolved);
      changed();
    }
  } catch (error) {
    log.debug('resolveTreeItem failed', { viewId, error: String(error) });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
/**
 * Where the workbench remembers itself.
 *
 * Its own file, not AXIOM's `LayoutState`: that shape is a fixed versioned contract for the panes
 * this build ships, and widening it for contributed views would put third-party ids inside a
 * structure the rest of the app validates strictly. Same write discipline as Phase 4 — a temp file
 * plus a rename, so a crash mid-write leaves the previous state readable rather than a truncated
 * JSON file.
 */
function stateFile(): string {
  return join(app.getPath('userData'), 'extension-views.json');
}

async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const raw = await readFile(stateFile(), 'utf8');
    workbenchState = parseWorkbenchState(JSON.parse(raw));
  } catch {
    workbenchState = emptyWorkbenchState();
  }
  activeContainer = workbenchState.activeContainer;
}

/** Read the live state back into the persisted shape. */
function captureState(): PersistedWorkbenchState {
  const views: Record<string, PersistedViewState> = {};
  for (const [viewId, state] of trees) {
    views[viewId] = {
      collapsed: state.collapsed,
      expanded: state.model.expandedList(),
      selected: [...state.model.selection],
      scrollTop: state.scrollTop,
      size: state.size,
    };
  }
  return pruneWorkbenchState(
    {
      version: 1,
      activeContainer,
      hiddenContainers: workbenchState.hiddenContainers,
      views,
    },
    new Set(registry.views.map((view) => view.id)),
  );
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushViewState();
  }, PERSIST_DELAY_MS);
}

/** Write now. Called on quit, and by the debounce. */
export async function flushViewState(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!stateLoaded) return;
  workbenchState = captureState();
  const target = stateFile();
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(workbenchState), 'utf8');
    await rename(temp, target);
  } catch (error) {
    log.warn('Could not persist workbench view state', { error: String(error) });
  }
}

// ---------------------------------------------------------------------------
// Snapshots for the renderer
// ---------------------------------------------------------------------------

function contextValues(): Record<string, unknown> {
  return contextKeys.snapshot();
}

function viewSummary(view: RegisteredView): ViewSummary {
  const state = trees.get(view.id);
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    extensionId: view.extensionId,
    extensionName: view.extensionName,
    contextualTitle: view.contextualTitle,
    collapsed: state?.collapsed ?? view.visibility === 'collapsed',
    size: state?.size ?? view.initialSize,
    badge: state?.badge ?? null,
    live: state?.registered ?? false,
  };
}

function containerSnapshot(
  container: RegisteredContainer,
  context: Record<string, unknown>,
): ContainerSnapshot {
  const views = visibleViewsOf(registry, container.id, context).map(viewSummary);
  let total = 0;
  for (const view of views) total += view.badge?.value ?? 0;
  return {
    id: container.id,
    title: container.title,
    extensionId: container.extensionId,
    extensionName: container.extensionName,
    icon: containerIcons.get(container.id) ?? null,
    location: container.location,
    badge: total > 0 ? { value: total, tooltip: `${total} items` } : null,
    views,
  };
}

export function workbenchSnapshot(): WorkbenchSnapshot {
  const context = contextValues();
  const builtIn: Record<string, ViewSummary[]> = {};
  for (const view of registry.views) {
    if (view.builtIn === null) continue;
    const list = builtInViewsOf(registry, view.builtIn, context).map(viewSummary);
    builtIn[view.builtIn] = list;
  }
  let treeVersion = 0;
  for (const state of trees.values()) treeVersion += state.model.version;
  return {
    version: contextKeys.version + treeVersion + registry.views.length,
    containers: activityBarContainers(registry, context).map((c) => containerSnapshot(c, context)),
    panels: panelContainers(registry, context).map((c) => containerSnapshot(c, context)),
    activeContainer,
    builtIn,
    orphanViews: registry.orphanViews.map((entry) => ({
      viewId: entry.viewId,
      container: entry.container,
      extensionId: entry.extensionId,
    })),
    unsupportedMenus: menus.unsupportedLocations,
  };
}

// ---------------------------------------------------------------------------
// One tree, windowed
// ---------------------------------------------------------------------------
/**
 * Build one view's snapshot.
 *
 * `viewportHeight` comes from the renderer because only it knows how tall the pane is; everything
 * else is derived here so the component stays a renderer of rows. Flattening happens on every call
 * and is O(visible nodes) — the expensive part, `getChildren`, already happened.
 */
export function treeSnapshot(viewId: string, viewportHeight: number): TreeViewSnapshot | null {
  const state = trees.get(viewId);
  if (state === undefined) return null;
  const context = contextValues();
  const rows: TreeRow[] = state.model.flattenVisible();
  const window = visibleWindow(rows.length, state.scrollTop, viewportHeight, DEFAULT_ROW_HEIGHT);
  const selection = new Set(state.model.selection);
  const focused = state.model.focused;
  const slice: TreeRowSnapshot[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    slice.push({
      handle: row.handle,
      index,
      depth: row.depth,
      item: row.item,
      expandable: row.expandable,
      expanded: row.expanded,
      loading: row.loading,
      selected: selection.has(row.handle),
      focused: focused === row.handle,
      ariaLabel: treeRowAriaLabel(row, index + 1, rows.length),
    });
  }
  return {
    viewId,
    version: state.model.version,
    title: state.title,
    description: state.description,
    message: state.message,
    badge: state.badge,
    canSelectMany: state.canSelectMany,
    showCollapseAll: state.showCollapseAll,
    registered: state.registered,
    loading: state.rootsLoading || state.loading.size > 0,
    error: state.lastError,
    collapsed: state.collapsed,
    size: state.size,
    scrollTop: state.scrollTop,
    rowHeight: DEFAULT_ROW_HEIGHT,
    rows: slice,
    total: rows.length,
    topPadding: window.topPadding,
    totalHeight: window.totalHeight,
    selection: [...state.model.selection],
    focused,
    welcome: rows.length === 0 ? resolveWelcome(registry, viewId, context) : [],
  };
}

// ---------------------------------------------------------------------------
// Intents from the renderer
// ---------------------------------------------------------------------------
/**
 * A pane became visible or hidden.
 *
 * Visibility is what drives loading: nothing is fetched for a collapsed or off-screen view, which
 * is why installing GitLens does not cost twelve provider round trips at startup. The host is told
 * too, because `TreeView.visible` and `onDidChangeVisibility` are public API extensions branch on.
 */
export async function setViewVisible(viewId: string, visible: boolean): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined || state.visible === visible) return;
  state.visible = visible;
  requireBridge().deliver(state.extensionId, { t: 'treeVisibility', viewId, visible });
  if (visible) await ensureRootsLoaded(state);
  changed();
}

export async function expandRow(viewId: string, handle: string): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined) return;
  const outcome = state.model.expand(handle);
  if (outcome === 'unknown' || outcome === 'not-expandable') return;
  requireBridge().deliver(state.extensionId, {
    t: 'treeExpansion',
    viewId,
    handle,
    expanded: true,
  });
  if (outcome === 'needs-children') await loadChildren(state, handle);
  schedulePersist();
  changed();
}

export function collapseRow(viewId: string, handle: string): void {
  const state = trees.get(viewId);
  if (state === undefined || !state.model.collapse(handle)) return;
  requireBridge().deliver(state.extensionId, {
    t: 'treeExpansion',
    viewId,
    handle,
    expanded: false,
  });
  schedulePersist();
  changed();
}

/** Collapse everything, for the `showCollapseAll` title button. */
export function collapseAll(viewId: string): void {
  const state = trees.get(viewId);
  if (state === undefined) return;
  for (const handle of state.model.expandedList()) collapseRow(viewId, handle);
}

export function selectRows(viewId: string, handles: string[]): void {
  const state = trees.get(viewId);
  if (state === undefined) return;
  const wanted = state.canSelectMany ? handles : handles.slice(0, 1);
  state.model.setSelection(wanted);
  const last = wanted[wanted.length - 1];
  if (last !== undefined) state.model.setFocus(last);
  requireBridge().deliver(state.extensionId, {
    t: 'treeSelection',
    viewId,
    handles: [...state.model.selection],
  });
  schedulePersist();
  changed();
}

/**
 * Enter, or a click on a row that carries a command.
 *
 * The arguments were narrowed to JSON in the pure layer when the item was normalised, and the id
 * itself is resolved by the command registry — an item cannot invoke something that was never
 * registered, and cannot smuggle a function or a live object through as an argument.
 */
export async function activateRow(viewId: string, handle: string): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined) return;
  selectRows(viewId, [handle]);
  const command = state.model.node(handle)?.item.command ?? null;
  if (command === null) return;
  try {
    await requireBridge().runCommand(command.command, command.arguments);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    changed();
  }
}

export function toggleCheckbox(viewId: string, handle: string): void {
  const state = trees.get(viewId);
  if (state === undefined) return;
  const current = state.model.node(handle)?.item.checkboxState ?? null;
  if (current === null) return;
  const next = current === 'checked' ? 'unchecked' : 'checked';
  if (!state.model.updateCheckbox(handle, next)) return;
  requireBridge().deliver(state.extensionId, {
    t: 'treeCheckbox',
    viewId,
    items: [{ handle, checked: next === 'checked' }],
  });
  changed();
}

/** Keyboard handling, decided by the pure table and applied here. */
export async function handleTreeKey(viewId: string, key: string): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined) return;
  const action = treeKeyAction(state.model.flattenVisible(), state.model.focused, key);
  switch (action.kind) {
    case 'focus':
      selectRows(viewId, [action.handle]);
      return;
    case 'expand':
      await expandRow(viewId, action.handle);
      return;
    case 'collapse':
      collapseRow(viewId, action.handle);
      return;
    case 'activate':
      await activateRow(viewId, action.handle);
      return;
    case 'toggle-checkbox':
      toggleCheckbox(viewId, action.handle);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Pane and container state
// ---------------------------------------------------------------------------
export function setActiveContainer(containerId: string | null): void {
  if (containerId !== null && !registry.containers.some((c) => c.id === containerId)) return;
  activeContainer = containerId;
  schedulePersist();
  changed();
}

export function activeContainerId(): string | null {
  return activeContainer;
}

export async function setViewCollapsed(viewId: string, collapsed: boolean): Promise<void> {
  const state = trees.get(viewId);
  if (state === undefined || state.collapsed === collapsed) return;
  state.collapsed = collapsed;
  schedulePersist();
  await setViewVisible(viewId, !collapsed);
  changed();
}

export function setViewSize(viewId: string, size: number | null): void {
  const state = trees.get(viewId);
  if (state === undefined) return;
  state.size = size === null ? null : Math.min(2000, Math.max(60, Math.round(size)));
  schedulePersist();
}

/**
 * Scroll position, stored but deliberately not broadcast.
 *
 * Scrolling changes which rows the next snapshot contains but not the model, so it does not call
 * `changed()` — a scroll must not notify every other view in the window.
 */
export function setViewScroll(viewId: string, scrollTop: number): void {
  const state = trees.get(viewId);
  if (state === undefined) return;
  state.scrollTop = Math.max(0, Math.round(scrollTop));
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------
/**
 * The workbench's own keys.
 *
 * AXIOM computes these — the focused editor, its language, the number of workspace folders — and
 * they are written under a reserved owner so no extension can forge them. Only a real change bumps
 * the store version, so a keystroke that leaves `editorLangId` alone re-renders nothing.
 *
 * `applyWorkbench` replaces the whole workbench-owned half, which is what keeps a stale
 * `resourceLangId` from outliving its editor. The platform keys are therefore merged in here rather
 * than pushed by the window: they are facts about this process, they never change while it runs, and
 * a renderer that forgot to resend them must not be able to make `isWindows` undefined.
 *
 * The window reports in more than one push — the sidebar knows which container is showing, the
 * editor bridge knows which file is focused — so pushes accumulate here instead of each one wiping
 * the other's keys. Every reporter sends its whole key set on every change, using a falsy value for
 * "nothing", so accumulating cannot leave a key describing an editor that has since closed.
 */
export function applyWorkbenchContext(values: Record<string, unknown>): void {
  workbenchContext = { ...workbenchContext, ...values };
  if (contextKeys.applyWorkbench({ ...PLATFORM_CONTEXT, ...workbenchContext })) changed();
}

export function contextKeySnapshot(): Record<string, unknown> {
  return contextValues();
}

/** Which of these keys does any view's `when` clause actually read? Used to skip needless work. */
export function viewsReadContextKeys(keys: readonly string[]): boolean {
  const changedKeys = new Set(keys);
  return registry.views.some((view) => whenReadsAnyOf(view.when, changedKeys));
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
/**
 * Resolve a menu location for the renderer.
 *
 * `overlay` carries the keys that only exist for the duration of one menu — `view`, `viewItem`,
 * `listMultiSelection` — exactly as upstream scopes them. They are merged over a copy of the store,
 * never written into it, so opening a context menu cannot leave a key behind.
 */
export function resolveMenuFor(
  location: string,
  overlay: Record<string, unknown> = {},
): ResolvedMenuGroup[] {
  const context = { ...contextValues(), ...overlay };
  return resolveMenu(menus, location, context, requireBridge().commands());
}

/** The context menu for one tree row, with `view`/`viewItem` bound to that row. */
export function resolveTreeItemMenu(viewId: string, handle: string): ResolvedMenuGroup[] {
  const state = trees.get(viewId);
  const item = state?.model.node(handle)?.item;
  return resolveMenuFor('view/item/context', {
    view: viewId,
    viewItem: item?.contextValue ?? '',
    listMultiSelection: (state?.model.selection.length ?? 0) > 1,
    treeItem: item?.label ?? '',
  });
}

export function resolveViewTitleMenu(viewId: string): ResolvedMenuGroup[] {
  return resolveMenuFor('view/title', { view: viewId });
}

/**
 * Run a command a menu offered.
 *
 * The id is checked against the menu that was actually resolved for that location, not taken on
 * trust from the renderer: a message naming a command the location never contained is refused. That
 * is what closes "menus cannot execute injected commands" — the renderer cannot widen the set of
 * commands a menu can reach, and neither can a manifest.
 */
export async function runMenuCommand(
  location: string,
  command: string,
  overlay: Record<string, unknown> = {},
  args: unknown[] = [],
): Promise<void> {
  const groups = resolveMenuFor(location, overlay);
  const match = groups
    .flatMap((group) => group.items)
    .find((item) => item.command === command || item.alt === command);
  if (match === undefined) {
    throw new Error(`${command} is not offered by ${location} right now.`);
  }
  if (!match.enabled) return;
  await requireBridge().runCommand(command, args);
}

export function menuRegistrySnapshot(): MenuRegistry {
  return menus;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
/**
 * A host stopped, was disabled, or crashed.
 *
 * The contributed views stay in the registry — they are declared in the manifest, and upstream keeps
 * drawing them so a crashed extension's pane shows a reload affordance instead of vanishing — but
 * their content is dropped and their context keys are withdrawn. A key an extension set must not
 * outlive it, or a menu item stays visible for an extension that is no longer there.
 */
export function disposeViewsForExtension(extensionId: string): void {
  let touched = contextKeys.removeOwner(extensionId);
  for (const state of trees.values()) {
    if (state.extensionId !== extensionId || !state.registered) continue;
    state.registered = false;
    state.model.invalidate(null);
    state.loading.clear();
    state.resolved.clear();
    state.rootsLoading = false;
    state.message = null;
    state.badge = null;
    state.visible = false;
    touched = true;
  }
  if (touched) {
    void flushViewState();
    changed();
  }
}

/** Test and diagnostics seam: forget everything without touching disk. */
export function resetExtensionViewsForTesting(): void {
  registry = buildViewRegistry([]);
  menus = buildMenuRegistry([]);
  trees.clear();
  containerIcons.clear();
  contextKeys.clear();
  workbenchState = emptyWorkbenchState();
  stateLoaded = false;
  activeContainer = null;
  registryBuilt = false;
}
