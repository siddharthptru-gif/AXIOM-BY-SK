import { performance } from 'node:perf_hooks';
import {
  buildStartupReport,
  startupMeasurements,
  type StartupMark,
  type StartupReport,
  type StartupReportResult,
} from '../../common/startupTiming';
import { planStartup, type StartupPlan, type StartupTask } from '../../common/startupPlan';

/**
 * Startup-phase timing service (Main, PRD Epoch J / Phases 266 + 268). Records real
 * lifecycle marks as offsets (ms) from process start via performance.now(), so the
 * total is a genuine cold-start measurement. main/index.ts marks 'app-ready' and
 * 'window-created'; the renderer reports 'dom-ready' once (via IPC) when it mounts.
 * getStartupReport() folds the marks into a phase breakdown + budget measurements
 * (Phase 266) + a deferred-init PLAN (Phase 268): the recorded pre-paint marks are
 * classified as the CRITICAL path (with their real measured durations as estMs),
 * while the known post-first-paint init steps are classified deferred/idle so the
 * planner can report the critical-path budget verdict + what runs off the paint path.
 * Pure logic lives in common (startupTiming + startupPlan); this only captures time.
 */
const marks: StartupMark[] = [{ phase: 'process', at: 0 }];
let domReadyRecorded = false;

/**
 * Known post-first-paint initialization steps the app runs OFF the critical path
 * (Phase 268). Their estMs are 0 until per-step instrumentation lands (honest
 * partial — measured deferred timings + a V8 startup snapshot are follow-ups); the
 * value here is the classification + dependency graph that keeps them off the paint
 * path. Deps reference the recorded critical marks (unknown ids are ignored).
 */
const DEFERRED_INIT_STEPS: StartupTask[] = [
  { id: 'core-sidecar', phase: 'deferred', estMs: 0, deps: ['window-created'] },
  { id: 'workspace-index', phase: 'deferred', estMs: 0, deps: ['core-sidecar'] },
  { id: 'file-watcher', phase: 'deferred', estMs: 0, deps: ['core-sidecar'] },
  { id: 'lsp-servers', phase: 'deferred', estMs: 0, deps: ['dom-ready'] },
  { id: 'prefs-sync', phase: 'idle', estMs: 0, deps: ['dom-ready'] },
  { id: 'telemetry-flush', phase: 'idle', estMs: 0 },
];

/** Record a named startup mark at the current offset from process start. */
export function markStartup(phase: string): void {
  marks.push({ phase, at: Math.round(performance.now()) });
}

/** Record the renderer 'dom-ready' mark exactly once (ignores repeat calls). */
export function markDomReady(): void {
  if (domReadyRecorded) return;
  domReadyRecorded = true;
  markStartup('dom-ready');
}

/**
 * Classify the app's startup into planner tasks (Phase 268): each recorded pre-paint
 * mark is a CRITICAL task chained to the previous one (real durations as estMs),
 * followed by the known deferred/idle init steps.
 */
export function buildStartupTasks(report: StartupReport): StartupTask[] {
  const critical: StartupTask[] = [];
  let prev: string | undefined;
  for (const p of report.phases) {
    critical.push({
      id: p.phase,
      phase: 'critical',
      estMs: Math.round(p.durationMs),
      ...(prev !== undefined ? { deps: [prev] } : {}),
    });
    prev = p.phase;
  }
  return [...critical, ...DEFERRED_INIT_STEPS];
}

/** The current deferred-init plan (critical-path budget + phase schedule). */
export function getStartupPlan(): StartupPlan {
  return planStartup(buildStartupTasks(buildStartupReport(marks)));
}

/** The current startup report + its performance-budget measurements + the plan. */
export function getStartupReport(): StartupReportResult {
  const report = buildStartupReport(marks);
  return {
    report,
    measurements: startupMeasurements(report),
    plan: planStartup(buildStartupTasks(report)),
  };
}
