import { promises as fs } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import simpleGit, { type SimpleGit, type SimpleGitProgressEvent } from 'simple-git';
import type {
  GitBranches,
  GitOperationKind,
  GitOperationProgress,
  GitOperationResult,
  GitRemote,
  GitRepositoryInfo,
  GitSystemInfo,
} from '../../common/ipc';
import { getGithubCredentialForGit } from './githubScm';
import { assertWorkspaceTrusted } from './workspaceTrust';
import { canonicalPathIdentity } from './pathAuthorization';
import {
  AskpassExchange,
  buildExplicitFetchArguments,
  buildExplicitPushArguments,
  buildSelectedGitEnvironment,
  canonicalOriginMatches,
} from './systemGitSecurity';
import {
  isExactGithubRemoteUrl,
  validateBranchRef,
  validateGithubCloneUrl,
  validateGithubRemoteUrl,
  validateRemoteName,
} from './githubScmPure';

const GIT_TIMEOUT_MS = 60_000;
const ASKPASS_TIMEOUT_MS = 75_000;
const MAX_ASKPASS_REQUESTS = 2;
const MAX_PROGRESS_MESSAGE = 240;
const MAX_ERROR_MESSAGE = 600;

export type GitProgressSink = (progress: GitOperationProgress) => void;

interface OperationValue<T> {
  value: T;
  message: string;
}

export class PartialPublishError extends Error {
  readonly stage: 'repository-created' | 'remote-added';

  constructor(stage: 'repository-created' | 'remote-added', message: string) {
    super(message);
    this.name = 'PartialPublishError';
    this.stage = stage;
  }
}

const mutationTails = new Map<string, Promise<void>>();

// Detection is re-probed while Git is unavailable (so installing Git later, or a
// transient miss, recovers) and becomes authoritative once a working binary is
// found. `resolvedGitBinary` is the exact executable every simple-git call uses.
let cachedGitInfo: GitSystemInfo | null = null;
let gitProbeInFlight: Promise<GitSystemInfo> | null = null;
let resolvedGitBinary = 'git';

function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** Standard Git-for-Windows install locations, checked when PATH has no `git`. */
function gitBinaryCandidates(): string[] {
  if (process.platform !== 'win32') return ['git'];
  const candidates: string[] = ['git'];
  const bases = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)'],
  ].filter((base): base is string => typeof base === 'string' && base.length > 0);
  for (const base of bases) {
    candidates.push(join(base, 'Git', 'cmd', 'git.exe'));
    candidates.push(join(base, 'Git', 'bin', 'git.exe'));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return [...new Set(candidates)];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, fallback: string, max = MAX_PROGRESS_MESSAGE): string {
  const raw = typeof value === 'string' ? value : fallback;
  const sanitized = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || fallback).slice(0, max);
}

function redactUrlCredentials(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1')
    .replace(/\b(?:authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~-]{8,}/gi, '[credential hidden]');
}

export function sanitizeGitError(error: unknown, sensitive: readonly string[] = []): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitive) {
    if (value.length >= 8) message = message.split(value).join('[credential hidden]');
  }
  message = redactUrlCredentials(message);
  return new Error(boundedText(message, 'The Git operation failed.', MAX_ERROR_MESSAGE));
}

function selectedEnvironment(): NodeJS.ProcessEnv {
  return buildSelectedGitEnvironment(process.env);
}

async function assertTrustedRootUnchanged(root: string): Promise<void> {
  const canonical = await assertWorkspaceTrusted(root);
  if (canonicalPathIdentity(canonical) !== canonicalPathIdentity(root)) {
    throw new Error('The trusted workspace identity changed before the Git operation.');
  }
}

function makeGit(
  root: string,
  env: NodeJS.ProcessEnv,
  onProgress?: (event: SimpleGitProgressEvent) => void,
): SimpleGit {
  return simpleGit({
    baseDir: root,
    binary: resolvedGitBinary,
    maxConcurrentProcesses: 1,
    timeout: { block: GIT_TIMEOUT_MS },
    // The binary is Main-resolved (PATH `git` or a validated Git-for-Windows path),
    // never renderer-supplied, so an absolute path with spaces is safe to allow.
    unsafe: { allowUnsafeCustomBinary: true },
    ...(onProgress ? { progress: onProgress } : {}),
  }).env(env);
}

async function probeGitVersion(binary: string): Promise<GitSystemInfo | null> {
  try {
    const result = await simpleGit({
      maxConcurrentProcesses: 1,
      timeout: { block: 5_000 },
      binary,
      unsafe: { allowUnsafeCustomBinary: true },
    })
      .env(selectedEnvironment())
      .version();
    if (!result.installed) return null;
    return {
      available: true,
      version: `${result.major}.${result.minor}.${result.patch}`,
      message: null,
    };
  } catch {
    return null;
  }
}

async function detectSystemGit(): Promise<GitSystemInfo> {
  // Prefer PATH `git`; otherwise fall back to the standard Git-for-Windows
  // executables so an installed-but-not-on-PATH Git is still detected and used.
  for (const candidate of gitBinaryCandidates()) {
    if (candidate !== 'git' && !(await fileExists(candidate))) continue;
    const info = await probeGitVersion(candidate);
    if (info) {
      resolvedGitBinary = candidate;
      return info;
    }
  }
  resolvedGitBinary = 'git';
  return {
    available: false,
    version: null,
    message:
      'Git was not found on PATH or in the standard Git for Windows locations. Install Git from https://git-scm.com, then click Refresh — commits, branches, and remote operations will light up automatically.',
  };
}

export async function getSystemGitInfo(): Promise<GitSystemInfo> {
  // A successful detection is authoritative; while unavailable, keep re-probing
  // (deduped) so the user can install Git and recover without restarting.
  if (cachedGitInfo?.available) return cachedGitInfo;
  if (gitProbeInFlight) return gitProbeInFlight;
  gitProbeInFlight = detectSystemGit()
    .then((info) => {
      cachedGitInfo = info;
      return info;
    })
    .finally(() => {
      gitProbeInFlight = null;
    });
  return gitProbeInFlight;
}

/** Force the next detection to re-probe (used by an explicit "Refresh Git" action). */
export function refreshSystemGitInfo(): void {
  cachedGitInfo = null;
  gitProbeInFlight = null;
}

async function localRepositoryExists(root: string): Promise<boolean> {
  try {
    await fs.access(join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

function sanitizeRemoteUrl(raw: string): string {
  const value = boundedText(raw, 'configured remote', 512);
  if (isExactGithubRemoteUrl(value)) return value;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '').slice(0, 512);
    }
    return 'configured remote';
  } catch {
    const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._/-]{1,240})$/.exec(value);
    return scp ? `${scp[1]}:${scp[2]}` : 'configured remote';
  }
}

function toRemote(name: string, fetchUrl: string, pushUrl: string): GitRemote | null {
  let validatedName: string;
  try {
    validatedName = validateRemoteName(name);
  } catch {
    return null;
  }
  return {
    name: validatedName,
    fetchUrl: sanitizeRemoteUrl(fetchUrl),
    pushUrl: sanitizeRemoteUrl(pushUrl),
    github: isExactGithubRemoteUrl(fetchUrl) || isExactGithubRemoteUrl(pushUrl),
  };
}

function emptyRepositoryInfo(isRepo: boolean, systemGit: GitSystemInfo): GitRepositoryInfo {
  return {
    isRepo,
    systemGit,
    remotes: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    conflicts: [],
  };
}

export async function getRepositoryInfo(
  root: string,
  knownRepository?: boolean,
): Promise<GitRepositoryInfo> {
  const [systemGit, isRepo] = await Promise.all([
    getSystemGitInfo(),
    knownRepository === undefined ? localRepositoryExists(root) : Promise.resolve(knownRepository),
  ]);
  const fallback = emptyRepositoryInfo(isRepo, systemGit);
  if (!isRepo || !systemGit.available) return fallback;

  await assertTrustedRootUnchanged(root);
  try {
    const git = makeGit(root, selectedEnvironment());
    const [status, configuredRemotes] = await Promise.all([git.status(), git.getRemotes(true)]);
    const remotes = configuredRemotes
      .map((remote) => toRemote(remote.name, remote.refs.fetch, remote.refs.push))
      .filter((remote): remote is GitRemote => remote !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      isRepo: true,
      systemGit,
      remotes,
      upstream: status.tracking ? boundedText(status.tracking, '', 255) || null : null,
      ahead: Math.max(0, Math.min(1_000_000, status.ahead)),
      behind: Math.max(0, Math.min(1_000_000, status.behind)),
      detached: status.detached,
      conflicts: status.conflicted
        .map((path) => boundedText(path, '', 1_024))
        .filter(Boolean)
        .slice(0, 1_000),
    };
  } catch (error) {
    return {
      ...fallback,
      systemGit: {
        ...systemGit,
        message: sanitizeGitError(error).message,
      },
    };
  }
}

export async function getSystemBranches(root: string): Promise<GitBranches> {
  await requireSystemGit();
  await assertTrustedRootUnchanged(root);
  const summary = await makeGit(root, selectedEnvironment()).branchLocal();
  return {
    current: summary.detached ? null : summary.current || null,
    branches: summary.all
      .filter((branch) => {
        try {
          validateBranchRef(branch);
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, 2_000),
    detached: summary.detached,
  };
}

async function requireSystemGit(): Promise<void> {
  const info = await getSystemGitInfo();
  if (!info.available) throw new Error(info.message ?? 'System Git is unavailable.');
}

/** Serialize an existing local Git mutation on the same queue used by sync operations. */
export async function serializeGitMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = rootKey(root);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const execution = previous
    .catch(() => undefined)
    .then(async () => {
      await assertTrustedRootUnchanged(root);
      return action();
    });
  const tail = execution.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(key, tail);
  try {
    return await execution;
  } finally {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

function emit(
  sink: GitProgressSink | undefined,
  operationId: string,
  root: string,
  operation: GitOperationKind,
  phase: GitOperationProgress['phase'],
  message: string,
  percent: number | null = null,
): void {
  sink?.({
    operationId,
    root,
    operation,
    phase,
    percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent))),
    message: boundedText(message, 'Git operation update.'),
  });
}

async function serializeOperation<T>(
  root: string,
  operation: GitOperationKind,
  sink: GitProgressSink | undefined,
  action: (
    operationId: string,
    progress: (event: SimpleGitProgressEvent) => void,
  ) => Promise<OperationValue<T>>,
): Promise<{ operationId: string; value: T; message: string }> {
  const operationId = randomUUID();
  emit(sink, operationId, root, operation, 'queued', `${operation} queued.`);
  const key = rootKey(root);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const execution = previous
    .catch(() => undefined)
    .then(async () => {
      await assertTrustedRootUnchanged(root);
      emit(sink, operationId, root, operation, 'running', `${operation} started.`);
      const onProgress = (event: SimpleGitProgressEvent): void => {
        emit(
          sink,
          operationId,
          root,
          operation,
          'progress',
          `${event.stage} ${event.processed}/${event.total}`,
          event.progress,
        );
      };
      try {
        const result = await action(operationId, onProgress);
        emit(sink, operationId, root, operation, 'complete', result.message, 100);
        return { operationId, value: result.value, message: result.message };
      } catch (error) {
        const safe = error instanceof PartialPublishError ? error : sanitizeGitError(error);
        emit(sink, operationId, root, operation, 'error', safe.message);
        throw safe;
      }
    });
  const tail = execution.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(key, tail);
  try {
    return await execution;
  } finally {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

function operationResult(result: { operationId: string; message: string }): GitOperationResult {
  return {
    operationId: result.operationId,
    outcome: 'success',
    message: result.message,
    recovery: null,
  };
}

async function assertClean(git: SimpleGit, action: string): Promise<void> {
  const status = await git.status();
  if (!status.isClean() || status.conflicted.length > 0) {
    throw new Error(`Commit or discard working-tree changes before ${action}.`);
  }
}

async function configuredRemote(
  root: string,
  git: SimpleGit,
  requested?: string,
): Promise<{ name: string; fetch: string; push: string }> {
  await assertTrustedRootUnchanged(root);
  const remotes = await git.getRemotes(true);
  let name = requested ? validateRemoteName(requested) : '';
  if (!name) {
    await assertTrustedRootUnchanged(root);
    const status = await git.status();
    const trackingRemote = status.tracking?.split('/')[0];
    if (trackingRemote) {
      try {
        name = validateRemoteName(trackingRemote);
      } catch {
        name = '';
      }
    }
    if (!name && remotes.some((remote) => remote.name === 'origin')) name = 'origin';
    if (!name && remotes.length === 1) name = remotes[0]?.name ?? '';
  }
  const remote = remotes.find((candidate) => candidate.name === name);
  if (!remote) throw new Error('No configured Git remote is available for this operation.');
  return {
    name: validateRemoteName(remote.name),
    fetch: remote.refs.fetch,
    push: remote.refs.push,
  };
}

const ASKPASS_SCRIPT = String.raw`'use strict';
const net = require('node:net');
const pipe = process.env.AXIOM_ASKPASS_PIPE;
const nonce = process.env.AXIOM_ASKPASS_NONCE;
const prompt = String(process.argv[2] || '').slice(0, 512);
if (!pipe || !nonce) process.exit(2);
const client = net.createConnection(pipe);
let data = '';
const fail = () => { client.destroy(); process.exitCode = 2; };
client.setTimeout(5000, fail);
client.on('error', fail);
client.on('connect', () => client.write(JSON.stringify({ nonce, prompt }) + '\n'));
client.on('data', (chunk) => {
  data += chunk.toString('utf8');
  if (data.length > 2048) return fail();
  const end = data.indexOf('\n');
  if (end < 0) return;
  try {
    const response = JSON.parse(data.slice(0, end));
    if (!response || typeof response.value !== 'string' || response.value.length > 512) return fail();
    process.stdout.write(response.value + '\n');
    client.end();
  } catch { fail(); }
});
`;

function nonceMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withAskpass<T>(
  root: string,
  access: string,
  onProgress: (event: SimpleGitProgressEvent) => void,
  action: (git: SimpleGit) => Promise<T>,
): Promise<T> {
  const temp = await fs.mkdtemp(join(tmpdir(), 'axiom-git-askpass-'));
  const scriptPath = join(temp, 'broker.cjs');
  const launcherPath = join(temp, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
  const pipeName =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\axiom-git-askpass-${randomBytes(20).toString('hex')}`
      : join(temp, `broker-${randomBytes(12).toString('hex')}.sock`);
  const nonce = randomBytes(32).toString('base64url');
  const sockets = new Set<Socket>();
  const exchange = new AskpassExchange(access);
  let requests = 0;
  let server: Server;
  const stopBroker = (preserve?: Socket): void => {
    if (server.listening) server.close();
    for (const active of sockets) {
      if (active !== preserve) active.destroy();
    }
  };
  server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    let input = '';
    let answered = false;
    socket.on('data', (chunk) => {
      if (answered) return;
      input += chunk.toString('utf8');
      if (input.length > 2_048) {
        stopBroker();
        return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      answered = true;
      requests += 1;
      if (requests > MAX_ASKPASS_REQUESTS) {
        stopBroker();
        return;
      }
      try {
        const request = JSON.parse(input.slice(0, end)) as Record<string, unknown>;
        const reply = nonceMatches(nonce, request.nonce) ? exchange.answer(request.prompt) : null;
        if (reply === null) {
          stopBroker();
          return;
        }
        if (reply.complete) stopBroker(socket);
        socket.end(`${JSON.stringify({ value: reply.value })}\n`);
      } catch {
        stopBroker();
      }
    });
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => sockets.delete(socket));
  });
  server.maxConnections = MAX_ASKPASS_REQUESTS;

  const timeout = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  }, ASKPASS_TIMEOUT_MS);
  try {
    const launcher =
      process.platform === 'win32'
        ? '@echo off\r\n@"%AXIOM_ASKPASS_RUNTIME%" "%AXIOM_ASKPASS_SCRIPT%" "%~1"\r\n'
        : '#!/bin/sh\nexec "$AXIOM_ASKPASS_RUNTIME" "$AXIOM_ASKPASS_SCRIPT" "$1"\n';
    await Promise.all([
      fs.writeFile(scriptPath, ASKPASS_SCRIPT, { encoding: 'utf8', mode: 0o700, flag: 'wx' }),
      fs.writeFile(launcherPath, launcher, { encoding: 'utf8', mode: 0o700, flag: 'wx' }),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const env = selectedEnvironment();
    env['GIT_ASKPASS'] = launcherPath;
    env['SSH_ASKPASS'] = launcherPath;
    env['GIT_CONFIG_COUNT'] = '3';
    env['GIT_CONFIG_KEY_0'] = 'credential.helper';
    env['GIT_CONFIG_VALUE_0'] = '';
    env['GIT_CONFIG_KEY_1'] = 'core.askPass';
    env['GIT_CONFIG_VALUE_1'] = launcherPath;
    env['GIT_CONFIG_KEY_2'] = 'core.hooksPath';
    env['GIT_CONFIG_VALUE_2'] = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env['AXIOM_ASKPASS_RUNTIME'] = process.execPath;
    env['AXIOM_ASKPASS_SCRIPT'] = scriptPath;
    env['AXIOM_ASKPASS_PIPE'] = pipeName;
    env['AXIOM_ASKPASS_NONCE'] = nonce;
    if (process.versions.electron) env['ELECTRON_RUN_AS_NODE'] = '1';

    try {
      await assertTrustedRootUnchanged(root);
      return await action(makeGit(root, env, onProgress));
    } catch (error) {
      throw sanitizeGitError(error, [access]);
    }
  } finally {
    clearTimeout(timeout);
    await closeServer(server, sockets).catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withRemoteAuthentication<T>(
  root: string,
  remote: { fetch: string; push: string },
  direction: 'fetch' | 'push',
  onProgress: (event: SimpleGitProgressEvent) => void,
  action: (git: SimpleGit) => Promise<T>,
): Promise<T> {
  const remoteUrl = direction === 'fetch' ? remote.fetch : remote.push;
  if (isExactGithubRemoteUrl(remoteUrl)) {
    const access = await getGithubCredentialForGit();
    if (access) return withAskpass(root, access, onProgress, action);
  }
  try {
    await assertTrustedRootUnchanged(root);
    return await action(makeGit(root, selectedEnvironment(), onProgress));
  } catch (error) {
    throw sanitizeGitError(error);
  }
}

export async function fetchRepository(
  root: string,
  requestedRemote: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const requested = requestedRemote === undefined ? undefined : validateRemoteName(requestedRemote);
  const result = await serializeOperation(root, 'fetch', sink, async (_id, onProgress) => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const probe = makeGit(root, selectedEnvironment());
    const remote = await configuredRemote(root, probe, requested);
    await withRemoteAuthentication(root, remote, 'fetch', onProgress, (git) =>
      git.raw(buildExplicitFetchArguments(remote.name)),
    );
    return { value: undefined, message: `Fetched ${remote.name}.` };
  });
  return operationResult(result);
}

export async function pullRepository(
  root: string,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const result = await serializeOperation(root, 'pull', sink, async (_id, onProgress) => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const probe = makeGit(root, selectedEnvironment());
    await assertClean(probe, 'pulling');
    await assertTrustedRootUnchanged(root);
    const status = await probe.status();
    if (!status.tracking) {
      throw new Error('The current branch has no upstream. Push it first to set an upstream.');
    }
    const separator = status.tracking.indexOf('/');
    if (separator <= 0) throw new Error('The configured upstream is invalid.');
    const remoteName = validateRemoteName(status.tracking.slice(0, separator));
    const remoteBranch = validateBranchRef(status.tracking.slice(separator + 1));
    await assertTrustedRootUnchanged(root);
    const remote = await configuredRemote(root, probe, remoteName);
    await withRemoteAuthentication(root, remote, 'fetch', onProgress, (git) =>
      git.raw(buildExplicitFetchArguments(remote.name, remoteBranch)),
    );
    // withRemoteAuthentication resolves only after withAskpass has closed and
    // deleted its broker. The merge receives only the generic fail-closed env.
    await assertTrustedRootUnchanged(root);
    await makeGit(root, selectedEnvironment(), onProgress).raw([
      'merge',
      '--ff-only',
      'FETCH_HEAD',
    ]);
    return { value: undefined, message: `Fast-forward pull from ${status.tracking} completed.` };
  });
  return operationResult(result);
}

interface PushResult {
  upstream: string;
  repositoryUrl: string;
}

class PushDestinationError extends Error {
  constructor(
    readonly repositoryUrl: string,
    cause: unknown,
  ) {
    super(sanitizeGitError(cause).message);
    this.name = 'PushDestinationError';
  }
}

function assertExpectedGithubPush(remoteUrl: string, expectedUrl: string | undefined): void {
  if (!expectedUrl) return;
  let actual: string;
  let expected: string;
  try {
    actual = validateGithubRemoteUrl(remoteUrl).replace(/\.git$/i, '').toLowerCase();
    expected = validateGithubRemoteUrl(expectedUrl).replace(/\.git$/i, '').toLowerCase();
  } catch {
    throw new Error('The configured push destination is not an exact credential-free GitHub URL.');
  }
  if (actual !== expected) {
    throw new Error('The configured push destination does not match the issue repository.');
  }
}

async function pushCurrent(
  root: string,
  onProgress: (event: SimpleGitProgressEvent) => void,
  expectedGithubRepository?: string,
): Promise<PushResult> {
  await assertTrustedRootUnchanged(root);
  const probe = makeGit(root, selectedEnvironment());
  const status = await probe.status();
  if (status.detached || !status.current) {
    throw new Error('Check out a local branch before pushing.');
  }
  const branch = validateBranchRef(status.current);
  if (status.tracking) {
    const separator = status.tracking.indexOf('/');
    if (separator <= 0) throw new Error('The configured upstream is invalid.');
    const remoteName = validateRemoteName(status.tracking.slice(0, separator));
    const remoteBranch = validateBranchRef(status.tracking.slice(separator + 1));
    await assertTrustedRootUnchanged(root);
    const remote = await configuredRemote(root, probe, remoteName);
    const repositoryUrl = sanitizeRemoteUrl(remote.push);
    try {
      assertExpectedGithubPush(remote.push, expectedGithubRepository);
      await withRemoteAuthentication(root, remote, 'push', onProgress, (git) =>
        git.raw(buildExplicitPushArguments(remote.name, branch, remoteBranch, false)),
      );
    } catch (error) {
      throw new PushDestinationError(repositoryUrl, error);
    }
    return { upstream: `${remote.name}/${remoteBranch}`, repositoryUrl };
  }

  await assertTrustedRootUnchanged(root);
  const remote = await configuredRemote(root, probe, 'origin');
  const repositoryUrl = sanitizeRemoteUrl(remote.push);
  try {
    assertExpectedGithubPush(remote.push, expectedGithubRepository);
    await withRemoteAuthentication(root, remote, 'push', onProgress, (git) =>
      git.raw(buildExplicitPushArguments('origin', branch, branch, true)),
    );
  } catch (error) {
    throw new PushDestinationError(repositoryUrl, error);
  }
  return { upstream: `origin/${branch}`, repositoryUrl };
}

export async function pushRepository(
  root: string,
  sink?: GitProgressSink,
  expectedGithubRepository?: string,
): Promise<GitOperationResult> {
  const result = await serializeOperation(root, 'push', sink, async (_id, onProgress) => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const pushed = await pushCurrent(root, onProgress, expectedGithubRepository);
    return { value: undefined, message: `Pushed to ${pushed.upstream}.` };
  });
  return operationResult(result);
}

export async function addRemote(
  root: string,
  nameValue: unknown,
  urlValue: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const name = validateRemoteName(nameValue);
  const url = validateGithubCloneUrl(urlValue);
  const result = await serializeOperation(root, 'add-remote', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    await makeGit(root, selectedEnvironment()).addRemote(name, url);
    return { value: undefined, message: `Added remote ${name}.` };
  });
  return operationResult(result);
}

export async function checkoutBranch(
  root: string,
  refValue: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const ref = validateBranchRef(refValue);
  const result = await serializeOperation(root, 'checkout', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    await assertClean(git, 'switching branches');
    await assertTrustedRootUnchanged(root);
    const branches = await git.branchLocal();
    if (!branches.all.includes(ref)) throw new Error(`Local branch "${ref}" does not exist.`);
    await assertTrustedRootUnchanged(root);
    await git.checkout(ref);
    return { value: undefined, message: `Switched to ${ref}.` };
  });
  return operationResult(result);
}

export async function createBranch(
  root: string,
  refValue: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const ref = validateBranchRef(refValue);
  const result = await serializeOperation(root, 'create-branch', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    await assertClean(git, 'creating a branch');
    await assertTrustedRootUnchanged(root);
    const branches = await git.branchLocal();
    if (branches.all.includes(ref)) throw new Error(`Local branch "${ref}" already exists.`);
    await assertTrustedRootUnchanged(root);
    await git.checkoutLocalBranch(ref);
    return { value: undefined, message: `Created and switched to ${ref}.` };
  });
  return operationResult(result);
}

function requireConfirmation(value: unknown, action: string): void {
  if (value !== true) throw new Error(`${action} requires explicit confirmation.`);
}

export async function deleteBranch(
  root: string,
  refValue: unknown,
  confirmed: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  requireConfirmation(confirmed, 'Deleting a branch');
  const ref = validateBranchRef(refValue);
  const result = await serializeOperation(root, 'delete-branch', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    await assertClean(git, 'deleting a branch');
    await assertTrustedRootUnchanged(root);
    const branches = await git.branchLocal();
    if (branches.current === ref)
      throw new Error('Switch branches before deleting the current branch.');
    if (!branches.all.includes(ref)) throw new Error(`Local branch "${ref}" does not exist.`);
    await assertTrustedRootUnchanged(root);
    await git.deleteLocalBranch(ref, false);
    return { value: undefined, message: `Deleted branch ${ref}.` };
  });
  return operationResult(result);
}

export async function mergeBranch(
  root: string,
  refValue: unknown,
  confirmed: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  requireConfirmation(confirmed, 'Merging');
  const ref = validateBranchRef(refValue);
  const result = await serializeOperation(root, 'merge', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    await assertClean(git, 'merging');
    await assertTrustedRootUnchanged(root);
    await git.raw(['merge', '--no-edit', ref]);
    return { value: undefined, message: `Merged ${ref}.` };
  });
  return operationResult(result);
}

export async function rebaseBranch(
  root: string,
  refValue: unknown,
  confirmed: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  requireConfirmation(confirmed, 'Rebasing');
  const ref = validateBranchRef(refValue);
  const result = await serializeOperation(root, 'rebase', sink, async () => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    await assertClean(git, 'rebasing');
    await assertTrustedRootUnchanged(root);
    await git.raw(['rebase', ref]);
    return { value: undefined, message: `Rebased onto ${ref}.` };
  });
  return operationResult(result);
}

type CommitAndPushValue =
  | { outcome: 'success'; commitOid: string; recovery: null }
  | {
      outcome: 'partial';
      commitOid: string;
      recovery: {
        stage: 'commit-created';
        action: 'retry-push';
        repositoryUrl: string | null;
      };
    };

export async function commitAndPush(
  root: string,
  message: string,
  commit: () => Promise<string>,
  sink?: GitProgressSink,
  expectedGithubRepository?: string,
): Promise<GitOperationResult> {
  const normalizedMessage = boundedText(message, '', 10_000);
  if (!normalizedMessage) throw new Error('Enter a commit message before committing and pushing.');
  const result = await serializeOperation<CommitAndPushValue>(
    root,
    'commit-and-push',
    sink,
    async (_id, onProgress) => {
      await requireSystemGit();
      await assertTrustedRootUnchanged(root);
      const oid = await commit();
      try {
        await assertTrustedRootUnchanged(root);
        const pushed = await pushCurrent(root, onProgress, expectedGithubRepository);
        return {
          value: {
            outcome: 'success' as const,
            commitOid: oid,
            recovery: null,
          },
          message: `Committed ${oid.slice(0, 7)} and pushed to ${pushed.upstream}.`,
        };
      } catch (error) {
        const detail = sanitizeGitError(error).message;
        return {
          value: {
            outcome: 'partial' as const,
            commitOid: oid,
            recovery: {
              stage: 'commit-created' as const,
              action: 'retry-push' as const,
              repositoryUrl: error instanceof PushDestinationError ? error.repositoryUrl : null,
            },
          },
          message: `Commit ${oid.slice(0, 7)} was created, but push failed. ${detail}`,
        };
      }
    },
  );
  return result.value.outcome === 'partial'
    ? {
        operationId: result.operationId,
        outcome: 'partial',
        message: result.message,
        recovery: result.value.recovery,
        commitOid: result.value.commitOid,
      }
    : {
        operationId: result.operationId,
        outcome: 'success',
        message: result.message,
        recovery: null,
        commitOid: result.value.commitOid,
      };
}

export async function publishCreatedRepository(
  root: string,
  cloneUrlValue: unknown,
  sink?: GitProgressSink,
): Promise<GitOperationResult> {
  const cloneUrl = validateGithubCloneUrl(cloneUrlValue);
  const result = await serializeOperation(root, 'publish', sink, async (_id, onProgress) => {
    await requireSystemGit();
    await assertTrustedRootUnchanged(root);
    const git = makeGit(root, selectedEnvironment());
    let remotes = await git.getRemotes(true);
    let origin = remotes.find((remote) => remote.name === 'origin');
    if (origin && !canonicalOriginMatches(origin.refs.fetch, origin.refs.push, cloneUrl)) {
      throw new PartialPublishError(
        'repository-created',
        'The GitHub repository was created, but origin does not exactly match its canonical address.',
      );
    }
    if (!origin) {
      try {
        await assertTrustedRootUnchanged(root);
        await git.addRemote('origin', cloneUrl);
        await assertTrustedRootUnchanged(root);
        remotes = await git.getRemotes(true);
        origin = remotes.find((remote) => remote.name === 'origin');
      } catch (error) {
        throw new PartialPublishError(
          'repository-created',
          `The GitHub repository was created, but origin could not be added. ${sanitizeGitError(error).message}`,
        );
      }
    }
    if (!origin || !canonicalOriginMatches(origin.refs.fetch, origin.refs.push, cloneUrl)) {
      throw new PartialPublishError(
        'repository-created',
        'The GitHub repository was created, but origin could not be verified.',
      );
    }

    await assertTrustedRootUnchanged(root);
    const status = await git.status();
    if (status.detached || !status.current) {
      throw new PartialPublishError(
        'remote-added',
        'The GitHub repository and origin remote are ready, but no local branch is checked out.',
      );
    }
    const branch = validateBranchRef(status.current);
    const remote = { name: 'origin', fetch: cloneUrl, push: cloneUrl };
    try {
      await withRemoteAuthentication(root, remote, 'push', onProgress, (authenticatedGit) =>
        authenticatedGit.raw(buildExplicitPushArguments('origin', branch, branch, true)),
      );
      return { value: undefined, message: `Published to origin/${branch}.` };
    } catch (error) {
      throw new PartialPublishError(
        'remote-added',
        `The GitHub repository and origin remote are ready, but push failed. ${sanitizeGitError(error).message}`,
      );
    }
  });
  return operationResult(result);
}


/** Create an isolated local clone without touching the source worktree or its index. */

/**
 * Enumerate tracked and non-ignored untracked files without ever listing ignored
 * credential artifacts. Callers must still reject links and sensitive names.
 */
export async function listVerificationSnapshotFiles(root: string): Promise<string[]> {
  await requireSystemGit();
  await assertTrustedRootUnchanged(root);
  let output: string;
  try {
    output = await makeGit(root, selectedEnvironment()).raw([
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
  } catch (error) {
    throw sanitizeGitError(error);
  }
  await assertTrustedRootUnchanged(root);
  if (Buffer.byteLength(output, 'utf-8') > 8 * 1024 * 1024) {
    throw new Error('Workspace file index exceeds the verification snapshot limit.');
  }
  const files = output.split('\0').filter(Boolean);
  if (files.length > 20_000) {
    throw new Error('Workspace contains too many non-ignored files for verification.');
  }
  return files;
}

export async function cloneLocalRepository(sourceRoot: string, destination: string): Promise<void> {
  await requireSystemGit();
  await assertTrustedRootUnchanged(sourceRoot);
  await simpleGit({
    maxConcurrentProcesses: 1,
    timeout: { block: 120_000 },
    binary: resolvedGitBinary,
    unsafe: { allowUnsafeCustomBinary: true },
  })
    .env(selectedEnvironment())
    .clone(sourceRoot, destination, ['--local', '--no-hardlinks', '--no-tags']);
  await assertTrustedRootUnchanged(sourceRoot);
}

/** Read the current immutable commit id through the hardened generic Git environment. */
export async function currentCommit(root: string): Promise<string> {
  await requireSystemGit();
  await assertTrustedRootUnchanged(root);
  const oid = boundedText(await makeGit(root, selectedEnvironment()).revparse(['HEAD']), '', 64);
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new Error('The repository has no valid HEAD commit.');
  return oid.toLowerCase();
}
