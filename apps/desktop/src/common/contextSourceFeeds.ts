/**
 * Context source PROVIDERS / FEEDS (Phase 154 — Context Source Providers).
 *
 * PURE module (no I/O, no Electron). This is the FEED step that sits *before* the
 * Phase 155 prioritizer (contextSources.ts) and the Phase 156 fitter
 * (contextBudget.ts):
 *
 *   raw inputs → [contextSourceFeeds: adapt each origin → SourceItem[]]
 *             → [contextSources: allocate · rank · select]      (Phase 155)
 *             → [contextBudget: fitContext truncation]          (Phase 156)
 *             → final prompt
 *
 * Where Phase 155 decides HOW MUCH budget each *kind* gets and which items fit,
 * Phase 154 is the concrete set of ADAPTERS that produce the candidate items for
 * every kind from the IDE's real state:
 *
 *   fromRules         workspace / project rule documents          → 'rules'
 *   fromSelection     the user's current editor selection(s)      → 'selection'
 *   fromAttachments   explicit @-mentions (files, snippets, urls) → 'attachments'
 *   fromOpenFiles     other open editor tabs                      → 'openFiles'
 *   fromRecentEdits   files touched recently (edit recency)       → 'recentEdits'
 *   fromSymbols       symbol/signature structure (graph, LSP)     → 'symbols'
 *   fromMemory        long-term memory entries                    → 'memory'
 *   fromRepoMap       project-understanding repo map / summary    → 'repoMap'
 *
 * Every adapter yields `SourceItem { kind, id, text, score? }` where `score` is a
 * within-source relevance signal (recency, explicitness, or a caller-supplied
 * relevance) — the prioritizer uses it to pick the best items per source.
 *
 * `composeSources` gathers all adapters' output and runs the Phase 155
 * `rankAndSelect`, with optional PINNED kinds whose items are always kept (never
 * dropped) — the active file is pinned by the caller so it can never be evicted.
 *
 * Token estimation reuses the shared ~4-chars/token heuristic from
 * contextManifest (kept DRY across the whole context pipeline).
 */

import { estimateTokens } from './contextManifest';
import {
  rankAndSelect,
  SOURCE_CONFIG,
  type SelectedItem,
  type SelectionManifest,
  type SourceBreakdown,
  type SourceItem,
  type SourceKind,
} from './contextSources';

// ---- raw input shapes (what the IDE hands the feeds) ------------------------

/** A workspace / project rule document (e.g. .axiom/rules/*.md). */
export interface RuleInput {
  id?: string;
  name?: string;
  body: string;
  /** Lower index = declared earlier = ranked higher. */
  order?: number;
}

/** An editor text selection. */
export interface SelectionInput {
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
  /** True for the selection in the currently-focused editor. */
  active?: boolean;
}

/** An explicit @-mention / attachment the user added to the prompt. */
export interface AttachmentInput {
  id?: string;
  label?: string;
  path?: string;
  text: string;
  /** Order the user added them (earlier = ranked higher). */
  order?: number;
}

/** An open editor tab (other than the active one). */
export interface OpenFileInput {
  path: string;
  text: string;
  active?: boolean;
  /** 0 = most-recently-used tab; larger = staler. */
  recencyRank?: number;
}

/** A file touched recently, most-recent first when `editedAt` is omitted. */
export interface RecentEditInput {
  path: string;
  text: string;
  /** Epoch ms of the edit; larger = more recent = ranked higher. */
  editedAt?: number;
}

/** A symbol / signature from the knowledge graph or LSP. */
export interface SymbolInput {
  name: string;
  kind?: string;
  path?: string;
  signature?: string;
  detail?: string;
  /** Structural relevance (e.g. fan-in, reference count). */
  relevance?: number;
}

/** A long-term memory entry. */
export interface MemoryInput {
  id?: string;
  text: string;
  /** Caller-supplied relevance (e.g. embedding similarity). */
  score?: number;
}

/** The project-understanding repo map / high-level summary. */
export interface RepoMapInput {
  id?: string;
  text: string;
}

export interface ComposeInputs {
  rules?: readonly RuleInput[];
  selection?: readonly SelectionInput[];
  attachments?: readonly AttachmentInput[];
  openFiles?: readonly OpenFileInput[];
  recentEdits?: readonly RecentEditInput[];
  symbols?: readonly SymbolInput[];
  memory?: readonly MemoryInput[];
  repoMap?: readonly RepoMapInput[];
}

// ---- helpers ----------------------------------------------------------------

/** Build a SourceItem, omitting `score` when undefined (exactOptionalPropertyTypes). */
function item(kind: SourceKind, id: string, text: string, score?: number): SourceItem {
  return { kind, id, text, ...(score !== undefined ? { score } : {}) };
}

/** Basename of a path (forward or back slashes). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** True when text has any non-whitespace content. */
function hasText(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

// ---- adapters (each: raw input → SourceItem[]) ------------------------------

/**
 * Workspace rules. Rules are authoritative instructions, so they carry a high,
 * order-based score (earlier-declared rules rank first).
 */
export function fromRules(rules: readonly RuleInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  rules.forEach((r, i) => {
    if (!hasText(r.body)) return;
    const order = r.order ?? i;
    const header = hasText(r.name) ? `Rule: ${r.name.trim()}\n` : '';
    // Earlier rules score higher; keep scores comfortably positive.
    out.push(item('rules', r.id ?? `rule:${i}`, `${header}${r.body.trim()}`, 1000 - order));
  });
  return out;
}

/**
 * Editor selection(s). The active selection is the single strongest signal of
 * user intent, so it gets the top score; other selections rank just below.
 */
export function fromSelection(selections: readonly SelectionInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  selections.forEach((s, i) => {
    if (!hasText(s.text)) return;
    const loc =
      s.startLine !== undefined && s.endLine !== undefined
        ? ` (lines ${s.startLine}\u2013${s.endLine})`
        : '';
    const text = `Selection from ${baseName(s.path)}${loc}:\n${s.text.trim()}`;
    const score = s.active === true ? 1000 : 900 - i;
    out.push(item('selection', `sel:${i}`, text, score));
  });
  return out;
}

/**
 * Explicit @-mentions / attachments. These are user-chosen, so they rank high;
 * earlier-added attachments rank first.
 */
export function fromAttachments(attachments: readonly AttachmentInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  attachments.forEach((a, i) => {
    if (!hasText(a.text)) return;
    const order = a.order ?? i;
    const label = hasText(a.label) ? a.label.trim() : a.path ? baseName(a.path) : `attachment ${i}`;
    out.push(
      item('attachments', a.id ?? `att:${i}`, `Attached: ${label}\n${a.text.trim()}`, 1000 - order),
    );
  });
  return out;
}

/**
 * Other open editor tabs. Excludes the active tab (that flows in via selection).
 * Score decays with tab recency (most-recently-used ranks first).
 */
export function fromOpenFiles(openFiles: readonly OpenFileInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  openFiles.forEach((f, i) => {
    if (f.active === true) return;
    if (!hasText(f.text)) return;
    const rank = f.recencyRank ?? i;
    out.push(
      item(
        'openFiles',
        `open:${baseName(f.path)}:${i}`,
        `Open file ${f.path}:\n${f.text.trim()}`,
        500 - rank,
      ),
    );
  });
  return out;
}

/**
 * Recently-edited files. Score by edit recency (larger `editedAt` = more recent =
 * higher). When `editedAt` is omitted the input order is treated as most-recent
 * first.
 */
export function fromRecentEdits(edits: readonly RecentEditInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  edits.forEach((e, i) => {
    if (!hasText(e.text)) return;
    // Normalize to a positive decaying score. Explicit timestamps win; otherwise
    // fall back to input order (index 0 = freshest).
    const score = e.editedAt !== undefined ? e.editedAt / 1e9 : 500 - i;
    out.push(
      item(
        'recentEdits',
        `edit:${baseName(e.path)}:${i}`,
        `Recently edited ${e.path}:\n${e.text.trim()}`,
        score,
      ),
    );
  });
  return out;
}

/**
 * Symbols / signatures (knowledge graph, LSP). Score by structural relevance when
 * provided, else by input order.
 */
export function fromSymbols(symbols: readonly SymbolInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  symbols.forEach((s, i) => {
    const sig = hasText(s.signature)
      ? s.signature.trim()
      : hasText(s.detail)
        ? s.detail.trim()
        : s.name;
    if (!hasText(sig) && !hasText(s.name)) return;
    const where = s.path ? ` — ${baseName(s.path)}` : '';
    const kind = hasText(s.kind) ? `${s.kind} ` : '';
    const text = `${kind}${s.name}${where}\n${sig}`;
    const score = s.relevance ?? 100 - i;
    out.push(item('symbols', `sym:${s.name}:${i}`, text, score));
  });
  return out;
}

/** Long-term memory entries. Score by caller-supplied relevance, else input order. */
export function fromMemory(entries: readonly MemoryInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  entries.forEach((m, i) => {
    if (!hasText(m.text)) return;
    const score = m.score ?? 100 - i;
    out.push(item('memory', m.id ?? `mem:${i}`, m.text.trim(), score));
  });
  return out;
}

/** Project-understanding repo map / summary. Usually a single low-priority item. */
export function fromRepoMap(maps: readonly RepoMapInput[]): SourceItem[] {
  const out: SourceItem[] = [];
  maps.forEach((r, i) => {
    if (!hasText(r.text)) return;
    out.push(item('repoMap', r.id ?? `repomap:${i}`, r.text.trim(), 100 - i));
  });
  return out;
}

/** Run every adapter over the raw inputs and concatenate the SourceItems. */
export function gatherSourceItems(inputs: ComposeInputs): SourceItem[] {
  return [
    ...fromRules(inputs.rules ?? []),
    ...fromSelection(inputs.selection ?? []),
    ...fromAttachments(inputs.attachments ?? []),
    ...fromOpenFiles(inputs.openFiles ?? []),
    ...fromRecentEdits(inputs.recentEdits ?? []),
    ...fromSymbols(inputs.symbols ?? []),
    ...fromMemory(inputs.memory ?? []),
    ...fromRepoMap(inputs.repoMap ?? []),
  ];
}

// ---- compose + prioritize ---------------------------------------------------

export interface ComposeOptions {
  /** Total token budget shared across all sources. */
  budget: number;
  /**
   * Source kinds whose items are ALWAYS kept, regardless of budget. Their tokens
   * are reserved first, and the remaining budget is shared among the rest. The
   * caller pins `selection` so the active file can never be dropped.
   */
  pinnedKinds?: readonly SourceKind[];
}

export interface ComposeResult extends SelectionManifest {
  /** Everything the adapters produced, before selection. */
  gathered: SourceItem[];
  /** How many items were force-kept because their kind was pinned. */
  pinnedCount: number;
}

/** Order included items by source priority (high→low), then score, then arrival. */
function orderIncluded(
  a: { item: SelectedItem; order: number },
  b: { item: SelectedItem; order: number },
): number {
  const pa = SOURCE_CONFIG[a.item.kind].priority;
  const pb = SOURCE_CONFIG[b.item.kind].priority;
  if (pb !== pa) return pb - pa;
  const sa = a.item.score ?? 0;
  const sb = b.item.score ?? 0;
  if (sb !== sa) return sb - sa;
  return a.order - b.order;
}

/**
 * Prioritize + select an already-gathered set of SourceItems with the Phase 155
 * `rankAndSelect`. Pinned-kind items bypass the budget contest (always kept); the
 * remaining budget is shared among the rest. This is the shared core used by
 * `composeSources` (raw-input path) and by callers that build their own items
 * (e.g. the context builder, which maps its candidates to SourceItems keyed by a
 * stable id so it can map the selection back).
 */
export function prioritizeItems(
  items: readonly SourceItem[],
  options: ComposeOptions,
): ComposeResult {
  const gathered = [...items];
  const pinnedKinds = new Set(options.pinnedKinds ?? []);
  const budget = Math.max(0, options.budget);

  const pinned = gathered.filter((it) => pinnedKinds.has(it.kind));
  const rest = gathered.filter((it) => !pinnedKinds.has(it.kind));

  const pinnedSelected: SelectedItem[] = pinned.map((it) => ({
    ...it,
    tokens: estimateTokens(it.text),
  }));
  const pinnedTokens = pinnedSelected.reduce((s, it) => s + it.tokens, 0);
  const remainingBudget = Math.max(0, budget - pinnedTokens);

  const manifest = rankAndSelect(rest, remainingBudget);

  // Merge pinned items into the manifest as always-included.
  const merged = [
    ...pinnedSelected.map((it, i) => ({ item: it, order: i })),
    ...manifest.included.map((it, i) => ({ item: it, order: pinnedSelected.length + i })),
  ];
  merged.sort(orderIncluded);
  const included = merged.map((m) => m.item);

  // Fold pinned counts/tokens into the per-source breakdown.
  const bySource = new Map<SourceKind, SourceBreakdown>();
  for (const b of manifest.bySource) bySource.set(b.kind, { ...b });
  for (const it of pinnedSelected) {
    const existing = bySource.get(it.kind);
    if (existing) {
      existing.includedCount += 1;
      existing.usedTokens += it.tokens;
      existing.budget += it.tokens;
    } else {
      bySource.set(it.kind, {
        kind: it.kind,
        budget: it.tokens,
        includedCount: 1,
        droppedCount: 0,
        usedTokens: it.tokens,
      });
    }
  }
  const bySourceList = [...bySource.values()].sort(
    (a, b) => SOURCE_CONFIG[b.kind].priority - SOURCE_CONFIG[a.kind].priority,
  );

  const usedTokens = included.reduce((s, it) => s + it.tokens, 0);
  const activeSources = bySourceList.filter((s) => s.includedCount > 0).length;
  const summary =
    `${included.length} item${included.length === 1 ? '' : 's'} across ` +
    `${activeSources} source${activeSources === 1 ? '' : 's'} · ` +
    `${usedTokens}/${budget} tokens · ${manifest.dropped.length} dropped` +
    (pinnedSelected.length > 0 ? ` · ${pinnedSelected.length} pinned` : '');

  return {
    totalBudget: budget,
    usedTokens,
    included,
    dropped: manifest.dropped,
    bySource: bySourceList,
    summary,
    gathered,
    pinnedCount: pinnedSelected.length,
  };
}

/**
 * Gather items from every source, then prioritize + select them with the Phase
 * 155 `rankAndSelect`. Pinned-kind items bypass the budget contest (always kept);
 * the remaining budget is shared among the rest. The returned manifest is a
 * drop-in for the contextBudget fitter, with `included[]` ordered ready to
 * compose into a prompt.
 */
export function composeSources(inputs: ComposeInputs, options: ComposeOptions): ComposeResult {
  return prioritizeItems(gatherSourceItems(inputs), options);
}
