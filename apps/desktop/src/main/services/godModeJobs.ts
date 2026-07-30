import { app } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AgentStepEvent, AgentTask } from '../../common/ipc';
import type {
  CreateAutonomousJobInput,
  EngineeringPhase,
  EvidenceKind,
  EvidenceRecord,
  GodModeJob,
  GodModeJobStatus,
  JobControlInput,
} from '../../common/godMode';
import { boundedText, canTransitionJob } from '../../common/godMode';

const STORE_VERSION = 1;
const MAX_JOBS = 300;
const MAX_EVIDENCE = 500;

interface JobStore {
  version: typeof STORE_VERSION;
  jobs: GodModeJob[];
}

let operationTail: Promise<void> = Promise.resolve();

function filePath(): string {
  return join(app.getPath('userData'), 'god-mode', 'jobs.json');
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

function isJob(value: unknown): value is GodModeJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.kind === 'autonomous-run' &&
    typeof item.root === 'string' &&
    typeof item.title === 'string' &&
    [
      'queued',
      'running',
      'paused',
      'awaiting-approval',
      'completed',
      'failed',
      'cancelled',
    ].includes(String(item.status)) &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number' &&
    Array.isArray(item.evidence)
  );
}

async function readStore(): Promise<JobStore> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: STORE_VERSION, jobs: [] };
    }
    const value = parsed as { version?: unknown; jobs?: unknown };
    if (value.version !== STORE_VERSION || !Array.isArray(value.jobs)) {
      return { version: STORE_VERSION, jobs: [] };
    }
    return {
      version: STORE_VERSION,
      jobs: value.jobs
        .filter(isJob)
        .slice(-MAX_JOBS)
        .map((job) => ({
          ...job,
          resumeRunId: typeof job.resumeRunId === 'string' ? job.resumeRunId : null,
        })),
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError)
      return { version: STORE_VERSION, jobs: [] };
    throw error;
  }
}

async function writeStore(store: JobStore): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.jobs-${randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(
    temp,
    `${JSON.stringify({ ...store, jobs: store.jobs.slice(-MAX_JOBS) }, null, 2)}\n`,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function rootKey(root: string): string {
  const value = resolve(root);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function evidenceKind(event: AgentStepEvent): EvidenceKind | null {
  if (event.kind !== 'tool') return null;
  const text = `${event.tool ?? ''} ${event.text ?? ''} ${event.observation ?? ''}`.toLowerCase();
  if (/test|vitest|jest|pytest/.test(text)) return 'test';
  if (/typecheck|tsc/.test(text)) return 'typecheck';
  if (/lint|eslint|prettier/.test(text)) return 'lint';
  if (/build|compile/.test(text)) return 'build';
  if (/run_command|terminal/.test(text)) return 'command';
  return null;
}

function phaseForEvent(event: AgentStepEvent): EngineeringPhase {
  if (event.kind === 'plan') return 'plan';
  if (event.kind === 'approval') return 'edit';
  if (event.kind === 'tool') {
    if (event.observation !== undefined) {
      return evidenceKind(event) ? 'observe' : 'edit';
    }
    return evidenceKind(event) ? 'run' : 'edit';
  }
  if (event.kind === 'final' || event.kind === 'error') return 'summarize';
  return event.progress?.phase === 'verifying' ? 'verify' : 'understand';
}

function toEvidence(event: AgentStepEvent): EvidenceRecord | null {
  const kind = evidenceKind(event);
  if (!kind || event.observation === undefined) return null;
  const evidenceText = event.observation ?? event.text ?? '';
  const passed = /\b(pass(?:ed)?|succeeded|exit\s*0)\b/i.test(evidenceText)
    ? true
    : /\b(fail(?:ed)?|error|exit\s*[1-9])\b/i.test(evidenceText)
      ? false
      : null;
  return {
    id: `${event.id}:${event.step}:${event.at}`,
    kind,
    label: event.tool ?? 'Agent check',
    passed,
    summary: boundedText(evidenceText, 2_000),
    createdAt: event.at,
  };
}

function transition(job: GodModeJob, status: GodModeJobStatus, now = Date.now()): GodModeJob {
  if (job.status !== status && !canTransitionJob(job.status, status)) {
    throw new Error(`Job cannot transition from ${job.status} to ${status}.`);
  }
  return {
    ...job,
    status,
    updatedAt: now,
    startedAt: status === 'running' && job.startedAt === null ? now : job.startedAt,
    endedAt: ['completed', 'failed', 'cancelled'].includes(status) ? now : null,
  };
}

export async function createAutonomousJob(
  ownerId: number,
  root: string,
  raw: Omit<CreateAutonomousJobInput, 'root'>,
): Promise<GodModeJob> {
  const goal = boundedText(raw.goal, 20_000);
  if (!goal) throw new Error('Enter an autonomous engineering goal.');
  const maxIterations =
    typeof raw.maxIterations === 'number' && Number.isFinite(raw.maxIterations)
      ? Math.max(1, Math.min(10, Math.floor(raw.maxIterations)))
      : 5;
  return serialize(async () => {
    const store = await readStore();
    const now = Date.now();
    const job: GodModeJob = {
      id: randomUUID(),
      kind: 'autonomous-run',
      root,
      title: goal.split(/\r?\n/)[0]!.slice(0, 160),
      status: 'queued',
      phase: 'understand',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      progress: 0,
      iteration: 0,
      maxIterations,
      ownerWindowId: ownerId,
      resumeRunId: null,
      resumable: true,
      summary: goal,
      error: null,
      evidence: [],
    };
    store.jobs.push(job);
    await writeStore(store);
    return job;
  });
}

export function listGodModeJobs(root: string): Promise<GodModeJob[]> {
  return serialize(async () => {
    const key = rootKey(root);
    return (await readStore()).jobs
      .filter((job) => rootKey(job.root) === key)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function claimAndStartJob(
  ownerId: number,
  root: string,
  id: string,
): Promise<GodModeJob> {
  return serialize(async () => {
    const store = await readStore();
    const index = store.jobs.findIndex(
      (job) => job.id === id && rootKey(job.root) === rootKey(root),
    );
    const job = store.jobs[index];
    if (!job) throw new Error('Autonomous job was not found.');
    if (job.status !== 'queued' && job.status !== 'paused')
      throw new Error('Autonomous job is not startable.');
    if (job.ownerWindowId !== null && job.ownerWindowId !== ownerId) {
      throw new Error('Autonomous job is leased by another window.');
    }
    const next = transition({ ...job, ownerWindowId: ownerId }, 'running');
    store.jobs[index] = next;
    await writeStore(store);
    return next;
  });
}

export async function controlGodModeJob(
  ownerId: number,
  root: string,
  input: JobControlInput,
): Promise<GodModeJob> {
  return serialize(async () => {
    const store = await readStore();
    const index = store.jobs.findIndex(
      (job) => job.id === input.id && rootKey(job.root) === rootKey(root),
    );
    const job = store.jobs[index];
    if (!job) throw new Error('Autonomous job was not found.');
    if (job.ownerWindowId !== null && job.ownerWindowId !== ownerId) {
      throw new Error('Autonomous job is leased by another window.');
    }
    if (input.action === 'resume') {
      if (!job.resumable || !['paused', 'failed', 'cancelled'].includes(job.status)) {
        throw new Error('Autonomous job is not resumable.');
      }
      const now = Date.now();
      const successorId = randomUUID();
      const successor: GodModeJob = {
        ...job,
        id: successorId,
        status: 'queued',
        phase: 'understand',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        endedAt: null,
        progress: 0,
        iteration: 0,
        ownerWindowId: ownerId,
        resumeRunId: job.id,
        resumable: true,
        summary: job.summary.replace(
          /\n\nPaused after application shutdown; resume to continue\.$/,
          '',
        ),
        error: null,
      };
      store.jobs[index] = { ...job, resumable: false, updatedAt: now };
      store.jobs.push(successor);
      await writeStore(store);
      return successor;
    }
    const desired: GodModeJobStatus = input.action === 'pause' ? 'paused' : 'cancelled';
    const next = transition({ ...job, ownerWindowId: ownerId }, desired);
    store.jobs[index] = next;
    await writeStore(store);
    return next;
  });
}

export async function recordGodModeAgentEvent(
  event: AgentStepEvent,
  ownerId: number,
): Promise<void> {
  await serialize(async () => {
    const store = await readStore();
    const index = store.jobs.findIndex(
      (job) => job.id === event.id && rootKey(job.root) === rootKey(event.root),
    );
    const job = store.jobs[index];
    if (!job) return;
    if (job.ownerWindowId !== ownerId) {
      throw new Error('Autonomous job event owner does not match its active lease.');
    }
    const evidence = toEvidence(event);
    const terminalStatus: GodModeJobStatus | null =
      event.outcome === 'completed'
        ? 'completed'
        : event.outcome === 'cancelled'
          ? job.status === 'paused'
            ? 'paused'
            : 'cancelled'
          : event.outcome === 'failed'
            ? 'failed'
            : null;
    let next: GodModeJob = {
      ...job,
      phase: phaseForEvent(event),
      updatedAt: event.at,
      progress:
        terminalStatus === 'completed'
          ? 100
          : event.progress?.completed !== undefined && event.progress.total
            ? Math.max(
                0,
                Math.min(100, Math.round((event.progress.completed / event.progress.total) * 100)),
              )
            : job.progress,
      iteration: Math.max(job.iteration, event.progress?.completed ?? job.iteration),
      summary: event.summary?.outcome ? (event.text ?? job.summary) : job.summary,
      error:
        event.kind === 'error' && event.outcome !== 'cancelled'
          ? boundedText(event.text, 2_000)
          : job.error,
      evidence: evidence ? [...job.evidence, evidence].slice(-MAX_EVIDENCE) : job.evidence,
    };
    if (event.kind === 'approval') next = { ...next, status: 'awaiting-approval' };
    else if (next.status === 'awaiting-approval' && event.kind === 'tool')
      next = { ...next, status: 'running' };
    if (terminalStatus && terminalStatus !== next.status) {
      next = transition(next, terminalStatus, event.at);
    }
    store.jobs[index] = next;
    await writeStore(store);
  });
}

export async function reconcileGodModeAgentTask(task: AgentTask, ownerId: number): Promise<void> {
  await serialize(async () => {
    const store = await readStore();
    const index = store.jobs.findIndex(
      (job) => job.id === task.id && rootKey(job.root) === rootKey(task.root),
    );
    const job = store.jobs[index];
    if (!job) return;
    if (job.ownerWindowId !== ownerId) {
      throw new Error('Autonomous task owner does not match its active job lease.');
    }
    const status: GodModeJobStatus =
      task.status === 'completed'
        ? 'completed'
        : task.status === 'failed'
          ? 'failed'
          : task.status === 'cancelled'
            ? job.status === 'paused'
              ? 'paused'
              : 'cancelled'
            : task.status === 'queued'
              ? 'queued'
              : job.status === 'awaiting-approval'
                ? 'awaiting-approval'
                : 'running';
    store.jobs[index] = {
      ...job,
      ownerWindowId: ownerId,
      status,
      updatedAt: task.endedAt ?? Date.now(),
      startedAt: job.startedAt ?? task.startedAt,
      endedAt: task.endedAt,
      progress: task.status === 'completed' ? 100 : job.progress,
      iteration: Math.max(job.iteration, task.steps),
      error: task.status === 'failed' ? task.lastText : null,
    };
    await writeStore(store);
  });
}

export async function recoverInterruptedGodModeJobs(): Promise<void> {
  await serialize(async () => {
    const store = await readStore();
    let changed = false;
    store.jobs = store.jobs.map((job) => {
      if (!['running', 'awaiting-approval'].includes(job.status)) {
        if (job.ownerWindowId === null) return job;
        changed = true;
        return { ...job, ownerWindowId: null };
      }
      changed = true;
      return {
        ...job,
        status: 'paused',
        ownerWindowId: null,
        updatedAt: Date.now(),
        endedAt: null,
        summary: `${job.summary}\n\nPaused after application shutdown; resume to continue.`,
      };
    });
    if (changed) await writeStore(store);
  });
}
