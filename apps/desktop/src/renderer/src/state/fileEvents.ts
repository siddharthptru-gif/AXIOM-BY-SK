/**
 * File-save event bus. A tiny decoupled signal emitted by the editor after a
 * successful save, so interested stores (e.g., settings) can react to on-disk
 * edits without coupling to the editor. Mirrors the notifications-bus pattern.
 */
type Listener = (path: string) => void;

const listeners = new Set<Listener>();

export function onFileSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitFileSaved(path: string): void {
  for (const listener of listeners) listener(path);
}
