import { useEffect, useRef, useState } from 'react';
import type { CoreSymbol, LspDocumentSymbol } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon } from './treeIcons';
import { monaco } from '../editor/monacoEnv';

/**
 * Outline view (PRD Part VII §104.7 / Phase 45; also §108 navigation). Lists the
 * symbols of the active editor's file; clicking one jumps the editor to it.
 *
 * Source of truth is the LANGUAGE SERVER's `documentSymbol`, which gives a real
 * nested tree (class → method → local) and the same answer the breadcrumb and
 * Go-to-Symbol use, so the three cannot disagree. When no server serves the file
 * — an unsupported language, or a toolchain the user has not installed — it falls
 * back to the on-device Rust Core Tree-sitter extraction (Phases 52–53), and
 * degrades quietly if that is unavailable too.
 */

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** LSP SymbolKind → the short label shown in the kind chip. */
const KIND_LABEL: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type',
};

interface FlatSymbol {
  name: string;
  kind: string;
  line: number;
  column: number;
  depth: number;
}

/** Flatten the server's tree for rendering, keeping depth for indentation. */
function flatten(symbols: LspDocumentSymbol[], depth = 0, out: FlatSymbol[] = []): FlatSymbol[] {
  for (const s of symbols) {
    out.push({
      name: s.name,
      kind: KIND_LABEL[s.kind] ?? 'symbol',
      line: s.selectionRange.start.line + 1,
      column: s.selectionRange.start.character + 1,
      depth,
    });
    if (s.children.length > 0 && depth < 8) flatten(s.children, depth + 1, out);
  }
  return out;
}

function fromCore(symbols: CoreSymbol[]): FlatSymbol[] {
  return symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.startLine,
    column: 1,
    depth: 0,
  }));
}

export function OutlineView() {
  const { activePath, openFileAt } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [symbols, setSymbols] = useState<FlatSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!activePath) {
      setSymbols([]);
      return;
    }
    if (collapsed) return; // don't fetch while collapsed; refetch on expand
    const id = ++reqRef.current;
    setLoading(true);
    setUnavailable(false);

    void (async () => {
      // Ask the language server first; it has the richest, most accurate tree.
      const model = monaco.editor.getModel(monaco.Uri.file(activePath));
      if (model) {
        const lspSymbols = await window.axiom.lsp
          .documentSymbol(model.uri.toString())
          .catch(() => [] as LspDocumentSymbol[]);
        if (reqRef.current !== id) return;
        if (lspSymbols.length > 0) {
          setSymbols(flatten(lspSymbols));
          setLoading(false);
          return;
        }
      }
      try {
        const res = await window.axiom.core.symbols(activePath);
        if (reqRef.current !== id) return;
        setSymbols(fromCore(res.symbols));
        setLoading(false);
      } catch {
        if (reqRef.current !== id) return;
        setSymbols([]);
        setUnavailable(true);
        setLoading(false);
      }
    })();
  }, [activePath, collapsed]);

  if (!activePath) return null;
  const name = baseName(activePath);

  const jump = (line: number, column: number): void =>
    openFileAt(activePath, name, line, column);

  return (
    <div className="outline">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">Outline</span>
        <span className="oe-count">{symbols.length}</span>
      </div>

      {collapsed ? null : (
        <div className="outline-list" role="list">
          {loading ? (
            <div className="outline-empty">Loading…</div>
          ) : unavailable ? (
            <div className="outline-empty">
              No outline for this file — no language server and no Rust Core.
            </div>
          ) : symbols.length === 0 ? (
            <div className="outline-empty">No symbols in this file.</div>
          ) : (
            symbols.map((s, i) => (
              <div
                key={`${s.kind}:${s.name}:${s.line}:${i}`}
                role="listitem"
                className="outline-row"
                style={s.depth > 0 ? { paddingLeft: 8 + s.depth * 12 } : undefined}
                title={`${s.kind} ${s.name} · line ${s.line}`}
                onClick={() => jump(s.line, s.column)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    jump(s.line, s.column);
                  }
                }}
                tabIndex={0}
              >
                <span className={`outline-kind k-${s.kind}`}>{s.kind}</span>
                <span className="outline-name">{s.name || '(anonymous)'}</span>
                <span className="outline-line">{s.line}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
