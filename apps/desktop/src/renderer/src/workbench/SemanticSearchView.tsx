import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreRetrieveResult } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { useLayout } from '../state/layout';
import { requestAiAction } from '../editor/aiActionBus';
import { notifyInfo } from '../notifications/bus';
import { ShieldIcon, SparkIcon } from './icons';

/**
 * Codebase semantic search (T2.8) — a first-class panel, not a checkbox.
 *
 * Ask in plain language ("where do we validate workspace trust?") and get ranked
 * passages from the Rust Core's on-device retrieval. Runs entirely locally: no
 * embedding provider, no upload, no account. That is the whole point — meaning-based
 * search over a private codebase, free.
 *
 * Beyond the raw hit list it does the two things that make retrieval useful:
 * results are grouped per file with a visible relevance bar (so a weak match reads
 * as weak instead of authoritative), and the whole result set can be handed to Ask
 * as an explicit question with the files attached.
 */
const DEBOUNCE_MS = 240;
const TOP_K_CHOICES = [10, 25, 50, 100] as const;
const MAX_ATTACHED_FILES = 12;

interface FileGroup {
  path: string;
  rel: string;
  name: string;
  best: number;
  hits: CoreRetrieveResult['results'];
}

function relTo(root: string, path: string): string {
  return path.startsWith(root)
    ? path
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/')
    : path;
}

/**
 * Group hits per file, preserving rank order. Core returns similarity scores whose
 * absolute scale is not meaningful to a user, so the bar is relative to the top hit.
 */
function groupHits(root: string, result: CoreRetrieveResult): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const hit of result.results) {
    const existing = groups.get(hit.path);
    if (existing) {
      existing.hits.push(hit);
      existing.best = Math.max(existing.best, hit.score);
      continue;
    }
    groups.set(hit.path, {
      path: hit.path,
      rel: relTo(root, hit.path),
      name: hit.path.split(/[\\/]/).pop() ?? hit.path,
      best: hit.score,
      hits: [hit],
    });
  }
  return [...groups.values()].sort((a, b) => b.best - a.best);
}

export function SemanticSearchView() {
  const { rootPath, openFileAt } = useWorkspace();
  const layout = useLayout();
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState<number>(25);
  const [result, setResult] = useState<CoreRetrieveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stateKey, setStateKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);

  const normalized = query.trim();
  const searchKey =
    rootPath && normalized.length > 0 ? JSON.stringify([rootPath, normalized, topK]) : null;
  const current = stateKey === searchKey;
  const visibleResult = current ? result : null;
  const visibleError = current ? error : null;
  const visibleLoading = current && loading;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = ++reqIdRef.current;
    const q = normalized;
    const root = rootPath;
    setStateKey(searchKey);
    setResult(null);
    setError(null);
    if (!root || !searchKey) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const live = (): boolean => !cancelled && reqIdRef.current === id;
    setLoading(true);
    const timer = setTimeout(() => {
      void window.axiom.core
        .retrieve(root, q, { topK })
        .then((res) => {
          if (!live()) return;
          setResult(res);
          setLoading(false);
        })
        .catch((cause: unknown) => {
          if (!live()) return;
          setError(
            `On-device retrieval failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // searchKey encodes root + query + topK; the rest are stable refs/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  const groups = useMemo(
    () => (rootPath && visibleResult ? groupHits(rootPath, visibleResult) : []),
    [rootPath, visibleResult],
  );
  const topScore = groups[0]?.best ?? 0;

  const toggleGroup = useCallback((path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /**
   * Hand the retrieved passages to Ask as evidence, with the user's own query as
   * the question. Only what is visible in this panel is sent, so the answer is
   * grounded in results the user can inspect.
   */
  const askAboutResults = useCallback((): void => {
    const root = rootPath;
    if (!root || groups.length === 0) return;
    const shown = groups.slice(0, MAX_ATTACHED_FILES);
    const evidence = shown
      .map((group) =>
        group.hits
          .slice(0, 3)
          .map((hit) => `--- ${group.rel}:${hit.startLine}\n${hit.preview}`)
          .join('\n'),
      )
      .join('\n');
    layout.showAiPanel();
    requestAiAction({
      kind: 'explain',
      question: `${normalized}\n\nAnswer using the retrieved passages below. Cite the file and line of each passage you rely on, and say so plainly if they do not contain the answer.`,
      code: evidence,
      fileLabel: `semantic search results (${shown.length} file${shown.length === 1 ? '' : 's'})`,
      language: 'text',
      startLine: 1,
      endLine: evidence.split('\n').length,
    });
    notifyInfo(`Asked Axiom AI about passages from ${shown.length} file(s).`, {
      source: 'Semantic Search',
    });
  }, [rootPath, groups, layout, normalized]);

  if (!rootPath) {
    return (
      <div className="empty-state">
        <span className="empty-state-eyebrow">Semantic search</span>
        <strong>No folder open</strong>
        <p>
          Open a folder to search it by meaning. Retrieval runs on your machine — no API key and no
          upload.
        </p>
      </div>
    );
  }

  return (
    <div className="semantic-view">
      <div className="semantic-head">
        <input
          ref={inputRef}
          className="semantic-input"
          aria-label="Search this codebase by meaning"
          placeholder="Describe what you're looking for…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="semantic-topk">
          <span>Results</span>
          <select
            value={topK}
            aria-label="Maximum number of results"
            onChange={(event) => setTopK(Number(event.target.value))}
          >
            {TOP_K_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="semantic-privacy">
        <ShieldIcon size={13} />
        On-device retrieval. Your code is never sent anywhere to run this search.
      </p>

      <div className="semantic-summary" role="status" aria-live="polite" aria-atomic="true">
        {visibleLoading ? (
          'Searching this codebase…'
        ) : visibleError ? (
          <span className="semantic-error">{visibleError}</span>
        ) : visibleResult === null ? (
          normalized.length === 0 ? (
            'Ask in plain language — for example, “where is workspace trust enforced?”'
          ) : null
        ) : visibleResult.count === 0 ? (
          'No related passages found. Try describing the behaviour rather than naming a symbol.'
        ) : (
          `${visibleResult.count} passage${visibleResult.count === 1 ? '' : 's'} across ${
            groups.length
          } file${groups.length === 1 ? '' : 's'}`
        )}
      </div>

      {groups.length > 0 ? (
        <div className="semantic-actions">
          <button
            type="button"
            className="btn btn-primary"
            title="Attach the top matching files and ask about them"
            onClick={askAboutResults}
          >
            <SparkIcon size={14} />
            Ask about these results
          </button>
        </div>
      ) : null}

      <div className="semantic-results" aria-busy={visibleLoading}>
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.path);
          const relative =
            topScore > 0 ? Math.max(4, Math.round((group.best / topScore) * 100)) : 0;
          return (
            <div key={group.path} className="semantic-group">
              <button
                type="button"
                className="semantic-group-head"
                aria-expanded={!isCollapsed}
                title={`${group.rel} · best relevance ${group.best.toFixed(3)}`}
                onClick={() => toggleGroup(group.path)}
              >
                <span className="semantic-group-name">{group.name}</span>
                <span className="semantic-group-dir">{group.rel}</span>
                <span className="semantic-score" aria-hidden="true">
                  <span className="semantic-score-fill" style={{ width: `${relative}%` }} />
                </span>
                <span className="semantic-group-count">{group.hits.length}</span>
              </button>
              {isCollapsed
                ? null
                : group.hits.map((hit, index) => (
                    <div
                      key={`${hit.path}:${hit.startLine}:${index}`}
                      className="semantic-hit"
                      role="button"
                      tabIndex={0}
                      title={`${group.rel}:${hit.startLine} · relevance ${hit.score.toFixed(3)}`}
                      onClick={() => openFileAt(hit.path, group.name, hit.startLine, 1)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openFileAt(hit.path, group.name, hit.startLine, 1);
                        }
                      }}
                    >
                      <span className="semantic-hit-line">{hit.startLine}</span>
                      <span className="semantic-hit-text">{hit.preview}</span>
                    </div>
                  ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
