/**
 * Process-local renderer dialog ordering. Every modal surface registers here so
 * Escape and Tab are handled only by the visually top-most dialog.
 */
let nextDialogId = 0;
const dialogStack: number[] = [];

export function createDialogId(): number {
  nextDialogId += 1;
  return nextDialogId;
}

export function registerDialog(id: number): () => void {
  const existing = dialogStack.lastIndexOf(id);
  if (existing >= 0) dialogStack.splice(existing, 1);
  dialogStack.push(id);
  return () => {
    const index = dialogStack.lastIndexOf(id);
    if (index >= 0) dialogStack.splice(index, 1);
  };
}

export function isTopDialog(id: number): boolean {
  return dialogStack[dialogStack.length - 1] === id;
}
