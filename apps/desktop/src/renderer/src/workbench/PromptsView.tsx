import { useEffect, useMemo, useState } from 'react';
import { notifyInfo, notifyError } from '../notifications/bus';
import { ChevronIcon } from './treeIcons';
import { searchPrompts, type PromptTemplate } from '../../../common/promptLibrary';

/**
 * Prompt library panel (PRD Epoch H §146 / Phase 234). Save reusable prompts (with
 * `{{variables}}` and tags), search them, copy one to the clipboard, and delete.
 * Prompts are also insertable directly from the chat composer's prompt picker.
 * Collapsed by default; loads on expand.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function PromptsView() {
  const [collapsed, setCollapsed] = useState(true);
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');

  const load = (): void => {
    void window.axiom.prompts
      .list()
      .then(setPrompts)
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!collapsed) load();
  }, [collapsed]);

  const results = useMemo(() => searchPrompts(prompts, query), [prompts, query]);

  const save = (): void => {
    if (name.trim().length === 0 || body.trim().length === 0) return;
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    void window.axiom.prompts
      .save({ name: name.trim(), body: body.trim(), tags: tagList, scope: 'global' })
      .then((list) => {
        setPrompts(list);
        setName('');
        setBody('');
        setTags('');
        setCreating(false);
        notifyInfo('Prompt saved.', { source: 'Prompts' });
      })
      .catch((e) =>
        notifyError('Could not save prompt', { source: 'Prompts', detail: detailOf(e) }),
      );
  };

  const copy = (p: PromptTemplate): void => {
    void window.axiom.system
      .copyText(p.body)
      .then(() => {
        notifyInfo(
          `Copied "${p.name}"${p.variables.length ? ' (fill in the {{variables}})' : ''}`,
          {
            source: 'Prompts',
          },
        );
        void window.axiom.prompts
          .recordUse(p.id)
          .then(setPrompts)
          .catch(() => undefined);
      })
      .catch((e) =>
        notifyError('Could not copy prompt', { source: 'Prompts', detail: detailOf(e) }),
      );
  };

  const remove = (p: PromptTemplate): void => {
    void window.axiom.prompts
      .remove(p.id)
      .then(setPrompts)
      .catch((e) =>
        notifyError('Could not delete prompt', { source: 'Prompts', detail: detailOf(e) }),
      );
  };

  return (
    <div className="prompts-view">
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
        <span className="oe-title">Prompt Library</span>
        {!collapsed ? <span className="oe-count">{prompts.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="prompts-body">
          {prompts.length > 0 ? (
            <input
              className="prompt-search"
              type="search"
              placeholder={'Search prompts\u2026'}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          {results.length === 0 ? (
            <div className="outline-empty">
              {prompts.length === 0 ? 'No saved prompts yet.' : 'No prompts match.'}
            </div>
          ) : (
            results.map((p) => (
              <div key={p.id} className="prompt-row">
                <div className="prompt-main" title={p.body}>
                  <span className="prompt-name">{p.name}</span>
                  {p.variables.length > 0 ? (
                    <span className="prompt-vars">{p.variables.length} var</span>
                  ) : null}
                </div>
                {p.tags.length > 0 ? <div className="prompt-tags">{p.tags.join(' · ')}</div> : null}
                <div className="prompt-actions">
                  <button type="button" className="prompt-act" title="Copy" onClick={() => copy(p)}>
                    {'\u29C9'}
                  </button>
                  <button
                    type="button"
                    className="prompt-act is-danger"
                    title="Delete"
                    onClick={() => remove(p)}
                  >
                    {'\u00D7'}
                  </button>
                </div>
              </div>
            ))
          )}

          {creating ? (
            <div className="prompt-form">
              <input
                className="prompt-input"
                placeholder="Prompt name"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                className="prompt-textarea"
                placeholder="Prompt body — use {{variables}} for placeholders"
                value={body}
                rows={3}
                spellCheck={false}
                onChange={(e) => setBody(e.target.value)}
              />
              <input
                className="prompt-input"
                placeholder="tags (comma-separated)"
                value={tags}
                spellCheck={false}
                onChange={(e) => setTags(e.target.value)}
              />
              <div className="prompt-form-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={name.trim().length === 0 || body.trim().length === 0}
                  onClick={save}
                >
                  Save prompt
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost prompt-new"
              onClick={() => setCreating(true)}
            >
              {'\uFF0B'} New prompt
            </button>
          )}
        </div>
      )}
    </div>
  );
}
