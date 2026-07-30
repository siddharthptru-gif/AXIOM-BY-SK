/**
 * Context truncation & compression (PRD Epoch F §69.5 / Phase 156). A pure policy
 * that fits a set of prioritized context items into a token budget "without
 * breaking quality": keep what fits, otherwise COMPRESS it to a symbol skeleton or
 * WINDOW it (keep a budget-sized slice of a large file), and DROP the
 * lowest-priority items last. Pinned items (system prompt, rules, the active file)
 * are never dropped — if they overflow, that is reported honestly. It operates on
 * token *estimates* only (no text, no I/O), so it is fully unit-testable; the
 * caller materializes each item's text per the chosen strategy and can surface the
 * plan in the context manifest (transparency, Phase 158).
 */

export type FitStrategy = 'none' | 'skeleton' | 'window';

/** Below this many tokens, windowing a file isn't worth attempting. */
export const DEFAULT_MIN_WINDOW_TOKENS = 60;

export interface ContextItem {
  id: string;
  /** Higher = more important; lower-priority items are dropped first. */
  priority: number;
  /** Token estimate of the full content. */
  tokens: number;
  /** May be compressed to a symbol skeleton to fit. */
  compressible?: boolean;
  /** Token estimate when skeletonized (only meaningful if `compressible`). */
  compressedTokens?: number;
  /** May be windowed (a budget-sized prefix slice kept) to fit. */
  windowable?: boolean;
  /** Floor on a useful window; below it, windowing isn't attempted. */
  minWindowTokens?: number;
  /** Never dropped — kept even if it overflows the budget. */
  pinned?: boolean;
}

export interface FittedItem {
  id: string;
  priority: number;
  strategy: FitStrategy;
  /** Resulting token count after the strategy (0 when dropped). */
  tokens: number;
  dropped: boolean;
}

export interface FitResult {
  /** Fitted items in the SAME order as the input. */
  items: FittedItem[];
  totalTokens: number;
  budget: number;
  keptCount: number;
  droppedCount: number;
  compressedCount: number;
  windowedCount: number;
  /** True when the kept total is within the budget. */
  withinBudget: boolean;
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface Decision {
  strategy: FitStrategy;
  tokens: number;
}

/** Pick the least-lossy strategy for an item given the remaining budget, or null. */
function decide(it: ContextItem, full: number, remaining: number): Decision | null {
  if (full <= remaining) return { strategy: 'none', tokens: full };
  if (it.compressible) {
    const c = nonNeg(it.compressedTokens ?? 0);
    if (c > 0 && c <= remaining && c < full) return { strategy: 'skeleton', tokens: c };
  }
  if (it.windowable) {
    const floorRaw = nonNeg(it.minWindowTokens ?? 0);
    const floor = floorRaw > 0 ? floorRaw : DEFAULT_MIN_WINDOW_TOKENS;
    if (remaining >= floor) {
      const t = Math.min(full, remaining);
      if (t > 0) return { strategy: 'window', tokens: t };
    }
  }
  return null;
}

/** The smallest representation of a pinned item that must be kept regardless. */
function smallestRep(it: ContextItem, full: number): Decision {
  if (it.compressible) {
    const c = nonNeg(it.compressedTokens ?? 0);
    if (c > 0 && c < full) return { strategy: 'skeleton', tokens: c };
  }
  if (it.windowable) {
    const floorRaw = nonNeg(it.minWindowTokens ?? 0);
    const floor = floorRaw > 0 ? floorRaw : DEFAULT_MIN_WINDOW_TOKENS;
    return { strategy: 'window', tokens: Math.min(full, floor) };
  }
  return { strategy: 'none', tokens: full };
}

/**
 * Fit prioritized context items into a token budget. Items are considered
 * pinned-first, then highest-priority-first, so scarce budget goes to the most
 * important context; each item is kept whole if it fits, else compressed or
 * windowed, else dropped (unless pinned). Returns a per-item plan in the original
 * input order plus totals.
 */
export function fitContext(items: readonly ContextItem[], budgetTokens: number): FitResult {
  const budget = nonNeg(budgetTokens);
  const order = items.map((it, i) => ({ it, i }));
  order.sort((a, b) => {
    const ap = a.it.pinned ? 1 : 0;
    const bp = b.it.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap; // pinned first
    if (a.it.priority !== b.it.priority) return b.it.priority - a.it.priority; // higher first
    return a.i - b.i; // stable
  });

  const decided = new Map<number, FittedItem>();
  let remaining = budget;
  for (const { it, i } of order) {
    const full = nonNeg(it.tokens);
    const d = decide(it, full, remaining);
    if (d) {
      decided.set(i, {
        id: it.id,
        priority: it.priority,
        strategy: d.strategy,
        tokens: d.tokens,
        dropped: false,
      });
      remaining = Math.max(0, remaining - d.tokens);
    } else if (it.pinned) {
      const s = smallestRep(it, full);
      decided.set(i, {
        id: it.id,
        priority: it.priority,
        strategy: s.strategy,
        tokens: s.tokens,
        dropped: false,
      });
      remaining = Math.max(0, remaining - s.tokens);
    } else {
      decided.set(i, {
        id: it.id,
        priority: it.priority,
        strategy: 'none',
        tokens: 0,
        dropped: true,
      });
    }
  }

  const resultItems: FittedItem[] = items.map((_, i) => decided.get(i)!);
  let totalTokens = 0;
  let dropped = 0;
  let compressed = 0;
  let windowed = 0;
  for (const r of resultItems) {
    if (r.dropped) {
      dropped++;
      continue;
    }
    totalTokens += r.tokens;
    if (r.strategy === 'skeleton') compressed++;
    else if (r.strategy === 'window') windowed++;
  }
  return {
    items: resultItems,
    totalTokens,
    budget,
    keptCount: resultItems.length - dropped,
    droppedCount: dropped,
    compressedCount: compressed,
    windowedCount: windowed,
    withinBudget: totalTokens <= budget,
  };
}

/** Compact, manifest-friendly summary of a fit (e.g. for the context header). */
export function summarizeFit(r: FitResult): string {
  const bits = [`~${r.totalTokens}/${r.budget} tokens`];
  if (r.compressedCount > 0) bits.push(`${r.compressedCount} compressed`);
  if (r.windowedCount > 0) bits.push(`${r.windowedCount} windowed`);
  if (r.droppedCount > 0) bits.push(`${r.droppedCount} dropped`);
  return bits.join(', ');
}
