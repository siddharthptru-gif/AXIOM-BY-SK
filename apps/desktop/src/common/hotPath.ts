/**
 * Editor hot-path latency & rendering policy (PRD Epoch J §196 / Phase 269).
 * Pure frame-budget math plus a work-classification / background-yielding policy,
 * with no I/O, so it is fully unit-testable and shared by the Performance panel
 * (which samples real frame intervals and grades them against the 60fps budget)
 * and any background scheduler (AI / index / agents) that must yield to keep
 * editing frame-perfect — encoding INV-1: "background work never breaches the hot
 * path". GPU tuning and universal adoption of the yielder live in the editor +
 * runtime; this module owns the *policy + measurement math*.
 */

export const TARGET_FPS = 60;
/** One 60fps frame (~16.667 ms). Keystroke→render must land inside one frame. */
export const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
/** Keystroke→render hard target: within one frame (Part XI §196). */
export const KEYSTROKE_BUDGET_MS = FRAME_BUDGET_MS;
/** Headroom reserved for the hot path before admitting background work. */
export const HOT_PATH_RESERVE_MS = 2;
/** A frame this fraction over budget tops the warn band; beyond it is a breach. */
export const LONG_FRAME_TOLERANCE = 0.5;

function finite(n: number): number {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Work classification — what runs on the hot path vs. what must yield.
// ---------------------------------------------------------------------------

export type WorkKind =
  // hot path — user-perceived input→paint work
  | 'keystroke'
  | 'caret'
  | 'scroll'
  | 'render'
  | 'layout'
  | 'selection'
  // background — deferrable work that must never breach the hot path
  | 'ai'
  | 'completion'
  | 'index'
  | 'agent'
  | 'lint'
  | 'search'
  | 'embed'
  | 'git'
  | 'telemetry';

const HOT_PATH_KINDS: ReadonlySet<WorkKind> = new Set<WorkKind>([
  'keystroke',
  'caret',
  'scroll',
  'render',
  'layout',
  'selection',
]);

/** True when a unit of work is on the interactive hot path (must not be delayed). */
export function isHotPath(kind: WorkKind): boolean {
  return HOT_PATH_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Latency statistics + frame grading.
// ---------------------------------------------------------------------------

export interface LatencyStats {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of an ascending-sorted array (1-based rank). */
function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

/** Compute count / mean / p50 / p95 / p99 / max over positive finite samples. */
export function computeLatencyStats(samples: readonly number[]): LatencyStats {
  const clean = samples.map(finite).filter((v) => v > 0);
  const n = clean.length;
  if (n === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: n,
    mean: sum / n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1]!,
  };
}

export type LatencyGrade = 'ok' | 'warn' | 'breach';

export interface FrameGrade {
  grade: LatencyGrade;
  stats: LatencyStats;
  budgetMs: number;
  /** Frames slower than the budget. */
  longFrames: number;
  /** longFrames / count (0 when no samples). */
  longFrameRatio: number;
  summary: string;
}

/**
 * Grade a run of frame intervals against the 60fps budget. `ok` when p95 is within
 * budget, `warn` up to the tolerance ceiling, `breach` beyond — the hot path is
 * janky and background work must yield harder.
 */
export function gradeFrames(
  samples: readonly number[],
  budgetMs: number = FRAME_BUDGET_MS,
  tolerance: number = LONG_FRAME_TOLERANCE,
): FrameGrade {
  const budget = budgetMs > 0 ? budgetMs : FRAME_BUDGET_MS;
  const stats = computeLatencyStats(samples);
  const clean = samples.map(finite).filter((v) => v > 0);
  const longFrames = clean.filter((v) => v > budget).length;
  const longFrameRatio = clean.length > 0 ? longFrames / clean.length : 0;
  const warnCeil = budget * (1 + Math.max(0, tolerance));
  let grade: LatencyGrade;
  if (stats.count === 0 || stats.p95 <= budget) grade = 'ok';
  else if (stats.p95 <= warnCeil) grade = 'warn';
  else grade = 'breach';
  const summary =
    stats.count === 0
      ? 'No frames sampled.'
      : `p95 ${stats.p95.toFixed(1)} ms (budget ${budget.toFixed(1)} ms), ${longFrames}/${stats.count} long frames.`;
  return { grade, stats, budgetMs: budget, longFrames, longFrameRatio, summary };
}

/** One-line advice for a hot-path grade (surfaced in the Performance panel). */
export function hotPathAdvice(grade: LatencyGrade): string {
  switch (grade) {
    case 'ok':
      return 'Frame-perfect \u2014 editing stays within the 60fps budget.';
    case 'warn':
      return 'Occasional long frames \u2014 background work should yield more aggressively.';
    case 'breach':
      return 'Janky \u2014 defer AI/index/agent work off the frame (INV-1).';
  }
}

// ---------------------------------------------------------------------------
// Background yielding — keep AI/index/agents off the hot path (INV-1).
// ---------------------------------------------------------------------------

/** Milliseconds left in the current frame after the work already done this frame. */
export function frameHeadroom(frameUsedMs: number, budgetMs: number = FRAME_BUDGET_MS): number {
  const budget = budgetMs > 0 ? budgetMs : FRAME_BUDGET_MS;
  return Math.max(0, budget - finite(frameUsedMs));
}

/**
 * Should a background task be deferred to a later idle slice to protect the hot
 * path? True when running it now would leave less than the reserved headroom, so a
 * keystroke or scroll would miss its frame.
 */
export function shouldDeferBackground(
  frameUsedMs: number,
  taskEstMs: number,
  budgetMs: number = FRAME_BUDGET_MS,
  reserveMs: number = HOT_PATH_RESERVE_MS,
): boolean {
  const budget = budgetMs > 0 ? budgetMs : FRAME_BUDGET_MS;
  return finite(frameUsedMs) + finite(taskEstMs) + Math.max(0, reserveMs) > budget;
}

export interface BackgroundTask {
  id: string;
  estMs: number;
}

export interface YieldPlan {
  /** Task ids to run in this frame's remaining budget. */
  admit: string[];
  /** Task ids pushed to a later idle slice. */
  defer: string[];
  /** Projected frame time (ms) after the admitted work. */
  usedMs: number;
}

/**
 * Split queued background tasks into those that fit the current frame's remaining
 * budget (admit) and those deferred to a later idle slice, in queue order. A fully
 * idle frame always admits at least one task (starvation guard) even if it is
 * individually larger than a frame, so background work keeps making progress.
 */
export function planYield(
  tasks: readonly BackgroundTask[],
  budgetMs: number = FRAME_BUDGET_MS,
  frameUsedMs: number = 0,
  reserveMs: number = HOT_PATH_RESERVE_MS,
): YieldPlan {
  const budget = budgetMs > 0 ? budgetMs : FRAME_BUDGET_MS;
  const reserve = Math.max(0, reserveMs);
  const admit: string[] = [];
  const defer: string[] = [];
  let used = Math.max(0, finite(frameUsedMs));
  for (const t of tasks) {
    const est = finite(t.estMs);
    if (used + est + reserve <= budget) {
      admit.push(t.id);
      used += est;
    } else {
      defer.push(t.id);
    }
  }
  // Starvation guard: an idle frame that admitted nothing runs the first task.
  if (admit.length === 0 && defer.length > 0 && finite(frameUsedMs) <= 0 && tasks.length > 0) {
    const first = tasks[0]!;
    admit.push(first.id);
    defer.shift();
    used += finite(first.estMs);
  }
  return { admit, defer, usedMs: used };
}
