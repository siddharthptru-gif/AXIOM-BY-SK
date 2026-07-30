/**
 * Continuous improvement engine (Phase 290 — Continuous Improvement Engine &
 * Long-Term Roadmap).
 *
 * PURE module (no I/O, no Electron). Two jobs: (1) turn product METRICS (each with a
 * target + a good direction) into prioritized improvement SUGGESTIONS for the
 * off-target ones, plus an overall on-target score; (2) score a ROADMAP of candidate
 * improvements by value-per-effort (impact ÷ effort) so the highest-leverage work
 * rises to the top. The Main services feed real metrics (perf, spend, health); this
 * decides what to improve next. Deterministic.
 */

export interface Metric {
  id: string;
  value: number;
  target: number;
  /** Which direction is "good": higher (e.g. coverage) or lower (e.g. latency). */
  direction: 'higher' | 'lower';
  /** Importance multiplier (default 1). */
  weight?: number;
}

export interface ImprovementSuggestion {
  metric: string;
  /** Normalized shortfall from target (0 = on target). */
  gap: number;
  priority: number;
  suggestion: string;
}

export interface MetricsReport {
  suggestions: ImprovementSuggestion[];
  onTargetCount: number;
  total: number;
  /** Percentage of metrics meeting their target (0..100). */
  score: number;
  summary: string;
}

function meetsTarget(m: Metric): boolean {
  return m.direction === 'higher' ? m.value >= m.target : m.value <= m.target;
}

/** Normalized shortfall from target in [0,1] (0 when met). */
function gapOf(m: Metric): number {
  if (meetsTarget(m)) return 0;
  const denom = Math.abs(m.target) > 1e-9 ? Math.abs(m.target) : 1;
  const raw =
    m.direction === 'higher' ? (m.target - m.value) / denom : (m.value - m.target) / denom;
  return Math.max(0, Math.round(raw * 1000) / 1000);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Analyze metrics: prioritized suggestions for off-target ones + an on-target score. */
export function analyzeMetrics(metrics: readonly Metric[]): MetricsReport {
  const suggestions: ImprovementSuggestion[] = [];
  let onTargetCount = 0;
  for (const m of metrics) {
    if (meetsTarget(m)) {
      onTargetCount += 1;
      continue;
    }
    const gap = gapOf(m);
    const priority = round(gap * (m.weight ?? 1));
    suggestions.push({
      metric: m.id,
      gap,
      priority,
      suggestion:
        m.direction === 'higher'
          ? `Raise ${m.id} from ${m.value} toward ${m.target}.`
          : `Reduce ${m.id} from ${m.value} toward ${m.target}.`,
    });
  }
  suggestions.sort((a, b) => b.priority - a.priority || a.metric.localeCompare(b.metric));
  const total = metrics.length;
  const score = total > 0 ? Math.round((onTargetCount / total) * 100) : 100;
  const summary =
    total === 0
      ? 'No metrics tracked.'
      : `${score}% on target (${onTargetCount}/${total}); ${suggestions.length} improvement(s) suggested.`;
  return { suggestions, onTargetCount, total, score, summary };
}

export interface RoadmapItem {
  title: string;
  /** Business/user impact 1..5. */
  impact: number;
  /** Effort 1..5 (higher = costlier). */
  effort: number;
}

export interface ScoredRoadmapItem extends RoadmapItem {
  /** impact ÷ effort — value per unit effort. */
  score: number;
  rank: number;
}

const clamp15 = (n: number): number => Math.max(1, Math.min(5, Math.round(n)));

/** Score + rank a roadmap by value-per-effort (highest leverage first). */
export function scoreRoadmap(items: readonly RoadmapItem[]): ScoredRoadmapItem[] {
  return items
    .map((it) => {
      const impact = clamp15(it.impact);
      const effort = clamp15(it.effort);
      return { ...it, impact, effort, score: round(impact / effort) };
    })
    .sort((a, b) => b.score - a.score || b.impact - a.impact || a.title.localeCompare(b.title))
    .map((it, i) => ({ ...it, rank: i + 1 }));
}
