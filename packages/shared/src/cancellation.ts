/**
 * Cancellation primitives. PRD Part II §13.2: cancellation is first-class and
 * propagated across boundaries so "Stop" is instant and honored end-to-end.
 */
export class CancellationError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export interface CancellationToken {
  readonly isCancelled: boolean;
  /** Register a listener; returns an unsubscribe function. */
  onCancelled(listener: () => void): () => void;
  /** Throws CancellationError if already cancelled. */
  throwIfCancelled(): void;
}

export class CancellationTokenSource {
  private _cancelled = false;
  private readonly _listeners = new Set<() => void>();
  readonly token: CancellationToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancelled(): boolean {
        return self._cancelled;
      },
      onCancelled(listener: () => void): () => void {
        if (self._cancelled) {
          listener();
          return () => undefined;
        }
        self._listeners.add(listener);
        return () => {
          self._listeners.delete(listener);
        };
      },
      throwIfCancelled(): void {
        if (self._cancelled) throw new CancellationError();
      },
    };
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        /* listener errors must not break cancellation */
      }
    }
    this._listeners.clear();
  }
}
