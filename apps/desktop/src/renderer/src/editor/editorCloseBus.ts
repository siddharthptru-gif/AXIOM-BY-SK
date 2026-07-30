/**
 * Editor close-actions bus. The mounted EditorArea registers handlers that route
 * through its dirty-aware close flow (the same queued Save/Don't Save/Cancel used
 * by the tab menu), so the command palette and the tab context menu share one
 * implementation. Relative actions (others / to the right) use the active editor
 * as the reference. All are no-ops when no editors are open.
 */
export interface EditorCloseActions {
  closeActive: () => void;
  closeOthers: () => void;
  closeToRight: () => void;
  closeSaved: () => void;
  /** Close all editors in the focused group. */
  closeAll: () => void;
  /** Close every editor in every group. */
  closeAllGroups: () => void;
  /** Close a specific editor by path (dirty-aware), regardless of focus. */
  closePath: (path: string) => void;
}

let actions: EditorCloseActions | null = null;

export function setEditorCloseActions(next: EditorCloseActions | null): void {
  actions = next;
}

export function editorCloseActive(): void {
  actions?.closeActive();
}
export function editorCloseOthers(): void {
  actions?.closeOthers();
}
export function editorCloseToRight(): void {
  actions?.closeToRight();
}
export function editorCloseSaved(): void {
  actions?.closeSaved();
}
export function editorCloseAll(): void {
  actions?.closeAll();
}
export function editorCloseAllGroups(): void {
  actions?.closeAllGroups();
}
export function editorClosePath(path: string): void {
  actions?.closePath(path);
}
