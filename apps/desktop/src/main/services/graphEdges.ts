import { readFile } from 'node:fs/promises';
import { listFiles } from './filesystem';
import { buildImportEdges, type SourceFile } from '../../common/importGraph';
import { buildKnowledgeGraph } from '../../common/knowledgeGraph';
import { summarizeSymbolGraph } from '../../common/symbolGraph';
import type { CoreGraphEdgesResult } from '../../common/ipc';

/**
 * Full-repo knowledge-graph builder (PRD Phase 65 — Knowledge Graph Construction).
 *
 * Complements the Rust Core's per-file graph queries with a whole-repo, file-level
 * import graph the renderer can query for reachability / blast-radius. Reuses the
 * ignore-aware `listFiles` walk, reads the source of each JS/TS module (bounded),
 * extracts relative-import edges via the pure `common/importGraph`, and returns a
 * de-duplicated `common/knowledgeGraph` (node ids are workspace-relative POSIX paths).
 */

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MAX_GRAPH_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

export async function buildWorkspaceGraph(root: string): Promise<CoreGraphEdgesResult> {
  const { files } = await listFiles(root);
  const sources = files.filter((f) => SOURCE_EXT.test(f.name)).slice(0, MAX_GRAPH_FILES);

  const loaded: SourceFile[] = [];
  for (const f of sources) {
    try {
      const content = await readFile(f.path, 'utf8');
      if (content.length > MAX_FILE_BYTES) continue; // skip huge/generated files
      loaded.push({ path: f.rel, source: content });
    } catch {
      // unreadable file (permissions, races) — skip quietly
    }
  }

  const { nodes, edges } = buildImportEdges(loaded);
  // Symbol-level summary (PRD Phase 65, symbol level) — cross-file reference analysis
  // over the same loaded sources (efficient identifier-frequency scan).
  return { ...buildKnowledgeGraph(nodes, edges), symbols: summarizeSymbolGraph(loaded) };
}
