import { useState } from 'react';
import type { ReviewFinding } from '../../../common/review';
import { useSettings } from '../settings/store';
import { getAiSettings } from '../settings/schema';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon } from './treeIcons';

/**
 * Code Review panel (PRD Epoch H §135 / Phase 222). Runs the review agent on the
 * active file and lists structured, severity-tagged findings (blocker/major/minor/
 * nit) with category, line, rationale, and a suggested fix; clicking a finding
 * jumps to its line. Read-only — suggestions are applied through the normal flow.
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
  return baseName(p);
}

export function ReviewView() {
  const { values } = useSettings();
  const ai = getAiSettings(values);
  const { activePath, rootPath, openFileAt } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [findings, setFindings] = useState<ReviewFinding[] | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = (): void => {
    if (!activePath || loading) return;
    setLoading(true);
    setError(null);
    setFindings(null);
    setVerdict(null);
    const path = activePath;
    window.axiom.fs
      .readFile(path)
      .then((f) =>
        window.axiom.ai.review({
          provider: ai.provider,
          model: ai.model,
          baseUrl: ai.baseUrl,
          headers: {},
          code: f.content,
          label: relTo(rootPath, path),
        }),
      )
      .then((res) => {
        setFindings(res.findings);
        setVerdict(res.verdictSummary ?? null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  };

  return (
    <div className="review-view">
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
        <span className="oe-title">Code Review</span>
        {!collapsed && findings ? <span className="oe-count">{findings.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="review-body">
          <div className="review-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!activePath || loading}
              onClick={review}
            >
              {loading ? 'Reviewing\u2026' : 'Review active file'}
            </button>
          </div>
          {verdict && findings ? (
            <div className="deps-impact" title="Debate/critic verdict (PRD Phase 257)">
              {verdict}
            </div>
          ) : null}
          {error ? (
            <div className="review-error">{error}</div>
          ) : findings === null ? (
            <div className="outline-empty">Review the active file for issues.</div>
          ) : findings.length === 0 ? (
            <div className="outline-empty">No issues found.</div>
          ) : (
            findings.map((f, i) => (
              <div
                key={i}
                className="review-row"
                role={f.line ? 'button' : undefined}
                tabIndex={f.line ? 0 : undefined}
                onClick={() => {
                  if (f.line && activePath) openFileAt(activePath, baseName(activePath), f.line, 1);
                }}
              >
                <span className={`review-sev review-sev-${f.severity}`}>{f.severity}</span>
                <div className="review-main">
                  <div className="review-title">
                    {f.title}
                    {f.line ? ` \u00b7 L${f.line}` : ''}
                  </div>
                  <div className="review-detail">{f.detail}</div>
                  {f.suggestion ? <div className="review-suggestion">{f.suggestion}</div> : null}
                </div>
                <span className="review-cat">{f.category}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
