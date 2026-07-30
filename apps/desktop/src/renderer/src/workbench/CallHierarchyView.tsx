import { Fragment, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon } from './treeIcons';
import { setCallHierarchyListener, type CallHierarchyRequest } from '../editor/callHierarchyBus';
import {
  buildCallHierarchy,
  type CallHierarchy,
  type RefLocation,
} from '../../../common/callHierarchy';

/**
 * Call Hierarchy panel (PRD Epoch D — Phase 95). Shows the incoming references
 * ("callers") of the symbol under the cursor, resolved through the language
 * server, grouped by file and sorted by reference count. Each row jumps to the
 * exact line/column. The editor action publishes the raw references on the
 * call-hierarchy bus; this panel owns the workspace root and builds the grouped
 * view with the pure `buildCallHierarchy`. It stays hidden until the first
 * request arrives, then sits at the bottom of the Explorer like the other panels.
 *
 * Scope: incoming references only — outgoing calls and a full Monaco
 * call-hierarchy provider are not implemented (Phase 95 remains partial).
 */

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function CallHierarchyView() {
  const { rootPath, openFileAt } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [hierarchy, setHierarchy] = useState<CallHierarchy | null>(null);
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;

  useEffect(
    () =>
      setCallHierarchyListener((req: CallHierarchyRequest) => {
        setHierarchy(buildCallHierarchy(req.symbol, req.refs, rootPathRef.current ?? ''));
        setCollapsed(false);
      }),
    [],
  );

  if (!hierarchy) return null;

  const jump = (loc: RefLocation): void =>
    openFileAt(loc.path, baseName(loc.path), loc.line, loc.column);

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
        <span className="oe-title">Call Hierarchy</span>
        <span className="oe-count" title="Total references">
          {hierarchy.totalRefs}
        </span>
      </div>

      {collapsed ? null : (
        <div className="deps-body">
          <div className="deps-impact" title="The symbol whose callers are shown">
            Callers of <strong>{hierarchy.symbol}</strong> — {hierarchy.totalRefs} reference
            {hierarchy.totalRefs === 1 ? '' : 's'} in {hierarchy.fileCount} file
            {hierarchy.fileCount === 1 ? '' : 's'}
          </div>
          {hierarchy.files.length === 0 ? (
            <div className="outline-empty">No references found.</div>
          ) : (
            hierarchy.files.map((file) => (
              <Fragment key={file.path}>
                <div className="deps-group-label" title={file.rel}>
                  {baseName(file.path)} ({file.count})
                </div>
                {file.locations.map((loc, i) => (
                  <div
                    key={`${loc.line}:${loc.column}:${i}`}
                    className="dep-row"
                    role="button"
                    tabIndex={0}
                    title={`${file.rel}:${loc.line}:${loc.column}`}
                    onClick={() => jump(loc)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        jump(loc);
                      }
                    }}
                  >
                    <span className="dep-name">Line {loc.line}</span>
                    <span className="dep-dir">col {loc.column}</span>
                  </div>
                ))}
              </Fragment>
            ))
          )}
        </div>
      )}
    </div>
  );
}
