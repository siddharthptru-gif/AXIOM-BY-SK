import { app } from 'electron';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  newJournal,
  markPhase as markPhasePure,
  markCleanExit,
  parseJournal,
  buildRecoveryNotice,
  type JournalState,
  type RecoveryNotice,
} from '../../common/crashJournal';
import { planRecovery, type StoreSignal } from '../../common/recovery';

/**
 * Crash-recovery journal (Main, PRD Epoch A / Part VI §88.6). On startup it reads
 * the previous session's journal: if it exists and was never marked clean, the app
 * crashed/was killed, and we surface a recovery notice. Disk-backed tab metadata may
 * restore, but unsaved editor contents are explicitly not persisted. Then it starts a fresh journal (cleanExit=false), records phase
 * breadcrumbs, and marks a clean exit on before-quit. Writes are SYNCHRONOUS + atomic
 * so a mark survives an imminent quit. The state machine is the pure `crashJournal`.
 */
let current: JournalState | null = null;
let notice: RecoveryNotice = { unclean: false, summary: '' };

function filePath(): string {
  return join(app.getPath('userData'), 'crash-journal.json');
}

function writeSync(j: JournalState): void {
  try {
    const path = filePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.axiom-crash-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(j), 'utf-8');
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    /* journal is best-effort — never block the app */
  }
}

/** Read the prior journal, compute the recovery notice, and begin a new session journal. */
export function initCrashJournal(): RecoveryNotice {
  let prev: JournalState | null = null;
  try {
    prev = parseJournal(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    prev = null;
  }
  notice = buildRecoveryNotice(prev);
  // Startup recovery plan (Phase 277): fold store-integrity + consecutive-crash +
  // interrupted-run signals into a richer notice (safe mode / recovered stores).
  try {
    const crashCount = bumpCrashCount(notice.unclean);
    const plan = planRecovery({
      uncleanExits: crashCount,
      stores: gatherStoreSignals(),
      backups: {},
      interruptedAgentRuns: countInterruptedRuns(),
    });
    const informative =
      plan.safeMode ||
      plan.rollbackUpdate ||
      plan.resumableAgentRuns > 0 ||
      plan.stores.some((s) => s.action !== 'keep');
    if (informative) {
      notice = { unclean: notice.unclean || plan.safeMode, summary: plan.summary };
    }
  } catch {
    /* recovery planning is best-effort — never block startup */
  }
  current = newJournal(Date.now(), app.getVersion());
  writeSync(current);
  return notice;
}

/** Record a phase breadcrumb (persisted synchronously). */
export function recordPhase(phase: string): void {
  if (!current) return;
  current = markPhasePure(current, phase, Date.now());
  writeSync(current);
}

/** Mark this session as exited cleanly (call on before-quit). */
export function markClean(): void {
  if (!current) return;
  current = markCleanExit(current);
  writeSync(current);
}

/** The recovery notice computed at startup (for the renderer's startup toast). */
export function getRecoveryNotice(): RecoveryNotice {
  return notice;
}

// --- Startup recovery plan (PRD Phase 277) ----------------------------------

/** userData JSON stores whose integrity we check at startup. */
const CHECKED_STORES: ReadonlyArray<{ file: string; name: string; critical: boolean }> = [
  { file: 'settings.json', name: 'settings', critical: true },
  { file: 'telemetry-buffer.json', name: 'telemetry buffer', critical: false },
  { file: 'agent-runs.json', name: 'agent runs', critical: false },
  { file: 'memory.json', name: 'memory', critical: false },
];

/** Classify a userData JSON file: ok (parses), corrupt (unparseable), missing. */
function storeStatus(file: string): StoreSignal['status'] {
  let raw: string;
  try {
    raw = readFileSync(join(app.getPath('userData'), file), 'utf-8');
  } catch {
    return 'missing';
  }
  try {
    JSON.parse(raw);
    return 'ok';
  } catch {
    return 'corrupt';
  }
}

function gatherStoreSignals(): StoreSignal[] {
  return CHECKED_STORES.map((s) => ({
    name: s.name,
    status: storeStatus(s.file),
    critical: s.critical,
  }));
}

/** Count agent runs the previous session left mid-flight (non-terminal status). */
function countInterruptedRuns(): number {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'agent-runs.json'), 'utf-8');
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    return arr.filter((r) => {
      const status = (r as { status?: unknown }).status;
      return status === 'running' || status === 'awaiting-approval' || status === 'queued';
    }).length;
  } catch {
    return 0;
  }
}

function crashCountPath(): string {
  return join(app.getPath('userData'), 'recovery-crashes.json');
}

/**
 * Track consecutive unclean exits: increment when the prior session was unclean,
 * reset to 0 on a clean prior session. Persisted synchronously (best-effort).
 */
function bumpCrashCount(prevUnclean: boolean): number {
  let prev = 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(crashCountPath(), 'utf-8'));
    const c = (parsed as { count?: unknown }).count;
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) prev = Math.floor(c);
  } catch {
    prev = 0;
  }
  const next = prevUnclean ? prev + 1 : 0;
  try {
    const path = crashCountPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.axiom-rc-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ count: next }), 'utf-8');
    try {
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    /* best-effort */
  }
  return next;
}
