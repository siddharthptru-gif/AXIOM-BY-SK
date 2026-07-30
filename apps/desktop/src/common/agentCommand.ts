import type { AgentCommandResult, AgentCommandStatus } from './ipc';

/**
 * Terminal-command records for the Build transcript (pure).
 *
 * Build runs shell commands the user explicitly approved, and until now their exit
 * code and output only existed inside the free-text `observation` that the
 * renderer is forbidden to display. The transcript therefore said "Verification
 * completed; output hidden." for both a passing test run and a failing build.
 * This module turns a raw capture into the bounded, Main-authored record the
 * transcript can safely show.
 *
 * Command output is program text rather than prose, which makes it the one place a
 * build log can echo a token that happened to be in the environment. So every
 * value is redacted, control-stripped, and capped HERE, in Main, before it crosses
 * IPC — and the result is never persisted to the run journal.
 *
 * Pure: no I/O, no Electron, no renderer dependency. Safe in Main or the renderer.
 */

/** Commands are already validated single-line by the tool; this is the display cap. */
export const MAX_COMMAND_LABEL_CHARS = 400;
export const MAX_COMMAND_OUTPUT_CHARS = 6_000;
export const MAX_COMMAND_OUTPUT_LINES = 400;

const REDACTED = '[REDACTED]';

/**
 * Credential shapes worth removing from build output. Deliberately self-contained
 * rather than importing the logger's redactor, because `common/` stays dependency
 * free so both process tiers can use it.
 */
const URL_USERINFO = /\b((?:https?|wss?|git\+https):\/\/)[^/@\s]+@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{4,}/gi;
const ASSIGNMENT =
  /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|secret|token|password|passwd|passcode|authorization|credential)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&#]+)/gi;
const QUERY_PARAM =
  /([?&#](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|password|passcode|authorization|credential|signature)=)[^&#\s]*/gi;
const PROVIDER_TOKEN =
  /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** ANSI CSI/OSC sequences: build tools emit them even when colour is disabled. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Remove credential-shaped fragments from provider- or tool-authored text. */
export function redactCommandText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(QUERY_PARAM, `$1${REDACTED}`)
    .replace(ASSIGNMENT, `$1${REDACTED}`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(PROVIDER_TOKEN, REDACTED)
    .replace(JWT, REDACTED);
}

/**
 * Make a raw capture safe and bounded for display: strip terminal control
 * sequences, collapse progress-bar carriage returns, redact credentials, and cap
 * both total characters and total lines.
 */
export function sanitizeCommandOutput(raw: string): { output: string; truncated: boolean } {
  const normalized = String(raw ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    // Everything except newline and tab; a lone control byte could otherwise
    // forge structure in a log view.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const redacted = redactCommandText(normalized);
  const lines = redacted.split('\n');
  let truncated = false;
  let kept = lines;
  if (kept.length > MAX_COMMAND_OUTPUT_LINES) {
    kept = kept.slice(0, MAX_COMMAND_OUTPUT_LINES);
    truncated = true;
  }
  let output = kept.join('\n');
  if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
    output = output.slice(0, MAX_COMMAND_OUTPUT_CHARS);
    truncated = true;
  }
  // Trailing blank lines are noise in a fixed-height output box.
  return { output: output.replace(/\n+$/, ''), truncated };
}

/** Collapse a command to a single bounded display line. */
export function sanitizeCommandLabel(command: string): string {
  const line = redactCommandText(String(command ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > MAX_COMMAND_LABEL_CHARS
    ? `${line.slice(0, MAX_COMMAND_LABEL_CHARS - 1)}\u2026`
    : line;
}

export interface AgentCommandCapture {
  command: string;
  status: AgentCommandStatus;
  /** Null whenever the process never reported a status code. */
  exitCode: number | null;
  /** Raw combined stdout+stderr as captured, in any state. */
  output: string;
  /** True when the capture itself was already capped upstream. */
  capturedTruncated?: boolean;
}

/** Build the sanitized record the transcript renders. */
export function buildAgentCommandResult(capture: AgentCommandCapture): AgentCommandResult {
  const { output, truncated } = sanitizeCommandOutput(capture.output);
  return {
    command: sanitizeCommandLabel(capture.command),
    status: capture.status,
    exitCode:
      typeof capture.exitCode === 'number' && Number.isFinite(capture.exitCode)
        ? Math.trunc(capture.exitCode)
        : null,
    output,
    truncated: truncated || capture.capturedTruncated === true,
  };
}

/** True when the command did not complete successfully. */
export function commandFailed(result: AgentCommandResult): boolean {
  return result.status !== 'completed' || result.exitCode !== 0;
}

/** Short status line for a command card header. */
export function commandStatusLabel(result: AgentCommandResult): string {
  if (result.status === 'cancelled') return 'Cancelled';
  if (result.status === 'timeout') return 'Timed out';
  if (result.status === 'error') return 'Could not run';
  return `Exit Code: ${result.exitCode ?? 'unknown'}`;
}
