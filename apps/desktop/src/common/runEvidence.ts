/**
 * Run evidence (T3.11 — the honest-evidence model, made visible for Build).
 *
 * Ask already shows "what was sent" per answer. An agent run had no equivalent: it
 * reported an outcome without an auditable account of what it actually read, what it
 * actually changed, and what it tried and failed to do. This derives that account
 * from the run's own event stream — no new IPC, no new trust in the model's prose.
 *
 * The distinction that matters: a file is listed under `changed` ONLY when Main
 * confirmed the write (`applied === true`). A proposed-but-unapplied diff is never
 * counted as a change, so the summary cannot overstate what happened.
 *
 * Pure — unit-testable.
 */
import type { AgentStepEvent } from './ipc';

export interface RunEvidence {
  /** Workspace-relative paths the run read, in first-seen order. */
  read: string[];
  /** Paths whose change Main confirmed as applied, with the change kind. */
  changed: Array<{ path: string; changeKind: string; added: number; removed: number }>;
  /** Tools that returned an error, with the first failure message (bounded). */
  failures: Array<{ tool: string; message: string }>;
  /** Distinct tool names used, in first-seen order. */
  tools: string[];
  /** Number of actions the user explicitly approved. */
  approvals: number;
  toolCallCount: number;
}

const MAX_LIST = 60;
const MAX_MESSAGE = 200;

/** Tools whose invocation means "this file was read". */
const READ_TOOLS = new Set(['read_file', 'read_files', 'search', 'grep', 'list_directory']);

function pathFromArgs(args: string | undefined): string | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const candidate = record.path ?? record.file ?? record.filepath ?? record.rel;
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
  } catch {
    return null;
  }
}

function looksLikeFailure(observation: string): boolean {
  return /^\s*(error|failed|refused|denied|not found|cannot)\b/i.test(observation);
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_MESSAGE ? `${single.slice(0, MAX_MESSAGE)}…` : single;
}

/** Derive an auditable account of a run from the events it emitted. */
export function buildRunEvidence(steps: readonly AgentStepEvent[]): RunEvidence {
  const read: string[] = [];
  const readSeen = new Set<string>();
  const changed: RunEvidence['changed'] = [];
  const changedSeen = new Set<string>();
  const failures: RunEvidence['failures'] = [];
  const tools: string[] = [];
  const toolsSeen = new Set<string>();
  let approvals = 0;
  let toolCallCount = 0;

  for (const step of steps) {
    if (step.kind === 'approval') {
      approvals += 1;
      continue;
    }
    if (step.kind !== 'tool') continue;
    toolCallCount += 1;
    const tool = step.tool ?? 'tool';
    if (!toolsSeen.has(tool)) {
      toolsSeen.add(tool);
      tools.push(tool);
    }

    if (READ_TOOLS.has(tool)) {
      const path = pathFromArgs(step.args);
      if (path && !readSeen.has(path) && read.length < MAX_LIST) {
        readSeen.add(path);
        read.push(path);
      }
    }

    // Only a Main-confirmed application counts as a change.
    if (step.applied === true && step.diff && !changedSeen.has(step.diff.path)) {
      changedSeen.add(step.diff.path);
      if (changed.length < MAX_LIST) {
        changed.push({
          path: step.diff.path,
          changeKind: step.diff.changeKind,
          added: step.diff.added,
          removed: step.diff.removed,
        });
      }
    }

    if (step.observation && looksLikeFailure(step.observation) && failures.length < MAX_LIST) {
      failures.push({ tool, message: clip(step.observation) });
    }
  }

  return { read, changed, failures, tools, approvals, toolCallCount };
}

/** One-line summary of a run's evidence, or '' when the run did nothing yet. */
export function summarizeRunEvidence(evidence: RunEvidence): string {
  if (evidence.toolCallCount === 0) return '';
  const parts: string[] = [
    `${evidence.toolCallCount} action${evidence.toolCallCount === 1 ? '' : 's'}`,
  ];
  if (evidence.read.length > 0) parts.push(`${evidence.read.length} file(s) read`);
  parts.push(`${evidence.changed.length} change(s) applied`);
  if (evidence.approvals > 0) parts.push(`${evidence.approvals} approved`);
  if (evidence.failures.length > 0) parts.push(`${evidence.failures.length} failed`);
  return parts.join(' \u00B7 ');
}
