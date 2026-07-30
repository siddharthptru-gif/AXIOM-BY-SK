/**
 * Context SOURCES & prioritization (Phase 155 — Context Sources & Prioritization).
 *
 * PURE module (no I/O, no Electron). This is the COMPOSE / PRIORITIZE step that
 * decides WHICH items from WHICH sources enter a prompt, and how the token budget
 * is shared across sources so one noisy source (e.g. retrieved chunks) cannot
 * crowd out high-value ones (e.g. the current selection or the user's rules).
 *
 * Pipeline position — it runs BEFORE contextBudget.ts fitContext (Phase 156 =
 * truncation / compression):
 *
 *   raw sources → [contextSources: allocate budget · rank · select] → chosen items
 *               → [contextBudget: fitContext truncation] → final prompt
 *
 * Model:
 *   - SourceKind: the ten well-known context origins.
 *   - SOURCE_CONFIG: per-kind { priority (drop order), share (budget weight),
 *     maxTokens (diminishing-returns hard cap) }. Shares sum to 1 across all kinds.
 *   - allocateBudget: split a total token budget across the sources that actually
 *     have items — proportional to share (normalized over present sources so the
 *     whole budget is used), clamped by each source's maxTokens, with the clamped
 *     remainder redistributed to sources still under their cap.
 *   - rankAndSelect: within each source's budget, greedily include items (highest
 *     score first) that fit; produce an included[] ordered by source priority then
 *     score, a dropped[], and a per-source manifest of counts + token usage.
 *
 * Reuses the shared ~4-chars/token estimate from contextManifest (kept DRY).
 */

import { estimateTokens } from './contextManifest';

export type SourceKind =
  | 'system'
  | 'rules'
  | 'selection'
  | 'attachments'
  | 'openFiles'
  | 'recentEdits'
  | 'symbols'
  | 'retrieved'
  | 'memory'
  | 'repoMap';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'system',
  'rules',
  'selection',
  'attachments',
  'openFiles',
  'recentEdits',
  'symbols',
  'retrieved',
  'memory',
  'repoMap',
];

export const SOURCE_LABELS: Record<SourceKind, string> = {
  system: 'System',
  rules: 'Workspace Rules',
  selection: 'Selection',
  attachments: 'Attachments',
  openFiles: 'Open Files',
  recentEdits: 'Recent Edits',
  symbols: 'Symbols',
  retrieved: 'Retrieved',
  memory: 'Memory',
  repoMap: 'Repo Map',
};

export interface SourceConfig {
  /** Drop order + prompt ordering. Higher = more important (kept / placed first). */
  priority: number;
  /** Relative budget weight. The raw shares below sum to 1 across all kinds. */
  share: number;
  /** Absolute per-source ceiling (diminishing returns) — a HARD cap. */
  maxTokens: number;
}

export const SOURCE_CONFIG: Record<SourceKind, SourceConfig> = {
  system: { priority: 100, share: 0.1, maxTokens: 4000 },
  rules: { priority: 90, share: 0.08, maxTokens: 3000 },
  selection: { priority: 80, share: 0.1, maxTokens: 4000 },
  attachments: { priority: 70, share: 0.15, maxTokens: 8000 },
  openFiles: { priority: 60, share: 0.15, maxTokens: 6000 },
  recentEdits: { priority: 50, share: 0.08, maxTokens: 3000 },
  symbols: { priority: 40, share: 0.09, maxTokens: 3000 },
  retrieved: { priority: 30, share: 0.15, maxTokens: 6000 },
  memory: { priority: 20, share: 0.05, maxTokens: 2000 },
  repoMap: { priority: 10, share: 0.05, maxTokens: 1500 },
};

export interface SourceItem {
  kind: SourceKind;
  id: string;
  text: string;
  /** Relevance score (higher = more relevant). Defaults to 0 when omitted. */
  score?: number;
}

export interface SelectedItem extends SourceItem {
  tokens: number;
}

export interface SourceBreakdown {
  kind: SourceKind;
  budget: number;
  includedCount: number;
  droppedCount: number;
  usedTokens: number;
}

export interface SelectionManifest {
  totalBudget: number;
  usedTokens: number;
  included: SelectedItem[];
  dropped: SourceItem[];
  bySource: SourceBreakdown[];
  summary: string;
}

/**
 * Allocate `totalTokens` across the sources present, proportional to each source's
 * share (normalized over the present sources) and clamped by its maxTokens cap. The
 * remainder freed by capping is redistributed to sources still under their cap.
 * Returns a per-kind integer token budget for the present kinds.
 */
export function allocateBudget(
  totalTokens: number,
  presentKinds: readonly SourceKind[],
): Record<string, number> {
  const present = presentKinds.filter((k, i) => presentKinds.indexOf(k) === i);
  const result: Record<string, number> = {};
  for (const k of present) result[k] = 0;
  if (totalTokens <= 0 || present.length === 0) return result;

  const alloc = new Map<SourceKind, number>();
  const capped = new Set<SourceKind>();
  for (const k of present) alloc.set(k, 0);

  let remaining = totalTokens;
  for (let pass = 0; pass < 32 && remaining > 1e-4; pass++) {
    const open = present.filter((k) => !capped.has(k));
    if (open.length === 0) break;
    const shareSum = open.reduce((s, k) => s + SOURCE_CONFIG[k].share, 0);
    if (shareSum <= 0) break;
    let distributed = 0;
    let newlyCapped = false;
    for (const k of open) {
      const current = alloc.get(k) ?? 0;
      const add = remaining * (SOURCE_CONFIG[k].share / shareSum);
      const cap = SOURCE_CONFIG[k].maxTokens;
      let next = current + add;
      if (next >= cap) {
        next = cap;
        capped.add(k);
        newlyCapped = true;
      }
      distributed += next - current;
      alloc.set(k, next);
    }
    remaining -= distributed;
    if (!newlyCapped) break;
  }

  // Floor to integers, then hand any rounding remainder to the highest-priority
  // present source that still has cap headroom.
  let used = 0;
  for (const k of present) {
    const v = Math.floor(alloc.get(k) ?? 0);
    result[k] = v;
    used += v;
  }
  let leftover = totalTokens - used;
  if (leftover > 0) {
    const byPriority = [...present].sort(
      (a, b) => SOURCE_CONFIG[b].priority - SOURCE_CONFIG[a].priority,
    );
    for (const k of byPriority) {
      if (leftover <= 0) break;
      const room = SOURCE_CONFIG[k].maxTokens - (result[k] ?? 0);
      if (room <= 0) continue;
      const give = Math.min(room, leftover);
      result[k] = (result[k] ?? 0) + give;
      leftover -= give;
    }
  }
  return result;
}

/**
 * Rank items across sources and select those that fit each source's allocated
 * budget. Within a source, highest-score items are included first; items that do
 * not fit are dropped. The final `included` list is ordered by source priority
 * (system → repoMap) then by score, ready to compose into a prompt.
 */
export function rankAndSelect(
  items: readonly SourceItem[],
  totalBudget: number,
): SelectionManifest {
  interface Rec {
    item: SourceItem;
    tokens: number;
    order: number;
  }
  const byKind = new Map<SourceKind, Rec[]>();
  items.forEach((item, order) => {
    const tokens = estimateTokens(item.text);
    const list = byKind.get(item.kind) ?? [];
    list.push({ item, tokens, order });
    byKind.set(item.kind, list);
  });

  const presentKinds = [...byKind.keys()];
  const budgets = allocateBudget(totalBudget, presentKinds);

  const includedRecords: Rec[] = [];
  const dropped: SourceItem[] = [];
  const bySource: SourceBreakdown[] = [];

  for (const kind of presentKinds) {
    const budget = budgets[kind] ?? 0;
    const list = (byKind.get(kind) ?? []).slice().sort((a, b) => {
      const sa = a.item.score ?? 0;
      const sb = b.item.score ?? 0;
      if (sb !== sa) return sb - sa;
      return a.order - b.order;
    });
    let usedForKind = 0;
    let inc = 0;
    let drp = 0;
    for (const rec of list) {
      if (usedForKind + rec.tokens <= budget) {
        includedRecords.push(rec);
        usedForKind += rec.tokens;
        inc++;
      } else {
        dropped.push(rec.item);
        drp++;
      }
    }
    bySource.push({ kind, budget, includedCount: inc, droppedCount: drp, usedTokens: usedForKind });
  }

  includedRecords.sort((a, b) => {
    const pa = SOURCE_CONFIG[a.item.kind].priority;
    const pb = SOURCE_CONFIG[b.item.kind].priority;
    if (pb !== pa) return pb - pa;
    const sa = a.item.score ?? 0;
    const sb = b.item.score ?? 0;
    if (sb !== sa) return sb - sa;
    return a.order - b.order;
  });
  bySource.sort((a, b) => SOURCE_CONFIG[b.kind].priority - SOURCE_CONFIG[a.kind].priority);

  const included: SelectedItem[] = includedRecords.map((r) => ({ ...r.item, tokens: r.tokens }));
  const usedTokens = included.reduce((sum, i) => sum + i.tokens, 0);
  const activeSources = bySource.filter((s) => s.includedCount > 0).length;
  const summary =
    `${included.length} item${included.length === 1 ? '' : 's'} across ` +
    `${activeSources} source${activeSources === 1 ? '' : 's'} · ` +
    `${usedTokens}/${totalBudget} tokens · ${dropped.length} dropped`;

  return { totalBudget, usedTokens, included, dropped, bySource, summary };
}

/** Sum of all raw source shares — should be 1. Exposed for tests / diagnostics. */
export function totalShare(): number {
  return SOURCE_KINDS.reduce((s, k) => s + SOURCE_CONFIG[k].share, 0);
}
