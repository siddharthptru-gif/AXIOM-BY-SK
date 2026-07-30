import { useCallback, useState } from 'react';
import { ChevronIcon } from './treeIcons';
import { buildRepoTour, type RepoTour } from '../../../common/repoTour';
import { buildRepoReport, repoReportFileName } from '../../../common/repoReport';
import { useWorkspace } from '../state/workspace';
import { notifyError, notifyInfo } from '../notifications/bus';

/**
 * Repo Tour + "Explain this repo" report (PRD Phase 263 / T3.12).
 *
 * The tour derives a guided walk from the Rust Core's project-understanding profile.
 * "Explain this repo" goes further: it gathers the profile, the dependency graph
 * shape, and import cycles, then renders a Markdown overview through the pure
 * `common/repoReport` builder — locally, with no model call and no network. The
 * result can be exported to a file anywhere or copied.
 *
 * Collapsed by default; nothing runs until requested.
 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function RepoTourView() {
  const { rootPath, rootName } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [tour, setTour] = useState<RepoTour | null>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportName, setReportName] = useState('repo-overview.md');
  const [reporting, setReporting] = useState(false);

  const run = (): void => {
    if (!rootPath || loading) return;
    setLoading(true);
    void window.axiom.core.project
      .understand(rootPath)
      .then((p) => {
        setTour(
          buildRepoTour({
            languages: p.languages.map((l) => l.name),
            frameworks: p.frameworks,
            scripts: p.scripts.map((s) => s.name),
            entryPoints: p.entryPoints,
          }),
        );
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  /**
   * One-click repository explanation. Each analysis is independent and best-effort:
   * a graph or cycle failure produces an explicit "not analysed" section instead of
   * losing the whole report.
   */
  const explainRepo = useCallback((): void => {
    const root = rootPath;
    if (!root || reporting) return;
    setReporting(true);
    void (async () => {
      try {
        const profile = await window.axiom.core.project.understand(root);
        const [graphResult, cyclesResult] = await Promise.allSettled([
          window.axiom.core.graph.edges(root),
          window.axiom.core.graph.cycles(root),
        ]);
        const tourModel = buildRepoTour({
          languages: profile.languages.map((language) => language.name),
          frameworks: profile.frameworks,
          scripts: profile.scripts.map((script) => script.name),
          entryPoints: profile.entryPoints,
        });
        setTour(tourModel);
        const generatedAt = Date.now();
        const name = profile.name ?? rootName ?? baseName(root);
        const markdown = buildRepoReport({
          name,
          root,
          generatedAt,
          totalFiles: profile.totalFiles,
          languages: profile.languages,
          frameworks: profile.frameworks,
          packageManagers: profile.packageManagers,
          testFramework: profile.testFramework,
          scripts: profile.scripts,
          entryPoints: profile.entryPoints,
          monorepo: profile.monorepo,
          workspaces: profile.workspaces,
          graph:
            graphResult.status === 'fulfilled'
              ? {
                  nodes: graphResult.value.nodes.length,
                  edges: graphResult.value.edges.length,
                }
              : null,
          cycles:
            cyclesResult.status === 'fulfilled'
              ? { count: cyclesResult.value.count, examples: cyclesResult.value.cycles }
              : null,
          tour: tourModel.stops,
          tourSummary: tourModel.summary,
        });
        setReport(markdown);
        setReportName(repoReportFileName(name, generatedAt));
        notifyInfo('Repository overview ready. Export it as Markdown or copy it.', {
          source: 'Project Intelligence',
        });
      } catch (cause) {
        notifyError('Could not analyse this repository', {
          source: 'Project Intelligence',
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setReporting(false);
      }
    })();
  }, [rootPath, rootName, reporting]);

  const exportReport = useCallback((): void => {
    const markdown = report;
    if (!markdown) return;
    void (async () => {
      try {
        const target = await window.axiom.dialog.saveFile(reportName);
        if (!target) return;
        await window.axiom.fs.writeFile(target.path, markdown, null, target.canonicalIdentity);
        notifyInfo(`Saved ${target.name}.`, { source: 'Project Intelligence' });
      } catch (cause) {
        notifyError('Could not save the report', {
          source: 'Project Intelligence',
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
  }, [report, reportName]);

  const copyReport = useCallback((): void => {
    const markdown = report;
    if (!markdown) return;
    void window.axiom.system
      .copyText(markdown)
      .then(() => notifyInfo('Report copied as Markdown.', { source: 'Project Intelligence' }))
      .catch((cause: unknown) =>
        notifyError('Could not copy the report', {
          source: 'Project Intelligence',
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  }, [report]);

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
        <span className="oe-title">Repo Tour</span>
        {!collapsed && tour ? <span className="oe-count">{tour.stops.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="deps-body">
          <div className="repo-report-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!rootPath || loading}
              onClick={run}
            >
              {loading ? 'Building\u2026' : 'Build repo tour'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!rootPath || reporting}
              title="Analyse this repo locally and produce a Markdown overview"
              onClick={explainRepo}
            >
              {reporting ? 'Analysing\u2026' : 'Explain this repo'}
            </button>
          </div>

          {report ? (
            <div className="repo-report-card">
              <div className="repo-report-meta">
                {`Overview ready \u00B7 ${report.split('\n').length} lines \u00B7 ${reportName}`}
              </div>
              <div className="repo-report-buttons">
                <button type="button" className="btn btn-ghost" onClick={exportReport}>
                  {'Export Markdown\u2026'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={copyReport}>
                  Copy
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setReport(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          {!rootPath ? (
            <div className="outline-empty">Open a folder to tour the codebase.</div>
          ) : tour === null ? (
            <div className="outline-empty">
              Build a guided architecture tour, or generate a full Markdown overview of this repo.
            </div>
          ) : tour.stops.length === 0 ? (
            <div className="outline-empty">No tour available.</div>
          ) : (
            <>
              <div className="deps-impact">{tour.summary}</div>
              {tour.stops.map((s) => (
                <div key={s.order} className="dep-row" title={s.path ?? s.kind}>
                  <span className="dep-name">
                    {s.order + 1}. {s.title}
                  </span>
                  <span className="dep-dir">{s.description}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
