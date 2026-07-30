/**
 * Knowledge graph construction (Phase 65 — Knowledge Graph Construction).
 *
 * PURE module (no I/O, no Electron). A repo-wide relationship model: NODES
 * (files / symbols / modules / packages) connected by typed EDGES (imports / calls /
 * extends / refs). Builds a de-duplicated, dangling-edge-safe graph from raw node +
 * edge lists (the per-language extractors in the Rust Core feed these), answers
 * neighbourhood / caller / root / orphan / cycle queries, and supports INCREMENTAL
 * updates so a re-index of a few files doesn't rebuild the whole graph. Serializable
 * (plain arrays) so it can cross IPC. Deterministic.
 */

export type NodeKind = 'file' | 'symbol' | 'module' | 'package';
export type EdgeKind = 'imports' | 'calls' | 'extends' | 'refs';
export type Direction = 'out' | 'in' | 'both';

export interface KnowledgeNode {
  id: string;
  kind: NodeKind;
  name: string;
  path?: string;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export interface GraphUpdate {
  addNodes?: KnowledgeNode[];
  addEdges?: KnowledgeEdge[];
  /** Node ids to remove (their incident edges are removed too). */
  removeNodes?: string[];
}

function edgeKey(e: KnowledgeEdge): string {
  return `${e.from}\u0000${e.to}\u0000${e.kind}`;
}

/**
 * Build a knowledge graph: nodes are de-duplicated by id (last wins), and edges are
 * de-duplicated and kept only when BOTH endpoints resolve to a known node (dangling
 * edges from a partial index are dropped, not thrown).
 */
export function buildKnowledgeGraph(
  nodes: readonly KnowledgeNode[],
  edges: readonly KnowledgeEdge[],
): KnowledgeGraph {
  const byId = new Map<string, KnowledgeNode>();
  for (const n of nodes) byId.set(n.id, n);
  const seen = new Set<string>();
  const keptEdges: KnowledgeEdge[] = [];
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    keptEdges.push(e);
  }
  return { nodes: [...byId.values()], edges: keptEdges };
}

/** Connected node ids in the given direction, optionally filtered by edge kind. */
export function neighbors(
  graph: KnowledgeGraph,
  id: string,
  direction: Direction = 'out',
  kind?: EdgeKind,
): string[] {
  const out = new Set<string>();
  for (const e of graph.edges) {
    if (kind && e.kind !== kind) continue;
    if ((direction === 'out' || direction === 'both') && e.from === id) out.add(e.to);
    if ((direction === 'in' || direction === 'both') && e.to === id) out.add(e.from);
  }
  return [...out];
}

/** Nodes that call `id` (incoming 'calls' edges). */
export function callersOf(graph: KnowledgeGraph, id: string): string[] {
  return neighbors(graph, id, 'in', 'calls');
}

/** Nodes that `id` calls (outgoing 'calls' edges). */
export function calleesOf(graph: KnowledgeGraph, id: string): string[] {
  return neighbors(graph, id, 'out', 'calls');
}

/** Nodes with no incoming edges (entry points / top of the graph). */
export function roots(graph: KnowledgeGraph): string[] {
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  return graph.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
}

/** Nodes with no edges at all (unreferenced / dead). */
export function orphans(graph: KnowledgeGraph): string[] {
  const connected = new Set<string>();
  for (const e of graph.edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  return graph.nodes.filter((n) => !connected.has(n.id)).map((n) => n.id);
}

/**
 * Detect directed cycles (each returned as a node-id path whose last node links back
 * to the first). Uses DFS with a recursion stack; deterministic in input order.
 */
export function detectCycles(graph: KnowledgeGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) adj.get(e.from)?.push(e.to);

  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const st = state.get(next) ?? 0;
      if (st === 0) visit(next);
      else if (st === 1) {
        const start = stack.indexOf(next);
        if (start >= 0) {
          const cycle = stack.slice(start);
          const canon = [...cycle].sort().join('\u0000');
          if (!seenCycle.has(canon)) {
            seenCycle.add(canon);
            cycles.push(cycle);
          }
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const n of graph.nodes) if ((state.get(n.id) ?? 0) === 0) visit(n.id);
  return cycles;
}

/** Apply an incremental update (add/remove) and return a new, rebuilt graph. */
export function applyUpdate(graph: KnowledgeGraph, update: GraphUpdate): KnowledgeGraph {
  const remove = new Set(update.removeNodes ?? []);
  const nodes = graph.nodes.filter((n) => !remove.has(n.id)).concat(update.addNodes ?? []);
  const edges = graph.edges
    .filter((e) => !remove.has(e.from) && !remove.has(e.to))
    .concat(update.addEdges ?? []);
  return buildKnowledgeGraph(nodes, edges);
}

/** Build a direction-aware adjacency map, optionally filtered by edge kind. */
function adjacency(
  graph: KnowledgeGraph,
  direction: Direction,
  kind?: EdgeKind,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    if (kind && e.kind !== kind) continue;
    if (direction === 'out' || direction === 'both') adj.get(e.from)?.push(e.to);
    if (direction === 'in' || direction === 'both') adj.get(e.to)?.push(e.from);
  }
  return adj;
}

/** Breadth-first transitive closure from `id` in the given direction (excludes `id`). */
function traverse(
  graph: KnowledgeGraph,
  id: string,
  direction: Direction,
  kind?: EdgeKind,
): string[] {
  if (!graph.nodes.some((n) => n.id === id)) return [];
  const adj = adjacency(graph, direction, kind);
  const seen = new Set<string>([id]);
  const order: string[] = [];
  const queue: string[] = [id];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(next);
    }
  }
  return order;
}

/** All nodes transitively reachable FROM `id` (follows out-edges). Excludes `id`. */
export function reachableFrom(graph: KnowledgeGraph, id: string, kind?: EdgeKind): string[] {
  return traverse(graph, id, 'out', kind);
}

/**
 * Transitive IMPACT (blast radius) of `id`: every node that transitively depends on
 * it (follows in-edges). Excludes `id`. This is the graph-level "what breaks if this
 * changes" set.
 */
export function transitiveImpact(graph: KnowledgeGraph, id: string, kind?: EdgeKind): string[] {
  return traverse(graph, id, 'in', kind);
}

/**
 * Shortest directed path from `from` to `to` (inclusive of both), or null if
 * unreachable. BFS over out-edges; deterministic in input order.
 */
export function shortestPath(
  graph: KnowledgeGraph,
  from: string,
  to: string,
  kind?: EdgeKind,
): string[] | null {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return null;
  if (from === to) return [from];
  const adj = adjacency(graph, 'out', kind);
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        let step = to;
        while (step !== from) {
          step = prev.get(step) as string;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export interface GraphSummary {
  nodes: number;
  edges: number;
  byNodeKind: Record<NodeKind, number>;
  byEdgeKind: Record<EdgeKind, number>;
  roots: number;
  orphans: number;
  cycles: number;
  summary: string;
}

/** A compact structural summary of the graph. */
export function summarizeGraph(graph: KnowledgeGraph): GraphSummary {
  const byNodeKind: Record<NodeKind, number> = { file: 0, symbol: 0, module: 0, package: 0 };
  for (const n of graph.nodes) byNodeKind[n.kind] += 1;
  const byEdgeKind: Record<EdgeKind, number> = { imports: 0, calls: 0, extends: 0, refs: 0 };
  for (const e of graph.edges) byEdgeKind[e.kind] += 1;
  const rootCount = roots(graph).length;
  const orphanCount = orphans(graph).length;
  const cycleCount = detectCycles(graph).length;
  const summary =
    graph.nodes.length === 0
      ? 'Empty knowledge graph.'
      : `${graph.nodes.length} nodes, ${graph.edges.length} edges \u00B7 ${rootCount} root(s), ${orphanCount} orphan(s)` +
        (cycleCount > 0 ? `, ${cycleCount} cycle(s)` : '') +
        '.';
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    byNodeKind,
    byEdgeKind,
    roots: rootCount,
    orphans: orphanCount,
    cycles: cycleCount,
    summary,
  };
}
