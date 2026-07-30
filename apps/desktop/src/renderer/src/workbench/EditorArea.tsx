import { Fragment, useEffect, useRef, useState } from 'react';
import type { AppInfo } from '../../../common/ipc';
import { useWorkspace, isUntitledPath, type OpenTab } from '../state/workspace';
import { EditorPane, type EditorEncoding } from '../editor/EditorPane';
import { Breadcrumbs } from './Breadcrumbs';
import { RunButton } from './RunButton';
import { Modal } from './Modal';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { Logo } from './icons';
import { GroupTabBar } from './GroupTabBar';
import { GettingStarted } from './GettingStarted';
import { saveFile } from '../editor/saveBus';
import { setEditorCloseActions, type EditorCloseActions } from '../editor/editorCloseBus';
import type { EolKind } from '../editor/eolBus';
import type { IndentInfo } from '../editor/indentBus';
import { useSettings } from '../settings/store';
import { useLayout } from '../state/layout';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function relativeTo(root: string | null, p: string): string {
  if (!root) return p;
  const sep = root.includes('\\') ? '\\' : '/';
  if (p === root) return baseName(p);
  return p.startsWith(root + sep) ? p.slice(root.length + 1) : p;
}

interface EditorAreaProps {
  info: AppInfo | null;
  onCursor: (line: number, column: number) => void;
  onLanguage: (language: string) => void;
  onSelection: (selectedChars: number) => void;
  onEol: (eol: EolKind) => void;
  onEncoding: (encoding: EditorEncoding) => void;
  onIndent: (indent: IndentInfo) => void;
  onReveal: (path: string) => void;
}

export function EditorArea({
  info,
  onCursor,
  onLanguage,
  onSelection,
  onEol,
  onEncoding,
  onIndent,
  onReveal,
}: EditorAreaProps) {
  const {
    groups,
    activeGroupId,
    dirtyPaths,
    pinnedPaths,
    rootPath,
    setActive,
    closeTab,
    closeTabs,
    reorderTabs,
    togglePin,
    keepOpen,
    newUntitled,
    markDirty,
    focusGroup,
    moveEditorToOtherGroup,
    moveTabToGroup,
    openFiles,
    openFolder,
    recentFolders,
    openRecent,
  } = useWorkspace();
  const { values } = useSettings();
  const { centeredLayout, showAiPanel } = useLayout();
  const showBreadcrumbs = values['workbench.breadcrumbs.enabled'] !== false;
  // Centered layout only applies to a single (unsplit) group.
  const centered = centeredLayout && groups.length === 1;
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [closeQueue, setCloseQueue] = useState<string[]>([]);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const closeActionsRef = useRef<EditorCloseActions>({
    closeActive() {},
    closeOthers() {},
    closeToRight() {},
    closeSaved() {},
    closeAll() {},
    closeAllGroups() {},
    closePath() {},
  });

  // Close a set of tabs: clean ones drop immediately; dirty ones queue a save prompt.
  const runClose = (paths: string[]): void => {
    const clean = paths.filter((p) => !dirtyPaths.has(p));
    const dirty = paths.filter((p) => dirtyPaths.has(p));
    if (clean.length > 0) closeTabs(clean);
    if (dirty.length > 0) setCloseQueue(dirty);
  };

  const requestClose = (tab: OpenTab): void => runClose([tab.path]);

  // Menu actions are relative to the group that holds the right-clicked tab.
  const tabMenuEntries = (path: string): MenuEntry[] => {
    const group = groups.find((g) => g.tabs.some((t) => t.path === path));
    const groupTabs = group?.tabs ?? [];
    const index = groupTabs.findIndex((t) => t.path === path);
    // Bulk closes leave pinned tabs alone; the single "Close" still closes them.
    const unpinnedOf = (list: string[]): string[] => list.filter((p) => !pinnedPaths.has(p));
    const others = unpinnedOf(groupTabs.filter((t) => t.path !== path).map((t) => t.path));
    const toRight = unpinnedOf(groupTabs.slice(index + 1).map((t) => t.path));
    const saved = unpinnedOf(groupTabs.filter((t) => !dirtyPaths.has(t.path)).map((t) => t.path));
    const all = unpinnedOf(groupTabs.map((t) => t.path));
    const isPinned = pinnedPaths.has(path);
    const isPreview = group?.preview === path;
    return [
      { label: 'Close', onSelect: () => runClose([path]) },
      { label: 'Close Others', disabled: others.length === 0, onSelect: () => runClose(others) },
      {
        label: 'Close to the Right',
        disabled: toRight.length === 0,
        onSelect: () => runClose(toRight),
      },
      { label: 'Close Saved', disabled: saved.length === 0, onSelect: () => runClose(saved) },
      { label: 'Close All', disabled: all.length === 0, onSelect: () => runClose(all) },
      { separator: true },
      ...(isPreview
        ? [{ label: 'Keep Open', onSelect: () => keepOpen(path) } satisfies MenuEntry]
        : []),
      { label: isPinned ? 'Unpin' : 'Pin', onSelect: () => togglePin(path) },
      { label: 'Move to Other Group', onSelect: () => moveEditorToOtherGroup(path) },
      { separator: true },
      { label: 'Copy Path', onSelect: () => void window.axiom.system.copyText(path) },
      {
        label: 'Copy Relative Path',
        onSelect: () => void window.axiom.system.copyText(relativeTo(rootPath, path)),
      },
      {
        label: 'Reveal in File Explorer',
        onSelect: () => void window.axiom.system.revealInOS(path),
      },
    ];
  };

  // Close actions for the command palette / bus, relative to the focused group.
  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const activeGroupTabs = activeGroup?.tabs ?? [];
  const activeGroupActive = activeGroup?.active ?? null;
  const notPinned = (t: OpenTab): boolean => !pinnedPaths.has(t.path);
  closeActionsRef.current = {
    // Explicit single close still closes a pinned active editor.
    closeActive: () => {
      if (activeGroupActive) runClose([activeGroupActive]);
    },
    closeOthers: () => {
      if (activeGroupActive)
        runClose(
          activeGroupTabs
            .filter((t) => t.path !== activeGroupActive && notPinned(t))
            .map((t) => t.path),
        );
    },
    closeToRight: () => {
      const index = activeGroupTabs.findIndex((t) => t.path === activeGroupActive);
      if (index >= 0)
        runClose(
          activeGroupTabs
            .slice(index + 1)
            .filter(notPinned)
            .map((t) => t.path),
        );
    },
    closeSaved: () =>
      runClose(
        activeGroupTabs.filter((t) => !dirtyPaths.has(t.path) && notPinned(t)).map((t) => t.path),
      ),
    closeAll: () => runClose(activeGroupTabs.filter(notPinned).map((t) => t.path)),
    closeAllGroups: () =>
      runClose(
        groups
          .flatMap((g) => g.tabs)
          .filter(notPinned)
          .map((t) => t.path),
      ),
    closePath: (p) => runClose([p]),
  };

  useEffect(() => {
    setEditorCloseActions({
      closeActive: () => closeActionsRef.current.closeActive(),
      closeOthers: () => closeActionsRef.current.closeOthers(),
      closeToRight: () => closeActionsRef.current.closeToRight(),
      closeSaved: () => closeActionsRef.current.closeSaved(),
      closeAll: () => closeActionsRef.current.closeAll(),
      closeAllGroups: () => closeActionsRef.current.closeAllGroups(),
      closePath: (p) => closeActionsRef.current.closePath(p),
    });
    return () => setEditorCloseActions(null);
  }, []);

  const totalTabs = groups.reduce((n, g) => n + g.tabs.length, 0);

  if (totalTabs === 0) {
    return (
      <main className="editor-area">
        <div className="welcome">
          <div className="welcome-mark">
            <Logo size={44} />
          </div>
          <h1 className="welcome-title">Axiom</h1>
          <p className="welcome-tag">Think. Build. Ship.</p>

          <GettingStarted />

          <div className="welcome-section-title">Start</div>
          <div className="start-grid">
            <button className="start-card" type="button" onClick={() => void openFiles()}>
              <span className="start-card-kicker">Editor</span>
              <h4>Open File</h4>
              <p>Open and edit one or more files without creating a workspace.</p>
              <kbd>Ctrl O</kbd>
            </button>
            <button className="start-card" type="button" onClick={() => void openFolder()}>
              <span className="start-card-kicker">Workspace</span>
              <h4>Open Folder</h4>
              <p>Open a local project and restore its focused workbench.</p>
              <span className="start-card-hint">File menu</span>
            </button>
            <button className="start-card" type="button" onClick={newUntitled}>
              <span className="start-card-kicker">Editor</span>
              <h4>New File</h4>
              <p>Start an untitled buffer without choosing a workspace.</p>
              <kbd>Ctrl N</kbd>
            </button>
            <button className="start-card" type="button" onClick={showAiPanel}>
              <span className="start-card-kicker">Axiom AI</span>
              <h4>Open AI Dock</h4>
              <p>Connect a provider, ask about code, or compose a change.</p>
              <span className="start-card-hint">AI rail</span>
            </button>
          </div>

          {recentFolders.length > 0 ? (
            <>
              <div className="welcome-section-title">Recent</div>
              <div className="welcome-recents">
                {recentFolders.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    className="welcome-recent"
                    title={r.path}
                    onClick={() => void openRecent(r.path)}
                  >
                    <span className="welcome-recent-name">{r.name}</span>
                    <span className="welcome-recent-path">{r.path}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="welcome-section-title">Runtime</div>
          <div className="welcome-meta">
            {info ? (
              <>
                <span>Axiom v{info.version}</span>
                <span>Electron {info.electron}</span>
                <span>Chromium {info.chrome}</span>
                <span>Node {info.node}</span>
                <span>
                  {info.platform}/{info.arch}
                </span>
              </>
            ) : (
              <span>Loading runtime info…</span>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="editor-groups" ref={mainRef}>
      {groups.map((group, gi) => {
        const isActiveGroup = group.id === activeGroupId;
        const flexGrow = groups.length === 2 ? (gi === 0 ? splitRatio : 1 - splitRatio) : 1;
        return (
          <Fragment key={group.id}>
            {gi === 1 && groups.length === 2 ? (
              <div
                className="group-resizer"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize editor groups"
                aria-valuemin={20}
                aria-valuemax={80}
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuetext={`First editor group ${Math.round(splitRatio * 100)} percent`}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 0.05 : 0.02;
                  let next: number;
                  if (event.key === 'ArrowLeft') next = splitRatio - step;
                  else if (event.key === 'ArrowRight') next = splitRatio + step;
                  else if (event.key === 'Home') next = 0.2;
                  else if (event.key === 'End') next = 0.8;
                  else return;
                  event.preventDefault();
                  setSplitRatio(Math.min(0.8, Math.max(0.2, next)));
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  const onMove = (ev: PointerEvent): void => {
                    const rect = mainRef.current?.getBoundingClientRect();
                    if (!rect || rect.width === 0) return;
                    const ratio = (ev.clientX - rect.left) / rect.width;
                    setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
                  };
                  const onUp = (): void => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    document.body.classList.remove('resizing-col');
                  };
                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup', onUp);
                  document.body.classList.add('resizing-col');
                }}
              />
            ) : null}
            <section
              className={`editor-group ${isActiveGroup ? 'active' : ''} ${centered ? 'centered' : ''}`}
              style={{ flexGrow }}
              onMouseDown={() => focusGroup(group.id)}
            >
              <GroupTabBar
                group={group}
                dirtyPaths={dirtyPaths}
                pinnedPaths={pinnedPaths}
                dragTab={dragTab}
                dragOverTab={dragOverTab}
                isDragOverGroup={dragOverGroup === group.id}
                onDragTabChange={setDragTab}
                onDragOverTabChange={setDragOverTab}
                onDragOverGroupChange={setDragOverGroup}
                onActivate={setActive}
                onReorder={reorderTabs}
                onMoveToGroup={moveTabToGroup}
                onRequestClose={requestClose}
                onTogglePin={togglePin}
                onKeepOpen={keepOpen}
                onNewFile={newUntitled}
                onContextMenu={(x, y, path) => setTabMenu({ x, y, path })}
              />
              {showBreadcrumbs && group.active && !isUntitledPath(group.active) ? (
                <div className="editor-subheader">
                  <Breadcrumbs path={group.active} onReveal={onReveal} />
                  {/* Run ▶ sits with the breadcrumb so it is always next to the file
                      it will execute, and only the focused group shows it. */}
                  {isActiveGroup ? <RunButton /> : null}
                </div>
              ) : null}
              <EditorPane
                activePath={group.active}
                groupId={group.id}
                isActive={isActiveGroup}
                onFocusGroup={focusGroup}
                onDirtyChange={markDirty}
                onCursorChange={onCursor}
                onLanguageChange={onLanguage}
                onSelectionChange={onSelection}
                onEolChange={onEol}
                onEncodingChange={onEncoding}
                onIndentChange={onIndent}
              />
            </section>
          </Fragment>
        );
      })}
      {tabMenu ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          entries={tabMenuEntries(tabMenu.path)}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
      {closeQueue.length > 0
        ? (() => {
            const head = closeQueue[0];
            if (head === undefined) return null;
            const rest = closeQueue.slice(1);
            const name =
              groups.flatMap((g) => g.tabs).find((t) => t.path === head)?.name ?? baseName(head);
            return (
              <Modal
                title={`Save changes to ${name}?`}
                onClose={() => setCloseQueue([])}
                footer={
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setCloseQueue([])}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        closeTab(head);
                        setCloseQueue(rest);
                      }}
                    >
                      Don&apos;t Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        void saveFile(head).then((saved) => {
                          if (!saved) {
                            setCloseQueue((current) => [
                              head,
                              ...current.filter((path) => path !== head),
                            ]);
                            return;
                          }
                          if (!saved.clean) {
                            setCloseQueue((current) => [
                              saved.path,
                              ...current.filter((path) => path !== head && path !== saved.path),
                            ]);
                            return;
                          }
                          // Save As can re-key the tab between these two paths;
                          // close whichever identity is current, but only after the
                          // saver confirms no newer edits remain dirty.
                          closeTabs([...new Set([head, saved.path])]);
                          setCloseQueue((current) =>
                            current.filter((path) => path !== head && path !== saved.path),
                          );
                        });
                        setCloseQueue(rest);
                      }}
                    >
                      Save
                    </button>
                  </>
                }
              >
                <div className="modal-message">
                  Your changes to <strong>{name}</strong> will be lost if you don&apos;t save them.
                </div>
              </Modal>
            );
          })()
        : null}
    </main>
  );
}
