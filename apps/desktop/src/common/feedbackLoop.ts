/**
 * Post-GA stabilization & feedback loop (Phase 287).
 *
 * PURE module (no I/O, no Electron). Aggregates post-release SIGNALS — crashes,
 * telemetry anomalies, user reports, store reviews — into a single, prioritized
 * STABILIZATION BACKLOG: signals are grouped by issue, weighted by source (a crash
 * outranks a telemetry blip) × occurrences × severity, and sorted worst-first so the
 * team fixes what hurts users most. The Main services feed real signals (crash
 * journal, telemetry buffer); this decides priority. Deterministic.
 */

export type FeedbackSource = 'crash' | 'telemetry' | 'user-report' | 'review';
export type FeedbackSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface FeedbackSignal {
  source: FeedbackSource;
  /** Issue title — signals with the same title are grouped. */
  title: string;
  /** How many times observed (default 1). */
  count?: number;
  severity?: FeedbackSeverity;
}

const SOURCE_WEIGHT: Record<FeedbackSource, number> = {
  crash: 5,
  'user-report': 3,
  review: 2,
  telemetry: 1,
};
const SEVERITY_MULT: Record<FeedbackSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0.5,
};

export interface BacklogItem {
  title: string;
  /** The distinct sources that reported this issue. */
  sources: FeedbackSource[];
  occurrences: number;
  score: number;
  topSeverity: FeedbackSeverity;
}

export interface StabilizationBacklog {
  backlog: BacklogItem[];
  totalOccurrences: number;
  summary: string;
}

const SEV_RANK: Record<FeedbackSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate feedback signals into a prioritized stabilization backlog. */
export function buildStabilizationBacklog(
  signals: readonly FeedbackSignal[],
): StabilizationBacklog {
  interface Acc {
    title: string;
    sources: Set<FeedbackSource>;
    occurrences: number;
    score: number;
    topSev: FeedbackSeverity;
  }
  const byTitle = new Map<string, Acc>();
  let totalOccurrences = 0;

  for (const s of signals) {
    const key = s.title.replace(/\s+/g, ' ').trim().toLowerCase();
    const count = s.count && s.count > 0 ? Math.floor(s.count) : 1;
    const severity = s.severity ?? 'medium';
    const contrib = SOURCE_WEIGHT[s.source] * count * SEVERITY_MULT[severity];
    totalOccurrences += count;
    const acc = byTitle.get(key);
    if (acc) {
      acc.sources.add(s.source);
      acc.occurrences += count;
      acc.score += contrib;
      if (SEV_RANK[severity] > SEV_RANK[acc.topSev]) acc.topSev = severity;
    } else {
      byTitle.set(key, {
        title: s.title.trim(),
        sources: new Set([s.source]),
        occurrences: count,
        score: contrib,
        topSev: severity,
      });
    }
  }

  const backlog: BacklogItem[] = [...byTitle.values()]
    .map((a) => ({
      title: a.title,
      sources: [...a.sources].sort((x, y) => SOURCE_WEIGHT[y] - SOURCE_WEIGHT[x]),
      occurrences: a.occurrences,
      score: round(a.score),
      topSeverity: a.topSev,
    }))
    .sort(
      (a, b) =>
        b.score - a.score || b.occurrences - a.occurrences || a.title.localeCompare(b.title),
    );

  const top = backlog[0];
  const summary =
    backlog.length === 0
      ? 'Stabilization: no feedback signals.'
      : `Stabilization backlog: ${backlog.length} issue(s), ${totalOccurrences} occurrence(s)` +
        (top ? ` · top: "${top.title}" (score ${top.score})` : '') +
        '.';

  return { backlog, totalOccurrences, summary };
}
