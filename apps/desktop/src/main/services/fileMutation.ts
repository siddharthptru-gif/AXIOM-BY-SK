/**
 * Main-owned coordinator for mutations of workspace files. Safe Edit commits and
 * explicit checkpoint restores share this queue, so a multi-file operation is
 * observed in one serial order rather than interleaving into a mixed state.
 *
 * Lock order is always file mutation -> snapshot metadata. Snapshot-only work
 * must never acquire this coordinator while already holding the snapshot queue.
 */
let fileMutationQueue: Promise<void> = Promise.resolve();

export function serializeFileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = fileMutationQueue.then(operation, operation);
  fileMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
