import type { AgentTask } from './ipc';

/**
 * Agent evals core (PRD Epoch H §217 / Phase 238). Aggregate measured agent metrics
 * from the task registry: success rate, average steps, duration, and a per-preset
 * breakdown — so agents are measured, not just run. Pure reducer over AgentTask[];
 * the Agent Tasks panel renders it. Smoke-tested.
 */
export interface PresetEval {
  preset: string;
  total: number;
  completed: number;
  successRate: number;
  avgSteps: number;
}

export interface EvalSummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  /** completed / finished (finished = completed + failed + cancelled). */
  successRate: number;
  /** Average steps over finished tasks. */
  avgSteps: number;
  /** Average wall-clock duration (ms) over tasks that ended. */
  avgDurationMs: number;
  byPreset: PresetEval[];
}

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate agent-task metrics into an eval summary (pure). */
export function summarizeEvals(tasks: readonly AgentTask[]): EvalSummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let running = 0;
  let finishedSteps = 0;
  let finishedCount = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const t of tasks) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'failed') failed++;
    else if (t.status === 'cancelled') cancelled++;
    else running++;

    if (FINISHED.has(t.status)) {
      finishedCount++;
      finishedSteps += t.steps;
    }
    if (t.endedAt !== null && t.endedAt >= t.startedAt) {
      durationSum += t.endedAt - t.startedAt;
      durationCount++;
    }
  }

  const finished = completed + failed + cancelled;

  // Per-preset rollup.
  const presets = new Map<
    string,
    { total: number; completed: number; steps: number; finished: number }
  >();
  for (const t of tasks) {
    const cur = presets.get(t.preset) ?? { total: 0, completed: 0, steps: 0, finished: 0 };
    cur.total++;
    if (t.status === 'completed') cur.completed++;
    if (FINISHED.has(t.status)) {
      cur.finished++;
      cur.steps += t.steps;
    }
    presets.set(t.preset, cur);
  }
  const byPreset: PresetEval[] = [...presets.entries()]
    .map(([preset, v]) => ({
      preset,
      total: v.total,
      completed: v.completed,
      successRate: v.finished === 0 ? 0 : round(v.completed / v.finished),
      avgSteps: v.finished === 0 ? 0 : round(v.steps / v.finished),
    }))
    .sort((a, b) => b.total - a.total || a.preset.localeCompare(b.preset));

  return {
    total: tasks.length,
    completed,
    failed,
    cancelled,
    running,
    successRate: finished === 0 ? 0 : round(completed / finished),
    avgSteps: finishedCount === 0 ? 0 : round(finishedSteps / finishedCount),
    avgDurationMs: durationCount === 0 ? 0 : Math.round(durationSum / durationCount),
    byPreset,
  };
}

/** A compact one-line eval summary for a header. */
export function formatEvalSummary(s: EvalSummary): string {
  if (s.total === 0) return 'No agent runs yet.';
  const pct = Math.round(s.successRate * 100);
  return `${s.completed}/${s.completed + s.failed + s.cancelled} succeeded (${pct}%) \u00B7 avg ${s.avgSteps} steps`;
}
