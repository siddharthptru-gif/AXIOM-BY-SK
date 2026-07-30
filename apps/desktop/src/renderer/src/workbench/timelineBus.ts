/**
 * Timeline (time-travel) opener bus (owner/subscribe pattern, like updateBus /
 * aboutBus). The palette command and the Checkpoints panel call `openTimeline()`;
 * the mounted `TimelineView` subscribes and shows the dialog.
 */
type Listener = () => void;

let listener: Listener | null = null;

/** TimelineView subscribes on mount. */
export function onTimelineOpen(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Command entry point: open the timeline (no-op if not mounted yet). */
export function openTimeline(): void {
  listener?.();
}
