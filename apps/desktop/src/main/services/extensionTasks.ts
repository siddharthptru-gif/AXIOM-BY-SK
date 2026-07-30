/**
 * The extension task runtime (PRD Phase 7 §2).
 *
 * A task is the most consequential thing an extension can ask AXIOM for: `ShellExecution` is a command
 * line, and running it is running whatever the workspace says. So the file is arranged around the
 * spawn, and everything that can be decided before it exists is decided in `common/vscodeTaskRuntime`
 * — the definition, the execution kind, the argument quoting, the concurrency bound — leaving four
 * questions here, in this order:
 *
 *   1. is the workspace trusted (`assertWorkspaceTrusted`, the same gate the integrated terminal uses);
 *   2. is the working directory inside it (`assertAuthorizedPath`);
 *   3. is there anything to run at all (`kind === 'none'` is refused, not silently skipped);
 *   4. is AXIOM already running as many tasks as it will.
 *
 * Only then does a process start. A `CustomExecution` never starts one: the extension *is* the task,
 * so it is asked to run and the execution ends when it says it has ended.
 *
 * Task output goes to the workbench, not to the extension. Upstream gives an extension no callback for
 * another task's bytes, and a task's terminal is frequently a build log with tokens in it.
 *
 * The four lifecycle events are broadcast rather than delivered to the requester, because upstream's
 * `onDidStartTask` / `onDidEndTask` fire in every extension host — that is how a task-watching
 * extension observes builds it did not start.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

import { rootLogger } from '@axiom/shared';
import type { ExtensionTaskExecutionInfo } from '../../common/ipc';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  MAX_TASKS_PER_PROVIDER,
  TaskExecutionRegistry,
  TaskProviderRegistry,
  normalizeTask,
  renderProcessArgv,
  renderShellCommandLine,
  type TaskExecutionRecord,
  type TaskSpec,
} from '../../common/vscodeTaskRuntime';
import { assertAuthorizedPath } from './pathAuthorization';
import { terminateProcessTree } from './processTree';
import { assertWorkspaceTrusted } from './workspaceTrust';

const log = rootLogger.child('extension-tasks');

/** How long a `provideTasks` / `resolveTask` round trip gets. */
const PROVIDE_TIMEOUT_MS = 15_000;
/** How long a `CustomExecution` gets to hand back its `Pseudoterminal`. */
const CUSTOM_START_TIMEOUT_MS = 10_000;
/** Grace between the polite signal and the impolite one when terminating a task. */
const KILL_GRACE_MS = 2_000;
/** How long a parsed `.vscode/tasks.json` is reused before its mtime is checked again. */
const TASKS_JSON_CACHE_MS = 2_000;
/** Largest chunk of task output forwarded in one message. */
const MAX_OUTPUT_CHUNK = 8 * 1024;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts and the workbench
// ---------------------------------------------------------------------------
export interface TasksHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Post to every running host: the task lifecycle events every extension may observe. */
  broadcast(message: MainToWorker): void;
  /** Call into a worker and await its reply. */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The execution list changed: the workbench must re-read it. */
  notifyChanged(): void;
  /** A task's process wrote something. Goes to the workbench's task panel only. */
  output(executionId: number, stream: 'stdout' | 'stderr', data: string): void;
  /** Absolute workspace folder paths. */
  workspaceRoots(): string[];
  /** The environment a child process would be spawned with, before the task's own `env`. */
  baseEnvironment(): Record<string, string>;
}

let bridge: TasksHostBridge | null = null;

export function configureExtensionTasks(next: TasksHostBridge): void {
  bridge = next;
}

function requireBridge(): TasksHostBridge {
  if (bridge === null) throw new Error('The extension task runtime is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const providers = new TaskProviderRegistry();
const executions = new TaskExecutionRegistry();
/** Live processes, by execution id. A `CustomExecution` has none, which is how the two are told apart. */
const processes = new Map<number, ChildProcess>();
/** Executions whose body runs inside an extension, and the host that owns each. */
const customExecutions = new Map<number, string>();
/** Pending force-kill timers, so a terminate cannot leave one armed after the task ended. */
const killTimers = new Map<number, NodeJS.Timeout>();
let revision = 1;

function changed(): void {
  revision += 1;
  bridge?.notifyChanged();
}

/** How the workbench draws one execution. Carries no command line and no environment. */
function describe(record: TaskExecutionRecord): ExtensionTaskExecutionInfo {
  return {
    executionId: record.id,
    extensionId: record.requestedBy,
    name: record.task.name,
    type: record.task.definitionType,
    source: record.task.source,
    state: record.state,
    processId: record.processId ?? 0,
    exitCode: record.exitCode ?? 0,
    custom: record.task.execution.kind === 'custom',
  };
}

/** Every tracked execution, for the workbench's pull channel. */
export function extensionTaskList(): {
  revision: number;
  executions: ExtensionTaskExecutionInfo[];
} {
  return { revision, executions: executions.list().map(describe) };
}

// ---------------------------------------------------------------------------
// Requests from the extension hosts
// ---------------------------------------------------------------------------
const TASK_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
  'tasks.registerProvider',
  'tasks.unregisterProvider',
  'tasks.fetch',
  'tasks.execute',
  'tasks.terminate',
  'tasks.customDone',
]);

export function isTasksRequestKind(kind: HostRequestKind): boolean {
  return TASK_REQUEST_KINDS.has(kind);
}

export async function handleTasksRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'tasks.registerProvider':
      return registerProvider(extensionId, String(payload.type), Number(payload.token));
    case 'tasks.unregisterProvider':
      return unregisterProvider(extensionId, Number(payload.token));
    case 'tasks.fetch':
      return fetchTasks(typeof payload.type === 'string' ? payload.type : null);
    case 'tasks.execute':
      return executeTask(extensionId, payload.task);
    case 'tasks.terminate':
      return terminateTask(extensionId, Number(payload.executionId));
    case 'tasks.customDone':
      return finishCustomTask(extensionId, Number(payload.executionId), Number(payload.exitCode));
    default:
      throw new Error(`${kind} is not a task request.`);
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
/**
 * Main's token for a provider, mapped back to the worker's.
 *
 * The worker mints its own token because `registerTaskProvider` returns a `Disposable` synchronously,
 * so two extensions both own a token `1`. Main keeps its own and translates on the way out, which is
 * what stops one extension from naming another's provider.
 */
const workerTokens = new Map<number, number>();

function registerProvider(extensionId: string, type: string, workerToken: number): number {
  const record = providers.register(extensionId, type);
  workerTokens.set(record.token, workerToken);
  changed();
  return record.token;
}

function unregisterProvider(extensionId: string, workerToken: number): boolean {
  for (const record of providers.list()) {
    if (record.extensionId !== extensionId) continue;
    if (workerTokens.get(record.token) !== workerToken) continue;
    providers.unregister(record.token);
    workerTokens.delete(record.token);
    changed();
    return true;
  }
  return false;
}

/**
 * `tasks.fetchTasks()`: the workspace's own tasks, plus every provider's.
 *
 * A provider that throws or never answers is skipped rather than failing the call, because upstream
 * returns what it managed to collect — one broken extension must not make `fetchTasks` unusable for
 * every other. Providers are asked concurrently; they are independent round trips and asking sixteen
 * of them in series would make the timeout cumulative.
 */
async function fetchTasks(type: string | null): Promise<TaskSpec[]> {
  const host = requireBridge();
  const out: TaskSpec[] = [];
  for (const root of host.workspaceRoots()) {
    for (const task of await workspaceTasks(root)) {
      if (type === null || task.definitionType === type) out.push(task);
    }
  }
  const answers = await Promise.all(
    providers.providersFor(type).map(async (record) => {
      try {
        const value = await host.call(
          record.extensionId,
          (id) => ({
            t: 'taskProvide',
            id,
            token: `tasks:${record.token}`,
            providerToken: workerTokens.get(record.token) ?? 0,
          }),
          PROVIDE_TIMEOUT_MS,
        );
        return { record, value };
      } catch (error) {
        log.warn('A task provider did not answer', {
          id: record.extensionId,
          type: record.type,
          error: String(error),
        });
        return { record, value: null };
      }
    }),
  );
  for (const { record, value } of answers) {
    if (!Array.isArray(value)) continue;
    for (const raw of value.slice(0, MAX_TASKS_PER_PROVIDER)) {
      out.push(normalizeTask(raw, record.extensionId));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The workspace's own tasks
// ---------------------------------------------------------------------------
interface TasksJsonCache {
  mtimeMs: number;
  checkedAt: number;
  tasks: TaskSpec[];
}

/**
 * `.vscode/tasks.json`, parsed once per change rather than once per `fetchTasks`.
 *
 * `fetchTasks` is called from the command palette and from extensions on activation, so it is on a
 * path a user waits on. The cache is keyed on the file's mtime and re-checked at most every couple of
 * seconds: an edited `tasks.json` is picked up without the palette ever re-parsing a file that has not
 * changed.
 */
const tasksJson = new Map<string, TasksJsonCache>();

async function workspaceTasks(root: string): Promise<TaskSpec[]> {
  const file = join(root, '.vscode', 'tasks.json');
  const now = Date.now();
  const cached = tasksJson.get(root);
  if (cached && now - cached.checkedAt < TASKS_JSON_CACHE_MS) return cached.tasks;
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    tasksJson.set(root, { mtimeMs: 0, checkedAt: now, tasks: [] });
    return [];
  }
  if (cached && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now;
    return cached.tasks;
  }
  const tasks = await readWorkspaceTasks(file, root);
  tasksJson.set(root, { mtimeMs, checkedAt: now, tasks });
  return tasks;
}

/** Drop the parsed `tasks.json` for every root. Called when the workspace itself changes. */
export function invalidateWorkspaceTasks(): void {
  tasksJson.clear();
}

async function readWorkspaceTasks(file: string, root: string): Promise<TaskSpec[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const parsed: unknown = parseJsonc(text.replace(/^\uFEFF/, ''), [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (typeof parsed !== 'object' || parsed === null) return [];
  const list = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(list)) return [];
  const out: TaskSpec[] = [];
  for (const entry of list.slice(0, MAX_TASKS_PER_PROVIDER)) {
    if (typeof entry !== 'object' || entry === null) continue;
    out.push(normalizeTask(workspaceTaskShape(entry as Record<string, unknown>, root), ''));
  }
  return out;
}

/**
 * One `tasks.json` entry, in the shape `normalizeTask` reads.
 *
 * The translation is small but it is the whole of `tasks.json` compatibility: `label` is the name,
 * `problemMatcher` is singular in the file and plural in the API, `group` may be a string or
 * `{ kind, isDefault }`, and the platform key overrides whatever it names. `cwd` defaults to the folder
 * the file was found in, which is what a task author expects and what stops a relative `command` from
 * resolving against AXIOM's own working directory.
 */
function workspaceTaskShape(entry: Record<string, unknown>, root: string): Record<string, unknown> {
  const merged = { ...entry, ...platformOverride(entry) };
  const type = typeof merged.type === 'string' ? merged.type : 'shell';
  const options = readObject(merged.options);
  const shell = readObject(options.shell);
  const group = merged.group;
  return {
    name: merged.label ?? merged.taskName ?? merged.script ?? 'task',
    source: 'Workspace',
    detail: merged.detail,
    definition: { ...merged, type },
    scope: { uri: { fsPath: root } },
    group: typeof group === 'object' && group !== null ? (group as { kind?: unknown }).kind : group,
    isBackground: merged.isBackground === true,
    problemMatchers: merged.problemMatcher,
    execution: {
      kind: type === 'process' ? 'process' : 'shell',
      command: merged.command,
      args: merged.args,
      options: {
        cwd: options.cwd ?? root,
        env: options.env,
        executable: shell.executable,
        shellArgs: shell.args,
      },
    },
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `tasks.json` lets a task override its fields per platform. Upstream's keys, upstream's precedence. */
function platformOverride(entry: Record<string, unknown>): Record<string, unknown> {
  const key =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  return readObject(entry[key]);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
/**
 * `tasks.executeTask()`.
 *
 * The order of the checks is the security property: the directory is authorised against the workspace
 * before the workspace is asked whether it is trusted, and both happen before anything is registered,
 * let alone spawned. A task that names a directory outside the workspace is refused rather than
 * rewritten to the root, so the extension is never left believing its build ran somewhere it did not.
 */
async function executeTask(extensionId: string, raw: unknown): Promise<ExtensionTaskExecutionInfo> {
  const host = requireBridge();
  // The task is attributed to its caller rather than to whatever `extensionId` the wire claimed: the
  // field decides whose teardown terminates the execution, and an extension may not put its work on
  // another's account.
  const task = normalizeTask(raw, extensionId);
  if (task.execution.kind === 'none') {
    throw new Error(`The task ${task.name} has no command to run.`);
  }
  const cwd = await resolveTaskCwd(task, host.workspaceRoots());
  await assertWorkspaceTrusted(cwd);
  const record = executions.start(task, extensionId, Date.now());
  emit('start', record);
  changed();
  log.info('An extension started a task', {
    id: extensionId,
    task: task.id,
    kind: task.execution.kind,
  });
  if (task.execution.kind === 'custom') await startCustomExecution(record);
  else startProcessExecution(record, cwd, host);
  return describe(record);
}

/** Where a task runs: its own `cwd`, else its folder scope, else the first workspace root. */
async function resolveTaskCwd(task: TaskSpec, roots: readonly string[]): Promise<string> {
  const requested = task.execution.cwd ?? task.scopePath;
  if (requested !== null) return assertAuthorizedPath(requested, { directory: true });
  const root = roots[0];
  if (root === undefined || root.length === 0) {
    throw new Error('No workspace is open, so a task has no directory to run in.');
  }
  return root;
}

/**
 * Spawn the task's process.
 *
 * A `ShellExecution` runs through a shell because that is what it means. A `ProcessExecution` never
 * does — `shell: false` — so an argument containing `&&` or `;` stays one argument instead of becoming
 * a second command; this is the whole reason upstream has two execution kinds and the reason the
 * quoting in `renderShellCommandLine` is confined to the shell branch.
 *
 * On POSIX the child is `detached`, so it leads its own process group and terminating the task can
 * name the whole tree rather than only the shell that spawned the compiler. Windows has no process
 * groups to name, so `taskkill /T` does that job in `killTree` instead.
 */
function startProcessExecution(
  record: TaskExecutionRecord,
  cwd: string,
  host: TasksHostBridge,
): void {
  const execution = record.task.execution;
  const env = { ...host.baseEnvironment(), ...execution.env };
  const detached = process.platform !== 'win32';
  let child: ChildProcess;
  try {
    if (execution.kind === 'shell') {
      const commandLine = renderShellCommandLine(execution, process.platform === 'win32');
      const shell = execution.shellExecutable;
      // A pinned shell with its own arguments is spawned directly: `spawn`'s `shell` option supplies
      // `-c` (or `/d /s /c`) itself and gives no way to replace them, so honouring `shellArgs` means
      // not using it.
      child =
        shell !== null && execution.shellArgs.length > 0
          ? spawn(shell, [...execution.shellArgs, commandLine], {
              cwd,
              env,
              windowsHide: true,
              shell: false,
              detached,
            })
          : spawn(commandLine, [], {
              cwd,
              env,
              windowsHide: true,
              shell: shell ?? true,
              detached,
            });
    } else {
      const argv = renderProcessArgv(execution);
      child = spawn(argv[0] ?? '', argv.slice(1), {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        detached,
      });
    }
  } catch (error) {
    // `spawn` throws synchronously for a malformed command; the execution still has to end, or the
    // extension waits on a promise that never settles.
    log.warn('A task could not be started', { task: record.task.id, error: String(error) });
    host.output(record.id, 'stderr', `${String(error)}\n`);
    endExecution(record.id, 1);
    return;
  }
  processes.set(record.id, child);
  attachProcessStreams(record, child, host);
}

/**
 * The process's streams, and its endings.
 *
 * Output goes to the workbench through the bridge and never to an extension: upstream hands an
 * extension no callback for a task's bytes, and a build log routinely carries registry tokens. Chunks
 * are clamped so a task that `cat`s a binary cannot post a hundred megabytes across an IPC boundary in
 * one message.
 */
function attachProcessStreams(
  record: TaskExecutionRecord,
  child: ChildProcess,
  host: TasksHostBridge,
): void {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    host.output(record.id, 'stdout', chunk.slice(0, MAX_OUTPUT_CHUNK));
  });
  child.stderr?.on('data', (chunk: string) => {
    host.output(record.id, 'stderr', chunk.slice(0, MAX_OUTPUT_CHUNK));
  });
  child.on('spawn', () => {
    executions.attachProcess(record.id, child.pid ?? null);
    emit('processStart', record);
    changed();
  });
  child.on('error', (error: Error) => {
    // A command that does not exist arrives here rather than at `close` with a code, so the execution
    // has to be ended from both places — `endExecution` is idempotent, which is what makes that safe.
    log.warn('A task process failed', { task: record.task.id, error: String(error) });
    host.output(record.id, 'stderr', `${error.message}\n`);
    endExecution(record.id, 1);
  });
  // `close`, not `exit`: it fires once both pipes have drained, so the last line of a build log reaches
  // the panel before the extension is told the task ended.
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    endExecution(record.id, code ?? (signal === null ? 0 : 1));
  });
}

// ---------------------------------------------------------------------------
// A task that is an extension (`CustomExecution`)
// ---------------------------------------------------------------------------
/**
 * Ask the owning host to run the task body.
 *
 * There is no process, so there are no process events: upstream fires neither `onDidStartTaskProcess`
 * nor `onDidEndTaskProcess` for a `CustomExecution`, and an extension waiting on a pid would wait for
 * one that is never coming. `attachProcess(id, null)` moves the state to running without inventing it.
 *
 * The callback lives in the host that called `executeTask` — a function cannot be serialised, so no
 * other host could run this task even if it had fetched it. A host that no longer holds the callback
 * answers with an error and the execution ends rather than hanging.
 */
async function startCustomExecution(record: TaskExecutionRecord): Promise<void> {
  const host = requireBridge();
  customExecutions.set(record.id, record.requestedBy);
  try {
    await host.call(
      record.requestedBy,
      (id) => ({
        t: 'taskCustomStart',
        id,
        executionId: record.id,
        task: wireTask(record.task),
      }),
      CUSTOM_START_TIMEOUT_MS,
    );
  } catch (error) {
    log.warn('A custom task did not start', { task: record.task.id, error: String(error) });
    endExecution(record.id, 1);
    return;
  }
  executions.attachProcess(record.id, null);
  changed();
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------
/**
 * One of the four lifecycle phases, to every running host.
 *
 * Upstream's `onDidStartTask` / `onDidEndTask` fire in every extension host and not only in the
 * requester's — that is how a task-watching extension observes builds it did not start — so
 * broadcasting is the compatible behaviour. It is also the reason `wireTask` exists.
 */
function emit(
  phase: 'start' | 'processStart' | 'processEnd' | 'end',
  record: TaskExecutionRecord,
): void {
  bridge?.broadcast({
    t: 'taskEvent',
    phase,
    executionId: record.id,
    task: wireTask(record.task),
    processId: record.processId,
    exitCode: record.exitCode,
  });
}

/**
 * The task as it is allowed to cross back into an extension host.
 *
 * The environment is dropped. A task's `env` is where a workspace keeps the credentials its build
 * needs, and a lifecycle event reaches every installed extension; this function is the one place those
 * two facts meet, so it is where the environment stops. Nothing upstream reads
 * `task.execution.options.env` out of an event, and main still holds the real values for the spawn.
 */
function wireTask(task: TaskSpec): TaskSpec {
  return { ...task, execution: { ...task.execution, env: {} } };
}

/**
 * End an execution exactly once.
 *
 * `TaskExecutionRegistry.end` returns the record only on the transition, which is what makes this safe
 * to call from `error` and `close` and from a cancellation timer that fired late. The order of the two
 * events is upstream's: `onDidEndTaskProcess` before `onDidEndTask`, and no process event at all for a
 * `CustomExecution`, which never had a process.
 */
function endExecution(executionId: number, exitCode: number | null): void {
  const timer = killTimers.get(executionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    killTimers.delete(executionId);
  }
  processes.delete(executionId);
  const custom = customExecutions.delete(executionId);
  const record = executions.end(executionId, exitCode, Date.now());
  if (!record) return;
  if (!custom && record.task.execution.kind !== 'custom') emit('processEnd', record);
  emit('end', record);
  changed();
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------
/**
 * `TaskExecution.terminate()`.
 *
 * An execution may be terminated by the extension that started it or by the one that provided the
 * task, and by nobody else. The execution id is a small integer, so without this check an extension
 * could count its way through the range and cancel builds it has nothing to do with.
 */
function terminateTask(extensionId: string, executionId: number): boolean {
  const record = executions.get(executionId);
  if (!record) return false;
  if (record.requestedBy !== extensionId && record.task.extensionId !== extensionId) {
    throw new Error('That task execution does not belong to this extension.');
  }
  cancelExecution(record);
  return true;
}

/**
 * Stop an execution, politely first.
 *
 * A custom task is *asked* to cancel, because the only thing that can stop it is the extension running
 * it. A process is signalled. Either way the impolite ending is armed: an extension that ignores its
 * cancellation, or a process that ignores SIGTERM, must not leave an execution running forever holding
 * one of the eight concurrency slots.
 */
function cancelExecution(record: TaskExecutionRecord): void {
  executions.markCancelled(record.id);
  changed();
  const owner = customExecutions.get(record.id);
  if (owner !== undefined) {
    bridge?.deliver(owner, { t: 'taskCustomCancel', executionId: record.id });
    arm(record.id, () => endExecution(record.id, 1));
    return;
  }
  const child = processes.get(record.id);
  if (child) {
    killTree(child);
    arm(record.id, () => endExecution(record.id, 1));
    return;
  }
  // Nothing to signal: the spawn either has not happened yet or already failed.
  endExecution(record.id, 1);
}

/** Arm the impolite ending. Replaces any timer already armed, and never holds the process open. */
function arm(executionId: number, action: () => void): void {
  const previous = killTimers.get(executionId);
  if (previous !== undefined) clearTimeout(previous);
  const timer = setTimeout(action, KILL_GRACE_MS * 2);
  timer.unref();
  killTimers.set(executionId, timer);
}

/**
 * Kill the process and everything it started.
 *
 * A task is usually a shell that spawned a compiler that spawned a linker, so signalling only the child
 * leaves the tree running and whatever lock it holds held. `terminateProcessTree` is the helper AXIOM's
 * own supervised processes already use: it resolves `taskkill.exe` out of `%SystemRoot%` rather than
 * trusting `PATH`, signals the process group on POSIX — which is what the `detached` spawn above is for
 * — escalates to SIGKILL, and registers the teardown with the shutdown drain so a quit cannot outrun it.
 */
function killTree(child: ChildProcess): void {
  void terminateProcessTree(child, KILL_GRACE_MS).catch((error: unknown) => {
    log.warn('A task process tree could not be terminated', {
      pid: child.pid ?? 0,
      error: String(error),
    });
  });
}

/**
 * The extension says its `CustomExecution` has ended.
 *
 * Only the host actually running it may say so: the exit code becomes the execution's, and an extension
 * must not be able to declare another's task finished.
 */
function finishCustomTask(extensionId: string, executionId: number, exitCode: number): boolean {
  const owner = customExecutions.get(executionId);
  if (owner === undefined) return false;
  if (owner !== extensionId) {
    throw new Error('That custom task execution does not belong to this extension.');
  }
  endExecution(executionId, Number.isFinite(exitCode) ? exitCode : 0);
  return true;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
/**
 * An extension stopped, was reloaded, or crashed.
 *
 * Providers go first so that a `fetchTasks` racing the teardown cannot call into a host that is on its
 * way out, and then every execution the extension owns is cancelled — a build must not outlive the
 * extension that started it, because nothing would be left to terminate it or to read its result.
 */
export function disposeTasksForExtension(extensionId: string): number {
  for (const record of providers.removeExtension(extensionId)) workerTokens.delete(record.token);
  const running = executions.forExtension(extensionId);
  for (const record of running) cancelExecution(record);
  if (running.length > 0) {
    log.info('Task executions were cancelled with their extension', {
      id: extensionId,
      count: running.length,
    });
  }
  changed();
  return running.length;
}

/** Counters for the validators and the diagnostics panel. Carries no command lines. */
export function extensionTasksState(): {
  providers: number;
  executions: number;
  running: number;
  processes: number;
  custom: number;
  revision: number;
} {
  return {
    providers: providers.size,
    executions: executions.size,
    running: executions.runningCount(),
    processes: processes.size,
    custom: customExecutions.size,
    revision,
  };
}

/**
 * Drop everything, for the validators.
 *
 * Timers are cleared rather than abandoned: a leaked kill timer would fire into the next test's
 * execution ids. Live processes are killed, because a validator that left a spawned shell behind would
 * leak one per run.
 */
export function resetExtensionTasksForTesting(): void {
  for (const timer of killTimers.values()) clearTimeout(timer);
  killTimers.clear();
  for (const child of processes.values()) killTree(child);
  processes.clear();
  customExecutions.clear();
  providers.clear();
  executions.clear();
  workerTokens.clear();
  tasksJson.clear();
  revision = 1;
  bridge = null;
}
