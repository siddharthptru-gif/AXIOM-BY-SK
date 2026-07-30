/**
 * Git change signal. A lightweight pub/sub the Source Control view pokes after
 * mutations (commit / stage / discard / checkout / init) so the Explorer's git
 * decorations refresh immediately — those operations touch `.git`, not the
 * working tree, so the filesystem watcher does not fire for them.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onGitChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function bumpGitChanged(): void {
  for (const cb of listeners) cb();
}
