import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorGroup, OpenTab } from '../state/workspace';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { FileIcon } from './treeIcons';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, PinIcon } from './icons';

function parentDirName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';
}

/** Display labels for the opened-editors menu, disambiguating duplicate file names. */
function menuLabels(tabs: OpenTab[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const t of tabs) {
    const dup = (counts.get(t.name) ?? 0) > 1;
    const dir = dup ? parentDirName(t.path) : '';
    labels.set(t.path, dir ? `${t.name} \u2014 ${dir}` : t.name);
  }
  return labels;
}

interface GroupTabBarProps {
  group: EditorGroup;
  dirtyPaths: ReadonlySet<string>;
  pinnedPaths: ReadonlySet<string>;
  dragTab: string | null;
  dragOverTab: string | null;
  isDragOverGroup: boolean;
  onDragTabChange: (path: string | null) => void;
  onDragOverTabChange: (path: string | null) => void;
  onDragOverGroupChange: (id: string | null) => void;
  onActivate: (path: string) => void;
  onReorder: (from: string, to: string) => void;
  onMoveToGroup: (path: string, groupId: string) => void;
  onRequestClose: (tab: OpenTab) => void;
  onTogglePin: (path: string) => void;
  onKeepOpen: (path: string) => void;
  onNewFile: () => void;
  onContextMenu: (x: number, y: number, path: string) => void;
}

/**
 * A single editor group's tab strip (PRD Part VII §105). The strip scrolls
 * horizontally (wheel or chevrons) when tabs overflow, keeps the active tab in
 * view, and offers an "Opened Editors" dropdown for quick selection. Drag/close/
 * context behavior is delegated to the parent EditorArea via callbacks.
 */
export function GroupTabBar({
  group,
  dirtyPaths,
  pinnedPaths,
  dragTab,
  dragOverTab,
  isDragOverGroup,
  onDragTabChange,
  onDragOverTabChange,
  onDragOverGroupChange,
  onActivate,
  onReorder,
  onMoveToGroup,
  onRequestClose,
  onTogglePin,
  onKeepOpen,
  onNewFile,
  onContextMenu,
}: GroupTabBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Recompute overflow on mount, tab-count changes, and container resize.
  const tabCount = group.tabs.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    const ro = new ResizeObserver(() => updateOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateOverflow, tabCount]);

  // Keep the active tab visible when it (or the tab set) changes.
  const activePath = group.active;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activePath) return;
    const activeEl = el.querySelector<HTMLElement>('.editor-tab.active');
    if (!activeEl) return;
    const left = activeEl.offsetLeft;
    const right = left + activeEl.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 8);
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 8;
    updateOverflow();
  }, [activePath, tabCount, updateOverflow]);

  const scrollByAmount = (delta: number): void => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const labels = menuLabels(group.tabs);
  const menuEntries: MenuEntry[] = group.tabs.map((t) => ({
    label: `${dirtyPaths.has(t.path) ? '\u25CF ' : ''}${labels.get(t.path) ?? t.name}`,
    onSelect: () => onActivate(t.path),
  }));

  return (
    <div
      className={`editor-tabs-bar ${isDragOverGroup ? 'drag-over-group' : ''}`}
      onDragOver={(e) => {
        if (dragTab && !group.tabs.some((t) => t.path === dragTab)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!isDragOverGroup) onDragOverGroupChange(group.id);
        }
      }}
      onDragLeave={() => {
        if (isDragOverGroup) onDragOverGroupChange(null);
      }}
      onDrop={(e) => {
        if (dragTab && !group.tabs.some((t) => t.path === dragTab)) {
          e.preventDefault();
          onMoveToGroup(dragTab, group.id);
        }
        onDragTabChange(null);
        onDragOverTabChange(null);
        onDragOverGroupChange(null);
      }}
    >
      {overflow.left ? (
        <button
          type="button"
          className="tabs-scroll-btn"
          aria-label="Scroll tabs left"
          onClick={() => scrollByAmount(-200)}
        >
          <ChevronLeftIcon />
        </button>
      ) : null}
      <div
        className="editor-tabs"
        role="tablist"
        aria-label="Editor tabs"
        ref={scrollRef}
        onScroll={updateOverflow}
        onDoubleClick={(e) => {
          // Double-clicking the empty strip (not a tab) opens a new untitled file.
          if (e.target === e.currentTarget) onNewFile();
        }}
        onWheel={(e) => {
          const el = scrollRef.current;
          if (el && e.deltaY !== 0) el.scrollLeft += e.deltaY;
        }}
      >
        {group.tabs.map((tab, index) => {
          const active = group.active === tab.path;
          const pinned = pinnedPaths.has(tab.path);
          const isPreview = group.preview === tab.path;
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable
              className={`editor-tab ${active ? 'active' : ''} ${pinned ? 'pinned' : ''} ${isPreview ? 'preview' : ''} ${dragOverTab === tab.path ? 'drag-over' : ''}`}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                let nextIndex: number;
                switch (e.key) {
                  case 'ArrowLeft':
                    nextIndex = (index - 1 + group.tabs.length) % group.tabs.length;
                    break;
                  case 'ArrowRight':
                    nextIndex = (index + 1) % group.tabs.length;
                    break;
                  case 'Home':
                    nextIndex = 0;
                    break;
                  case 'End':
                    nextIndex = group.tabs.length - 1;
                    break;
                  default:
                    return;
                }
                e.preventDefault();
                const nextTab = group.tabs[nextIndex];
                if (!nextTab) return;
                onActivate(nextTab.path);
                scrollRef.current
                  ?.querySelectorAll<HTMLElement>('.editor-tab[role="tab"]')
                  [nextIndex]?.focus();
              }}
              onClick={() => onActivate(tab.path)}
              onDoubleClick={() => onKeepOpen(tab.path)}
              onAuxClick={(e) => {
                // Middle-click closes the tab (dirty-aware via the parent).
                if (e.button === 1) {
                  e.preventDefault();
                  onRequestClose(tab);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e.clientX, e.clientY, tab.path);
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', tab.path);
                onKeepOpen(tab.path);
                onDragTabChange(tab.path);
              }}
              onDragOver={(e) => {
                if (dragTab && dragTab !== tab.path) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverTab !== tab.path) onDragOverTabChange(tab.path);
                }
              }}
              onDragLeave={() => {
                if (dragOverTab === tab.path) onDragOverTabChange(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragTab && dragTab !== tab.path) {
                  if (group.tabs.some((t) => t.path === dragTab)) onReorder(dragTab, tab.path);
                  else onMoveToGroup(dragTab, group.id);
                }
                onDragTabChange(null);
                onDragOverTabChange(null);
                onDragOverGroupChange(null);
              }}
              onDragEnd={() => {
                onDragTabChange(null);
                onDragOverTabChange(null);
              }}
            >
              <span className="editor-tab-icon">
                <FileIcon name={tab.name} />
              </span>
              <span className="editor-tab-label">{tab.name}</span>
              {dirtyPaths.has(tab.path) ? (
                <span className="dirty-dot" aria-label="Unsaved" />
              ) : null}
              {pinned ? (
                <button
                  type="button"
                  className="tab-pin"
                  aria-label={`Unpin ${tab.name}`}
                  title="Unpin"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(tab.path);
                  }}
                >
                  <PinIcon size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestClose(tab);
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {overflow.right ? (
        <button
          type="button"
          className="tabs-scroll-btn"
          aria-label="Scroll tabs right"
          onClick={() => scrollByAmount(200)}
        >
          <ChevronRightIcon />
        </button>
      ) : null}
      <button
        type="button"
        className="tabs-overflow-btn"
        aria-label="Opened editors"
        title="Opened Editors"
        disabled={group.tabs.length === 0}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.bottom });
        }}
      >
        <ChevronDownIcon />
      </button>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
