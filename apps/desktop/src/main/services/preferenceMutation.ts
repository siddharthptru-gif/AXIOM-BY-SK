/**
 * One failure-tolerant FIFO for user preference files. Settings, keybindings,
 * and multi-file profile application share this order so commits cannot race.
 */
let preferenceMutationQueue: Promise<void> = Promise.resolve();

export function serializePreferenceMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = preferenceMutationQueue.then(operation, operation);
  preferenceMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
