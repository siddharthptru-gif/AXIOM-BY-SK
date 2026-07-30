/**
 * Recent terminal output buffer (renderer-only).
 *
 * xterm owns the visible scrollback, but two AI features need the text: the
 * `@terminal` chat mention and "fix the last failing command". Rather than reach
 * into the terminal widget, the view tees every incoming chunk here.
 *
 * Bounded on purpose — a runaway build log must not grow the renderer heap, and a
 * prompt must not be flooded. ANSI control sequences are stripped so the model sees
 * what the user sees. Nothing is persisted: the buffer dies with the session.
 */
const MAX_CHARS = 24_000;
const MAX_PROMPT_CHARS = 6_000;

interface TerminalBuffer {
  id: string;
  title: string;
  text: string;
  /** Epoch ms of the most recent chunk, used to pick the "current" terminal. */
  at: number;
}

const buffers = new Map<string, TerminalBuffer>();
let lastActiveId: string | null = null;

/**
 * Strip ANSI escape sequences (CSI/OSC/single-char) and carriage returns so the
 * captured text matches the rendered output.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC ... BEL | ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // CSI sequences
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // Two-character escapes
      .replace(/\u001b[@-Z\\-_]/g, '')
      .replace(/\r/g, '')
  );
}

/** Record a chunk of output for a terminal. Called by the terminal view. */
export function recordTerminalOutput(id: string, data: string, title?: string): void {
  if (!id || data.length === 0) return;
  const existing = buffers.get(id);
  const merged = `${existing?.text ?? ''}${stripAnsi(data)}`;
  buffers.set(id, {
    id,
    title: title ?? existing?.title ?? id,
    text: merged.length > MAX_CHARS ? merged.slice(merged.length - MAX_CHARS) : merged,
    at: Date.now(),
  });
  lastActiveId = id;
}

/** Drop a terminal's buffer when its process is gone. */
export function clearTerminalOutput(id: string): void {
  buffers.delete(id);
  if (lastActiveId === id) lastActiveId = null;
}

/** Drop every buffer (e.g. when workspace trust is revoked). */
export function clearAllTerminalOutput(): void {
  buffers.clear();
  lastActiveId = null;
}

function mostRecent(): TerminalBuffer | null {
  let best: TerminalBuffer | null = null;
  for (const buffer of buffers.values()) {
    if (!best || buffer.at > best.at) best = buffer;
  }
  return best;
}

/**
 * The tail of the most recently active terminal, trimmed for a prompt. Returns ''
 * when nothing has been captured, so callers can report honestly.
 */
export function recentTerminalOutput(maxChars = MAX_PROMPT_CHARS): string {
  const buffer = (lastActiveId ? buffers.get(lastActiveId) : null) ?? mostRecent();
  if (!buffer) return '';
  const text = buffer.text.trimEnd();
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** Title of the terminal `recentTerminalOutput` would read from. */
export function recentTerminalTitle(): string | null {
  const buffer = (lastActiveId ? buffers.get(lastActiveId) : null) ?? mostRecent();
  return buffer?.title ?? null;
}

/** True when any terminal output has been captured this session. */
export function hasTerminalOutput(): boolean {
  return recentTerminalOutput(MAX_PROMPT_CHARS).length > 0;
}

// ---- Last typed command -----------------------------------------------------

/**
 * The command the user most recently submitted, tracked from their own keystrokes
 * rather than parsed out of the scrollback. Prompt formats vary per shell and
 * per user, so guessing where a command starts in the output is unreliable;
 * watching what was typed and committing it on Enter is exact.
 */
const MAX_COMMAND_CHARS = 2_000;
const pendingInput = new Map<string, string>();
let lastCommand: { id: string; command: string; at: number } | null = null;

/** Record raw keystrokes headed for a terminal. Called by the terminal view. */
export function recordTerminalInput(id: string, data: string): void {
  if (!id || data.length === 0) return;
  let buffer = pendingInput.get(id) ?? '';
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      const command = buffer.trim();
      buffer = '';
      if (command.length > 0) {
        lastCommand = { id, command: command.slice(0, MAX_COMMAND_CHARS), at: Date.now() };
      }
      continue;
    }
    // Backspace / delete.
    if (char === '\u0008' || char === '\u007f') {
      buffer = buffer.slice(0, -1);
      continue;
    }
    // Ctrl-C and friends abandon the line.
    if (char < ' ' && char !== '\t') {
      buffer = '';
      continue;
    }
    if (buffer.length < MAX_COMMAND_CHARS) buffer += char;
  }
  pendingInput.set(id, buffer);
}

/** The most recently submitted command, or null when none has been seen. */
export function lastTerminalCommand(): string | null {
  return lastCommand?.command ?? null;
}

/**
 * Output captured for the terminal the last command ran in, so the command and the
 * output shown to the model belong together.
 */
export function lastTerminalCommandOutput(maxChars = MAX_PROMPT_CHARS): string {
  const id = lastCommand?.id;
  const buffer = id ? buffers.get(id) : null;
  if (!buffer) return recentTerminalOutput(maxChars);
  const text = buffer.text.trimEnd();
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
