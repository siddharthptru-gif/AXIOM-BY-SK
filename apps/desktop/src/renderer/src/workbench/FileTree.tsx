import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DirEntry, GitChangeType } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { useGitDecorations } from '../state/gitStatus';
import { useSettings } from '../settings/store';
import { ChevronIcon, FileIcon, FolderIcon } from './treeIcons';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { ConfirmModal, Modal, PromptModal } from './Modal';
import { notifyInfo } from '../notifications/bus';

/**
 * File explorer (PRD Part VII §104). Lazy tree + toolbar + right-click menu for
 * create / rename / delete, backed by the Main FileSystem service. Reacts to the
 * workspace refresh/collapse/expand signals (which also fire on fs-watch events).
 */

// ---- Explorer UI context: lets deeply-nested nodes open the shared menu ----
interface ExplorerUI {
  openMenu: (entry: DirEntry, x: number, y: number) => void;
  menuTargetPath: string | null;
  dragSource: string | null;
  setDragSource: (path: string | null) => void;
  moveEntry: (source: string, destDir: string) => void;
  /** When true, single-click opens files as reused preview tabs. */
  previewEnabled: boolean;
}
const ExplorerUIContext = createContext<ExplorerUI | null>(null);
function useExplorerUI(): ExplorerUI {
  const ctx = useContext(ExplorerUIContext);
  if (!ctx) throw new Error('useExplorerUI must be used within the explorer');
  return ctx;
}

// ---- Client-side name validation (mirrors the Main service for instant feedback) ----
function validateName(name: string): string | null {
  const t = name.trim();
  if (t.length === 0) return 'Name cannot be empty.';
  if (t === '.' || t === '..') return 'Invalid name.';
  if (/[\\/]/.test(t)) return 'Name cannot contain path separators.';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(t)) return 'Name contains characters that are not allowed.';
  return null;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}
function parentOf(p: string): string {
  const s = sepOf(p);
  const i = p.lastIndexOf(s);
  return i > 0 ? p.slice(0, i) : p;
}
function isUnder(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(ancestor + sepOf(ancestor));
}
function relativeTo(root: string, p: string): string {
  if (p === root) return baseName(p);
  return p.startsWith(root + sepOf(root)) ? p.slice(root.length + 1) : p;
}

/** Root-relative path with forward slashes, to match git's status paths. */
function toGitRel(root: string, p: string): string {
  const sep = sepOf(root);
  if (p === root) return '';
  const rel = p.startsWith(root + sep) ? p.slice(root.length + 1) : p;
  return rel.split(sep).join('/');
}

/** Single-letter git status badge, matching the Source Control view. */
const GIT_LETTER: Record<GitChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  untracked: 'U',
};

// ---- Toolbar glyphs (16px) ----
function NewFileGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V6L9 1.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M12 8.5v4M10 10.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
function NewFolderGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.25 3 3h3l1.25 1.5h6A.75.75 0 0 1 14 5.25V12a1 1 0 0 1-1 1H2.75A1 1 0 0 1 1.75 12V4.25Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M11 8v3M9.5 9.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
function RefreshGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.5 6A5 5 0 1 0 13 9"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path d="M12.7 2.5V6H9.2" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}
function CollapseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6.5 7 4l3 2.5M4 9.5 7 12l3-2.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const { openFile, activePath, refreshNonce, collapseNonce, expandSignal, revealEntry, rootPath } =
    useWorkspace();
  const { openMenu, menuTargetPath, dragSource, setDragSource, moveEntry, previewEnabled } =
    useExplorerUI();
  const deco = useGitDecorations();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Load / reload children when expanded or when a refresh is requested.
  useEffect(() => {
    if (entry.kind !== 'directory' || !expanded) return;
    let cancelled = false;
    window.axiom.fs
      .readDirectory(entry.path)
      .then((res) => {
        if (!cancelled) setChildren(res?.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.kind, entry.path, expanded, refreshNonce]);

  // Collapse-all signal.
  useEffect(() => {
    if (collapseNonce > 0) setExpanded(false);
  }, [collapseNonce]);

  // Targeted expand (e.g., after creating an item inside this folder).
  useEffect(() => {
    if (entry.kind === 'directory' && expandSignal && expandSignal.path === entry.path) {
      setExpanded(true);
    }
  }, [expandSignal, entry.kind, entry.path]);

  // Cascade-expand toward a reveal target so ancestors open as their children mount.
  useEffect(() => {
    if (!revealEntry || entry.kind !== 'directory') return;
    const sep = revealEntry.path.includes('\\') ? '\\' : '/';
    if (revealEntry.path === entry.path || revealEntry.path.startsWith(entry.path + sep)) {
      setExpanded(true);
    }
  }, [revealEntry, entry.kind, entry.path]);

  // Scroll the exact reveal target into view.
  useEffect(() => {
    if (revealEntry && revealEntry.path === entry.path) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [revealEntry, entry.path]);

  // Files open as a reused preview tab on single-click; permanent otherwise.
  const openEntry = useCallback(
    (preview: boolean) => {
      if (entry.kind === 'file') {
        openFile(entry.path, entry.name, preview ? { preview: true } : undefined);
      } else {
        setExpanded((e) => !e);
      }
    },
    [entry, openFile],
  );

  const isActiveFile = entry.kind === 'file' && activePath === entry.path;
  const isMenuTarget = menuTargetPath === entry.path;
  const gitRel = rootPath ? toGitRel(rootPath, entry.path) : '';
  const gitType = entry.kind === 'file' ? deco.fileType(gitRel) : undefined;
  const dirChanged = entry.kind === 'directory' ? deco.dirHasChanges(gitRel) : false;

  // Drop target: a directory drops into itself; a file drops into its parent.
  const targetDir = entry.kind === 'directory' ? entry.path : parentOf(entry.path);
  const canAccept =
    dragSource !== null &&
    dragSource !== targetDir &&
    !isUnder(targetDir, dragSource) &&
    parentOf(dragSource) !== targetDir;

  return (
    <div>
      <div
        ref={rowRef}
        className={`tree-row ${isActiveFile ? 'active' : ''} ${isMenuTarget ? 'context-target' : ''} ${dropActive ? 'drop-target' : ''} ${gitType ? `git-${gitType}` : ''} ${dirChanged ? 'git-dir-changed' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        role="treeitem"
        tabIndex={0}
        aria-expanded={entry.kind === 'directory' ? expanded : undefined}
        draggable
        onClick={() => openEntry(previewEnabled)}
        onDoubleClick={() => {
          if (entry.kind === 'file') openEntry(false);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(entry, e.clientX, e.clientY);
        }}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', entry.path);
          setDragSource(entry.path);
        }}
        onDragEnd={() => {
          setDragSource(null);
          setDropActive(false);
        }}
        onDragOver={(e) => {
          if (!canAccept) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          if (!dropActive) setDropActive(true);
        }}
        onDragLeave={() => {
          if (dropActive) setDropActive(false);
        }}
        onDrop={(e) => {
          if (!canAccept || dragSource === null) return;
          e.preventDefault();
          e.stopPropagation();
          setDropActive(false);
          moveEntry(dragSource, targetDir);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEntry(false);
          }
        }}
      >
        <span className="tree-chevron">
          {entry.kind === 'directory' ? <ChevronIcon open={expanded} /> : null}
        </span>
        <span className={`tree-icon ${entry.kind}`}>
          {entry.kind === 'directory' ? (
            <FolderIcon open={expanded} />
          ) : (
            <FileIcon name={entry.name} />
          )}
        </span>
        <span className="tree-label">{entry.name}</span>
        {gitType ? (
          <span className={`tree-git-badge git-badge-${gitType}`} title={gitType}>
            {GIT_LETTER[gitType]}
          </span>
        ) : dirChanged ? (
          <span className="tree-git-dot" title="Contains changes" />
        ) : null}
      </div>
      {expanded && Array.isArray(children) ? (
        <div role="group">
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type DialogState =
  | { kind: 'newFile' | 'newFolder'; anchorPath: string; anchorIsDir: boolean }
  | { kind: 'rename'; target: DirEntry }
  | { kind: 'delete'; target: DirEntry }
  | null;

export function FileTree({ rootPath, rootName }: { rootPath: string; rootName: string }) {
  const {
    refreshNonce,
    bumpRefresh,
    collapseAll,
    expandPath,
    openFile,
    applyRename,
    applyDelete,
    dirtyPaths,
  } = useWorkspace();
  const { values } = useSettings();
  const previewEnabled = values['workbench.editor.enablePreview'] !== false;
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: DirEntry | null } | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragSource, setDragSource] = useState<string | null>(null);
  const affectsDirtyEditor = useCallback(
    (path: string): boolean => {
      const prefix =
        path.endsWith('\\') || path.endsWith('/')
          ? path
          : `${path}${path.includes('\\') ? '\\' : '/'}`;
      return [...dirtyPaths].some((dirty) => dirty === path || dirty.startsWith(prefix));
    },
    [dirtyPaths],
  );

  // Read the root listing on mount and on every refresh signal.
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    window.axiom.fs
      .readDirectory(rootPath)
      .then((res) => {
        if (!cancelled) setEntries(res?.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, refreshNonce]);

  const openMenu = useCallback(
    (entry: DirEntry, x: number, y: number) => setMenu({ x, y, target: entry }),
    [],
  );

  const moveEntry = useCallback(
    async (source: string, destDir: string) => {
      if (affectsDirtyEditor(source)) {
        setErrorMessage('Save or close unsaved editors under this item before moving it.');
        return;
      }
      try {
        const res = await window.axiom.fs.move(source, destDir);
        if (res.newPath !== res.oldPath) {
          applyRename(source, res.newPath, res.name);
          notifyInfo(`Moved ${res.name}`, { source: 'Explorer' });
        }
        bumpRefresh();
        expandPath(destDir);
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const marker = raw.lastIndexOf('Error: ');
        setErrorMessage(marker >= 0 ? raw.slice(marker + 7) : raw);
      }
    },
    [affectsDirtyEditor, applyRename, bumpRefresh, expandPath],
  );

  const ui = useMemo<ExplorerUI>(
    () => ({
      openMenu,
      menuTargetPath: menu?.target?.path ?? null,
      dragSource,
      setDragSource,
      moveEntry,
      previewEnabled,
    }),
    [openMenu, menu, dragSource, moveEntry, previewEnabled],
  );

  const performDelete = async (target: DirEntry): Promise<void> => {
    if (affectsDirtyEditor(target.path)) {
      setErrorMessage(
        'Save or close unsaved editors under this item before moving it to the Recycle Bin.',
      );
      return;
    }
    try {
      const res = await window.axiom.fs.delete(target.path);
      applyDelete(target.path);
      bumpRefresh();
      notifyInfo(`Deleted ${target.name}${res.trashed ? ' (moved to Recycle Bin)' : ''}`, {
        source: 'Explorer',
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const marker = raw.lastIndexOf('Error: ');
      setErrorMessage(marker >= 0 ? raw.slice(marker + 7) : raw);
    }
  };

  const menuEntries = (target: DirEntry | null): MenuEntry[] => {
    if (target) {
      return [
        {
          label: 'New File…',
          onSelect: () =>
            setDialog({
              kind: 'newFile',
              anchorPath: target.path,
              anchorIsDir: target.kind === 'directory',
            }),
        },
        {
          label: 'New Folder…',
          onSelect: () =>
            setDialog({
              kind: 'newFolder',
              anchorPath: target.path,
              anchorIsDir: target.kind === 'directory',
            }),
        },
        { separator: true },
        { label: 'Rename…', onSelect: () => setDialog({ kind: 'rename', target }) },
        { label: 'Delete', danger: true, onSelect: () => setDialog({ kind: 'delete', target }) },
        { separator: true },
        { label: 'Copy Path', onSelect: () => void window.axiom.system.copyText(target.path) },
        {
          label: 'Copy Relative Path',
          onSelect: () => void window.axiom.system.copyText(relativeTo(rootPath, target.path)),
        },
        {
          label: 'Reveal in File Explorer',
          onSelect: () => void window.axiom.system.revealInOS(target.path),
        },
      ];
    }
    return [
      {
        label: 'New File…',
        onSelect: () => setDialog({ kind: 'newFile', anchorPath: rootPath, anchorIsDir: true }),
      },
      {
        label: 'New Folder…',
        onSelect: () => setDialog({ kind: 'newFolder', anchorPath: rootPath, anchorIsDir: true }),
      },
      { separator: true },
      { label: 'Refresh', onSelect: bumpRefresh },
      { label: 'Collapse All', onSelect: collapseAll },
    ];
  };

  const createLabel = (anchorPath: string, anchorIsDir: boolean): string =>
    anchorIsDir ? `Create in "${baseName(anchorPath)}"` : 'Create in the current folder';

  return (
    <ExplorerUIContext.Provider value={ui}>
      <div className="explorer-toolbar">
        <div className="explorer-root" title={rootPath}>
          {rootName}
        </div>
        <div className="explorer-actions">
          <button
            type="button"
            className="icon-btn"
            title="New File"
            aria-label="New File"
            onClick={() => setDialog({ kind: 'newFile', anchorPath: rootPath, anchorIsDir: true })}
          >
            <NewFileGlyph />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="New Folder"
            aria-label="New Folder"
            onClick={() =>
              setDialog({ kind: 'newFolder', anchorPath: rootPath, anchorIsDir: true })
            }
          >
            <NewFolderGlyph />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Refresh Explorer"
            aria-label="Refresh Explorer"
            onClick={() => bumpRefresh()}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Collapse All"
            aria-label="Collapse All"
            onClick={() => collapseAll()}
          >
            <CollapseGlyph />
          </button>
        </div>
      </div>

      <div
        role="tree"
        aria-label={rootName}
        className="file-tree"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, target: null });
        }}
        onDragOver={(e) => {
          if (
            dragSource !== null &&
            parentOf(dragSource) !== rootPath &&
            !isUnder(rootPath, dragSource)
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(e) => {
          if (
            dragSource !== null &&
            parentOf(dragSource) !== rootPath &&
            !isUnder(rootPath, dragSource)
          ) {
            e.preventDefault();
            moveEntry(dragSource, rootPath);
          }
        }}
      >
        {entries === null ? (
          <div className="tree-loading">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="tree-loading">Empty folder</div>
        ) : (
          entries.map((entry) => <TreeNode key={entry.path} entry={entry} depth={0} />)
        )}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {dialog?.kind === 'newFile' ? (
        <PromptModal
          title="New File"
          label={createLabel(dialog.anchorPath, dialog.anchorIsDir)}
          confirmLabel="Create"
          validate={validateName}
          onSubmit={async (name) => {
            const res = await window.axiom.fs.createFile(dialog.anchorPath, name);
            notifyInfo(`Created ${res.name}`, { source: 'Explorer' });
            bumpRefresh();
            if (dialog.anchorIsDir) expandPath(dialog.anchorPath);
            openFile(res.path, res.name);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'newFolder' ? (
        <PromptModal
          title="New Folder"
          label={createLabel(dialog.anchorPath, dialog.anchorIsDir)}
          confirmLabel="Create"
          validate={validateName}
          onSubmit={async (name) => {
            const res = await window.axiom.fs.createDirectory(dialog.anchorPath, name);
            notifyInfo(`Created folder ${res.name}`, { source: 'Explorer' });
            bumpRefresh();
            if (dialog.anchorIsDir) expandPath(dialog.anchorPath);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename' ? (
        <PromptModal
          title={`Rename ${dialog.target.kind === 'directory' ? 'Folder' : 'File'}`}
          initialValue={dialog.target.name}
          confirmLabel="Rename"
          validate={validateName}
          onSubmit={async (name) => {
            if (name === dialog.target.name) {
              setDialog(null);
              return;
            }
            if (affectsDirtyEditor(dialog.target.path)) {
              setDialog(null);
              setErrorMessage('Save or close unsaved editors under this item before renaming it.');
              return;
            }
            const res = await window.axiom.fs.rename(dialog.target.path, name);
            applyRename(dialog.target.path, res.newPath, res.name);
            notifyInfo(`Renamed to ${res.name}`, { source: 'Explorer' });
            bumpRefresh();
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'delete' ? (
        <ConfirmModal
          title={`Delete ${dialog.target.kind === 'directory' ? 'Folder' : 'File'}`}
          danger
          confirmLabel="Move to Recycle Bin"
          message={
            <>
              Are you sure you want to delete <strong>{dialog.target.name}</strong>? It will be
              moved to the Recycle Bin.
            </>
          }
          onConfirm={() => void performDelete(dialog.target)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {errorMessage ? (
        <Modal
          title="Operation Failed"
          onClose={() => setErrorMessage(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setErrorMessage(null)}>
              OK
            </button>
          }
        >
          <div className="modal-message">{errorMessage as ReactNode}</div>
        </Modal>
      ) : null}
    </ExplorerUIContext.Provider>
  );
}
