import { useEffect, useState } from 'react';
import type { DirEntryKind, LspDocumentSymbol } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon, FileIcon, FolderIcon } from './treeIcons';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { monaco } from '../editor/monacoEnv';
import { subscribeActiveCursor } from '../editor/activeEditorBus';

/**
 * Editor breadcrumbs (PRD Part VII §106).
 *
 * Two halves. The path half shows the active file's location relative to the
 * workspace root; clicking a segment opens a dropdown of its siblings.
 *
 * The symbol half — `src > components > Button.tsx > Button > render()` — is
 * driven by the language server's `documentSymbol` tree and the live cursor
 * position, so it names the class and method you are actually inside. Clicking a
 * symbol jumps to it, and its dropdown lists its siblings at that nesting level.
 */
interface Segment {
  name: string;
  path: string;
  kind: DirEntryKind;
}

interface SymbolSegment {
  name: string;
  detail: string;
  kind: number;
  line: number;
  column: number;
  /** The symbols at this nesting level, for the dropdown. */
  siblings: LspDocumentSymbol[];
}

function computeSegments(activePath: string, rootPath: string | null): Segment[] {
  const sep = (rootPath ?? activePath).includes('\\') ? '\\' : '/';

  if (!rootPath || !(activePath === rootPath || activePath.startsWith(rootPath + sep))) {
    const parts = activePath.split(/[\\/]/).filter(Boolean);
    const name = parts[parts.length - 1] ?? activePath;
    return [{ name, path: activePath, kind: 'file' }];
  }

  const rel = activePath.slice(rootPath.length + 1);
  const parts = rel.split(sep).filter(Boolean);
  const segments: Segment[] = [];
  let acc = rootPath;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    acc = `${acc}${sep}${part}`;
    segments.push({ name: part, path: acc, kind: i === parts.length - 1 ? 'file' : 'directory' });
  }
  return segments;
}

/** 1-based line/column is inside a 0-based LSP range. */
function containsPosition(range: LspDocumentSymbol['range'], line: number, column: number): boolean {
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  if (line < startLine || line > endLine) return false;
  if (line === startLine && column < range.start.character + 1) return false;
  if (line === endLine && column > range.end.character + 1) return false;
  return true;
}

/**
 * Walk the symbol tree to the deepest symbol containing the cursor, recording the
 * chain and each level's siblings on the way down.
 */
function symbolChain(
  symbols: LspDocumentSymbol[],
  line: number,
  column: number,
): SymbolSegment[] {
  const chain: SymbolSegment[] = [];
  let level = symbols;
  for (let depth = 0; depth < 32; depth += 1) {
    const match = level.find((s) => containsPosition(s.range, line, column));
    if (!match) break;
    chain.push({
      name: match.name,
      detail: match.detail ?? '',
      kind: match.kind,
      line: match.selectionRange.start.line + 1,
      column: match.selectionRange.start.character + 1,
      siblings: level,
    });
    if (match.children.length === 0) break;
    level = match.children;
  }
  return chain;
}

/** LSP SymbolKind → the icon-ish label shown before a symbol name. */
const SYMBOL_GLYPH: Record<number, string> = {
  5: 'C', // Class
  6: 'M', // Method
  7: 'P', // Property
  8: 'F', // Field
  9: 'C', // Constructor
  10: 'E', // Enum
  11: 'I', // Interface
  12: 'ƒ', // Function
  13: 'V', // Variable
  14: 'K', // Constant
  22: 'E', // EnumMember
  23: 'S', // Struct
  26: 'T', // TypeParameter
};

export function Breadcrumbs({
  path,
  onReveal,
}: {
  path?: string;
  onReveal: (path: string) => void;
}) {
  const { activePath, rootPath, openFile, openFileAt } = useWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [symbols, setSymbols] = useState<LspDocumentSymbol[]>([]);
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });

  const filePath = path ?? activePath;

  useEffect(() => subscribeActiveCursor(setCursor), []);

  // Re-request the outline when the file changes or its content settles. The
  // language server owns the answer, so the breadcrumb cannot disagree with the
  // Go-to-Symbol list or the outline view.
  useEffect(() => {
    if (!filePath || !rootPath) {
      setSymbols([]);
      return;
    }
    const model = monaco.editor.getModel(monaco.Uri.file(filePath));
    if (!model) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const load = (): void => {
      void window.axiom.lsp
        .documentSymbol(model.uri.toString())
        .then((result) => {
          if (!cancelled) setSymbols(result);
        })
        .catch(() => {
          if (!cancelled) setSymbols([]);
        });
    };
    load();
    const sub = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      sub.dispose();
    };
  }, [filePath, rootPath]);

  if (!filePath) return null;

  const segments = computeSegments(filePath, rootPath);
  if (segments.length === 0) return null;
  const chain = symbolChain(symbols, cursor.line, cursor.column);

  // Open a dropdown of the segment's siblings (contents of its parent directory).
  const openSegmentMenu = async (seg: Segment, x: number, y: number): Promise<void> => {
    const sep = seg.path.includes('\\') ? '\\' : '/';
    const parent = seg.path.slice(0, seg.path.lastIndexOf(sep)) || seg.path;
    const entries: MenuEntry[] = [
      { label: 'Reveal in Explorer', onSelect: () => onReveal(seg.path) },
      { separator: true },
    ];
    try {
      const res = await window.axiom.fs.readDirectory(parent);
      for (const entry of res.entries) {
        entries.push({
          label: entry.name,
          onSelect: () =>
            entry.kind === 'file' ? openFile(entry.path, entry.name) : onReveal(entry.path),
        });
      }
    } catch {
      /* directory unreadable — keep just the reveal action */
    }
    setMenu({ x, y, entries });
  };

  /** Jump list for the symbols at the same nesting level as the clicked one. */
  const openSymbolMenu = (seg: SymbolSegment, x: number, y: number): void => {
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setMenu({
      x,
      y,
      entries: seg.siblings.map((sibling) => ({
        label: sibling.detail ? `${sibling.name} ${sibling.detail}` : sibling.name,
        onSelect: () =>
          openFileAt(
            filePath,
            name,
            sibling.selectionRange.start.line + 1,
            sibling.selectionRange.start.character + 1,
          ),
      })),
    });
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumbs">
        {segments.map((seg, i) => (
          <span className="breadcrumb-item" key={seg.path}>
            {i > 0 ? (
              <span className="breadcrumb-sep" aria-hidden="true">
                <ChevronIcon open={false} />
              </span>
            ) : null}
            <button
              type="button"
              className="breadcrumb-seg"
              title={seg.path}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                void openSegmentMenu(seg, r.left, r.bottom);
              }}
            >
              <span className={`breadcrumb-icon ${seg.kind}`}>
                {seg.kind === 'directory' ? (
                  <FolderIcon open={false} />
                ) : (
                  <FileIcon name={seg.name} />
                )}
              </span>
              <span className="breadcrumb-name">{seg.name}</span>
            </button>
          </span>
        ))}
        {chain.map((seg, i) => (
          <span className="breadcrumb-item" key={`symbol:${i}:${seg.name}`}>
            <span className="breadcrumb-sep" aria-hidden="true">
              <ChevronIcon open={false} />
            </span>
            <button
              type="button"
              className="breadcrumb-seg breadcrumb-symbol"
              title={seg.detail ? `${seg.name} ${seg.detail}` : seg.name}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openSymbolMenu(seg, r.left, r.bottom);
              }}
            >
              <span className="breadcrumb-symbol-kind" aria-hidden="true">
                {SYMBOL_GLYPH[seg.kind] ?? '·'}
              </span>
              <span className="breadcrumb-name">{seg.name}</span>
            </button>
          </span>
        ))}
      </nav>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}
