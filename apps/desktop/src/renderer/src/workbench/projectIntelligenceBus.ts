export type ProjectIntelligenceCategory =
  'understand' | 'context' | 'automate' | 'assure' | 'recover';

type Listener = (category: ProjectIntelligenceCategory) => void;

let listener: Listener | null = null;
let pending: ProjectIntelligenceCategory | null = null;

/** Select a Project Intelligence category, buffering until its sidebar mounts. */
export function revealProjectIntelligence(category: ProjectIntelligenceCategory): void {
  if (listener) listener(category);
  else pending = category;
}

/** Project Intelligence owns the single category listener. */
export function setProjectIntelligenceListener(listenerFn: Listener): () => void {
  listener = listenerFn;
  if (pending) {
    const category = pending;
    pending = null;
    listenerFn(category);
  }
  return () => {
    if (listener === listenerFn) listener = null;
  };
}
