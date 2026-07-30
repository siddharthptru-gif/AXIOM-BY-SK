/**
 * Extension dependency resolution and activation ordering (PRD Ch. 42).
 *
 * Two fields with similar shapes and opposite semantics live here.
 * `extensionDependencies` is a hard, transitive runtime edge: the dependency must be
 * installed, enabled, and *fully activated* before the dependent's `activate()` runs,
 * because the dependent will call `getExtension(dep).exports` and a half-initialized
 * dependency yields `undefined` and a confusing stack far from the real cause.
 * `extensionPack` is only a bundle — members install together and then live independent
 * lives — and it expands exactly once, at the root, so installing a pack that lists
 * another pack does not pull in the whole transitive world.
 *
 * Cycles are tolerated rather than rejected (42.4): real published extensions contain
 * them and upstream ships anyway, so a cycle is logged, broken at the back edge, and the
 * remaining order is used. Failing the install instead would make Axiom the odd one out.
 *
 * Pure: no I/O, no gallery access. Callers pass a resolved catalog in.
 */

/** 42.4: a chain longer than this is treated as a cycle rather than walked. */
export const MAX_DEPENDENCY_DEPTH = 32;

export interface DependencyCandidate {
  id: string;
  /**
   * The version chosen by the Ch. 43 selection policy, or null when nothing in the
   * registry satisfies the engine/platform/blocklist filters for this editor build.
   */
  version: string | null;
  extensionDependencies?: readonly string[];
  extensionPack?: readonly string[];
}

export type DependencyFailureCode = 'E_DEP_NOT_FOUND' | 'E_DEP_INCOMPATIBLE';

export interface DependencyFailure {
  code: DependencyFailureCode;
  id: string;
  /** The extension that asked for it, or null when it is the root request. */
  requestedBy: string | null;
}

export interface InstallGraphResult {
  /** Install order: dependencies before dependents. */
  order: string[];
  /** id → version to install. */
  versions: Record<string, string>;
  /** Cycles found, each as the ids on the cycle in discovery order. */
  cycles: string[][];
  /** Non-fatal problems worth showing (self-dependency, depth cap). */
  warnings: string[];
  /** Fatal problems; a non-empty list means the install must not proceed. */
  failures: DependencyFailure[];
  /** Pack members pulled in, so the UI can distinguish them from real dependencies. */
  packMembers: string[];
}

function normalizeId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

/**
 * Resolve the install closure for one requested extension (42.2).
 *
 * The catalog is keyed by lower-cased id, as marketplace ids are case-insensitive; the
 * caller supplies it from the gallery query or the local index. A missing entry is
 * `E_DEP_NOT_FOUND`, a present entry with no usable version is `E_DEP_INCOMPATIBLE`, and
 * both name the extension that asked, because "some dependency failed" is unactionable.
 */
export function resolveInstallGraph(
  requested: string,
  catalog: ReadonlyMap<string, DependencyCandidate>,
): InstallGraphResult {
  const rootId = normalizeId(requested);
  const result: InstallGraphResult = {
    order: [],
    versions: {},
    cycles: [],
    warnings: [],
    failures: [],
    packMembers: [],
  };
  if (rootId.length === 0) {
    result.failures.push({ code: 'E_DEP_NOT_FOUND', id: String(requested), requestedBy: null });
    return result;
  }

  const dependencies = new Map<string, string[]>();
  const frontier: Array<{ id: string; requestedBy: string | null; depth: number }> = [
    { id: rootId, requestedBy: null, depth: 0 },
  ];
  const seen = new Set<string>();

  while (frontier.length > 0) {
    const item = frontier.pop() as { id: string; requestedBy: string | null; depth: number };
    if (seen.has(item.id)) continue;
    if (item.depth > MAX_DEPENDENCY_DEPTH) {
      result.warnings.push(
        `Dependency chain deeper than ${MAX_DEPENDENCY_DEPTH} at ${item.id}; treated as a cycle and not expanded.`,
      );
      continue;
    }
    seen.add(item.id);
    const meta = catalog.get(item.id);
    if (meta === undefined) {
      result.failures.push({ code: 'E_DEP_NOT_FOUND', id: item.id, requestedBy: item.requestedBy });
      continue;
    }
    if (meta.version === null || meta.version === undefined) {
      result.failures.push({
        code: 'E_DEP_INCOMPATIBLE',
        id: item.id,
        requestedBy: item.requestedBy,
      });
      continue;
    }
    result.versions[item.id] = meta.version;
    const deps: string[] = [];
    for (const raw of meta.extensionDependencies ?? []) {
      const dep = normalizeId(raw);
      if (dep.length === 0) continue;
      if (dep === item.id) {
        result.warnings.push(`${item.id} declares itself as a dependency; ignored.`);
        continue;
      }
      if (!deps.includes(dep)) deps.push(dep);
      frontier.push({ id: dep, requestedBy: item.id, depth: item.depth + 1 });
    }
    dependencies.set(item.id, deps);
    // Packs expand only at the root: a pack member's own pack list is not followed.
    if (item.id === rootId) {
      for (const raw of meta.extensionPack ?? []) {
        const member = normalizeId(raw);
        if (member.length === 0 || member === rootId) continue;
        if (!result.packMembers.includes(member)) result.packMembers.push(member);
        frontier.push({ id: member, requestedBy: item.id, depth: item.depth + 1 });
      }
    }
  }

  const ordering = topologicalOrder(dependencies);
  result.order = ordering.order.filter((id) => result.versions[id] !== undefined);
  result.cycles = ordering.cycles;
  return result;
}
export interface TopologicalResult {
  /** Post-order: every node appears after the dependencies it could reach. */
  order: string[];
  cycles: string[][];
}

/**
 * Post-order DFS over the dependency graph (42.3), tolerant of cycles.
 *
 * DFS colouring: nodes on the current stack are grey, finished nodes are black. A grey
 * hit is a back edge — the cycle is recorded and the edge ignored, which breaks the loop
 * without discarding either extension.
 */
export function topologicalOrder(
  dependencies: ReadonlyMap<string, readonly string[]>,
): TopologicalResult {
  const order: string[] = [];
  const cycles: string[][] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start >= 0 ? start : 0).concat(id));
      return;
    }
    if (stack.length >= MAX_DEPENDENCY_DEPTH) {
      cycles.push([...stack.slice(-2), id]);
      return;
    }
    stack.push(id);
    onStack.add(id);
    for (const dep of dependencies.get(id) ?? []) visit(dep);
    onStack.delete(id);
    stack.pop();
    done.add(id);
    order.push(id);
  };

  for (const id of dependencies.keys()) visit(id);
  return { order, cycles };
}

/**
 * The activation order for one extension: its dependencies, deepest first, then itself.
 *
 * Single-flight is the caller's job — a diamond (A→B→D, A→C→D) yields D exactly once
 * here, but the host must also not start a second activation for a node already in
 * flight from another root.
 */
export function activationOrder(
  rootId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): TopologicalResult {
  const root = normalizeId(rootId);
  const reachable = new Map<string, readonly string[]>();
  const frontier = [root];
  let guard = 0;
  while (frontier.length > 0 && guard < 4096) {
    guard += 1;
    const id = frontier.pop() as string;
    if (reachable.has(id)) continue;
    const deps = dependencies.get(id) ?? [];
    reachable.set(id, deps);
    for (const dep of deps) if (!reachable.has(dep)) frontier.push(dep);
  }
  const result = topologicalOrder(reachable);
  // The root must be last even if the graph reached it through a cycle.
  const order = result.order.filter((id) => id !== root);
  order.push(root);
  return { order, cycles: result.cycles };
}

/** The installed-state facts the runtime checks before activating a dependent. */
export interface InstalledState {
  id: string;
  enabled: boolean;
}

export type DependencyIssueKind = 'missing' | 'disabled' | 'activation-failed';

export interface DependencyIssue {
  kind: DependencyIssueKind;
  /** The extension that cannot run. */
  extensionId: string;
  /** The dependency responsible. */
  dependencyId: string;
  /** Message shown next to the extension, with the offered action implied by `kind`. */
  message: string;
}

/**
 * Diagnose a dependent's dependencies before activation (42.4).
 *
 * Returning issues rather than throwing lets the caller decide between blocking the
 * activation and offering "Install" / "Enable" — the UI needs the reason, not just a
 * refusal.
 */
export function diagnoseDependencies(
  extensionId: string,
  declared: readonly string[],
  installed: readonly InstalledState[],
): DependencyIssue[] {
  const byId = new Map(installed.map((entry) => [normalizeId(entry.id), entry]));
  const issues: DependencyIssue[] = [];
  for (const raw of declared) {
    const dep = normalizeId(raw);
    if (dep.length === 0 || dep === normalizeId(extensionId)) continue;
    const state = byId.get(dep);
    if (state === undefined) {
      issues.push({
        kind: 'missing',
        extensionId,
        dependencyId: dep,
        message: `Missing dependency: ${dep}`,
      });
    } else if (!state.enabled) {
      issues.push({
        kind: 'disabled',
        extensionId,
        dependencyId: dep,
        message: `${extensionId} requires ${dep}, which is disabled.`,
      });
    }
  }
  return issues;
}

/** The error a dependent's activation fails with when a dependency could not start. */
export function dependencyActivationError(
  extensionId: string,
  dependencyId: string,
): {
  code: 'ERR_DEPENDENCY_ACTIVATION_FAILED';
  message: string;
} {
  return {
    code: 'ERR_DEPENDENCY_ACTIVATION_FAILED',
    message: `${extensionId} was not activated because its dependency ${dependencyId} failed to activate.`,
  };
}

/**
 * Who depends on an extension, for the uninstall warning (42.4).
 *
 * Only hard dependencies count: a pack listing the extension does not stop it being
 * removed, it just means the pack is no longer complete.
 */
export function dependentsOf(
  targetId: string,
  installed: ReadonlyArray<{ id: string; extensionDependencies?: readonly string[] }>,
): string[] {
  const target = normalizeId(targetId);
  const out: string[] = [];
  for (const entry of installed) {
    const deps = (entry.extensionDependencies ?? []).map(normalizeId);
    if (deps.includes(target) && !out.includes(entry.id)) out.push(entry.id);
  }
  return out;
}

/**
 * Pack members that can be removed with the pack: those nothing else still needs.
 *
 * A member kept by another dependent, or listed by a second installed pack, is left
 * alone — silently uninstalling it would break an unrelated extension.
 */
export function removablePackMembers(
  packId: string,
  members: readonly string[],
  installed: ReadonlyArray<{
    id: string;
    extensionDependencies?: readonly string[];
    extensionPack?: readonly string[];
  }>,
): string[] {
  const pack = normalizeId(packId);
  const out: string[] = [];
  for (const raw of members) {
    const member = normalizeId(raw);
    if (member.length === 0 || member === pack) continue;
    const keptBy = installed.some((entry) => {
      const id = normalizeId(entry.id);
      if (id === pack || id === member) return false;
      const deps = (entry.extensionDependencies ?? []).map(normalizeId);
      const packed = (entry.extensionPack ?? []).map(normalizeId);
      return deps.includes(member) || packed.includes(member);
    });
    if (!keptBy && !out.includes(member)) out.push(member);
  }
  return out;
}
