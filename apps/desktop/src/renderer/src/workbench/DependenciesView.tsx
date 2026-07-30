import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWorkspace } from '../state/workspace';
import type { CoreGraphEdgesResult } from '../../../common/ipc';
import { ChevronIcon } from './treeIcons';
import { computeFileMetrics } from '../../../common/graphMetrics';
import {
  buildKnowledgeGraph,
  summarizeGraph,
  transitiveImpact,
  reachableFrom,
  type KnowledgeNode,
  type KnowledgeEdge,
} from '../../../common/knowledgeGraph';

/**
 * Dependencies panel (PRD Part VIII §127 / Phase 66–67). Surfaces the on-device
 * knowledge graph for the active file: what it imports, what imports it, and how
 * many files a change would transitively affect (impact / blast radius). Each
 * entry navigates to the file. Collapsed by default so the graph is only built
 * (an ignore-aware workspace walk, cached afterwards) when the user opens it.
 * Sits at the bottom of the Explorer, mirroring the Outline view.
 */

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

function relTo(root: string | null, p: string): string {
  if (root && p.startsWith(root)) {
    return p
      .slice(root.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
  }
  return p.replace(/\\/g, '/');
}

export function DependenciesView() {
  const { activePath, rootPath, openFileAt } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [imports, setImports] = useState<string[]>([]);
  const [importedBy, setImportedBy] = useState<string[]>([]);
  const [impactCount, setImpactCount] = useState(0);
  const [graphSummary, setGraphSummary] = useState<string | null>(null);
  const [repoGraph, setRepoGraph] = useState<CoreGraphEdgesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reqRef = useRef(0);

  // Whole-repo knowledge graph (PRD Phase 65): a best-effort, TS-built file-level
  // import graph. Fetched ONCE per workspace root (not per active file — the graph
  // only changes with the file set), then queried in-memory below.
  useEffect(() => {
    if (!rootPath || collapsed) return;
    let cancelled = false;
    void window.axiom.core.graph
      .edges(rootPath)
      .then((graph) => {
        if (!cancelled) setRepoGraph(graph);
      })
      .catch(() => {
        if (!cancelled) setRepoGraph(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, collapsed]);

  // The active file's transitive blast radius + dependency reach — cheap in-memory
  // queries over the cached repo graph, recomputed only when the file/graph changes.
  const fullGraph = useMemo(() => {
    if (!repoGraph || !activePath || !rootPath) return null;
    const rel = relTo(rootPath, activePath);
    // Only meaningful when the active file is actually a node in the import graph
    // (a scanned source file) — otherwise the 0/0 readout would mislead.
    if (!repoGraph.nodes.some((n) => n.id === rel)) return null;
    return {
      impact: transitiveImpact(repoGraph, rel).length,
      reach: reachableFrom(repoGraph, rel).length,
    };
  }, [repoGraph, activePath, rootPath]);

  useEffect(() => {
    if (!activePath || !rootPath || collapsed) return;
    const id = ++reqRef.current;
    setLoading(true);
    setUnavailable(false);
    Promise.all([
      window.axiom.core.graph.dependencies(rootPath, activePath),
      window.axiom.core.graph.dependents(rootPath, activePath),
      window.axiom.core.graph.impact(rootPath, activePath),
    ])
      .then(([deps, dependents, impact]) => {
        if (reqRef.current !== id) return;
        setImports(deps.dependencies);
        setImportedBy(dependents.dependents);
        setImpactCount(impact.count);
        // Knowledge graph (PRD Phase 65): assemble the active file's immediate
        // neighborhood as a typed node/edge graph and surface its structural summary
        // (de-duplicated across import/imported-by, dangling-safe).
        const nodes: KnowledgeNode[] = [
          { id: activePath, kind: 'file', name: baseName(activePath) },
          ...deps.dependencies.map((d): KnowledgeNode => ({
            id: d,
            kind: 'file',
            name: baseName(d),
          })),
          ...dependents.dependents.map((d): KnowledgeNode => ({
            id: d,
            kind: 'file',
            name: baseName(d),
          })),
        ];
        const edges: KnowledgeEdge[] = [
          ...deps.dependencies.map((d): KnowledgeEdge => ({
            from: activePath,
            to: d,
            kind: 'imports',
          })),
          ...dependents.dependents.map((d): KnowledgeEdge => ({
            from: d,
            to: activePath,
            kind: 'imports',
          })),
        ];
        setGraphSummary(summarizeGraph(buildKnowledgeGraph(nodes, edges)).summary);
        setLoading(false);
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setUnavailable(true);
        setLoading(false);
      });
  }, [activePath, rootPath, collapsed]);

  if (!activePath) return null;

  const openFile = (full: string): void => openFileAt(full, baseName(full), 1, 1);

  const renderList = (files: string[]): ReactNode =>
    files.map((f, i) => (
      <div
        key={`${f}:${i}`}
        className="dep-row"
        role="button"
        tabIndex={0}
        title={relTo(rootPath, f)}
        onClick={() => openFile(f)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFile(f);
          }
        }}
      >
        <span className="dep-name">{baseName(f)}</span>
        <span className="dep-dir">{relTo(rootPath, f)}</span>
      </div>
    ));

  return (
    <div className="deps-view">
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
        <span className="oe-title">Dependencies</span>
        {!collapsed && !loading && !unavailable ? (
          <span className="oe-count" title="Files impacted by a change">
            {impactCount}
          </span>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="deps-body">
          {loading ? (
            <div className="outline-empty">Analyzing…</div>
          ) : unavailable ? (
            <div className="outline-empty">Graph unavailable — build the Rust Core.</div>
          ) : (
            <>
              <div className="deps-impact" title="Files transitively affected if this file changes">
                Impacts <strong>{impactCount}</strong> file{impactCount === 1 ? '' : 's'}
              </div>
              {graphSummary ? (
                <div className="deps-impact" title="Knowledge-graph neighborhood (PRD Phase 65)">
                  {'\uD83D\uDD78 '}
                  {graphSummary}
                </div>
              ) : null}
              {fullGraph ? (
                <div
                  className="deps-impact"
                  title="Whole-repo transitive analysis over the file-level knowledge graph (PRD Phase 65)"
                >
                  Repo graph: transitively impacts <strong>{fullGraph.impact}</strong>, depends on{' '}
                  <strong>{fullGraph.reach}</strong>
                </div>
              ) : null}
              {repoGraph?.symbols ? (
                <div
                  className="deps-impact"
                  title="Symbol-level knowledge graph — cross-file reference analysis (PRD Phase 65)"
                >
                  {'\uD83E\uDDE9 '}
                  {repoGraph.symbols.summary}
                </div>
              ) : null}
              {(() => {
                const m = computeFileMetrics({
                  fanIn: importedBy.length,
                  fanOut: imports.length,
                  impact: impactCount,
                });
                return (
                  <div
                    className={`deps-impact${m.hotspot ? ' status-warn' : ''}`}
                    title="Coupling + stability (PRD §127): instability = fan-out / (fan-in + fan-out)"
                  >
                    {m.label} — fan-in <strong>{m.fanIn}</strong>, fan-out{' '}
                    <strong>{m.fanOut}</strong>, instability <strong>{m.instability}</strong>
                  </div>
                );
              })()}
              <div className="deps-group-label">Imported by ({importedBy.length})</div>
              {importedBy.length === 0 ? (
                <div className="outline-empty">None</div>
              ) : (
                renderList(importedBy)
              )}
              <div className="deps-group-label">Imports ({imports.length})</div>
              {imports.length === 0 ? (
                <div className="outline-empty">None</div>
              ) : (
                renderList(imports)
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
