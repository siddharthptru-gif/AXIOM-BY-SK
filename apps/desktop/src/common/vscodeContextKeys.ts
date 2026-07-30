/**
 * The context-key service (PRD Phase 5 §5).
 *
 * `contextKeyExpr.ts` can already parse and evaluate a `when` clause. What was missing is the
 * other half: a *store* of keys for those clauses to read, and the `setContext` command that
 * lets an extension write one. Every gated surface in the workbench — a menu item, a tree
 * item's inline action, a view's visibility, a keybinding — reads from here.
 *
 * Three decisions worth stating:
 *
 *   1. **Compiled clauses are cached by source text.** A menu with forty items is resolved on
 *      every context change; re-parsing forty strings each time is work with a known answer.
 *      The cache is keyed by the raw string, bounded, and holds the key list too so a change
 *      to one key can be matched against the clauses that actually read it.
 *   2. **Values are copied and narrowed, never referenced.** An extension hands over a value
 *      across a process boundary; accepting an arbitrary object would put a structure the
 *      workbench never validated in front of every `when` evaluation. Booleans, numbers,
 *      strings and flat arrays of those are what upstream clauses actually compare against.
 *   3. **Keys carry an owner.** One store serves all extensions, as in VS Code, but each entry
 *      remembers who wrote it so an extension host that stops takes its keys with it. A key
 *      left behind would keep a menu item visible for an extension that is no longer running.
 *
 * Pure: no globals beyond the clause cache, no I/O, and no code is ever compiled from a
 * context value — `evaluateContextKey` walks an AST.
 */

import {
  contextKeysUsed,
  evaluateContextKey,
  parseContextKeyExpression,
  type ContextKeyExpression,
  type ContextKeyValues,
} from './contextKeyExpr';

/** Keys one store holds at once. Upstream's own set is in the low hundreds. */
export const MAX_CONTEXT_KEYS = 512;
export const MAX_CONTEXT_KEY_CHARS = 128;
export const MAX_CONTEXT_VALUE_CHARS = 1_024;
export const MAX_CONTEXT_ARRAY_ITEMS = 200;
/** Compiled clauses kept. A workbench with every extension installed uses a few hundred. */
export const MAX_WHEN_CACHE_ENTRIES = 2_048;

const CONTEXT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.:\-]{0,127}$/;

/** Names that would reach `Object.prototype` if a store were ever a plain object. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isContextKeyName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CONTEXT_KEY_CHARS &&
    CONTEXT_KEY_RE.test(value) &&
    !FORBIDDEN_KEYS.has(value)
  );
}

export type ContextPrimitive = boolean | number | string | null;
export type ContextKeyValue = ContextPrimitive | ContextPrimitive[];

function primitive(raw: unknown): { value: ContextPrimitive } | null {
  if (raw === null) return { value: null };
  if (typeof raw === 'boolean') return { value: raw };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : null;
  if (typeof raw === 'string') {
    return raw.length > MAX_CONTEXT_VALUE_CHARS ? null : { value: raw };
  }
  return null;
}

/**
 * Narrow a value an extension passed to `setContext`.
 *
 * `undefined` is accepted and means "remove", which is how upstream clears a key. Anything
 * that is not a primitive or a flat array of primitives is refused rather than coerced: a
 * clause comparing `key == '[object Object]'` is not behaviour worth reproducing.
 */
export function normalizeContextValue(
  raw: unknown,
): { kind: 'value'; value: ContextKeyValue } | { kind: 'remove' } | null {
  if (raw === undefined) return { kind: 'remove' };
  const single = primitive(raw);
  if (single !== null) return { kind: 'value', value: single.value };
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_CONTEXT_ARRAY_ITEMS) return null;
  const out: ContextPrimitive[] = [];
  for (const entry of raw) {
    const item = primitive(entry);
    if (item === null) return null;
    out.push(item.value);
  }
  return { kind: 'value', value: out };
}

/**
 * Keys the workbench computes for itself, which an extension may not overwrite.
 *
 * Upstream's `setContext` is unrestricted, and this is a deliberate, narrow deviation. These
 * are the keys AXIOM recomputes from its own state on every editor, selection, tree and
 * workspace change — the identity of what the user is looking at. An extension write would be
 * silently discarded on the next recompute anyway, so refusing it is the honest answer; and
 * accepting it would let one extension lie to another extension's `when` clause about which
 * file is open. Keys an extension invents for itself, which is what `setContext` is for, are
 * unrestricted.
 */
export const WORKBENCH_OWNED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'isWindows',
  'isLinux',
  'isMac',
  'isWeb',
  'isDevelopment',
  'workspaceFolderCount',
  'workbenchState',
  'workspaceTrust',
  'editorIsOpen',
  'editorFocus',
  'editorTextFocus',
  'editorHasSelection',
  'editorLangId',
  'editorReadonly',
  'resourceScheme',
  'resource',
  'resourcePath',
  'resourceDirname',
  'resourceFilename',
  'resourceExtname',
  'resourceLangId',
  'resourceSet',
  'isFileSystemResource',
  'view',
  'viewItem',
  'focusedView',
  'sideBarVisible',
  'sideBarFocus',
  'activeViewlet',
  'panelFocus',
  'terminalFocus',
  'listFocus',
  'listHasSelectionOrFocus',
  'listMultiSelection',
  'treeElementCanCollapse',
  'treeElementCanExpand',
  'webviewFocus',
]);

export function isWorkbenchOwnedContextKey(key: string): boolean {
  return WORKBENCH_OWNED_CONTEXT_KEYS.has(key);
}

export type ContextWriteResult =
  'set' | 'removed' | 'unchanged' | 'invalid-key' | 'invalid-value' | 'reserved' | 'full';

function sameValue(a: ContextKeyValue, b: ContextKeyValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

/**
 * The store itself.
 *
 * A `Map`, not an object, so a key named `toString` is a key and not a method. `version`
 * increments on every accepted change and is what the renderer polls against: re-resolving
 * every menu in the workbench because an unrelated key moved is the cost this avoids.
 */
export class ContextKeyStore {
  private readonly entries = new Map<string, { value: ContextKeyValue; owner: string }>();
  private versionValue = 0;

  get version(): number {
    return this.versionValue;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Write one key. `owner` is an extension id, or `'workbench'` for AXIOM's own state. */
  set(key: unknown, raw: unknown, owner: string): ContextWriteResult {
    if (!isContextKeyName(key)) return 'invalid-key';
    const normalized = normalizeContextValue(raw);
    if (normalized === null) return 'invalid-value';
    const trusted = owner === 'workbench';
    if (!trusted && isWorkbenchOwnedContextKey(key)) return 'reserved';
    if (normalized.kind === 'remove') return this.remove(key, owner) ? 'removed' : 'unchanged';
    const existing = this.entries.get(key);
    if (existing === undefined && this.entries.size >= MAX_CONTEXT_KEYS) return 'full';
    if (
      existing !== undefined &&
      existing.owner === owner &&
      sameValue(existing.value, normalized.value)
    ) {
      return 'unchanged';
    }
    this.entries.set(key, { value: normalized.value, owner });
    this.versionValue += 1;
    return 'set';
  }

  /**
   * Replace the whole workbench-owned half of the store.
   *
   * Called with what the window currently is — which editor, which view, which selection.
   * Keys the caller no longer sends are removed, because a stale `resourceLangId` is worse
   * than none: a menu item would stay visible for a file that is no longer open.
   */
  applyWorkbench(values: Readonly<Record<string, unknown>>): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(values)) {
      if (!isContextKeyName(key)) continue;
      seen.add(key);
      const result = this.set(key, value, 'workbench');
      if (result === 'set' || result === 'removed') changed = true;
    }
    for (const [key, entry] of [...this.entries]) {
      if (entry.owner !== 'workbench' || seen.has(key)) continue;
      this.entries.delete(key);
      changed = true;
    }
    if (changed) this.versionValue += 1;
    return changed;
  }

  /** Remove a key, but only the owner's own. */
  remove(key: unknown, owner: string): boolean {
    if (typeof key !== 'string') return false;
    const existing = this.entries.get(key);
    if (existing === undefined) return false;
    if (existing.owner !== owner && owner !== 'workbench') return false;
    this.entries.delete(key);
    this.versionValue += 1;
    return true;
  }

  /** Everything one owner wrote, dropped at once. Called when an extension host stops. */
  removeOwner(owner: string): boolean {
    let changed = false;
    for (const [key, entry] of [...this.entries]) {
      if (entry.owner !== owner) continue;
      this.entries.delete(key);
      changed = true;
    }
    if (changed) this.versionValue += 1;
    return changed;
  }

  ownerOf(key: string): string | null {
    return this.entries.get(key)?.owner ?? null;
  }

  get(key: string): ContextKeyValue | undefined {
    return this.entries.get(key)?.value;
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** A plain snapshot for `evaluateContextKey`. Built with a null prototype for the same reason. */
  snapshot(): ContextKeyValues {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of this.entries) out[key] = entry.value;
    return out;
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.versionValue += 1;
  }
}

// ---------------------------------------------------------------------------
// Compiled `when` clauses
// ---------------------------------------------------------------------------
export interface CompiledWhen {
  /** The clause as written, so a diagnostic can quote it. */
  source: string;
  expr: ContextKeyExpression;
  /** Keys the clause reads, for change-driven re-resolution. */
  keys: readonly string[];
}

const whenCache = new Map<string, CompiledWhen | null>();

/**
 * Compile a clause, once.
 *
 * `null` means the clause did not parse; it is cached too, so a typo in a manifest costs one
 * parse rather than one per resolution. An absent clause compiles to `true`, which is
 * upstream's "no `when` means always".
 */
export function compileWhen(source: string | null | undefined): CompiledWhen | null {
  const text = typeof source === 'string' ? source : '';
  const cached = whenCache.get(text);
  if (cached !== undefined) return cached;
  const expr = parseContextKeyExpression(text);
  const compiled: CompiledWhen | null =
    expr === null ? null : { source: text, expr, keys: contextKeysUsed(expr) };
  // Oldest-first eviction: a workbench that has churned through thousands of distinct clauses
  // is one where the newest are the ones being resolved.
  if (whenCache.size >= MAX_WHEN_CACHE_ENTRIES) {
    const oldest = whenCache.keys().next();
    if (!oldest.done) whenCache.delete(oldest.value);
  }
  whenCache.set(text, compiled);
  return compiled;
}

/** Evaluate a clause against a snapshot. An unparseable clause is `false`, never `true`. */
export function evaluateWhen(
  source: string | null | undefined,
  context: ContextKeyValues,
): boolean {
  const compiled = compileWhen(source);
  return compiled === null ? false : evaluateContextKey(compiled.expr, context);
}

/** Does a change to these keys affect this clause? Used to skip re-resolving untouched menus. */
export function whenReadsAnyOf(
  source: string | null | undefined,
  changed: ReadonlySet<string>,
): boolean {
  const compiled = compileWhen(source);
  if (compiled === null) return false;
  return compiled.keys.some((key) => changed.has(key));
}

export function whenCacheSize(): number {
  return whenCache.size;
}

export function clearWhenCache(): void {
  whenCache.clear();
}
