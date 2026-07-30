import type { VimMode } from '../../../common/vim';

/**
 * Vim status bus (PRD Phase 249). Broadcasts the focused editor's current Vim mode
 * (or null when the Vim keymap is off) so a status-bar item can render it. A simple
 * value pub/sub — the editor pushes, the status item subscribes.
 */
export type VimStatus = VimMode | null;

let current: VimStatus = null;
const listeners = new Set<(status: VimStatus) => void>();

export function setVimStatus(status: VimStatus): void {
  if (current === status) return;
  current = status;
  for (const listener of listeners) listener(status);
}

export function getVimStatus(): VimStatus {
  return current;
}

export function subscribeVimStatus(fn: (status: VimStatus) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}
