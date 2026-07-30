/**
 * Run-history view model (Phase 210/256 — Run history UI + resume/branch actions).
 *
 * PURE module (no I/O, no Electron, no React). It turns persisted RunRecords into
 * display rows for the run-history panel: a truncated title, a status label + class
 * suffix, a relative timestamp, the step/branch-point counts, and whether the
 * resume / branch actions apply. The renderer panel maps these straight onto rows +
 * buttons; the pure formatting/enablement logic lives here so it is unit-testable.
 */

import type { RunRecord, RunStatus } from './runJournal';
import { isRunResumable } from './runResume';
import { listBranchPoints } from './timeTravel';

export interface RunRowVM {
  id: string;
  /** Original task, truncated for a one-line row. */
  title: string;
  preset: string;
  status: RunStatus;
  /** Human label, e.g. "Needs approval". */
  statusLabel: string;
  /** Class suffix for a status dot/badge: ok | warn | fail | running | muted. */
  statusClass: 'ok' | 'warn' | 'fail' | 'running' | 'muted';
  /** Relative time of the last activity, e.g. "2m ago". */
  relTime: string;
  steps: number;
  /** How many steps can be branched/redone from (time-travel). */
  branchPoints: number;
  /** Can this run be resumed (not completed/cancelled)? */
  canResume: boolean;
  /** Can this run be branched (has at least one branch point)? */
  canBranch: boolean;
}

const STATUS_META: Record<RunStatus, { label: string; cls: RunRowVM['statusClass'] }> = {
  running: { label: 'Running', cls: 'running' },
  'awaiting-approval': { label: 'Needs approval', cls: 'warn' },
  completed: { label: 'Completed', cls: 'ok' },
  failed: { label: 'Failed', cls: 'fail' },
  cancelled: { label: 'Cancelled', cls: 'muted' },
};

/** Truncate a task to a single-line title. */
export function runTitle(task: string, max = 72): string {
  const t = task.replace(/\s+/g, ' ').trim();
  if (t.length === 0) return '(untitled run)';
  return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/** Compact relative time: "just now", "45s ago", "3m ago", "2h ago", "5d ago". */
export function formatRelTime(ts: number, now: number): string {
  const deltaMs = Math.max(0, now - ts);
  const s = Math.floor(deltaMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Build a display row for one run. */
export function toRunRow(run: RunRecord, now: number): RunRowVM {
  const meta = STATUS_META[run.status] ?? { label: run.status, cls: 'muted' as const };
  const branchPoints = listBranchPoints(run).length;
  const when = run.endedAt ?? run.startedAt;
  return {
    id: run.id,
    title: runTitle(run.task),
    preset: run.preset,
    status: run.status,
    statusLabel: meta.label,
    statusClass: meta.cls,
    relTime: formatRelTime(when, now),
    steps: run.steps.length,
    branchPoints,
    canResume: isRunResumable(run),
    canBranch: branchPoints > 0,
  };
}

/** Build display rows for a run list (input order preserved — caller sorts). */
export function toRunRows(runs: readonly RunRecord[], now: number): RunRowVM[] {
  return runs.map((r) => toRunRow(r, now));
}

/** One-line summary of a run set: total + resumable counts. */
export function runsSummary(runs: readonly RunRecord[]): string {
  if (runs.length === 0) return 'No agent runs yet.';
  const resumable = runs.filter((r) => isRunResumable(r)).length;
  return (
    `${runs.length} run${runs.length === 1 ? '' : 's'}` +
    (resumable > 0 ? ` · ${resumable} resumable` : '')
  );
}
