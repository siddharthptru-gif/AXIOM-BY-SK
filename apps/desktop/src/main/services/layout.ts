import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LayoutState } from '../../common/ipc';

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 560;
const MIN_AI = 320;
const MAX_AI = 760;
const VIEWS = new Set(['explorer', 'search', 'scm', 'run', 'intelligence']);
let layoutQueue: Promise<void> = Promise.resolve();

function serializeLayout<T>(operation: () => Promise<T>): Promise<T> {
  const result = layoutQueue.then(operation, operation);
  layoutQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function layoutPath(): string {
  return join(app.getPath('userData'), 'layout.json');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Restore valid fields only; the renderer merges them over current defaults. */
export function readLayout(): Promise<Partial<LayoutState>> {
  return serializeLayout(async () => {
    let raw: string;
    try {
      raw = await fs.readFile(layoutPath(), 'utf-8');
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error('Layout file contains invalid JSON.', { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Layout file must contain a JSON object.');
    }
    const source = parsed as Record<string, unknown>;
    const out: Partial<LayoutState> = {};
    if (source.version === 1) out.version = 1;
    if (typeof source.activeView === 'string' && VIEWS.has(source.activeView)) {
      out.activeView = source.activeView;
    }
    if (typeof source.sidebarVisible === 'boolean') out.sidebarVisible = source.sidebarVisible;
    if (typeof source.sidebarWidth === 'number' && Number.isFinite(source.sidebarWidth)) {
      out.sidebarWidth = clamp(source.sidebarWidth, MIN_SIDEBAR, MAX_SIDEBAR);
    }
    if (typeof source.aiPanelVisible === 'boolean') out.aiPanelVisible = source.aiPanelVisible;
    if (typeof source.aiPanelWidth === 'number' && Number.isFinite(source.aiPanelWidth)) {
      out.aiPanelWidth = clamp(source.aiPanelWidth, MIN_AI, MAX_AI);
    }
    if (typeof source.activityBarVisible === 'boolean') {
      out.activityBarVisible = source.activityBarVisible;
    }
    if (typeof source.statusBarVisible === 'boolean') {
      out.statusBarVisible = source.statusBarVisible;
    }
    if (typeof source.centeredLayout === 'boolean') out.centeredLayout = source.centeredLayout;
    return out;
  });
}

/** Persist a defensive, versioned workbench-layout snapshot atomically. */
export function writeLayout(state: LayoutState): Promise<void> {
  const source = (state ?? {}) as Partial<LayoutState>;
  const sanitized: LayoutState = {
    version: 1,
    activeView:
      typeof source.activeView === 'string' && VIEWS.has(source.activeView)
        ? source.activeView
        : 'explorer',
    sidebarVisible: typeof source.sidebarVisible === 'boolean' ? source.sidebarVisible : true,
    sidebarWidth:
      typeof source.sidebarWidth === 'number' && Number.isFinite(source.sidebarWidth)
        ? clamp(source.sidebarWidth, MIN_SIDEBAR, MAX_SIDEBAR)
        : 280,
    aiPanelVisible: typeof source.aiPanelVisible === 'boolean' ? source.aiPanelVisible : true,
    aiPanelWidth:
      typeof source.aiPanelWidth === 'number' && Number.isFinite(source.aiPanelWidth)
        ? clamp(source.aiPanelWidth, MIN_AI, MAX_AI)
        : 420,
    activityBarVisible:
      typeof source.activityBarVisible === 'boolean' ? source.activityBarVisible : true,
    statusBarVisible: typeof source.statusBarVisible === 'boolean' ? source.statusBarVisible : true,
    centeredLayout: typeof source.centeredLayout === 'boolean' ? source.centeredLayout : false,
  };

  return serializeLayout(async () => {
    const path = layoutPath();
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.axiom-layout-${randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(sanitized, null, 2), 'utf-8');
    try {
      await fs.rename(tmp, path);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  });
}
