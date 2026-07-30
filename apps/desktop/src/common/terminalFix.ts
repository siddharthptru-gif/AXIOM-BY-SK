/**
 * Terminal-aware AI (T3.14) — "fix the last failing command".
 *
 * A failing command is the single most common moment a developer wants help, and
 * the evidence is already on screen. This turns that moment into one action: the
 * command the user actually typed plus the tail of its output become a grounded
 * request, rather than the user re-typing an error into a chat box.
 *
 * Pure — no I/O. The renderer supplies the captured command and output; this decides
 * what is worth sending and how to frame it.
 */

/** Signals that a command run probably failed. Ordered most to least specific. */
const FAILURE_PATTERNS: readonly RegExp[] = [
  /\bexit(?:ed with)? code\s*[:=]?\s*[1-9]/i,
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bpermission denied\b/i,
  /\bno such file or directory\b/i,
  /^\s*error[:\s]/im,
  /^\s*fatal[:\s]/im,
  /\bTraceback \(most recent call last\)/,
  /^\s*(?:\w+)?Error\b/im,
  /\bfailed\b/i,
  /\bnpm ERR!/,
  /\bERROR\b/,
  /\bTS\d{4}:/,
  /\bAssertionError\b/i,
  /\btest(?:s)? failed\b/i,
];

/** Heuristic: does this output look like a failure? Used only to label the prompt. */
export function looksLikeFailingOutput(output: string): boolean {
  return FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

export interface TerminalFixInput {
  /** The command the user submitted, or '' when it was not captured. */
  command: string;
  /** Recent terminal output (already ANSI-stripped and bounded). */
  output: string;
  /** Terminal tab title, for context. */
  title?: string | null;
  /** Workspace-relative label for where the command ran, when known. */
  cwdLabel?: string | null;
}

export type TerminalFixReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/**
 * Whether there is enough captured evidence to ask for a fix. Refuses honestly
 * instead of sending an empty prompt the model would have to guess at.
 */
export function terminalFixReadiness(input: TerminalFixInput): TerminalFixReadiness {
  if (input.output.trim().length === 0 && input.command.trim().length === 0) {
    return {
      ready: false,
      reason:
        'No terminal activity has been captured yet. Run a command in the integrated terminal, then try again.',
    };
  }
  if (input.output.trim().length === 0) {
    return {
      ready: false,
      reason: `Captured the command \`${input.command}\` but no output yet. Wait for it to finish, then try again.`,
    };
  }
  return { ready: true };
}

/**
 * Build the request. The output is repository/tool text, so the prompt frames it as
 * evidence to diagnose — and explicitly tells the model to say when the output is
 * insufficient rather than inventing a cause.
 */
export function buildTerminalFixPrompt(input: TerminalFixInput): string {
  const failing = looksLikeFailingOutput(input.output);
  const lines: string[] = [];
  lines.push(
    failing
      ? 'The command below failed in my integrated terminal. Diagnose the actual cause from the output and give me the fix.'
      : 'Here is the last command I ran in my integrated terminal and its output. Tell me what it means and what to do next.',
  );
  lines.push('');
  lines.push('Requirements for your answer:');
  lines.push('1. State the root cause, quoting the specific line of output that shows it.');
  lines.push('2. Give the concrete fix — the exact command to run, or the exact file edit.');
  lines.push(
    '3. If the output does not contain enough information to be sure, say so and name the one command that would reveal it. Do not guess a cause.',
  );
  lines.push('');
  if (input.command.trim().length > 0) {
    lines.push(`Command: \`${input.command.trim()}\``);
  } else {
    lines.push('Command: not captured (the output below is what I have).');
  }
  if (input.cwdLabel) lines.push(`Working directory: ${input.cwdLabel}`);
  if (input.title) lines.push(`Terminal: ${input.title}`);
  return lines.join('\n');
}

/** Short label for the evidence block attached alongside the prompt. */
export function terminalFixEvidenceLabel(input: TerminalFixInput): string {
  const command = input.command.trim();
  return command.length > 0 ? `terminal output of \`${command}\`` : 'recent terminal output';
}
