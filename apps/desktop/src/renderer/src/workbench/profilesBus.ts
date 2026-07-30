/**
 * Keymap-profiles opener bus (owner/subscribe pattern, like aboutBus/updateBus).
 * The "Manage Keymap Profiles" command calls `openProfiles()`; the mounted
 * `ProfilesView` subscribes and shows the manager modal.
 */
type Listener = () => void;

let listener: Listener | null = null;

export function onProfilesOpen(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

export function openProfiles(): void {
  listener?.();
}
