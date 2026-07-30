import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SETTINGS, type SettingDefinition } from '../settings/schema';
import { useSettings, type SettingsScope } from '../settings/store';
import { useWorkspace } from '../state/workspace';
import { DialogFrame } from './Modal';

/**
 * Settings editor (PRD Part IV §55 / Part VII §120). A searchable, grouped view
 * generated from the schema, with User / Workspace scope tabs. Edits persist to
 * the selected scope immediately; the effective value uses default < user < workspace.
 */
function clampNum(value: number, min?: number, max?: number): number {
  let result = value;
  if (typeof min === 'number') result = Math.max(min, result);
  if (typeof max === 'number') result = Math.min(max, result);
  return result;
}

function matchesFilter(def: SettingDefinition, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  return (
    def.title.toLowerCase().includes(q) ||
    def.description.toLowerCase().includes(q) ||
    def.key.toLowerCase().includes(q)
  );
}

export function SettingsView() {
  const {
    isOpen,
    close,
    set,
    reset,
    isModified,
    getResolvedValue,
    loaded,
    workspaceAvailable,
    workspaceLoaded,
  } = useSettings();
  const { openFile, rootPath } = useWorkspace();
  const [query, setQuery] = useState('');
  const [activeScope, setActiveScope] = useState<SettingsScope>('user');
  const scopeTabRefs = useRef<Record<SettingsScope, HTMLButtonElement | null>>({
    user: null,
    workspace: null,
  });
  const scope: SettingsScope =
    workspaceAvailable && activeScope === 'workspace' ? 'workspace' : 'user';
  const scopeReady = loaded && (scope === 'user' || workspaceLoaded);
  const selectScope = (next: SettingsScope, focus = false): void => {
    if (next === 'workspace' && !workspaceAvailable) return;
    setActiveScope(next);
    if (focus) requestAnimationFrame(() => scopeTabRefs.current[next]?.focus());
  };
  const onScopeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: SettingsScope,
  ): void => {
    const available: SettingsScope[] = workspaceAvailable ? ['user', 'workspace'] : ['user'];
    const index = Math.max(0, available.indexOf(current));
    let next: SettingsScope | undefined;
    if (event.key === 'ArrowRight') next = available[(index + 1) % available.length];
    else if (event.key === 'ArrowLeft') {
      next = available[(index - 1 + available.length) % available.length];
    } else if (event.key === 'Home') next = available[0];
    else if (event.key === 'End') next = available.at(-1);
    if (!next) return;
    event.preventDefault();
    selectScope(next, true);
  };

  const openJson = async (): Promise<void> => {
    if (!scopeReady || (scope === 'workspace' && !rootPath)) return;
    const path = await window.axiom.settings.resolve(
      scope,
      scope === 'workspace' ? (rootPath ?? undefined) : undefined,
    );
    openFile(path, path.split(/[\\/]/).pop() ?? 'settings.json');
    close();
  };

  const groups = useMemo(() => {
    const map = new Map<string, SettingDefinition[]>();
    for (const setting of SETTINGS) {
      if (!matchesFilter(setting, query)) continue;
      const group = map.get(setting.category) ?? [];
      group.push(setting);
      map.set(setting.category, group);
    }
    return [...map.entries()];
  }, [query]);

  if (!isOpen) return null;

  const renderControl = (def: SettingDefinition): ReactNode => {
    const resolved = getResolvedValue(def.key, scope);
    const raw = resolved === undefined ? def.default : resolved;
    switch (def.type) {
      case 'number': {
        const value = typeof raw === 'number' ? raw : Number(def.default);
        return (
          <input
            type="number"
            className="set-input set-number"
            aria-label={def.title}
            value={value}
            min={def.min}
            max={def.max}
            onChange={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isNaN(next)) return;
              set(def.key, clampNum(next, def.min, def.max), scope);
            }}
          />
        );
      }
      case 'boolean': {
        const checked = raw === true;
        return (
          <button
            type="button"
            role="switch"
            aria-label={def.title}
            aria-checked={checked}
            className={`set-toggle ${checked ? 'on' : ''}`}
            onClick={() => set(def.key, !checked, scope)}
          >
            <span className="set-toggle-knob" />
          </button>
        );
      }
      case 'enum': {
        const value = typeof raw === 'string' ? raw : String(def.default);
        return (
          <select
            className="set-input set-select"
            aria-label={def.title}
            value={value}
            onChange={(event) => set(def.key, event.target.value, scope)}
          >
            {(def.options ?? []).map((option) => (
              <option key={option} value={option}>
                {def.optionLabels?.[option] ?? option}
              </option>
            ))}
          </select>
        );
      }
      default: {
        const value = typeof raw === 'string' ? raw : String(def.default);
        return (
          <input
            type="text"
            className="set-input set-text"
            aria-label={def.title}
            value={value}
            spellCheck={false}
            onChange={(event) => set(def.key, event.target.value, scope)}
          />
        );
      }
    }
  };

  return (
    <DialogFrame
      onClose={close}
      overlayClassName="settings-overlay"
      cardClassName="settings-panel"
      ariaLabel="Settings"
    >
      <div className="settings-head">
        <span className="settings-title">Settings</span>
        <input
          className="settings-search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="icon-btn settings-json-btn"
          title="Open Settings (JSON)"
          aria-label="Open Settings (JSON)"
          disabled={!scopeReady}
          onClick={() => void openJson()}
        >
          {'{ }'}
        </button>
        <button type="button" className="icon-btn" aria-label="Close settings" onClick={close}>
          ×
        </button>
      </div>
      <div className="settings-scopes" role="tablist" aria-label="Settings scope">
        <button
          id="settings-scope-user"
          ref={(node) => {
            scopeTabRefs.current.user = node;
          }}
          type="button"
          role="tab"
          aria-selected={scope === 'user'}
          aria-controls="settings-scope-panel"
          tabIndex={scope === 'user' ? 0 : -1}
          className={`settings-scope ${scope === 'user' ? 'active' : ''}`}
          onKeyDown={(event) => onScopeKeyDown(event, 'user')}
          onClick={() => selectScope('user')}
        >
          User
        </button>
        <button
          id="settings-scope-workspace"
          ref={(node) => {
            scopeTabRefs.current.workspace = node;
          }}
          type="button"
          role="tab"
          aria-selected={scope === 'workspace'}
          aria-controls="settings-scope-panel"
          tabIndex={scope === 'workspace' ? 0 : -1}
          disabled={!workspaceAvailable}
          title={
            workspaceAvailable ? 'Workspace settings' : 'Open a folder to edit workspace settings'
          }
          className={`settings-scope ${scope === 'workspace' ? 'active' : ''}`}
          onKeyDown={(event) => onScopeKeyDown(event, 'workspace')}
          onClick={() => selectScope('workspace')}
        >
          Workspace
        </button>
      </div>
      <div
        id="settings-scope-panel"
        className="settings-body"
        role="tabpanel"
        aria-labelledby={`settings-scope-${scope}`}
      >
        {!scopeReady ? (
          <div className="settings-empty" role="status">
            {loaded ? 'Loading workspace settings…' : 'Loading settings…'}
          </div>
        ) : groups.length === 0 ? (
          <div className="settings-empty">No settings match “{query}”.</div>
        ) : (
          groups.map(([category, definitions]) => (
            <div key={category} className="settings-group">
              <div className="settings-group-title">{category}</div>
              {definitions.map((def) => (
                <div key={def.key} className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-title">
                      {def.title}
                      {isModified(def.key, scope) ? (
                        <button
                          type="button"
                          className="settings-reset"
                          title={
                            scope === 'workspace'
                              ? 'Reset workspace value to inherit the User setting'
                              : 'Reset user value to the default'
                          }
                          onClick={() => reset(def.key, scope)}
                        >
                          Reset
                        </button>
                      ) : null}
                    </div>
                    <div className="settings-row-desc">{def.description}</div>
                    <div className="settings-row-key">{def.key}</div>
                  </div>
                  <div className="settings-row-control">{renderControl(def)}</div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </DialogFrame>
  );
}
