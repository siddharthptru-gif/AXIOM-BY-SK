import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SpendEntry, SpendSummary } from '../../common/ipc';

/**
 * AI spend ledger (Main process, PRD Phases 152/197). Appends one entry per
 * completed chat turn to userData/ai-spend.json and rolls it up into session /
 * today / all-time totals for the status bar + dashboard. Writes are atomic
 * (temp + rename); reads are sanitized. Estimates only — BYOK is billed by the
 * provider. Entirely local (INV-4).
 */
const MAX_ENTRIES = 5000;
const sessionStart = Date.now();

let cache: SpendEntry[] | null = null;

function filePath(): string {
  return join(app.getPath('userData'), 'ai-spend.json');
}

function sanitizeEntry(value: unknown): SpendEntry | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null;
  return {
    ts: o.ts,
    provider: typeof o.provider === 'string' ? o.provider : 'unknown',
    model: typeof o.model === 'string' ? o.model : 'unknown',
    inputTokens: typeof o.inputTokens === 'number' ? o.inputTokens : 0,
    outputTokens: typeof o.outputTokens === 'number' ? o.outputTokens : 0,
    costUsd: typeof o.costUsd === 'number' ? o.costUsd : null,
  };
}

async function load(): Promise<SpendEntry[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(filePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const out: SpendEntry[] = [];
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        const s = sanitizeEntry(e);
        if (s) out.push(s);
      }
    }
    cache = out;
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(entries: readonly SpendEntry[]): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-aispend-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(entries), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Roll entries up into session / today / all-time totals (pure — unit-tested). */
export function summarize(
  entries: readonly SpendEntry[],
  now: number,
  sessionStartTs: number,
): SpendSummary {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayMs = start.getTime();

  let sessionUsd = 0;
  let todayUsd = 0;
  let totalUsd = 0;
  let todayTokens = 0;
  let totalTokens = 0;
  const byModel = new Map<string, number>();

  for (const e of entries) {
    const cost = e.costUsd ?? 0;
    const tokens = e.inputTokens + e.outputTokens;
    totalUsd += cost;
    totalTokens += tokens;
    if (e.ts >= todayMs) {
      todayUsd += cost;
      todayTokens += tokens;
    }
    if (e.ts >= sessionStartTs) sessionUsd += cost;
    byModel.set(e.model, (byModel.get(e.model) ?? 0) + cost);
  }

  const topModels = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([model, usd]) => ({ model, usd }));

  return {
    sessionUsd,
    todayUsd,
    totalUsd,
    todayTokens,
    totalTokens,
    count: entries.length,
    topModels,
  };
}

/** Record a completed turn and return the updated summary. */
export async function recordSpend(entry: Omit<SpendEntry, 'ts'>): Promise<SpendSummary> {
  const entries = await load();
  entries.push({ ts: Date.now(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  void persist(entries).catch(() => undefined);
  return summarize(entries, Date.now(), sessionStart);
}

/** Current spend summary. */
export async function getSpendSummary(): Promise<SpendSummary> {
  const entries = await load();
  return summarize(entries, Date.now(), sessionStart);
}

/** Clear the entire ledger and return the (empty) summary. */
export async function clearSpend(): Promise<SpendSummary> {
  cache = [];
  void persist([]).catch(() => undefined);
  return summarize([], Date.now(), sessionStart);
}
