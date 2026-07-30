/**
 * Dependency-injection container / service registry (Phase 8 — DI Container).
 *
 * PURE module (no I/O, no Electron). A small, typed service container: register
 * factories with declared dependencies, then `resolve` a service — its deps are
 * constructed first (topological), singletons are cached, and `dispose` tears
 * everything down in REVERSE construction order. It is cycle-safe: a dependency
 * cycle is detected (with the offending path) rather than overflowing the stack,
 * and `validate` statically checks the whole graph (missing deps + cycles) WITHOUT
 * constructing anything — so the Main process can verify its service wiring at
 * startup.
 *
 * The graph algorithms (missing-dep scan, cycle find, resolution order) are pure
 * functions, reusable + unit-testable on their own.
 */

/** A dependency graph: service id → the ids it depends on. */
export type DepGraph = Record<string, readonly string[]>;

export interface MissingDep {
  id: string;
  dep: string;
}

/** Dependencies referenced by a node but not registered in the graph. */
export function findMissingDeps(graph: DepGraph): MissingDep[] {
  const out: MissingDep[] = [];
  for (const id of Object.keys(graph)) {
    for (const dep of graph[id] ?? []) {
      if (!(dep in graph)) out.push({ id, dep });
    }
  }
  return out;
}

/**
 * Find one dependency cycle (as an ordered path a → b → … → a), or null when the
 * graph is acyclic. Deterministic: nodes + edges are visited in insertion order.
 */
export function findCycle(graph: DepGraph): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of graph[id] ?? []) {
      if (!(dep in graph)) continue; // missing deps handled separately
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        // Back-edge → cycle. Return the path from `dep` to here + back to `dep`.
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of Object.keys(graph)) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export interface ResolutionResult {
  /** Topological order (deps before dependents), or null when a cycle exists. */
  order: string[] | null;
  cycle: string[] | null;
}

/**
 * Compute a construction order for the whole graph (deps first). Returns a cycle
 * instead of an order when one exists. Ignores missing deps (they can't be ordered;
 * use findMissingDeps to catch them).
 */
export function resolutionOrder(graph: DepGraph): ResolutionResult {
  const cycle = findCycle(graph);
  if (cycle) return { order: null, cycle };
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    for (const dep of graph[id] ?? []) {
      if (dep in graph) visit(dep);
    }
    done.add(id);
    order.push(id);
  };
  for (const id of Object.keys(graph)) visit(id);
  return { order, cycle: null };
}

export interface ValidationReport {
  ok: boolean;
  missing: MissingDep[];
  cycle: string[] | null;
  /** Construction order when valid, else []. */
  order: string[];
  summary: string;
}

/** Static validation of a dependency graph — missing deps + cycles, no construction. */
export function validateGraph(graph: DepGraph): ValidationReport {
  const missing = findMissingDeps(graph);
  const { order, cycle } = resolutionOrder(graph);
  const ok = missing.length === 0 && cycle === null;
  const summary = ok
    ? `${Object.keys(graph).length} services wired OK.`
    : cycle !== null
      ? `Dependency cycle: ${cycle.join(' \u2192 ')}.`
      : `${missing.length} missing dependency(ies): ${missing
          .map((m) => `${m.id}\u2192${m.dep}`)
          .join(', ')}.`;
  return { ok, missing, cycle, order: order ?? [], summary };
}

// ---- the container ----------------------------------------------------------

export interface RegisterOptions<T> {
  /** Ids this service depends on (constructed + injected first). */
  deps?: readonly string[];
  /** Cache a single instance (default true). When false, a new instance per resolve. */
  singleton?: boolean;
  /** Teardown hook, called on dispose in reverse construction order. */
  dispose?: (instance: T) => void;
}

interface Registration {
  id: string;
  deps: readonly string[];
  factory: (deps: Record<string, unknown>) => unknown;
  singleton: boolean;
  dispose?: (instance: unknown) => void;
}

/** A typed DI container. */
export class ServiceRegistry {
  private readonly defs = new Map<string, Registration>();
  private readonly instances = new Map<string, unknown>();
  /** Ids in the order their singletons were constructed (for reverse dispose). */
  private readonly built: string[] = [];

  /** Register a service factory. Re-registering an id replaces its definition. */
  register<T>(
    id: string,
    factory: (deps: Record<string, unknown>) => T,
    options: RegisterOptions<T> = {},
  ): this {
    this.defs.set(id, {
      id,
      deps: options.deps ?? [],
      factory: factory as (deps: Record<string, unknown>) => unknown,
      singleton: options.singleton !== false,
      ...(options.dispose ? { dispose: options.dispose as (i: unknown) => void } : {}),
    });
    return this;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  ids(): string[] {
    return [...this.defs.keys()];
  }

  /** The registry's dependency graph (for validation / diagnostics). */
  graph(): DepGraph {
    const g: Record<string, readonly string[]> = {};
    for (const [id, def] of this.defs) g[id] = def.deps;
    return g;
  }

  /** Static validation of the registered graph (missing deps + cycles). */
  validate(): ValidationReport {
    return validateGraph(this.graph());
  }

  /** Resolve a service, constructing (and caching, if singleton) its dep tree. */
  resolve<T>(id: string): T {
    return this.resolveWith<T>(id, []);
  }

  private resolveWith<T>(id: string, stack: string[]): T {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Service "${id}" is not registered.`);
    if (stack.includes(id)) {
      throw new Error(`Dependency cycle: ${[...stack, id].join(' \u2192 ')}.`);
    }
    if (def.singleton && this.instances.has(id)) {
      return this.instances.get(id) as T;
    }
    const nextStack = [...stack, id];
    const resolvedDeps: Record<string, unknown> = {};
    for (const dep of def.deps) {
      resolvedDeps[dep] = this.resolveWith(dep, nextStack);
    }
    const instance = def.factory(resolvedDeps);
    if (def.singleton) {
      this.instances.set(id, instance);
      this.built.push(id);
    }
    return instance as T;
  }

  /** True when a singleton instance has already been constructed. */
  isConstructed(id: string): boolean {
    return this.instances.has(id);
  }

  /** Dispose all constructed singletons in reverse construction order, then clear. */
  dispose(): void {
    for (let i = this.built.length - 1; i >= 0; i--) {
      const id = this.built[i]!;
      const def = this.defs.get(id);
      const instance = this.instances.get(id);
      if (def?.dispose && instance !== undefined) {
        try {
          def.dispose(instance);
        } catch {
          /* teardown is best-effort */
        }
      }
    }
    this.built.length = 0;
    this.instances.clear();
  }
}
