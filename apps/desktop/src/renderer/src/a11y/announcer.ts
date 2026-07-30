import type { Politeness } from '../../../common/a11y';

/**
 * Announce bus (PRD Phases 253/254). A tiny pub/sub for explicit screen-reader
 * announcements (e.g., the editor announcing an opened file). The LiveRegion
 * subscribes and writes to the aria-live regions; notifications are announced
 * separately via the notification bus.
 */
export interface Announcement {
  text: string;
  politeness: Politeness;
}

type Listener = (a: Announcement) => void;
const listeners = new Set<Listener>();

export function announce(text: string, politeness: Politeness = 'polite'): void {
  const a: Announcement = { text, politeness };
  for (const listener of listeners) listener(a);
}

export function subscribeAnnounce(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
