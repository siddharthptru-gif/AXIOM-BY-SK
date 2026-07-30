import type { AgentProgress, AgentRunOutcome, AgentTerminalSummary } from './ipc';

export interface AgentEventMetadata {
  root: string;
  at: number;
  kind: string;
  progress?: AgentProgress;
  outcome?: AgentRunOutcome;
  summary?: AgentTerminalSummary;
}

/**
 * Validate Main-stamped nested metadata before a live task or durable journal
 * accepts it. Terminal kind, outcome, summary, root, and timestamp must agree.
 */
export function isValidAgentEventMetadata(event: AgentEventMetadata): boolean {
  if (!Number.isFinite(event.at) || event.at < 0) return false;

  if (event.kind === 'progress') {
    if (!event.progress || event.progress.root !== event.root || event.progress.at !== event.at) {
      return false;
    }
  } else if (event.progress !== undefined) {
    return false;
  }

  const terminal = event.kind === 'final' || event.kind === 'error';
  if (!terminal) return event.outcome === undefined && event.summary === undefined;
  if (!event.outcome || !event.summary) return false;
  if (
    event.summary.root !== event.root ||
    event.summary.at !== event.at ||
    event.summary.outcome !== event.outcome
  ) {
    return false;
  }
  if (event.kind === 'final') return event.outcome === 'completed';
  return event.outcome === 'failed' || event.outcome === 'cancelled';
}
