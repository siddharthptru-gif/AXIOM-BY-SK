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
import type { OpenPathResult, RecentFolder } from '../../../common/ipc';
import { notifyError, notifyInfo } from '../notifications/bus';

/**
 * Workspace state (PRD Part VII §105/§111 / Part II §16.2). Holds the open root,
 * the editor groups (each with its own tabs + active tab), the focused group, and
 * the dirty set (per file, shared across groups). A file lives in at most one
 * group; "move to other group" gives side-by-side editing of different files.
 */
export interface OpenTab {
  path: string;
  name: string;
}

export interface EditorGroup {
  id: string;
  tabs: OpenTab[];
  active: string | null;
  /** Path of this group's preview tab (single-click open), if any. */
  preview: string | null;
}

export interface ExpandSignal {
  path: string;
  nonce: number;
}

/** A request to reveal a specific 1-based line/column in a file (search → editor). */
export interface RevealTarget {
  path: string;
  line: number;
  column: number;
  nonce: number;
}

/** A request to reveal a file/folder in the explorer tree (breadcrumbs → explorer). */
export interface RevealEntry {
  path: string;
  nonce: number;
}

/** A location in the back/forward navigation history. */
interface NavEntry {
  path: string;
  line: number;
  column: number;
}

interface WorkspaceContextValue {
  rootPath: string | null;
  rootName: string | null;
  /** Editor groups (1 or more), left to right. */
  groups: EditorGroup[];
  /** Id of the focused group. */
  activeGroupId: string;
  /** Focused group's active tab (compat + status bar / breadcrumbs). */
  activePath: string | null;
  /** Focused group's tabs (compat). */
  tabs: OpenTab[];
  dirtyPaths: ReadonlySet<string>;
  /** Paths of pinned tabs (session-only; pinned tabs lead their group). */
  pinnedPaths: ReadonlySet<string>;
  /** Recently opened file paths, most-recent first (session-only; for Quick Open). */
  recentFiles: string[];
  refreshNonce: number;
  collapseNonce: number;
  expandSignal: ExpandSignal | null;
  revealTarget: RevealTarget | null;
  revealEntry: RevealEntry | null;
  recentFolders: RecentFolder[];
  recentsLoaded: boolean;
  openFolder: () => Promise<void>;
  openFiles: () => Promise<void>;
  openDroppedEntry: (entry: OpenPathResult) => Promise<void>;
  openRecent: (path: string) => Promise<void>;
  clearRecents: () => void;
  openFile: (
    path: string,
    name: string,
    options?: { preview?: boolean; at?: { line: number; column: number } },
  ) => void;
  openFileAt: (path: string, name: string, line: number, column: number) => void;
  /** Open a new empty untitled buffer in the focused group. */
  newUntitled: () => void;
  /** True if a path is open as a tab in any group (used to guard Save As). */
  isFileOpen: (path: string) => boolean;
  /** Live tab paths and generation from the synchronously published workspace state. */
  getOpenFileSnapshot: () => { paths: string[]; generation: number };
  gotoLine: (line: number, column: number) => void;
  /** Navigate back/forward through visited locations (Go Back / Go Forward). */
  navigateBack: () => void;
  navigateForward: () => void;
  /** Report the live cursor position so a jump can capture where you left from. */
  noteCursor: (line: number, column: number) => void;
  closeTab: (path: string) => void;
  closeTabs: (paths: string[]) => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  reopenClosed: () => void;
  reorderTabs: (fromPath: string, toPath: string) => void;
  /** Toggle pinned state of a tab (keeps the group's pinned zone contiguous). */
  togglePin: (path: string) => void;
  /** Promote a preview tab to a permanent one (clears its group's preview slot). */
  keepOpen: (path: string) => void;
  setActive: (path: string) => void;
  /** Focus a group by id (e.g. when its editor gains focus). */
  focusGroup: (id: string) => void;
  focusNextGroup: () => void;
  focusPreviousGroup: () => void;
  /** Move an editor (default: the focused group's active) into the other group. */
  moveEditorToOtherGroup: (path?: string) => void;
  /** Move a specific tab into an existing target group. */
  moveTabToGroup: (path: string, targetGroupId: string) => void;
  markDirty: (path: string, dirty: boolean) => void;
  bumpRefresh: () => void;
  collapseAll: () => void;
  expandPath: (path: string) => void;
  applyRename: (oldPath: string, newPath: string, newName: string) => void;
  applyDelete: (path: string) => void;
  revealInExplorer: (path: string) => void;
  revealActiveFile: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

let groupIdSeq = 1;
function nextGroupId(): string {
  groupIdSeq += 1;
  return `group-${groupIdSeq}`;
}

/** Untitled buffers use an `untitled:` pseudo-path as their unique key. */
export function isUntitledPath(p: string): boolean {
  return p.startsWith('untitled:');
}

/** Recompute a group's active tab after `removed` is taken out (nearest survivor). */
function activeAfterRemoval(group: EditorGroup, removed: ReadonlySet<string>): string | null {
  if (group.active === null || !removed.has(group.active)) return group.active;
  const idx = group.tabs.findIndex((t) => t.path === group.active);
  for (let i = idx; i < group.tabs.length; i += 1) {
    const t = group.tabs[i];
    if (t && !removed.has(t.path)) return t.path;
  }
  for (let i = idx - 1; i >= 0; i -= 1) {
    const t = group.tabs[i];
    if (t && !removed.has(t.path)) return t.path;
  }
  return null;
}

/**
 * Stable-partition a group's tabs so pinned ones lead, preserving relative order
 * within each zone. Returns the original array if the order is already correct
 * (avoids needless re-renders). Keeps the pinned zone contiguous at the front.
 */
function sortPinned(tabs: OpenTab[], pinned: ReadonlySet<string>): OpenTab[] {
  if (pinned.size === 0) return tabs;
  const pin: OpenTab[] = [];
  const rest: OpenTab[] = [];
  for (const t of tabs) (pinned.has(t.path) ? pin : rest).push(t);
  if (pin.length === 0 || pin.length === tabs.length) return tabs;
  const next = [...pin, ...rest];
  return next.every((t, i) => t === tabs[i]) ? tabs : next;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootName, setRootName] = useState<string | null>(null);
  const [groups, setGroups] = useState<EditorGroup[]>(() => [
    { id: 'group-1', tabs: [], active: null, preview: null },
  ]);
  const [activeGroupId, setActiveGroupId] = useState('group-1');
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set<string>());
  const [pinnedPaths, setPinnedPaths] = useState<ReadonlySet<string>>(new Set<string>());
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [collapseNonce, setCollapseNonce] = useState(0);
  const [expandSignal, setExpandSignal] = useState<ExpandSignal | null>(null);
  const [revealTarget, setRevealTarget] = useState<RevealTarget | null>(null);
  const [revealEntry, setRevealEntry] = useState<RevealEntry | null>(null);
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>([]);
  const [recentsLoaded, setRecentsLoaded] = useState(false);

  const activeGroup = groups.find((g) => g.id === activeGroupId) ??
    groups[0] ?? { id: 'group-1', tabs: [], active: null, preview: null };
  const activePath = activeGroup.active;
  const tabs = activeGroup.tabs;

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const groupsGenerationRef = useRef(0);
  const commitGroups = useCallback(
    (next: EditorGroup[]) => {
      groupsRef.current = next;
      groupsGenerationRef.current += 1;
      setGroups(next);
    },
    [setGroups],
  );
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const pinnedPathsRef = useRef(pinnedPaths);
  pinnedPathsRef.current = pinnedPaths;
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;
  const closedStackRef = useRef<OpenTab[]>([]);
  // Back/forward navigation history (browser-style stack + index).
  const navStackRef = useRef<NavEntry[]>([]);
  const navIndexRef = useRef(-1);
  const navigatingRef = useRef(false);
  const currentPosRef = useRef<NavEntry | null>(null);
  const previousMcpRootRef = useRef<string | null>(rootPath);

  const bumpRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const collapseAll = useCallback(() => setCollapseNonce((n) => n + 1), []);
  const expandPath = useCallback(
    (path: string) => setExpandSignal((s) => ({ path, nonce: (s?.nonce ?? 0) + 1 })),
    [],
  );

  // Commit a new group layout, dropping empty groups (keeping at least one) and
  // keeping the focused group valid.
  const applyGroups = useCallback(
    (next: EditorGroup[], focusId?: string) => {
      let g = next.length > 1 ? next.filter((grp) => grp.tabs.length > 0) : next;
      if (g.length === 0) {
        const keep = next[0];
        g = keep ? [keep] : [{ id: 'group-1', tabs: [], active: null, preview: null }];
      }
      commitGroups(g);
      const ids = g.map((grp) => grp.id);
      setActiveGroupId((cur) => {
        const want = focusId ?? cur;
        return ids.includes(want) ? want : (ids[0] ?? 'group-1');
      });
    },
    [commitGroups],
  );

  const pushClosed = useCallback((removed: OpenTab[]) => {
    if (removed.length === 0) return;
    const paths = new Set(removed.map((t) => t.path));
    closedStackRef.current = [
      ...closedStackRef.current.filter((t) => !paths.has(t.path)),
      ...removed,
    ].slice(-25);
  }, []);

  const clearDirty = useCallback((paths: Iterable<string>) => {
    const set = new Set(paths);
    setDirtyPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of set) if (next.delete(p)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  const clearPinned = useCallback((paths: Iterable<string>) => {
    const set = new Set(paths);
    setPinnedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of set) if (next.delete(p)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  // Load recent folders once on startup.
  useEffect(() => {
    let cancelled = false;
    void window.axiom.recents
      .get()
      .then((list) => {
        if (!cancelled) setRecentFolders(list);
      })
      .finally(() => {
        if (!cancelled) setRecentsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the Main-owned window close guard synchronized with unsaved buffers.
  useEffect(() => {
    void window.axiom.app
      .setDirty({ root: rootPath, dirty: dirtyPaths.size > 0 })
      .catch(() => undefined);
  }, [dirtyPaths, rootPath]);

  // MCP process lifetime follows the renderer's workspace, not whether its sidebar
  // happens to be mounted. Main enforces owner + root and performs tree teardown.
  useEffect(() => {
    const previousRoot = previousMcpRootRef.current;
    previousMcpRootRef.current = rootPath;
    if (previousRoot && previousRoot !== rootPath) {
      void window.axiom.mcp.disconnectWorkspace(previousRoot).catch(() => undefined);
    }
  }, [rootPath]);

  // Switch the open workspace and restore its disk-backed tab metadata.
  // A workspace replacement is destructive to untitled/dirty buffers, so the
  // user must explicitly confirm before any state is discarded.
  const switchToFolder = useCallback(
    async (path: string, name: string): Promise<boolean> => {
      if (
        rootPath !== path &&
        dirtyPathsRef.current.size > 0 &&
        !window.confirm(
          `You have ${dirtyPathsRef.current.size} unsaved file${dirtyPathsRef.current.size === 1 ? '' : 's'}. Discard those changes and open “${name}”?`,
        )
      ) {
        return false;
      }
      const restored = await window.axiom.editorState.read(path);
      const id = nextGroupId();
      setRootPath(path);
      setRootName(name);
      commitGroups([{ id, tabs: restored.tabs, active: restored.active, preview: null }]);
      setActiveGroupId(id);
      setDirtyPaths(new Set<string>());
      setPinnedPaths(new Set<string>());
      setRecentFiles([]);
      closedStackRef.current = [];
      navStackRef.current = [];
      navIndexRef.current = -1;
      currentPosRef.current = null;
      return true;
    },
    [commitGroups, rootPath],
  );

  const openFolder = useCallback(async () => {
    const result = await window.axiom.dialog.openFolder();
    if (!result || !(await switchToFolder(result.path, result.name))) return;
    notifyInfo(`Opened folder “${result.name}”`, { source: 'Workspace' });
    void window.axiom.recents.add(result.path, result.name).then(setRecentFolders);
  }, [switchToFolder]);

  const openRecent = useCallback(
    async (path: string) => {
      const result = await window.axiom.dialog.validateFolder(path);
      if (!result) {
        notifyError('That folder no longer exists', { source: 'Workspace', detail: path });
        void window.axiom.recents.remove(path).then(setRecentFolders);
        return;
      }
      if (!(await switchToFolder(result.path, result.name))) return;
      notifyInfo(`Opened folder “${result.name}”`, { source: 'Workspace' });
      void window.axiom.recents.add(result.path, result.name).then(setRecentFolders);
    },
    [switchToFolder],
  );

  const clearRecents = useCallback(() => {
    void window.axiom.recents.clear().then(setRecentFolders);
  }, []);

  // Track the live cursor location so a jump can capture where we left from.
  const noteCursor = useCallback((line: number, column: number) => {
    const path = activePathRef.current;
    if (path) currentPosRef.current = { path, line, column };
  }, []);

  // Record a navigation target, refining the current entry with the live leaving
  // position first (so Back returns to exactly where the cursor was). No-op while
  // we are the ones navigating (back/forward), so programmatic jumps aren't logged.
  const recordNav = useCallback((target: NavEntry) => {
    if (navigatingRef.current) return;
    const stack = navStackRef.current;
    const index = navIndexRef.current;
    const leaving = currentPosRef.current;
    const curEntry = index >= 0 ? stack[index] : undefined;
    if (leaving && curEntry && curEntry.path === leaving.path) {
      stack[index] = leaving;
    }
    const top = index >= 0 ? stack[index] : undefined;
    if (top && top.path === target.path && top.line === target.line) {
      stack[index] = target;
      return;
    }
    const next = stack.slice(0, index + 1);
    next.push(target);
    const capped = next.slice(-50);
    navStackRef.current = capped;
    navIndexRef.current = capped.length - 1;
  }, []);

  const openFile = useCallback(
    (
      path: string,
      name: string,
      options?: { preview?: boolean; at?: { line: number; column: number } },
    ) => {
      const preview = options?.preview ?? false;
      const current = groupsRef.current;
      const existing = current.find((g) => g.tabs.some((t) => t.path === path));
      if (existing) {
        // Already open: focus it. A permanent open promotes it out of preview.
        applyGroups(
          current.map((g) =>
            g.id === existing.id
              ? { ...g, active: path, preview: !preview && g.preview === path ? null : g.preview }
              : g,
          ),
          existing.id,
        );
      } else {
        const targetId = activeGroupIdRef.current;
        applyGroups(
          current.map((g) => {
            if (g.id !== targetId) return g;
            if (preview && g.preview) {
              // Reuse the preview slot: replace the current preview tab in place.
              const tabs = g.tabs.map((t) => (t.path === g.preview ? { path, name } : t));
              return { ...g, tabs, active: path, preview: path };
            }
            return {
              ...g,
              tabs: [...g.tabs, { path, name }],
              active: path,
              preview: preview ? path : g.preview,
            };
          }),
          targetId,
        );
      }
      recordNav({ path, line: options?.at?.line ?? 1, column: options?.at?.column ?? 1 });
      // Track most-recently-used files for Quick Open (session-only).
      if (!isUntitledPath(path)) {
        setRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, 50));
      }
    },
    [applyGroups, recordNav],
  );

  const openFiles = useCallback(async (): Promise<void> => {
    try {
      const selected = await window.axiom.dialog.openFiles();
      for (const file of selected) openFile(file.path, file.name);
      if (selected.length > 0) {
        notifyInfo(
          selected.length === 1
            ? `Opened “${selected[0]?.name ?? 'file'}”`
            : `Opened ${selected.length} files`,
          { source: 'Editor' },
        );
      }
    } catch (error) {
      notifyError('Could not open the selected file', {
        source: 'Editor',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [openFile]);

  const openDroppedEntry = useCallback(
    async (entry: OpenPathResult): Promise<void> => {
      if (entry.kind === 'directory') {
        if (!(await switchToFolder(entry.path, entry.name))) return;
        notifyInfo(`Opened folder “${entry.name}”`, { source: 'Workspace' });
        void window.axiom.recents.add(entry.path, entry.name).then(setRecentFolders);
        return;
      }
      openFile(entry.path, entry.name);
    },
    [openFile, switchToFolder],
  );

  const openFileAt = useCallback(
    (path: string, name: string, line: number, column: number) => {
      openFile(path, name, { at: { line, column } });
      setRevealTarget((prev) => ({ path, line, column, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [openFile],
  );

  const navigateTo = useCallback(
    (entry: NavEntry) => {
      navigatingRef.current = true;
      try {
        const name = entry.path.split(/[\\/]/).pop() ?? entry.path;
        openFileAt(entry.path, name, entry.line, entry.column);
      } finally {
        navigatingRef.current = false;
      }
    },
    [openFileAt],
  );

  const navigateBack = useCallback(() => {
    const index = navIndexRef.current;
    if (index <= 0) return;
    const stack = navStackRef.current;
    const leaving = currentPosRef.current;
    const curEntry = stack[index];
    if (leaving && curEntry && curEntry.path === leaving.path) stack[index] = leaving;
    navIndexRef.current = index - 1;
    const entry = stack[index - 1];
    if (entry) navigateTo(entry);
  }, [navigateTo]);

  const navigateForward = useCallback(() => {
    const index = navIndexRef.current;
    const stack = navStackRef.current;
    if (index >= stack.length - 1) return;
    navIndexRef.current = index + 1;
    const entry = stack[index + 1];
    if (entry) navigateTo(entry);
  }, [navigateTo]);

  const newUntitled = useCallback(() => {
    const gs = groupsRef.current;
    const used = new Set(gs.flatMap((g) => g.tabs).map((t) => t.path));
    let n = 1;
    while (used.has(`untitled:Untitled-${n}`)) n += 1;
    const path = `untitled:Untitled-${n}`;
    const name = `Untitled-${n}`;
    const targetId = activeGroupIdRef.current;
    applyGroups(
      gs.map((g) =>
        g.id === targetId ? { ...g, tabs: [...g.tabs, { path, name }], active: path } : g,
      ),
      targetId,
    );
  }, [applyGroups]);

  const isFileOpen = useCallback(
    (path: string) => groupsRef.current.some((g) => g.tabs.some((t) => t.path === path)),
    [],
  );

  const getOpenFileSnapshot = useCallback(
    () => ({
      paths: groupsRef.current.flatMap((group) => group.tabs.map((tab) => tab.path)),
      generation: groupsGenerationRef.current,
    }),
    [],
  );

  const gotoLine = useCallback(
    (line: number, column: number) => {
      const path = activePathRef.current;
      if (!path) return;
      recordNav({ path, line, column });
      setRevealTarget((prev) => ({ path, line, column, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [recordNav],
  );

  const setActive = useCallback((path: string) => {
    const current = groupsRef.current;
    const group = current.find((g) => g.tabs.some((t) => t.path === path));
    if (!group) return;
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, active: path } : g)));
    setActiveGroupId(group.id);
  }, []);

  const focusGroup = useCallback((id: string) => {
    if (groupsRef.current.some((g) => g.id === id)) setActiveGroupId(id);
  }, []);

  const cycleGroup = useCallback((delta: number) => {
    const gs = groupsRef.current;
    if (gs.length < 2) return;
    const i = gs.findIndex((g) => g.id === activeGroupIdRef.current);
    const next = gs[(i + delta + gs.length) % gs.length];
    if (next) setActiveGroupId(next.id);
  }, []);
  const focusNextGroup = useCallback(() => cycleGroup(1), [cycleGroup]);
  const focusPreviousGroup = useCallback(() => cycleGroup(-1), [cycleGroup]);

  const moveEditorToOtherGroup = useCallback(
    (path?: string) => {
      const gs = groupsRef.current;
      const src = path
        ? gs.find((g) => g.tabs.some((t) => t.path === path))
        : (gs.find((g) => g.id === activeGroupIdRef.current) ?? gs[0]);
      if (!src) return;
      const movePath = path ?? src.active;
      if (!movePath) return;
      const tab = src.tabs.find((t) => t.path === movePath);
      if (!tab) return;
      const removed = new Set([movePath]);
      const newSrc: EditorGroup = {
        ...src,
        tabs: src.tabs.filter((t) => t.path !== movePath),
        active: activeAfterRemoval(src, removed),
        preview: src.preview === movePath ? null : src.preview,
      };
      const other = gs.find((g) => g.id !== src.id);
      if (!other) {
        const otherId = nextGroupId();
        applyGroups(
          [newSrc, { id: otherId, tabs: [tab], active: movePath, preview: null }],
          otherId,
        );
        return;
      }
      applyGroups(
        gs.map((g) => {
          if (g.id === src.id) return newSrc;
          if (g.id === other.id) {
            const has = g.tabs.some((t) => t.path === movePath);
            const merged = has ? g.tabs : [...g.tabs, tab];
            return { ...g, tabs: sortPinned(merged, pinnedPathsRef.current), active: movePath };
          }
          return g;
        }),
        other.id,
      );
    },
    [applyGroups],
  );

  // Move a specific tab into an existing target group (drag between groups).
  const moveTabToGroup = useCallback(
    (path: string, targetGroupId: string) => {
      const gs = groupsRef.current;
      const src = gs.find((g) => g.tabs.some((t) => t.path === path));
      const target = gs.find((g) => g.id === targetGroupId);
      if (!src || !target || src.id === target.id) return;
      const tab = src.tabs.find((t) => t.path === path);
      if (!tab) return;
      const removed = new Set([path]);
      applyGroups(
        gs.map((g) => {
          if (g.id === src.id)
            return {
              ...g,
              tabs: g.tabs.filter((t) => t.path !== path),
              active: activeAfterRemoval(g, removed),
              preview: g.preview === path ? null : g.preview,
            };
          if (g.id === target.id) {
            const has = g.tabs.some((t) => t.path === path);
            const merged = has ? g.tabs : [...g.tabs, tab];
            return { ...g, tabs: sortPinned(merged, pinnedPathsRef.current), active: path };
          }
          return g;
        }),
        target.id,
      );
    },
    [applyGroups],
  );

  const markDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      if (dirty === prev.has(path)) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
    // Editing a preview tab keeps it open.
    if (dirty && groupsRef.current.some((g) => g.preview === path)) {
      setGroups((prev) => prev.map((g) => (g.preview === path ? { ...g, preview: null } : g)));
    }
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      const current = groupsRef.current;
      const group = current.find((g) => g.tabs.some((t) => t.path === path));
      if (!group) return;
      const tab = group.tabs.find((t) => t.path === path);
      if (tab) pushClosed([tab]);
      const removed = new Set([path]);
      applyGroups(
        current.map((g) =>
          g.id === group.id
            ? {
                ...g,
                tabs: g.tabs.filter((t) => t.path !== path),
                active: activeAfterRemoval(g, removed),
                preview: g.preview === path ? null : g.preview,
              }
            : g,
        ),
      );
      clearDirty([path]);
      clearPinned([path]);
    },
    [applyGroups, pushClosed, clearDirty, clearPinned],
  );

  const closeTabs = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const toClose = new Set(paths);
      const current = groupsRef.current;
      const removed: OpenTab[] = [];
      const next = current.map((g) => {
        const keep = g.tabs.filter((t) => !toClose.has(t.path));
        if (keep.length === g.tabs.length) return g;
        for (const t of g.tabs) if (toClose.has(t.path)) removed.push(t);
        return {
          ...g,
          tabs: keep,
          active: activeAfterRemoval(g, toClose),
          preview: g.preview && toClose.has(g.preview) ? null : g.preview,
        };
      });
      if (removed.length === 0) return;
      pushClosed(removed);
      applyGroups(next);
      clearDirty(paths);
      clearPinned(paths);
    },
    [applyGroups, pushClosed, clearDirty, clearPinned],
  );

  const closeActiveTab = useCallback(() => {
    if (activePathRef.current) closeTab(activePathRef.current);
  }, [closeTab]);

  const closeAllTabs = useCallback(() => {
    pushClosed(groupsRef.current.flatMap((g) => g.tabs));
    const id = nextGroupId();
    commitGroups([{ id, tabs: [], active: null, preview: null }]);
    setActiveGroupId(id);
    setDirtyPaths(new Set<string>());
    setPinnedPaths(new Set<string>());
  }, [commitGroups, pushClosed]);

  const reopenClosed = useCallback(() => {
    const stack = closedStackRef.current;
    const last = stack[stack.length - 1];
    if (!last) return;
    closedStackRef.current = stack.slice(0, -1);
    openFile(last.path, last.name);
  }, [openFile]);

  const reorderTabs = useCallback((fromPath: string, toPath: string) => {
    if (fromPath === toPath) return;
    const current = groupsRef.current;
    const group = current.find(
      (g) => g.tabs.some((t) => t.path === fromPath) && g.tabs.some((t) => t.path === toPath),
    );
    if (!group) return;
    const fromIdx = group.tabs.findIndex((t) => t.path === fromPath);
    const toIdx = group.tabs.findIndex((t) => t.path === toPath);
    const reordered = [...group.tabs];
    const [moved] = reordered.splice(fromIdx, 1);
    if (!moved) return;
    reordered.splice(toIdx, 0, moved);
    // Re-assert the pinned-first invariant so a drag can't cross the boundary.
    const sorted = sortPinned(reordered, pinnedPathsRef.current);
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, tabs: sorted } : g)));
  }, []);

  const togglePin = useCallback((path: string) => {
    const group = groupsRef.current.find((g) => g.tabs.some((t) => t.path === path));
    if (!group) return;
    const nextPinned = new Set(pinnedPathsRef.current);
    if (nextPinned.has(path)) nextPinned.delete(path);
    else nextPinned.add(path);
    setPinnedPaths(nextPinned);
    setGroups((prev) =>
      prev.map((g) =>
        g.id === group.id
          ? {
              ...g,
              tabs: sortPinned(g.tabs, nextPinned),
              // Pinning a preview tab keeps it open.
              preview: g.preview === path ? null : g.preview,
            }
          : g,
      ),
    );
  }, []);

  const keepOpen = useCallback((path: string) => {
    setGroups((prev) => {
      if (!prev.some((g) => g.preview === path)) return prev;
      return prev.map((g) => (g.preview === path ? { ...g, preview: null } : g));
    });
  }, []);

  const revealInExplorer = useCallback((path: string) => {
    setRevealEntry((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const revealActiveFile = useCallback(() => {
    const path = activePathRef.current;
    if (path) setRevealEntry((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const applyRename = useCallback(
    (oldPath: string, newPath: string, newName: string) => {
      const sep = oldPath.includes('\\') ? '\\' : '/';
      const remap = (p: string): string | null => {
        if (p === oldPath) return newPath;
        if (p.startsWith(oldPath + sep)) return newPath + p.slice(oldPath.length);
        return null;
      };
      commitGroups(
        groupsRef.current.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => {
            const np = remap(t.path);
            if (np === null) return t;
            return { path: np, name: np === newPath ? newName : t.name };
          }),
          active: g.active ? (remap(g.active) ?? g.active) : g.active,
          preview: g.preview ? (remap(g.preview) ?? g.preview) : g.preview,
        })),
      );
      const remapSet = (prev: ReadonlySet<string>): ReadonlySet<string> => {
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          const np = remap(p);
          if (np) changed = true;
          next.add(np ?? p);
        }
        return changed ? next : prev;
      };
      setDirtyPaths(remapSet);
      setPinnedPaths(remapSet);
      setRecentFiles((prev) => {
        let changed = false;
        const next = prev.map((p) => {
          const np = remap(p);
          if (np) changed = true;
          return np ?? p;
        });
        return changed ? next : prev;
      });
    },
    [commitGroups],
  );

  const applyDelete = useCallback(
    (path: string) => {
      const sep = path.includes('\\') ? '\\' : '/';
      const affected = (p: string): boolean => p === path || p.startsWith(path + sep);
      const current = groupsRef.current;
      const removedSet = new Set<string>();
      for (const g of current) for (const t of g.tabs) if (affected(t.path)) removedSet.add(t.path);
      if (removedSet.size === 0) return;
      applyGroups(
        current.map((g) => ({
          ...g,
          tabs: g.tabs.filter((t) => !affected(t.path)),
          active: activeAfterRemoval(g, removedSet),
          preview: g.preview && affected(g.preview) ? null : g.preview,
        })),
      );
      clearDirty(removedSet);
      clearPinned(removedSet);
      setRecentFiles((prev) => prev.filter((p) => !affected(p)));
    },
    [applyGroups, clearDirty, clearPinned],
  );

  // Watch the open workspace and refresh the tree on any on-disk change.
  useEffect(() => {
    if (!rootPath) return;
    void window.axiom.fs.watchStart(rootPath);
    const off = window.axiom.fs.onDidChange(() => bumpRefresh());
    return () => off();
  }, [rootPath, bumpRefresh]);

  // Persist disk-backed tab metadata for workspace restoration. This is not hot
  // exit: unsaved model contents and untitled buffers are deliberately not stored.
  useEffect(() => {
    if (!rootPath) return;
    // Untitled buffers have no on-disk backing, so they are not restored.
    const allTabs = groups.flatMap((g) => g.tabs).filter((t) => !isUntitledPath(t.path));
    const persistActive = activePath && !isUntitledPath(activePath) ? activePath : null;
    void window.axiom.editorState.write(rootPath, { tabs: allTabs, active: persistActive });
  }, [rootPath, groups, activePath]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      rootPath,
      rootName,
      groups,
      activeGroupId,
      activePath,
      tabs,
      dirtyPaths,
      pinnedPaths,
      recentFiles,
      refreshNonce,
      collapseNonce,
      expandSignal,
      revealTarget,
      revealEntry,
      recentFolders,
      recentsLoaded,
      openFolder,
      openFiles,
      openDroppedEntry,
      openRecent,
      clearRecents,
      openFile,
      openFileAt,
      newUntitled,
      isFileOpen,
      getOpenFileSnapshot,
      gotoLine,
      navigateBack,
      navigateForward,
      noteCursor,
      closeTab,
      closeTabs,
      closeActiveTab,
      closeAllTabs,
      reopenClosed,
      reorderTabs,
      togglePin,
      keepOpen,
      setActive,
      focusGroup,
      focusNextGroup,
      focusPreviousGroup,
      moveEditorToOtherGroup,
      moveTabToGroup,
      markDirty,
      bumpRefresh,
      collapseAll,
      expandPath,
      applyRename,
      applyDelete,
      revealInExplorer,
      revealActiveFile,
    }),
    [
      rootPath,
      rootName,
      groups,
      activeGroupId,
      activePath,
      tabs,
      dirtyPaths,
      pinnedPaths,
      recentFiles,
      refreshNonce,
      collapseNonce,
      expandSignal,
      revealTarget,
      revealEntry,
      recentFolders,
      recentsLoaded,
      openFolder,
      openFiles,
      openDroppedEntry,
      openRecent,
      clearRecents,
      openFile,
      openFileAt,
      newUntitled,
      isFileOpen,
      getOpenFileSnapshot,
      gotoLine,
      navigateBack,
      navigateForward,
      noteCursor,
      closeTab,
      closeTabs,
      closeActiveTab,
      closeAllTabs,
      reopenClosed,
      reorderTabs,
      togglePin,
      keepOpen,
      setActive,
      focusGroup,
      focusNextGroup,
      focusPreviousGroup,
      moveEditorToOtherGroup,
      moveTabToGroup,
      markDirty,
      bumpRefresh,
      collapseAll,
      expandPath,
      applyRename,
      applyDelete,
      revealInExplorer,
      revealActiveFile,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
