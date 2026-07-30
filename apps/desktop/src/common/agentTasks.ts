import type { AgentStepEvent, AgentTask, AgentTaskStatus } from './ipc';
import { isValidAgentEventMetadata } from './agentEventValidation';

/**
 * Agent task-status model (PRD Epoch H §72.5 / §149). A pure reducer that folds
 * the agent's step events into a task's lifecycle status, plus summary helpers.
 * No I/O — the Main registry uses this and the Tasks view renders it; unit-tested
 * so the state transitions are correct.
 */

export function newTask(
  id: string,
  preset: string,
  task: string,
  root: string,
  now: number,
  status: AgentTaskStatus = 'running',
): AgentTask {
  return {
    id,
    root,
    preset,
    task,
    status,
    steps: 0,
    startedAt: now,
    endedAt: null,
    lastText: null,
    progress: null,
    summary: null,
  };
}

/** Fold one Main-stamped event into the task's status (pure). */
export function applyTaskEvent(task: AgentTask, event: AgentStepEvent, now: number): AgentTask {
  // A stale event from another canonical workspace is never allowed to update a task,
  // and terminal states remain absorbing even if delivery/journal work finishes late.
  if (
    task.id !== event.id ||
    task.root !== event.root ||
    now !== event.at ||
    isTerminal(task.status) ||
    !isValidAgentEventMetadata({
      root: event.root,
      at: event.at,
      kind: event.kind,
      ...(event.progress ? { progress: event.progress } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
    })
  ) {
    return task;
  }

  switch (event.kind) {
    case 'tool':
      return { ...task, status: 'running', steps: task.steps + 1 };
    case 'plan':
      return { ...task, status: 'running' };
    case 'progress': {
      const phase = event.progress?.phase;
      const status =
        phase === 'queued'
          ? 'queued'
          : phase === 'awaiting-approval'
            ? 'awaiting-approval'
            : 'running';
      return { ...task, status, progress: event.progress ?? task.progress };
    }
    case 'approval':
      return { ...task, status: 'awaiting-approval' };
    case 'final':
    case 'error': {
      const outcome = event.outcome;
      if (!outcome) return task;
      return {
        ...task,
        status: outcome,
        endedAt: now,
        lastText: event.text ?? null,
        summary: event.summary ?? null,
      };
    }
    default:
      return task;
  }
}

export function isTerminal(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export interface TaskSummary {
  queued: number;
  running: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export function summarizeTasks(tasks: readonly AgentTask[]): TaskSummary {
  const s: TaskSummary = {
    queued: 0,
    running: 0,
    awaitingApproval: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: tasks.length,
  };
  for (const t of tasks) {
    if (t.status === 'queued') s.queued++;
    else if (t.status === 'running') s.running++;
    else if (t.status === 'awaiting-approval') s.awaitingApproval++;
    else if (t.status === 'completed') s.completed++;
    else if (t.status === 'failed') s.failed++;
    else if (t.status === 'cancelled') s.cancelled++;
  }
  return s;
}
