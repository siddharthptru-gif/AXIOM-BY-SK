/**
 * VS Code task runtime (PRD Phase 7 — §2 Task API).
 *
 * PURE module: no I/O, no child processes. Everything a task *is* before anything runs — the
 * definition, the execution it carries, the scope it belongs to, the provider that produced it, and
 * the lifecycle an execution moves through — is decided here, so the service that spawns the process
 * is left with the spawn alone.
 *
 * Why the split matters for tasks specifically: `ShellExecution` is a command line an extension asks
 * AXIOM to run. That is the single most dangerous thing Phase 7 adds, and the decisions that make it
 * safe (is there a command at all, are the arguments strings, is the cwd a path the extension may
 * reach, how many may run at once) are all decidable without a process. Putting them here means the
 * validators exercise them directly instead of inferring them from a spawn.
 */

/** Task providers one extension may register. */
export const MAX_TASK_PROVIDERS = 16;
/** Tasks one provider may return from a single `provideTasks`. */
export const MAX_TASKS_PER_PROVIDER = 200;
/** Task executions AXIOM will run at once, across every extension. */
export const MAX_CONCURRENT_TASKS = 8;
/** Executions kept in the registry, running or finished, before the oldest finished one is dropped. */
export const MAX_TRACKED_EXECUTIONS = 64;
/** Arguments one execution may carry. */
export const MAX_TASK_ARGS = 128;
/** Longest single argument, command, or command line. */
export const MAX_TASK_STRING = 4_096;
/** Environment variables one task may set. */
export const MAX_TASK_ENV = 64;

/** `TaskScope`: `TaskScope.Global` is 1, `TaskScope.Workspace` is 2, a folder is a `WorkspaceFolder`. */
export type TaskScopeKind = 'global' | 'workspace' | 'folder';

/** Which `*Execution` class the task carried. `custom` is a `CustomExecution` — the extension runs it. */
export type TaskExecutionKind = 'process' | 'shell' | 'custom' | 'none';

/** `TaskGroup` ids, as upstream's `TaskGroup.*.id` strings. */
export type TaskGroupId = 'build' | 'test' | 'clean' | 'rebuild' | null;

/** `ShellQuoting`. Only affects how an argument is rendered onto a command line. */
export type ShellQuoting = 'escape' | 'strong' | 'weak';

export interface TaskArgument {
  value: string;
  /** Null when the extension passed a bare string rather than a `ShellQuotedString`. */
  quoting: ShellQuoting | null;
}

/** The validated execution half of a task. */
export interface TaskExecutionSpec {
  kind: TaskExecutionKind;
  /** The program (`ProcessExecution`) or the shell command (`ShellExecution`). Null for custom. */
  command: string | null;
  args: TaskArgument[];
  /** Set when `ShellExecution` was built from a whole command line rather than command + args. */
  commandLine: string | null;
  cwd: string | null;
  env: Record<string, string>;
  /** `ShellExecutionOptions.executable` / `shellArgs`, when the extension pinned a shell. */
  shellExecutable: string | null;
  shellArgs: string[];
}

/** A task, as AXIOM tracks it. `definition` is the extension's own opaque object. */
export interface TaskSpec {
  /** Stable identity: `${source}.${definitionType}.${name}`. What `fetchTasks` filters on. */
  id: string;
  name: string;
  source: string;
  detail: string | null;
  definitionType: string;
  definition: Record<string, unknown>;
  scope: TaskScopeKind;
  /** Folder path when `scope` is `folder`. */
  scopePath: string | null;
  group: TaskGroupId;
  isBackground: boolean;
  problemMatchers: string[];
  execution: TaskExecutionSpec;
  /** Which extension supplied it. Empty for a task read out of the workspace's `tasks.json`. */
  extensionId: string;
}

const NUL_RE = new RegExp(String.fromCharCode(0), 'g');

/** Strip NULs and clamp. A NUL in an argv entry truncates it at the C boundary. */
function taskString(value: unknown, limit = MAX_TASK_STRING): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(NUL_RE, '').slice(0, limit);
  return cleaned.length === 0 ? null : cleaned;
}

function readPath(value: unknown): string | null {
  if (typeof value === 'string') return taskString(value);
  if (typeof value === 'object' && value !== null) {
    const fsPath = (value as { fsPath?: unknown }).fsPath;
    if (typeof fsPath === 'string') return taskString(fsPath);
  }
  return null;
}

export function normalizeShellQuoting(value: unknown): ShellQuoting | null {
  if (value === 1 || value === 'escape') return 'escape';
  if (value === 2 || value === 'strong') return 'strong';
  if (value === 3 || value === 'weak') return 'weak';
  return null;
}

/** `string | ShellQuotedString` → a validated argument, or null when it is neither. */
export function normalizeTaskArgument(value: unknown): TaskArgument | null {
  if (typeof value === 'string') {
    const cleaned = value.replace(NUL_RE, '').slice(0, MAX_TASK_STRING);
    return { value: cleaned, quoting: null };
  }
  if (typeof value === 'object' && value !== null) {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw !== 'string') return null;
    return {
      value: raw.replace(NUL_RE, '').slice(0, MAX_TASK_STRING),
      quoting: normalizeShellQuoting((value as { quoting?: unknown }).quoting),
    };
  }
  return null;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function taskEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_TASK_ENV) break;
    if (!ENV_NAME_RE.test(key) || typeof entry !== 'string') continue;
    out[key] = entry.replace(NUL_RE, '').slice(0, MAX_TASK_STRING);
    count += 1;
  }
  return out;
}

/**
 * Validate the `*Execution` an extension attached to a task.
 *
 * The wire carries a plain object, not the class, so the kind is recovered from which fields are
 * present — upstream's own classes are distinguished the same way over its RPC. An execution that
 * names no command at all becomes `none`, which the service refuses to run: that is deliberately not
 * an exception here, because `fetchTasks` must still be able to *list* a task whose execution the
 * provider fills in later via `resolveTask`.
 */
export function normalizeTaskExecution(raw: unknown): TaskExecutionSpec {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const declared = typeof source.kind === 'string' ? source.kind : '';
  const options =
    typeof source.options === 'object' && source.options !== null
      ? (source.options as Record<string, unknown>)
      : {};
  const args: TaskArgument[] = [];
  if (Array.isArray(source.args)) {
    for (const entry of source.args.slice(0, MAX_TASK_ARGS)) {
      const arg = normalizeTaskArgument(entry);
      if (arg) args.push(arg);
    }
  }
  const commandLine = taskString(source.commandLine);
  const commandRaw = source.command;
  const command =
    typeof commandRaw === 'string'
      ? taskString(commandRaw)
      : typeof commandRaw === 'object' && commandRaw !== null
        ? taskString((commandRaw as { value?: unknown }).value)
        : null;
  let kind: TaskExecutionKind;
  if (declared === 'custom' || source.custom === true) kind = 'custom';
  else if (declared === 'shell' || commandLine !== null || options.shell === true) kind = 'shell';
  else if (declared === 'process' || command !== null) kind = 'process';
  else kind = 'none';
  if (kind !== 'custom' && command === null && commandLine === null) kind = 'none';
  return {
    kind,
    command,
    args,
    commandLine,
    cwd: readPath(options.cwd),
    env: taskEnv(options.env),
    shellExecutable: taskString(options.executable),
    shellArgs: Array.isArray(options.shellArgs)
      ? options.shellArgs
          .slice(0, MAX_TASK_ARGS)
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.replace(NUL_RE, '').slice(0, MAX_TASK_STRING))
      : [],
  };
}

export function normalizeTaskGroup(value: unknown): TaskGroupId {
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? (value as { id?: unknown }).id
        : null;
  if (id === 'build' || id === 'test' || id === 'clean' || id === 'rebuild') return id;
  return null;
}

/** `TaskScope.Global` (1) / `TaskScope.Workspace` (2) / a `WorkspaceFolder`. */
export function normalizeTaskScope(value: unknown): { scope: TaskScopeKind; path: string | null } {
  if (value === 1) return { scope: 'global', path: null };
  if (value === 2) return { scope: 'workspace', path: null };
  if (typeof value === 'object' && value !== null) {
    const path = readPath((value as { uri?: unknown }).uri);
    if (path) return { scope: 'folder', path };
  }
  return { scope: 'workspace', path: null };
}

/** A task definition is the extension's own shape; only `type` is required by upstream. */
function taskDefinition(raw: unknown): { type: string; definition: Record<string, unknown> } {
  if (typeof raw !== 'object' || raw === null) return { type: 'axiom', definition: {} };
  const source = raw as Record<string, unknown>;
  const type = taskString(source.type, 200) ?? 'axiom';
  const definition: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (count >= 64) break;
    if (key.length > 200) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      definition[key] = typeof value === 'string' ? value.slice(0, MAX_TASK_STRING) : value;
      count += 1;
    }
  }
  definition.type = type;
  return { type, definition };
}

/**
 * Validate one task, from a provider or from `executeTask`.
 *
 * Never throws, for the same reason `normalizeTerminalRequest` does not: a task with an unusable
 * field should still appear in `fetchTasks` the way upstream shows it, and the refusal belongs at the
 * point of execution where it can be reported as an execution failure.
 */
export function normalizeTask(raw: unknown, extensionId: string): TaskSpec {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { type, definition } = taskDefinition(source.definition);
  const name = taskString(source.name, 300) ?? 'task';
  const source_ =
    taskString(source.source, 200) ?? (extensionId === '' ? 'Workspace' : extensionId);
  const { scope, path } = normalizeTaskScope(source.scope);
  const matchers: string[] = [];
  const rawMatchers = source.problemMatchers;
  const matcherList =
    typeof rawMatchers === 'string' ? [rawMatchers] : Array.isArray(rawMatchers) ? rawMatchers : [];
  for (const entry of matcherList.slice(0, 32)) {
    const cleaned = taskString(entry, 200);
    if (cleaned) matchers.push(cleaned);
  }
  return {
    id: `${source_}.${type}.${name}`,
    name,
    source: source_,
    detail: taskString(source.detail, 1_000),
    definitionType: type,
    definition,
    scope,
    scopePath: path,
    group: normalizeTaskGroup(source.group),
    isBackground: source.isBackground === true,
    problemMatchers: matchers,
    execution: normalizeTaskExecution(source.execution),
    extensionId,
  };
}

// ---------------------------------------------------------------------------
// Rendering an execution onto a real spawn
// ---------------------------------------------------------------------------
/**
 * Quote one shell argument the way upstream's `ShellQuoting` asks.
 *
 * `strong` is single quotes on POSIX (nothing inside is expanded) and double quotes on Windows, where
 * single quotes are not a quoting character at all. `weak` keeps expansion, so it is double quotes on
 * both. `escape` prefixes the characters a shell would act on. The quoting an extension picks is a
 * statement about its own argument, not a security control — a task runs a command line the user's
 * workspace asked for — but rendering it wrongly is how a path with a space becomes two arguments.
 */
export function quoteShellArgument(
  value: string,
  quoting: ShellQuoting | null,
  windows: boolean,
): string {
  if (quoting === 'strong') {
    if (windows) return `"${value.replace(/(["\\])/g, '\\$1')}"`;
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  if (quoting === 'weak') return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  if (quoting === 'escape') {
    if (windows) return value.replace(/([&|<>^%"])/g, '^$1');
    return value.replace(/([\s"'`$&|;<>()*?[\]\\!#~])/g, '\\$1');
  }
  // No quoting asked for. A bare argument that would split still has to survive the shell, so it is
  // quoted the weak way rather than passed through and silently re-split.
  if (/[\s"'`$&|;<>()*?[\]!#~]/.test(value)) {
    return windows ? `"${value.replace(/(["\\])/g, '\\$1')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
  }
  return value;
}

/** The command line a `ShellExecution` becomes. Empty when there is nothing to run. */
export function renderShellCommandLine(execution: TaskExecutionSpec, windows: boolean): string {
  if (execution.commandLine !== null) return execution.commandLine;
  if (execution.command === null) return '';
  const parts = [quoteShellArgument(execution.command, null, windows)];
  for (const arg of execution.args) parts.push(quoteShellArgument(arg.value, arg.quoting, windows));
  return parts.join(' ');
}

/** A `ProcessExecution`'s argv. The command is argv[0]; nothing is quoted, nothing goes near a shell. */
export function renderProcessArgv(execution: TaskExecutionSpec): string[] {
  if (execution.command === null) return [];
  return [execution.command, ...execution.args.map((arg) => arg.value)];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
export interface TaskProviderRecord {
  token: number;
  extensionId: string;
  type: string;
}

/**
 * Which extensions answer `fetchTasks`.
 *
 * Keyed by a token rather than by type because upstream allows two extensions to provide the same
 * task type and asks both. Disposal is by token, so a provider that registers twice and disposes once
 * still has its second registration live — which is what an extension that re-registers on
 * configuration change depends on.
 */
export class TaskProviderRegistry {
  private readonly records = new Map<number, TaskProviderRecord>();
  private nextToken = 1;

  register(extensionId: string, type: string): TaskProviderRecord {
    if (this.countFor(extensionId) >= MAX_TASK_PROVIDERS) {
      throw new Error(`An extension may register at most ${MAX_TASK_PROVIDERS} task providers.`);
    }
    const token = this.nextToken++;
    const record: TaskProviderRecord = { token, extensionId, type: type.slice(0, 200) };
    this.records.set(token, record);
    return record;
  }

  unregister(token: number): TaskProviderRecord | undefined {
    const record = this.records.get(token);
    if (record) this.records.delete(token);
    return record;
  }

  /** Everyone who might answer for a type, or everyone at all when no type is asked for. */
  providersFor(type: string | null): TaskProviderRecord[] {
    const out: TaskProviderRecord[] = [];
    for (const record of this.records.values()) {
      if (type === null || record.type === type) out.push(record);
    }
    return out;
  }

  countFor(extensionId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.extensionId === extensionId) count += 1;
    }
    return count;
  }

  removeExtension(extensionId: string): TaskProviderRecord[] {
    const removed: TaskProviderRecord[] = [];
    for (const [token, record] of [...this.records]) {
      if (record.extensionId !== extensionId) continue;
      this.records.delete(token);
      removed.push(record);
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }

  list(): TaskProviderRecord[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
  }
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------
/**
 * The lifecycle one `TaskExecution` moves through.
 *
 * `starting` exists because upstream fires `onDidStartTask` before the process exists and
 * `onDidStartTaskProcess` when it does — an extension that cancels in between must still get exactly
 * one `onDidEndTask`, which is only decidable if the in-between state is named.
 */
export type TaskRunState = 'starting' | 'running' | 'ended';

export interface TaskExecutionRecord {
  id: number;
  task: TaskSpec;
  /** The extension that called `executeTask`, which is not always the one that provided the task. */
  requestedBy: string;
  state: TaskRunState;
  processId: number | null;
  exitCode: number | null;
  cancelled: boolean;
  startedAt: number;
  endedAt: number | null;
}

/**
 * Every task AXIOM is running or has just run.
 *
 * Two bounds, for two different failures: `MAX_CONCURRENT_TASKS` stops a provider loop from turning
 * into a fork bomb, and `MAX_TRACKED_EXECUTIONS` stops the finished ones from accumulating for the
 * lifetime of the window. Ending an execution is idempotent and returns the record only on the
 * transition, so `onDidEndTask` cannot be fired twice for one task — the case that breaks extensions
 * which resolve a promise in that handler.
 */
export class TaskExecutionRegistry {
  private readonly records = new Map<number, TaskExecutionRecord>();
  private nextId = 1;

  start(task: TaskSpec, requestedBy: string, now: number): TaskExecutionRecord {
    if (this.runningCount() >= MAX_CONCURRENT_TASKS) {
      throw new Error(`AXIOM runs at most ${MAX_CONCURRENT_TASKS} tasks at once.`);
    }
    this.evictFinished();
    const id = this.nextId++;
    const record: TaskExecutionRecord = {
      id,
      task,
      requestedBy,
      state: 'starting',
      processId: null,
      exitCode: null,
      cancelled: false,
      startedAt: now,
      endedAt: null,
    };
    this.records.set(id, record);
    return record;
  }

  get(id: number): TaskExecutionRecord | undefined {
    return this.records.get(id);
  }

  /** The process attached: `onDidStartTaskProcess`. Refused once the execution has ended. */
  attachProcess(id: number, processId: number | null): TaskExecutionRecord | undefined {
    const record = this.records.get(id);
    if (!record || record.state === 'ended') return undefined;
    record.state = 'running';
    record.processId = processId;
    return record;
  }

  markCancelled(id: number): boolean {
    const record = this.records.get(id);
    if (!record || record.state === 'ended' || record.cancelled) return false;
    record.cancelled = true;
    return true;
  }

  /** End an execution once. Returns the record only on the transition. */
  end(id: number, exitCode: number | null, now: number): TaskExecutionRecord | undefined {
    const record = this.records.get(id);
    if (!record || record.state === 'ended') return undefined;
    record.state = 'ended';
    record.exitCode = exitCode;
    record.endedAt = now;
    return record;
  }

  runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state !== 'ended') count += 1;
    }
    return count;
  }

  running(): TaskExecutionRecord[] {
    return [...this.records.values()].filter((record) => record.state !== 'ended');
  }

  /** Executions to terminate when an extension goes away — its own, and ones it started. */
  forExtension(extensionId: string): TaskExecutionRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        record.state !== 'ended' &&
        (record.requestedBy === extensionId || record.task.extensionId === extensionId),
    );
  }

  private evictFinished(): void {
    if (this.records.size < MAX_TRACKED_EXECUTIONS) return;
    for (const [id, record] of this.records) {
      if (record.state !== 'ended') continue;
      this.records.delete(id);
      if (this.records.size < MAX_TRACKED_EXECUTIONS) return;
    }
  }

  get size(): number {
    return this.records.size;
  }

  list(): TaskExecutionRecord[] {
    return [...this.records.values()];
  }

  clear(): void {
    this.records.clear();
  }
}
