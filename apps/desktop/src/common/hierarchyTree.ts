/**
 * Lazy hierarchy tree model (PRD Phase 7 — Type Hierarchy UI, call hierarchy callees).
 *
 * PURE module: no React, no Monaco, no I/O. It holds the shape of a hierarchy the user is exploring
 * and answers the four questions the panel asks — what rows are visible, which node can be expanded,
 * where a fetched level attaches, and where the traversal must stop.
 *
 * A hierarchy is lazy by nature: `prepareTypeHierarchy` gives one item, and every level after it
 * costs a provider round trip, so the tree cannot be computed up front. That makes the model a state
 * machine per node (`collapsed → loading → expanded | leaf | error`) rather than a data structure,
 * and it is the state machine — not the fetching — that decides whether the panel is correct. So it
 * lives here, where the validators drive it directly with no provider in the loop.
 *
 * Two things upstream gets right and a naive tree gets wrong:
 *
 * - recursion terminates. `class A extends B`, `class B extends A` is invalid in most languages but
 *   perfectly expressible by a provider, and a mutually recursive call graph is ordinary. A node that
 *   repeats one of its own ancestors is marked `recursive` and refuses to expand, so the panel shows
 *   the cycle instead of unrolling it forever;
 * - identity is positional, not nominal. Two `render` methods in different files are different nodes;
 *   the same symbol reached down two different paths expands independently, because the user is
 *   exploring a path, not a set.
 */

import type { LspRange } from './ipc';
import type { WireHierarchyItem } from './vscodeLanguageWire';

/** Which way the traversal runs. The value is also the provider op that fetches it. */
export type HierarchyDirection = 'incoming' | 'outgoing' | 'supertypes' | 'subtypes';

/** Which provider answers. */
export type HierarchyKind = 'call' | 'type';

/** Levels the tree will hold. Deeper than this and a cycle no identity check caught is likelier. */
export const MAX_HIERARCHY_DEPTH = 16;
/** Children accepted for one node. */
export const MAX_HIERARCHY_CHILDREN = 200;
/** Nodes the whole tree will hold, across every expanded branch. */
export const MAX_HIERARCHY_NODES = 2_000;

/** One edge as the provider reported it: the item, plus where the parent referenced it. */
export interface HierarchyEdge {
  item: WireHierarchyItem;
  /** Call hierarchy only: the ranges in the parent that make this edge. Empty for a type. */
  fromRanges: LspRange[];
}

export type HierarchyNodeState = 'collapsed' | 'loading' | 'expanded' | 'leaf' | 'error';

export interface HierarchyNode {
  /** Stable for the life of the node, and unique even when the same symbol appears twice. */
  key: string;
  item: WireHierarchyItem;
  fromRanges: LspRange[];
  depth: number;
  parent: string | null;
  /** Child keys in provider order. Null until a level has been fetched. */
  children: string[] | null;
  state: HierarchyNodeState;
  /** Set only in the `error` state; the panel shows it on the row. */
  error?: string;
  /** This node repeats an ancestor. It renders, and it does not expand. */
  recursive: boolean;
  /** The provider returned more children than the model keeps. */
  truncated: boolean;
}

export interface HierarchyTree {
  kind: HierarchyKind;
  direction: HierarchyDirection;
  /** Root keys, in provider order. */
  roots: string[];
  nodes: ReadonlyMap<string, HierarchyNode>;
  /** Monotonic key source. Carried on the tree so keys stay unique across every level fetched. */
  seq: number;
  /** A level was refused because the tree is at `MAX_HIERARCHY_NODES`. */
  capped: boolean;
}

/** The directions a hierarchy of this kind can be explored in, in the order the panel offers them. */
export function hierarchyDirections(kind: HierarchyKind): readonly HierarchyDirection[] {
  return kind === 'call'
    ? (['incoming', 'outgoing'] as const)
    : (['supertypes', 'subtypes'] as const);
}

/** The language feature that answers this kind. */
export function hierarchyFeature(kind: HierarchyKind): 'callHierarchy' | 'typeHierarchy' {
  return kind === 'call' ? 'callHierarchy' : 'typeHierarchy';
}

/** What the direction toggle reads. */
export function hierarchyDirectionLabel(direction: HierarchyDirection): string {
  switch (direction) {
    case 'incoming':
      return 'Callers';
    case 'outgoing':
      return 'Calls';
    case 'supertypes':
      return 'Supertypes';
    case 'subtypes':
      return 'Subtypes';
  }
}

/**
 * A node's identity for cycle detection.
 *
 * File plus the start of the selection range plus the name: the position pins the declaration, and
 * the name keeps two symbols declared at the same position (which a provider can report, wrongly)
 * distinct rather than collapsing them. Case is folded on the uri because the same file arrives with
 * a different drive-letter case depending on which provider produced it.
 */
export function hierarchyIdentity(item: WireHierarchyItem): string {
  const start = item.selectionRange.start;
  return `${item.uri.toLowerCase()}|${start.line}:${start.character}|${item.name}`;
}

function makeNode(
  key: string,
  edge: HierarchyEdge,
  depth: number,
  parent: string | null,
  recursive: boolean,
): HierarchyNode {
  return {
    key,
    item: edge.item,
    fromRanges: edge.fromRanges,
    depth,
    parent,
    children: null,
    state: recursive || depth >= MAX_HIERARCHY_DEPTH ? 'leaf' : 'collapsed',
    recursive,
    truncated: false,
  };
}

/** Start a tree from what `prepare` returned. Roots are collapsed; nothing has been fetched yet. */
export function createHierarchyTree(
  kind: HierarchyKind,
  direction: HierarchyDirection,
  items: readonly HierarchyEdge[],
): HierarchyTree {
  const nodes = new Map<string, HierarchyNode>();
  const roots: string[] = [];
  let seq = 0;
  for (const edge of items.slice(0, MAX_HIERARCHY_CHILDREN)) {
    seq += 1;
    const key = `h${seq}`;
    nodes.set(key, makeNode(key, edge, 0, null, false));
    roots.push(key);
  }
  return { kind, direction, roots, nodes, seq, capped: false };
}

/** The ancestors of `key`, nearest first. */
export function hierarchyAncestors(tree: HierarchyTree, key: string): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  let current = tree.nodes.get(key)?.parent ?? null;
  let guard = 0;
  while (current !== null && guard < MAX_HIERARCHY_DEPTH + 1) {
    const node = tree.nodes.get(current);
    if (node === undefined) break;
    out.push(node);
    current = node.parent;
    guard += 1;
  }
  return out;
}

/** Can the user open this row? A loaded, empty, recursive or too-deep node cannot. */
export function canExpandHierarchyNode(node: HierarchyNode): boolean {
  if (node.recursive) return false;
  if (node.depth >= MAX_HIERARCHY_DEPTH) return false;
  return node.state === 'collapsed' || (node.state === 'error' && node.children === null);
}

function replace(tree: HierarchyTree, node: HierarchyNode): HierarchyTree {
  const nodes = new Map(tree.nodes);
  nodes.set(node.key, node);
  return { ...tree, nodes };
}

/**
 * The node without its error message.
 *
 * Spelled out field by field rather than spread-and-overwrite because `exactOptionalPropertyTypes`
 * refuses `error: undefined` for an optional `error?: string`, and a stale message left on a node
 * that has since loaded would render under a row that succeeded.
 */
function withoutError(node: HierarchyNode): Omit<HierarchyNode, 'error'> {
  return {
    key: node.key,
    item: node.item,
    fromRanges: node.fromRanges,
    depth: node.depth,
    parent: node.parent,
    children: node.children,
    state: node.state,
    recursive: node.recursive,
    truncated: node.truncated,
  };
}

/** Mark a node as fetching. The panel shows a spinner; a second click is ignored by `canExpand`. */
export function setHierarchyNodeLoading(tree: HierarchyTree, key: string): HierarchyTree {
  const node = tree.nodes.get(key);
  if (node === undefined) return tree;
  return replace(tree, { ...withoutError(node), state: 'loading' });
}

/**
 * Attach a fetched level.
 *
 * An empty level is a leaf, not an error: "nothing calls this" is the answer for most entry points,
 * and upstream shows it as a node that simply does not open.
 */
export function setHierarchyNodeChildren(
  tree: HierarchyTree,
  key: string,
  edges: readonly HierarchyEdge[],
): HierarchyTree {
  const node = tree.nodes.get(key);
  if (node === undefined) return tree;
  const nodes = new Map(tree.nodes);
  const ancestry = new Set<string>([
    hierarchyIdentity(node.item),
    ...hierarchyAncestors(tree, key).map((entry) => hierarchyIdentity(entry.item)),
  ]);
  const accepted = edges.slice(0, MAX_HIERARCHY_CHILDREN);
  const children: string[] = [];
  let seq = tree.seq;
  let capped = tree.capped;
  for (const edge of accepted) {
    if (nodes.size >= MAX_HIERARCHY_NODES) {
      capped = true;
      break;
    }
    seq += 1;
    const childKey = `h${seq}`;
    const recursive = ancestry.has(hierarchyIdentity(edge.item));
    nodes.set(childKey, makeNode(childKey, edge, node.depth + 1, key, recursive));
    children.push(childKey);
  }
  nodes.set(key, {
    ...withoutError(node),
    children,
    state: children.length === 0 ? 'leaf' : 'expanded',
    truncated: edges.length > accepted.length || capped !== tree.capped,
  });
  return { ...tree, nodes, seq, capped };
}

/** A level that could not be fetched. The row stays openable so the user can retry. */
export function setHierarchyNodeError(
  tree: HierarchyTree,
  key: string,
  message: string,
): HierarchyTree {
  const node = tree.nodes.get(key);
  if (node === undefined) return tree;
  return replace(tree, { ...node, state: 'error', error: message, children: null });
}

/** Close a node. Children are kept, so reopening costs nothing. */
export function collapseHierarchyNode(tree: HierarchyTree, key: string): HierarchyTree {
  const node = tree.nodes.get(key);
  if (node === undefined || node.state !== 'expanded') return tree;
  return replace(tree, { ...node, state: 'collapsed' });
}

/** Reopen a node whose children were already fetched, without a provider call. */
export function expandLoadedHierarchyNode(tree: HierarchyTree, key: string): HierarchyTree {
  const node = tree.nodes.get(key);
  if (node === undefined || node.children === null || node.children.length === 0) return tree;
  if (node.state === 'expanded') return tree;
  return replace(tree, { ...node, state: 'expanded' });
}

/**
 * The rows to render, parents before children, in provider order.
 *
 * Depth-first with an explicit stack rather than recursion: the tree is user-driven and bounded, but
 * a provider that reported a parent as its own child would otherwise recurse the renderer's stack,
 * and `visited` makes that impossible regardless of what the model holds.
 */
export function visibleHierarchyRows(tree: HierarchyTree): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  const visited = new Set<string>();
  const stack = [...tree.roots].reverse();
  while (stack.length > 0 && out.length < MAX_HIERARCHY_NODES) {
    const key = stack.pop();
    if (key === undefined || visited.has(key)) continue;
    visited.add(key);
    const node = tree.nodes.get(key);
    if (node === undefined) continue;
    out.push(node);
    if (node.state !== 'expanded' || node.children === null) continue;
    for (const child of [...node.children].reverse()) stack.push(child);
  }
  return out;
}

/**
 * Swap direction.
 *
 * Everything fetched under the old direction is discarded: it answered a different question, and a
 * callers subtree left hanging under a "calls" toggle would be a lie about the code.
 */
export function switchHierarchyDirection(
  tree: HierarchyTree,
  direction: HierarchyDirection,
): HierarchyTree {
  if (direction === tree.direction) return tree;
  const nodes = new Map<string, HierarchyNode>();
  for (const key of tree.roots) {
    const node = tree.nodes.get(key);
    if (node === undefined) continue;
    nodes.set(key, {
      ...withoutError(node),
      children: null,
      state: node.recursive || node.depth >= MAX_HIERARCHY_DEPTH ? 'leaf' : 'collapsed',
      truncated: false,
    });
  }
  return { ...tree, direction, nodes, capped: false };
}
