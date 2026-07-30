/**
 * Ambient codebase health (Phase 259 — Ambient Codebase Health Agent).
 *
 * PURE module (no I/O, no Electron). Aggregates health SIGNALS (failing tests, lint,
 * security findings, dependency risk, dead code, doc drift) collected cheaply in the
 * background into a single health SCORE, a per-kind breakdown, and a PRIORITIZED,
 * fixable-first backlog. The background agent gathers the signals (from the existing
 * scanners) + a cheap/local model; this decides what matters most. Deterministic.
 */

export type HealthKind =
  'failing-test' | 'lint' | 'security' | 'dep-risk' | 'dead-code' | 'doc-drift';

export type HealthSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface HealthSignal {
  kind: HealthKind;
  severity: HealthSeverity;
  title: string;
  /** How many occurrences (default 1). */
  count?: number;
  /** Can this be auto/one-click fixed? Fixable items rank first at equal severity. */
  fixable?: boolean;
}

const SEVERITY_RANK: Record<HealthSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
const SEVERITY_PENALTY: Record<HealthSeverity, number> = {
  critical: 15,
  high: 8,
  medium: 3,
  low: 1,
};

export interface HealthReport {
  /** 0..100 (100 = healthy), or `null` when no scans were run (unassessed). */
  score: number | null;
  /** True when at least one scan kind was actually run. */
  assessed: boolean;
  /** The scan kinds that were actually run (coverage), sorted. */
  assessedKinds: HealthKind[];
  total: number;
  byKind: Record<HealthKind, number>;
  /** Signals sorted worst-first, fixable-first at equal severity. */
  prioritized: HealthSignal[];
  fixableCount: number;
  summary: string;
}

function emptyByKind(): Record<HealthKind, number> {
  return {
    'failing-test': 0,
    lint: 0,
    security: 0,
    'dep-risk': 0,
    'dead-code': 0,
    'doc-drift': 0,
  };
}

/**
 * Aggregate health signals into a score + prioritized backlog.
 *
 * `assessedKinds` declares which scan kinds actually ran. This is what makes a
 * clean result honest: zero signals is only "healthy" for the kinds that were
 * scanned. If nothing was scanned, the score is `null` (unassessed) rather than a
 * misleading 100/100.
 */
export function aggregateHealth(
  signals: readonly HealthSignal[],
  assessedKinds: readonly HealthKind[] = [],
): HealthReport {
  const byKind = emptyByKind();
  let penalty = 0;
  let fixableCount = 0;
  for (const s of signals) {
    const count = s.count && s.count > 0 ? Math.floor(s.count) : 1;
    byKind[s.kind] += count;
    penalty += SEVERITY_PENALTY[s.severity] * count;
    if (s.fixable) fixableCount += 1;
  }

  // Any kind with a signal is implicitly assessed; union with the declared set.
  const coverage = new Set<HealthKind>(assessedKinds);
  for (const s of signals) coverage.add(s.kind);
  const assessedList = [...coverage].sort();
  const assessed = assessedList.length > 0;
  const score = assessed ? Math.max(0, Math.min(100, 100 - penalty)) : null;

  const prioritized = [...signals].sort((a, b) => {
    const sr = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sr !== 0) return sr;
    const fx = Number(b.fixable ?? false) - Number(a.fixable ?? false);
    if (fx !== 0) return fx;
    return a.title.localeCompare(b.title);
  });

  const worst = prioritized[0];
  const summary = !assessed
    ? 'Codebase health: not assessed — run a scan (secrets, SAST, dependencies, fitness) first.'
    : signals.length === 0
      ? `Codebase health: ${score}/100 — no issues across ${assessedList.length} scanned kind(s).`
      : `Codebase health: ${score}/100 — ${signals.length} signal(s), ${fixableCount} fixable` +
        (worst ? ` · top: ${worst.severity} ${worst.kind} (${worst.title})` : '') +
        '.';

  return {
    score,
    assessed,
    assessedKinds: assessedList,
    total: signals.length,
    byKind,
    prioritized,
    fixableCount,
    summary,
  };
}

/** The top-N fixable items to surface as one-click suggestions. */
export function topFixable(report: HealthReport, n = 5): HealthSignal[] {
  return report.prioritized.filter((s) => s.fixable === true).slice(0, Math.max(0, n));
}
