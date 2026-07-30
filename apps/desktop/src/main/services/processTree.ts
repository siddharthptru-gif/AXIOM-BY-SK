import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 2_000;
const inFlight = new Set<Promise<void>>();
const completedFailures: unknown[] = [];

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function killDirect(child: ChildProcess, signal?: NodeJS.Signals): void {
  if (exited(child)) return;
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited between the state check and kill.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didExit: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(didExit);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(exited(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroup(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(pid);
}

async function terminateProcessTreeImpl(child: ChildProcess, timeoutMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    killDirect(child);
    await waitForExit(child, timeoutMs);
    return;
  }

  if (process.platform === 'win32') {
    const executable = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
      : 'taskkill.exe';
    let code: number | null = null;
    try {
      const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      code = await new Promise<number | null>((resolve) => {
        let settled = false;
        const finish = (result: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          killDirect(killer);
          finish(null);
        }, timeoutMs);
        killer.once('error', () => finish(null));
        killer.once('close', finish);
      });
    } catch {
      code = null;
    }
    if (code !== 0) {
      killDirect(child);
      if (!exited(child)) {
        throw new Error(`Could not terminate Windows process tree ${pid}.`);
      }
    }
    await waitForExit(child, timeoutMs);
    return;
  }

  // Every supervised POSIX service is spawned detached, making its PID the
  // process-group id. Group signals still reach descendants after the parent exits.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    killDirect(child, 'SIGTERM');
  }
  if (!(await waitForProcessGroup(pid, timeoutMs))) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      killDirect(child, 'SIGKILL');
    }
    if (!(await waitForProcessGroup(pid, timeoutMs))) {
      throw new Error(`Could not terminate POSIX process group ${pid}.`);
    }
  }
}

/** Terminate a supervised child tree and retain the promise for final app drain. */
export function terminateProcessTree(
  child: ChildProcess,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const task = terminateProcessTreeImpl(child, timeoutMs);
  inFlight.add(task);
  void task.then(
    () => inFlight.delete(task),
    (error: unknown) => {
      inFlight.delete(task);
      completedFailures.push(error);
    },
  );
  return task;
}

/** Await teardown started by renderer/process events before the final clean exit. */
export async function drainProcessTerminations(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
  const failure = completedFailures.shift();
  completedFailures.length = 0;
  if (failure !== undefined) throw failure;
}
