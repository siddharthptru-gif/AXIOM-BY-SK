/**
 * Import-graph extraction (PRD Phase 65 — Knowledge Graph Construction, file level).
 *
 * PURE module (no I/O, no Electron). Turns a set of source files into a file-level
 * import graph (`KnowledgeNode[]` + `KnowledgeEdge[]` of kind `imports`) that the
 * `common/knowledgeGraph` engine can query for reachability / blast-radius / cycles.
 * A heuristic (regex) extractor — resolves RELATIVE specifiers (`./`, `../`) against
 * the known file set (trying common extensions + `/index`), and treats bare
 * specifiers (packages) as external (dropped). The Rust Core builds the same graph
 * natively for indexing; this TS builder makes the FULL edge list available in the
 * app (the Core only exposes per-file queries), which is what lets the knowledge
 * graph answer whole-repo reachability. Deterministic.
 */
import type { KnowledgeNode, KnowledgeEdge } from './knowledgeGraph';

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import ... from 'x'  /  export ... from 'x'
  /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // bare side-effect import 'x'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // dynamic import('x')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Extract every module specifier referenced by a source file (deduped, in order). */
export function extractSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec) found.add(spec);
    }
  }
  return [...found];
}

/** Normalize a POSIX-ish path, collapsing `.`/`..` segments. Keeps it relative-safe. */
export function normalizePath(path: string): string {
  const isAbs = path.startsWith('/');
  const parts = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(part);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
}

function dirname(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? '' : norm.slice(0, idx);
}

const RESOLVE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolve a RELATIVE specifier from `fromPath` to a concrete file in `known`. Tries
 * the exact join, then common source extensions, then a `/index.*` barrel. Returns
 * null for bare/external specifiers or unresolved targets.
 */
export function resolveRelative(fromPath: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalizePath(`${dirname(fromPath)}/${spec}`);
  if (known.has(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (known.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export interface SourceFile {
  path: string;
  source: string;
}

/**
 * Build a file-level import graph from a set of source files: one `file` node per
 * input path and one `imports` edge per resolved relative import (deduped,
 * self-imports dropped). Feed the result to `buildKnowledgeGraph`.
 */
export function buildImportEdges(files: readonly SourceFile[]): {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
} {
  const known = new Set<string>();
  for (const f of files) known.add(normalizePath(f.path));

  const nodes: KnowledgeNode[] = files.map((f) => ({
    id: normalizePath(f.path),
    kind: 'file',
    name: baseName(f.path),
  }));

  const seen = new Set<string>();
  const edges: KnowledgeEdge[] = [];
  for (const f of files) {
    const from = normalizePath(f.path);
    for (const spec of extractSpecifiers(f.source)) {
      const to = resolveRelative(from, spec, known);
      if (!to || to === from) continue;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: 'imports' });
    }
  }
  return { nodes, edges };
}
