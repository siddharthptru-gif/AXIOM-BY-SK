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
import type {
  ExtensionTerminalCommand,
  ExtensionTerminalInfo,
  TerminalShellInfo,
} from '../../../common/ipc';
import { useSettings } from '../settings/store';
import { getTerminalSettings } from '../settings/schema';
import {
  deliverExtensionTerminalWrite,
  dropExtensionTerminalWrites,
  hideTerminalPanel,
  resetExtensionTerminalWrites,
  revealTerminalPanel,
  suppressNextTerminalFocus,
} from './extensionTerminalBus';
import { useWorkspace } from './workspace';
import { useWorkspaceTrust } from './workspaceTrust';

/**
 * Integrated terminal state (PRD Epoch D). Manages terminal sessions organized
 * into tabs; each tab can hold multiple split panes shown side by side. Sessions
 * stay alive across tab switches (the views are kept mounted). The actual PTY
 * lifecycle is owned by each TerminalView; this store only tracks structure.
 *
 * PRD Phase 7 adds panes an extension asked for. They are ordinary sessions with an extension
 * handle attached, so every existing path — splits, tab close, exit, the fix action — keeps working
 * unchanged; what the handle adds is that their lifecycle is also reported back to Main, which owns
 * which extension a pane belongs to. The renderer never names an extension.
 */
export interface TerminalSession {
  id: string;
  title: string;
  shell: string;
  /** A command auto-run once the PTY is ready (used by the Run/Tasks view). */
  initialCommand?: string;
  /** The extension terminal this pane was adopted for (PRD Phase 7), or absent. */
  extensionHandle?: number;
  /** True when an extension *is* the process (`Pseudoterminal`): no pty is spawned. */
  extensionPty?: boolean;
  /** `TerminalOptions.hideFromUser`: the shell runs, but the pane is not in the tab bar. */
  hidden?: boolean;
}

export interface TerminalTab {
  id: string;
  paneIds: string[];
}

interface TerminalsValue {
  available: boolean;
  disabledReason: string;
  shells: TerminalShellInfo[];
  sessions: Record<string, TerminalSession>;
  tabs: TerminalTab[];
  activeTabId: string | null;
  activePaneId: string | null;
  /** Panes that exist and run but are deliberately not in the tab bar (`hideFromUser`). */
  hiddenPaneIds: string[];
  newTerminal: (shell?: string, initialCommand?: string) => void;
  splitActive: (shell?: string) => void;
  closePane: (paneId: string) => void;
  closeTab: (tabId: string) => void;
  /** The pty behind a pane exited on its own. Carries the exit code Main reported. */
  paneExited: (paneId: string, exitCode: number | null) => void;
  setActiveTab: (tabId: string) => void;
  setActivePane: (paneId: string) => void;
  /** Create an initial terminal if none exist (called when the panel opens). */
  ensureOne: () => void;
}

const TerminalsContext = createContext<TerminalsValue | null>(null);

export function useTerminals(): TerminalsValue {
  const ctx = useContext(TerminalsContext);
  if (!ctx) throw new Error('useTerminals must be used within TerminalsProvider');
  return ctx;
}

function labelFor(shells: TerminalShellInfo[], id: string): string {
  return shells.find((s) => s.id === id)?.label ?? 'Terminal';
}

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const { values } = useSettings();
  const { rootPath } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const defaultShell = getTerminalSettings(values).defaultShell;
  const capabilityKey = rootPath && workspaceTrust.trusted ? rootPath : null;
  const available = capabilityKey !== null;

  const [shells, setShells] = useState<TerminalShellInfo[]>([]);
  const [sessions, setSessions] = useState<Record<string, TerminalSession>>({});
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [hiddenPaneIds, setHiddenPaneIds] = useState<string[]>([]);

  const shellsRef = useRef<TerminalShellInfo[]>([]);
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const activePaneIdRef = useRef<string | null>(null);
  const defaultShellRef = useRef<string>(defaultShell);
  const capabilityKeyRef = useRef<string | null>(capabilityKey);
  const sessionsRef = useRef<Record<string, TerminalSession>>({});
  /** Extension handle → pane id, so a command can find the pane without scanning sessions. */
  const paneForHandleRef = useRef<Map<number, string>>(new Map());
  /**
   * Extension handle → the tab its pane lives in.
   *
   * Kept beside the state rather than derived from it because a split is resolved while the parent's
   * `setTabs` may still be queued: two `create` commands can arrive in one tick, and the second one
   * has to name the tab the first will produce.
   */
  const tabIdForHandleRef = useRef<Map<number, string>>(new Map());
  /** Handles already reported closed, so `onDidCloseTerminal` can only fire once per terminal. */
  const closedHandlesRef = useRef<Set<number>>(new Set());
  defaultShellRef.current = defaultShell;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;
  activePaneIdRef.current = activePaneId;
  capabilityKeyRef.current = capabilityKey;
  sessionsRef.current = sessions;

  useEffect(() => {
    let cancelled = false;
    shellsRef.current = [];
    tabsRef.current = [];
    paneForHandleRef.current = new Map();
    tabIdForHandleRef.current = new Map();
    closedHandlesRef.current = new Set();
    resetExtensionTerminalWrites();
    setShells([]);
    setSessions({});
    setTabs([]);
    setActiveTabId(null);
    setActivePaneId(null);
    setHiddenPaneIds([]);

    if (!capabilityKey) return;

    void window.axiom.terminal
      .listShells()
      .then((list) => {
        if (cancelled || capabilityKeyRef.current !== capabilityKey) return;
        shellsRef.current = list;
        setShells(list);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [capabilityKey]);

  const resolveShell = useCallback((shell?: string): string => {
    if (shell) return shell;
    const list = shellsRef.current;
    const def = defaultShellRef.current;
    if (def && list.some((s) => s.id === def)) return def;
    return list[0]?.id ?? 'powershell';
  }, []);

  const createSession = useCallback(
    (shell?: string, initialCommand?: string): TerminalSession | null => {
      if (!capabilityKeyRef.current) return null;
      const sid = resolveShell(shell);
      const session: TerminalSession = {
        id: crypto.randomUUID(),
        title: labelFor(shellsRef.current, sid),
        shell: sid,
        ...(initialCommand ? { initialCommand } : {}),
      };
      setSessions((cur) => ({ ...cur, [session.id]: session }));
      return session;
    },
    [resolveShell],
  );

  const newTerminal = useCallback(
    (shell?: string, initialCommand?: string) => {
      const session = createSession(shell, initialCommand);
      if (!session) return;
      const tab: TerminalTab = { id: crypto.randomUUID(), paneIds: [session.id] };
      setTabs((cur) => [...cur, tab]);
      setActiveTabId(tab.id);
      setActivePaneId(session.id);
    },
    [createSession],
  );

  const splitActive = useCallback(
    (shell?: string) => {
      if (!capabilityKeyRef.current) return;
      const tabId = activeTabIdRef.current;
      if (!tabId) {
        newTerminal(shell);
        return;
      }
      const session = createSession(shell);
      if (!session) return;
      setTabs((cur) =>
        cur.map((t) => (t.id === tabId ? { ...t, paneIds: [...t.paneIds, session.id] } : t)),
      );
      setActivePaneId(session.id);
    },
    [createSession, newTerminal],
  );

  /**
   * One pane is gone, whatever ended it: the user closed it, its shell exited, or the extension that
   * created it called `dispose()`.
   *
   * Every route funnels through here so an extension terminal is reported closed exactly once and
   * with the real exit code. `onDidCloseTerminal` must fire when the *user* closes a pane an
   * extension created, and must not fire twice when both ends notice at the same moment.
   */
  const dropSession = useCallback((paneId: string, exitCode: number | null): void => {
    const session = sessionsRef.current[paneId];
    setTabs((cur) => {
      const next: TerminalTab[] = [];
      for (const t of cur) {
        if (t.paneIds.includes(paneId)) {
          const panes = t.paneIds.filter((p) => p !== paneId);
          if (panes.length > 0) next.push({ ...t, paneIds: panes });
        } else {
          next.push(t);
        }
      }
      return next;
    });
    setSessions((cur) => {
      if (!(paneId in cur)) return cur;
      const next = { ...cur };
      delete next[paneId];
      return next;
    });
    setHiddenPaneIds((cur) => (cur.includes(paneId) ? cur.filter((p) => p !== paneId) : cur));
    const handle = session?.extensionHandle ?? 0;
    if (handle <= 0) return;
    paneForHandleRef.current.delete(handle);
    tabIdForHandleRef.current.delete(handle);
    dropExtensionTerminalWrites(handle);
    if (closedHandlesRef.current.has(handle)) return;
    // Handles are never reused, so forgetting old ones cannot resurrect a report: every entry here
    // belongs to a terminal whose pane is already gone.
    if (closedHandlesRef.current.size >= 512) closedHandlesRef.current.clear();
    closedHandlesRef.current.add(handle);
    void window.axiom.extensionRuntime
      .reportTerminal({
        kind: 'closed',
        handle,
        ...(exitCode === null ? {} : { exitCode }),
      })
      .catch(() => undefined);
  }, []);

  const closePane = useCallback((paneId: string) => dropSession(paneId, null), [dropSession]);

  const paneExited = useCallback(
    (paneId: string, exitCode: number | null) => dropSession(paneId, exitCode),
    [dropSession],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      for (const paneId of [...tab.paneIds]) dropSession(paneId, null);
    },
    [dropSession],
  );

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    const tab = tabsRef.current.find((t) => t.id === tabId);
    setActivePaneId(tab?.paneIds[0] ?? null);
  }, []);

  const setActivePane = useCallback((paneId: string) => setActivePaneId(paneId), []);

  const ensureOne = useCallback(() => {
    if (!capabilityKeyRef.current) return;
    if (tabsRef.current.length === 0) newTerminal();
  }, [newTerminal]);

  // Reconcile active ids whenever the tab structure changes (e.g., after close).
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      if (activePaneId !== null) setActivePaneId(null);
      return;
    }
    const current = tabs.find((t) => t.id === activeTabId);
    const activeTab = current ?? tabs[tabs.length - 1];
    if (!activeTab) return;
    if (activeTab.id !== activeTabId) setActiveTabId(activeTab.id);
    if (!activePaneId || !activeTab.paneIds.includes(activePaneId)) {
      setActivePaneId(activeTab.paneIds[0] ?? null);
    }
  }, [tabs, activeTabId, activePaneId]);

  // ---------------------------------------------------------------------------
  // Extension terminals (PRD Phase 7 §1). Panes an extension asked for, addressed only by handle.
  // ---------------------------------------------------------------------------

  /**
   * Draw a pane for a terminal Main says an extension owns.
   *
   * Deliberately does not steal the panel or the active tab: upstream, `createTerminal()` only
   * creates, and `show()` is what reveals. The one exception is a workbench with no terminal at all,
   * where the reconcile effect would make this pane active anyway.
   */
  const adopt = useCallback(
    (info: ExtensionTerminalInfo): void => {
      if (info.handle <= 0 || paneForHandleRef.current.has(info.handle)) return;
      const shell = resolveShell();
      const session: TerminalSession = {
        id: crypto.randomUUID(),
        title: info.name.length > 0 ? info.name : labelFor(shellsRef.current, shell),
        shell,
        extensionHandle: info.handle,
        ...(info.extensionPty ? { extensionPty: true } : {}),
        ...(info.hideFromUser ? { hidden: true } : {}),
      };
      paneForHandleRef.current.set(info.handle, session.id);
      setSessions((cur) => ({ ...cur, [session.id]: session }));
      if (info.hideFromUser) {
        // No tab: the pane runs off-screen until `show()` promotes it, exactly as `hideFromUser` does
        // upstream. It is still a real pane, so it still reports its lifecycle.
        setHiddenPaneIds((cur) => (cur.includes(session.id) ? cur : [...cur, session.id]));
        return;
      }
      // `location: 'editor'` degrades to the panel — AXIOM has no terminal editors — which is visible
      // and closable rather than silently dropped.
      const parentTabId =
        info.splitParent > 0 ? tabIdForHandleRef.current.get(info.splitParent) : undefined;
      const tabId = parentTabId ?? crypto.randomUUID();
      tabIdForHandleRef.current.set(info.handle, tabId);
      setTabs((cur) =>
        cur.some((t) => t.id === tabId)
          ? cur.map((t) => (t.id === tabId ? { ...t, paneIds: [...t.paneIds, session.id] } : t))
          : [...cur, { id: tabId, paneIds: [session.id] }],
      );
      setActiveTabId((cur) => cur ?? tabId);
      setActivePaneId((cur) => cur ?? session.id);
    },
    [resolveShell],
  );

  /** `Terminal.show()`: promote a hidden pane if needed, make it active, open the panel. */
  const revealPane = useCallback((paneId: string, preserveFocus: boolean): void => {
    const orphan = !tabsRef.current.some((t) => t.paneIds.includes(paneId));
    const tabId = crypto.randomUUID();
    if (orphan) {
      const handle = sessionsRef.current[paneId]?.extensionHandle ?? 0;
      if (handle > 0) tabIdForHandleRef.current.set(handle, tabId);
      setTabs((cur) =>
        cur.some((t) => t.paneIds.includes(paneId))
          ? cur
          : [...cur, { id: tabId, paneIds: [paneId] }],
      );
      setHiddenPaneIds((cur) => cur.filter((p) => p !== paneId));
      setSessions((cur) => {
        const session = cur[paneId];
        return session?.hidden ? { ...cur, [paneId]: { ...session, hidden: false } } : cur;
      });
    }
    if (preserveFocus) suppressNextTerminalFocus(paneId);
    setActiveTabId(
      orphan ? tabId : (tabsRef.current.find((t) => t.paneIds.includes(paneId))?.id ?? null),
    );
    setActivePaneId(paneId);
    revealTerminalPanel(preserveFocus);
  }, []);

  const handleCommand = useCallback(
    (command: ExtensionTerminalCommand): void => {
      const paneId = paneForHandleRef.current.get(command.handle);
      switch (command.op) {
        case 'create':
          if (command.terminal) adopt(command.terminal);
          return;
        case 'dispose':
          if (paneId) dropSession(paneId, null);
          return;
        case 'show':
          if (paneId) revealPane(paneId, command.preserveFocus === true);
          return;
        case 'hide':
          // Upstream `hide()` collapses the panel only while this terminal is the one on screen.
          if (paneId && paneId === activePaneIdRef.current) hideTerminalPanel();
          return;
        case 'name': {
          const name = command.name ?? '';
          if (!paneId || name.length === 0) return;
          setSessions((cur) => {
            const session = cur[paneId];
            return session ? { ...cur, [paneId]: { ...session, title: name } } : cur;
          });
          return;
        }
        case 'write':
          if (command.data) deliverExtensionTerminalWrite(command.handle, command.data);
          return;
        default:
          return;
      }
    },
    [adopt, dropSession, revealPane],
  );

  // Subscribe first, then pull: an extension can have created terminals before this provider mounted
  // (or before the folder was trusted), and a command must not be missed in the gap between the two.
  useEffect(() => {
    if (!capabilityKey) return;
    let cancelled = false;
    const off = window.axiom.extensionRuntime.onTerminalCommand((command) => {
      if (!cancelled) handleCommand(command);
    });
    void window.axiom.extensionRuntime
      .terminals()
      .then(({ terminals }) => {
        if (cancelled || capabilityKeyRef.current !== capabilityKey) return;
        for (const info of terminals) {
          if (paneForHandleRef.current.has(info.handle)) continue;
          if (info.sessionId.length > 0) {
            // A pane from a previous renderer instance: its pty died with that window, so the record
            // is reported closed rather than adopted. That is also what fires `onDidCloseTerminal`.
            void window.axiom.extensionRuntime
              .reportTerminal({ kind: 'closed', handle: info.handle })
              .catch(() => undefined);
            continue;
          }
          adopt(info);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, [capabilityKey, adopt, handleCommand]);

  // `window.activeTerminal`. Main decides what each extension may see; the renderer only says which
  // pane is in front, including when it is a pane no extension owns.
  useEffect(() => {
    if (!capabilityKey) return;
    void window.axiom.extensionRuntime
      .reportTerminal({
        kind: 'active',
        handle: 0,
        ...(activePaneId ? { sessionId: activePaneId } : {}),
      })
      .catch(() => undefined);
  }, [capabilityKey, activePaneId]);

  const disabledReason = !rootPath
    ? 'Open a folder to use the integrated terminal.'
    : workspaceTrust.status === 'checking'
      ? 'Checking workspace trust. Terminal processes remain off until the check finishes.'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified. Terminal processes remain disabled.'
        : 'Restricted Mode blocks terminal processes. Trust this workspace to create a terminal.';

  const value = useMemo<TerminalsValue>(
    () => ({
      available,
      disabledReason,
      shells,
      sessions,
      tabs,
      activeTabId,
      activePaneId,
      hiddenPaneIds,
      newTerminal,
      splitActive,
      closePane,
      closeTab,
      paneExited,
      setActiveTab,
      setActivePane,
      ensureOne,
    }),
    [
      available,
      disabledReason,
      shells,
      sessions,
      tabs,
      activeTabId,
      activePaneId,
      hiddenPaneIds,
      newTerminal,
      splitActive,
      closePane,
      closeTab,
      paneExited,
      setActiveTab,
      setActivePane,
      ensureOne,
    ],
  );

  return <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>;
}
