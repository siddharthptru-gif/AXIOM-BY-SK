/**
 * Snippet variable resolution (PRD Ch. 29, SN-4).
 *
 * Every variable in the TextMate set is resolved here, in one table, from an explicit
 * context object. The alternative — reaching for `new Date()` and the clipboard inside the
 * engine — makes snippet insertion untestable and makes a snippet's output depend on which
 * thread expanded it. So the impure values are parameters: the caller passes a clock and a
 * random source, and the same context always produces the same insertion.
 *
 * A variable that has no meaningful value resolves to the empty string rather than being
 * left unset, because upstream's fallback for an *unset* variable is its default or `''`,
 * while an *unknown* name inserts the name itself — those two cases must stay
 * distinguishable, and they are: unknown names never appear in this table.
 */

export interface SnippetCommentRules {
  lineComment?: string;
  blockStart?: string;
  blockEnd?: string;
}

export interface SnippetVariableContext {
  /** Absolute path of the document being edited. */
  filePath?: string;
  /** Path relative to the workspace folder, as `RELATIVE_FILEPATH` expects. */
  relativePath?: string;
  workspaceName?: string;
  workspaceFolder?: string;
  selectedText?: string;
  currentLine?: string;
  currentWord?: string;
  /** Zero-based line of the cursor. */
  lineIndex?: number;
  clipboard?: string;
  /** Zero-based index of this cursor when inserting at several cursors (SN-6). */
  cursorIndex?: number;
  /** Language comment markers, from `contributes.languages[].configuration`. */
  comments?: SnippetCommentRules;
}

export interface SnippetVariableOptions {
  /** The instant used for every `CURRENT_*` variable, so one insertion is consistent. */
  now?: Date;
  /** [0,1) source used for `RANDOM`, `RANDOM_HEX` and `UUID`. */
  random?: () => number;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function basename(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function directory(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? '' : normalized.slice(0, cut);
}

/** `+HH:MM` / `-HH:MM`, matching upstream's `CURRENT_TIMEZONE_OFFSET` format. */
function timezoneOffset(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function randomDigits(random: () => number, count: number): string {
  let out = '';
  for (let index = 0; index < count; index += 1) {
    out += String(Math.floor(Math.min(Math.max(random(), 0), 0.999999) * 10));
  }
  return out;
}

function randomHex(random: () => number, count: number): string {
  let out = '';
  for (let index = 0; index < count; index += 1) {
    out += Math.floor(Math.min(Math.max(random(), 0), 0.999999) * 16).toString(16);
  }
  return out;
}

/** RFC 4122 version 4 shape, from the supplied random source. */
function uuid(random: () => number): string {
  const hex = randomHex(random, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Build the variable table for one insertion at one cursor.
 *
 * `CURSOR_INDEX`/`CURSOR_NUMBER` differ by one on purpose (zero- and one-based), which is
 * the pair multi-cursor snippets use to number generated lines.
 */
export function resolveSnippetVariables(
  context: SnippetVariableContext = {},
  options: SnippetVariableOptions = {},
): Record<string, string> {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const filePath = context.filePath ?? '';
  const name = filePath.length > 0 ? basename(filePath) : '';
  const dot = name.lastIndexOf('.');
  const lineIndex = context.lineIndex ?? 0;
  const cursorIndex = context.cursorIndex ?? 0;
  const comments = context.comments ?? {};

  return {
    TM_SELECTED_TEXT: context.selectedText ?? '',
    TM_CURRENT_LINE: context.currentLine ?? '',
    TM_CURRENT_WORD: context.currentWord ?? '',
    TM_LINE_INDEX: String(lineIndex),
    TM_LINE_NUMBER: String(lineIndex + 1),
    TM_FILENAME: name,
    TM_FILENAME_BASE: dot > 0 ? name.slice(0, dot) : name,
    TM_DIRECTORY: filePath.length > 0 ? directory(filePath) : '',
    TM_FILEPATH: filePath,
    RELATIVE_FILEPATH: context.relativePath ?? '',
    CLIPBOARD: context.clipboard ?? '',
    WORKSPACE_NAME: context.workspaceName ?? '',
    WORKSPACE_FOLDER: context.workspaceFolder ?? '',
    CURSOR_INDEX: String(cursorIndex),
    CURSOR_NUMBER: String(cursorIndex + 1),
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_YEAR_SHORT: String(now.getFullYear()).slice(-2),
    CURRENT_MONTH: pad(now.getMonth() + 1),
    CURRENT_MONTH_NAME: MONTH_NAMES[now.getMonth()] ?? '',
    CURRENT_MONTH_NAME_SHORT: (MONTH_NAMES[now.getMonth()] ?? '').slice(0, 3),
    CURRENT_DATE: pad(now.getDate()),
    CURRENT_DAY_NAME: DAY_NAMES[now.getDay()] ?? '',
    CURRENT_DAY_NAME_SHORT: (DAY_NAMES[now.getDay()] ?? '').slice(0, 3),
    CURRENT_HOUR: pad(now.getHours()),
    CURRENT_MINUTE: pad(now.getMinutes()),
    CURRENT_SECOND: pad(now.getSeconds()),
    CURRENT_SECONDS_UNIX: String(Math.floor(now.getTime() / 1000)),
    CURRENT_TIMEZONE_OFFSET: timezoneOffset(now),
    RANDOM: randomDigits(random, 6),
    RANDOM_HEX: randomHex(random, 6),
    UUID: uuid(random),
    BLOCK_COMMENT_START: comments.blockStart ?? '',
    BLOCK_COMMENT_END: comments.blockEnd ?? '',
    LINE_COMMENT: comments.lineComment ?? '',
  };
}

/** The variable names this platform resolves, for conformance reporting (Ch. 48). */
export function supportedSnippetVariables(): string[] {
  return Object.keys(resolveSnippetVariables()).sort();
}
