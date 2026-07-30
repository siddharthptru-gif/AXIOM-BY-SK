import { useEffect, useState } from 'react';
import type { FlagValue } from '../../../common/ipc';
import { ChevronIcon } from './treeIcons';

/**
 * Experiments panel (PRD Epoch E §57 / §167). Read-only view of resolved feature
 * flags (compiled defaults, later Realtime-overridable) so the user can see which
 * experiments/rollouts apply to this install. Collapsed by default; loads on expand.
 */
export function ExperimentsView() {
  const [collapsed, setCollapsed] = useState(true);
  const [flags, setFlags] = useState<Record<string, FlagValue>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (collapsed) return;
    let active = true;
    setError(null);
    window.axiom.featureFlags
      .all()
      .then((f) => {
        if (active) setFlags(f);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not load feature flags.');
      });
    return () => {
      active = false;
    };
  }, [collapsed]);

  const entries = Object.entries(flags).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="experiments-view">
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
        <span className="oe-title">Experiments</span>
        {!collapsed ? <span className="oe-count">{entries.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="experiments-body">
          {error ? (
            <div className="outline-empty" role="alert">
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="outline-empty">No flags.</div>
          ) : (
            entries.map(([k, v]) => (
              <div key={k} className="flag-row">
                <span className="flag-key" title={k}>
                  {k}
                </span>
                <span
                  className={`flag-val ${typeof v === 'boolean' ? (v ? 'on' : 'off') : 'other'}`}
                >
                  {String(v)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
