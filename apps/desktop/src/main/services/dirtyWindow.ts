import { BrowserWindow, dialog } from 'electron';
import { DirtyWorkspaceRegistry, type DirtyWorkspaceTransition } from '../../common/dirtyWorkspace';

const dirtyWorkspaces = new DirtyWorkspaceRegistry();
const confirmedClose = new WeakSet<BrowserWindow>();

export function setWindowDirty(
  ownerId: number,
  root: string | null,
  dirty: boolean,
): DirtyWorkspaceTransition {
  return dirtyWorkspaces.set(ownerId, root, dirty);
}

export function reconcileWindowDirty(
  ownerId: number,
  generation: number,
  canonicalRoot: string | null,
): DirtyWorkspaceTransition | null {
  return dirtyWorkspaces.reconcile(ownerId, generation, canonicalRoot);
}

/** Authoritative owner/root query used at every Agent mutation precommit boundary. */
export function assertWorkspaceClean(ownerId: number, root: string): void {
  dirtyWorkspaces.assertClean(ownerId, root);
}

export function isWorkspaceDirty(ownerId: number, root: string): boolean {
  return dirtyWorkspaces.isDirty(ownerId, root);
}

/** Main-authoritative close guard so window/app exit cannot silently lose edits. */
export function attachDirtyCloseGuard(win: BrowserWindow): void {
  const ownerId = win.webContents.id;
  win.on('close', (event) => {
    if (confirmedClose.has(win) || !dirtyWorkspaces.hasDirty(ownerId)) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail:
        'Cancel to return to Axiom and save them, or discard the changes and close the window.',
      buttons: ['Cancel', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice !== 1) return;
    confirmedClose.add(win);
    dirtyWorkspaces.clear(ownerId);
    win.close();
  });
  win.webContents.once('destroyed', () => dirtyWorkspaces.clear(ownerId));
}
