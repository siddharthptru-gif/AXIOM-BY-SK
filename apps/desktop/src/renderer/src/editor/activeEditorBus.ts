/**
 * Active-editor bus (PRD Part VII §105). With split groups there are multiple
 * editor panes but the workbench commands (Save, Format, Go to Symbol, Revert)
 * target the focused one. The focused pane registers its actions here; the
 * disposer clears them only if still the owner, so focus hand-offs are race-free.
 * Commands are registered once (in App) and delegate through these invokers.
 */
export interface ActiveEditorActions {
  save: () => void;
  saveAs: () => void;
  saveCopyAs: () => void;
  format: () => void;
  goToSymbol: () => void;
  revert: () => void;
  /** Execute a Monaco command against the focused editor. */
  runAction: (id: string) => void;
  /** Insert text at the cursor (replacing any selection). */
  insertText: (text: string) => void;
  /** Current selection (empty when nothing is selected), for `@selection`. */
  getSelection: () => EditorSelectionSnapshot | null;
}

/** What the focused editor currently has selected. */
export interface EditorSelectionSnapshot {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  text: string;
}

let current: ActiveEditorActions | null = null;

export function setActiveEditor(actions: ActiveEditorActions): () => void {
  current = actions;
  return () => {
    if (current === actions) current = null;
  };
}

export function activeSave(): void {
  current?.save();
}
export function activeSaveAs(): void {
  current?.saveAs();
}
export function activeSaveCopyAs(): void {
  current?.saveCopyAs();
}
export function activeFormat(): void {
  current?.format();
}
export function activeGoToSymbol(): void {
  current?.goToSymbol();
}
export function activeRevert(): void {
  current?.revert();
}
/** Execute a Monaco command against the focused editor. */
export function activeRunEditorAction(id: string): boolean {
  if (!current) return false;
  current.runAction(id);
  return true;
}
/** Insert text into the active editor. Returns false when no editor is active. */
export function activeInsertText(text: string): boolean {
  if (!current) return false;
  current.insertText(text);
  return true;
}
/** The focused editor's selection, or null when there is no editor / no selection. */
export function activeSelection(): EditorSelectionSnapshot | null {
  return current?.getSelection() ?? null;
}

/**
 * Live cursor position of the focused editor.
 *
 * The status bar receives the cursor through a prop chain, but the symbol
 * breadcrumb needs it too, and threading it through the workbench tree would
 * couple unrelated components. This is the same owner/listener pattern as the
 * rest of the bus: the focused pane publishes, interested views subscribe.
 */
export interface CursorPosition {
  line: number;
  column: number;
}

let cursor: CursorPosition = { line: 1, column: 1 };
const cursorListeners = new Set<(position: CursorPosition) => void>();

/** Subscribe to the focused editor's cursor. Returns an unsubscribe fn. */
export function subscribeActiveCursor(listener: (position: CursorPosition) => void): () => void {
  cursorListeners.add(listener);
  listener(cursor);
  return () => {
    cursorListeners.delete(listener);
  };
}

/** Published by the focused editor pane on every cursor move. */
export function setActiveCursor(line: number, column: number): void {
  if (cursor.line === line && cursor.column === column) return;
  cursor = { line, column };
  for (const listener of cursorListeners) listener(cursor);
}
