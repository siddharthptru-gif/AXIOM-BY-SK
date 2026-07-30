import { useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { editorClosePath, editorCloseAllGroups } from '../editor/editorCloseBus';
import { ChevronIcon, FileIcon } from './treeIcons';
import { CloseIcon, PinIcon } from './icons';

/**
 * Open Editors section (PRD Part VII §104). A collapsible list at the top of the
 * Explorer showing every open file across editor groups (sub-grouped when the
 * editor is split). Rows focus their file on click and expose a dirty-aware close
 * that reuses the editor area's Save/Don't Save flow via the close bus. Renders
 * nothing when no editors are open.
 */
export function OpenEditors() {
  const { groups, activeGroupId, activePath, dirtyPaths, pinnedPaths, setActive } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);

  const total = groups.reduce((n, g) => n + g.tabs.length, 0);
  if (total === 0) return null;
  const multi = groups.length > 1;

  return (
    <div className="open-editors">
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
        <span className="oe-title">Open Editors</span>
        <span className="oe-count">{total}</span>
        <button
          type="button"
          className="icon-btn oe-close-all"
          title="Close All Editors"
          aria-label="Close All Editors"
          onClick={(e) => {
            e.stopPropagation();
            editorCloseAllGroups();
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      {collapsed ? null : (
        <div className="oe-list" role="list">
          {groups.map((group, gi) => (
            <div key={group.id} role="group">
              {multi ? <div className="oe-group-label">Group {gi + 1}</div> : null}
              {group.tabs.map((tab) => {
                const active = activePath === tab.path && group.id === activeGroupId;
                const dirty = dirtyPaths.has(tab.path);
                const pinned = pinnedPaths.has(tab.path);
                const preview = group.preview === tab.path;
                return (
                  <div
                    key={tab.path}
                    role="listitem"
                    className={`oe-row ${active ? 'active' : ''} ${preview ? 'preview' : ''}`}
                    title={tab.path}
                    onClick={() => setActive(tab.path)}
                    onAuxClick={(e) => {
                      // Middle-click closes the editor (dirty-aware via the close bus).
                      if (e.button === 1) editorClosePath(tab.path);
                    }}
                  >
                    <span className="oe-icon">
                      <FileIcon name={tab.name} />
                    </span>
                    <span className="oe-label">{tab.name}</span>
                    {pinned ? (
                      <span className="oe-pin" aria-label="Pinned">
                        <PinIcon size={12} />
                      </span>
                    ) : null}
                    {dirty ? <span className="oe-dirty dirty-dot" aria-label="Unsaved" /> : null}
                    <button
                      type="button"
                      className="oe-close"
                      aria-label={`Close ${tab.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        editorClosePath(tab.path);
                      }}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
