import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuditEvent, AuditVerifyResult } from '../../common/ipc';

/**
 * Local hash-chained audit log (PRD Part IV §56 / Part X §187). An append-only,
 * tamper-evident record of security/trust events (agent actions + approvals,
 * provider/secret config changes, sign-in/out). Each entry chains a SHA-256 of
 * the previous entry's hash, so any deletion or alteration is detectable by
 * recomputing the chain. Stored locally as JSON-lines in the app-data dir; it
 * NEVER contains secrets or code — edits are referenced by summary only. This is
 * the authoritative log; an optional cloud mirror is out of scope here.
 */
const GENESIS = '0'.repeat(64);
const MAX_READ = 500;
const MAX_SUMMARY = 500;

function auditPath(): string {
  return join(app.getPath('userData'), 'audit-log.jsonl');
}

/** Deterministic hash chaining the previous hash + this entry's fields. */
export function auditEntryHash(
  prevHash: string,
  seq: number,
  ts: number,
  type: string,
  summary: string,
): string {
  return createHash('sha256')
    .update(`${prevHash}\n${seq}\n${ts}\n${type}\n${summary}`)
    .digest('hex');
}

function parseLine(line: string): AuditEvent | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof o.seq === 'number' &&
      typeof o.ts === 'number' &&
      typeof o.type === 'string' &&
      typeof o.summary === 'string' &&
      typeof o.prevHash === 'string' &&
      typeof o.hash === 'string'
    ) {
      return {
        seq: o.seq,
        ts: o.ts,
        type: o.type,
        summary: o.summary,
        prevHash: o.prevHash,
        hash: o.hash,
      };
    }
  } catch {
    /* skip malformed line */
  }
  return null;
}

async function readAll(): Promise<AuditEvent[]> {
  try {
    const raw = await fs.readFile(auditPath(), 'utf-8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(parseLine)
      .filter((e): e is AuditEvent => e !== null);
  } catch {
    return [];
  }
}

// In-memory chain tip (avoids re-reading the whole file per append) + an append
// queue so concurrent callers can't race the tip.
let tip: { seq: number; hash: string } | null = null;
let tipLoaded = false;
let queue: Promise<void> = Promise.resolve();

async function loadTip(): Promise<{ seq: number; hash: string }> {
  if (!tipLoaded) {
    const all = await readAll();
    const last = all.length > 0 ? all[all.length - 1]! : null;
    tip = last ? { seq: last.seq, hash: last.hash } : null;
    tipLoaded = true;
  }
  return tip ?? { seq: 0, hash: GENESIS };
}

/** Append a tamper-evident audit entry (never secrets/code). Best-effort. */
export function appendAudit(type: string, summary: string): Promise<void> {
  const run = queue.then(async () => {
    const t = await loadTip();
    const seq = t.seq + 1;
    const prevHash = t.hash;
    const ts = Date.now();
    const clean = summary.slice(0, MAX_SUMMARY);
    const hash = auditEntryHash(prevHash, seq, ts, type, clean);
    const entry: AuditEvent = { seq, ts, type, summary: clean, prevHash, hash };
    const path = auditPath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, `${JSON.stringify(entry)}\n`, 'utf-8');
    tip = { seq, hash };
    tipLoaded = true;
  });
  // Keep the queue alive even if one append fails; callers don't await success.
  queue = run.catch(() => undefined);
  return queue;
}

/** Read recent audit entries (most recent last), capped for display. */
export async function readAudit(limit = MAX_READ): Promise<AuditEvent[]> {
  const all = await readAll();
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_READ) : MAX_READ;
  return all.slice(-n);
}

/** Verify chain integrity: every entry's hash recomputes and links to the prior. */
export async function verifyAudit(): Promise<AuditVerifyResult> {
  const all = await readAll();
  let prevHash = GENESIS;
  for (const e of all) {
    const expected = auditEntryHash(prevHash, e.seq, e.ts, e.type, e.summary);
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { ok: false, count: all.length, brokenAt: e.seq };
    }
    prevHash = e.hash;
  }
  return { ok: true, count: all.length, brokenAt: null };
}
