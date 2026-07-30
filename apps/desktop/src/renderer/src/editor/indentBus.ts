/**
 * Indentation bus (PRD Part IX §160). Lets the status bar / command palette
 * change the focused editor's indentation — spaces vs tabs, tab size, converting
 * existing indentation, or re-detecting it from content. Owner pattern (like the
 * EOL and language buses) so split-group focus hand-offs are race-free. Changes
 * apply to the active model's options (per-editor, transient), matching how VS
 * Code's status-bar indentation control behaves.
 */
/** The active model's current indentation, reported to the status bar. */
export interface IndentInfo {
  tabSize: number;
  insertSpaces: boolean;
}

export interface IndentActions {
  setInsertSpaces: (insertSpaces: boolean) => void;
  setTabSize: (tabSize: number) => void;
  convertToSpaces: () => void;
  convertToTabs: () => void;
  detect: () => void;
}

let current: IndentActions | null = null;

export function setIndentActions(actions: IndentActions): () => void {
  current = actions;
  return () => {
    if (current === actions) current = null;
  };
}

export function indentSetInsertSpaces(insertSpaces: boolean): void {
  current?.setInsertSpaces(insertSpaces);
}
export function indentSetTabSize(tabSize: number): void {
  current?.setTabSize(tabSize);
}
export function indentConvertToSpaces(): void {
  current?.convertToSpaces();
}
export function indentConvertToTabs(): void {
  current?.convertToTabs();
}
export function indentDetect(): void {
  current?.detect();
}
