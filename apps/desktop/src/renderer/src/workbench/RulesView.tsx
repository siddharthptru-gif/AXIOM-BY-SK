import { useEffect, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { notifyInfo, notifyError } from '../notifications/bus';
import { ChevronIcon } from './treeIcons';
import type { Rule } from '../../../common/rules';

/**
 * Workspace rules panel (PRD Epoch H §145 / Phase 233). Lists the rules that shape
 * AI generation: workspace rules from `.axiom/rules/*.md` (+ imported AGENTS.md /
 * .cursorrules) and user-global rules. Global rules can be added/deleted here;
 * workspace rules are edited as files. Rules are injected into the chat system
 * prompt (guardrails non-overridable). Collapsed by default; loads on expand.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RulesView() {
  const { rootPath } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [rules, setRules] = useState<Rule[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [body, setBody] = useState('');
  const [guardrail, setGuardrail] = useState(false);

  const load = (): void => {
    void window.axiom.rules
      .list(rootPath ?? null)
      .then(setRules)
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!collapsed) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, rootPath]);

  const save = (): void => {
    if (name.trim().length === 0 || body.trim().length === 0) return;
    void window.axiom.rules
      .saveGlobal({
        name: name.trim(),
        body: body.trim(),
        guardrail,
        ...(scope.trim().length > 0 ? { scope: scope.trim() } : {}),
      })
      .then(() => {
        setName('');
        setScope('');
        setBody('');
        setGuardrail(false);
        setCreating(false);
        load();
        notifyInfo('Global rule saved.', { source: 'Rules' });
      })
      .catch((e) => notifyError('Could not save rule', { source: 'Rules', detail: detailOf(e) }));
  };

  const remove = (r: Rule): void => {
    void window.axiom.rules
      .deleteGlobal(r.id)
      .then(() => load())
      .catch((e) => notifyError('Could not delete rule', { source: 'Rules', detail: detailOf(e) }));
  };

  return (
    <div className="rules-view">
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
        <span className="oe-title">Rules</span>
        {!collapsed ? <span className="oe-count">{rules.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="rules-body">
          {rules.length === 0 ? (
            <div className="outline-empty">
              No rules. Add one, or create `.axiom/rules/*.md` in the workspace.
            </div>
          ) : (
            rules.map((r) => (
              <div key={r.id} className="rule-row">
                <div className="rule-head">
                  <span className="rule-name" title={r.body}>
                    {r.name}
                  </span>
                  {r.guardrail ? <span className="rule-badge is-guard">guardrail</span> : null}
                  <span className="rule-badge">{r.source}</span>
                  {r.source === 'global' ? (
                    <button
                      type="button"
                      className="rule-del"
                      title="Delete rule"
                      onClick={() => remove(r)}
                    >
                      {'\u00D7'}
                    </button>
                  ) : null}
                </div>
                {r.scope ? <div className="rule-scope">scope: {r.scope}</div> : null}
              </div>
            ))
          )}

          {creating ? (
            <div className="rule-form">
              <input
                className="rule-input"
                placeholder="Rule name"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="rule-input"
                placeholder="scope glob (optional, e.g. src/**/*.ts)"
                value={scope}
                spellCheck={false}
                onChange={(e) => setScope(e.target.value)}
              />
              <textarea
                className="rule-textarea"
                placeholder="Rule text (e.g. Always use async/await, never .then chains)"
                value={body}
                rows={3}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
              />
              <label className="rule-check">
                <input
                  type="checkbox"
                  checked={guardrail}
                  onChange={(e) => setGuardrail(e.target.checked)}
                />
                Guardrail (non-overridable, always applied)
              </label>
              <div className="rule-form-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={name.trim().length === 0 || body.trim().length === 0}
                  onClick={save}
                >
                  Save rule
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost rule-new"
              onClick={() => setCreating(true)}
            >
              {'\uFF0B'} Add global rule
            </button>
          )}
        </div>
      )}
    </div>
  );
}
