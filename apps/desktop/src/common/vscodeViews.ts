/**
 * The contribution-driven workbench model (PRD Phase 5 §1, §2, §8, §9).
 *
 * VS Code's sidebar is not a fixed set of panels; it is whatever the installed extensions
 * declared. This module turns the raw `contributes.viewsContainers` / `contributes.views` /
 * `contributes.viewsWelcome` of every enabled extension into the ordered, deduplicated model
 * the activity bar and the sidebar draw from, and it holds the shapes of the state that has to
 * survive a restart.
 *
 * Three decisions:
 *
 *   1. **A view targeting a container AXIOM already has lands in it.** `contributes.views` is
 *      keyed by container id, and the ids `explorer`, `scm` and `debug` are upstream's own
 *      built-ins — GitLens and GitHub Pull Requests both use them. Those views are appended to
 *      AXIOM's matching sidebar rather than given a new home, because that is where the user
 *      would look for them. A container this build does not have is reported, not invented.
 *   2. **First declaration of an id wins.** Two extensions can claim the same view id; upstream
 *      resolves it by registration order and so does this. Losing the collision is recorded so
 *      the extension manager can say which extension was shadowed.
 *   3. **Nothing here evaluates a `when` clause on its own.** The caller passes a context
 *      snapshot, so visibility is a pure function of (contributions, context) and the same
 *      inputs always produce the same sidebar.
 *
 * Pure: no I/O. Icon paths are packaged-relative strings; turning one into bytes is Main's job.
 */

import { evaluateWhen } from './vscodeContextKeys';
import type { WireTreeItem } from './vscodeTree';
import type {
  MenuItemContribution,
  SubmenuContribution,
  ViewContribution,
  ViewWelcomeContribution,
  ViewsContainerContribution,
} from './vscodeManifest';
import type { ContextKeyValues } from './contextKeyExpr';

export const MAX_VIEW_CONTAINERS = 32;
export const MAX_VIEWS = 256;
export const MAX_VIEW_WELCOME = 128;
export const MAX_PERSISTED_VIEWS = 128;
export const MAX_PERSISTED_EXPANDED = 500;
export const MAX_WELCOME_BLOCKS = 32;
export const VIEW_SIZE_MIN = 60;
export const VIEW_SIZE_MAX = 2_000;

/**
 * Containers AXIOM itself provides, and the primary view each maps onto.
 *
 * These are upstream's built-in ids. An extension that contributes a view into one of them is
 * asking to appear inside a surface the workbench already owns, so the answer is a section
 * appended to that sidebar — not a new activity bar entry.
 */
export const BUILT_IN_VIEW_CONTAINERS: Readonly<Record<string, string>> = {
  explorer: 'explorer',
  scm: 'scm',
  debug: 'run',
  extensions: 'extensions',
  search: 'search',
};

export function builtInContainerFor(containerId: string): string | null {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_VIEW_CONTAINERS, containerId)
    ? (BUILT_IN_VIEW_CONTAINERS[containerId] ?? null)
    : null;
}

/** What one extension contributed to the workbench, as Main reads it off disk. */
export interface ViewContributor {
  extensionId: string;
  displayName: string;
  /** Absolute directory the icon paths are relative to. */
  directory: string;
  containers: readonly ViewsContainerContribution[];
  views: readonly ViewContribution[];
  welcome: readonly ViewWelcomeContribution[];
  menus: readonly MenuItemContribution[];
  submenus: readonly SubmenuContribution[];
}

export interface RegisteredContainer {
  id: string;
  extensionId: string;
  extensionName: string;
  title: string;
  /** Packaged-relative icon path, or null. */
  icon: string | null;
  directory: string;
  location: 'activitybar' | 'panel';
  /** Declaration order across all extensions, which is the order upstream draws them in. */
  order: number;
}

export interface RegisteredView {
  id: string;
  extensionId: string;
  extensionName: string;
  /** The container as declared. `builtIn` names AXIOM's own surface when it is one. */
  container: string;
  builtIn: string | null;
  name: string;
  type: 'tree' | 'webview';
  when: string | null;
  icon: string | null;
  contextualTitle: string | null;
  visibility: 'visible' | 'collapsed' | 'hidden';
  initialSize: number | null;
  directory: string;
  order: number;
}

export interface RegisteredWelcome {
  view: string;
  extensionId: string;
  contents: string;
  when: string | null;
  group: string | null;
  enablement: string | null;
  order: number;
}

export interface ViewRegistry {
  containers: RegisteredContainer[];
  views: RegisteredView[];
  welcome: RegisteredWelcome[];
  /** Views whose container exists nowhere: neither contributed nor built in. */
  orphanViews: Array<{ extensionId: string; viewId: string; container: string }>;
  /** Ids declared twice. The first declaration is the one in `containers`/`views`. */
  shadowed: Array<{ kind: 'container' | 'view'; id: string; extensionId: string }>;
}

/**
 * Merge every contributor into one registry.
 *
 * Order is declaration order, which for AXIOM means the order Main enumerated the enabled
 * extensions in — stable across restarts because that enumeration is sorted.
 */
export function buildViewRegistry(contributors: readonly ViewContributor[]): ViewRegistry {
  const containers: RegisteredContainer[] = [];
  const views: RegisteredView[] = [];
  const welcome: RegisteredWelcome[] = [];
  const orphanViews: ViewRegistry['orphanViews'] = [];
  const shadowed: ViewRegistry['shadowed'] = [];
  const containerIds = new Set<string>(Object.keys(BUILT_IN_VIEW_CONTAINERS));
  const contributedIds = new Set<string>();
  const viewIds = new Set<string>();

  for (const contributor of contributors) {
    for (const declared of contributor.containers) {
      if (containers.length >= MAX_VIEW_CONTAINERS) break;
      if (containerIds.has(declared.id)) {
        shadowed.push({ kind: 'container', id: declared.id, extensionId: contributor.extensionId });
        continue;
      }
      containerIds.add(declared.id);
      contributedIds.add(declared.id);
      containers.push({
        id: declared.id,
        extensionId: contributor.extensionId,
        extensionName: contributor.displayName,
        title: declared.title,
        icon: declared.icon ?? null,
        directory: contributor.directory,
        location: declared.location,
        order: containers.length,
      });
    }
  }

  for (const contributor of contributors) {
    for (const declared of contributor.views) {
      if (views.length >= MAX_VIEWS) break;
      if (viewIds.has(declared.id)) {
        shadowed.push({ kind: 'view', id: declared.id, extensionId: contributor.extensionId });
        continue;
      }
      const builtIn = builtInContainerFor(declared.container);
      if (builtIn === null && !contributedIds.has(declared.container)) {
        orphanViews.push({
          extensionId: contributor.extensionId,
          viewId: declared.id,
          container: declared.container,
        });
        continue;
      }
      viewIds.add(declared.id);
      views.push({
        id: declared.id,
        extensionId: contributor.extensionId,
        extensionName: contributor.displayName,
        container: declared.container,
        builtIn,
        name: declared.name,
        type: declared.type,
        when: declared.when ?? null,
        icon: declared.icon ?? null,
        contextualTitle: declared.contextualTitle ?? null,
        visibility: declared.visibility ?? 'visible',
        initialSize: declared.initialSize ?? null,
        directory: contributor.directory,
        order: views.length,
      });
    }
  }

  for (const contributor of contributors) {
    for (const declared of contributor.welcome) {
      if (welcome.length >= MAX_VIEW_WELCOME) break;
      welcome.push({
        view: declared.view,
        extensionId: contributor.extensionId,
        contents: declared.contents,
        when: declared.when ?? null,
        group: declared.group ?? null,
        enablement: declared.enablement ?? null,
        order: welcome.length,
      });
    }
  }

  return { containers, views, welcome, orphanViews, shadowed };
}

/** Views of one container, in declaration order, whose `when` clause passes right now. */
export function visibleViewsOf(
  registry: ViewRegistry,
  containerId: string,
  context: ContextKeyValues,
): RegisteredView[] {
  return registry.views.filter(
    (view) =>
      view.container === containerId &&
      view.visibility !== 'hidden' &&
      evaluateWhen(view.when, context),
  );
}

/** Views AXIOM's own sidebars should append, keyed by the built-in surface they land in. */
export function builtInViewsOf(
  registry: ViewRegistry,
  builtIn: string,
  context: ContextKeyValues,
): RegisteredView[] {
  return registry.views.filter(
    (view) =>
      view.builtIn === builtIn && view.visibility !== 'hidden' && evaluateWhen(view.when, context),
  );
}

/**
 * Activity bar entries for contributed containers.
 *
 * A container whose every view is gated off is hidden, which is upstream's behaviour and the
 * reason an extension can ship a container that only appears once you sign in.
 */
export function activityBarContainers(
  registry: ViewRegistry,
  context: ContextKeyValues,
): RegisteredContainer[] {
  return registry.containers.filter(
    (container) =>
      container.location === 'activitybar' &&
      visibleViewsOf(registry, container.id, context).length > 0,
  );
}

export function panelContainers(
  registry: ViewRegistry,
  context: ContextKeyValues,
): RegisteredContainer[] {
  return registry.containers.filter(
    (container) =>
      container.location === 'panel' && visibleViewsOf(registry, container.id, context).length > 0,
  );
}

// ---------------------------------------------------------------------------
// View welcome content (§8)
// ---------------------------------------------------------------------------

/**
 * One rendered piece of welcome content.
 *
 * Upstream accepts a small markdown dialect here, not arbitrary markdown: paragraphs, and links
 * whose target is a command or a URL. A link alone on its own line is drawn as a button — that
 * is how GitHub Pull Requests gets its "Sign in to GitHub" button and Continue its "Get
 * started". Anything else in the string stays text.
 */
export type WelcomeBlock =
  | { kind: 'text'; spans: WelcomeSpan[] }
  | { kind: 'button'; label: string; command: string | null; href: string | null };

export type WelcomeSpan =
  | { kind: 'plain'; text: string }
  | { kind: 'link'; text: string; command: string | null; href: string | null };

const LINK_RE = /\[([^\]]{1,120})\]\(([^)\s]{1,400})\)/g;

/**
 * Which link targets are allowed.
 *
 * `command:` and `http(s):` only. A `javascript:` or `file:` target in welcome content is an
 * extension asking the workbench to navigate somewhere it has no business navigating, so the
 * link is kept as plain text rather than made clickable.
 */
function welcomeTarget(raw: string): { command: string | null; href: string | null } | null {
  if (raw.startsWith('command:')) {
    const command = raw.slice('command:'.length).split('?')[0] ?? '';
    if (command.length === 0 || command.length > 200) return null;
    if (!/^[A-Za-z0-9_.\-:]+$/.test(command)) return null;
    return { command, href: null };
  }
  if (/^https:\/\/[^\s]+$/.test(raw)) return { command: null, href: raw };
  return null;
}

/** Split one `contents` string into blocks. Bounded: a runaway string yields a bounded model. */
export function parseWelcomeContents(contents: string): WelcomeBlock[] {
  const blocks: WelcomeBlock[] = [];
  const lines = contents.slice(0, 4_000).split('\n');
  for (const rawLine of lines) {
    if (blocks.length >= MAX_WELCOME_BLOCKS) break;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const solo = line.match(/^\[([^\]]{1,120})\]\(([^)\s]{1,400})\)$/);
    if (solo) {
      const target = welcomeTarget(solo[2] ?? '');
      if (target !== null) {
        blocks.push({
          kind: 'button',
          label: solo[1] ?? '',
          command: target.command,
          href: target.href,
        });
        continue;
      }
    }
    blocks.push({ kind: 'text', spans: parseWelcomeSpans(line) });
  }
  return blocks;
}

function parseWelcomeSpans(line: string): WelcomeSpan[] {
  const spans: WelcomeSpan[] = [];
  let cursor = 0;
  LINK_RE.lastIndex = 0;
  for (let match = LINK_RE.exec(line); match !== null; match = LINK_RE.exec(line)) {
    if (match.index > cursor) {
      spans.push({ kind: 'plain', text: line.slice(cursor, match.index) });
    }
    const label = match[1] ?? '';
    const target = welcomeTarget(match[2] ?? '');
    if (target === null) {
      spans.push({ kind: 'plain', text: match[0] });
    } else {
      spans.push({ kind: 'link', text: label, command: target.command, href: target.href });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) spans.push({ kind: 'plain', text: line.slice(cursor) });
  return spans.length > 0 ? spans : [{ kind: 'plain', text: line }];
}

/**
 * The welcome content one view should show, in group order.
 *
 * Upstream shows every matching entry, not the first, and sorts by `group`; an entry whose
 * `when` fails contributes nothing. `enablement` is carried through so the renderer can draw a
 * button that is visible but not clickable — Continue relies on that while it is still loading.
 */
export function resolveWelcome(
  registry: ViewRegistry,
  viewId: string,
  context: ContextKeyValues,
): Array<{ extensionId: string; blocks: WelcomeBlock[]; enabled: boolean }> {
  return registry.welcome
    .filter((entry) => entry.view === viewId && evaluateWhen(entry.when, context))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.order - b.order)
    .map((entry) => ({
      extensionId: entry.extensionId,
      blocks: parseWelcomeContents(entry.contents),
      enabled: entry.enablement === null ? true : evaluateWhen(entry.enablement, context),
    }));
}

// ---------------------------------------------------------------------------
// Persistence (§9)
// ---------------------------------------------------------------------------

/** A badge on an activity bar entry or a view title. Not persisted: extensions recompute it. */
export interface ViewBadge {
  value: number;
  tooltip: string;
}

export interface PersistedViewState {
  collapsed: boolean;
  /** Node ids the user had expanded. Ids are provider-supplied, so they are only hints. */
  expanded: string[];
  selected: string[];
  scrollTop: number;
  size: number | null;
}

export interface PersistedWorkbenchState {
  version: 1;
  /** Activity bar entry to restore, contributed or built-in. Null means AXIOM's own default. */
  activeContainer: string | null;
  /** Containers the user hid from the activity bar. */
  hiddenContainers: string[];
  views: Record<string, PersistedViewState>;
}

export function emptyWorkbenchState(): PersistedWorkbenchState {
  return { version: 1, activeContainer: null, hiddenContainers: [], views: {} };
}

export function emptyViewState(): PersistedViewState {
  return { collapsed: false, expanded: [], selected: [], scrollTop: 0, size: null };
}

function stringList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= limit) break;
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= 512) out.push(entry);
  }
  return out;
}

function clampSize(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(VIEW_SIZE_MAX, Math.max(VIEW_SIZE_MIN, Math.round(raw)));
}

/**
 * Read the persisted file.
 *
 * Every field is re-derived from `unknown`. A hand-edited or truncated state file must produce a
 * usable workbench rather than an exception during startup, so anything unrecognised is dropped
 * and the rest is kept — losing one view's expansion state is not worth failing a window for.
 */
export function parseWorkbenchState(raw: unknown): PersistedWorkbenchState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyWorkbenchState();
  const source = raw as Record<string, unknown>;
  const state = emptyWorkbenchState();
  if (typeof source.activeContainer === 'string' && source.activeContainer.length <= 256) {
    state.activeContainer = source.activeContainer;
  }
  state.hiddenContainers = stringList(source.hiddenContainers, MAX_VIEW_CONTAINERS);
  const views = source.views;
  if (views !== null && typeof views === 'object' && !Array.isArray(views)) {
    let kept = 0;
    for (const [viewId, rawView] of Object.entries(views as Record<string, unknown>)) {
      if (kept >= MAX_PERSISTED_VIEWS) break;
      if (viewId.length === 0 || viewId.length > 256) continue;
      if (rawView === null || typeof rawView !== 'object' || Array.isArray(rawView)) continue;
      const entry = rawView as Record<string, unknown>;
      state.views[viewId] = {
        collapsed: entry.collapsed === true,
        expanded: stringList(entry.expanded, MAX_PERSISTED_EXPANDED),
        selected: stringList(entry.selected, 100),
        scrollTop:
          typeof entry.scrollTop === 'number' && Number.isFinite(entry.scrollTop)
            ? Math.max(0, Math.round(entry.scrollTop))
            : 0,
        size: clampSize(entry.size),
      };
      kept += 1;
    }
  }
  return state;
}

/** Trim state before writing: a view that has drifted out of the registry is not worth keeping. */
export function pruneWorkbenchState(
  state: PersistedWorkbenchState,
  knownViewIds: ReadonlySet<string>,
): PersistedWorkbenchState {
  const views: Record<string, PersistedViewState> = {};
  for (const [viewId, entry] of Object.entries(state.views)) {
    if (knownViewIds.has(viewId)) views[viewId] = entry;
  }
  return { ...state, views };
}

// ---------------------------------------------------------------------------
// What the renderer receives
// ---------------------------------------------------------------------------
/**
 * The wire shapes.
 *
 * Declared here rather than in the Main service so the preload bridge and the components can name
 * them without importing anything from `src/main`. Every field is already narrowed: an icon is a
 * `data:` URL, a row is an opaque handle, and nothing in here can be turned back into a path or an
 * extension object.
 */
export interface ViewSummary {
  id: string;
  name: string;
  type: 'tree' | 'webview';
  extensionId: string;
  extensionName: string;
  contextualTitle: string | null;
  collapsed: boolean;
  size: number | null;
  badge: ViewBadge | null;
  /** True once an extension has actually registered a provider for it. */
  live: boolean;
}

export interface ContainerSnapshot {
  id: string;
  title: string;
  extensionId: string;
  extensionName: string;
  icon: string | null;
  location: 'activitybar' | 'panel';
  badge: ViewBadge | null;
  views: ViewSummary[];
}

export interface WorkbenchSnapshot {
  version: number;
  containers: ContainerSnapshot[];
  panels: ContainerSnapshot[];
  activeContainer: string | null;
  /** Contributed views that belong in one of AXIOM's own sidebars, keyed by that sidebar. */
  builtIn: Record<string, ViewSummary[]>;
  orphanViews: Array<{ viewId: string; container: string; extensionId: string }>;
  unsupportedMenus: Array<{ extensionId: string; location: string; items: number }>;
}

export interface TreeRowSnapshot {
  handle: string;
  index: number;
  depth: number;
  item: WireTreeItem;
  expandable: boolean;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  focused: boolean;
  /** What a screen reader announces for the row, built from the same flattened list. */
  ariaLabel: string;
}

export interface TreeViewSnapshot {
  viewId: string;
  version: number;
  title: string | null;
  description: string | null;
  message: string | null;
  badge: ViewBadge | null;
  canSelectMany: boolean;
  showCollapseAll: boolean;
  /** A provider has registered. False means the extension has not activated yet. */
  registered: boolean;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  size: number | null;
  scrollTop: number;
  rowHeight: number;
  /** Only the rows the viewport covers: a 10,000-node tree still mounts a few dozen. */
  rows: TreeRowSnapshot[];
  total: number;
  topPadding: number;
  totalHeight: number;
  selection: string[];
  focused: string | null;
  /** Drawn instead of rows when the tree is empty and an extension contributed welcome content. */
  welcome: Array<{ extensionId: string; blocks: WelcomeBlock[]; enabled: boolean }>;
}
