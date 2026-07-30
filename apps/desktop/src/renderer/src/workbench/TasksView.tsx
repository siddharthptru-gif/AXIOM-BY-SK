import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTask } from '../../../common/ipc';
import { ChevronIcon } from './treeIcons';
import { summarizeEvals, formatEvalSummary } from '../../../common/agentEval';
import { buildTimeline, summarizeRun, type RunRecord } from '../../../common/runJournal';
import {
  aggregateResults,
  canAdmit,
  freeSlots,
  type RunOutcome,
  type TaskResult,
} from '../../../common/agentScheduler';
import { isRunResumable } from '../../../common/runResume';
import { listBranchPoints } from '../../../common/timeTravel';
import { formatRelTime } from '../../../common/runsView';
import { useWorkspace } from '../state/workspace';
import { useSettings } from '../settings/store';
import { getAiSettings, getCustomProvider, parseHeaders } from '../settings/schema';
import { notifyInfo, notifyError } from '../notifications/bus';

/**
 * Agent Tasks panel (PRD Epoch H §72.5 / §149). Mission control for agent runs:
 * lists queued/running/awaiting-approval/completed/failed/cancelled tasks with
 * live status (background + parallel runs show here), step counts, and a stop
 * control. Collapsed by default; loads on expand and subscribes to live updates.
 */
const STATUS_LABEL: Record<AgentTask['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  'awaiting-approval': 'Needs approval',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Default bounded-pool ceiling for concurrent agents (PRD Phase 218/219). */
const MAX_CONCURRENT = 4;

/** Number of persisted runs added to the DOM at a time. */
const RUN_PAGE_SIZE = 50;

/** Map a finished run's status to a scheduler run outcome (PRD Phase 219). */
const RUN_OUTCOME: Partial<Record<RunRecord['status'], RunOutcome>> = {
  completed: 'success',
  failed: 'failure',
  cancelled: 'cancelled',
};

interface PendingReinvoke {
  kind: 'resume' | 'branch';
  branchIndex?: number;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeTaskUpdates(base: AgentTask[], updates: Iterable<AgentTask>): AgentTask[] {
  const byId = new Map(base.map((task) => [task.id, task]));
  for (const task of updates) byId.set(task.id, task);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function TasksView() {
  const [collapsed, setCollapsed] = useState(true);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runPage, setRunPage] = useState(0);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [clearingRuns, setClearingRuns] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [pendingReinvokes, setPendingReinvokes] = useState<Record<string, PendingReinvoke>>({});
  const [inlineErrors, setInlineErrors] = useState<Record<string, string>>({});
  const ws = useWorkspace();
  const { values } = useSettings();

  const mountedRef = useRef(false);
  const collapsedRef = useRef(collapsed);
  const taskListRequestRef = useRef(0);
  const runListRequestRef = useRef(0);
  const clearingRunsRef = useRef(false);
  const cancellingIdsRef = useRef(new Set<string>());
  const pendingReinvokesRef = useRef(new Map<string, PendingReinvoke>());
  collapsedRef.current = collapsed;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      taskListRequestRef.current += 1;
      runListRequestRef.current += 1;
    };
  }, []);

  const clearInlineError = useCallback((key: string): void => {
    if (!mountedRef.current) return;
    setInlineErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const reportInlineError = useCallback((key: string, title: string, error: unknown): void => {
    const detail = errorDetail(error);
    if (mountedRef.current) {
      setInlineErrors((current) => ({ ...current, [key]: `${title}: ${detail}` }));
    }
    notifyError(title, { source: 'Agent Tasks', detail });
  }, []);

  const finishCancellation = useCallback((id: string): void => {
    if (!cancellingIdsRef.current.delete(id) || !mountedRef.current) return;
    setCancellingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const reconcileCancellations = useCallback((list: AgentTask[]): void => {
    const cancellableIds = new Set(
      list
        .filter((task) => task.status === 'running' || task.status === 'awaiting-approval')
        .map((task) => task.id),
    );
    let changed = false;
    for (const id of cancellingIdsRef.current) {
      if (!cancellableIds.has(id)) {
        cancellingIdsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed && mountedRef.current) {
      setCancellingIds(new Set(cancellingIdsRef.current));
    }
  }, []);

  const loadRuns = useCallback(
    (showLoading = false): void => {
      if (!mountedRef.current || collapsedRef.current || clearingRunsRef.current) return;
      const root = ws.rootPath;
      if (!root) {
        setRuns([]);
        setRunsLoading(false);
        return;
      }
      const requestId = ++runListRequestRef.current;
      if (showLoading) setRunsLoading(true);
      clearInlineError('runs:list');
      void window.axiom.agent.runs
        .list(root)
        .then((list) => {
          if (
            !mountedRef.current ||
            collapsedRef.current ||
            requestId !== runListRequestRef.current
          ) {
            return;
          }
          setRuns(list);
          setRunPage(0);
        })
        .catch((error: unknown) => {
          if (
            !mountedRef.current ||
            collapsedRef.current ||
            requestId !== runListRequestRef.current
          ) {
            return;
          }
          reportInlineError('runs:list', 'Could not load run history', error);
        })
        .finally(() => {
          if (
            mountedRef.current &&
            !collapsedRef.current &&
            requestId === runListRequestRef.current
          ) {
            setRunsLoading(false);
          }
        });
    },
    [clearInlineError, reportInlineError, ws.rootPath],
  );

  /**
   * Resume/branch EXECUTION (Phase 210/256): ask Main to compose a fresh-run task
   * from the persisted run, then start a normal agent run with the current AI target.
   */
  const reinvoke = useCallback(
    (runId: string, kind: 'resume' | 'branch', branchIndex?: number): void => {
      const root = ws.rootPath;
      if (!root) {
        notifyInfo('Open a folder to resume or branch a run.', { source: 'Agent Tasks' });
        return;
      }
      if (pendingReinvokesRef.current.has(runId)) return;

      const pending: PendingReinvoke = {
        kind,
        ...(branchIndex !== undefined ? { branchIndex } : {}),
      };
      pendingReinvokesRef.current.set(runId, pending);
      setPendingReinvokes((current) => ({ ...current, [runId]: pending }));
      clearInlineError(`reinvoke:${runId}`);

      void (async () => {
        try {
          const req = await window.axiom.agent.runs.reinvoke(
            root,
            runId,
            kind,
            branchIndex !== undefined ? { branchIndex } : {},
          );
          if (!req || !req.ok) {
            notifyInfo(req?.reason ?? 'This run cannot be re-run.', { source: 'Agent Tasks' });
            return;
          }
          const ai = getAiSettings(values);
          const headers =
            ai.provider === 'custom' ? parseHeaders(getCustomProvider(values).headers) : {};
          await window.axiom.agent.run({
            id: crypto.randomUUID(),
            provider: ai.provider,
            model: ai.model,
            baseUrl: ai.baseUrl,
            headers,
            root,
            task: req.task,
            preset: req.preset,
            // Resume replays the source run's completed side-effecting steps
            // (Phase 210); branch intentionally redoes from a point, so no replay.
            ...(kind === 'resume' ? { resumeRunId: runId } : {}),
          });
          notifyInfo(
            kind === 'resume'
              ? 'Resumed run — see Agent Tasks.'
              : 'Branched run — see Agent Tasks.',
            { source: 'Agent Tasks' },
          );
          loadRuns();
        } catch (error: unknown) {
          reportInlineError(`reinvoke:${runId}`, 'Could not re-run task', error);
        } finally {
          pendingReinvokesRef.current.delete(runId);
          if (mountedRef.current) {
            setPendingReinvokes((current) => {
              if (current[runId] === undefined) return current;
              const next = { ...current };
              delete next[runId];
              return next;
            });
          }
        }
      })();
    },
    [clearInlineError, loadRuns, reportInlineError, values, ws.rootPath],
  );

  useEffect(() => {
    if (collapsed) {
      taskListRequestRef.current += 1;
      runListRequestRef.current += 1;
      setTasksLoading(false);
      setRunsLoading(false);
      return;
    }
    const root = ws.rootPath;
    if (!root) {
      setTasks([]);
      setRuns([]);
      setTasksLoading(false);
      setRunsLoading(false);
      return;
    }
    // Never retain the previous workspace's snapshot while this root is loading
    // or if its request fails.
    setTasks([]);
    setRuns([]);
    setExpandedRun(null);
    setRunPage(0);
    cancellingIdsRef.current.clear();
    setCancellingIds(new Set());

    let active = true;
    let snapshotPending = true;
    const bufferedUpdates = new Map<string, AgentTask>();
    const requestId = ++taskListRequestRef.current;
    const handleTaskUpdate = (task: AgentTask): void => {
      if (!active || !mountedRef.current || collapsedRef.current || task.root !== root) {
        return;
      }
      if (snapshotPending) bufferedUpdates.set(task.id, task);
      else setTasks((current) => mergeTaskUpdates(current, [task]));

      // A finished run is now persisted — refresh the history.
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        finishCancellation(task.id);
        loadRuns();
      }
    };
    // Subscribe before requesting the snapshot, then replay any intervening live
    // events so an older snapshot can never regress a newer task status.
    const unsub = window.axiom.agent.onTaskUpdate(handleTaskUpdate);

    setTasksLoading(true);
    clearInlineError('tasks:list');
    void window.axiom.agent
      .tasks(root)
      .then((list) => {
        if (
          !active ||
          !mountedRef.current ||
          collapsedRef.current ||
          requestId !== taskListRequestRef.current
        ) {
          return;
        }
        snapshotPending = false;
        const merged = mergeTaskUpdates(list, bufferedUpdates.values());
        bufferedUpdates.clear();
        setTasks(merged);
        reconcileCancellations(merged);
      })
      .catch((error: unknown) => {
        if (
          !active ||
          !mountedRef.current ||
          collapsedRef.current ||
          requestId !== taskListRequestRef.current
        ) {
          return;
        }
        snapshotPending = false;
        if (bufferedUpdates.size > 0) {
          setTasks((current) => mergeTaskUpdates(current, bufferedUpdates.values()));
          bufferedUpdates.clear();
        }
        reportInlineError('tasks:list', 'Could not load agent tasks', error);
      })
      .finally(() => {
        if (
          active &&
          mountedRef.current &&
          !collapsedRef.current &&
          requestId === taskListRequestRef.current
        ) {
          setTasksLoading(false);
        }
      });

    loadRuns(true);
    return () => {
      active = false;
      taskListRequestRef.current += 1;
      runListRequestRef.current += 1;
      unsub();
    };
  }, [
    clearInlineError,
    collapsed,
    finishCancellation,
    loadRuns,
    reconcileCancellations,
    reportInlineError,
    ws.rootPath,
  ]);

  const clearRuns = useCallback((): void => {
    const root = ws.rootPath;
    if (!root || clearingRunsRef.current) return;
    clearingRunsRef.current = true;
    runListRequestRef.current += 1;
    setRunsLoading(false);
    setClearingRuns(true);
    clearInlineError('runs:clear');

    void window.axiom.agent.runs
      .clear(root)
      .then(() => {
        runListRequestRef.current += 1;
        if (!mountedRef.current) return;
        clearInlineError('runs:list');
        setRuns([]);
        setExpandedRun(null);
        setRunPage(0);
      })
      .catch((error: unknown) => {
        reportInlineError('runs:clear', 'Could not clear run history', error);
      })
      .finally(() => {
        clearingRunsRef.current = false;
        if (mountedRef.current) {
          setClearingRuns(false);
          setRunsLoading(false);
        }
      });
  }, [clearInlineError, reportInlineError, ws.rootPath]);

  const cancel = useCallback(
    (id: string): void => {
      if (cancellingIdsRef.current.has(id)) return;
      cancellingIdsRef.current.add(id);
      setCancellingIds((current) => new Set(current).add(id));
      clearInlineError(`cancel:${id}`);

      void window.axiom.agent
        .cancel(id)
        .then(() => clearInlineError(`cancel:${id}`))
        .catch((error: unknown) => {
          reportInlineError(`cancel:${id}`, 'Could not stop task', error);
          finishCancellation(id);
        });
    },
    [clearInlineError, finishCancellation, reportInlineError],
  );

  const toggleCollapsed = useCallback((): void => {
    if (collapsed) {
      setTasksLoading(true);
      setRunsLoading(!clearingRunsRef.current);
    }
    setCollapsed(!collapsed);
  }, [collapsed]);

  const showOlderRuns = useCallback((): void => {
    setRunPage((current) => Math.min(Math.ceil(runs.length / RUN_PAGE_SIZE) - 1, current + 1));
  }, [runs.length]);

  const showNewerRuns = useCallback((): void => {
    setRunPage((current) => Math.max(0, current - 1));
  }, []);

  const { activeCount, queuedCount } = useMemo(() => {
    let active = 0;
    let queued = 0;
    for (const task of tasks) {
      if (task.status === 'running' || task.status === 'awaiting-approval') active += 1;
      if (task.status === 'queued') queued += 1;
    }
    return { activeCount: active, queuedCount: queued };
  }, [tasks]);

  const evalSummary = useMemo(() => summarizeEvals(tasks), [tasks]);
  const runAggregate = useMemo(() => {
    const runResults = runs
      .map((run): TaskResult | null => {
        const outcome = RUN_OUTCOME[run.status];
        return outcome ? { id: run.id, outcome, group: run.preset } : null;
      })
      .filter((result): result is TaskResult => result !== null);
    return runResults.length > 0 ? aggregateResults(runResults) : null;
  }, [runs]);
  const runPageStart = runPage * RUN_PAGE_SIZE;
  const runPageEnd = Math.min(runs.length, runPageStart + RUN_PAGE_SIZE);
  const visibleRuns = useMemo(
    () => runs.slice(runPageStart, runPageEnd),
    [runPageEnd, runPageStart, runs],
  );
  const newerRunCount = runPageStart;
  const olderRunCount = Math.max(0, runs.length - runPageEnd);
  const inlineErrorEntries = useMemo(() => Object.entries(inlineErrors), [inlineErrors]);
  const hasListError =
    inlineErrors['tasks:list'] !== undefined || inlineErrors['runs:list'] !== undefined;
  const loading = tasksLoading || runsLoading;
  const statusMessage = useMemo(() => {
    const messages: string[] = [];
    if (tasksLoading) messages.push('Loading agent tasks…');
    if (runsLoading) messages.push('Loading run history…');
    if (clearingRuns) messages.push('Clearing run history…');
    if (cancellingIds.size > 0) {
      messages.push(`Stopping ${cancellingIds.size} task${cancellingIds.size === 1 ? '' : 's'}…`);
    }
    const pending = Object.values(pendingReinvokes);
    const resumes = pending.filter((item) => item.kind === 'resume').length;
    const branches = pending.length - resumes;
    if (resumes > 0) messages.push(`Resuming ${resumes} run${resumes === 1 ? '' : 's'}…`);
    if (branches > 0) messages.push(`Branching ${branches} run${branches === 1 ? '' : 's'}…`);
    return messages.join(' ');
  }, [cancellingIds.size, clearingRuns, pendingReinvokes, runsLoading, tasksLoading]);

  return (
    <div className="tasks-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleCollapsed();
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">Agent Tasks</span>
        {!collapsed && activeCount > 0 ? <span className="oe-count">{activeCount}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="tasks-body">
          {statusMessage ? (
            <div className="tasks-evals-line" role="status" aria-live="polite" aria-atomic="true">
              {statusMessage}
            </div>
          ) : null}
          {inlineErrorEntries.length > 0 ? (
            <div role="alert" aria-live="assertive" aria-atomic="true">
              {inlineErrorEntries.map(([key, message]) => (
                <div key={key} className="tasks-evals-line">
                  {message}
                </div>
              ))}
            </div>
          ) : null}

          {tasks.length === 0 && runs.length === 0 ? (
            !loading && !hasListError ? (
              <div className="outline-empty">No agent runs yet.</div>
            ) : null
          ) : (
            <>
              {tasks.length > 0 ? (
                <>
                  <div className="tasks-evals" title="Agent evals (PRD Phase 238)">
                    <div className="tasks-evals-line">{formatEvalSummary(evalSummary)}</div>
                    {evalSummary.byPreset.length > 1 ? (
                      <div className="tasks-evals-presets">
                        {evalSummary.byPreset.slice(0, 6).map((preset) => (
                          <span key={preset.preset} className="tasks-evals-preset">
                            {preset.preset}: {Math.round(preset.successRate * 100)}%
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="tasks-evals-line" title="Bounded agent pool (PRD Phase 218/219)">
                    Pool: {activeCount} / {MAX_CONCURRENT} running
                    {queuedCount > 0 ? ` · ${queuedCount} queued` : ''}
                    {canAdmit(activeCount, MAX_CONCURRENT)
                      ? ` · ${freeSlots(activeCount, MAX_CONCURRENT)} free`
                      : ' · full'}
                  </div>
                  {tasks.map((task) => {
                    const cancelling = cancellingIds.has(task.id);
                    return (
                      <div key={task.id} className="task-row">
                        <span className={`task-badge task-badge-${task.status}`}>
                          {STATUS_LABEL[task.status]}
                        </span>
                        <span className="task-desc" title={task.task}>
                          {task.task}
                        </span>
                        <span className="task-meta">
                          {task.preset} · {task.steps} step{task.steps === 1 ? '' : 's'}
                        </span>
                        {task.status === 'running' || task.status === 'awaiting-approval' ? (
                          <button
                            type="button"
                            className="task-cancel"
                            title={cancelling ? 'Stopping…' : 'Stop'}
                            aria-label={
                              cancelling ? `Stopping task: ${task.task}` : `Stop task: ${task.task}`
                            }
                            aria-busy={cancelling}
                            disabled={cancelling}
                            onClick={() => cancel(task.id)}
                          >
                            {'×'}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </>
              ) : null}

              {runs.length > 0 ? (
                <div className="tasks-history" aria-busy={clearingRuns}>
                  <div className="tasks-history-head">
                    <span>Run history (PRD Phase 209/210)</span>
                    <button
                      type="button"
                      className="task-cancel"
                      title={clearingRuns ? 'Clearing run history…' : 'Clear run history'}
                      aria-label={clearingRuns ? 'Clearing run history' : 'Clear run history'}
                      aria-busy={clearingRuns}
                      disabled={clearingRuns}
                      onClick={clearRuns}
                    >
                      {clearingRuns ? 'Clearing…' : 'Clear'}
                    </button>
                  </div>
                  {runAggregate ? (
                    <div
                      className="tasks-evals-line"
                      title="Parallel-agent results aggregated (PRD Phase 219)"
                    >
                      {runAggregate.success} ok · {runAggregate.failure} failed ·{' '}
                      {runAggregate.cancelled} cancelled
                    </div>
                  ) : null}
                  {visibleRuns.map((run) => {
                    const sum = summarizeRun(run);
                    const open = expandedRun === run.id;
                    const resumable = isRunResumable(run);
                    const branchable = open ? new Set(listBranchPoints(run)) : null;
                    const pendingReinvoke = pendingReinvokes[run.id];
                    const resumePending = pendingReinvoke?.kind === 'resume';
                    return (
                      <div key={run.id} className="run-item">
                        <button
                          type="button"
                          className="task-row run-row"
                          aria-expanded={open}
                          onClick={() => setExpandedRun(open ? null : run.id)}
                        >
                          <span className={`task-badge task-badge-${run.status}`}>
                            {STATUS_LABEL[run.status]}
                          </span>
                          <span className="task-desc" title={run.task}>
                            {run.task}
                          </span>
                          <span className="task-meta">
                            {run.preset} · {sum.steps} step{sum.steps === 1 ? '' : 's'}
                            {sum.durationMs !== null
                              ? ` · ${(sum.durationMs / 1000).toFixed(1)}s`
                              : ''}{' '}
                            · {formatRelTime(run.endedAt ?? run.startedAt, Date.now())}
                          </span>
                        </button>
                        {open ? (
                          <div className="run-timeline" aria-busy={pendingReinvoke !== undefined}>
                            <div className="run-actions">
                              {resumable ? (
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  title="Continue this run from where it stopped"
                                  aria-busy={resumePending}
                                  disabled={pendingReinvoke !== undefined}
                                  onClick={() => reinvoke(run.id, 'resume')}
                                >
                                  {'↻'} {resumePending ? 'Resuming…' : 'Resume'}
                                </button>
                              ) : null}
                            </div>
                            {buildTimeline(run).map((event) => {
                              const branchPending =
                                pendingReinvoke?.kind === 'branch' &&
                                pendingReinvoke.branchIndex === event.index;
                              return (
                                <div key={event.index} className="run-step">
                                  <span className="run-step-time">
                                    +{(event.offsetMs / 1000).toFixed(1)}s
                                  </span>
                                  <span className="run-step-label">{event.label}</span>
                                  {event.text ? (
                                    <span className="run-step-text" title={event.text}>
                                      {event.text.slice(0, 100)}
                                    </span>
                                  ) : null}
                                  {branchable?.has(event.index) ? (
                                    <button
                                      type="button"
                                      className="btn btn-ghost run-branch-btn"
                                      title="Redo the run from this step with a different approach"
                                      aria-busy={branchPending}
                                      disabled={pendingReinvoke !== undefined}
                                      onClick={() => reinvoke(run.id, 'branch', event.index)}
                                    >
                                      {'⌥'} {branchPending ? 'Redoing…' : 'Redo here'}
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {olderRunCount > 0 || newerRunCount > 0 ? (
                    <div className="run-actions" aria-label="Run history pages">
                      {newerRunCount > 0 ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`Show ${Math.min(RUN_PAGE_SIZE, newerRunCount)} newer runs; ${newerRunCount} newer remaining`}
                          onClick={showNewerRuns}
                        >
                          Newer ({newerRunCount})
                        </button>
                      ) : null}
                      {olderRunCount > 0 ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`Show ${Math.min(RUN_PAGE_SIZE, olderRunCount)} older runs; ${olderRunCount} older remaining`}
                          onClick={showOlderRuns}
                        >
                          Older ({olderRunCount})
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
