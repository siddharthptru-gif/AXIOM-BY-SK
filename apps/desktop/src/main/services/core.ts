import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateProcessTree } from './processTree';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@axiom/shared';
import { buildChildProcessEnvironment } from './processEnvironment';
import { assertAuthorizedPath, canonicalPathIdentity } from './pathAuthorization';
import { readFile } from './filesystem';

/**
 * Supervisor + JSON-RPC client for the Rust Core sidecar (PRD Epoch C, Phase 49).
 * Spawns the `axiom-core` binary on demand, frames newline-delimited JSON over
 * stdio, and correlates responses by id. Degrades gracefully — calls reject with
 * a clear message when the binary hasn't been built yet — so the app never breaks
 * if Core is unavailable.
 */
const log = rootLogger.child('core');
const CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CoreClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;

  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  private resolveBinary(): string | null {
    // Packaged builds must use the sidecar shipped with this exact application
    // version; never fall back to an environment- or repository-selected binary.
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, 'bin', 'axiom-core.exe');
      return existsSync(packaged) ? packaged : null;
    }

    const candidates: string[] = [];
    const fromEnv = process.env.AXIOM_CORE_BIN;
    if (fromEnv) candidates.push(fromEnv);
    const roots = [join(app.getAppPath(), '..', '..'), process.cwd()];
    for (const root of roots) {
      // Cargo workspace output (repo-root ./target — current layout, PRD §15.1).
      candidates.push(join(root, 'target', 'release', 'axiom-core.exe'));
      candidates.push(join(root, 'target', 'debug', 'axiom-core.exe'));
      // Standalone crate output (fallback for non-workspace builds).
      candidates.push(join(root, 'crates', 'axiom-core', 'target', 'release', 'axiom-core.exe'));
      candidates.push(join(root, 'crates', 'axiom-core', 'target', 'debug', 'axiom-core.exe'));
    }
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  private start(): boolean {
    if (this.proc) return true;
    const bin = this.resolveBinary();
    if (!bin) {
      log.warn('axiom-core binary not found; Core features are disabled until it is built');
      return false;
    }
    const proc = spawn(bin, [], {
      detached: process.platform !== 'win32',
      env: buildChildProcessEnvironment({ color: false }),
    });
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => log.debug(`core: ${chunk.trim()}`));
    proc.on('exit', (code) => {
      log.warn('axiom-core exited', { code });
      this.teardown(new Error('Core process exited'));
    });
    proc.on('error', (error: Error) => {
      log.error('axiom-core spawn error', { error: error.message });
      this.teardown(new Error('Core process error'));
    });
    this.proc = proc;
    log.info('axiom-core started', { bin });
    return true;
  }

  private teardown(error: Error): void {
    this.proc = null;
    this.buffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim().length > 0) this.onMessage(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const record = msg as Record<string, unknown>;
    // Server-initiated notifications carry a `method` and no numeric id (e.g.
    // `fs/event` from the native watcher). Route them to the handler.
    if (typeof record.method === 'string') {
      this.notificationHandler?.(record.method, record.params);
      return;
    }
    const id = record.id;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.error) {
      const err = record.error as Record<string, unknown>;
      pending.reject(new Error(typeof err.message === 'string' ? err.message : 'Core error'));
    } else {
      pending.resolve(record.result);
    }
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.start() || !this.proc) {
      return Promise.reject(new Error('Axiom Core is unavailable.'));
    }
    const id = this.nextId++;
    const proc = this.proc;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('Core request timed out.'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.teardown(new Error('Core disposed'));
    if (proc) await terminateProcessTree(proc);
  }
}

const client = new CoreClient();

function coreRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Core returned an invalid ${label} response.`);
  }
  return value as Record<string, unknown>;
}

async function authorizeCoreResultPath(
  root: string,
  value: unknown,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error('Core returned an invalid path.');
  }
  const canonical = await assertAuthorizedPath(value, {
    ...(options.allowMissing === true ? { allowMissing: true } : {}),
  });
  const rel = relative(root, canonical);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Core returned a path outside the authorized workspace root.');
  }
  return canonical;
}

async function validateCoreEnvelopeRoot(
  root: string,
  record: Record<string, unknown>,
): Promise<void> {
  const returnedRoot = await authorizeCoreResultPath(root, record.root);
  if (canonicalPathIdentity(returnedRoot) !== canonicalPathIdentity(root)) {
    throw new Error('Core returned a mismatched workspace root.');
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Core returned an invalid ${label}.`);
  }
  return Number(value);
}

async function rereadCoreLines(
  root: string,
  pathValue: unknown,
  startLine: number,
  endLine: number,
  maxChars: number,
): Promise<{ path: string; text: string }> {
  const path = await authorizeCoreResultPath(root, pathValue);
  const file = await readFile(path);
  if (file.binary) throw new Error('Core referenced a binary file as text.');
  const lines = file.content.split(/\r?\n/);
  if (startLine > lines.length + 1 || endLine < startLine) {
    throw new Error('Core returned an invalid line range.');
  }
  return {
    path,
    text: lines
      .slice(startLine - 1, Math.min(endLine, lines.length))
      .join('\n')
      .slice(0, maxChars),
  };
}

async function validateCorePathArray(
  root: string,
  value: unknown,
  maximum: number,
): Promise<string[]> {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error('Core returned an invalid or oversized path list.');
  }
  return Promise.all(value.map((path) => authorizeCoreResultPath(root, path)));
}

async function validateGraphListResult(
  root: string,
  path: string,
  method: string,
  listKey: 'dependencies' | 'dependents' | 'impacted',
): Promise<unknown> {
  const record = coreRecord(await client.call(method, { root, path }), method);
  await validateCoreEnvelopeRoot(root, record);
  const returnedPath = await authorizeCoreResultPath(root, record.path);
  if (canonicalPathIdentity(returnedPath) !== canonicalPathIdentity(path)) {
    throw new Error('Core returned a mismatched graph query path.');
  }
  const paths = await validateCorePathArray(root, record[listKey], 20_000);
  const result: Record<string, unknown> = {
    root,
    path: returnedPath,
    [listKey]: paths,
    count: paths.length,
  };
  if (listKey === 'dependencies') {
    const external = Array.isArray(record.external)
      ? record.external
          .filter((value): value is string => typeof value === 'string' && value.length <= 512)
          .slice(0, 20_000)
      : [];
    result.external = external;
  }
  return result;
}

export function coreInitialize(): Promise<unknown> {
  return client.call('initialize', {});
}
export async function coreWalk(root: string): Promise<unknown> {
  const record = coreRecord(await client.call('walk', { root }), 'walk');
  await validateCoreEnvelopeRoot(root, record);
  const files = await validateCorePathArray(root, record.files, 100_000);
  return { root, files, count: files.length };
}
export async function coreSearch(
  root: string,
  query: string,
  caseSensitive: boolean,
): Promise<unknown> {
  if (!query || query.length > 16_384) throw new Error('Core search query is invalid.');
  const record = coreRecord(
    await client.call('search', { root, query, case_sensitive: caseSensitive }),
    'search',
  );
  await validateCoreEnvelopeRoot(root, record);
  if (!Array.isArray(record.matches) || record.matches.length > 5_000) {
    throw new Error('Core returned an invalid or oversized search result.');
  }
  const matches = [];
  for (const value of record.matches) {
    const match = coreRecord(value, 'search match');
    const line = boundedInteger(match.line, 1, 10_000_000, 'search line');
    const reread = await rereadCoreLines(root, match.path, line, line, 4_096);
    matches.push({ path: reread.path, line, text: reread.text });
  }
  return { root, query, matches, count: matches.length };
}
/**
 * Semantic (natural-language) retrieval over the workspace using the on-device
 * embedder + cosine ranking (PRD Epoch C Phase 64, Part VIII §126). Returns
 * top-k chunks with file/line provenance. Code never leaves the machine (INV-4).
 */
export async function coreRetrieve(
  root: string,
  query: string,
  options?: { topK?: number; maxLines?: number; dim?: number },
): Promise<unknown> {
  if (!query || query.length > 16_384) throw new Error('Core retrieval query is invalid.');
  const params: Record<string, unknown> = { root, query };
  if (typeof options?.topK === 'number') params.top_k = options.topK;
  if (typeof options?.maxLines === 'number') params.max_lines = options.maxLines;
  if (typeof options?.dim === 'number') params.dim = options.dim;
  const record = coreRecord(await client.call('retrieve', params), 'retrieval');
  await validateCoreEnvelopeRoot(root, record);
  if (!Array.isArray(record.results) || record.results.length > 100) {
    throw new Error('Core returned an invalid or oversized retrieval result.');
  }
  const results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    preview: string;
  }> = [];
  for (const value of record.results) {
    const hit = coreRecord(value, 'retrieval hit');
    const startLine = boundedInteger(hit.startLine, 1, 10_000_000, 'retrieval start line');
    const endLine = boundedInteger(hit.endLine, startLine, 10_000_000, 'retrieval end line');
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
      throw new Error('Core returned an invalid retrieval score.');
    }
    const reread = await rereadCoreLines(root, hit.path, startLine, endLine, 32_000);
    results.push({
      path: reread.path,
      startLine,
      endLine,
      score: hit.score,
      preview: reread.text,
    });
  }
  return { root, query, count: results.length, results };
}
/** Embed a text into an L2-normalized vector via the on-device embedder (PRD Phase 59). */
export function coreEmbed(text: string, dim?: number): Promise<unknown> {
  const params: Record<string, unknown> = { text };
  if (typeof dim === 'number') params.dim = dim;
  return client.call('embed', params);
}
/** Build (or rebuild) the on-device dependency graph for a workspace (PRD Phase 65). */
export async function coreGraphBuild(root: string): Promise<unknown> {
  const record = coreRecord(await client.call('graph/build', { root }), 'graph build');
  await validateCoreEnvelopeRoot(root, record);
  return {
    root,
    files: boundedInteger(record.files, 0, 200_000, 'graph file count'),
    edges: boundedInteger(record.edges, 0, 2_000_000, 'graph edge count'),
  };
}
/** Files (+ external packages) a file imports (PRD Phase 66). */
export function coreGraphDependencies(root: string, path: string): Promise<unknown> {
  return validateGraphListResult(root, path, 'graph/dependencies', 'dependencies');
}
/** Files that directly import a file (PRD Phase 66). */
export function coreGraphDependents(root: string, path: string): Promise<unknown> {
  return validateGraphListResult(root, path, 'graph/dependents', 'dependents');
}
/** Transitive set of files affected by changing a file — impact analysis (PRD Phase 66). */
export function coreGraphImpact(root: string, path: string): Promise<unknown> {
  return validateGraphListResult(root, path, 'graph/impact', 'impacted');
}
/** Example import cycles in the workspace (PRD Phase 66). */
export async function coreGraphCycles(root: string): Promise<unknown> {
  const record = coreRecord(await client.call('graph/cycles', { root }), 'graph cycles');
  await validateCoreEnvelopeRoot(root, record);
  if (!Array.isArray(record.cycles) || record.cycles.length > 1_000) {
    throw new Error('Core returned invalid or oversized dependency cycles.');
  }
  const cycles: string[][] = [];
  for (const value of record.cycles) {
    cycles.push(await validateCorePathArray(root, value, 200));
  }
  return { root, cycles, count: cycles.length };
}
/** Derive a project profile — frameworks, languages, scripts, monorepo (PRD Phase 68). */
export async function coreProjectUnderstand(root: string): Promise<unknown> {
  const record = coreRecord(await client.call('project/understand', { root }), 'project profile');
  await validateCoreEnvelopeRoot(root, record);
  const entryPoints = await validateCorePathArray(root, record.entryPoints ?? [], 100);
  const result = { ...record, root, entryPoints };
  if (JSON.stringify(result).length > 2 * 1024 * 1024) {
    throw new Error('Core project profile exceeds the Main response limit.');
  }
  return result;
}
export async function coreSymbols(root: string, path: string): Promise<unknown> {
  const record = coreRecord(await client.call('symbols', { root, path }), 'symbols');
  await validateCoreEnvelopeRoot(root, record);
  const returnedPath = await authorizeCoreResultPath(root, record.path);
  if (canonicalPathIdentity(returnedPath) !== canonicalPathIdentity(path)) {
    throw new Error('Core returned a mismatched symbol path.');
  }
  if (!Array.isArray(record.symbols) || record.symbols.length > 20_000) {
    throw new Error('Core returned invalid or oversized symbols.');
  }
  if (JSON.stringify(record.symbols).length > 8 * 1024 * 1024) {
    throw new Error('Core symbol response exceeds the Main limit.');
  }
  return { ...record, root, path: returnedPath, count: record.symbols.length };
}
export async function coreChunk(
  root: string,
  path: string,
  options?: { maxLines?: number; overlap?: number },
): Promise<unknown> {
  const params: Record<string, unknown> = { root, path };
  if (typeof options?.maxLines === 'number') params.max_lines = options.maxLines;
  if (typeof options?.overlap === 'number') params.overlap = options.overlap;
  const record = coreRecord(await client.call('chunk', params), 'chunks');
  await validateCoreEnvelopeRoot(root, record);
  const returnedPath = await authorizeCoreResultPath(root, record.path);
  if (canonicalPathIdentity(returnedPath) !== canonicalPathIdentity(path)) {
    throw new Error('Core returned a mismatched chunk path.');
  }
  if (!Array.isArray(record.chunks) || record.chunks.length > 10_000) {
    throw new Error('Core returned invalid or oversized chunks.');
  }
  const file = await readFile(returnedPath);
  if (file.binary) throw new Error('Core referenced a binary file as text.');
  const lines = file.content.split(/\r?\n/);
  let returnedChars = 0;
  const chunks = record.chunks.map((value, index) => {
    const chunk = coreRecord(value, 'chunk');
    const startLine = boundedInteger(chunk.startLine, 1, 10_000_000, 'chunk start line');
    const endLine = boundedInteger(chunk.endLine, startLine, 10_000_000, 'chunk end line');
    const text = lines.slice(startLine - 1, Math.min(endLine, lines.length)).join('\n');
    returnedChars += text.length;
    if (returnedChars > 16 * 1024 * 1024) {
      throw new Error('Core chunk response exceeds the Main text limit.');
    }
    return { index, startLine, endLine, text };
  });
  return { root, path: returnedPath, count: chunks.length, chunks };
}
export function coreWatch(root: string): Promise<unknown> {
  return client.call('watch', { root });
}
export function coreUnwatch(root: string): Promise<unknown> {
  return client.call('unwatch', { root });
}
export function coreCatalogRebuild(root: string, db: string): Promise<unknown> {
  return client.call('catalog/rebuild', { root, db });
}
export function coreCatalogStats(db: string): Promise<unknown> {
  return client.call('catalog/stats', { db });
}
export function coreCatalogQuery(db: string, pattern?: string, limit?: number): Promise<unknown> {
  const params: Record<string, unknown> = { db };
  if (typeof pattern === 'string') params.pattern = pattern;
  if (typeof limit === 'number') params.limit = limit;
  return client.call('catalog/query', params);
}
/** Register a handler for server-initiated Core notifications (e.g. `fs/event`). */
export function onCoreNotification(handler: (method: string, params: unknown) => void): void {
  client.setNotificationHandler(handler);
}
export function coreDispose(): Promise<void> {
  return client.dispose();
}

/**
 * The current sidecar protocol has no per-request cancellation id. Revocation
 * therefore terminates the whole isolated Core process so no task or watcher can
 * retain access; unaffected roots lazily restart it on their next authorized call.
 */
export function coreDrainForWorkspace(_root: string): Promise<void> {
  return client.dispose();
}
