import { app, type WebContents } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CreateIsolatedWorkspaceInput,
  IsolatedWorkspaceProfile,
  RemoteProbeResult,
  WorkspaceBackend,
  WorkspaceCommandResult,
  WorkspaceProbeInput,
} from '../../common/godMode';
import { boundedText, validateWorkspaceBackendInput } from '../../common/godMode';
import { cloneLocalRepository } from './systemGit';
import { getStatus } from './git';
import { terminateProcessTree } from './processTree';
import { buildChildProcessEnvironment } from './processEnvironment';

const STORE_VERSION = 1;
const MAX_OUTPUT_CHARS = 1_000_000;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/;
const REMOTE_PATH = /^[A-Za-z0-9_./~ +:@-]{1,1_024}$/;

interface WorkspaceStore {
  version: typeof STORE_VERSION;
  profiles: IsolatedWorkspaceProfile[];
}

interface RunningCommand {
  ownerId: number;
  root: string;
  profileId: string;
  child: ChildProcess;
}

let operationTail: Promise<void> = Promise.resolve();
const running = new Map<string, RunningCommand>();

interface IsolatedOperation {
  ownerId: number;
  root: string;
  controller: AbortController;
}

const operations = new Map<string, IsolatedOperation>();

export interface IsolatedOperationLease {
  signal: AbortSignal;
  release: () => void;
}

export function beginIsolatedOperation(ownerId: number, root: string): IsolatedOperationLease {
  const id = randomUUID();
  const operation: IsolatedOperation = { ownerId, root, controller: new AbortController() };
  operations.set(id, operation);
  return {
    signal: operation.controller.signal,
    release: () => {
      if (operations.get(id) === operation) operations.delete(id);
    },
  };
}

function cancelIsolatedOperations(predicate: (operation: IsolatedOperation) => boolean): void {
  for (const [id, operation] of operations) {
    if (!predicate(operation)) continue;
    operations.delete(id);
    operation.controller.abort();
  }
}

export function cancelIsolatedOperationsForOwner(ownerId: number): void {
  cancelIsolatedOperations((operation) => operation.ownerId === ownerId);
}

export function cancelIsolatedOperationsForWorkspace(root: string): void {
  const key = rootKey(root);
  cancelIsolatedOperations((operation) => rootKey(operation.root) === key);
}

function baseDir(): string {
  return join(app.getPath('userData'), 'god-mode', 'workspaces');
}

function rootKey(root: string): string {
  const canonical = resolve(root);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function storePath(): string {
  return join(app.getPath('userData'), 'god-mode', 'isolated-workspaces.json');
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isProfile(value: unknown): value is IsolatedWorkspaceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    ['local-clone', 'wsl', 'ssh', 'dev-container'].includes(String(item.backend)) &&
    typeof item.sourceRoot === 'string' &&
    typeof item.workspacePath === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number' &&
    ['creating', 'ready', 'busy', 'stopped', 'error'].includes(String(item.status)) &&
    Array.isArray(item.reproducibilityFiles) &&
    (typeof item.lastError === 'string' || item.lastError === null)
  );
}

async function readStore(): Promise<WorkspaceStore> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(storePath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: STORE_VERSION, profiles: [] };
    }
    const value = parsed as { version?: unknown; profiles?: unknown };
    if (value.version !== STORE_VERSION || !Array.isArray(value.profiles)) {
      return { version: STORE_VERSION, profiles: [] };
    }
    return { version: STORE_VERSION, profiles: value.profiles.filter(isProfile).slice(0, 100) };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError)
      return { version: STORE_VERSION, profiles: [] };
    throw error;
  }
}

async function writeStore(store: WorkspaceStore): Promise<void> {
  const path = storePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.isolated-workspaces-${randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function reproductionFiles(root: string): Promise<string[]> {
  const candidates = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'Cargo.lock',
    'go.sum',
    'requirements.txt',
    'poetry.lock',
    'Dockerfile',
    '.devcontainer/devcontainer.json',
  ];
  return Promise.all(
    candidates.map(async (name) => {
      try {
        return (await fs.stat(join(root, name))).isFile() ? name : null;
      } catch {
        return null;
      }
    }),
  ).then((items) => items.filter((item): item is string => item !== null));
}

function executableFor(backend: WorkspaceBackend): { command: string; args: string[] } {
  const system32 = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '';
  switch (backend) {
    case 'local-clone':
      return { command: 'git', args: ['--version'] };
    case 'wsl':
      return { command: system32 ? join(system32, 'wsl.exe') : 'wsl.exe', args: ['--version'] };
    case 'ssh':
      return {
        command: system32 ? join(system32, 'OpenSSH', 'ssh.exe') : 'ssh.exe',
        args: ['-V'],
      };
    case 'dev-container':
      return { command: 'docker.exe', args: ['--version'] };
  }
}

async function captureProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    ownerId?: number;
    profileId?: string;
    root?: string;
    signal?: AbortSignal;
  },
): Promise<{ code: number | null; output: string; truncated: boolean; durationMs: number }> {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: buildChildProcessEnvironment({ ci: true, color: false }),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (options.profileId && options.ownerId !== undefined && options.root) {
    running.set(options.profileId, {
      ownerId: options.ownerId,
      root: options.root,
      profileId: options.profileId,
      child,
    });
  }
  let output = '';
  let truncated = false;
  const append = (chunk: Buffer): void => {
    if (output.length >= MAX_OUTPUT_CHARS) {
      truncated = true;
      return;
    }
    const next = output + chunk.toString('utf-8');
    truncated ||= next.length > MAX_OUTPUT_CHARS;
    output = next.slice(0, MAX_OUTPUT_CHARS);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolveCode, reject) => {
      let settled = false;
      const finish = (value: number | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolveCode(value);
      };
      const onAbort = (): void => {
        void terminateProcessTree(child).finally(() =>
          finish(null, new Error('Workspace operation was cancelled.')),
        );
      };
      const timer = setTimeout(() => {
        void terminateProcessTree(child).finally(() =>
          finish(null, new Error('Workspace command timed out.')),
        );
      }, options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      child.once('error', (error) => finish(null, error));
      child.once('close', (value) => finish(value));
    });
  } finally {
    if (options.profileId && running.get(options.profileId)?.child === child) {
      running.delete(options.profileId);
    }
  }
  return {
    code,
    output: output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(),
    truncated,
    durationMs: Date.now() - startedAt,
  };
}

export async function probeWorkspaceBackend(
  backend: WorkspaceBackend,
  signal?: AbortSignal,
): Promise<RemoteProbeResult> {
  signal?.throwIfAborted();
  const executable = executableFor(backend);
  try {
    const result = await captureProcess(executable.command, executable.args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const version = boundedText(result.output.split(/\r?\n/)[0], 300) || null;
    return {
      backend,
      available: result.code === 0,
      version,
      message: result.code === 0 ? 'Backend is available.' : 'Backend probe did not succeed.',
      durationMs: result.durationMs,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      backend,
      available: false,
      version: null,
      message: error instanceof Error ? boundedText(error.message, 300) : 'Backend is unavailable.',
    };
  }
}

function validatedProbeInput(root: string, raw: unknown): WorkspaceProbeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Workspace target probe input is required.');
  }
  const item = raw as Record<string, unknown>;
  if (!['local-clone', 'wsl', 'ssh', 'dev-container'].includes(String(item.backend))) {
    throw new Error('Unknown workspace backend.');
  }
  const input: WorkspaceProbeInput = {
    root,
    backend: item.backend as WorkspaceBackend,
    ...(typeof item.workspacePath === 'string'
      ? { workspacePath: boundedText(item.workspacePath, 1_024) }
      : {}),
    ...(typeof item.distro === 'string' ? { distro: boundedText(item.distro, 100) } : {}),
    ...(typeof item.host === 'string' ? { host: boundedText(item.host, 253) } : {}),
    ...(typeof item.user === 'string' ? { user: boundedText(item.user, 100) } : {}),
    ...(typeof item.container === 'string' ? { container: boundedText(item.container, 200) } : {}),
  };
  const errors = validateWorkspaceBackendInput({
    ...input,
    name: 'Target probe',
    confirmation: true,
  });
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (input.distro && !DISTRO.test(input.distro)) throw new Error('WSL distro name is invalid.');
  if (input.host && !HOST.test(input.host)) throw new Error('SSH host is invalid.');
  if (input.user && !USER.test(input.user)) throw new Error('SSH user is invalid.');
  if (input.container && !CONTAINER.test(input.container)) {
    throw new Error('Container name is invalid.');
  }
  if (input.workspacePath && !REMOTE_PATH.test(input.workspacePath)) {
    throw new Error('Remote workspace path is invalid.');
  }
  return input;
}

/** Probe both the installed backend and the exact configured target using a bounded `pwd`. */
export async function probeWorkspaceTarget(
  root: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<RemoteProbeResult> {
  const input = validatedProbeInput(root, raw);
  const backendProbe = await probeWorkspaceBackend(input.backend, signal);
  signal?.throwIfAborted();
  if (!backendProbe.available) return backendProbe;

  const now = Date.now();
  const profile: IsolatedWorkspaceProfile = {
    id: 'target-probe',
    name: 'Target probe',
    backend: input.backend,
    sourceRoot: root,
    workspacePath: input.backend === 'local-clone' ? root : input.workspacePath!,
    ...(input.distro ? { distro: input.distro } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.user ? { user: input.user } : {}),
    ...(input.container ? { container: input.container } : {}),
    createdAt: now,
    updatedAt: now,
    status: 'creating',
    reproducibilityFiles: [],
    lastError: null,
  };
  try {
    const target = commandForProfile(profile, 'pwd');
    const result = await captureProcess(target.executable, target.args, {
      ...(target.cwd ? { cwd: target.cwd } : {}),
      timeoutMs: PROBE_TIMEOUT_MS * 2,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const targetPath = boundedText(result.output.split(/\r?\n/)[0], 1_024) || null;
    return {
      backend: input.backend,
      available: result.code === 0 && targetPath !== null,
      version: backendProbe.version,
      targetPath,
      durationMs: (backendProbe.durationMs ?? 0) + result.durationMs,
      message:
        result.code === 0 && targetPath
          ? 'The exact configured workspace target is reachable.'
          : boundedText(result.output, 300) || 'The configured workspace target did not respond.',
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      backend: input.backend,
      available: false,
      version: backendProbe.version,
      targetPath: null,
      message:
        error instanceof Error
          ? boundedText(error.message, 300)
          : 'The configured workspace target is unavailable.',
    };
  }
}

export function listIsolatedWorkspaces(root: string): Promise<IsolatedWorkspaceProfile[]> {
  return serialize(async () => {
    const key = rootKey(root);
    return (await readStore()).profiles
      .filter((profile) => rootKey(profile.sourceRoot) === key)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

function validatedInput(root: string, raw: unknown): CreateIsolatedWorkspaceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Isolated workspace input is required.');
  }
  const item = raw as Record<string, unknown>;
  const backend: WorkspaceBackend =
    item.backend === 'wsl' || item.backend === 'ssh' || item.backend === 'dev-container'
      ? item.backend
      : 'local-clone';
  const value: CreateIsolatedWorkspaceInput = {
    root,
    name: boundedText(item.name, 100),
    backend,
    ...(typeof item.workspacePath === 'string'
      ? { workspacePath: boundedText(item.workspacePath, 1_024) }
      : {}),
    ...(typeof item.distro === 'string' ? { distro: boundedText(item.distro, 100) } : {}),
    ...(typeof item.host === 'string' ? { host: boundedText(item.host, 253) } : {}),
    ...(typeof item.user === 'string' ? { user: boundedText(item.user, 100) } : {}),
    ...(typeof item.container === 'string' ? { container: boundedText(item.container, 200) } : {}),
    confirmation: item.confirmation === true,
  };
  const errors = validateWorkspaceBackendInput(value);
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (!value.confirmation)
    throw new Error('Creating an isolated workspace requires explicit confirmation.');
  if (value.distro && !DISTRO.test(value.distro)) throw new Error('WSL distro name is invalid.');
  if (value.host && !HOST.test(value.host)) throw new Error('SSH host is invalid.');
  if (value.user && !USER.test(value.user)) throw new Error('SSH user is invalid.');
  if (value.container && !CONTAINER.test(value.container))
    throw new Error('Container name is invalid.');
  if (value.workspacePath && !REMOTE_PATH.test(value.workspacePath))
    throw new Error('Remote workspace path is invalid.');
  return value;
}

export interface IsolatedWorkspaceApprovalDescriptor {
  digest: string;
  detail: string;
}

function creationApprovalIdentity(input: CreateIsolatedWorkspaceInput): Record<string, unknown> {
  return {
    root: input.root,
    name: input.name,
    backend: input.backend,
    workspacePath:
      input.backend === 'local-clone' ? '[managed Main-owned path]' : input.workspacePath,
    distro: input.distro ?? null,
    host: input.host ?? null,
    user: input.user ?? null,
    container: input.container ?? null,
  };
}

export function prepareIsolatedWorkspaceCreationApproval(
  root: string,
  raw: unknown,
): IsolatedWorkspaceApprovalDescriptor {
  const input = validatedInput(root, raw);
  const canonical = JSON.stringify(creationApprovalIdentity(input));
  return {
    digest: createHash('sha256').update(canonical).digest('hex'),
    detail: JSON.stringify(creationApprovalIdentity(input), null, 2),
  };
}

export async function createIsolatedWorkspace(
  root: string,
  raw: unknown,
  approved: IsolatedWorkspaceApprovalDescriptor,
  signal?: AbortSignal,
): Promise<IsolatedWorkspaceProfile> {
  signal?.throwIfAborted();
  const input = validatedInput(root, raw);
  const currentApproval = prepareIsolatedWorkspaceCreationApproval(root, raw);
  if (approved.digest !== currentApproval.digest) {
    throw new Error('Isolated workspace configuration changed after approval.');
  }
  return serialize(async () => {
    signal?.throwIfAborted();
    const store = await readStore();
    if (store.profiles.length >= 100)
      throw new Error('The isolated workspace limit has been reached.');
    const id = randomUUID();
    const now = Date.now();
    const managedPath = join(baseDir(), id, 'repo');
    const profile: IsolatedWorkspaceProfile = {
      id,
      name: input.name,
      backend: input.backend,
      sourceRoot: root,
      workspacePath: input.backend === 'local-clone' ? managedPath : input.workspacePath!,
      ...(input.distro ? { distro: input.distro } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.user ? { user: input.user } : {}),
      ...(input.container ? { container: input.container } : {}),
      createdAt: now,
      updatedAt: now,
      status: 'creating',
      reproducibilityFiles: await reproductionFiles(root),
      lastError: null,
    };
    store.profiles.push(profile);
    await writeStore(store);
    try {
      if (input.backend === 'local-clone') {
        const status = await getStatus(root);
        if (status.staged.length > 0 || status.unstaged.length > 0) {
          throw new Error(
            'Commit or discard workspace changes before creating a reproducible clone.',
          );
        }
        await fs.mkdir(dirname(managedPath), { recursive: true });
        signal?.throwIfAborted();
        await cloneLocalRepository(root, managedPath);
        signal?.throwIfAborted();
      } else {
        const probe = await probeWorkspaceTarget(root, input, signal);
        signal?.throwIfAborted();
        if (!probe.available) throw new Error(probe.message);
      }
      profile.status = 'ready';
      profile.updatedAt = Date.now();
      await writeStore(store);
      return profile;
    } catch (error) {
      profile.status = 'error';
      profile.updatedAt = Date.now();
      profile.lastError =
        error instanceof Error ? boundedText(error.message, 1_000) : 'Workspace creation failed.';
      await writeStore(store);
      if (input.backend === 'local-clone') {
        await fs.rm(join(baseDir(), id), { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  });
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandForProfile(
  profile: IsolatedWorkspaceProfile,
  command: string,
): { executable: string; args: string[]; cwd?: string } {
  const system32 = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '';
  switch (profile.backend) {
    case 'local-clone':
      return process.platform === 'win32'
        ? {
            executable: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', command],
            cwd: profile.workspacePath,
          }
        : { executable: '/bin/sh', args: ['-lc', command], cwd: profile.workspacePath };
    case 'wsl':
      return {
        executable: system32 ? join(system32, 'wsl.exe') : 'wsl.exe',
        args: [
          '-d',
          profile.distro!,
          '--cd',
          profile.workspacePath,
          '--',
          '/bin/sh',
          '-lc',
          command,
        ],
      };
    case 'ssh': {
      const authority = profile.user ? `${profile.user}@${profile.host}` : profile.host!;
      return {
        executable: system32 ? join(system32, 'OpenSSH', 'ssh.exe') : 'ssh.exe',
        args: [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'StrictHostKeyChecking=yes',
          '--',
          authority,
          `/bin/sh -lc ${quotePosix(`cd -- ${quotePosix(profile.workspacePath)} && ${command}`)}`,
        ],
      };
    }
    case 'dev-container':
      return {
        executable: 'docker.exe',
        args: [
          'exec',
          '--',
          profile.container!,
          '/bin/sh',
          '-lc',
          `cd -- ${quotePosix(profile.workspacePath)} && ${command}`,
        ],
      };
  }
}

export interface IsolatedCommandApprovalDescriptor {
  digest: string;
  detail: string;
}

async function resolveIsolatedCommandApproval(
  root: string,
  profileId: string,
  command: string,
): Promise<{
  descriptor: IsolatedCommandApprovalDescriptor;
  profile: IsolatedWorkspaceProfile;
  spec: { executable: string; args: string[]; cwd?: string };
}> {
  const profile = (await listIsolatedWorkspaces(root)).find((item) => item.id === profileId);
  if (!profile || profile.status !== 'ready') throw new Error('Isolated workspace is not ready.');
  const spec = commandForProfile(profile, command);
  const identity = {
    root,
    profileId: profile.id,
    backend: profile.backend,
    workspacePath: profile.workspacePath,
    executable: spec.executable,
    argv: spec.args,
    cwd: spec.cwd ?? null,
  };
  const canonical = JSON.stringify(identity);
  return {
    descriptor: {
      digest: createHash('sha256').update(canonical).digest('hex'),
      detail: JSON.stringify(identity, null, 2),
    },
    profile,
    spec,
  };
}

export async function prepareIsolatedCommandApproval(
  root: string,
  profileId: string,
  command: string,
): Promise<IsolatedCommandApprovalDescriptor> {
  return (await resolveIsolatedCommandApproval(root, profileId, command)).descriptor;
}

export async function runIsolatedWorkspaceCommand(
  owner: WebContents,
  root: string,
  profileId: unknown,
  rawCommand: unknown,
  confirmation: unknown,
  approved: IsolatedCommandApprovalDescriptor,
): Promise<WorkspaceCommandResult> {
  if (confirmation !== true)
    throw new Error('Running an isolated workspace command requires explicit confirmation.');
  const id = typeof profileId === 'string' ? profileId : '';
  const command = typeof rawCommand === 'string' ? rawCommand.trim() : '';
  if (!id || !command) throw new Error('Workspace profile and command are required.');
  if (command.length > 1_000 || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new Error(
      'Workspace commands must be a single control-free line of at most 1,000 characters.',
    );
  }
  const resolved = await resolveIsolatedCommandApproval(root, id, command);
  if (approved.digest !== resolved.descriptor.digest) {
    throw new Error('Isolated command target changed after approval.');
  }
  if (running.has(id)) throw new Error('This isolated workspace is already running a command.');
  const spec = resolved.spec;
  const onOwnerDestroyed = (): void => {
    const active = running.get(id);
    if (active?.ownerId === owner.id)
      void terminateProcessTree(active.child).catch(() => undefined);
  };
  owner.once('destroyed', onOwnerDestroyed);
  try {
    const result = await captureProcess(spec.executable, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      timeoutMs: COMMAND_TIMEOUT_MS,
      ownerId: owner.id,
      profileId: id,
      root,
    });
    return {
      profileId: id,
      exitCode: result.code,
      durationMs: result.durationMs,
      output: result.output,
      truncated: result.truncated,
      passed: result.code === 0,
    };
  } finally {
    owner.removeListener('destroyed', onOwnerDestroyed);
  }
}

export async function removeIsolatedWorkspace(
  root: string,
  profileId: unknown,
  confirmation: unknown,
): Promise<IsolatedWorkspaceProfile[]> {
  if (confirmation !== true)
    throw new Error('Removing an isolated workspace requires explicit confirmation.');
  const id = typeof profileId === 'string' ? profileId : '';
  if (!id || running.has(id)) throw new Error('Workspace is missing or busy.');
  return serialize(async () => {
    const store = await readStore();
    const key = rootKey(root);
    const profile = store.profiles.find(
      (item) => item.id === id && rootKey(item.sourceRoot) === key,
    );
    if (!profile) return store.profiles.filter((item) => rootKey(item.sourceRoot) === key);
    if (profile.backend === 'local-clone') {
      const managedRoot = resolve(baseDir(), profile.id);
      const rel = relative(resolve(baseDir()), managedRoot);
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Managed workspace path is invalid.');
      await fs.rm(managedRoot, { recursive: true, force: true });
    }
    store.profiles = store.profiles.filter((item) => item.id !== id);
    await writeStore(store);
    return store.profiles.filter((item) => rootKey(item.sourceRoot) === key);
  });
}

export async function cancelIsolatedCommand(ownerId: number, profileId: unknown): Promise<void> {
  const id = typeof profileId === 'string' ? profileId : '';
  const active = running.get(id);
  if (!active) return;
  if (active.ownerId !== ownerId) throw new Error('Workspace command belongs to another window.');
  await terminateProcessTree(active.child).catch(() => undefined);
  if (running.get(id) === active) running.delete(id);
}

async function cancelMatchingIsolatedCommands(
  predicate: (active: RunningCommand) => boolean,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [id, active] of running) {
    if (!predicate(active)) continue;
    running.delete(id);
    tasks.push(terminateProcessTree(active.child).catch(() => undefined));
  }
  await Promise.allSettled(tasks);
}

export async function cancelIsolatedCommandsForOwner(ownerId: number): Promise<void> {
  await cancelMatchingIsolatedCommands((active) => active.ownerId === ownerId);
}

export async function cancelIsolatedCommandsForWorkspace(root: string): Promise<void> {
  const key = rootKey(root);
  await cancelMatchingIsolatedCommands((active) => rootKey(active.root) === key);
}

export async function cancelAllIsolatedCommands(): Promise<void> {
  await cancelMatchingIsolatedCommands(() => true);
}
