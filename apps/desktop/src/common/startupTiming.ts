import type { Measurement } from './perfBudget';
import type { StartupPlan } from './startupPlan';

/**
 * Startup-phase timing (PRD Epoch J §194 / Phase 266). Pure logic that turns a set
 * of named startup marks (each an offset in ms from process start) into a phase
 * breakdown — per-phase duration + cumulative offset + total startup time — and
 * maps that into the performance-budget engine's Measurement list (total ->
 * cold/warm start, the dom-ready mark -> the domReady budget). No I/O: a Main
 * service records the real marks and the renderer renders the report. Smoke-tested.
 * (Full V8-snapshot startup tuning + CI-on-reference-HW gates are out of the sandbox.)
 */

/** A single instant during startup, measured in ms since process start. */
export interface StartupMark {
  phase: string;
  at: number;
}

/** One resolved phase: when it completed (offset from origin) and how long it took. */
export interface StartupPhase {
  phase: string;
  /** Offset from process start (ms) at which this mark occurred. */
  offsetMs: number;
  /** Time since the previous mark (ms). */
  durationMs: number;
}

export interface StartupReport {
  phases: StartupPhase[];
  /** Total time from the first to the last mark (ms). */
  totalMs: number;
}

/** The mark whose offset represents "renderer DOM ready" (maps to the domReady budget). */
export const DOM_READY_MARK = 'dom-ready';

/**
 * Build a phase breakdown from raw marks. Marks are sorted by time; the earliest is
 * the origin. Each subsequent mark becomes a phase whose duration is the gap since
 * the previous mark. Invalid (non-finite) marks are dropped; negatives are clamped.
 */
export function buildStartupReport(marks: readonly StartupMark[]): StartupReport {
  const valid = marks.filter((m) => typeof m.at === 'number' && Number.isFinite(m.at));
  const sorted = [...valid].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) return { phases: [], totalMs: 0 };

  const origin = sorted[0]!.at;
  const phases: StartupPhase[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    phases.push({
      phase: cur.phase,
      offsetMs: Math.max(0, cur.at - origin),
      durationMs: Math.max(0, cur.at - prev.at),
    });
  }
  const totalMs = Math.max(0, sorted[sorted.length - 1]!.at - origin);
  return { phases, totalMs };
}

/**
 * Map a startup report into performance-budget measurements: the total time maps to
 * the cold-start budget (or warm start when `warm` is true), and the dom-ready mark's
 * offset maps to the domReady budget when present.
 */
export function startupMeasurements(report: StartupReport, warm = false): Measurement[] {
  const out: Measurement[] = [{ id: warm ? 'warmStart' : 'coldStart', value: report.totalMs }];
  const dom = report.phases.find((p) => p.phase === DOM_READY_MARK);
  if (dom) out.push({ id: 'domReady', value: dom.offsetMs });
  return out;
}

/** A compact human-readable rendering of the report. */
export function formatStartupReport(report: StartupReport): string {
  if (report.phases.length === 0) return 'No startup marks recorded.';
  const lines = report.phases.map(
    (p) => `  ${p.phase}: +${Math.round(p.offsetMs)}ms (${Math.round(p.durationMs)}ms)`,
  );
  return `Startup ${Math.round(report.totalMs)}ms\n${lines.join('\n')}`;
}

/** The IPC payload: the report plus its budget measurements + the deferred-init plan. */
export interface StartupReportResult {
  report: StartupReport;
  measurements: Measurement[];
  /** Phase 268 deferred-init plan (critical-path budget + phase schedule). */
  plan: StartupPlan;
}
