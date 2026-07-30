// Pure call-hierarchy model. No I/O, no Electron — safe to unit-test in Node.
//
// Builds an "incoming references" (callers) hierarchy for a symbol from a flat
// list of LSP reference locations: it dedupes exact duplicates, groups the
// references by file, and sorts everything deterministically so the UI is
// stable across runs. The renderer maps LSP locations (0-based) into
// 1-based RefLocation values before calling buildCallHierarchy.
//
// Scope (Epoch D, Phase 95): this covers INCOMING references only. Outgoing
// calls and a full Monaco call-hierarchy provider are not implemented (Monaco
// exposes no registerCallHierarchyProvider), so Phase 95 remains partial.

/** A single reference site. Coordinates are 1-based (editor-facing). */
export interface RefLocation {
  path: string;
  line: number;
  column: number;
}

/** All references that live in one file, sorted by position. */
export interface HierarchyFile {
  path: string;
  /** `path` relative to the workspace root, using forward slashes. */
  rel: string;
  count: number;
  locations: RefLocation[];
}

/** The full grouped hierarchy for one symbol. */
export interface CallHierarchy {
  symbol: string;
  totalRefs: number;
  fileCount: number;
  files: HierarchyFile[];
}

/**
 * Return `path` relative to `root` using forward slashes. Matching is
 * case-insensitive (Windows-friendly) but the original casing of the tail is
 * preserved. If `path` is not under `root`, the normalized absolute path is
 * returned unchanged.
 */
export function relFromRoot(root: string, path: string): string {
  const normPath = path.replace(/\\/g, '/');
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normRoot.length === 0) return normPath;
  const lowerRoot = normRoot.toLowerCase();
  const lowerPath = normPath.toLowerCase();
  if (lowerPath === lowerRoot) return '';
  if (lowerPath.startsWith(lowerRoot + '/')) {
    return normPath.slice(normRoot.length + 1);
  }
  return normPath;
}

/**
 * Build a grouped, sorted call hierarchy from raw reference locations.
 *
 * - Dedupes by `path:line:column`.
 * - Groups the surviving refs by file.
 * - Sorts locations within a file by line, then column.
 * - Sorts files by reference count (desc), then relative path (asc).
 */
export function buildCallHierarchy(
  symbol: string,
  refs: RefLocation[],
  root: string,
): CallHierarchy {
  const seen = new Set<string>();
  const groups = new Map<string, RefLocation[]>();

  for (const ref of refs) {
    const key = `${ref.path}:${ref.line}:${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = groups.get(ref.path);
    if (list) list.push(ref);
    else groups.set(ref.path, [ref]);
  }

  const files: HierarchyFile[] = [];
  for (const [path, locations] of groups) {
    const sorted = locations.slice().sort((a, b) => a.line - b.line || a.column - b.column);
    files.push({
      path,
      rel: relFromRoot(root, path),
      count: sorted.length,
      locations: sorted,
    });
  }

  files.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));

  return {
    symbol,
    totalRefs: seen.size,
    fileCount: files.length,
    files,
  };
}
