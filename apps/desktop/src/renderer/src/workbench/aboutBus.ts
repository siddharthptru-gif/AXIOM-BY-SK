/**
 * About/Legal opener bus (owner/subscribe pattern, like the other renderer buses).
 * A command-palette entry calls `openAbout()`; the mounted `AboutView` subscribes and
 * shows the modal. Keeps `AboutView` self-contained without threading state through App.
 */
type Listener = () => void;

let listener: Listener | null = null;

/** AboutView subscribes on mount. */
export function onAboutOpen(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Command entry point: open the About & Legal modal (no-op if not mounted yet). */
export function openAbout(): void {
  listener?.();
}
