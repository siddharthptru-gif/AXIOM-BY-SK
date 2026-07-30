/**
 * Symbol-level knowledge graph (PRD Phase 65 — Knowledge Graph Construction, symbol level).
 *
 * PURE module (no I/O, no Electron). Complements the FILE-level import graph
 * (`common/importGraph`) with SYMBOL-level structure: it extracts top-level
 * declarations (functions / classes / interfaces / types / enums / consts) from each
 * source file and computes CROSS-FILE references — i.e. which files use a symbol
 * declared elsewhere — to surface the repo's most-referenced symbols and the
 * symbol-usage surface. A heuristic (regex + identifier-frequency) analysis, kept
 * efficient by tokenizing each file once (no per-symbol regex). Deterministic;
 * serializable outputs. Symbol resolution is by name across the repo (not scope-exact)
 * — honest heuristic, not a type-checker.
 */

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';

export interface SymbolDecl {
  name: string;
  kind: SymbolKind;
}

export interface SymbolSourceFile {
  path: string;
  source: string;
}

/** A cross-file reference: `from` uses `symbol` (declared in another file) `count` times. */
export interface SymbolRef {
  from: string;
  symbol: string;
  count: number;
}

export interface SymbolGraphSummary {
  symbols: number;
  files: number;
  references: number;
  topReferenced: { symbol: string; count: number }[];
  summary: string;
}

const DECL_PATTERNS: ReadonlyArray<readonly [SymbolKind, RegExp]> = [
  ['function', /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g],
  ['class', /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g],
  ['interface', /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g],
  ['type', /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/g],
  ['enum', /\b(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g],
  ['const', /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g],
];

/** Extract top-level declaration names from a source file (first kind wins per name). */
export function extractSymbols(source: string): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({ name, kind });
      }
    }
  }
  return out;
}

/** Identifier → occurrence-count for a source file (single pass). */
function tokenFrequency(source: string): Map<string, number> {
  const re = /[A-Za-z_$][\w$]*/g;
  const map = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tok = m[0];
    map.set(tok, (map.get(tok) ?? 0) + 1);
  }
  return map;
}

/**
 * Compute cross-file symbol references. Each symbol is attributed to its FIRST
 * declaring file; a reference is any other file whose tokens include that symbol
 * name. Efficient: one tokenization pass per file, then O(distinct tokens) lookups.
 */
export function buildSymbolReferences(files: readonly SymbolSourceFile[]): SymbolRef[] {
  const declHome = new Map<string, string>();
  for (const f of files) {
    for (const d of extractSymbols(f.source)) {
      if (!declHome.has(d.name)) declHome.set(d.name, f.path);
    }
  }
  const refs: SymbolRef[] = [];
  for (const f of files) {
    const freq = tokenFrequency(f.source);
    for (const [tok, count] of freq) {
      const home = declHome.get(tok);
      if (home !== undefined && home !== f.path) {
        refs.push({ from: f.path, symbol: tok, count });
      }
    }
  }
  return refs;
}

/** Summarize the symbol graph: totals + the most cross-file-referenced symbols. */
export function summarizeSymbolGraph(files: readonly SymbolSourceFile[]): SymbolGraphSummary {
  const allSymbols = new Set<string>();
  for (const f of files) for (const d of extractSymbols(f.source)) allSymbols.add(d.name);

  const refs = buildSymbolReferences(files);
  const bySymbol = new Map<string, number>();
  for (const r of refs) bySymbol.set(r.symbol, (bySymbol.get(r.symbol) ?? 0) + r.count);

  const topReferenced = [...bySymbol.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
    .slice(0, 10);

  const references = refs.reduce((s, r) => s + r.count, 0);
  const top = topReferenced[0];
  const summary =
    allSymbols.size === 0
      ? 'No symbols found.'
      : `${allSymbols.size} symbols across ${files.length} files, ${references} cross-file reference(s)` +
        (top ? `; most-referenced: ${top.symbol} (${top.count})` : '') +
        '.';

  return { symbols: allSymbols.size, files: files.length, references, topReferenced, summary };
}
