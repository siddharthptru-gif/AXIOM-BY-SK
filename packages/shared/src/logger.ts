/**
 * Structured logger with secret redaction at the sink.
 * PRD Part II §23 (Observability) and Part X §177 (secrets never logged).
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LogRecord {
  level: LogLevel;
  msg: string;
  ts: string;
  subsystem?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|authorization|refresh[_-]?token|private[_-]?key|credential)/i;
const REDACTED = '[REDACTED]';
const CREDENTIAL_QUERY_PATTERN =
  /([?&#](?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passcode|authorization|credential|signature)=)[^&#\s]*/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(\b(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passcode|authorization|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi;
const AUTHORIZATION_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{4,}/gi;
const PROVIDER_TOKEN_PATTERN =
  /\b(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_USERINFO_PATTERN = /\b((?:https?|wss?|git\+https):\/\/)[^/@\s]+@/gi;

/** Redact credential-shaped string fragments while preserving ordinary prose and URLs. */
export function redactString(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`)
    .replace(CREDENTIAL_QUERY_PATTERN, `$1${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(AUTHORIZATION_SCHEME_PATTERN, `$1 ${REDACTED}`)
    .replace(PROVIDER_TOKEN_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MaxDepth]';
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return redactString(String(value));
}

export const consoleSink: LogSink = (r) => {
  const prefix = r.subsystem ? `[${r.subsystem}] ` : '';
  const line = `${r.ts} ${r.level.toUpperCase().padEnd(5)} ${prefix}${r.msg}`;
  if (r.level === 'error') {
    r.data ? console.error(line, r.data) : console.error(line);
  } else if (r.level === 'warn') {
    r.data ? console.warn(line, r.data) : console.warn(line);
  } else {
    r.data ? console.log(line, r.data) : console.log(line);
  }
};

export interface LoggerOptions {
  level?: LogLevel;
  subsystem?: string;
  sink?: LogSink;
}

export class Logger {
  private level: LogLevel;
  private readonly subsystem: string | undefined;
  private readonly sink: LogSink;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.subsystem = opts.subsystem;
    this.sink = opts.sink ?? consoleSink;
  }

  child(subsystem: string): Logger {
    return new Logger({ level: this.level, subsystem, sink: this.sink });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      level,
      msg: redactString(msg),
      ts: new Date().toISOString(),
      ...(this.subsystem !== undefined ? { subsystem: this.subsystem } : {}),
      ...(data !== undefined ? { data: redact(data) as Record<string, unknown> } : {}),
    };
    this.sink(record);
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.emit('trace', msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.emit('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.emit('error', msg, data);
  }
}

export const rootLogger = new Logger();
