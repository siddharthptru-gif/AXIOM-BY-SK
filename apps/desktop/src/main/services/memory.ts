import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MemoryEntry, MemoryScope, MemorySelection } from '../../common/ipc';
import { buildMemoryBlock, selectMemories } from '../../common/memory';

/**
 * Long-term memory store (Main, PRD Epoch F §70). Persists user-curated memory
 * entries locally (JSON in the app-data dir; INV-4 — never uploaded). Provides
 * CRUD for the memory panel and a relevance selection for chat grounding. Entries
 * are size- and count-capped; workspace-scoped entries are keyed by the local
 * root path.
 */
const MAX_ENTRIES = 500;
const MAX_TEXT = 2000;

function memoryPath(): string {
  return join(app.getPath('userData'), 'memory.json');
}

function isEntry(v: unknown): v is MemoryEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.scope === 'global' || o.scope === 'workspace') &&
    (o.workspaceKey === null || typeof o.workspaceKey === 'string') &&
    typeof o.text === 'string' &&
    typeof o.pinned === 'boolean' &&
    typeof o.createdAt === 'number' &&
    typeof o.updatedAt === 'number'
  );
}

async function read(): Promise<MemoryEntry[]> {
  try {
    const raw = await fs.readFile(memoryPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

async function write(list: MemoryEntry[]): Promise<void> {
  const path = memoryPath();
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.axiom-memory-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Sort for display: pinned first, then most-recently-updated. */
function sorted(list: MemoryEntry[]): MemoryEntry[] {
  return [...list].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt,
  );
}

export async function listMemories(): Promise<MemoryEntry[]> {
  return sorted(await read());
}

export async function addMemory(
  text: string,
  scope: MemoryScope,
  workspaceKey: string | null,
): Promise<MemoryEntry[]> {
  const clean = text.trim().slice(0, MAX_TEXT);
  const list = await read();
  if (clean.length > 0) {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope,
      workspaceKey: scope === 'workspace' ? workspaceKey : null,
      text: clean,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    list.push(entry);
    // Cap total entries, evicting the oldest unpinned first.
    if (list.length > MAX_ENTRIES) {
      const byAge = [...list].sort((a, b) => a.updatedAt - b.updatedAt);
      const victim = byAge.find((e) => !e.pinned) ?? byAge[0];
      if (victim) list.splice(list.indexOf(victim), 1);
    }
    await write(list);
  }
  return sorted(list);
}

export async function updateMemory(
  id: string,
  patch: { text?: string; pinned?: boolean },
): Promise<MemoryEntry[]> {
  const list = await read();
  const entry = list.find((e) => e.id === id);
  if (entry) {
    if (typeof patch.text === 'string') entry.text = patch.text.trim().slice(0, MAX_TEXT);
    if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned;
    entry.updatedAt = Date.now();
    await write(list);
  }
  return sorted(list);
}

export async function deleteMemory(id: string): Promise<MemoryEntry[]> {
  const next = (await read()).filter((e) => e.id !== id);
  await write(next);
  return sorted(next);
}

export async function clearMemories(): Promise<MemoryEntry[]> {
  await write([]);
  return [];
}

/** Select memories relevant to a query for chat grounding (global + workspace). */
export async function selectRelevant(
  query: string,
  workspaceKey: string | null,
): Promise<MemorySelection> {
  const all = await read();
  const scoped = all.filter(
    (e) => e.scope === 'global' || (workspaceKey !== null && e.workspaceKey === workspaceKey),
  );
  const chosen = selectMemories(scoped, query);
  return { text: buildMemoryBlock(chosen), count: chosen.length };
}
