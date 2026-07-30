/**
 * The tree view model (PRD Phase 5 §3, §4, §13).
 *
 * A tree view has two halves that must not be confused. Inside the extension host there are
 * *elements*: whatever objects the extension's `TreeDataProvider` deals in — a commit, a
 * container, a spelling mistake. Those objects never leave the host; they are not serialisable
 * and they often hold closures. What crosses to Main and then to the renderer is the flattened,
 * validated projection in this file.
 *
 * The design follows upstream's, because the API forces it:
 *
 *   1. **Handles, not elements.** Every node gets a string handle derived from the provider's own
 *      `TreeItem.id` when it gave one and from the path of child indices when it did not. The
 *      host keeps handle→element; Main and the renderer only ever say "expand handle X". This is
 *      what makes `reveal()` and restored expansion state possible at all: an element identity
 *      cannot survive a restart, a handle can.
 *   2. **Children are `null` until asked for.** `getChildren` is async and may hit the network —
 *      GitLens's commit graph does. A node with `collapsibleState !== none` and `children ===
 *      null` renders a twistie and nothing else; expanding it is what triggers the fetch. That is
 *      lazy loading, and it is the only reason a 10,000-node repository view opens instantly.
 *   3. **The visible list is derived, never stored.** `flattenVisible` walks the loaded nodes
 *      once and yields exactly the rows the user could scroll to; `visibleWindow` then narrows
 *      that to the slice the viewport covers. The renderer mounts that slice and nothing else.
 *
 * Pure: no I/O, no timers, and nothing here calls a provider. Every cap is enforced on the way
 * in, so a provider that returns a million children costs a bounded amount of memory.
 */

export const MAX_TREE_LABEL_CHARS = 512;
export const MAX_TREE_DESCRIPTION_CHARS = 512;
export const MAX_TREE_TOOLTIP_CHARS = 2_048;
export const MAX_TREE_CONTEXT_VALUE_CHARS = 128;
export const MAX_TREE_HANDLE_CHARS = 1_024;
/** Children one node may contribute. Upstream has no cap; a runaway provider must not win. */
export const MAX_TREE_CHILDREN = 5_000;
/** Loaded nodes one view may hold at once. Above this, expansion is refused, not silently lost. */
export const MAX_TREE_NODES = 50_000;
export const MAX_TREE_DEPTH = 64;
export const MAX_TREE_SELECTION = 500;
export const MAX_COMMAND_ARGUMENTS = 16;
export const MAX_COMMAND_ARGUMENT_CHARS = 8_192;
export const DEFAULT_ROW_HEIGHT = 22;

export type TreeCollapsibleState = 'none' | 'collapsed' | 'expanded';
export type TreeCheckboxState = 'unchecked' | 'checked';

export interface WireThemeIcon {
  kind: 'theme';
  /** A codicon id, e.g. `git-commit`. The renderer maps a known subset and falls back honestly. */
  id: string;
  /** A theme colour id, e.g. `charts.red`. */
  color: string | null;
}

export interface WireIconPath {
  kind: 'path';
  /** Packaged-relative paths. Main turns these into `data:` URLs; a path never reaches the DOM. */
  light: string;
  dark: string;
}

export type WireIcon = WireThemeIcon | WireIconPath | null;

export interface WireTreeCommand {
  command: string;
  title: string;
  /** JSON-safe arguments only. Anything else was dropped on the way out of the host. */
  arguments: unknown[];
}

/** One node as it crosses every boundary. Flat, JSON-safe, and fully bounded. */
export interface WireTreeItem {
  handle: string;
  /** The provider's own `TreeItem.id`, when it supplied one. */
  id: string | null;
  label: string;
  /** `TreeItemLabel.highlights` — ranges the renderer emphasises. */
  highlights: Array<[number, number]> | null;
  description: string | null;
  tooltip: string | null;
  tooltipIsMarkdown: boolean;
  icon: WireIcon;
  /** A `file:` URI as text, used for icon-theme lookup and the explorer-style label. */
  resourceUri: string | null;
  contextValue: string | null;
  command: WireTreeCommand | null;
  collapsibleState: TreeCollapsibleState;
  /** Null when the provider did not opt into checkboxes for this node. */
  checkboxState: TreeCheckboxState | null;
  checkboxTooltip: string | null;
  accessibilityLabel: string | null;
  accessibilityRole: string | null;
}

// Control characters are stripped rather than escaped: a label is drawn as text, and a stray
// carriage return in one would break the row layout for reasons the user cannot see.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(CONTROL_CHARS_RE, '');
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const CODICON_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const THEME_COLOR_RE = /^[A-Za-z][A-Za-z0-9.\-_]{0,127}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-:]{0,199}$/;

export function isTreeCommandId(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_ID_RE.test(value);
}

/**
 * Narrow the arguments an extension attached to a tree item's command.
 *
 * A `TreeItem.command.arguments` array is authored by the extension and executed by the
 * workbench, so it is the one place where extension data becomes a command invocation. Anything
 * that is not plain JSON is dropped: a function, a class instance or a getter would either fail
 * to cross the boundary or arrive as something the command did not expect. Depth and size are
 * capped so a self-referential argument cannot be turned into an unbounded structure.
 */
export function sanitizeCommandArguments(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const entry of raw.slice(0, MAX_COMMAND_ARGUMENTS)) {
    const safe = jsonSafe(entry, 0);
    if (safe !== undefined) out.push(safe);
  }
  return out;
}

function jsonSafe(value: unknown, depth: number): unknown {
  if (depth > 8) return undefined;
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'string':
      return value.length > MAX_COMMAND_ARGUMENT_CHARS
        ? value.slice(0, MAX_COMMAND_ARGUMENT_CHARS)
        : value;
    case 'object':
      break;
    default:
      return undefined;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value.slice(0, 100)) {
      const safe = jsonSafe(entry, depth + 1);
      out.push(safe === undefined ? null : safe);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= 64) break;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const safe = jsonSafe(entry, depth + 1);
    if (safe === undefined) continue;
    out[key] = safe;
    kept += 1;
  }
  return out;
}

/**
 * A `vscode.TreeItem` as the worker hands it over: still loosely typed, already flattened.
 *
 * The worker converts `Uri` to text and `ThemeIcon` to `{ id, color }` because those classes are
 * its own; everything else arrives exactly as the extension set it, including the numeric enums
 * and the `string | TreeItemLabel` union, and is narrowed here so that one implementation covers
 * every provider.
 */
export interface RawTreeItem {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  tooltip?: unknown;
  iconPath?: unknown;
  resourceUri?: unknown;
  contextValue?: unknown;
  command?: unknown;
  collapsibleState?: unknown;
  checkboxState?: unknown;
  accessibilityInformation?: unknown;
}

function normalizeCollapsible(raw: unknown): TreeCollapsibleState {
  if (raw === 1 || raw === 'collapsed') return 'collapsed';
  if (raw === 2 || raw === 'expanded') return 'expanded';
  return 'none';
}

function normalizeLabel(raw: unknown): {
  label: string;
  highlights: Array<[number, number]> | null;
} {
  if (typeof raw === 'string')
    return { label: clamp(raw, MAX_TREE_LABEL_CHARS) ?? '', highlights: null };
  if (raw !== null && typeof raw === 'object') {
    const source = raw as Record<string, unknown>;
    const label = clamp(source.label, MAX_TREE_LABEL_CHARS) ?? '';
    const highlights: Array<[number, number]> = [];
    if (Array.isArray(source.highlights)) {
      for (const range of source.highlights.slice(0, 32)) {
        if (!Array.isArray(range) || range.length < 2) continue;
        const [start, end] = range as [unknown, unknown];
        if (typeof start !== 'number' || typeof end !== 'number') continue;
        if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
        if (start < 0 || end <= start || end > label.length) continue;
        highlights.push([start, end]);
      }
    }
    return { label, highlights: highlights.length > 0 ? highlights : null };
  }
  return { label: '', highlights: null };
}

function normalizeIcon(raw: unknown): WireIcon {
  if (typeof raw === 'string') {
    const path = clamp(raw, 1_024);
    return path === null ? null : { kind: 'path', light: path, dark: path };
  }
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.id === 'string') {
    const id = source.id.toLowerCase();
    if (!CODICON_ID_RE.test(id)) return null;
    const rawColor = (source.color as Record<string, unknown> | undefined)?.id ?? source.color;
    const color = typeof rawColor === 'string' && THEME_COLOR_RE.test(rawColor) ? rawColor : null;
    return { kind: 'theme', id, color };
  }
  const light = clamp(source.light, 1_024);
  const dark = clamp(source.dark, 1_024);
  if (light === null && dark === null) return null;
  return { kind: 'path', light: light ?? (dark as string), dark: dark ?? (light as string) };
}

function normalizeTooltip(raw: unknown): { tooltip: string | null; markdown: boolean } {
  if (typeof raw === 'string')
    return { tooltip: clamp(raw, MAX_TREE_TOOLTIP_CHARS), markdown: false };
  if (raw !== null && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>).value;
    const tooltip = clamp(value, MAX_TREE_TOOLTIP_CHARS);
    if (tooltip !== null) return { tooltip, markdown: true };
  }
  return { tooltip: null, markdown: false };
}

function normalizeCommand(raw: unknown): WireTreeCommand | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!isTreeCommandId(source.command)) return null;
  return {
    command: source.command,
    title: clamp(source.title, MAX_TREE_LABEL_CHARS) ?? source.command,
    arguments: sanitizeCommandArguments(source.arguments),
  };
}

function normalizeCheckbox(raw: unknown): {
  state: TreeCheckboxState | null;
  tooltip: string | null;
} {
  if (raw === 0 || raw === 'unchecked') return { state: 'unchecked', tooltip: null };
  if (raw === 1 || raw === 'checked') return { state: 'checked', tooltip: null };
  if (raw !== null && typeof raw === 'object') {
    const source = raw as Record<string, unknown>;
    const inner = normalizeCheckbox(source.state);
    if (inner.state !== null) {
      return { state: inner.state, tooltip: clamp(source.tooltip, MAX_TREE_TOOLTIP_CHARS) };
    }
  }
  return { state: null, tooltip: null };
}

/** Project one raw item onto the wire. Never throws; a hostile item degrades to an empty row. */
export function normalizeTreeItem(raw: RawTreeItem | unknown, handle: string): WireTreeItem {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as RawTreeItem;
  const { label, highlights } = normalizeLabel(source.label);
  const { tooltip, markdown } = normalizeTooltip(source.tooltip);
  const checkbox = normalizeCheckbox(source.checkboxState);
  const accessibility = (
    source.accessibilityInformation !== null && typeof source.accessibilityInformation === 'object'
      ? source.accessibilityInformation
      : {}
  ) as Record<string, unknown>;
  const resourceUri = clamp(source.resourceUri, 2_048);
  const contextValue = clamp(source.contextValue, MAX_TREE_CONTEXT_VALUE_CHARS);
  return {
    handle,
    id: clamp(source.id, 256),
    // A tree row with neither a label nor a resource is still a row upstream draws, so the label
    // falls back to the resource's own text rather than to a placeholder the extension never wrote.
    label: label.length > 0 ? label : (resourceUri ?? ''),
    highlights,
    description:
      source.description === true ? '' : clamp(source.description, MAX_TREE_DESCRIPTION_CHARS),
    tooltip,
    tooltipIsMarkdown: markdown,
    icon: normalizeIcon(source.iconPath),
    resourceUri,
    contextValue,
    command: normalizeCommand(source.command),
    collapsibleState: normalizeCollapsible(source.collapsibleState),
    checkboxState: checkbox.state,
    checkboxTooltip: checkbox.tooltip,
    accessibilityLabel: clamp(accessibility.label, MAX_TREE_LABEL_CHARS),
    accessibilityRole: clamp(accessibility.role, 64),
  };
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * The handle for one node.
 *
 * A provider-supplied `TreeItem.id` wins, because upstream documents it as unique within the view
 * and extensions that implement `reveal()` rely on it surviving a refresh. Without one, the path
 * of child indices is used: stable as long as the provider returns children in a stable order,
 * which is the same guarantee upstream gives.
 */
export function composeHandle(
  parent: string | null,
  index: number,
  providerId: string | null,
): string {
  if (providerId !== null && providerId.length > 0) {
    const handle = `#${providerId}`;
    return handle.length > MAX_TREE_HANDLE_CHARS ? handle.slice(0, MAX_TREE_HANDLE_CHARS) : handle;
  }
  const handle = parent === null ? `/${index}` : `${parent}/${index}`;
  return handle.length > MAX_TREE_HANDLE_CHARS ? handle.slice(0, MAX_TREE_HANDLE_CHARS) : handle;
}

export interface TreeNode {
  item: WireTreeItem;
  parent: string | null;
  depth: number;
  /** `null` means "not fetched yet", which is not the same as "no children". */
  children: string[] | null;
}

export interface TreeRow {
  handle: string;
  depth: number;
  item: WireTreeItem;
  expandable: boolean;
  expanded: boolean;
  /** Children were asked for and have not arrived. The renderer draws a spinner in the twistie. */
  loading: boolean;
}

export type ExpandOutcome = 'loaded' | 'needs-children' | 'not-expandable' | 'unknown';
export type SetChildrenOutcome = 'ok' | 'unknown-parent' | 'too-deep' | 'full';

/**
 * One view's loaded tree, plus the state the user put it in.
 *
 * Mutable by design: this is the live model Main holds per view and mutates as the provider
 * answers. `version` increments on every structural or state change so the renderer can diff
 * cheaply instead of re-rendering on every provider event.
 */
export class TreeModel {
  private readonly nodes = new Map<string, TreeNode>();
  private rootHandles: string[] | null = null;
  private readonly expandedHandles = new Set<string>();
  private readonly loadingHandles = new Set<string>();
  private selectionHandles: string[] = [];
  private focusHandle: string | null = null;
  private versionValue = 0;

  get version(): number {
    return this.versionValue;
  }

  get size(): number {
    return this.nodes.size;
  }

  get rootsLoaded(): boolean {
    return this.rootHandles !== null;
  }

  get selection(): readonly string[] {
    return this.selectionHandles;
  }

  get focused(): string | null {
    return this.focusHandle;
  }

  node(handle: string): TreeNode | undefined {
    return this.nodes.get(handle);
  }

  isExpanded(handle: string): boolean {
    return this.expandedHandles.has(handle);
  }

  isLoading(handle: string): boolean {
    return this.loadingHandles.has(handle);
  }

  expandedList(): string[] {
    return [...this.expandedHandles];
  }

  /**
   * Install the root children.
   *
   * Replacing the roots is what a full `refresh()` does. Nodes no longer reachable are dropped,
   * but expansion and selection *handles* are kept: a refresh that returns the same tree must not
   * collapse everything the user opened, and a handle that no longer exists is simply inert.
   */
  setRoots(items: readonly WireTreeItem[]): void {
    this.nodes.clear();
    this.loadingHandles.clear();
    this.rootHandles = [];
    for (const item of items.slice(0, MAX_TREE_CHILDREN)) {
      if (this.nodes.has(item.handle)) continue;
      this.nodes.set(item.handle, { item, parent: null, depth: 0, children: null });
      this.rootHandles.push(item.handle);
    }
    this.versionValue += 1;
  }

  /** Install one node's children, which is the answer to an expansion. */
  setChildren(parent: string, items: readonly WireTreeItem[]): SetChildrenOutcome {
    const node = this.nodes.get(parent);
    if (node === undefined) return 'unknown-parent';
    this.loadingHandles.delete(parent);
    if (node.depth + 1 >= MAX_TREE_DEPTH) {
      node.children = [];
      this.versionValue += 1;
      return 'too-deep';
    }
    const capped = items.slice(0, MAX_TREE_CHILDREN);
    if (this.nodes.size + capped.length > MAX_TREE_NODES) {
      node.children = [];
      this.versionValue += 1;
      return 'full';
    }
    const handles: string[] = [];
    for (const item of capped) {
      if (this.nodes.has(item.handle)) continue;
      this.nodes.set(item.handle, {
        item,
        parent,
        depth: node.depth + 1,
        children: null,
      });
      handles.push(item.handle);
    }
    node.children = handles;
    this.versionValue += 1;
    return 'ok';
  }

  /** Replace one item in place — what `resolveTreeItem` and a single-node refresh both do. */
  updateItem(item: WireTreeItem): boolean {
    const node = this.nodes.get(item.handle);
    if (node === undefined) return false;
    node.item = item;
    this.versionValue += 1;
    return true;
  }

  updateCheckbox(handle: string, state: TreeCheckboxState): boolean {
    const node = this.nodes.get(handle);
    if (node === undefined || node.item.checkboxState === null) return false;
    node.item = { ...node.item, checkboxState: state };
    this.versionValue += 1;
    return true;
  }

  /**
   * Drop a subtree's loaded children so the next expansion refetches.
   *
   * `null` invalidates the whole view. This is `onDidChangeTreeData` with and without an element:
   * upstream refetches the affected subtree and keeps everything above it, and so does this.
   */
  invalidate(handle: string | null): boolean {
    if (handle === null) {
      this.nodes.clear();
      this.loadingHandles.clear();
      this.rootHandles = null;
      this.versionValue += 1;
      return true;
    }
    const node = this.nodes.get(handle);
    if (node === undefined) return false;
    this.dropDescendants(handle);
    node.children = null;
    this.loadingHandles.delete(handle);
    this.versionValue += 1;
    return true;
  }

  private dropDescendants(handle: string): void {
    const node = this.nodes.get(handle);
    if (node === undefined || node.children === null) return;
    for (const child of node.children) {
      this.dropDescendants(child);
      this.nodes.delete(child);
      this.loadingHandles.delete(child);
    }
    node.children = null;
  }

  /**
   * Mark a node expanded.
   *
   * `needs-children` is the caller's cue to ask the provider — that is the whole lazy-loading
   * contract. The node is recorded as expanded *before* the children arrive so the twistie turns
   * immediately, which is what upstream does and what makes a slow provider feel responsive.
   */
  expand(handle: string): ExpandOutcome {
    const node = this.nodes.get(handle);
    if (node === undefined) return 'unknown';
    if (node.item.collapsibleState === 'none') return 'not-expandable';
    const already = this.expandedHandles.has(handle);
    this.expandedHandles.add(handle);
    if (!already) this.versionValue += 1;
    if (node.children !== null) return 'loaded';
    this.loadingHandles.add(handle);
    return 'needs-children';
  }

  collapse(handle: string): boolean {
    if (!this.expandedHandles.delete(handle)) return false;
    this.versionValue += 1;
    return true;
  }

  /** Seed expansion from persisted state before the roots load. Handles are hints, not promises. */
  restoreExpanded(handles: readonly string[]): void {
    for (const handle of handles.slice(0, MAX_TREE_NODES)) {
      if (typeof handle === 'string' && handle.length > 0) this.expandedHandles.add(handle);
    }
  }

  setSelection(handles: readonly string[]): void {
    const next: string[] = [];
    for (const handle of handles.slice(0, MAX_TREE_SELECTION)) {
      if (this.nodes.has(handle) && !next.includes(handle)) next.push(handle);
    }
    this.selectionHandles = next;
    if (next.length > 0) this.focusHandle = next[next.length - 1] ?? null;
    this.versionValue += 1;
  }

  setFocus(handle: string | null): void {
    this.focusHandle = handle !== null && this.nodes.has(handle) ? handle : null;
    this.versionValue += 1;
  }

  /** Every ancestor of a node, root first — the chain `reveal()` has to expand. */
  ancestorsOf(handle: string): string[] {
    const chain: string[] = [];
    let cursor = this.nodes.get(handle)?.parent ?? null;
    let guard = 0;
    while (cursor !== null && guard < MAX_TREE_DEPTH) {
      chain.unshift(cursor);
      cursor = this.nodes.get(cursor)?.parent ?? null;
      guard += 1;
    }
    return chain;
  }

  /**
   * The rows the user could scroll to, in order.
   *
   * One pass, no allocation per node beyond the row itself. A collapsed node contributes one row
   * and stops the walk, which is why a 10,000-node tree with everything closed flattens to the
   * length of its root list.
   */
  flattenVisible(): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (handles: readonly string[], depth: number): void => {
      for (const handle of handles) {
        const node = this.nodes.get(handle);
        if (node === undefined) continue;
        const expandable = node.item.collapsibleState !== 'none';
        const expanded = expandable && this.expandedHandles.has(handle);
        rows.push({
          handle,
          depth,
          item: node.item,
          expandable,
          expanded,
          loading: this.loadingHandles.has(handle),
        });
        if (expanded && node.children !== null && depth + 1 < MAX_TREE_DEPTH) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(this.rootHandles ?? [], 0);
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Virtualisation and keyboard navigation (§12, §13)
// ---------------------------------------------------------------------------

export interface TreeWindow {
  start: number;
  end: number;
  /** Pixels of empty space above the first mounted row, so the scrollbar stays honest. */
  topPadding: number;
  totalHeight: number;
}

/**
 * Which slice of the flattened list the viewport covers.
 *
 * Fixed row height, because every row in a VS Code tree is the same height and the arithmetic is
 * then exact — no measurement pass, no layout thrash. `overscan` rows above and below are mounted
 * so a fast scroll does not show blank space.
 */
export function visibleWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = DEFAULT_ROW_HEIGHT,
  overscan = 8,
): TreeWindow {
  const height = Math.max(1, rowHeight);
  const totalHeight = total * height;
  if (total <= 0) return { start: 0, end: 0, topPadding: 0, totalHeight: 0 };
  const top = Math.max(0, Math.min(scrollTop, totalHeight));
  const firstVisible = Math.floor(top / height);
  const rowsInView = Math.ceil(Math.max(0, viewportHeight) / height) + 1;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + rowsInView + overscan);
  return { start, end, topPadding: start * height, totalHeight };
}

export type TreeKeyAction =
  | { kind: 'focus'; handle: string }
  | { kind: 'expand'; handle: string }
  | { kind: 'collapse'; handle: string }
  | { kind: 'activate'; handle: string }
  | { kind: 'toggle-checkbox'; handle: string }
  | { kind: 'none' };

/**
 * Keyboard behaviour, as a pure function of the visible rows.
 *
 * Upstream's tree bindings: arrows move and open, Right on an expanded node steps into the first
 * child, Left on a leaf steps out to the parent, Home/End jump, Enter runs the item's command and
 * Space toggles a checkbox. Keeping this out of the component means the validator can exercise it.
 */
export function treeKeyAction(
  rows: readonly TreeRow[],
  focused: string | null,
  key: string,
): TreeKeyAction {
  if (rows.length === 0) return { kind: 'none' };
  const index = focused === null ? -1 : rows.findIndex((row) => row.handle === focused);
  const current = index >= 0 ? rows[index] : undefined;
  const at = (position: number): TreeKeyAction => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, position))];
    return row === undefined ? { kind: 'none' } : { kind: 'focus', handle: row.handle };
  };
  switch (key) {
    case 'ArrowDown':
      return at(index + 1);
    case 'ArrowUp':
      return index <= 0 ? at(0) : at(index - 1);
    case 'Home':
      return at(0);
    case 'End':
      return at(rows.length - 1);
    case 'PageDown':
      return at(index + 10);
    case 'PageUp':
      return at(Math.max(0, index - 10));
    case 'ArrowRight':
      if (current === undefined) return at(0);
      if (current.expandable && !current.expanded)
        return { kind: 'expand', handle: current.handle };
      return at(index + 1);
    case 'ArrowLeft': {
      if (current === undefined) return at(0);
      if (current.expandable && current.expanded)
        return { kind: 'collapse', handle: current.handle };
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = rows[cursor];
        if (candidate !== undefined && candidate.depth < current.depth) {
          return { kind: 'focus', handle: candidate.handle };
        }
      }
      return { kind: 'none' };
    }
    case 'Enter':
      return current === undefined
        ? { kind: 'none' }
        : { kind: 'activate', handle: current.handle };
    case ' ':
    case 'Spacebar':
      if (current === undefined) return { kind: 'none' };
      return current.item.checkboxState !== null
        ? { kind: 'toggle-checkbox', handle: current.handle }
        : { kind: 'activate', handle: current.handle };
    default:
      return { kind: 'none' };
  }
}

/**
 * The label a screen reader reads for one row.
 *
 * `accessibilityInformation.label` wins when the extension supplied one; otherwise the label plus
 * the description, which is what a sighted user sees. Position and expansion state are announced
 * because a tree row without them is unnavigable by ear.
 */
export function treeRowAriaLabel(row: TreeRow, position: number, total: number): string {
  const base =
    row.item.accessibilityLabel ??
    [row.item.label, row.item.description]
      .filter((part) => part !== null && part !== '')
      .join(', ');
  const parts = [base, `${position} of ${total}`];
  if (row.expandable) parts.push(row.expanded ? 'expanded' : 'collapsed');
  if (row.item.checkboxState !== null) {
    parts.push(row.item.checkboxState === 'checked' ? 'checked' : 'not checked');
  }
  return parts.join(', ');
}
