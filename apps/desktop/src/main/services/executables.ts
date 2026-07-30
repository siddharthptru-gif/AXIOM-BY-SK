import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { buildChildProcessEnvironment } from './processEnvironment';

/**
 * Executable resolution — "is this tool installed, and where?"
 *
 * This exists because a single strategy is provably not enough on Windows, and
 * getting it wrong makes AXIOM tell the user a tool they have is missing.
 *
 * Measured on a real machine:
 *
 *   python  PATH+existsSync -> NOT FOUND   spawn by name -> Python 3.13.14
 *   npm     PATH+existsSync -> npm.CMD     spawn by name -> ENOENT
 *
 * Two independent failure modes:
 *
 * 1. APP EXECUTION ALIASES. A Microsoft Store Python lives in
 *    `%LOCALAPPDATA%\Microsoft\WindowsApps`, which IS on PATH, but its entries are
 *    zero-length reparse points. `existsSync` stats them and gets EACCES, so the
 *    scan reports nothing even though the OS launches them fine.
 * 2. SHELL SHIMS. `npm` is `npm.cmd`, and Node refuses to spawn a `.cmd` without a
 *    shell, so spawning the bare name fails even though the tool exists.
 *
 * So resolution tries, in order:
 *   a) a PATH + PATHEXT scan — fast, and yields an absolute path;
 *   b) the OS's OWN resolver (`where` on Windows, `which` elsewhere) — this is the
 *      authority, and the only thing that sees execution aliases;
 *   c) spawning the name with a harmless version flag — proof by execution.
 *
 * Every spawn here is read-only, argument-fixed by the caller, bounded by a timeout,
 * and runs with the narrow allowlisted child environment.
 */

const PROBE_TIMEOUT_MS = 4_000;
const PROBE_OUTPUT_CAP = 4_000;

export interface ResolvedExecutable {
  /** The base name that resolved (e.g. `python3` when `python` was absent). */
  command: string;
  /**
   * Absolute path when one could be determined. For an execution alias resolved by
   * name only, this is the bare command — which is what must be spawned anyway.
   */
  path: string;
  /** How it was found, for diagnostics. */
  via: 'path-scan' | 'os-resolver' | 'spawn';
}

function childEnv(): NodeJS.ProcessEnv {
  return buildChildProcessEnvironment({ color: false });
}

/** Windows `.cmd`/`.bat` shims cannot be spawned by CreateProcess directly. */
export function isShellShim(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

/** Strategy (a): scan PATH × PATHEXT. Fast, but blind to execution aliases. */
function scanPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const raw = env.PATH ?? env.Path ?? '';
  const dirs = raw.split(delimiter).filter((entry) => entry.length > 0);
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry.length > 0)
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // An unreadable PATH entry is skipped rather than failing the whole scan.
      }
    }
  }
  return null;
}

/** Run a bounded, read-only probe and return its combined output, or null. */
function runProbe(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, [...args], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    let failed = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      resolve(failed ? null : output);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish();
    }, PROBE_TIMEOUT_MS);
    const append = (chunk: Buffer): void => {
      if (output.length < PROBE_OUTPUT_CAP) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', () => {
      // A spawn error means this strategy did not work — not that output was empty.
      failed = true;
      finish();
    });
    child.on('close', finish);
  });
}

/**
 * The OS resolver's absolute path for a command. `where`/`which` are spawned by
 * absolute path with no shell, so nothing here is interpreted as a command line.
 */
async function osResolve(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.WINDIR ?? env.windir;
    if (!systemRoot) return null;
    const where = join(systemRoot, 'System32', 'where.exe');
    if (!existsSync(where)) return null;
    const output = await runProbe(where, [command], env);
    const first = output?.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first && !/INFO:/i.test(first) ? first.trim() : null;
  }
  for (const which of ['/usr/bin/which', '/bin/which']) {
    if (!existsSync(which)) continue;
    const output = await runProbe(which, [command], env);
    const first = output?.split('\n').find((line) => line.trim().length > 0);
    if (first && first.startsWith('/')) return first.trim();
  }
  return null;
}

/**
 * Resolve the first of `commands` that this machine can run.
 *
 * `versionArgs` is used only for the final proof-by-execution step, so it must be a
 * flag that merely prints information.
 */
export async function resolveExecutable(
  commands: readonly string[],
  versionArgs: readonly string[] = ['--version'],
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<ResolvedExecutable | null> {
  for (const command of commands) {
    const scanned = scanPath(command, env);
    if (scanned) return { command, path: scanned, via: 'path-scan' };
  }
  for (const command of commands) {
    const resolved = await osResolve(command, env);
    if (resolved) return { command, path: resolved, via: 'os-resolver' };
  }
  // Last resort: if it runs, it exists. This is what catches a tool reachable only
  // through a mechanism neither the scan nor the resolver reported.
  for (const command of commands) {
    if (isShellShim(command)) continue;
    const output = await runProbe(command, versionArgs, env);
    if (output !== null) return { command, path: command, via: 'spawn' };
  }
  return null;
}

/**
 * Read a tool's version string. Returns null when it cannot be determined — which
 * is not the same as the tool being absent, so callers must not treat it as such.
 */
export async function readVersion(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<string | null> {
  // A shim needs the interpreter, and building a command line for it is not worth
  // the risk here: the tool's existence is already established.
  if (isShellShim(executable)) return null;
  const output = await runProbe(executable, args, env);
  if (output === null) return null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line.slice(0, 160);
  }
  return null;
}
