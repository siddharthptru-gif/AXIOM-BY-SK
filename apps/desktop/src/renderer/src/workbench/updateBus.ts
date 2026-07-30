/**
 * Update-dialog opener bus (owner/subscribe pattern, like aboutBus). The
 * "Check for Updates" command calls `openUpdate()`; the mounted `UpdateView`
 * subscribes and shows the dialog (and triggers a fresh check).
 */
type Listener = () => void;

let listener: Listener | null = null;

/** UpdateView subscribes on mount. */
export function onUpdateOpen(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Command entry point: open the update dialog (no-op if not mounted yet). */
export function openUpdate(): void {
  listener?.();
}
