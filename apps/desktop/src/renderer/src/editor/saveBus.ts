/**
 * Save bus. Lets code outside the editor (e.g. the close-tab confirmation) save a
 * file by path. With split editor groups there can be more than one editor pane,
 * so multiple savers register; `saveFile` tries each until the pane that owns the
 * file's model handles it.
 *
 * A saver returns `false` when it does not own the path, the save failed, or
 * the user cancelled. Success reports the path now holding the content plus whether
 * the model is still clean relative to the exact bytes written. The latter prevents
 * close-after-save from discarding edits made while an asynchronous write was in flight.
 */
export interface SaveResult {
  path: string;
  clean: boolean;
}

type Saver = (path: string) => Promise<SaveResult | false>;

const savers = new Set<Saver>();

export function addSaver(saver: Saver): () => void {
  savers.add(saver);
  return () => {
    savers.delete(saver);
  };
}

export async function saveFile(path: string): Promise<SaveResult | false> {
  for (const saver of savers) {
    const result = await saver(path);
    if (result !== false) return result;
  }
  return false;
}
