import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDiagnostics, type Diagnostic } from '../state/diagnostics';
import { useWorkspace } from '../state/workspace';
import { nextFocusIndex, rovingTabIndex } from '../../../common/focusNav';
import { requestAiAction } from '../editor/aiActionBus';
import { restartLspServer, subscribeLspServers } from '../editor/lsp';
import { notifyError } from '../notifications/bus';
import type { LspServerStatus } from '../../../common/ipc';

/**
 * Problems list (PRD Part VII §112). Diagnostics grouped by file; each row jumps
 * to the exact line/column, and every diagnostic can be handed to the AI to
 * explain or fix.
 *
 * The list is VIRTUALISED: a project-wide type error can produce thousands of
 * diagnostics, and rendering them all is what turns a panel into a stall. Only
 * the rows in view (plus a small overscan) exist in the DOM, so scrolling cost is
 * constant regardless of problem count.
 *
 * Keyboard-navigable as a single roving-tabindex listbox (PRD Phase 254): the
 * list is one Tab stop, Up/Down/Home/End/PageUp/PageDown move between rows, and
 * the focused row exposes its AI actions as additional tab stops.
 */
const SEVERITY_LABEL: Record<Diagnostic['severity'], string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};

/** Fixed row height, matched by CSS. Virtualisation needs a known geometry. */
const ROW_HEIGHT = 28;
/** Rows rendered beyond the viewport, so fast scrolling does not show gaps. */
const OVERSCAN = 8;
/** Lines of surrounding context handed to the AI with a diagnostic. */
const AI_CONTEXT_LINES = 6;

type Row =
  | { kind: 'file'; key: string; path: string; name: string; count: number; closed: boolean }
  | { kind: 'problem'; key: string; diagnostic: Diagnostic; focusIndex: number };

type SeverityFilter = Record<Diagnostic['severity'], boolean>;

export function ProblemsView() {
  const { diagnostics, errorCount, warningCount, infoCount } = useDiagnostics();
  const { openFileAt, rootPath } = useWorkspace();
  const [focusIndex, setFocusIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [severities, setSeverities] = useState<SeverityFilter>({
    error: true,
    warning: true,
    info: true,
  });
  const [servers, setServers] = useState<LspServerStatus[]>([]);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);

  useEffect(() => subscribeLspServers(setServers), []);

  // Track the scroller's height so the visible window is computed from reality
  // rather than a guess (the panel is user-resizable).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (typeof height === 'number' && height > 0) setViewportHeight(height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return diagnostics.filter((d) => {
      if (!severities[d.severity]) return false;
      if (needle.length === 0) return true;
      return (
        d.message.toLowerCase().includes(needle) ||
        d.name.toLowerCase().includes(needle) ||
        (d.source ?? '').toLowerCase().includes(needle) ||
        (d.code ?? '').toLowerCase().includes(needle)
      );
    });
  }, [diagnostics, query, severities]);

  const relPath = useCallback(
    (path: string): string => {
      if (rootPath && path.toLowerCase().startsWith(rootPath.toLowerCase())) {
        return path.slice(rootPath.length).replace(/^[\\/]/, '');
      }
      return path;
    },
    [rootPath],
  );

  // One flat row list: file headers interleaved with their problems. Flattening
  // is what makes a windowed render possible while keeping visual grouping.
  const { rows, total } = useMemo(() => {
    const groups = new Map<string, { name: string; closed: boolean; items: Diagnostic[] }>();
    for (const d of filtered) {
      const group = groups.get(d.path) ?? { name: d.name, closed: d.closed, items: [] };
      group.items.push(d);
      groups.set(d.path, group);
    }
    const out: Row[] = [];
    let focusable = 0;
    for (const [path, group] of groups) {
      out.push({
        kind: 'file',
        key: `file:${path}`,
        path,
        name: group.name,
        count: group.items.length,
        closed: group.closed,
      });
      for (const [index, diagnostic] of group.items.entries()) {
        out.push({
          kind: 'problem',
          key: `${path}:${diagnostic.line}:${diagnostic.column}:${index}`,
          diagnostic,
          focusIndex: focusable,
        });
        focusable += 1;
      }
    }
    return { rows: out, total: focusable };
  }, [filtered]);

  const activeIndex = focusIndex >= 0 && focusIndex < total ? focusIndex : 0;

  /** Row offset of each focusable problem, so keyboard focus can scroll to it. */
  const rowOffsetForFocusIndex = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach((row, offset) => {
      if (row.kind === 'problem') map.set(row.focusIndex, offset);
    });
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    return { first, last: Math.min(rows.length, first + count) };
  }, [rows.length, scrollTop, viewportHeight]);

  /**
   * Hand a diagnostic to the AI. The file is read from disk so this works for
   * problems in files that are not open, which is exactly when an explanation is
   * most useful.
   */
  const runAi = useCallback(async (d: Diagnostic, mode: 'explain' | 'fix'): Promise<void> => {
    let content = '';
    try {
      content = (await window.axiom.fs.readFile(d.path)).content;
    } catch {
      notifyError(`Could not read ${d.name} to explain this problem.`, { source: 'Problems' });
      return;
    }
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, d.line - AI_CONTEXT_LINES);
    const end = Math.min(lines.length, d.endLine + AI_CONTEXT_LINES);
    const snippet = lines.slice(start - 1, end).join('\n');
    const label = d.code === undefined ? '' : ` [${d.code}]`;
    const where = `${d.name}:${d.line}:${d.column}`;
    const question =
      mode === 'explain'
        ? `Explain this ${SEVERITY_LABEL[d.severity].toLowerCase()} at ${where}: ${d.message}${label}` +
          `${d.source ? ` (reported by ${d.source})` : ''}.\n\n` +
          'Cover why it happens, how to fix it, the best practice, and show a corrected example.'
        : `Fix this ${SEVERITY_LABEL[d.severity].toLowerCase()} at ${where}: ${d.message}${label}` +
          `${d.source ? ` (reported by ${d.source})` : ''}.\n\nReturn the corrected code.`;
    requestAiAction({
      kind: mode === 'explain' ? 'explain' : 'fix',
      code: snippet,
      fileLabel: d.name,
      language: '',
      startLine: start,
      endLine: end,
      question,
    });
  }, []);

  const focusRow = useCallback(
    (next: number): void => {
      setFocusIndex(next);
      const offset = rowOffsetForFocusIndex.get(next);
      const scroller = scrollRef.current;
      if (offset !== undefined && scroller) {
        const top = offset * ROW_HEIGHT;
        if (top < scroller.scrollTop) scroller.scrollTop = top;
        else if (top + ROW_HEIGHT > scroller.scrollTop + viewportHeight) {
          scroller.scrollTop = top + ROW_HEIGHT - viewportHeight;
        }
      }
      // The row may not be mounted yet if it was outside the window; focus after
      // the scroll-driven re-render places it in the DOM.
      requestAnimationFrame(() => rowRefs.current.get(next)?.focus());
    },
    [rowOffsetForFocusIndex, viewportHeight],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = nextFocusIndex(activeIndex, total, e.key, { orientation: 'vertical' });
    if (next < 0) return;
    e.preventDefault();
    focusRow(next);
  };

  const toggleSeverity = (severity: Diagnostic['severity']): void => {
    setSeverities((current) => ({ ...current, [severity]: !current[severity] }));
  };

  const failedServers = servers.filter((s) => s.state === 'failed');

  const filterBar = (
    <div className="problems-toolbar">
      <input
        type="search"
        className="problems-filter"
        value={query}
        placeholder="Filter problems"
        aria-label="Filter problems"
        onChange={(e) => setQuery(e.target.value)}
      />
      {(['error', 'warning', 'info'] as const).map((severity) => {
        const count =
          severity === 'error' ? errorCount : severity === 'warning' ? warningCount : infoCount;
        return (
          <button
            key={severity}
            type="button"
            className="problems-sev-toggle"
            aria-pressed={severities[severity]}
            title={`${severities[severity] ? 'Hide' : 'Show'} ${SEVERITY_LABEL[severity].toLowerCase()}s`}
            onClick={() => toggleSeverity(severity)}
          >
            <span className={`problem-sev problem-sev-${severity}`} aria-hidden="true" />
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );

  // A failed language server is the usual reason a file looks clean when it is
  // not, so say so instead of showing an empty, reassuring panel.
  const serverNotice =
    failedServers.length === 0 ? null : (
      <div className="problems-servers">
        {failedServers.map((server) => (
          <div key={server.id} className="problems-server">
            <span className="problem-sev problem-sev-warning" aria-hidden="true" />
            <span className="problems-server-name">{server.displayName}</span>
            <span className="problems-server-detail">{server.detail}</span>
            {server.external ? null : (
              <button
                type="button"
                className="problems-server-restart"
                onClick={() => void restartLspServer(server.id)}
              >
                Restart
              </button>
            )}
          </div>
        ))}
      </div>
    );

  if (filtered.length === 0) {
    return (
      <div className="problems-list">
        {filterBar}
        {serverNotice}
        <div className="panel-empty">
          {diagnostics.length === 0
            ? 'No problems have been detected in this workspace.'
            : 'No problems match the current filter.'}
        </div>
      </div>
    );
  }

  return (
    <div className="problems-list">
      {filterBar}
      {serverNotice}
      <div
        className="problems-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          role="listbox"
          aria-label="Problems"
          aria-setsize={total}
          onKeyDown={onKeyDown}
          className="problems-virtual"
          style={{ height: rows.length * ROW_HEIGHT }}
        >
          {rows.slice(visible.first, visible.last).map((row, offset) => {
            const top = (visible.first + offset) * ROW_HEIGHT;
            if (row.kind === 'file') {
              return (
                <div
                  key={row.key}
                  className="problems-file"
                  style={{ top }}
                  title={row.path}
                  role="presentation"
                >
                  <span className="problems-file-name">{row.name}</span>
                  <span className="problems-file-path">{relPath(row.path)}</span>
                  {row.closed ? (
                    <span className="problems-file-closed" title="This file is not open">
                      not open
                    </span>
                  ) : null}
                  <span className="problems-file-count">{row.count}</span>
                </div>
              );
            }
            const d = row.diagnostic;
            const selected = row.focusIndex === activeIndex;
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={selected}
                aria-posinset={row.focusIndex + 1}
                tabIndex={rovingTabIndex(row.focusIndex, activeIndex)}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.focusIndex, el);
                  else rowRefs.current.delete(row.focusIndex);
                }}
                className="problem-row"
                style={{ top }}
                onFocus={() => setFocusIndex(row.focusIndex)}
                onClick={() => openFileAt(d.path, d.name, d.line, d.column)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  openFileAt(d.path, d.name, d.line, d.column);
                }}
              >
                <span
                  className={`problem-sev problem-sev-${d.severity}`}
                  title={SEVERITY_LABEL[d.severity]}
                  aria-label={SEVERITY_LABEL[d.severity]}
                />
                <span className="problem-message">{d.message}</span>
                {d.code ? <span className="problem-code">{d.code}</span> : null}
                {d.source ? <span className="problem-source">{d.source}</span> : null}
                <span className="problem-loc">
                  Ln {d.line}, Col {d.column}
                </span>
                <span className="problem-actions">
                  <button
                    type="button"
                    className="problem-action"
                    tabIndex={selected ? 0 : -1}
                    title="Explain this problem with Axiom AI"
                    onClick={(e) => {
                      e.stopPropagation();
                      void runAi(d, 'explain');
                    }}
                  >
                    Explain
                  </button>
                  <button
                    type="button"
                    className="problem-action"
                    tabIndex={selected ? 0 : -1}
                    title="Ask Axiom AI to fix this problem"
                    onClick={(e) => {
                      e.stopPropagation();
                      void runAi(d, 'fix');
                    }}
                  >
                    Fix
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
