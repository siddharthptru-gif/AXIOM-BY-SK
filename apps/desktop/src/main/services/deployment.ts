import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { WebContents } from 'electron';
import type {
  DeploymentPlan,
  DeploymentRun,
  DeploymentTarget,
  ExecuteDeploymentInput,
  VerificationRunResult,
} from '../../common/godMode';
import { boundedText, validateDeploymentTarget } from '../../common/godMode';
import { currentCommit, getRepositoryInfo } from './systemGit';
import { getStatus } from './git';
import { githubApiRequest } from './githubApi';
import { requireVerifiedPlan } from './verification';
import { resolveDeploymentHookSecret, setDeploymentHookSecret } from './secrets';

const PLAN_TTL_MS = 30 * 60_000;
const HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_RESPONSE_BYTES = 128 * 1024;
const MAX_STATIC_FILE_BYTES = 50 * 1024 * 1024;
const MAX_STATIC_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_STATIC_FILES = 10_000;
const MAX_STATIC_ENTRIES = 20_000;
const MAX_LOCAL_SERVERS = 5;
const MAX_RUNS = 200;

interface StoredPlan {
  ownerId: number;
  plan: DeploymentPlan;
  expiresAt: number;
}

interface LocalServer {
  ownerId: number;
  runId: string;
  server: Server;
}

interface StaticAsset {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
}

interface StaticSnapshot {
  assets: ReadonlyMap<string, StaticAsset>;
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

interface PlanningRecord {
  ownerId: number;
  root: string;
  controller: AbortController;
}

interface RunRecord {
  ownerId: number;
  root: string;
  run: DeploymentRun;
  controller: AbortController | null;
}

class SafeDeploymentError extends Error {}

const blockedHookIpv4Addresses = new BlockList();
const blockedHookIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedHookIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedHookIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

class DeploymentCancelledError extends Error {}

const plans = new Map<string, StoredPlan>();
const planning = new Set<PlanningRecord>();
const runs = new Map<string, RunRecord>();
const localServers = new Map<string, LocalServer>();
const boundOwners = new Set<number>();

function cloneRun(run: DeploymentRun): DeploymentRun {
  return { ...run, evidence: run.evidence.map((item) => ({ ...item })) };
}

function rootKey(root: string): string {
  const canonical = resolve(root);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function targetOf(value: unknown): DeploymentTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Deployment target is required.');
  }
  const raw = value as Record<string, unknown>;
  if (!['local-static', 'github-actions', 'deploy-hook'].includes(String(raw.provider))) {
    throw new Error('Unknown deployment provider.');
  }
  const target: DeploymentTarget = {
    id: boundedText(raw.id, 100),
    name: boundedText(raw.name, 160),
    provider: raw.provider as DeploymentTarget['provider'],
    ...(typeof raw.secretRef === 'string' ? { secretRef: boundedText(raw.secretRef, 180) } : {}),
    ...(typeof raw.workflow === 'string' ? { workflow: boundedText(raw.workflow, 200) } : {}),
    ...(typeof raw.repository === 'string' ? { repository: boundedText(raw.repository, 201) } : {}),
    ...(typeof raw.ref === 'string' ? { ref: boundedText(raw.ref, 200) } : {}),
    ...(typeof raw.hookOrigin === 'string'
      ? { hookOrigin: boundedText(raw.hookOrigin, 1_000) }
      : {}),
    ...(typeof raw.hookRevision === 'string'
      ? { hookRevision: boundedText(raw.hookRevision, 64) }
      : {}),
    ...(typeof raw.hookUrlSha256 === 'string'
      ? { hookUrlSha256: boundedText(raw.hookUrlSha256, 64) }
      : {}),
    ...(typeof raw.outputDirectory === 'string'
      ? { outputDirectory: boundedText(raw.outputDirectory, 1_024) }
      : {}),
  };
  const errors = validateDeploymentTarget(target);
  if (errors.length > 0) throw new Error(errors.join(' '));
  if (target.provider === 'deploy-hook') target.hookOrigin = new URL(target.hookOrigin!).origin;
  return target;
}

function prunePlans(now = Date.now()): void {
  for (const [id, item] of plans) if (item.expiresAt <= now) plans.delete(id);
}

function pruneRuns(): void {
  if (runs.size <= MAX_RUNS) return;
  const removable = [...runs.entries()]
    .filter(([, record]) => !record.controller && !localServers.has(record.run.id))
    .sort((left, right) => left[1].run.updatedAt - right[1].run.updatedAt);
  while (runs.size > MAX_RUNS && removable.length > 0) {
    const [id] = removable.shift()!;
    runs.delete(id);
  }
}

function markCancelled(record: RunRecord, summary = 'Deployment operation was cancelled.'): void {
  if (record.run.status === 'failed' || record.run.status === 'cancelled') return;
  record.run.status = 'cancelled';
  record.run.updatedAt = Date.now();
  record.run.summary = summary;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose();
    };
    const timer = setTimeout(finish, 2_000);
    try {
      server.close(finish);
      server.closeAllConnections?.();
    } catch {
      finish();
    }
  });
}

async function stopMatchingDeployments(
  predicate: (ownerId: number, root: string) => boolean,
  summary: string,
): Promise<void> {
  for (const [id, plan] of plans) {
    if (predicate(plan.ownerId, plan.plan.root)) plans.delete(id);
  }
  for (const item of [...planning]) {
    if (!predicate(item.ownerId, item.root)) continue;
    planning.delete(item);
    item.controller.abort();
  }
  for (const record of runs.values()) {
    if (!predicate(record.ownerId, record.root) || !record.controller) continue;
    markCancelled(record, summary);
    record.controller.abort();
  }
  const ownedServers = [...localServers.values()].filter((item) => {
    const record = runs.get(item.runId);
    return Boolean(record && predicate(record.ownerId, record.root));
  });
  await Promise.allSettled(
    ownedServers.map(async (item) => {
      localServers.delete(item.runId);
      const record = runs.get(item.runId);
      if (record) markCancelled(record, summary);
      await closeServer(item.server);
    }),
  );
}

export async function stopDeploymentsForOwner(ownerId: number): Promise<void> {
  await stopMatchingDeployments(
    (candidateOwner) => candidateOwner === ownerId,
    'Deployment stopped because its window closed.',
  );
}

export async function stopDeploymentsForWorkspace(root: string): Promise<void> {
  const key = rootKey(root);
  await stopMatchingDeployments(
    (_ownerId, candidateRoot) => rootKey(candidateRoot) === key,
    'Deployment stopped because workspace trust was revoked.',
  );
}

function bindOwner(owner: WebContents): void {
  if (boundOwners.has(owner.id)) return;
  boundOwners.add(owner.id);
  owner.once('destroyed', () => {
    boundOwners.delete(owner.id);
    void stopDeploymentsForOwner(owner.id);
  });
}

function isPublicHookAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return !blockedHookIpv4Addresses.check(normalized, 'ipv4');
  if (family === 6) return !blockedHookIpv6Addresses.check(normalized, 'ipv6');
  return false;
}

function normalizedHookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeDeploymentError('Deployment hook URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new SafeDeploymentError('Deployment hooks require credential-free HTTPS URLs.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new SafeDeploymentError('Deployment hooks must use a public HTTPS host.');
  }
  const family = isIP(hostname);
  if (family !== 0 && !isPublicHookAddress(hostname)) {
    throw new SafeDeploymentError('Deployment hooks must not target private or special-use IPs.');
  }
  return url;
}

export function describeDeploymentHook(
  root: string,
  targetId: unknown,
  hookUrl: unknown,
): {
  targetId: string;
  secretRef: string;
  hookOrigin: string;
  hookUrlSha256: string;
} {
  const id = boundedText(targetId, 100);
  const value = typeof hookUrl === 'string' ? hookUrl.trim() : '';
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id) || !value || value.length > 4_000) {
    throw new Error('Target id and hook URL are required.');
  }
  const parsed = normalizedHookUrl(value);
  const rootFingerprint = createHash('sha256').update(rootKey(root), 'utf-8').digest('hex');
  return {
    targetId: id,
    secretRef: `deployment.hook.${rootFingerprint}.${id}`,
    hookOrigin: parsed.origin,
    hookUrlSha256: createHash('sha256').update(parsed.toString(), 'utf-8').digest('hex'),
  };
}

export async function saveDeploymentHook(
  root: string,
  targetId: unknown,
  hookUrl: unknown,
): Promise<{
  secretRef: string;
  hookOrigin: string;
  hookRevision: string;
  hookUrlSha256: string;
}> {
  const descriptor = describeDeploymentHook(root, targetId, hookUrl);
  const parsed = normalizedHookUrl(typeof hookUrl === 'string' ? hookUrl.trim() : '');
  const metadata = await setDeploymentHookSecret(descriptor.secretRef, parsed.toString());
  if (
    metadata.origin !== descriptor.hookOrigin ||
    metadata.urlSha256 !== descriptor.hookUrlSha256
  ) {
    throw new Error('Stored deployment hook metadata did not match the approved URL.');
  }
  return {
    secretRef: descriptor.secretRef,
    hookOrigin: descriptor.hookOrigin,
    hookRevision: metadata.revision,
    hookUrlSha256: metadata.urlSha256,
  };
}

export async function createDeploymentPlan(
  owner: WebContents,
  root: string,
  rawTarget: unknown,
): Promise<DeploymentPlan> {
  prunePlans();
  bindOwner(owner);
  const target = targetOf(rawTarget);
  const controller = new AbortController();
  const planningRecord: PlanningRecord = { ownerId: owner.id, root, controller };
  planning.add(planningRecord);
  try {
    const commitSha = await currentCommit(root);
    throwIfAborted(controller.signal);
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error('The current Git commit is invalid.');

    let artifact: StaticSnapshot | null = null;
    if (target.provider === 'local-static') {
      const output = await staticDirectory(root, target.outputDirectory!);
      throwIfAborted(controller.signal);
      artifact = await captureStaticSnapshot(output, controller.signal);
      throwIfAborted(controller.signal);
    }

    const createdAt = Date.now();
    const plan: DeploymentPlan = {
      id: randomUUID(),
      root,
      target,
      commitSha,
      ...(artifact
        ? {
            artifactSha256: artifact.sha256,
            artifactFileCount: artifact.fileCount,
            artifactBytes: artifact.totalBytes,
          }
        : {}),
      createdAt,
      checks: [
        'A current successful verification plan is required.',
        `The one-shot deployment is pinned to commit ${commitSha.slice(0, 12)}.`,
        artifact
          ? `The local artifact is pinned to SHA-256 ${artifact.sha256}.`
          : 'Axiom sends only the pinned commit identifier, never workspace source files.',
      ],
      warnings:
        target.provider === 'deploy-hook'
          ? ['The provider hook can start billable external infrastructure.']
          : target.provider === 'github-actions'
            ? ['The selected workflow controls its own infrastructure and must honor commit_sha.']
            : [
                'The local preview server is reachable only through its exact loopback host and port.',
              ],
      requiresConfirmation: true,
    };
    throwIfAborted(controller.signal);
    plans.set(plan.id, { ownerId: owner.id, plan, expiresAt: createdAt + PLAN_TTL_MS });
    return plan;
  } catch (error) {
    if (controller.signal.aborted || error instanceof DeploymentCancelledError) {
      throw new Error('Deployment planning was cancelled.');
    }
    throw error;
  } finally {
    planning.delete(planningRecord);
  }
}

async function assertCleanTrackedWorktree(root: string): Promise<void> {
  const status = await getStatus(root);
  if (status.staged.length > 0 || status.unstaged.length > 0) {
    throw new Error(
      'Remote deployment requires a completely clean worktree, including no untracked files, so the dispatched commit is the verified source snapshot.',
    );
  }
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(value);
  if (!match) throw new Error('GitHub repository must be owner/name.');
  return { owner: match[1]!, repo: match[2]! };
}

function remoteRepository(raw: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      raw.trim(),
    );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

async function assertRepositoryMatches(root: string, repository: string): Promise<void> {
  const expected = repository.toLowerCase();
  const info = await getRepositoryInfo(root);
  if (
    !info.remotes.some(
      (remote) =>
        remote.github &&
        remoteRepository(remote.fetchUrl) === expected &&
        remoteRepository(remote.pushUrl) === expected,
    )
  ) {
    throw new Error(
      `The trusted workspace has no GitHub remote whose fetch and push destinations both match ${repository}.`,
    );
  }
}

function mime(path: string): string {
  const values: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return values[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function staticDirectory(root: string, outputDirectory: string): Promise<string> {
  const candidate = resolve(root, outputDirectory);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Static output must be a subdirectory of the workspace.');
  }
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(candidate);
  const realRel = relative(realRoot, real);
  if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new Error('Static output escapes the trusted workspace.');
  }
  if (!(await fs.stat(real)).isDirectory())
    throw new Error('Static output path is not a directory.');
  return real;
}

function sensitiveStaticPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return true;
  const filename = segments.at(-1)?.toLowerCase() ?? '';
  return (
    /^(?:secret|secrets|credential|credentials)(?:[._-]|$)/.test(filename) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(filename)
  );
}

async function captureStaticSnapshot(
  directory: string,
  signal: AbortSignal,
): Promise<StaticSnapshot> {
  const assets = new Map<string, StaticAsset>();
  const pendingDirectories = [''];
  let entriesVisited = 0;
  let totalBytes = 0;

  while (pendingDirectories.length > 0) {
    signal.throwIfAborted();
    const directoryRelative = pendingDirectories.shift()!;
    const currentDirectory = resolve(directory, directoryRelative);
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      entriesVisited += 1;
      if (entriesVisited > MAX_STATIC_ENTRIES) {
        throw new Error(`Static output exceeds the ${MAX_STATIC_ENTRIES}-entry limit.`);
      }
      const entryRelative = directoryRelative
        ? `${directoryRelative.replaceAll('\\', '/')}/${entry.name}`
        : entry.name;
      if (sensitiveStaticPath(entryRelative)) continue;
      const candidate = resolve(directory, entryRelative);
      const lexicalRelative = relative(directory, candidate);
      if (!lexicalRelative || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
        throw new Error('Static output contains an escaping path.');
      }
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) continue;
      const real = await fs.realpath(candidate);
      const realRelative = relative(directory, real);
      if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) {
        throw new Error('Static output contains a reparse-point escape.');
      }
      if (stat.isDirectory()) {
        pendingDirectories.push(entryRelative);
        continue;
      }
      if (!stat.isFile()) continue;
      if (assets.size >= MAX_STATIC_FILES) {
        throw new Error(`Static output exceeds the ${MAX_STATIC_FILES}-file limit.`);
      }
      if (stat.size > MAX_STATIC_FILE_BYTES) {
        throw new Error('A static output file exceeds the per-file size limit.');
      }
      const handle = await fs.open(real, 'r');
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_STATIC_FILE_BYTES) {
          throw new Error('A static output entry changed before snapshot capture.');
        }
        bytes = await handle.readFile();
        if (bytes.byteLength !== opened.size) {
          throw new Error('A static output file changed during snapshot capture.');
        }
      } finally {
        await handle.close();
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_STATIC_TOTAL_BYTES) {
        throw new Error('Static output exceeds the total snapshot size limit.');
      }
      const relativePath = entryRelative.replaceAll('\\', '/');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assets.set(`/${relativePath}`, { relativePath, bytes, sha256 });
    }
  }

  if (assets.size === 0) throw new Error('Static output contains no safe regular files.');
  const aggregate = createHash('sha256');
  for (const [path, asset] of [...assets.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    aggregate.update(`${path}\0${asset.bytes.byteLength}\0${asset.sha256}\n`, 'utf-8');
  }
  return {
    assets,
    fileCount: assets.size,
    totalBytes,
    sha256: aggregate.digest('hex'),
  };
}

async function startStaticServer(
  ownerId: number,
  runId: string,
  snapshot: StaticSnapshot,
  signal: AbortSignal,
): Promise<string> {
  if (localServers.size >= MAX_LOCAL_SERVERS) {
    throw new Error(`Close a local preview before starting more than ${MAX_LOCAL_SERVERS}.`);
  }
  let expectedHost = '';
  const server = createServer((request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        response.writeHead(421).end('Misdirected request');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      const parsed = new URL(request.url ?? '/', `http://${expectedHost}`);
      let pathname: string;
      try {
        pathname = decodeURIComponent(parsed.pathname);
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }
      if (
        pathname.includes('\0') ||
        pathname.split('/').some((part) => part === '..' || part === '.')
      ) {
        response.writeHead(400).end('Bad request');
        return;
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      if (sensitiveStaticPath(pathname)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const asset = snapshot.assets.get(pathname);
      if (!asset) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': mime(asset.relativePath),
        'Content-Length': String(asset.bytes.byteLength),
        'Cache-Control': 'no-store',
        ETag: `"sha256-${asset.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      response.end(request.method === 'HEAD' ? undefined : asset.bytes);
    } catch {
      if (!response.headersSent) response.writeHead(404).end('Not found');
      else response.end();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    const onStartupError = (error: Error): void => reject(error);
    server.once('error', onStartupError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onStartupError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Local preview server did not bind a TCP port.'));
        return;
      }
      expectedHost = `127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  server.on('error', () => {
    const record = runs.get(runId);
    if (record && record.run.status === 'ready') {
      record.run.status = 'failed';
      record.run.updatedAt = Date.now();
      record.run.summary = 'Local preview server stopped after a network error.';
    }
  });
  server.once('close', () => {
    if (localServers.get(runId)?.server === server) localServers.delete(runId);
  });
  if (signal.aborted) {
    await closeServer(server);
    throw new DeploymentCancelledError('Deployment was cancelled.');
  }
  localServers.set(runId, { ownerId, runId, server });
  return `http://${expectedHost}/`;
}

interface ResolvedHookAddress {
  address: string;
  family: 4 | 6;
}

function resolvePublicHookAddress(
  hostnameValue: string,
  signal: AbortSignal,
): Promise<ResolvedHookAddress> {
  const hostname = hostnameValue.replace(/^\[|\]$/g, '').toLowerCase();
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicHookAddress(hostname)) {
      return Promise.reject(
        new SafeDeploymentError('Deployment hook DNS resolved to a private or special-use IP.'),
      );
    }
    return Promise.resolve({ address: hostname, family: literalFamily });
  }
  return new Promise<ResolvedHookAddress>((resolveAddress, rejectAddress) => {
    let settled = false;
    const finish = (error: unknown, value?: ResolvedHookAddress): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) rejectAddress(error);
      else resolveAddress(value!);
    };
    const onAbort = (): void => finish(new DeploymentCancelledError('Deployment was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        if (addresses.length === 0) {
          finish(new SafeDeploymentError('Deployment hook host did not resolve.'));
          return;
        }
        if (addresses.some((entry) => !isPublicHookAddress(entry.address))) {
          finish(
            new SafeDeploymentError('Deployment hook DNS resolved to a private or special-use IP.'),
          );
          return;
        }
        const selected = addresses[0]!;
        if (selected.family !== 4 && selected.family !== 6) {
          finish(
            new SafeDeploymentError('Deployment hook resolved with an unsupported address family.'),
          );
          return;
        }
        finish(null, { address: selected.address, family: selected.family });
      },
      () => finish(new SafeDeploymentError('Deployment hook host resolution failed.')),
    );
  });
}

function postPinnedHook(
  url: URL,
  address: ResolvedHookAddress,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const finish = (error: unknown, value?: { status: number; payload: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) rejectResponse(error);
      else resolveResponse(value!);
    };
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: address.address,
        family: address.family,
        port: url.port ? Number.parseInt(url.port, 10) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0 ? { servername: url.hostname } : {}),
        headers: {
          Host: url.host,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
          'User-Agent': 'Axiom-Desktop',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          finish(new SafeDeploymentError('Deployment hook redirects are not allowed.'));
          return;
        }
        const declaredHeader = response.headers['content-length'];
        const declared = Number(Array.isArray(declaredHeader) ? declaredHeader[0] : declaredHeader);
        if (Number.isFinite(declared) && declared > MAX_HOOK_RESPONSE_BYTES) {
          response.destroy();
          finish(new SafeDeploymentError('Deploy-hook response was too large.'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          length += chunk.byteLength;
          if (length > MAX_HOOK_RESPONSE_BYTES) {
            response.destroy();
            request.destroy();
            finish(new SafeDeploymentError('Deploy-hook response was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', (error) => finish(error));
        response.once('end', () => {
          if (settled) return;
          let payload: unknown = null;
          if (length > 0) {
            try {
              payload = JSON.parse(Buffer.concat(chunks, length).toString('utf-8')) as unknown;
            } catch {
              payload = null;
            }
          }
          finish(null, { status, payload });
        });
      },
    );
    const onAbort = (): void => {
      request.destroy(new DeploymentCancelledError('Deployment was cancelled.'));
    };
    request.once('error', (error) => finish(error));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    request.end(body);
  });
}

function safeProviderUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function triggerHook(
  target: DeploymentTarget,
  commitSha: string,
  signal: AbortSignal,
): Promise<{ previewUrl: string | null; providerUrl: string | null }> {
  const hook = await resolveDeploymentHookSecret(
    target.secretRef!,
    target.hookOrigin!,
    target.hookRevision!,
    target.hookUrlSha256!,
  );
  const parsedHook = normalizedHookUrl(hook);
  if (parsedHook.origin !== target.hookOrigin) {
    throw new SafeDeploymentError('The stored deployment hook no longer matches this target.');
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
  try {
    const address = await resolvePublicHookAddress(parsedHook.hostname, controller.signal);
    const response = await postPinnedHook(
      parsedHook,
      address,
      JSON.stringify({ source: 'axiom', commit: commitSha }),
      controller.signal,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new SafeDeploymentError(`Deployment hook failed with HTTP ${response.status}.`);
    }
    const record =
      response.payload && typeof response.payload === 'object' && !Array.isArray(response.payload)
        ? (response.payload as Record<string, unknown>)
        : {};
    return {
      previewUrl: safeProviderUrl(record.url ?? record.preview_url),
      providerUrl: safeProviderUrl(record.inspector_url ?? record.dashboard_url),
    };
  } catch (error) {
    if (signal.aborted) {
      throw new DeploymentCancelledError('Deployment was cancelled.');
    }
    if (controller.signal.aborted) {
      throw new SafeDeploymentError('Deployment hook did not respond before the timeout.');
    }
    if (error instanceof DeploymentCancelledError) {
      throw new DeploymentCancelledError('Deployment was cancelled.');
    }
    if (error instanceof SafeDeploymentError) throw error;
    throw new SafeDeploymentError(
      'Deployment hook request failed without exposing its secret URL.',
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeploymentCancelledError('Deployment was cancelled.');
}

async function pinnedVerification(
  ownerId: number,
  verificationPlanId: string,
  root: string,
  commitSha: string,
  signal: AbortSignal,
  requireCleanCommit: boolean,
): Promise<VerificationRunResult> {
  const verification = await requireVerifiedPlan(ownerId, verificationPlanId, root);
  throwIfAborted(signal);
  const current = await currentCommit(root);
  throwIfAborted(signal);
  if (current.toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error(
      'The Git commit changed after this deployment plan was created. Create a new plan.',
    );
  }
  if (
    requireCleanCommit &&
    verification.cleanCommitSha?.toLowerCase() !== commitSha.toLowerCase()
  ) {
    throw new Error(
      'Remote deployment requires verification of an immutable, completely clean snapshot of this exact commit.',
    );
  }
  return verification;
}

export interface DeploymentExecutionApprovalDescriptor {
  ownerId: number;
  root: string;
  planId: string;
  verificationPlanId: string;
  planDigest: string;
  digest: string;
  detail: string;
}

function deploymentPlanIdentity(plan: DeploymentPlan): Record<string, unknown> {
  return {
    planId: plan.id,
    root: plan.root,
    provider: plan.target.provider,
    targetId: plan.target.id,
    targetName: plan.target.name,
    commitSha: plan.commitSha,
    artifactSha256: plan.artifactSha256 ?? null,
    artifactFileCount: plan.artifactFileCount ?? null,
    artifactBytes: plan.artifactBytes ?? null,
    outputDirectory: plan.target.outputDirectory ?? null,
    repository: plan.target.repository ?? null,
    workflow: plan.target.workflow ?? null,
    ref: plan.target.ref ?? null,
    hookSecretRef: plan.target.secretRef ?? null,
    hookOrigin: plan.target.hookOrigin ?? null,
    hookRevision: plan.target.hookRevision ?? null,
    hookUrlSha256: plan.target.hookUrlSha256 ?? null,
  };
}

export async function prepareDeploymentExecutionApproval(
  ownerId: number,
  root: string,
  input: ExecuteDeploymentInput,
): Promise<DeploymentExecutionApprovalDescriptor> {
  prunePlans();
  const stored = plans.get(input.planId);
  if (!stored || stored.ownerId !== ownerId || rootKey(stored.plan.root) !== rootKey(root)) {
    throw new Error('Deployment plan expired or belongs to another window.');
  }
  const verification = await requireVerifiedPlan(ownerId, input.verificationPlanId, root);
  const planIdentity = deploymentPlanIdentity(stored.plan);
  const planDigest = createHash('sha256').update(JSON.stringify(planIdentity)).digest('hex');
  const identity = {
    ownerId,
    ...planIdentity,
    verification: {
      planId: verification.planId,
      startedAt: verification.startedAt,
      endedAt: verification.endedAt,
      passed: verification.passed,
      level: verification.level,
      checks: verification.results.map((result) => ({
        checkId: result.checkId,
        passed: result.passed,
        exitCode: result.exitCode,
        summary: boundedText(result.summary, 500),
      })),
    },
  };
  const detail = JSON.stringify(identity, null, 2);
  if (detail.length > 10_000) {
    throw new Error('Deployment approval details exceed the native display limit.');
  }
  return {
    ownerId,
    root,
    planId: stored.plan.id,
    verificationPlanId: input.verificationPlanId,
    planDigest,
    digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    detail,
  };
}

export async function executeDeployment(
  owner: WebContents,
  root: string,
  raw: ExecuteDeploymentInput,
  approved: DeploymentExecutionApprovalDescriptor,
): Promise<DeploymentRun> {
  if (raw.confirmation !== true) {
    throw new Error('Starting a preview deployment requires explicit confirmation.');
  }
  prunePlans();
  bindOwner(owner);
  const stored = plans.get(raw.planId);
  if (!stored || stored.ownerId !== owner.id || rootKey(stored.plan.root) !== rootKey(root)) {
    throw new Error('Deployment plan expired or belongs to another window.');
  }
  const currentPlanDigest = createHash('sha256')
    .update(JSON.stringify(deploymentPlanIdentity(stored.plan)))
    .digest('hex');
  if (
    approved.ownerId !== owner.id ||
    rootKey(approved.root) !== rootKey(root) ||
    approved.planId !== raw.planId ||
    approved.verificationPlanId !== raw.verificationPlanId ||
    approved.planDigest !== currentPlanDigest
  ) {
    throw new Error('Deployment plan or verification identity changed after approval.');
  }
  // Consume and register synchronously before the first await. Owner destruction,
  // trust revocation, and explicit cancellation can now abort every preflight phase.
  plans.delete(stored.plan.id);
  const target = stored.plan.target;
  const now = Date.now();
  const run: DeploymentRun = {
    id: randomUUID(),
    planId: stored.plan.id,
    provider: target.provider,
    status: 'deploying',
    createdAt: now,
    updatedAt: now,
    previewUrl: null,
    providerUrl: null,
    commitSha: stored.plan.commitSha,
    summary: 'Deployment preflight is validating the approved commit, verification, and artifact.',
    evidence: [],
  };
  const controller = new AbortController();
  const record: RunRecord = { ownerId: owner.id, root, run, controller };
  runs.set(run.id, record);
  pruneRuns();

  try {
    throwIfAborted(controller.signal);
    const initialCommit = await currentCommit(root);
    throwIfAborted(controller.signal);
    if (initialCommit.toLowerCase() !== stored.plan.commitSha.toLowerCase()) {
      throw new Error(
        'The Git commit changed after this deployment plan was created. Create a new plan.',
      );
    }

    let staticOutput: string | null = null;
    if (target.provider === 'local-static') {
      staticOutput = await staticDirectory(root, target.outputDirectory!);
      throwIfAborted(controller.signal);
    }

    const verification = await pinnedVerification(
      owner.id,
      raw.verificationPlanId,
      root,
      stored.plan.commitSha,
      controller.signal,
      target.provider !== 'local-static',
    );
    throwIfAborted(controller.signal);
    run.summary = `Deployment started after ${verification.results.length} verified check(s).`;
    run.evidence = verification.results.map((result) => ({
      id: `${raw.verificationPlanId}:${result.checkId}`,
      kind: 'deployment',
      label: result.checkId,
      passed: result.passed,
      summary: boundedText(result.summary, 2_000),
      createdAt: verification.endedAt,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }));

    if (target.provider === 'local-static') {
      const snapshot = await captureStaticSnapshot(staticOutput!, controller.signal);
      throwIfAborted(controller.signal);
      if (
        snapshot.sha256 !== stored.plan.artifactSha256 ||
        snapshot.fileCount !== stored.plan.artifactFileCount ||
        snapshot.totalBytes !== stored.plan.artifactBytes
      ) {
        throw new Error(
          'Local deployment output changed after the one-shot plan was approved. Create a new deployment plan and verify again.',
        );
      }
      run.evidence.push({
        id: `${run.id}:artifact-snapshot`,
        kind: 'deployment',
        label: 'Approved immutable local preview snapshot',
        passed: true,
        summary: `${snapshot.fileCount} safe file(s), ${snapshot.totalBytes} byte(s), SHA-256 ${snapshot.sha256}.`,
        createdAt: Date.now(),
      });
      // Final gate immediately before creating the privileged local listener.
      throwIfAborted(controller.signal);
      run.previewUrl = await startStaticServer(owner.id, run.id, snapshot, controller.signal);
      throwIfAborted(controller.signal);
      run.providerUrl = run.previewUrl;
      run.status = 'ready';
      run.summary =
        'Local static preview is serving the exact approved, verified immutable byte snapshot on an exact-host loopback-only server.';
    } else {
      let repository: { owner: string; repo: string } | null = null;
      if (target.provider === 'github-actions') {
        await assertRepositoryMatches(root, target.repository!);
        throwIfAborted(controller.signal);
        repository = parseRepository(target.repository!);
      }
      await assertCleanTrackedWorktree(root);
      throwIfAborted(controller.signal);
      const dispatchCommit = await currentCommit(root);
      throwIfAborted(controller.signal);
      if (dispatchCommit.toLowerCase() !== stored.plan.commitSha.toLowerCase()) {
        throw new Error(
          'The Git commit changed before provider dispatch. Create a new deployment plan.',
        );
      }

      if (target.provider === 'github-actions') {
        // Final gate immediately before the external mutation; no asynchronous
        // preflight remains between clean commit validation and dispatch.
        throwIfAborted(controller.signal);
        const response = await githubApiRequest(
          owner.id,
          `/repos/${repository!.owner}/${repository!.repo}/actions/workflows/${target.workflow!}/dispatches`,
          'POST',
          { ref: target.ref!, inputs: { axiom_preview: 'true', commit_sha: run.commitSha } },
          controller.signal,
        );
        throwIfAborted(controller.signal);
        if (!response.ok) {
          throw new SafeDeploymentError(
            `GitHub workflow dispatch failed with HTTP ${response.status}.`,
          );
        }
        run.status = 'queued';
        run.providerUrl = `https://github.com/${repository!.owner}/${repository!.repo}/actions`;
        run.summary = `GitHub Actions accepted ${target.workflow} for ${target.ref}; the workflow must honor commit_sha ${stored.plan.commitSha.slice(0, 12)}.`;
      } else {
        // Final gate immediately before connecting to the external hook.
        throwIfAborted(controller.signal);
        const hook = await triggerHook(target, run.commitSha!, controller.signal);
        throwIfAborted(controller.signal);
        run.previewUrl = hook.previewUrl;
        run.providerUrl = hook.providerUrl;
        run.status = 'queued';
        run.summary = hook.previewUrl
          ? 'Provider accepted the deployment hook and reported a preview URL; external completion remains unverified by Axiom.'
          : 'Provider accepted the deployment hook; external completion is not verified by Axiom.';
      }
    }
    run.updatedAt = Date.now();
    run.evidence.push({
      id: `${run.id}:provider`,
      kind: 'deployment',
      label: target.name,
      passed: run.status === 'ready' ? true : null,
      summary: run.summary,
      createdAt: run.updatedAt,
    });
    return cloneRun(run);
  } catch (error) {
    if (controller.signal.aborted || error instanceof DeploymentCancelledError) {
      markCancelled(record);
      return cloneRun(run);
    }
    run.status = 'failed';
    run.updatedAt = Date.now();
    run.summary =
      error instanceof SafeDeploymentError || error instanceof Error
        ? boundedText(error.message, 1_000, 'Deployment failed.')
        : 'Deployment failed.';
    run.evidence.push({
      id: `${run.id}:provider-failure`,
      kind: 'deployment',
      label: target.name,
      passed: false,
      summary: run.summary,
      createdAt: run.updatedAt,
    });
    throw new Error(run.summary);
  } finally {
    record.controller = null;
  }
}

export function listDeployments(ownerId: number, root: string): DeploymentRun[] {
  const key = rootKey(root);
  return [...runs.values()]
    .filter((record) => record.ownerId === ownerId && rootKey(record.root) === key)
    .sort((left, right) => right.run.updatedAt - left.run.updatedAt)
    .map((record) => cloneRun(record.run));
}

export async function cancelDeployment(ownerId: number, runId: unknown): Promise<void> {
  const id = typeof runId === 'string' ? runId : '';
  const record = runs.get(id);
  if (!record) return;
  if (record.ownerId !== ownerId) throw new Error('Deployment belongs to another window.');
  const server = localServers.get(id);
  if (server) {
    localServers.delete(id);
    markCancelled(record, 'Local deployment preview stopped.');
    await closeServer(server.server);
    return;
  }
  if (record.controller) {
    markCancelled(record);
    record.controller.abort();
    return;
  }
  if (record.run.status === 'queued') {
    throw new Error(
      'The external provider already accepted this deployment; Axiom cannot cancel it.',
    );
  }
}

export async function stopAllDeployments(): Promise<void> {
  await stopMatchingDeployments(() => true, 'Deployment stopped during application shutdown.');
}
