import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { monaco } from '../editor/monacoEnv';
import { useWorkspace } from './workspace';

/**
 * Diagnostics (PRD Part VII §112). Surfaces every Monaco marker — the language
 * servers' errors, warnings and hints, plus anything Monaco itself computes —
 * into the Problems panel and status bar.
 *
 * Two things this store deliberately does:
 *
 *   • It keeps diagnostics for files that are NOT open in a tab. A rename or an
 *     agent edit can break a file the user is not looking at; dropping those
 *     markers made the Problems panel a view of the open editors rather than a
 *     view of the project.
 *   • It preserves the marker's `source`, rule `code` and tags, so the panel can
 *     show which server reported a problem and which rule fired.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  path: string;
  name: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string | undefined;
  /** Rule / error code, when the server supplied one. */
  code?: string | undefined;
  /** Documentation URL for the rule behind this diagnostic. */
  codeHref?: string | undefined;
  /** True when the file is not currently open in an editor tab. */
  closed: boolean;
  /** LSP DiagnosticTag values (1 unnecessary, 2 deprecated). */
  tags?: number[] | undefined;
}

interface RawMarker {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string | undefined;
  code?: string | undefined;
  codeHref?: string | undefined;
  tags?: number[] | undefined;
}

interface DiagnosticsValue {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

const DiagnosticsContext = createContext<DiagnosticsValue | null>(null);

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function toSeverity(severity: number): DiagnosticSeverity {
  if (severity === monaco.MarkerSeverity.Error) return 'error';
  if (severity === monaco.MarkerSeverity.Warning) return 'warning';
  return 'info';
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Monaco's marker code is either a bare string or a value + documentation link. */
function readCode(code: monaco.editor.IMarker['code']): {
  code?: string | undefined;
  href?: string | undefined;
} {
  if (code === undefined) return {};
  if (typeof code === 'string') return { code };
  return { code: code.value, href: code.target.toString() };
}

export function DiagnosticsProvider({ children }: { children: ReactNode }) {
  const { groups } = useWorkspace();
  const tabs = useMemo(() => groups.flatMap((g) => g.tabs), [groups]);
  const [markers, setMarkers] = useState<RawMarker[]>([]);

  useEffect(() => {
    const refresh = (): void => {
      const next = monaco.editor
        .getModelMarkers({})
        .filter((m) => m.severity >= monaco.MarkerSeverity.Info)
        .map<RawMarker>((m) => {
          const { code, href } = readCode(m.code);
          return {
            path: m.resource.fsPath,
            line: m.startLineNumber,
            column: m.startColumn,
            endLine: m.endLineNumber,
            endColumn: m.endColumn,
            severity: toSeverity(m.severity),
            message: m.message,
            source: m.source,
            code,
            codeHref: href,
            tags: m.tags ? [...m.tags] : undefined,
          };
        });
      setMarkers(next);
    };
    refresh();
    const sub = monaco.editor.onDidChangeMarkers(() => refresh());
    return () => sub.dispose();
  }, []);

  // Canonical tab metadata keyed by normalized path (Windows drive-letter casing
  // means the raw marker path and the tab path can differ for the same file).
  const tabByNorm = useMemo(() => {
    const map = new Map<string, { path: string; name: string }>();
    for (const t of tabs) map.set(normPath(t.path), { path: t.path, name: t.name });
    return map;
  }, [tabs]);

  const diagnostics = useMemo<Diagnostic[]>(() => {
    const out: Diagnostic[] = [];
    for (const m of markers) {
      const tab = tabByNorm.get(normPath(m.path));
      out.push(
        tab
          ? { ...m, path: tab.path, name: tab.name, closed: false }
          : { ...m, name: baseName(m.path), closed: true },
      );
    }
    // Open editors first, then by path/line, so the file being worked on leads.
    out.sort(
      (a, b) =>
        Number(a.closed) - Number(b.closed) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.column - b.column,
    );
    return out;
  }, [markers, tabByNorm]);

  const value = useMemo<DiagnosticsValue>(() => {
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    for (const d of diagnostics) {
      if (d.severity === 'error') errorCount += 1;
      else if (d.severity === 'warning') warningCount += 1;
      else infoCount += 1;
    }
    return { diagnostics, errorCount, warningCount, infoCount };
  }, [diagnostics]);

  return <DiagnosticsContext.Provider value={value}>{children}</DiagnosticsContext.Provider>;
}

export function useDiagnostics(): DiagnosticsValue {
  const ctx = useContext(DiagnosticsContext);
  if (!ctx) throw new Error('useDiagnostics must be used within DiagnosticsProvider');
  return ctx;
}
