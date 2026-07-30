import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startRun, appendRunStep, type RunEvent, type RunRecord } from '../../common/runJournal';
import {
  checkpointFromRun,
  planResume,
  isRunResumable,
  type PlanStep,
  type ResumePlan,
} from '../../common/runResume';
import { planBranch, type BranchPlan } from '../../common/timeTravel';
import { buildReinvoke, type ReinvokeKind, type ReinvokeRequest } from '../../common/runReinvoke';

/**
 * Agent run persistence (Main, PRD Epoch H / Phases 209/210). Persists each agent
 * run + its complete step timeline to userData/agent-runs.json (atomic,
 * newest-first) so runs survive a restart — the live task registry in agent.ts
 * stays session-only. Every operation participates in one serialized stream.
 */
const FILE = 'agent-runs.json';

let runs: Map<string, RunRecord> | null = null;
let loadPromise: Promise<Map<string, RunRecord>> | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function filePath(): string {
  return join(app.getPath('userData'), FILE);
}

const RUN_STATUSES = new Set(['running', 'awaiting-approval', 'completed', 'failed', 'cancelled']);

function isRecord(v: unknown): v is RunRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.root === undefined || typeof o.root === 'string') &&
    typeof o.preset === 'string' &&
    typeof o.task === 'string' &&
    typeof o.status === 'string' &&
    RUN_STATUSES.has(o.status) &&
    typeof o.startedAt === 'number' &&
    (o.endedAt === null || typeof o.endedAt === 'number') &&
    Array.isArray(o.steps)
  );
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function newestFirst(values: Iterable<RunRecord>): RunRecord[] {
  return [...values].sort((a, b) => b.startedAt - a.startedAt);
}

function rootKey(root: string): string {
  const value = normalize(root);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function belongsToRoot(run: RunRecord, root: string): boolean {
  return typeof run.root === 'string' && rootKey(run.root) === rootKey(root);
}

async function readRuns(): Promise<Map<string, RunRecord>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath(), 'utf-8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return new Map();
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error(`Invalid agent run journal at ${filePath()}.`);
  }

  const loaded = new Map<string, RunRecord>();
  for (const run of parsed) {
    if (loaded.has(run.id)) throw new Error(`Duplicate agent run id "${run.id}" in journal.`);
    loaded.set(run.id, run);
  }
  return loaded;
}

/** Load the journal exactly once; a failed load remains visible to every caller. */
async function load(): Promise<Map<string, RunRecord>> {
  if (runs) return runs;
  loadPromise ??= readRuns();
  runs = await loadPromise;
  return runs;
}

/** Queue reads and writes together so their observable order matches invocation order. */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persist(next: Map<string, RunRecord>): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-runs-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(newestFirst(next.values())), 'utf-8');
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Publish an in-memory state only after its atomic disk replacement succeeds. */
async function commit(next: Map<string, RunRecord>): Promise<void> {
  await persist(next);
  runs = next;
}

/** Record the start of a run and wait until it is durable. */
export function beginRun(
  id: string,
  preset: string,
  task: string,
  root: string,
  now: number,
): Promise<void> {
  return serialize(async () => {
    const current = await load();
    if (current.has(id)) throw new Error('An agent run with this id already exists.');
    const next = new Map(current);
    next.set(id, startRun(id, preset, task, root, now));
    await commit(next);
  });
}

/** Fold an event into the timeline and wait until the updated journal is durable. */
export function recordRunEvent(id: string, event: RunEvent, now: number): Promise<void> {
  return serialize(async () => {
    const currentRuns = await load();
    const current = currentRuns.get(id);
    if (!current) return;

    const updated = appendRunStep(current, event, now);
    if (updated === current) return; // Terminal statuses are absorbing.

    const next = new Map(currentRuns);
    next.set(id, updated);
    await commit(next);
  });
}

/** Persisted runs for exactly one canonical workspace, complete and newest first. */
export function listRuns(root: string): Promise<RunRecord[]> {
  return serialize(async () =>
    newestFirst((await load()).values()).filter((run) => belongsToRoot(run, root)),
  );
}

/** Fetch a single persisted run by id (for resume replay, Phase 210). */
export function getRun(id: string): Promise<RunRecord | null> {
  return serialize(async () => (await load()).get(id) ?? null);
}

/**
 * Persisted runs that can be RESUMED — not completed / cancelled (Phase 209/210).
 * Newest first. Backs a "resume interrupted run" affordance after a crash/restart.
 */
export function listResumableRuns(root: string): Promise<RunRecord[]> {
  return serialize(async () =>
    newestFirst((await load()).values()).filter(
      (run) => belongsToRoot(run, root) && isRunResumable(run),
    ),
  );
}

/**
 * Build a replay-safe resume plan for a persisted run, given its plan-first step
 * list (Phase 210). The checkpoint is reconstructed best-effort from the journal
 * (completed tool steps → done plan steps), so completed — especially
 * side-effecting — steps are NOT re-executed on resume. Returns null when the run
 * is unknown.
 */
export function buildResumePlan(id: string, plan: PlanStep[]): Promise<ResumePlan | null> {
  return serialize(async () => {
    const run = (await load()).get(id);
    if (!run) return null;
    return planResume(checkpointFromRun(run, plan));
  });
}

/**
 * Time-travel review (Phase 256): plan a branch of a persisted run — "redo from
 * step N with a different approach". Returns a BranchPlan that preserves the first
 * N steps as history (not re-executed) + a continuation context to seed a new run.
 * Returns null when the run is unknown.
 */
export function buildRunBranch(
  id: string,
  root: string,
  branchIndex: number,
  guidance?: string,
): Promise<BranchPlan | null> {
  return serialize(async () => {
    const run = (await load()).get(id);
    if (!run || !belongsToRoot(run, root)) return null;
    return planBranch(run, branchIndex, guidance !== undefined ? { guidance } : {});
  });
}

/**
 * Resume/branch EXECUTION (Phase 209/210): build a fresh-run request (composed task
 * + source preset) from a persisted run, so the caller can start a normal agent run
 * that continues (resume) or redoes-from-a-step (branch). Returns null when the run
 * is unknown; `.ok` is false when the source doesn't support the re-invocation.
 */
export function buildRunReinvoke(
  id: string,
  root: string,
  kind: ReinvokeKind,
  options: { branchIndex?: number; guidance?: string } = {},
): Promise<ReinvokeRequest | null> {
  return serialize(async () => {
    const run = (await load()).get(id);
    if (!run || !belongsToRoot(run, root)) return null;
    return buildReinvoke(run, kind, options);
  });
}

/** Clear terminal history for one workspace while preserving all other records. */
export function clearRuns(root: string): Promise<void> {
  return serialize(async () => {
    const current = await load();
    const retained = new Map(
      [...current].filter(
        ([, run]) =>
          !belongsToRoot(run, root) ||
          run.status === 'running' ||
          run.status === 'awaiting-approval',
      ),
    );
    await commit(retained);
  });
}
