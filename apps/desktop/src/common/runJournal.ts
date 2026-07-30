import type { AgentProgress, AgentRunOutcome, AgentTerminalSummary } from './ipc';
import { isValidAgentEventMetadata } from './agentEventValidation';

/**
 * Agent run journal (PRD Epoch H §149 / Phases 209/210). Pure model for persisting
 * agent runs and their step timeline: start a run, fold each step event into it
 * (mirroring the live task reducer's transitions), build a display timeline, and
 * produce a resume context. No I/O — the Main service persists these to disk and the
 * Tasks panel renders the timeline. Smoke-tested.
 */

export type RunStatus = 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled';

export interface RunStep {
  index: number;
  /** Event kind: tool / plan / progress / approval / final / error. */
  kind: string;
  /** ms timestamp. */
  at: number;
  text?: string;
  /** Tool name (kind === 'tool') — enables replay-safe resume (Phase 210). */
  tool?: string;
  /** JSON-encoded tool arguments (kind === 'tool'). */
  args?: string;
  /** Recorded tool result (kind === 'tool') — replayed on resume, not re-executed. */
  observation?: string;
  /** Main-authored side-effect result; only tool steps participate in replay. */
  effectApplied?: boolean;
  /** Exact bounded signature computed before display arguments are truncated. */
  effectSignature?: string;
  /** Main-authored, canonical-root progress snapshot. */
  progress?: AgentProgress;
  /** Main-authored terminal outcome; present only for final/error steps. */
  outcome?: AgentRunOutcome;
  /** Main-authored terminal accounting. */
  summary?: AgentTerminalSummary;
}

export interface RunRecord {
  id: string;
  /** Canonical workspace identity. Legacy records without it are not IPC-visible. */
  root?: string;
  preset: string;
  task: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  steps: RunStep[];
  /** Latest progress is duplicated here for bounded list rendering. */
  progress?: AgentProgress;
  /** Present after a new-format run reaches a terminal state. */
  summary?: AgentTerminalSummary;
}

/** A single event the run journal ingests (a subset of the agent's step event). */
export interface RunEvent {
  kind: string;
  text?: string;
  /** Tool name (kind === 'tool') — recorded so a resume can replay it. */
  tool?: string;
  /** JSON-encoded tool arguments (kind === 'tool'). */
  args?: string;
  /** Recorded tool result (kind === 'tool'). */
  observation?: string;
  /** Main-authored side-effect result; legacy records may omit it. */
  effectApplied?: boolean;
  /** Exact bounded signature computed from full action arguments. */
  effectSignature?: string;
  progress?: AgentProgress;
  outcome?: AgentRunOutcome;
  summary?: AgentTerminalSummary;
}

const STEP_TEXT_CAP = 2000;
const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Begin a new run record (status running, no steps). */
export function startRun(
  id: string,
  preset: string,
  task: string,
  root: string,
  now: number,
): RunRecord {
  return { id, root, preset, task, status: 'running', startedAt: now, endedAt: null, steps: [] };
}

/**
 * Fold one step event into a run: append a timeline step + transition the status.
 * Terminal runs are immutable so delayed progress/approval/tool events cannot
 * resurrect them. Progress and summaries are informational and never replayed.
 */
export function appendRunStep(run: RunRecord, event: RunEvent, now: number): RunRecord {
  if (isRunTerminal(run.status)) return run;
  const terminal = event.kind === 'final' || event.kind === 'error';
  if (
    !run.root ||
    !isValidAgentEventMetadata({
      root: run.root,
      at: now,
      kind: event.kind,
      ...(event.progress ? { progress: event.progress } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
    })
  ) {
    return run;
  }
  const terminalOutcome = terminal ? event.outcome : undefined;

  const step: RunStep = {
    index: run.steps.length,
    kind: event.kind,
    at: now,
    ...(event.text ? { text: event.text.slice(0, STEP_TEXT_CAP) } : {}),
    ...(event.tool ? { tool: event.tool } : {}),
    ...(event.args ? { args: event.args.slice(0, STEP_TEXT_CAP) } : {}),
    ...(event.observation ? { observation: event.observation.slice(0, STEP_TEXT_CAP) } : {}),
    ...(event.effectApplied !== undefined ? { effectApplied: event.effectApplied } : {}),
    ...(event.effectSignature ? { effectSignature: event.effectSignature } : {}),
    ...(event.progress ? { progress: event.progress } : {}),
    ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
  };
  let status = run.status;
  let endedAt = run.endedAt;
  switch (event.kind) {
    case 'approval':
      status = 'awaiting-approval';
      break;
    case 'tool':
    case 'plan':
      status = 'running';
      break;
    case 'progress':
      status = event.progress?.phase === 'awaiting-approval' ? 'awaiting-approval' : status;
      break;
    case 'final':
    case 'error':
      status = terminalOutcome!;
      endedAt = now;
      break;
    default:
      break;
  }
  return {
    ...run,
    status,
    endedAt,
    steps: [...run.steps, step],
    ...(event.progress ? { progress: event.progress } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
  };
}

export interface RunSummary {
  steps: number;
  durationMs: number | null;
  status: RunStatus;
}

export function summarizeRun(run: RunRecord): RunSummary {
  const durationMs = run.endedAt !== null ? Math.max(0, run.endedAt - run.startedAt) : null;
  return { steps: run.steps.length, durationMs, status: run.status };
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'tool':
      return 'Tool call';
    case 'plan':
      return 'Plan';
    case 'progress':
      return 'Progress';
    case 'approval':
      return 'Awaiting approval';
    case 'final':
      return 'Answer';
    case 'error':
      return 'Error';
    default:
      return kind;
  }
}

export interface TimelineEntry {
  index: number;
  kind: string;
  label: string;
  /** Offset from the run start (ms). */
  offsetMs: number;
  text?: string;
}

/** Build a display timeline (relative offsets + labels) from a run's steps. */
export function buildTimeline(run: RunRecord): TimelineEntry[] {
  return run.steps.map((s) => ({
    index: s.index,
    kind: s.kind,
    label: kindLabel(s.kind),
    offsetMs: Math.max(0, s.at - run.startedAt),
    ...(s.text ? { text: s.text } : {}),
  }));
}

/** Keep the newest `max` runs (by start time). */
export function pruneRuns(runs: readonly RunRecord[], max: number): RunRecord[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, max));
}

/**
 * A short natural-language context to resume/continue a run (PRD Phase 210): the
 * preset, the original task, how far it got, and the last meaningful step.
 */
export function resumeContext(run: RunRecord): string {
  const lastText = [...run.steps].reverse().find((s) => s.text && s.text.trim().length > 0)?.text;
  const parts = [
    `Continuing a previous ${run.preset} agent run.`,
    `Original task: ${run.task}`,
    `It reached ${run.steps.length} step(s) with status "${run.status}".`,
  ];
  if (lastText) parts.push(`Last output: ${lastText.slice(0, 500)}`);
  return parts.join('\n');
}
