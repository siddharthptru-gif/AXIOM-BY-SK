import { watch, type FSWatcher } from 'node:fs';
import { rootLogger } from '@axiom/shared';

/**
 * Workspace file watcher (Main process). PRD Part VII §104: the explorer reflects
 * on-disk changes without a manual refresh. This is a coarse watcher — it emits a
 * single debounced "something changed under root" signal and lets the renderer
 * re-read the directories it currently has expanded. A precise per-path diff is a
 * later refinement (Part III/Rust Core).
 */
const log = rootLogger.child('watcher');

const DEBOUNCE_MS = 200;

let active: FSWatcher | null = null;
let activeRoot: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Kept separate from the watcher so a renderer reload can refresh the target
// (new webContents) without tearing down and recreating the OS watch.
let notify: ((root: string) => void) | null = null;
let activeToken: symbol | null = null;

export function stopWatching(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (active) {
    active.close();
    active = null;
    activeRoot = null;
  }
  notify = null;
  activeToken = null;
}

/**
 * Starts (or restarts) watching `rootPath` recursively. Fires `onChange` at most
 * once per debounce window. Returns silently if the platform/path cannot be
 * watched — watching is a convenience, never a hard dependency.
 */
export function startWatching(rootPath: string, onChange: (root: string) => void): () => void {
  const token = Symbol('watch-owner');
  activeToken = token;
  // Always refresh the notify target (handles renderer reloads for the same root).
  notify = onChange;
  if (activeRoot !== rootPath || !active) {
    stopWatching();
    activeToken = token;
    notify = onChange;

    try {
      active = watch(rootPath, { recursive: true }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          notify?.(rootPath);
        }, DEBOUNCE_MS);
      });
      activeRoot = rootPath;
      active.on('error', (err) => {
        log.warn('watch error; disabling watcher', { error: String(err) });
        stopWatching();
      });
      log.info('watching workspace', { root: rootPath });
    } catch (error) {
      log.warn('could not start watcher', { root: rootPath, error: String(error) });
      active = null;
      activeRoot = null;
    }
  }
  return () => {
    if (activeToken === token) stopWatching();
  };
}
