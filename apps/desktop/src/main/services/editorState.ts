import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { EditorSessionState, EditorTabState } from '../../common/ipc';

/**
 * Per-workspace editor session persistence (Main process, PRD Part VII §111 hot
 * exit). A single JSON object in userData/editor-state.json maps each workspace
 * root to its open tabs + active tab. On read we validate that each file still
 * exists (dropping deleted ones) so reopening a folder never resurrects dead
 * tabs. Atomic write (temp + rename).
 */
type EditorStateFile = Record<string, EditorSessionState>;

function statePath(): string {
  return join(app.getPath('userData'), 'editor-state.json');
}

function isTab(value: unknown): value is EditorTabState {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.path === 'string' && typeof o.name === 'string';
}

function toSession(value: unknown): EditorSessionState {
  if (!value || typeof value !== 'object') return { tabs: [], active: null };
  const o = value as Record<string, unknown>;
  const tabs = Array.isArray(o.tabs)
    ? o.tabs.filter(isTab).map((t) => ({ path: t.path, name: t.name }))
    : [];
  const active = typeof o.active === 'string' ? o.active : null;
  return { tabs, active };
}

async function readAll(): Promise<EditorStateFile> {
  try {
    const raw = await fs.readFile(statePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: EditorStateFile = {};
    for (const [root, session] of Object.entries(parsed as Record<string, unknown>)) {
      out[root] = toSession(session);
    }
    return out;
  } catch {
    return {};
  }
}

async function writeAll(data: EditorStateFile): Promise<void> {
  const path = statePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-editors-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Restore a workspace's session, keeping only tabs whose files still exist. */
export async function readEditorState(root: string): Promise<EditorSessionState> {
  const all = await readAll();
  const stored = all[root];
  if (!stored) return { tabs: [], active: null };

  const tabs: EditorTabState[] = [];
  for (const tab of stored.tabs) {
    try {
      const info = await fs.stat(tab.path);
      if (info.isFile()) tabs.push(tab);
    } catch {
      // File was deleted or moved since last session — drop it.
    }
  }

  let active = stored.active;
  if (!active || !tabs.some((t) => t.path === active)) {
    active = tabs.length > 0 ? (tabs[tabs.length - 1]?.path ?? null) : null;
  }
  return { tabs, active };
}

/** Persist a workspace's session. An empty session removes the entry entirely. */
export async function writeEditorState(root: string, state: EditorSessionState): Promise<void> {
  const session = toSession(state);
  const all = await readAll();
  if (session.tabs.length === 0) delete all[root];
  else all[root] = session;
  await writeAll(all);
}
