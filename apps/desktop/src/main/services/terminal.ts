import fs from 'node:fs';
import { join, normalize } from 'node:path';
import type { IPty } from 'node-pty';
import type { WebContents } from 'electron';
import { rootLogger } from '@axiom/shared';
import {
  IPC,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalShellInfo,
} from '../../common/ipc';
import { buildChildProcessEnvironment } from './processEnvironment';
import { assertPathInTrustedWorkspace, assertWorkspaceTrusted } from './workspaceTrust';

/**
 * Integrated terminal service (Main process, PRD Epoch D). Spawns real PTYs via
 * node-pty (N-API prebuild — ConPTY on modern Windows) and streams I/O to the
 * requesting renderer. Supports PowerShell, Command Prompt, Git Bash, and WSL,
 * launched in the workspace directory. Terminals are tracked per id and cleaned
 * up on exit or when their renderer goes away.
 */
const log = rootLogger.child('terminal');

/**
 * node-pty is a NATIVE module. It is loaded LAZILY (only when the first terminal
 * is created) and defensively: a missing or ABI-incompatible native binary must
 * NEVER crash app startup — which is exactly what the previous eager top-level
 * `import { spawn } from 'node-pty'` did (the whole app failed to open if the
 * packaged binary didn't match). If node-pty can't load, the integrated terminal
 * is disabled with a clear error, but the rest of the app runs normally.
 */
type NodePty = typeof import('node-pty');
let ptyModule: NodePty | null | undefined;

function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = require('node-pty') as NodePty;
  } catch (error) {
    ptyModule = null;
    log.error('node-pty unavailable — integrated terminal disabled', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return ptyModule;
}

interface TerminalRecord {
  pty: IPty;
  root: string;
  owner: WebContents;
  exited: Promise<void>;
  resolveExited: () => void;
  termination: Promise<void> | null;
}

const terminals = new Map<string, TerminalRecord>();
const terminalOwners = new WeakSet<WebContents>();
const terminalTerminations = new Set<Promise<void>>();
const terminalFailures: unknown[] = [];

function pathKey(path: string): string {
  const value = normalize(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function programFilesDirs(): string[] {
  const dirs = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ];
  return dirs.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

function pwshPath(): string | null {
  for (const base of programFilesDirs()) {
    const p = join(base, 'PowerShell', '7', 'pwsh.exe');
    if (existsFile(p)) return p;
  }
  return null;
}

function gitBashPath(): string | null {
  for (const base of programFilesDirs()) {
    const p = join(base, 'Git', 'bin', 'bash.exe');
    if (existsFile(p)) return p;
  }
  return null;
}

function wslPath(): string | null {
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const p = join(sysRoot, 'System32', 'wsl.exe');
  return existsFile(p) ? p : null;
}

/** Discover the shells available on this machine (Windows). */
export function listShells(): TerminalShellInfo[] {
  const shells: TerminalShellInfo[] = [];
  if (pwshPath()) shells.push({ id: 'pwsh', label: 'PowerShell' });
  shells.push({ id: 'powershell', label: 'Windows PowerShell' });
  shells.push({ id: 'cmd', label: 'Command Prompt' });
  if (gitBashPath()) shells.push({ id: 'gitbash', label: 'Git Bash' });
  if (wslPath()) shells.push({ id: 'wsl', label: 'WSL' });
  return shells;
}

/** Resolve a shell id into an executable + args, falling back sensibly. */
function resolveShell(id: string): { shell: string; file: string; args: string[] } {
  switch (id) {
    case 'cmd':
      return { shell: 'cmd', file: process.env.ComSpec ?? 'cmd.exe', args: [] };
    case 'gitbash': {
      const gb = gitBashPath();
      return gb
        ? { shell: 'gitbash', file: gb, args: ['--login', '-i'] }
        : { shell: 'powershell', file: 'powershell.exe', args: [] };
    }
    case 'wsl': {
      const wsl = wslPath();
      return wsl
        ? { shell: 'wsl', file: wsl, args: [] }
        : { shell: 'powershell', file: 'powershell.exe', args: [] };
    }
    case 'pwsh': {
      const pwsh = pwshPath();
      return pwsh
        ? { shell: 'pwsh', file: pwsh, args: ['-NoLogo'] }
        : { shell: 'powershell', file: 'powershell.exe', args: ['-NoLogo'] };
    }
    case 'powershell':
    default:
      return { shell: 'powershell', file: 'powershell.exe', args: ['-NoLogo'] };
  }
}

/** Positive non-secret environment map accepted by node-pty. */
function cleanEnv(): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(buildChildProcessEnvironment({ color: true }))) {
    if (typeof value === 'string') out[key] = value;
  }
  out.TERM = out.TERM ?? 'xterm-256color';
  return out;
}

function ownedTerminal(id: string, owner: WebContents): TerminalRecord {
  const record = terminals.get(id);
  if (!record) throw new Error(`Terminal is not active: ${id}`);
  if (record.owner !== owner) throw new Error('Terminal is owned by another renderer.');
  return record;
}

function killRecord(id: string, record: TerminalRecord): Promise<void> {
  if (record.termination) return record.termination;
  if (terminals.get(id) === record) terminals.delete(id);
  if (process.platform !== 'win32') {
    try {
      process.kill(-record.pty.pid, 'SIGTERM');
    } catch {
      // node-pty still gets a direct kill below.
    }
  }
  try {
    record.pty.kill();
  } catch {
    record.resolveExited();
  }
  const termination = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-record.pty.pid, 'SIGKILL');
        } catch {
          // The process group may already be gone.
        }
      }
      try {
        record.pty.kill();
      } catch {
        // Continue to the explicit failure below.
      }
      reject(new Error(`Terminal process tree did not exit: ${id}`));
    }, 6_000);
    void record.exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  record.termination = termination;
  terminalTerminations.add(termination);
  void termination.then(
    () => terminalTerminations.delete(termination),
    (error: unknown) => {
      terminalTerminations.delete(termination);
      terminalFailures.push(error);
    },
  );
  return termination;
}

/**
 * Main-resolved spawn details for a pane an extension asked for (PRD Phase 7).
 *
 * Never assembled from renderer input. `main/ipc.ts` looks this up by handle in the extension
 * terminal registry, so an extension's requested shell, directory and environment reach node-pty
 * without ever crossing the preload boundary — the renderer only ever echoes back the handle.
 */
export interface TerminalSpawnOverride {
  /** Shell id from `TerminalShellInfo`, or '' for the workbench default. */
  shell: string;
  /** Directory the extension asked for; re-checked against the trusted root before use. */
  cwd: string;
  /** The complete environment for this pane: base + collections + the extension's own `env`. */
  env: Record<string, string>;
}

/** Spawn a pty, stream its output to `owner`, and track it by id and workspace. */
export async function createTerminal(
  opts: TerminalCreateOptions,
  owner: WebContents,
  override: TerminalSpawnOverride | null = null,
): Promise<TerminalCreateResult> {
  const root = await assertWorkspaceTrusted(opts.cwd);
  if (terminals.has(opts.id)) {
    throw new Error(`Terminal id is already in use: ${opts.id}`);
  }

  const pty = loadPty();
  if (!pty) {
    throw new Error(
      'Integrated terminal unavailable: the node-pty native module failed to load on this system.',
    );
  }

  // An extension's directory is authorized a second time here, against this pane's trusted root,
  // because the two checks answer different questions: the registry's check said "the user let
  // something reach that path", this one says "it is inside the workspace this terminal belongs to".
  const cwd =
    override && override.cwd.length > 0
      ? await assertPathInTrustedWorkspace(root, override.cwd, { directory: true })
      : root;
  const resolved = resolveShell(
    override && override.shell.length > 0 ? override.shell : opts.shell,
  );
  // `strictEnv` is honoured by replacing rather than merging: an extension that asked for an
  // isolated environment must not receive the allowlist back through the workbench default.
  const env = override ? { ...override.env } : cleanEnv();
  env.TERM = env.TERM ?? 'xterm-256color';
  const cols = opts.cols > 0 ? Math.floor(opts.cols) : 80;
  const rows = opts.rows > 0 ? Math.floor(opts.rows) : 24;
  const term = pty.spawn(resolved.file, resolved.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const record: TerminalRecord = {
    pty: term,
    root,
    owner,
    exited,
    resolveExited,
    termination: null,
  };

  term.onData((data) => {
    if (terminals.get(opts.id) === record && !owner.isDestroyed()) {
      owner.send(IPC.termData, { id: opts.id, data });
    }
  });
  term.onExit(({ exitCode }) => {
    record.resolveExited();
    const current = terminals.get(opts.id);
    if (current === record) terminals.delete(opts.id);
    // Do not let a late exit from a killed terminal affect a newly-created
    // terminal that happens to reuse the same id.
    if ((current === record || current === undefined) && !owner.isDestroyed()) {
      owner.send(IPC.termExit, { id: opts.id, exitCode });
    }
  });

  terminals.set(opts.id, record);
  if (!terminalOwners.has(owner)) {
    terminalOwners.add(owner);
    owner.once('destroyed', () => killForSender(owner));
  }

  log.info('Terminal created', {
    id: opts.id,
    root,
    shell: resolved.shell,
    pid: term.pid,
  });
  return { id: opts.id, pid: term.pid, shell: resolved.shell };
}

export async function writeTerminal(id: string, data: string, owner: WebContents): Promise<void> {
  const record = ownedTerminal(id, owner);
  await assertWorkspaceTrusted(record.root);
  if (terminals.get(id) !== record || record.owner !== owner) {
    throw new Error(`Terminal is not active: ${id}`);
  }
  record.pty.write(data);
}

export async function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
  owner: WebContents,
): Promise<void> {
  const record = ownedTerminal(id, owner);
  await assertWorkspaceTrusted(record.root);
  if (terminals.get(id) !== record || record.owner !== owner) {
    throw new Error(`Terminal is not active: ${id}`);
  }
  if (cols > 0 && rows > 0) {
    try {
      record.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* resize can throw if the pty just exited; ignore */
    }
  }
}

/** Owner-checked cleanup. Trust is deliberately not required for termination. */
export function killTerminal(id: string, owner: WebContents): Promise<void> {
  const record = terminals.get(id);
  if (!record) return Promise.resolve();
  if (record.owner !== owner) throw new Error('Terminal is owned by another renderer.');
  return killRecord(id, record);
}

/** Kill every terminal owned by a renderer (called when it is destroyed). */
export function killForSender(owner: WebContents): void {
  for (const [id, record] of terminals) {
    if (record.owner === owner) void killRecord(id, record).catch(() => undefined);
  }
}

/** Kill every terminal for a canonical workspace without consulting trust. */
export async function killForWorkspace(root: string): Promise<void> {
  const key = pathKey(root);
  await Promise.all(
    [...terminals.entries()]
      .filter(([, record]) => pathKey(record.root) === key)
      .map(([id, record]) => killRecord(id, record)),
  );
}

/** App-shutdown cleanup for all terminal process trees (node-pty owns tree teardown). */
export async function killAllTerminals(): Promise<void> {
  const started = [...terminals.entries()].map(([id, record]) => killRecord(id, record));
  await Promise.allSettled([...started, ...terminalTerminations]);
  const failure = terminalFailures.shift();
  terminalFailures.length = 0;
  if (failure !== undefined) throw failure;
}
