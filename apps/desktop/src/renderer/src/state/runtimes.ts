import type { DetectedRuntime } from '../../../common/runtimes';

/**
 * Detected-toolchain store.
 *
 * Main scans PATH once and caches; this keeps the renderer's copy so every Run
 * button, settings row, and status readout shares one answer instead of each one
 * triggering its own IPC round trip on every render.
 *
 * The set of installed ids is what the Run system needs, so it is precomputed here
 * rather than derived at each call site.
 */

interface RuntimeSnapshot {
  runtimes: readonly DetectedRuntime[];
  /** Ids of the toolchains that are actually installed. */
  available: ReadonlySet<string>;
  /** False until the first scan resolves, so the UI can avoid a premature verdict. */
  loaded: boolean;
}

let snapshot: RuntimeSnapshot = { runtimes: [], available: new Set(), loaded: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<(next: RuntimeSnapshot) => void>();

function publish(runtimes: readonly DetectedRuntime[]): void {
  snapshot = {
    runtimes,
    available: new Set(runtimes.filter((entry) => entry.path !== null).map((entry) => entry.id)),
    loaded: true,
  };
  for (const listener of listeners) listener(snapshot);
}

export function currentRuntimes(): RuntimeSnapshot {
  return snapshot;
}

/**
 * Subscribe to the detected toolchains. The first subscriber triggers the scan; the
 * current snapshot is delivered immediately so a late subscriber is never blank.
 */
export function subscribeRuntimes(listener: (next: RuntimeSnapshot) => void): () => void {
  listeners.add(listener);
  listener(snapshot);
  if (!snapshot.loaded) void refreshRuntimes();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-read the toolchains. Concurrent callers share one request; `force` asks Main to
 * re-scan the machine, which is what the user wants after installing something.
 */
export function refreshRuntimes(force = false): Promise<void> {
  if (inFlight && !force) return inFlight;
  inFlight = window.axiom.lsp
    .runtimes(force)
    .then((runtimes) => publish(runtimes))
    .catch(() => {
      // A failed scan must not leave the UI waiting forever; report "none detected".
      if (!snapshot.loaded) publish([]);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
