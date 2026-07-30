/**
 * End-of-line bus. Lets the status bar / command palette convert the focused
 * editor's line endings. Owner pattern (like languageBus) so split-group focus
 * hand-offs are race-free.
 */
export type EolKind = 'LF' | 'CRLF';

type EolSetter = (eol: EolKind) => void;

let setter: EolSetter | null = null;

export function setEolSetter(fn: EolSetter): () => void {
  setter = fn;
  return () => {
    if (setter === fn) setter = null;
  };
}

export function setEditorEol(eol: EolKind): void {
  setter?.(eol);
}
