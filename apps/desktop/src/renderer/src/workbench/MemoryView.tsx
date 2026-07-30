import { useEffect, useRef, useState } from 'react';
import type { MemoryEntry } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { ChevronIcon } from './treeIcons';

/**
 * Memory panel (PRD Epoch F §70). Lets the user curate long-term memory —
 * global or per-workspace notes the AI is grounded on. Add, pin (always kept),
 * and forget. Local only (INV-4); collapsed by default, loads on expand. Relevant
 * memories are auto-injected into chat context at send time.
 */
export function MemoryView() {
  const { rootPath } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [draft, setDraft] = useState('');
  const reqRef = useRef(0);

  const load = (): void => {
    const id = ++reqRef.current;
    window.axiom.memory
      .list()
      .then((list) => {
        if (reqRef.current === id) setEntries(list);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!collapsed) load();
  }, [collapsed]);

  const visible = entries.filter((e) => e.scope === 'global' || e.workspaceKey === rootPath);

  const add = (): void => {
    const t = draft.trim();
    if (!t) return;
    const scope = rootPath ? 'workspace' : 'global';
    void window.axiom.memory
      .add(t, scope, rootPath ?? null)
      .then(setEntries)
      .catch(() => undefined);
    setDraft('');
  };
  const togglePin = (e: MemoryEntry): void => {
    void window.axiom.memory
      .update(e.id, { pinned: !e.pinned })
      .then(setEntries)
      .catch(() => undefined);
  };
  const forget = (e: MemoryEntry): void => {
    void window.axiom.memory
      .remove(e.id)
      .then(setEntries)
      .catch(() => undefined);
  };

  return (
    <div className="memory-view">
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
        <span className="oe-title">Memory</span>
        {!collapsed ? <span className="oe-count">{visible.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="memory-body">
          <div className="memory-add">
            <input
              className="memory-input"
              value={draft}
              spellCheck={false}
              placeholder={'Remember something\u2026'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button type="button" className="btn btn-ghost" disabled={!draft.trim()} onClick={add}>
              Add
            </button>
          </div>
          {visible.length === 0 ? (
            <div className="outline-empty">No memories yet.</div>
          ) : (
            visible.map((e) => (
              <div key={e.id} className="memory-row">
                <button
                  type="button"
                  className={`memory-pin ${e.pinned ? 'on' : ''}`}
                  title={e.pinned ? 'Unpin' : 'Pin (always kept)'}
                  onClick={() => togglePin(e)}
                >
                  {e.pinned ? '\u2605' : '\u2606'}
                </button>
                <span className="memory-text" title={e.text}>
                  {e.text}
                </span>
                <span className="memory-scope">{e.scope === 'workspace' ? 'ws' : 'global'}</span>
                <button
                  type="button"
                  className="memory-del"
                  title="Forget"
                  onClick={() => forget(e)}
                >
                  {'\u00D7'}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
