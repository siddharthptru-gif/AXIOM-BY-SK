import { useEffect, useRef, useState } from 'react';
import type { AuditEvent, AuditVerifyResult } from '../../../common/ipc';
import { ChevronIcon } from './treeIcons';

/**
 * Audit Log panel (PRD Part IV §56 / Part X §187). Surfaces the local, append-only,
 * hash-chained audit log (agent runs + approvals, provider/secret config changes)
 * with a tamper-evidence badge from verifying the chain. Collapsed by default so
 * it only loads on demand. Read-only + local; never shows secrets or code.
 */
function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function AuditView() {
  const [collapsed, setCollapsed] = useState(true);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const load = (): void => {
    const id = ++reqRef.current;
    setLoading(true);
    Promise.all([window.axiom.audit.read(200), window.axiom.audit.verify()])
      .then(([list, v]) => {
        if (reqRef.current !== id) return;
        setEvents([...list].reverse()); // most recent first
        setVerify(v);
        setLoading(false);
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setLoading(false);
      });
  };

  useEffect(() => {
    if (!collapsed) load();
  }, [collapsed]);

  return (
    <div className="audit-view">
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
        <span className="oe-title">Audit Log</span>
        {!collapsed && verify ? (
          <span
            className={`audit-badge ${verify.ok ? 'ok' : 'bad'}`}
            title={
              verify.ok
                ? 'Chain intact (tamper-evident)'
                : `Tampering detected at #${verify.brokenAt}`
            }
          >
            {verify.ok ? `\u2713 ${verify.count}` : `\u26A0 #${verify.brokenAt}`}
          </span>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="audit-body">
          {loading ? (
            <div className="outline-empty">{'Loading\u2026'}</div>
          ) : events.length === 0 ? (
            <div className="outline-empty">No audit events yet.</div>
          ) : (
            <>
              <div className="audit-actions">
                <button type="button" className="btn btn-ghost" onClick={load}>
                  Refresh
                </button>
              </div>
              {events.map((e) => (
                <div key={e.seq} className="audit-row" title={fmtTime(e.ts)}>
                  <span className="audit-type">{e.type}</span>
                  <span className="audit-summary">{e.summary}</span>
                  <span className="audit-time">{fmtTime(e.ts)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
