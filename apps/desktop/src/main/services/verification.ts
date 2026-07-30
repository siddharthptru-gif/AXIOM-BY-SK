import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { app, type WebContents } from 'electron';
import type {
  VerificationCheck,
  VerificationCheckResult,
  VerificationPlan,
  VerificationRunResult,
} from '../../common/godMode';
import { hasFlakySignal, planAffectedChecks } from '../../common/godMode';
import { interpretVerification } from '../../common/selfVerify';
import { getStatus } from './git';
import { currentCommit, listVerificationSnapshotFiles } from './systemGit';
import { assertWorkspaceTrusted } from './workspaceTrust';
import { terminateProcessTree } from './processTree';
import { buildChildProcessEnvironment } from './processEnvironment';

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 50 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const PLAN_TTL_MS = 30 * 60_000;
const SCRIPT_NAME = /^[A-Za-z0-9:_-]{1,100}$/;

interface StoredPlan {
  ownerId: number;
  plan: VerificationPlan;
  scripts: Map<string, string>;
  scriptTexts: Map<string, string>;
  expiresAt: number;
}

interface SnapshotIdentity {
  sha256: string;
  fileCount: number;
  totalBytes: number;
  fingerprint: string;
  commitSha: string | null;
  cleanCommitSha: string | null;
  packageJsonSha256: string;
}

export interface VerificationExecutionApprovalDescriptor {
  token: string;
  ownerId: number;
  root: string;
  planId: string;
  selectedCheckIds: string[];
  snapshotSha256: string;
  digest: string;
  detail: string;
}

interface PreparedVerification {
  descriptor: VerificationExecutionApprovalDescriptor;
  snapshotRoot: string;
  identity: SnapshotIdentity;
  checks: VerificationCheck[];
  scripts: Map<string, string>;
  expiresAt: number;
}

interface RunningVerification {
  ownerId: number;
  root: string;
  planId: string;
  controller: AbortController;
  child: ChildProcess | null;
}

interface CompletedVerification {
  ownerId: number;
  root: string;
  result: VerificationRunResult;
  fingerprint: string;
  expiresAt: number;
}

const plans = new Map<string, StoredPlan>();
const prepared = new Map<string, PreparedVerification>();
const running = new Map<string, RunningVerification>();
const completed = new Map<string, CompletedVerification>();
const boundOwners = new Set<number>();

function bindOwner(owner: WebContents): void {
  if (boundOwners.has(owner.id)) return;
  boundOwners.add(owner.id);
  owner.once('destroyed', () => {
    boundOwners.delete(owner.id);
    void cancelVerificationsForOwner(owner.id);
  });
}

function pathKey(path: string): string {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function safeRelativePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    return null;
  }
  return normalized.slice(0, 1_024);
}

function sensitiveSnapshotPath(relativePath: string): boolean {
  const segments = relativePath.replaceAll('\\', '/').split('/');
  const name = segments.at(-1)?.toLowerCase() ?? '';
  const sourceModule =
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|cs|go|java|js|jsx|mjs|cjs|ts|tsx|py|rb|rs|swift|kt|kts|scala|php|vue|svelte)$/i.test(
      name,
    );
  const environmentTemplate = /^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template)$/i.test(name);
  const secretLikeName =
    /^(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name) ||
    /(?:^|[._-])(?:client[_-]?secret|private[_-]?key|access[_-]?token)(?:[._-]|$)/i.test(name);
  return (
    segments.some(
      (segment) => segment.toLowerCase() === '.git' || segment.toLowerCase() === 'node_modules',
    ) ||
    name === '.env' ||
    (name.startsWith('.env.') && !environmentTemplate) ||
    (secretLikeName && !sourceModule) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)
  );
}

function statusIdentity(status: Awaited<ReturnType<typeof getStatus>>): string[] {
  return [
    ...status.staged.map((item) => `S:${item.type}:${item.path}`),
    ...status.unstaged.map((item) => `U:${item.type}:${item.path}`),
  ].sort();
}

async function captureWorkspaceSnapshot(
  root: string,
  destination: string | null,
  signal?: AbortSignal,
): Promise<SnapshotIdentity> {
  signal?.throwIfAborted();
  const canonicalRoot = await assertWorkspaceTrusted(root);
  const realRoot = await fs.realpath(canonicalRoot);
  const statusBefore = await getStatus(canonicalRoot);
  const commitBefore = await currentCommit(canonicalRoot).catch(() => null);
  const paths = (await listVerificationSnapshotFiles(canonicalRoot)).sort((a, b) =>
    a.localeCompare(b),
  );
  if (paths.length > MAX_SNAPSHOT_FILES) {
    throw new Error(`Verification snapshot exceeds ${MAX_SNAPSHOT_FILES} files.`);
  }
  const aggregate = createHash('sha256');
  let fileCount = 0;
  let totalBytes = 0;
  let packageJsonSha256 = createHash('sha256').update('<absent>').digest('hex');

  for (const rawPath of paths) {
    signal?.throwIfAborted();
    const rel = safeRelativePath(rawPath);
    if (!rel) {
      throw new Error('Git returned an unsafe verification source path.');
    }
    if (sensitiveSnapshotPath(rel)) {
      throw new Error(
        'Verification cannot authorize a source snapshot containing non-ignored sensitive paths. Remove them from version control and add them to ignore rules.',
      );
    }
    const source = resolve(canonicalRoot, rel);
    const lexical = relative(canonicalRoot, source);
    if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) {
      throw new Error('Verification snapshot contains an escaping path.');
    }
    const linkStat = await fs.lstat(source);
    if (linkStat.isSymbolicLink() || linkStat.isDirectory() || !linkStat.isFile()) {
      throw new Error(
        'Verification cannot authorize a snapshot containing symlinks, submodules, directories, or special files.',
      );
    }
    if (linkStat.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(`Verification source file exceeds ${MAX_SNAPSHOT_FILE_BYTES} bytes.`);
    }
    const realSource = await fs.realpath(source);
    const canonicalRelative = relative(realRoot, realSource);
    if (!canonicalRelative || canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
      throw new Error('Verification source resolves outside the trusted workspace.');
    }
    const handle = await fs.open(realSource, 'r');
    let bytes: Buffer;
    let mode = 0o600;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_SNAPSHOT_FILE_BYTES) {
        throw new Error('Verification source changed before capture.');
      }
      mode = opened.mode;
      bytes = await handle.readFile();
      if (bytes.byteLength !== opened.size) {
        throw new Error('Verification source changed during capture.');
      }
    } finally {
      await handle.close();
    }
    fileCount += 1;
    if (fileCount > MAX_SNAPSHOT_FILES) {
      throw new Error(`Verification snapshot exceeds ${MAX_SNAPSHOT_FILES} files.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`Verification snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    aggregate.update(`${rel}\0${bytes.byteLength}\0${sha256}\n`, 'utf-8');
    if (rel === 'package.json') packageJsonSha256 = sha256;
    if (destination) {
      const target = resolve(destination, rel);
      const targetRelative = relative(destination, target);
      if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
        throw new Error('Verification snapshot target escaped its temporary root.');
      }
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: mode & 0o777 });
    }
  }

  const statusAfter = await getStatus(canonicalRoot);
  const commitAfter = await currentCommit(canonicalRoot).catch(() => null);
  const beforeChanges = statusIdentity(statusBefore);
  const afterChanges = statusIdentity(statusAfter);
  if (
    commitBefore !== commitAfter ||
    JSON.stringify(beforeChanges) !== JSON.stringify(afterChanges)
  ) {
    throw new Error('Workspace changed while the immutable verification snapshot was captured.');
  }
  const sha256 = aggregate.digest('hex');
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        root: pathKey(canonicalRoot),
        branch: statusAfter.branch ?? null,
        commit: commitAfter,
        changes: afterChanges,
        sha256,
        fileCount,
        totalBytes,
      }),
    )
    .digest('hex');
  return {
    sha256,
    fileCount,
    totalBytes,
    fingerprint,
    commitSha: commitAfter,
    cleanCommitSha: afterChanges.length === 0 ? commitAfter : null,
    packageJsonSha256,
  };
}

async function workspaceFingerprint(root: string): Promise<string> {
  return (await captureWorkspaceSnapshot(root, null)).fingerprint;
}

async function cleanupPreparedSnapshot(item: PreparedVerification): Promise<void> {
  prepared.delete(item.descriptor.token);
  const dependencyLink = join(item.snapshotRoot, 'node_modules');
  await fs.unlink(dependencyLink).catch(() => undefined);
  await fs.rm(item.snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
}

function prunePlans(now = Date.now()): void {
  for (const [id, stored] of plans) {
    if (stored.expiresAt <= now) plans.delete(id);
  }
  for (const item of [...prepared.values()]) {
    if (item.expiresAt <= now) void cleanupPreparedSnapshot(item);
  }
  for (const [id, stored] of completed) {
    if (stored.expiresAt <= now) completed.delete(id);
  }
}

async function packageScripts(root: string): Promise<Record<string, string>> {
  let text: string;
  try {
    const file = await fs.readFile(join(root, 'package.json'));
    if (file.byteLength > MAX_PACKAGE_BYTES) throw new Error('package.json is too large.');
    text = file.toString('utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('package.json is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const scriptsValue = (parsed as Record<string, unknown>).scripts;
  if (!scriptsValue || typeof scriptsValue !== 'object' || Array.isArray(scriptsValue)) return {};
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(scriptsValue as Record<string, unknown>)) {
    if (SCRIPT_NAME.test(name) && typeof command === 'string')
      scripts[name] = command.slice(0, 10_000);
  }
  return scripts;
}

async function changedFiles(root: string): Promise<string[]> {
  try {
    const status = await getStatus(root);
    return [...new Set([...status.staged, ...status.unstaged].map((change) => change.path))].slice(
      0,
      500,
    );
  } catch {
    return [];
  }
}

export async function createVerificationPlan(
  owner: WebContents,
  root: string,
  requestedChangedFiles?: unknown,
): Promise<VerificationPlan> {
  prunePlans();
  bindOwner(owner);
  const scripts = await packageScripts(root);
  const requested = Array.isArray(requestedChangedFiles)
    ? requestedChangedFiles
        .filter((item): item is string => typeof item === 'string')
        .map(safeRelativePath)
        .filter((item): item is string => item !== null)
        .slice(0, 500)
    : [];
  const files = requested.length > 0 ? requested : await changedFiles(root);
  const plan = planAffectedChecks(root, files, scripts);
  const scriptMap = new Map<string, string>();
  const scriptTexts = new Map<string, string>();
  for (const check of plan.checks) {
    const name = check.id.slice(check.id.indexOf(':') + 1);
    if (SCRIPT_NAME.test(name) && scripts[name] !== undefined) {
      scriptMap.set(check.id, name);
      scriptTexts.set(check.id, scripts[name]);
    }
  }
  plans.set(plan.id, {
    ownerId: owner.id,
    plan,
    scripts: scriptMap,
    scriptTexts,
    expiresAt: Date.now() + PLAN_TTL_MS,
  });
  return plan;
}

function selectVerificationChecks(
  stored: StoredPlan,
  requestedCheckIds: unknown,
): VerificationCheck[] {
  const selected = new Set(
    Array.isArray(requestedCheckIds)
      ? requestedCheckIds.filter((item): item is string => typeof item === 'string')
      : stored.plan.checks.map((check) => check.id),
  );
  const checks = stored.plan.checks.filter((check) => selected.has(check.id));
  const omittedRequired = stored.plan.checks.filter(
    (check) => check.required && !selected.has(check.id),
  );
  if (omittedRequired.length > 0) {
    throw new Error(
      `Required verification checks cannot be omitted: ${omittedRequired.map((check) => check.label).join(', ')}.`,
    );
  }
  if (checks.length === 0) throw new Error('Select at least one generated verification check.');
  return checks;
}

export async function prepareVerificationExecution(
  owner: WebContents,
  planId: unknown,
  requestedCheckIds: unknown,
  confirmation: unknown,
): Promise<VerificationExecutionApprovalDescriptor> {
  if (confirmation !== true)
    throw new Error('Running workspace checks requires explicit confirmation.');
  if (typeof planId !== 'string') throw new TypeError('Verification plan id is required.');
  prunePlans();
  bindOwner(owner);
  const stored = plans.get(planId);
  if (!stored || stored.ownerId !== owner.id) {
    throw new Error('Verification plan expired or belongs to another window.');
  }
  if (running.has(planId)) throw new Error('This verification plan is already running.');
  const checks = selectVerificationChecks(stored, requestedCheckIds);
  for (const item of [...prepared.values()]) {
    if (item.descriptor.ownerId === owner.id && item.descriptor.planId === planId) {
      await cleanupPreparedSnapshot(item);
    }
  }

  const snapshotRoot = await fs.mkdtemp(join(app.getPath('temp'), 'axiom-verification-'));
  try {
    const identity = await captureWorkspaceSnapshot(stored.plan.root, snapshotRoot);
    const snapshotScripts = await packageScripts(snapshotRoot);
    const scripts = new Map<string, string>();
    const exactScripts = checks.map((check) => {
      const script = stored.scripts.get(check.id);
      const plannedText = stored.scriptTexts.get(check.id);
      if (!script || plannedText === undefined || snapshotScripts[script] !== plannedText) {
        throw new Error(`Verification package script changed after planning: ${check.label}`);
      }
      scripts.set(check.id, script);
      return { checkId: check.id, name: script, text: plannedText };
    });

    const dependencyRoot = join(stored.plan.root, 'node_modules');
    try {
      const dependencyStat = await fs.lstat(dependencyRoot);
      if (dependencyStat.isSymbolicLink() || !dependencyStat.isDirectory()) {
        throw new Error(
          'Workspace node_modules must be a real directory for isolated verification.',
        );
      }
      const realDependencies = await fs.realpath(dependencyRoot);
      const dependencyRelative = relative(await fs.realpath(stored.plan.root), realDependencies);
      if (
        !dependencyRelative ||
        dependencyRelative.startsWith('..') ||
        isAbsolute(dependencyRelative)
      ) {
        throw new Error('Workspace node_modules resolves outside the trusted workspace.');
      }
      await fs.symlink(
        realDependencies,
        join(snapshotRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    await assertWorkspaceTrusted(stored.plan.root);
    const token = randomUUID();
    const approvalIdentity = {
      root: stored.plan.root,
      planId,
      selectedCheckIds: checks.map((check) => check.id),
      scripts: exactScripts,
      snapshotSha256: identity.sha256,
      snapshotFileCount: identity.fileCount,
      snapshotBytes: identity.totalBytes,
      packageJsonSha256: identity.packageJsonSha256,
      sourceFingerprint: identity.fingerprint,
      commitSha: identity.commitSha,
      cleanCommitSha: identity.cleanCommitSha,
    };
    const detail = JSON.stringify(approvalIdentity, null, 2);
    if (detail.length > 10_000) {
      throw new Error('Exact verification scripts exceed the native approval display limit.');
    }
    const descriptor: VerificationExecutionApprovalDescriptor = {
      token,
      ownerId: owner.id,
      root: stored.plan.root,
      planId,
      selectedCheckIds: checks.map((check) => check.id),
      snapshotSha256: identity.sha256,
      digest: createHash('sha256').update(JSON.stringify(approvalIdentity)).digest('hex'),
      detail,
    };
    prepared.set(token, {
      descriptor,
      snapshotRoot,
      identity,
      checks,
      scripts,
      expiresAt: Date.now() + PLAN_TTL_MS,
    });
    return descriptor;
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function commandForScript(script: string): { executable: string; args: string[] } {
  if (!SCRIPT_NAME.test(script)) throw new Error('Verification script name is invalid.');
  if (process.platform === 'win32') {
    return {
      executable: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm.cmd --ignore-scripts run ${script}`],
    };
  }
  return { executable: '/bin/sh', args: ['-lc', `npm --ignore-scripts run ${script}`] };
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + chunk.toString('utf-8')).slice(0, MAX_OUTPUT_CHARS);
}

async function runCheck(
  root: string,
  check: VerificationCheck,
  script: string,
  active: RunningVerification,
): Promise<VerificationCheckResult> {
  active.controller.signal.throwIfAborted();
  const startedAt = Date.now();
  const command = commandForScript(script);
  const child = spawn(command.executable, command.args, {
    cwd: root,
    env: buildChildProcessEnvironment({ ci: true, color: false }),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.child = child;
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output = appendBounded(output, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output = appendBounded(output, chunk);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const finish = (value: number | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.controller.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => {
      void terminateProcessTree(child).finally(() =>
        finish(null, new Error('Verification cancelled.')),
      );
    };
    const timer = setTimeout(() => {
      void terminateProcessTree(child).finally(() =>
        finish(
          null,
          new Error(`Verification timed out after ${CHECK_TIMEOUT_MS / 60_000} minutes.`),
        ),
      );
    }, CHECK_TIMEOUT_MS);
    active.controller.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
  active.child = null;
  const interpreted = interpretVerification(check.command, output, exitCode ?? undefined);
  return {
    checkId: check.id,
    passed: interpreted.passed,
    exitCode,
    durationMs: Date.now() - startedAt,
    summary: interpreted.summary,
    failures: interpreted.failures.slice(0, 20),
    flakySignal: !interpreted.passed && hasFlakySignal(output),
  };
}

export async function executePreparedVerification(
  owner: WebContents,
  approved: VerificationExecutionApprovalDescriptor,
): Promise<VerificationRunResult> {
  prunePlans();
  const item = prepared.get(approved.token);
  if (
    !item ||
    item.descriptor.ownerId !== owner.id ||
    item.descriptor.planId !== approved.planId ||
    item.descriptor.digest !== approved.digest ||
    item.descriptor.snapshotSha256 !== approved.snapshotSha256 ||
    pathKey(item.descriptor.root) !== pathKey(approved.root)
  ) {
    throw new Error('Prepared verification expired or changed after approval.');
  }
  prepared.delete(approved.token);
  const planId = item.descriptor.planId;
  if (running.has(planId)) {
    await cleanupPreparedSnapshot(item);
    throw new Error('This verification plan is already running.');
  }
  const checks = item.checks;
  const active: RunningVerification = {
    ownerId: owner.id,
    root: item.descriptor.root,
    planId,
    controller: new AbortController(),
    child: null,
  };
  running.set(planId, active);
  const onOwnerDestroyed = (): void => {
    void cancelVerification(owner.id, planId).catch(() => undefined);
  };
  owner.once('destroyed', onOwnerDestroyed);
  const startedAt = Date.now();
  const results: VerificationCheckResult[] = [];
  try {
    for (const check of checks) {
      const script = item.scripts.get(check.id);
      if (!script) throw new Error(`Verification check is no longer valid: ${check.label}`);
      results.push(await runCheck(item.snapshotRoot, check, script, active));
      if (!results.at(-1)?.passed && check.required) break;
    }
    const passed = results.length === checks.length && results.every((result) => result.passed);
    const result: VerificationRunResult = {
      planId,
      startedAt,
      endedAt: Date.now(),
      passed,
      level: passed ? 'verified' : 'executed',
      snapshotSha256: item.identity.sha256,
      snapshotFileCount: item.identity.fileCount,
      snapshotBytes: item.identity.totalBytes,
      sourceFingerprint: item.identity.fingerprint,
      cleanCommitSha: item.identity.cleanCommitSha,
      results,
    };
    if (passed) {
      completed.set(planId, {
        ownerId: owner.id,
        root: item.descriptor.root,
        result,
        fingerprint: item.identity.fingerprint,
        expiresAt: Date.now() + PLAN_TTL_MS,
      });
    } else {
      completed.delete(planId);
    }
    return result;
  } finally {
    owner.removeListener('destroyed', onOwnerDestroyed);
    if (active.child) await terminateProcessTree(active.child).catch(() => undefined);
    if (running.get(planId) === active) running.delete(planId);
    await cleanupPreparedSnapshot(item);
  }
}

/** Compatibility wrapper used by focused service tests; production IPC prepares and approves first. */
export async function runVerificationPlan(
  owner: WebContents,
  planId: unknown,
  requestedCheckIds: unknown,
  confirmation: unknown,
): Promise<VerificationRunResult> {
  const descriptor = await prepareVerificationExecution(
    owner,
    planId,
    requestedCheckIds,
    confirmation,
  );
  return executePreparedVerification(owner, descriptor);
}

export async function requireVerifiedPlan(
  ownerId: number,
  planId: string,
  root: string,
): Promise<VerificationRunResult> {
  prunePlans();
  const record = completed.get(planId);
  if (!record || record.ownerId !== ownerId || pathKey(record.root) !== pathKey(root)) {
    throw new Error('A current successful verification run is required.');
  }
  if ((await workspaceFingerprint(root)) !== record.fingerprint) {
    completed.delete(planId);
    throw new Error('Workspace files changed after verification. Run the verification plan again.');
  }
  return record.result;
}

export async function cancelVerification(ownerId: number, planId: unknown): Promise<void> {
  if (typeof planId !== 'string') throw new TypeError('Verification plan id is required.');
  const preparedItems = [...prepared.values()].filter((item) => item.descriptor.planId === planId);
  for (const item of preparedItems) {
    if (item.descriptor.ownerId !== ownerId) {
      throw new Error('Verification is owned by another window.');
    }
    await cleanupPreparedSnapshot(item);
  }
  const active = running.get(planId);
  if (!active) return;
  if (active.ownerId !== ownerId) throw new Error('Verification is owned by another window.');
  active.controller.abort();
  if (active.child) await terminateProcessTree(active.child).catch(() => undefined);
}

async function cancelMatchingVerifications(
  predicate: (ownerId: number, root: string) => boolean,
): Promise<void> {
  for (const [id, plan] of plans) {
    if (predicate(plan.ownerId, plan.plan.root)) plans.delete(id);
  }
  for (const [id, record] of completed) {
    if (predicate(record.ownerId, record.root)) completed.delete(id);
  }
  const preparedCleanup: Promise<void>[] = [];
  for (const item of [...prepared.values()]) {
    if (!predicate(item.descriptor.ownerId, item.descriptor.root)) continue;
    preparedCleanup.push(cleanupPreparedSnapshot(item));
  }
  const tasks: Promise<void>[] = [];
  for (const [id, active] of running) {
    if (!predicate(active.ownerId, active.root)) continue;
    running.delete(id);
    active.controller.abort();
    if (active.child) tasks.push(terminateProcessTree(active.child).catch(() => undefined));
  }
  await Promise.allSettled([...preparedCleanup, ...tasks]);
}

export async function cancelVerificationsForOwner(ownerId: number): Promise<void> {
  await cancelMatchingVerifications((candidateOwner) => candidateOwner === ownerId);
}

export async function cancelVerificationsForWorkspace(root: string): Promise<void> {
  const key = pathKey(root);
  await cancelMatchingVerifications((_ownerId, candidateRoot) => pathKey(candidateRoot) === key);
}

export async function cancelAllVerifications(): Promise<void> {
  await cancelMatchingVerifications(() => true);
}
