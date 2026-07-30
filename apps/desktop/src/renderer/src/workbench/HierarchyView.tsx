import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon } from './treeIcons';
import { monaco } from '../editor/monacoEnv';
import { symbolKind } from '../editor/lspConvert';
import { setHierarchyListener, type HierarchyRequest } from '../editor/hierarchyBus';
import {
  callHierarchyIncoming,
  callHierarchyOutgoing,
  typeHierarchyRelated,
} from '../editor/extensionProviders';
import {
  canExpandHierarchyNode,
  collapseHierarchyNode,
  createHierarchyTree,
  expandLoadedHierarchyNode,
  hierarchyDirectionLabel,
  hierarchyDirections,
  setHierarchyNodeChildren,
  setHierarchyNodeError,
  setHierarchyNodeLoading,
  switchHierarchyDirection,
  visibleHierarchyRows,
  type HierarchyDirection,
  type HierarchyEdge,
  type HierarchyNode,
  type HierarchyTree,
} from '../../../common/hierarchyTree';
import type { WireHierarchyItem } from '../../../common/vscodeLanguageWire';

/**
 * Hierarchy panel (PRD Phase 7 — Type Hierarchy UI).
 *
 * The view for an extension's `TypeHierarchyProvider` and `CallHierarchyProvider`: the roots the
 * provider prepared, and a level fetched from it each time the user opens a row. The direction toggle
 * asks the other question — supertypes/subtypes, callers/calls — which is the half of both APIs that a
 * flat reference list cannot express.
 *
 * The tree state machine is the pure `common/hierarchyTree`; this component is the provider round trip
 * and the rows. Levels are fetched lazily because that is how the API is shaped: each item carries the
 * token its provider minted, and only the item the user opened is asked about.
 *
 * AXIOM's own language-server call hierarchy keeps its flat grouped panel next door; this one appears
 * when an extension answered, and stays hidden until then.
 */

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** The item's file, or null when its provider gave a uri the window cannot resolve to a file. */
function itemPath(item: WireHierarchyItem): string | null {
  let path: string;
  try {
    path = monaco.Uri.parse(item.uri).fsPath;
  } catch {
    return null;
  }
  return path.length === 0 ? null : path;
}

/** The kind chip text, through the same LSP → Monaco mapping the outline and breadcrumbs use. */
function kindLabel(kind: number): string {
  const name: unknown = monaco.languages.SymbolKind[symbolKind(kind)];
  return typeof name === 'string' && name.length > 0 ? name.toLowerCase() : 'symbol';
}

/** The edge a prepared root makes: the item itself, with no call ranges from a parent. */
function rootEdge(item: WireHierarchyItem): HierarchyEdge {
  return { item, fromRanges: [] };
}

/** A level, asked of whichever provider owns this direction. */
async function fetchLevel(
  node: HierarchyNode,
  direction: HierarchyDirection,
): Promise<HierarchyEdge[]> {
  if (direction === 'incoming') {
    const calls = await callHierarchyIncoming(node.item);
    return calls.map((call) => ({ item: call.from, fromRanges: call.fromRanges }));
  }
  if (direction === 'outgoing') {
    const calls = await callHierarchyOutgoing(node.item);
    return calls.map((call) => ({ item: call.to, fromRanges: call.fromRanges }));
  }
  const related = await typeHierarchyRelated(node.item, direction);
  return related.map((entry) => rootEdge(entry.item));
}

export function HierarchyView() {
  const { rootPath, openFileAt } = useWorkspace();
  const [request, setRequest] = useState<HierarchyRequest | null>(null);
  const [tree, setTree] = useState<HierarchyTree | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  /**
   * Bumped by a new request and by a direction switch. An in-flight level answers a question the panel
   * is no longer asking, and attaching it would put callers under a "calls" toggle.
   */
  const epochRef = useRef(0);

  useEffect(
    () =>
      setHierarchyListener((req: HierarchyRequest) => {
        epochRef.current += 1;
        const first = hierarchyDirections(req.kind)[0] ?? 'incoming';
        setRequest(req);
        setTree(createHierarchyTree(req.kind, first, req.roots.map(rootEdge)));
        setCollapsed(false);
      }),
    [],
  );

  if (request === null || tree === null) return null;

  const rows = visibleHierarchyRows(tree);
  const title = request.kind === 'type' ? 'Type Hierarchy' : 'Call Hierarchy Tree';

  const open = (item: WireHierarchyItem): void => {
    const path = itemPath(item);
    if (path === null) return;
    openFileAt(
      path,
      baseName(path),
      item.selectionRange.start.line + 1,
      item.selectionRange.start.character + 1,
    );
  };

  const changeDirection = (direction: HierarchyDirection): void => {
    epochRef.current += 1;
    setTree((current) =>
      current === null ? current : switchHierarchyDirection(current, direction),
    );
  };

  /** Open a row's level: from the model when it is already loaded, from the provider otherwise. */
  const expand = (node: HierarchyNode): void => {
    if (node.children !== null && node.children.length > 0) {
      setTree((current) =>
        current === null ? current : expandLoadedHierarchyNode(current, node.key),
      );
      return;
    }
    if (!canExpandHierarchyNode(node)) return;
    const epoch = epochRef.current;
    const direction = tree.direction;
    setTree((current) => (current === null ? current : setHierarchyNodeLoading(current, node.key)));
    void fetchLevel(node, direction)
      .then((edges) => {
        if (epochRef.current !== epoch) return;
        setTree((current) =>
          current === null ? current : setHierarchyNodeChildren(current, node.key, edges),
        );
      })
      .catch((error: unknown) => {
        if (epochRef.current !== epoch) return;
        const detail = error instanceof Error ? error.message : String(error);
        setTree((current) =>
          current === null ? current : setHierarchyNodeError(current, node.key, detail),
        );
      });
  };

  const collapse = (node: HierarchyNode): void => {
    setTree((current) => (current === null ? current : collapseHierarchyNode(current, node.key)));
  };

  const toggle = (node: HierarchyNode): void => {
    if (node.state === 'expanded') collapse(node);
    else expand(node);
  };

  const rowKeyDown = (event: KeyboardEvent<HTMLDivElement>, node: HierarchyNode): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      open(node.item);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggle(node);
    } else if (event.key === 'ArrowRight' && node.state !== 'expanded') {
      event.preventDefault();
      expand(node);
    } else if (event.key === 'ArrowLeft' && node.state === 'expanded') {
      event.preventDefault();
      collapse(node);
    }
  };

  const rowTrailer = (node: HierarchyNode): string => {
    if (node.state === 'loading') return '…';
    if (node.recursive) return 'cycle';
    if (node.state === 'error') return 'failed';
    const path = itemPath(node.item);
    if (path === null) return '';
    return rootPath !== null && path.startsWith(rootPath) ? path.slice(rootPath.length + 1) : path;
  };

  const rowTitle = (node: HierarchyNode): string => {
    if (node.state === 'error') return node.error ?? 'This level could not be loaded.';
    if (node.recursive)
      return 'Already shown higher in this branch — expanding it would not terminate.';
    const path = itemPath(node.item);
    const where = path === null ? '' : ` · ${path}:${node.item.selectionRange.start.line + 1}`;
    const detail =
      node.item.detail !== undefined && node.item.detail.length > 0 ? ` ${node.item.detail}` : '';
    return `${kindLabel(node.item.kind)} ${node.item.name}${detail}${where}`;
  };

  return (
    <div className="deps-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">{title}</span>
        <span className="oe-count" title="Rows shown">
          {rows.length}
        </span>
      </div>

      {collapsed ? null : (
        <div className="deps-body">
          <div className="repo-report-actions" role="group" aria-label="Hierarchy direction">
            {hierarchyDirections(tree.kind).map((direction) => (
              <button
                key={direction}
                type="button"
                className={`btn ${direction === tree.direction ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={direction === tree.direction}
                onClick={() => changeDirection(direction)}
              >
                {hierarchyDirectionLabel(direction)}
              </button>
            ))}
          </div>
          <div className="deps-impact" title="The symbol this hierarchy was prepared from">
            {hierarchyDirectionLabel(tree.direction)} of <strong>{request.symbol}</strong>
          </div>
          {rows.length === 0 ? (
            <div className="outline-empty">No hierarchy items.</div>
          ) : (
            <div className="outline-list" role="list">
              {rows.map((node) => {
                const expandable =
                  node.state === 'expanded' ||
                  (node.children !== null && node.children.length > 0) ||
                  canExpandHierarchyNode(node);
                const kind = kindLabel(node.item.kind);
                return (
                  <div
                    key={node.key}
                    role="listitem"
                    className="outline-row"
                    style={{ paddingLeft: 8 + node.depth * 12 }}
                    title={rowTitle(node)}
                    aria-level={node.depth + 1}
                    {...(expandable ? { 'aria-expanded': node.state === 'expanded' } : {})}
                    tabIndex={0}
                    onClick={() => open(node.item)}
                    onKeyDown={(event) => rowKeyDown(event, node)}
                  >
                    <span
                      className="oe-chevron"
                      aria-hidden="true"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(node);
                      }}
                    >
                      {expandable ? <ChevronIcon open={node.state === 'expanded'} /> : null}
                    </span>
                    <span className={`outline-kind k-${kind}`}>{kind}</span>
                    <span className="outline-name">{node.item.name || '(anonymous)'}</span>
                    <span className="outline-line">{rowTrailer(node)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {tree.capped ? (
            <div className="outline-empty">
              Hierarchy truncated — this tree is at the size AXIOM keeps in memory.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
