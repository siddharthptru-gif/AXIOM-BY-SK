/**
 * Provider refresh events (PRD Phase 7 — provider change events, editor refresh pipeline).
 *
 * PURE module: no timers, no I/O, no Electron. It owns the two decisions the refresh pipeline needs
 * and nothing else — which `vscode` provider member carries a change event for a given feature, and
 * which of a burst of `fire()` calls the editor should actually be woken for.
 *
 * A provider that recomputes its answer tells the editor by firing an event: a code-lens provider
 * whose backing build finished fires `onDidChangeCodeLenses`, and the editor asks again. Phases 1–6
 * had no path for that at all — a provider's first answer was its only answer until the document
 * changed — so the lenses of every real language extension went stale and stayed stale.
 *
 * The reason the coalescing lives here rather than in Main is that firing is cheap for the extension
 * and expensive for the editor: `onDidChangeCodeLenses` costs the extension a function call, and
 * costs the renderer a full re-provide over every visible model. Upstream debounces; so does AXIOM,
 * with a per-handle deadline (so two providers do not share one budget) and a sustained-rate window
 * (so a provider that fires in a loop cannot hold the editor at 100%).
 *
 * `no polling` in the PRD is satisfied by construction: nothing here has a clock of its own. Main
 * asks `nextDueAt()` for the one deadline it needs a timer for, and that timer exists only while a
 * change is pending.
 */

/**
 * Feature → the `vscode` provider member whose event means "ask me again".
 *
 * These are the five events upstream defines. There is deliberately no entry for
 * `semanticTokensRange`: `DocumentRangeSemanticTokensProvider` has no change event in the VS Code
 * API and none in Monaco, and inventing one would mean advertising a refresh path that cannot
 * arrive.
 */
export const PROVIDER_CHANGE_EVENTS = {
  codeLens: 'onDidChangeCodeLenses',
  inlayHint: 'onDidChangeInlayHints',
  semanticTokens: 'onDidChangeSemanticTokens',
  foldingRange: 'onDidChangeFoldingRanges',
  inlineValue: 'onDidChangeInlineValues',
} as const;

/** A feature whose provider may carry a change event. */
export type ChangeableFeature = keyof typeof PROVIDER_CHANGE_EVENTS;

const CHANGEABLE = new Set<string>(Object.keys(PROVIDER_CHANGE_EVENTS));

export function isChangeableFeature(value: unknown): value is ChangeableFeature {
  return typeof value === 'string' && CHANGEABLE.has(value);
}

/** The event member to subscribe to, or null when the feature has no change event. */
export function providerChangeEventName(feature: string): string | null {
  return isChangeableFeature(feature) ? PROVIDER_CHANGE_EVENTS[feature] : null;
}

/**
 * Features whose refresh reaches Monaco through the provider it registered.
 *
 * `inlineValue` is absent because standalone Monaco has no inline-values provider: its refresh is
 * delivered to AXIOM's own inline-values surface instead, which is why the renderer needs both a
 * per-handle path and a per-feature one.
 */
export const MONACO_REFRESHED_FEATURES = [
  'codeLens',
  'inlayHint',
  'semanticTokens',
  'foldingRange',
] as const;

/** How long a fire waits for its neighbours before the editor is woken. */
export const PROVIDER_CHANGE_DEBOUNCE_MS = 50;
/** The sustained-rate window one provider is measured over. */
export const PROVIDER_CHANGE_WINDOW_MS = 1_000;
/** Refreshes one provider may cause per window before its next one is held to the window's end. */
export const MAX_CHANGES_PER_WINDOW = 20;
/**
 * Pending entries kept at once.
 *
 * Entries are keyed by provider handle and forgotten on unregister, so this cannot be reached while
 * the number of live providers is bounded (`MAX_PROVIDERS_PER_EXTENSION`). It is a valve, not a
 * budget: `dropped` counts anything it ever refuses so the condition is reported rather than hidden.
 */
export const MAX_PENDING_PROVIDER_CHANGES = 512;

/** One provider asking to be asked again. */
export interface ProviderChange {
  /** Main's global provider handle. */
  handle: number;
  feature: string;
}

/** What `record` did with a fire. Reported for logging; no caller branches on it. */
export type RecordOutcome = 'queued' | 'coalesced' | 'deferred' | 'dropped';

interface PendingChange extends ProviderChange {
  dueAt: number;
}

interface RateWindow {
  start: number;
  count: number;
}

/**
 * A burst of provider fires, collapsed to the set of refreshes the editor should see.
 *
 * Keyed by handle, so two fires from one provider are one refresh however close together they are,
 * while two providers that fire in the same millisecond are two — a code-lens refresh must not be
 * swallowed because an unrelated inlay-hints provider fired first.
 *
 * Time is a parameter, never read from a clock, so the whole policy is exercised directly by the
 * validators at whatever timestamps they choose.
 */
export class ProviderChangeCoalescer {
  private readonly pending = new Map<number, PendingChange>();
  private readonly windows = new Map<number, RateWindow>();
  private droppedCount = 0;

  /** Record one `fire()`. `now` is a monotonic millisecond reading supplied by the caller. */
  record(handle: number, feature: string, now: number): RecordOutcome {
    const window = this.windows.get(handle);
    let count: number;
    let start: number;
    if (window === undefined || now - window.start >= PROVIDER_CHANGE_WINDOW_MS) {
      this.windows.set(handle, { start: now, count: 1 });
      count = 1;
      start = now;
    } else {
      window.count += 1;
      count = window.count;
      start = window.start;
    }
    // A provider over its budget still gets its refresh — it waits for the window to close for it.
    const hot = count > MAX_CHANGES_PER_WINDOW;
    const dueAt = hot ? start + PROVIDER_CHANGE_WINDOW_MS : now + PROVIDER_CHANGE_DEBOUNCE_MS;
    const existing = this.pending.get(handle);
    if (existing !== undefined) {
      // Keep the earliest deadline: a burst must not push back a refresh that was already due.
      if (dueAt < existing.dueAt) existing.dueAt = dueAt;
      return 'coalesced';
    }
    if (this.pending.size >= MAX_PENDING_PROVIDER_CHANGES) {
      this.droppedCount += 1;
      return 'dropped';
    }
    this.pending.set(handle, { handle, feature, dueAt });
    return hot ? 'deferred' : 'queued';
  }

  /** The one deadline a caller needs a timer for, or null when nothing is pending. */
  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const entry of this.pending.values()) {
      if (earliest === null || entry.dueAt < earliest) earliest = entry.dueAt;
    }
    return earliest;
  }

  /** Take the changes due at `now`, in the order they were first recorded. */
  drain(now: number): ProviderChange[] {
    const out: ProviderChange[] = [];
    for (const [handle, entry] of [...this.pending]) {
      if (entry.dueAt > now) continue;
      this.pending.delete(handle);
      out.push({ handle: entry.handle, feature: entry.feature });
    }
    return out;
  }

  /** Take everything pending regardless of deadline. Used when the registry is rebuilt. */
  drainAll(): ProviderChange[] {
    const out: ProviderChange[] = [];
    for (const entry of this.pending.values()) {
      out.push({ handle: entry.handle, feature: entry.feature });
    }
    this.pending.clear();
    return out;
  }

  /** Forget a handle entirely — its provider is gone, so its refresh means nothing. */
  forget(handle: number): void {
    this.pending.delete(handle);
    this.windows.delete(handle);
  }

  forgetMany(handles: Iterable<number>): void {
    for (const handle of handles) this.forget(handle);
  }

  clear(): void {
    this.pending.clear();
    this.windows.clear();
    this.droppedCount = 0;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Fires refused by the valve. Non-zero is a condition worth logging, never an expected state. */
  get dropped(): number {
    return this.droppedCount;
  }
}

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------
/** One flush, as it crosses to the renderer. */
export interface ProviderChangeBatch {
  /**
   * The registry revision the batch was produced under.
   *
   * The renderer drops handles it does not know, so this is not used to gate delivery; it is carried
   * so a renderer that has fallen behind can say so in a log rather than guess.
   */
  revision: number;
  changes: ProviderChange[];
}

/**
 * Validate a pushed batch inside the renderer.
 *
 * A push from Main is not a reason to skip validation: the renderer is the untrusted side of its own
 * boundary in the sense that matters here — it turns these numbers into provider invocations — and a
 * malformed entry should cost one dropped refresh, not a thrown listener that unsubscribes the
 * refresh pipeline for the rest of the session.
 */
export function normalizeProviderChangeBatch(value: unknown): ProviderChangeBatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  const revision = source.revision;
  if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0) return null;
  if (!Array.isArray(source.changes)) return null;
  const changes: ProviderChange[] = [];
  const seen = new Set<number>();
  for (const entry of source.changes.slice(0, MAX_PENDING_PROVIDER_CHANGES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const change = entry as Record<string, unknown>;
    const handle = change.handle;
    const feature = change.feature;
    if (typeof handle !== 'number' || !Number.isInteger(handle) || handle <= 0) continue;
    if (!isChangeableFeature(feature)) continue;
    if (seen.has(handle)) continue;
    seen.add(handle);
    changes.push({ handle, feature });
  }
  return { revision: Math.floor(revision), changes };
}

/** The distinct features a batch touched, for consumers that refresh per feature. */
export function changedFeatures(changes: readonly ProviderChange[]): string[] {
  const out: string[] = [];
  for (const change of changes) {
    if (!out.includes(change.feature)) out.push(change.feature);
  }
  return out;
}
