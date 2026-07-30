/**
 * Language bus. Lets the status bar / command palette change the active editor's
 * language mode without holding a Monaco reference. With split groups, only the
 * focused pane registers; the disposer clears the setter only if still the owner,
 * so focus hand-offs between panes are race-free.
 */
type LanguageSetter = (languageId: string) => void;

let setter: LanguageSetter | null = null;

export function setLanguageSetter(fn: LanguageSetter): () => void {
  setter = fn;
  return () => {
    if (setter === fn) setter = null;
  };
}

export function setEditorLanguage(languageId: string): void {
  setter?.(languageId);
}
