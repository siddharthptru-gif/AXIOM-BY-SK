import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CoreRetrieveResult, SearchResult } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon, FileIcon } from './treeIcons';

/**
 * Cross-file search view (PRD Part VII §105). Debounced query with case / word /
 * regex options; results grouped per file; clicking a match opens the file and
 * jumps to the line. Backed by the Main search service over IPC.
 */

const DEBOUNCE_MS = 220;

function renderPreview(preview: string, start: number, length: number): ReactNode {
  // Trim leading indentation for compact rows, keeping the highlight aligned.
  const leading = preview.length - preview.trimStart().length;
  const text = preview.slice(leading);
  const s = Math.max(0, start - leading);
  const before = text.slice(0, s);
  const mid = text.slice(s, s + length);
  const after = text.slice(s + length);
  return (
    <>
      {before}
      <mark className="search-hi">{mid}</mark>
      {after}
    </>
  );
}

function OptionToggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`search-opt ${active ? 'active' : ''}`}
      title={title}
      aria-pressed={active}
      aria-label={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function SearchView() {
  const { rootPath, openFileAt } = useWorkspace();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [coreMode, setCoreMode] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [coreResult, setCoreResult] = useState<CoreRetrieveResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchStateKey, setSearchStateKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const normalizedQuery = query.trim();
  const searchKey =
    rootPath && normalizedQuery.length > 0
      ? JSON.stringify([rootPath, normalizedQuery, caseSensitive, wholeWord, regex, coreMode])
      : null;
  const searchStateCurrent = searchStateKey === searchKey;
  const visibleResult = searchStateCurrent ? result : null;
  const visibleCoreResult = searchStateCurrent ? coreResult : null;
  const visibleError = searchStateCurrent ? searchError : null;
  const visibleLoading = searchStateCurrent && loading;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = ++reqIdRef.current;
    const q = normalizedQuery;
    setSearchStateKey(searchKey);
    setResult(null);
    setCoreResult(null);
    setSearchError(null);
    if (!rootPath || !searchKey) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const current = (): boolean => !cancelled && reqIdRef.current === id;
    setLoading(true);
    const timer = setTimeout(() => {
      if (coreMode) {
        // On-device lexical-similarity retrieval via Rust Core (INV-4: code never leaves).
        void window.axiom.core
          .retrieve(rootPath, q, { topK: 40 })
          .then((res) => {
            if (!current()) return;
            setCoreResult(res);
            setLoading(false);
          })
          .catch((error: unknown) => {
            if (!current()) return;
            const detail = error instanceof Error ? error.message : String(error);
            setSearchError(`Core search failed: ${detail}. Check the workspace and try again.`);
            setLoading(false);
          });
      } else {
        void window.axiom.fs
          .search(rootPath, q, { caseSensitive, wholeWord, regex })
          .then((res) => {
            if (!current()) return;
            if (res.error) {
              setSearchError(`Search failed: ${res.error}`);
            } else {
              setResult(res);
            }
            setLoading(false);
          })
          .catch((error: unknown) => {
            if (!current()) return;
            const detail = error instanceof Error ? error.message : String(error);
            setSearchError(`Search failed: ${detail}. Check the workspace and try again.`);
            setLoading(false);
          });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchKey]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (!rootPath) {
    return (
      <div className="empty-state">
        <p>Open a folder to search across its files.</p>
      </div>
    );
  }

  const summary = (): ReactNode => {
    if (visibleLoading) return coreMode ? 'Retrieving lexical matches…' : 'Searching…';
    if (visibleError) return <span className="search-error">{visibleError}</span>;
    if (coreMode) {
      if (!visibleCoreResult) return null;
      if (visibleCoreResult.count === 0) return 'No lexical similarity matches found';
      return `${visibleCoreResult.count} lexical similarity ${visibleCoreResult.count === 1 ? 'match' : 'matches'}`;
    }
    if (!visibleResult) return null;
    if (visibleResult.totalMatches === 0) return 'No results found';
    const fileWord = visibleResult.files.length === 1 ? 'file' : 'files';
    return `${visibleResult.totalMatches}${visibleResult.truncated ? '+' : ''} results in ${visibleResult.files.length} ${fileWord}`;
  };

  return (
    <div className="search-view">
      <div className="search-input-row">
        <input
          ref={inputRef}
          className="search-input"
          aria-label="Search files"
          placeholder="Search"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="search-opts">
          <OptionToggle
            label="Aa"
            title="Match Case"
            active={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
          />
          <OptionToggle
            label="ab"
            title="Match Whole Word"
            active={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
          />
          <OptionToggle
            label=".*"
            title="Use Regular Expression"
            active={regex}
            onClick={() => setRegex((v) => !v)}
          />
          <OptionToggle
            label="Core"
            title="Core search (on-device lexical similarity) — code never leaves your machine"
            active={coreMode}
            onClick={() => setCoreMode((v) => !v)}
          />
        </div>
      </div>

      <div className="search-summary" role="status" aria-live="polite" aria-atomic="true">
        {summary()}
      </div>

      <div className="search-results" aria-busy={visibleLoading}>
        {coreMode
          ? visibleCoreResult?.results.map((hit, i) => {
              const name = hit.path.split(/[\\/]/).pop() ?? hit.path;
              const rel =
                rootPath && hit.path.startsWith(rootPath)
                  ? hit.path
                      .slice(rootPath.length)
                      .replace(/^[\\/]+/, '')
                      .replace(/\\/g, '/')
                  : hit.path;
              return (
                <div
                  key={`${hit.path}:${hit.startLine}:${i}`}
                  className="search-match sem-hit"
                  role="button"
                  tabIndex={0}
                  title={`${rel}:${hit.startLine} · score ${hit.score.toFixed(3)}`}
                  onClick={() => openFileAt(hit.path, name, hit.startLine, 1)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openFileAt(hit.path, name, hit.startLine, 1);
                    }
                  }}
                >
                  <span className="search-match-line">{hit.startLine}</span>
                  <span className="search-match-text">
                    <span className="sem-hit-head">
                      {rel} · {hit.score.toFixed(2)}
                    </span>{' '}
                    {hit.preview}
                  </span>
                </div>
              );
            })
          : visibleResult
            ? visibleResult.files.map((file) => {
                const isCollapsed = collapsed.has(file.path);
                return (
                  <div key={file.path} className="search-file">
                    <div
                      className="search-file-head"
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleCollapsed(file.path)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleCollapsed(file.path);
                        }
                      }}
                    >
                      <span className="search-file-chevron">
                        <ChevronIcon open={!isCollapsed} />
                      </span>
                      <span className="search-file-icon">
                        <FileIcon />
                      </span>
                      <span className="search-file-name">{file.name}</span>
                      <span className="search-file-dir">{file.rel}</span>
                      <span className="search-file-count">{file.matches.length}</span>
                    </div>
                    {isCollapsed
                      ? null
                      : file.matches.map((match, i) => (
                          <div
                            key={`${file.path}:${match.line}:${match.column}:${i}`}
                            className="search-match"
                            role="button"
                            tabIndex={0}
                            title={`${file.rel}:${match.line}:${match.column}`}
                            onClick={() =>
                              openFileAt(file.path, file.name, match.line, match.column)
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openFileAt(file.path, file.name, match.line, match.column);
                              }
                            }}
                          >
                            <span className="search-match-line">{match.line}</span>
                            <span className="search-match-text">
                              {renderPreview(match.preview, match.matchStart, match.matchLength)}
                            </span>
                          </div>
                        ))}
                  </div>
                );
              })
            : null}
      </div>
    </div>
  );
}
