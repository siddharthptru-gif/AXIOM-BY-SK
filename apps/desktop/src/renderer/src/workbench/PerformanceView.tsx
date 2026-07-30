import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronIcon } from './treeIcons';
import {
  summarizeBudgets,
  formatMetric,
  type Measurement,
  type BudgetSummary,
} from '../../../common/perfBudget';
import { watchdogLevel, watchdogAdvice, type WatchdogLevel } from '../../../common/memoryWatchdog';
import type { StartupReport } from '../../../common/startupTiming';
import type { StartupPlan } from '../../../common/startupPlan';
import {
  analyzeSoak,
  pushSample,
  type HeapSample,
  type SoakResult,
} from '../../../common/memorySoak';
import { gradeFrames, hotPathAdvice, type FrameGrade } from '../../../common/hotPath';
import {
  summarizeRepoHardening,
  classifyRepoScale,
  planScopedIndex,
  planIndexSchedule,
  type RepoScale,
} from '../../../common/largeRepo';
import type { CompatReport } from '../../../common/compatMatrix';
import { analyzeMetrics, type Metric } from '../../../common/improvementEngine';
import { buildStabilizationBacklog, type FeedbackSignal } from '../../../common/feedbackLoop';
import { useWorkspace } from '../state/workspace';

/**
 * Performance panel (PRD Epoch J §194 / Phase 265). Measures real in-app metrics
 * (renderer DOM-ready from the Navigation Timing API, and JS heap usage where the
 * runtime exposes it) and checks them against the performance budgets, showing
 * pass / warn / fail. The budget engine is the pure `common/perfBudget` module.
 * (Full CI perf gates on reference hardware are a separate, out-of-app concern.)
 */
function measure(): Measurement[] {
  const out: Measurement[] = [];
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    if (nav && nav.domContentLoadedEventEnd > 0) {
      out.push({ id: 'domReady', value: nav.domContentLoadedEventEnd });
    }
  } catch {
    /* navigation timing unavailable */
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  if (mem && typeof mem.usedJSHeapSize === 'number') {
    out.push({ id: 'idleMemory', value: mem.usedJSHeapSize / (1024 * 1024) });
  }
  return out;
}

/** Current used JS heap in MB, or null when the runtime doesn't expose it. */
function readHeapMb(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return mem && typeof mem.usedJSHeapSize === 'number' ? mem.usedJSHeapSize / (1024 * 1024) : null;
}

export function PerformanceView() {
  const { rootPath, activePath } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [startup, setStartup] = useState<StartupReport | null>(null);
  // Deferred-init plan (PRD Phase 268): critical-path budget verdict + phase schedule.
  const [startupPlan, setStartupPlan] = useState<StartupPlan | null>(null);
  // Memory-soak trend (PRD Phases 266/267): a ring buffer of heap samples analyzed
  // for a slow upward drift a soak test would reveal.
  const samplesRef = useRef<HeapSample[]>([]);
  const [soak, setSoak] = useState<SoakResult | null>(null);
  // Hot-path frame latency (PRD Phase 269 / INV-1): sample frame intervals via
  // requestAnimationFrame and grade them against the 60fps budget.
  const frameSamplesRef = useRef<number[]>([]);
  const [frameGrade, setFrameGrade] = useState<FrameGrade | null>(null);
  // Large-repository hardening (PRD Phase 267): classify the repo by file count.
  const [repoScale, setRepoScale] = useState<{
    summary: string;
    scale: RepoScale;
    indexPlan: string;
  } | null>(null);
  // Environment compatibility (PRD Phase 276): probe OS/arch/GPU/shell/locale tiers.
  const [compat, setCompat] = useState<CompatReport | null>(null);

  const sampleHeap = useCallback((): void => {
    const heapMb = readHeapMb();
    if (heapMb === null) return;
    samplesRef.current = pushSample(samplesRef.current, { t: Date.now(), heapMb });
    setSoak(analyzeSoak(samplesRef.current));
  }, []);

  const refresh = useCallback((): void => {
    const local = measure();
    sampleHeap();
    // Merge the main-process startup report (real cold-start marks) with the local
    // renderer metrics. Local measurements are ordered last so the renderer's own
    // navigation-timing domReady wins over the startup fallback; coldStart comes
    // only from the main process. Best-effort — fall back to local-only on error.
    void window.axiom.perf
      .startupReport()
      .then((res) => {
        setStartup(res.report);
        setStartupPlan(res.plan);
        setSummary(summarizeBudgets([...res.measurements, ...local]));
      })
      .catch(() => {
        setStartup(null);
        setStartupPlan(null);
        setSummary(summarizeBudgets(local));
      });
  }, [sampleHeap]);

  useEffect(() => {
    if (!collapsed) refresh();
  }, [collapsed, refresh]);

  // While the panel is open, sample the heap periodically to build a soak trend.
  useEffect(() => {
    if (collapsed) return;
    const timer = window.setInterval(sampleHeap, 10_000);
    return () => window.clearInterval(timer);
  }, [collapsed, sampleHeap]);

  // While the panel is open, sample frame intervals (rAF) and grade the hot path
  // against the 60fps budget once enough frames are collected (PRD Phase 269).
  useEffect(() => {
    if (collapsed) return;
    frameSamplesRef.current = [];
    setFrameGrade(null);
    let raf = 0;
    let last = performance.now();
    const MAX = 240; // ~4s of frames at 60fps
    const tick = (now: number): void => {
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 1000) {
        const buf = frameSamplesRef.current;
        buf.push(dt);
        if (buf.length > MAX) buf.shift();
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    const grader = window.setInterval(() => {
      if (frameSamplesRef.current.length >= 10) {
        setFrameGrade(gradeFrames(frameSamplesRef.current));
      }
    }, 1000);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(grader);
    };
  }, [collapsed]);

  // While open, classify the repository scale for the hardening readout (Phase 267).
  useEffect(() => {
    if (collapsed || !rootPath) return;
    let active = true;
    void window.axiom.core.project
      .understand(rootPath)
      .then((p) => {
        if (active) {
          // Scoped incremental index plan (Phase 267 depth): the scale-appropriate
          // budget + projected batch count, with recent/open files first. The active
          // file is fed as the priority head; the full candidate walk comes from the
          // Rust walker (out of this sandbox).
          const strat = planScopedIndex(p.totalFiles);
          const indexed = Math.min(p.totalFiles, strat.maxIndexedFiles);
          const projBatches = Math.max(1, Math.ceil(indexed / 500));
          const head = planIndexSchedule(
            activePath ? [{ path: activePath, active: true, open: true }] : [],
            p.totalFiles,
          );
          setRepoScale({
            summary: summarizeRepoHardening(p.totalFiles),
            scale: classifyRepoScale(p.totalFiles),
            indexPlan: `${head.mode} index — ~${indexed.toLocaleString()} of ${p.totalFiles.toLocaleString()} files in ~${projBatches} batch(es); recent + open first`,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [collapsed, rootPath, activePath]);

  // While open, fetch the environment compatibility report once (Phase 276).
  useEffect(() => {
    if (collapsed) return;
    let active = true;
    void window.axiom.compat
      .report()
      .then((r) => {
        if (active) setCompat(r);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [collapsed]);

  return (
    <div className="perf-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">Performance</span>
        {!collapsed && summary && summary.results.length > 0 ? (
          <span className={`oe-count perf-worst-${summary.worst}`}>{summary.worst}</span>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="perf-body">
          {!summary || summary.results.length === 0 ? (
            <div className="outline-empty">No measurable metrics in this runtime.</div>
          ) : (
            summary.results.map((r) => (
              <div key={r.budget.id} className="perf-row">
                <span className={`perf-dot perf-${r.status}`} title={r.status} />
                <span className="perf-label">{r.budget.label}</span>
                <span className="perf-value">
                  {formatMetric(r.value, r.budget.unit)}
                  <span className="perf-budget">
                    {' / '}
                    {formatMetric(r.budget.limit, r.budget.unit)}
                  </span>
                </span>
              </div>
            ))
          )}
          <button type="button" className="btn btn-ghost perf-refresh" onClick={refresh}>
            {'\u21BB'} Re-measure
          </button>
          {startup && startup.phases.length > 0 ? (
            <div className="perf-startup">
              <div className="perf-row">
                <span className="perf-label">Startup phases</span>
                <span className="perf-value">{Math.round(startup.totalMs)} ms total</span>
              </div>
              {startup.phases.map((p) => (
                <div key={p.phase} className="perf-row perf-startup-row">
                  <span className="perf-label">{p.phase}</span>
                  <span className="perf-value">
                    +{Math.round(p.offsetMs)} ms
                    <span className="perf-budget">
                      {' ('}
                      {Math.round(p.durationMs)} ms{')'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {startupPlan ? (
            <div
              className={`perf-watchdog perf-wd-${startupPlan.budgetOk ? 'ok' : 'hard'}`}
              title="Startup deferred-init plan (PRD Phase 268)"
            >
              <span className={`perf-dot perf-${startupPlan.budgetOk ? 'pass' : 'fail'}`} />
              Startup plan: critical {Math.round(startupPlan.criticalPathMs)}/{startupPlan.budgetMs}{' '}
              ms{' '}
              {startupPlan.budgetOk ? 'OK' : `OVER by ${Math.round(startupPlan.overBudgetMs)} ms`} ·{' '}
              {startupPlan.phases.deferred.length} deferred, {startupPlan.phases.idle.length} idle
            </div>
          ) : null}
          {(() => {
            const mem = summary?.results.find((r) => r.budget.id === 'idleMemory');
            if (!mem) return null;
            const level: WatchdogLevel = watchdogLevel(mem.value);
            return (
              <div
                className={`perf-watchdog perf-wd-${level}`}
                title="Memory watchdog (PRD Phase 266)"
              >
                <span
                  className={`perf-dot perf-${level === 'ok' ? 'pass' : level === 'soft' ? 'warn' : 'fail'}`}
                />
                Memory watchdog: {level} — {watchdogAdvice(level)}
              </div>
            );
          })()}
          {soak && soak.samples >= 5 ? (
            <div
              className={`perf-watchdog perf-wd-${
                soak.trend === 'ok' ? 'ok' : soak.trend === 'suspect' ? 'soft' : 'hard'
              }`}
              title="Memory soak trend (PRD Phases 266/267)"
            >
              <span
                className={`perf-dot perf-${
                  soak.trend === 'ok' ? 'pass' : soak.trend === 'suspect' ? 'warn' : 'fail'
                }`}
              />
              Memory trend: {soak.trend} — {soak.reason}
            </div>
          ) : null}
          {frameGrade && frameGrade.stats.count >= 10 ? (
            <div
              className={`perf-watchdog perf-wd-${
                frameGrade.grade === 'ok' ? 'ok' : frameGrade.grade === 'warn' ? 'soft' : 'hard'
              }`}
              title="Hot-path frame latency (PRD Phase 269 / INV-1)"
            >
              <span
                className={`perf-dot perf-${
                  frameGrade.grade === 'ok' ? 'pass' : frameGrade.grade === 'warn' ? 'warn' : 'fail'
                }`}
              />
              Hot path: p95 {frameGrade.stats.p95.toFixed(1)} ms · {frameGrade.longFrames}/
              {frameGrade.stats.count} long — {hotPathAdvice(frameGrade.grade)}
            </div>
          ) : null}
          {repoScale ? (
            <div
              className={`perf-watchdog perf-wd-${
                repoScale.scale === 'small' || repoScale.scale === 'medium'
                  ? 'ok'
                  : repoScale.scale === 'large'
                    ? 'soft'
                    : 'hard'
              }`}
              title="Large-repository hardening (PRD Phase 267)"
            >
              <span
                className={`perf-dot perf-${
                  repoScale.scale === 'small' || repoScale.scale === 'medium'
                    ? 'pass'
                    : repoScale.scale === 'large'
                      ? 'warn'
                      : 'fail'
                }`}
              />
              Repo: {repoScale.summary}
            </div>
          ) : null}
          {repoScale ? (
            <div
              className="perf-row perf-startup-row"
              title="Scoped incremental index plan (PRD Phase 267)"
            >
              <span className="perf-label">Index plan</span>
              <span className="perf-value">{repoScale.indexPlan}</span>
            </div>
          ) : null}
          {compat ? (
            <div
              className={`perf-watchdog perf-wd-${
                compat.overall === 'supported'
                  ? 'ok'
                  : compat.overall === 'degraded'
                    ? 'soft'
                    : 'hard'
              }`}
              title="Environment compatibility (PRD Phase 276)"
            >
              <span
                className={`perf-dot perf-${
                  compat.overall === 'supported'
                    ? 'pass'
                    : compat.overall === 'degraded'
                      ? 'warn'
                      : 'fail'
                }`}
              />
              Compatibility: {compat.summary}
            </div>
          ) : null}
          {summary && summary.results.length > 0
            ? (() => {
                // Continuous improvement (Phase 290) + stabilization feedback loop
                // (Phase 287) fed by the real performance-budget results.
                const metrics: Metric[] = summary.results.map((r) => ({
                  id: r.budget.label,
                  value: r.value,
                  target: r.budget.limit,
                  direction: 'lower',
                }));
                const imp = analyzeMetrics(metrics);
                const signals: FeedbackSignal[] = summary.results
                  .filter((r) => r.status !== 'pass')
                  .map((r) => ({
                    source: 'telemetry' as const,
                    title: `${r.budget.label} over budget`,
                    severity: r.status === 'fail' ? ('high' as const) : ('medium' as const),
                  }));
                const backlog = buildStabilizationBacklog(signals);
                return (
                  <>
                    <div
                      className="perf-row perf-startup-row"
                      title="Continuous improvement (PRD Phase 290)"
                    >
                      <span className="perf-label">Improve</span>
                      <span className="perf-value">{imp.summary}</span>
                    </div>
                    {backlog.backlog.length > 0 ? (
                      <div
                        className="perf-row perf-startup-row"
                        title="Stabilization feedback loop (PRD Phase 287)"
                      >
                        <span className="perf-label">Stabilize</span>
                        <span className="perf-value">{backlog.summary}</span>
                      </div>
                    ) : null}
                  </>
                );
              })()
            : null}
        </div>
      )}
    </div>
  );
}
