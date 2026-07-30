import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RecentFolder } from '../../common/ipc';
import {
  assertAuthorizedWorkspaceRoot,
  resolveWorkspaceRootIdentity,
  samePath,
} from './pathAuthorization';

/**
 * Recently opened folders (Main process, PRD Part VI §85). The persisted list is
 * Main-owned reopening provenance; renderer input can only add an already
 * authorized native-picker result and cannot establish a new capability.
 */
const MAX_RECENTS = 12;

function recentsPath(): string {
  return join(app.getPath('userData'), 'recent-folders.json');
}

function isRecent(value: unknown): value is RecentFolder {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.path === 'string' && typeof o.name === 'string' && typeof o.lastOpened === 'number'
  );
}

async function read(): Promise<RecentFolder[]> {
  try {
    const raw = await fs.readFile(recentsPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecent) : [];
  } catch {
    return [];
  }
}

async function write(list: RecentFolder[]): Promise<void> {
  const path = recentsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(list, null, 2), 'utf-8');
}

export function getRecents(): Promise<RecentFolder[]> {
  return read();
}

/** Resolve a recent's originally approved canonical identity without granting it. */
export async function knownRecentIdentity(path: string): Promise<string | null> {
  try {
    const currentIdentity = await resolveWorkspaceRootIdentity(path);
    const recent = (await read()).find((entry) => samePath(entry.path, currentIdentity));
    return recent?.path ?? null;
  } catch {
    return null;
  }
}

export async function addRecent(path: string, _name: string): Promise<RecentFolder[]> {
  const canonical = await assertAuthorizedWorkspaceRoot(path);
  const list = await read();
  const next = [
    { path: canonical, name: basename(canonical) || canonical, lastOpened: Date.now() },
    ...list.filter((recent) => !samePath(recent.path, canonical)),
  ].slice(0, MAX_RECENTS);
  await write(next);
  return next;
}

export async function removeRecent(path: string): Promise<RecentFolder[]> {
  const next = (await read()).filter((recent) => !samePath(recent.path, path));
  await write(next);
  return next;
}

export async function clearRecents(): Promise<RecentFolder[]> {
  await write([]);
  return [];
}
