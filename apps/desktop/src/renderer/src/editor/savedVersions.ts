/**
 * Shared "saved version" map, keyed by file path (PRD Part VII §105/§106). A
 * file's dirty state is `model.getAlternativeVersionId() !== savedVersion`. Keeping
 * this baseline here (rather than per editor pane) means a file open in more than
 * one editor group — or moved between groups — has one consistent saved baseline,
 * so its dirty state and saves never diverge. The Monaco model itself is shared
 * per URI, so this only needs to track the last-persisted version id.
 */
const savedVersions = new Map<string, number>();

export function getSavedVersion(path: string): number | undefined {
  return savedVersions.get(path);
}

export function setSavedVersion(path: string, versionId: number): void {
  savedVersions.set(path, versionId);
}

export function clearSavedVersion(path: string): void {
  savedVersions.delete(path);
}
