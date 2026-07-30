import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from '../../common/ipc';
import { UpdateView } from './workbench/UpdateView';
import { openUpdate } from './workbench/updateBus';
import { TimelineView } from './workbench/TimelineView';
import { openTimeline } from './workbench/timelineBus';
import { requestTerminalFix } from './workbench/terminalFixAction';
import { installAudioCues } from './a11y/audioCue';
import { WorkspaceProvider, isUntitledPath, useWorkspace } from './state/workspace';
import { setLspNavigator, setLspWorkspaceRoot } from './editor/lsp';
import { setAiPanelRevealer } from './editor/aiActionBus';
import { setInlineCompletionEnabled, setInlineCompletionPriority } from './editor/inlineCompletion';
import { requestAiDockCommand, requestScmCommand } from './commands/commandBuses';
import { setCallHierarchyRevealer } from './editor/callHierarchyBus';
import { setHierarchyRevealer } from './editor/hierarchyBus';
import { revealProjectIntelligence } from './workbench/projectIntelligenceBus';
import { OnboardingWizard } from './workbench/OnboardingWizard';
import {
  LayoutProvider,
  useLayout,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_AI_WIDTH,
  MAX_AI_WIDTH,
} from './state/layout';
import { DiagnosticsProvider, useDiagnostics } from './state/diagnostics';
import { CommandRegistryProvider, useCommands, type Command } from './commands/registry';
import { AI_EDITOR_COMMANDS } from './commands/aiCommands';
import { PaletteProvider, usePalette } from './commands/palette';
import { KeybindingsProvider, useKeybindings } from './commands/keybindings';
import { SettingsProvider, useSettings } from './settings/store';
import { getEditorSettings } from './settings/schema';
import { presetAppBindings, parseKeymapPreset } from '../../common/keymapProfiles';
import { parseInlinePriority } from '../../common/nextEdit';
import { ThemeController } from './settings/ThemeController';
import { ContributionsController } from './editor/ContributionsController';
import { ExtensionHostBridge } from './workbench/ExtensionHostBridge';
import { WebviewLayer } from './workbench/WebviewLayer';
import { NotificationsProvider, useNotifications } from './notifications/store';
import { GitDecorationsProvider } from './state/gitStatus';
import { notifyError, notifyInfo } from './notifications/bus';
import {
  editorCloseActive,
  editorCloseOthers,
  editorCloseToRight,
  editorCloseSaved,
  editorCloseAll,
  editorCloseAllGroups,
} from './editor/editorCloseBus';
import {
  activeSave,
  activeSaveAs,
  activeSaveCopyAs,
  activeFormat,
  activeGoToSymbol,
  activeRevert,
  activeRunEditorAction as invokeActiveEditorAction,
} from './editor/activeEditorBus';
import type { IndentInfo } from './editor/indentBus';
import type { EditorEncoding } from './editor/EditorPane';
import { saveFile } from './editor/saveBus';
import { Toasts } from './workbench/Toasts';
import { LiveRegion } from './workbench/LiveRegion';
import { TitleBar } from './workbench/TitleBar';
import { ActivityBar } from './workbench/ActivityBar';
import { PrimarySidebar } from './workbench/PrimarySidebar';
import { ContributedContainerSidebar, useContributedWorkbench } from './workbench/ContributedViews';
import { AiView } from './workbench/AiView';
import { SidebarResizer } from './workbench/SidebarResizer';
import { EditorArea } from './workbench/EditorArea';
import { Panel } from './workbench/Panel';
import { StatusBar } from './workbench/StatusBar';
import { PaletteHost } from './workbench/PaletteHost';
import { SettingsView } from './workbench/SettingsView';
import { KeybindingsView } from './workbench/KeybindingsView';
import { AboutView } from './workbench/AboutView';
import { openAbout } from './workbench/aboutBus';
import { ProfilesView } from './workbench/ProfilesView';
import { openProfiles } from './workbench/profilesBus';
import { DiffHost } from './workbench/DiffHost';
import { AuthProvider, useAuth } from './state/auth';
import { SignInGate, SignInLoading } from './workbench/SignInGate';
import { TerminalsProvider, useTerminals } from './state/terminals';
import { setTerminalPanelController } from './state/extensionTerminalBus';
import { WorkspaceTrustProvider, useWorkspaceTrust } from './state/workspaceTrust';
import { ExplorerIcon, ShieldIcon } from './workbench/icons';

interface CursorPos {
  line: number;
  column: number;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function relativeToRoot(root: string | null, p: string): string {
  if (!root) return p;
  const sep = root.includes('\\') ? '\\' : '/';
  if (p === root) return baseName(p);
  return p.startsWith(root + sep) ? p.slice(root.length + 1) : p;
}

/** Order two positions the same way the diagnostics list is sorted. */
function diagCompare(
  a: { path: string; line: number; column: number },
  b: { path: string; line: number; column: number },
): number {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

/**
 * Workbench composition (PRD Part VII §102). Regions: Title Bar, Activity Bar,
 * Primary Sidebar, Editor Area + Panel, Status Bar. Registers the core commands
 * (view switching, file/editor actions, palette entry points).
 */
function Workbench() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [cursor, setCursor] = useState<CursorPos>({ line: 1, column: 1 });
  const [language, setLanguage] = useState<string>('');
  const [selectedChars, setSelectedChars] = useState(0);
  const [eol, setEol] = useState<string>('');
  const [encoding, setEncoding] = useState<EditorEncoding>('');
  const [indent, setIndent] = useState<IndentInfo | null>(null);
  const [fileDropActive, setFileDropActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const ws = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const layout = useLayout();
  const palette = usePalette();
  const settings = useSettings();
  const notifications = useNotifications();
  const keybindings = useKeybindings();
  const diagnostics = useDiagnostics();
  const auth = useAuth();
  const terminals = useTerminals();
  /**
   * Contributed view containers and views (PRD Phase 5 §1, §2, §9).
   *
   * Read as a snapshot beside the existing layout state rather than folded into it: `PrimaryViewId`
   * stays the fixed list this build ships, and third-party container ids live only here and in the
   * workbench service's own persistence file.
   */
  const contributed = useContributedWorkbench(layout.sidebarVisible);
  const activeContainer = contributed.containers.find(
    (container) => container.id === contributed.active,
  );
  const panelCanDockRight = !layout.aiPanelVisible && !layout.isConstrained;
  const canTogglePanelPosition = notifications.panelPosition === 'right' || panelCanDockRight;
  const panelPositionDisabledReason = layout.isConstrained
    ? 'Right panel docking is unavailable at the current window width.'
    : 'Close the Axiom AI dock before moving the panel to the right.';

  const restoredRef = useRef(false);

  const openTerminalPanel = (): void => {
    notifications.setPanelTab('terminal');
    notifications.setPanelOpen(true);
  };
  const toggleTerminal = (): void => {
    if (notifications.panelOpen && notifications.panelTab === 'terminal') {
      notifications.setPanelOpen(false);
    } else {
      openTerminalPanel();
    }
  };
  const activeRunEditorAction = (id: string): void => {
    if (invokeActiveEditorAction(id)) return;
    notifyInfo('Open or create a file to use this command.', { source: 'Editor' });
  };

  const handleReveal = (path: string): void => {
    ws.revealInExplorer(path);
    layout.showView('explorer');
  };

  // Open files or folders dropped from the OS. Preload derives each path from
  // the real File object, so renderer-controlled strings cannot grant access.
  const openDroppedFiles = async (files: File[]): Promise<void> => {
    for (const file of files) {
      try {
        const entry = await window.axiom.dialog.openDroppedPath(file);
        if (entry) await ws.openDroppedEntry(entry);
      } catch (error) {
        notifyError('Could not open the dropped item', {
          source: 'Workspace',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // OS "Open with AXIOM": Main authorizes the launch target and pushes the exact
  // descriptor here, so a file opens in the editor and a folder opens as the workspace.
  useEffect(() => {
    const dispose = window.axiom.app.onOpenPath((entry) => {
      void ws.openDroppedEntry(entry).catch((error: unknown) =>
        notifyError('Could not open the selected item', {
          source: 'Workspace',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    return dispose;
  }, [ws.openDroppedEntry]);

  /*
   * `Terminal.show()` and `Terminal.hide()` from an extension (PRD Phase 7).
   *
   * The terminal state sits below this chrome and cannot reach the panel, so the chrome registers
   * what those two calls mean — the same owner pattern as the AI panel revealer above. Focus is not
   * touched here: the pane itself decides, which is how `preserveFocus` is honoured.
   */
  useEffect(
    () =>
      setTerminalPanelController({
        reveal: () => openTerminalPanel(),
        hide: () => notifications.setPanelOpen(false),
      }),
    [notifications.setPanelTab, notifications.setPanelOpen],
  );

  // Jump to the next/previous diagnostic relative to the cursor (wraps around).
  const gotoProblem = (dir: 1 | -1): void => {
    const list = diagnostics.diagnostics;
    if (list.length === 0) return;
    const cur = { path: ws.activePath ?? '', line: cursor.line, column: cursor.column };
    let target: (typeof list)[number] | undefined;
    if (dir === 1) {
      target = list.find((d) => diagCompare(d, cur) > 0) ?? list[0];
    } else {
      for (const d of list) {
        if (diagCompare(d, cur) < 0) target = d;
        else break;
      }
      target = target ?? list[list.length - 1];
    }
    if (target) ws.openFileAt(target.path, target.name, target.line, target.column);
  };

  useEffect(() => {
    let cancelled = false;
    void window.axiom.app
      .getInfo()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        /* foundation: ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep language services unavailable until the current workspace is trusted.
  // setLspWorkspaceRoot reconciles every existing Monaco model on either change.
  useEffect(() => {
    setLspWorkspaceRoot(workspaceTrust.trusted ? ws.rootPath : null);
  }, [ws.rootPath, workspaceTrust.trusted]);

  // Inline editor AI actions reveal the AI panel before delivering (PRD Epoch G).
  useEffect(() => setAiPanelRevealer(() => layout.showAiPanel()), [layout.showAiPanel]);

  // Call-hierarchy results live under Project Intelligence → Understand.
  useEffect(
    () =>
      setCallHierarchyRevealer(() => {
        layout.showView('intelligence');
        revealProjectIntelligence('understand');
      }),
    [layout.showView],
  );

  // An extension's type/call hierarchy tree sits beside them (PRD Phase 7).
  useEffect(
    () =>
      setHierarchyRevealer(() => {
        layout.showView('intelligence');
        revealProjectIntelligence('understand');
      }),
    [layout.showView],
  );

  // Crash-recovery notice: report an unclean prior exit and the limits of
  // disk-backed tab restoration; unsaved buffer contents are not persisted.
  useEffect(() => {
    void window.axiom.crash
      .recoveryNotice()
      .then((n) => {
        if (n.unclean && n.summary) notifyInfo(n.summary, { source: 'Recovery' });
      })
      .catch(() => undefined);
    // Report the renderer as ready so Main records the cold-start 'dom-ready' mark
    // (PRD Phase 266). Fire-and-forget; recorded once in Main.
    void window.axiom.perf.markReady().catch(() => undefined);
  }, []);

  // Audio cues (PRD Phase 254): play a tone on error/warning notifications when the
  // a11y.audioCues setting is on. Prefs read live so toggling takes effect at once.
  useEffect(() => {
    return installAudioCues(() => ({ enabled: settings.values['a11y.audioCues'] === true }));
  }, [settings.values]);

  // Route cross-file go-to-definition / references into the workbench (PRD §108).
  useEffect(() => {
    setLspNavigator((path, line, column) =>
      ws.openFileAt(path, path.split(/[\\/]/).pop() ?? path, line, column),
    );
  }, [ws]);

  // Reopen the most recent folder on startup (opt-in), once both settings and
  // recents have loaded and no folder is open yet.
  useEffect(() => {
    if (restoredRef.current) return;
    if (!settings.loaded || !ws.recentsLoaded) return;
    restoredRef.current = true;
    const shouldRestore = settings.values['workbench.restoreLastFolder'] !== false;
    const mostRecent = ws.recentFolders[0];
    if (shouldRestore && !ws.rootPath && mostRecent) {
      void ws.openRecent(mostRecent.path);
    }
  }, [settings.loaded, settings.values, ws]);

  const commandDefinitions: Command[] = [
    {
      id: 'workbench.view.explorer',
      title: 'Show Explorer',
      category: 'View',
      run: () => layout.showView('explorer'),
    },
    {
      id: 'workbench.action.checkForUpdates',
      title: 'Check for Updates',
      category: 'Application',
      run: () => openUpdate(),
    },
    {
      id: 'workbench.action.about',
      title: 'About Axiom & Legal',
      category: 'Help',
      run: () => openAbout(),
    },
    {
      id: 'workbench.action.keymapProfiles',
      title: 'Manage Keymap Profiles',
      category: 'Preferences',
      run: () => openProfiles(),
    },
    {
      id: 'workbench.view.search',
      title: 'Find in Files',
      category: 'Search',
      run: () => layout.showView('search'),
    },
    {
      id: 'workbench.view.semanticSearch',
      title: 'Search Codebase by Meaning (on-device)',
      category: 'Search',
      run: () => layout.showView('semantic'),
    },
    {
      id: 'workbench.action.timeline',
      title: 'Open Timeline (Time Travel)',
      category: 'Checkpoints',
      run: () => openTimeline(),
    },
    {
      id: 'workbench.action.ai.fixLastCommand',
      title: 'AI: Fix the Last Failing Command',
      category: 'Terminal',
      run: () => {
        layout.showAiPanel();
        requestTerminalFix(ws.rootPath);
      },
    },
    // Command-palette + keyboard parity for every editor AI action (T3.15). These
    // were reachable only from the editor context menu; each now has one workbench
    // command that delegates to the focused editor, so nothing is mouse-only.
    ...AI_EDITOR_COMMANDS.map((entry): Command => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file in the editor first.',
      run: () => {
        if (!invokeActiveEditorAction(entry.editorAction)) {
          notifyError('No editor is focused', {
            source: 'Axiom AI',
            detail: 'Click into an editor, then run this command again.',
          });
        }
      },
    })),
    {
      id: 'workbench.action.explainRepo',
      title: 'Explain This Repo (local Markdown overview)',
      category: 'Project Intelligence',
      enabled: () => ws.rootPath !== null,
      disabledReason: () => 'Open a folder first.',
      run: () => layout.showView('intelligence'),
    },
    {
      id: 'workbench.view.scm',
      title: 'Show Source Control',
      category: 'View',
      run: () => {
        layout.showView('scm');
        requestScmCommand('view');
      },
    },
    {
      id: 'git.refresh',
      title: 'Source Control: Refresh',
      category: 'Source Control',
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () =>
        ws.rootPath ? 'Trust this workspace to refresh Source Control.' : 'Open a folder first.',
      run: () => {
        layout.showView('scm');
        requestScmCommand('refresh');
      },
    },
    {
      id: 'git.fetch',
      title: 'Source Control: Fetch',
      category: 'Source Control',
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () =>
        ws.rootPath ? 'Trust this workspace before fetching.' : 'Open a folder first.',
      run: () => {
        layout.showView('scm');
        requestScmCommand('fetch');
      },
    },
    {
      id: 'git.pull',
      title: 'Source Control: Pull (Fast-Forward Only)',
      category: 'Source Control',
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () =>
        ws.rootPath ? 'Trust this workspace before pulling.' : 'Open a folder first.',
      run: () => {
        layout.showView('scm');
        requestScmCommand('pull');
      },
    },
    {
      id: 'git.push',
      title: 'Source Control: Push',
      category: 'Source Control',
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () =>
        ws.rootPath ? 'Trust this workspace before pushing.' : 'Open a folder first.',
      run: () => {
        layout.showView('scm');
        requestScmCommand('push');
      },
    },
    {
      id: 'git.commitAndPush',
      title: 'Source Control: Commit and Push',
      category: 'Source Control',
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () =>
        ws.rootPath ? 'Trust this workspace before committing.' : 'Open a folder first.',
      run: () => {
        layout.showView('scm');
        requestScmCommand('commit-and-push');
      },
    },
    {
      id: 'github.connect',
      title: 'GitHub: Connect Account',
      category: 'Source Control',
      run: () => {
        layout.showView('scm');
        requestScmCommand('connect');
      },
    },
    {
      id: 'github.disconnect',
      title: 'GitHub: Disconnect Account',
      category: 'Source Control',
      run: () => {
        layout.showView('scm');
        requestScmCommand('disconnect');
      },
    },
    {
      id: 'workbench.view.run',
      title: 'Show Run and Debug',
      category: 'Run',
      run: () => layout.showView('run'),
    },
    {
      id: 'workbench.view.languages',
      title: 'Show Languages',
      category: 'View',
      run: () => layout.showView('languages'),
    },
    {
      id: 'workbench.view.projectIntelligence',
      title: 'Show Project Intelligence',
      category: 'View',
      run: () => layout.showView('intelligence'),
    },
    {
      id: 'workbench.view.projectIntelligence.understand',
      title: 'Project Intelligence: Understand',
      category: 'View',
      run: () => {
        layout.showView('intelligence');
        revealProjectIntelligence('understand');
      },
    },
    {
      id: 'workbench.view.projectIntelligence.context',
      title: 'Project Intelligence: Context',
      category: 'View',
      run: () => {
        layout.showView('intelligence');
        revealProjectIntelligence('context');
      },
    },
    {
      id: 'workbench.view.projectIntelligence.automate',
      title: 'Project Intelligence: Automate',
      category: 'View',
      run: () => {
        layout.showView('intelligence');
        revealProjectIntelligence('automate');
      },
    },
    {
      id: 'workbench.view.projectIntelligence.assure',
      title: 'Project Intelligence: Assure',
      category: 'View',
      run: () => {
        layout.showView('intelligence');
        revealProjectIntelligence('assure');
      },
    },
    {
      id: 'workbench.view.projectIntelligence.recover',
      title: 'Project Intelligence: Recover',
      category: 'View',
      run: () => {
        layout.showView('intelligence');
        revealProjectIntelligence('recover');
      },
    },
    {
      id: 'workbench.view.godMode',
      title: 'View: Show God Mode',
      category: 'View',
      run: () => layout.showView('godmode'),
    },
    {
      id: 'workbench.view.ai',
      title: 'Show Axiom AI',
      category: 'View',
      run: () => layout.showAiPanel(),
    },
    {
      id: 'workbench.action.ai.focusBuild',
      title: 'AI: Focus Build',
      category: 'Axiom AI',
      run: () => {
        layout.showAiPanel();
        void requestAiDockCommand('focus-build');
      },
    },
    {
      id: 'workbench.action.ai.newBuild',
      title: 'AI: New Build',
      category: 'Axiom AI',
      run: () => {
        layout.showAiPanel();
        void requestAiDockCommand('new-build');
      },
    },
    {
      id: 'workbench.action.ai.stopBuild',
      title: 'AI: Stop Build',
      category: 'Axiom AI',
      run: () => {
        layout.showAiPanel();
        void requestAiDockCommand('stop-build');
      },
    },
    {
      id: 'workbench.action.openFolder',
      title: 'Open Folder…',
      category: 'File',
      run: () => ws.openFolder(),
    },
    {
      id: 'workbench.action.files.openFile',
      title: 'Open File…',
      category: 'File',
      run: () => ws.openFiles(),
    },
    {
      id: 'workbench.action.files.newUntitledFile',
      title: 'New File',
      category: 'File',
      run: () => ws.newUntitled(),
    },
    {
      id: 'editor.action.undo',
      title: 'Undo',
      category: 'Edit',
      run: () => activeRunEditorAction('undo'),
    },
    {
      id: 'editor.action.redo',
      title: 'Redo',
      category: 'Edit',
      run: () => activeRunEditorAction('redo'),
    },
    {
      id: 'editor.action.clipboardCutAction',
      title: 'Cut',
      category: 'Edit',
      run: () => activeRunEditorAction('editor.action.clipboardCutAction'),
    },
    {
      id: 'editor.action.clipboardCopyAction',
      title: 'Copy',
      category: 'Edit',
      run: () => activeRunEditorAction('editor.action.clipboardCopyAction'),
    },
    {
      id: 'editor.action.clipboardPasteAction',
      title: 'Paste',
      category: 'Edit',
      run: () => activeRunEditorAction('editor.action.clipboardPasteAction'),
    },
    {
      id: 'editor.action.selectAll',
      title: 'Select All',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.selectAll'),
    },
    {
      id: 'editor.action.smartSelect.expand',
      title: 'Expand Selection',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.smartSelect.expand'),
    },
    {
      id: 'editor.action.smartSelect.shrink',
      title: 'Shrink Selection',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.smartSelect.shrink'),
    },
    {
      id: 'editor.action.insertCursorAbove',
      title: 'Add Cursor Above',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.insertCursorAbove'),
    },
    {
      id: 'editor.action.insertCursorBelow',
      title: 'Add Cursor Below',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.insertCursorBelow'),
    },
    {
      id: 'editor.action.addSelectionToNextFindMatch',
      title: 'Add Next Occurrence',
      category: 'Selection',
      run: () => activeRunEditorAction('editor.action.addSelectionToNextFindMatch'),
    },
    {
      id: 'workbench.action.clearRecentFolders',
      title: 'File: Clear Recent Folders',
      category: 'File',
      run: () => ws.clearRecents(),
    },
    {
      id: 'workbench.action.closeActiveEditor',
      title: 'Close Editor',
      category: 'File',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'There is no active editor to close.',
      run: () => editorCloseActive(),
    },
    {
      id: 'workbench.action.closeOtherEditors',
      title: 'Close Other Editors',
      category: 'File',
      run: () => editorCloseOthers(),
    },
    {
      id: 'workbench.action.closeEditorsToTheRight',
      title: 'Close Editors to the Right',
      category: 'File',
      run: () => editorCloseToRight(),
    },
    {
      id: 'workbench.action.closeSavedEditors',
      title: 'Close Saved Editors',
      category: 'File',
      run: () => editorCloseSaved(),
    },
    {
      id: 'workbench.action.closeEditorGroup',
      title: 'Close Editor Group',
      category: 'View',
      run: () => editorCloseAll(),
    },
    {
      id: 'workbench.action.closeAllEditors',
      title: 'Close All Editors',
      category: 'File',
      run: () => editorCloseAllGroups(),
    },
    {
      id: 'explorer.refresh',
      title: 'Refresh Explorer',
      category: 'Explorer',
      enabled: () => ws.rootPath !== null,
      disabledReason: () => 'Open a folder before refreshing Explorer.',
      run: () => ws.bumpRefresh(),
    },
    {
      id: 'explorer.collapseAll',
      title: 'Collapse Folders in Explorer',
      category: 'Explorer',
      enabled: () => ws.rootPath !== null,
      disabledReason: () => 'Open a folder before collapsing Explorer folders.',
      run: () => ws.collapseAll(),
    },
    {
      id: 'workbench.action.quickOpen',
      title: 'Go to File…',
      category: 'Go',
      enabled: () => ws.rootPath !== null,
      disabledReason: () => 'Open a folder before searching workspace files.',
      run: () => palette.openFiles(),
    },
    {
      id: 'workbench.action.workspace.enterRestrictedMode',
      title: 'Workspace: Enter Restricted Mode',
      category: 'Workspace',
      visible: () => ws.rootPath !== null && workspaceTrust.trusted,
      enabled: () => ws.rootPath !== null && workspaceTrust.trusted,
      disabledReason: () => 'Trust a workspace before entering Restricted Mode.',
      run: () => workspaceTrust.revoke(),
    },
    {
      id: 'workbench.action.showCommands',
      title: 'Show All Commands',
      category: 'Go',
      run: () => palette.openCommands(),
    },
    {
      id: 'workbench.action.openSettings',
      title: 'Preferences: Open Settings',
      category: 'Preferences',
      run: () => settings.open(),
    },
    {
      id: 'workbench.action.openSettingsJson',
      title: 'Preferences: Open Settings (JSON)',
      category: 'Preferences',
      run: async () => {
        const p = await window.axiom.settings.resolve('user');
        ws.openFile(p, p.split(/[\\/]/).pop() ?? 'settings.json');
      },
    },
    {
      id: 'workbench.action.openKeybindings',
      title: 'Preferences: Keyboard Shortcuts',
      category: 'Preferences',
      run: () => keybindings.openKb(),
    },
    {
      id: 'workbench.action.toggleSidebar',
      title: 'View: Toggle Primary Sidebar',
      category: 'View',
      run: () => layout.toggleSidebar(),
    },
    {
      id: 'workbench.action.togglePanel',
      title: 'View: Toggle Panel',
      category: 'View',
      run: () => notifications.togglePanel(),
    },
    {
      id: 'workbench.action.toggleMaximizedPanel',
      title: 'View: Toggle Maximized Panel',
      category: 'View',
      run: () => notifications.toggleMaximizePanel(),
    },
    {
      id: 'workbench.action.togglePanelPosition',
      title: 'View: Toggle Panel Position (Bottom/Right)',
      category: 'View',
      enabled: () => canTogglePanelPosition,
      disabledReason: () => panelPositionDisabledReason,
      run: () => notifications.togglePanelPosition(),
    },
    {
      id: 'workbench.action.toggleZenMode',
      title: 'View: Toggle Zen Mode',
      category: 'View',
      run: () => layout.toggleZenMode(),
    },
    {
      id: 'workbench.action.toggleCenteredLayout',
      title: 'View: Toggle Centered Layout',
      category: 'View',
      run: () => layout.toggleCenteredLayout(),
    },
    {
      id: 'workbench.action.toggleActivityBarVisibility',
      title: 'View: Toggle Activity Bar',
      category: 'View',
      run: () => layout.toggleActivityBar(),
    },
    {
      id: 'workbench.action.toggleStatusbarVisibility',
      title: 'View: Toggle Status Bar',
      category: 'View',
      run: () => layout.toggleStatusBar(),
    },
    {
      id: 'workbench.action.showProblems',
      title: 'Problems: Focus',
      category: 'View',
      run: () => {
        notifications.setPanelTab('problems');
        notifications.setPanelOpen(true);
      },
    },
    {
      id: 'workbench.files.reveal',
      title: 'Reveal Active File in Explorer',
      category: 'File',
      enabled: () =>
        ws.activePath !== null && ws.rootPath !== null && !isUntitledPath(ws.activePath),
      disabledReason: () => 'Open a saved workspace file before revealing it in Explorer.',
      run: () => {
        ws.revealActiveFile();
        layout.showView('explorer');
      },
    },
    {
      id: 'workbench.action.gotoLine',
      title: 'Go to Line/Column…',
      category: 'Go',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file before going to a line.',
      run: () => palette.openGoto(),
    },
    {
      id: 'editor.action.changeLanguageMode',
      title: 'Change Language Mode',
      category: 'Editor',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file before changing its language mode.',
      run: () => palette.openLanguage(),
    },
    {
      id: 'editor.action.changeIndentation',
      title: 'Change Indentation',
      category: 'Editor',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file before changing indentation.',
      run: () => palette.openIndent(),
    },
    {
      id: 'workbench.action.editor.changeEOL',
      title: 'Change End of Line Sequence',
      category: 'Editor',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file before changing its end-of-line sequence.',
      run: () => palette.openEol(),
    },
    {
      id: 'editor.action.marker.next',
      title: 'Go to Next Problem',
      category: 'Go',
      run: () => gotoProblem(1),
    },
    {
      id: 'editor.action.marker.prev',
      title: 'Go to Previous Problem',
      category: 'Go',
      run: () => gotoProblem(-1),
    },
    {
      id: 'workbench.action.reopenClosedEditor',
      title: 'Reopen Closed Editor',
      category: 'File',
      run: () => ws.reopenClosed(),
    },
    {
      id: 'workbench.action.navigateBack',
      title: 'Go Back',
      category: 'Go',
      run: () => ws.navigateBack(),
    },
    {
      id: 'workbench.action.navigateForward',
      title: 'Go Forward',
      category: 'Go',
      run: () => ws.navigateForward(),
    },
    {
      id: 'workbench.action.files.copyPath',
      title: 'Copy Path of Active File',
      category: 'File',
      enabled: () => ws.activePath !== null && !isUntitledPath(ws.activePath),
      disabledReason: () => 'Open a saved file before copying its path.',
      run: async () => {
        if (!ws.activePath) return;
        await window.axiom.system.copyText(ws.activePath);
        notifyInfo('Copied path to clipboard', { source: 'File' });
      },
    },
    {
      id: 'workbench.action.files.copyRelativePath',
      title: 'Copy Relative Path of Active File',
      category: 'File',
      enabled: () =>
        ws.activePath !== null && ws.rootPath !== null && !isUntitledPath(ws.activePath),
      disabledReason: () => 'Open a saved workspace file before copying its relative path.',
      run: async () => {
        if (!ws.activePath) return;
        await window.axiom.system.copyText(relativeToRoot(ws.rootPath, ws.activePath));
        notifyInfo('Copied relative path to clipboard', { source: 'File' });
      },
    },
    {
      id: 'workbench.action.files.copyFileName',
      title: 'Copy Name of Active File',
      category: 'File',
      enabled: () => ws.activePath !== null && !isUntitledPath(ws.activePath),
      disabledReason: () => 'Open a saved file before copying its name.',
      run: async () => {
        if (!ws.activePath) return;
        await window.axiom.system.copyText(baseName(ws.activePath));
        notifyInfo('Copied file name to clipboard', { source: 'File' });
      },
    },
    {
      id: 'editor.action.toggleWordWrap',
      title: 'View: Toggle Word Wrap',
      category: 'View',
      run: () =>
        settings.set(
          'editor.wordWrap',
          getEditorSettings(settings.values).wordWrap === 'off' ? 'on' : 'off',
          'user',
        ),
    },
    {
      id: 'editor.action.toggleMinimap',
      title: 'View: Toggle Minimap',
      category: 'View',
      run: () =>
        settings.set('editor.minimap.enabled', !getEditorSettings(settings.values).minimap, 'user'),
    },
    {
      id: 'editor.action.toggleLineNumbers',
      title: 'View: Toggle Line Numbers',
      category: 'View',
      run: () =>
        settings.set(
          'editor.lineNumbers',
          getEditorSettings(settings.values).lineNumbers === 'off' ? 'on' : 'off',
          'user',
        ),
    },
    {
      id: 'editor.action.toggleStickyScroll',
      title: 'View: Toggle Sticky Scroll',
      category: 'View',
      run: () =>
        settings.set(
          'editor.stickyScroll.enabled',
          !getEditorSettings(settings.values).stickyScroll,
          'user',
        ),
    },
    {
      id: 'editor.action.toggleRenderWhitespace',
      title: 'View: Toggle Render Whitespace',
      category: 'View',
      run: () =>
        settings.set(
          'editor.renderWhitespace',
          getEditorSettings(settings.values).renderWhitespace === 'none' ? 'all' : 'none',
          'user',
        ),
    },
    {
      id: 'breadcrumbs.toggle',
      title: 'View: Toggle Breadcrumbs',
      category: 'View',
      run: () => {
        const on = settings.values['workbench.breadcrumbs.enabled'] !== false;
        settings.set('workbench.breadcrumbs.enabled', !on, 'user');
      },
    },
    {
      id: 'editor.action.fontZoomIn',
      title: 'Editor Font: Zoom In',
      category: 'Editor',
      run: () =>
        settings.set(
          'editor.fontSize',
          Math.min(40, getEditorSettings(settings.values).fontSize + 1),
          'user',
        ),
    },
    {
      id: 'editor.action.fontZoomOut',
      title: 'Editor Font: Zoom Out',
      category: 'Editor',
      run: () =>
        settings.set(
          'editor.fontSize',
          Math.max(6, getEditorSettings(settings.values).fontSize - 1),
          'user',
        ),
    },
    {
      id: 'editor.action.fontZoomReset',
      title: 'Editor Font: Reset Zoom',
      category: 'Editor',
      run: () => settings.reset('editor.fontSize', 'user'),
    },
    {
      id: 'workbench.action.selectTheme',
      title: 'Preferences: Color Theme',
      category: 'Preferences',
      run: () => palette.openTheme(),
    },
    {
      id: 'workbench.action.selectAccentColor',
      title: 'Preferences: Accent Color',
      category: 'Preferences',
      run: () => palette.openAccent(),
    },
    {
      id: 'workbench.action.files.save',
      title: 'Save',
      category: 'File',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open or create a file before saving.',
      run: () => activeSave(),
    },
    {
      id: 'workbench.action.files.saveAs',
      title: 'Save As…',
      category: 'File',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open or create a file before using Save As.',
      run: () => activeSaveAs(),
    },
    {
      id: 'workbench.action.files.saveCopyAs',
      title: 'Save Copy As…',
      category: 'File',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open or create a file before saving a copy.',
      run: () => activeSaveCopyAs(),
    },
    {
      id: 'workbench.action.files.saveAll',
      title: 'Save All',
      category: 'File',
      enabled: () => ws.dirtyPaths.size > 0,
      disabledReason: () => 'There are no unsaved files.',
      run: async () => {
        await Promise.all([...ws.dirtyPaths].map((path) => saveFile(path)));
      },
    },
    {
      id: 'workbench.action.files.revert',
      title: 'Revert File',
      category: 'File',
      enabled: () => ws.activePath !== null && !isUntitledPath(ws.activePath),
      disabledReason: () => 'Open a saved file before reverting.',
      run: () => activeRevert(),
    },
    {
      id: 'editor.action.formatDocument',
      title: 'Format Document',
      category: 'Editor',
      run: () => activeFormat(),
    },
    {
      id: 'editor.action.quickOutline',
      title: 'Go to Symbol in Editor…',
      category: 'Go',
      run: () => activeGoToSymbol(),
    },
    {
      // Answered by extensions' workspace-symbol providers (PRD Phase 6); standalone Monaco has no
      // registration for them, so this palette is where they surface.
      id: 'workbench.action.showAllSymbols',
      title: 'Go to Symbol in Workspace…',
      category: 'Go',
      run: () => palette.openWorkspaceSymbols(),
    },
    // Code-intelligence navigation. These dispatch Monaco's own actions against
    // the focused pane, so they are driven by the language servers' providers.
    // Note F12 is reserved: Main blocks it as a DevTools accelerator, so
    // Go to Definition is on Ctrl+F12 (Ctrl+Click also works).
    {
      id: 'editor.action.revealDefinition',
      title: 'Go to Definition',
      category: 'Go',
      run: () => activeRunEditorAction('editor.action.revealDefinition'),
    },
    {
      id: 'editor.action.peekDefinition',
      title: 'Peek Definition',
      category: 'Go',
      run: () => activeRunEditorAction('editor.action.peekDefinition'),
    },
    {
      id: 'editor.action.goToTypeDefinition',
      title: 'Go to Type Definition',
      category: 'Go',
      run: () => activeRunEditorAction('editor.action.goToTypeDefinition'),
    },
    {
      id: 'editor.action.goToImplementation',
      title: 'Go to Implementations',
      category: 'Go',
      run: () => activeRunEditorAction('editor.action.goToImplementation'),
    },
    {
      id: 'editor.action.goToReferences',
      title: 'Find All References',
      category: 'Go',
      run: () => activeRunEditorAction('editor.action.goToReferences'),
    },
    {
      id: 'editor.action.rename',
      title: 'Rename Symbol',
      category: 'Refactor',
      run: () => activeRunEditorAction('editor.action.rename'),
    },
    {
      id: 'editor.action.quickFix',
      title: 'Quick Fix…',
      category: 'Refactor',
      run: () => activeRunEditorAction('editor.action.quickFix'),
    },
    {
      id: 'editor.action.refactor',
      title: 'Refactor…',
      category: 'Refactor',
      run: () => activeRunEditorAction('editor.action.refactor'),
    },
    {
      id: 'editor.action.sourceAction',
      title: 'Source Action… (Organize Imports)',
      category: 'Refactor',
      run: () => activeRunEditorAction('editor.action.sourceAction'),
    },
    {
      id: 'editor.action.showHover',
      title: 'Show Hover',
      category: 'Editor',
      run: () => activeRunEditorAction('editor.action.showHover'),
    },
    {
      id: 'editor.action.triggerSuggest',
      title: 'Trigger Suggest',
      category: 'Editor',
      run: () => activeRunEditorAction('editor.action.triggerSuggest'),
    },
    {
      id: 'editor.action.triggerParameterHints',
      title: 'Trigger Parameter Hints',
      category: 'Editor',
      run: () => activeRunEditorAction('editor.action.triggerParameterHints'),
    },
    {
      id: 'workbench.action.splitEditor',
      title: 'Move Active Editor to Split Group',
      category: 'View',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'Open a file before moving an editor to the split group.',
      run: () => ws.moveEditorToOtherGroup(),
    },
    {
      id: 'workbench.action.moveEditorToOtherGroup',
      title: 'Move Editor into Other Group',
      category: 'View',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'There is no active editor to move.',
      run: () => ws.moveEditorToOtherGroup(),
    },
    {
      id: 'workbench.action.togglePinEditor',
      title: 'Pin/Unpin Active Editor',
      category: 'View',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'There is no active editor to pin.',
      run: () => {
        if (ws.activePath) ws.togglePin(ws.activePath);
      },
    },
    {
      id: 'workbench.action.keepEditorOpen',
      title: 'Keep Editor Open',
      category: 'View',
      enabled: () => ws.activePath !== null,
      disabledReason: () => 'There is no active editor to keep open.',
      run: () => {
        if (ws.activePath) ws.keepOpen(ws.activePath);
      },
    },
    {
      id: 'workbench.action.focusFirstEditorGroup',
      title: 'Focus First Editor Group',
      category: 'View',
      run: () => {
        const g = ws.groups[0];
        if (g) ws.focusGroup(g.id);
      },
    },
    {
      id: 'workbench.action.focusSecondEditorGroup',
      title: 'Focus Second Editor Group',
      category: 'View',
      run: () => {
        const g = ws.groups[1];
        if (g) ws.focusGroup(g.id);
      },
    },
    {
      id: 'workbench.action.focusNextGroup',
      title: 'Focus Next Editor Group',
      category: 'View',
      run: () => ws.focusNextGroup(),
    },
    {
      id: 'workbench.action.focusPreviousGroup',
      title: 'Focus Previous Editor Group',
      category: 'View',
      run: () => ws.focusPreviousGroup(),
    },
    {
      id: 'workbench.action.signIn',
      title: 'Account: Sign In with Google',
      category: 'Account',
      run: () => auth.signInGoogle(),
    },
    {
      id: 'workbench.action.signOut',
      title: 'Account: Sign Out',
      category: 'Account',
      run: () => auth.signOut(),
    },
    {
      id: 'workbench.action.terminal.toggleTerminal',
      title: 'Terminal: Toggle Terminal',
      category: 'Terminal',
      run: () => toggleTerminal(),
    },
    {
      id: 'workbench.action.terminal.new',
      title: 'Terminal: Create New Terminal',
      category: 'Terminal',
      enabled: () => terminals.available,
      disabledReason: () => terminals.disabledReason,
      run: () => {
        openTerminalPanel();
        terminals.newTerminal();
      },
    },
    {
      id: 'workbench.action.terminal.split',
      title: 'Terminal: Split Terminal',
      category: 'Terminal',
      enabled: () => terminals.available && terminals.activeTabId !== null,
      disabledReason: () =>
        terminals.available ? 'Create a terminal before splitting it.' : terminals.disabledReason,
      run: () => {
        openTerminalPanel();
        terminals.splitActive();
      },
    },
    {
      id: 'workbench.action.terminal.killActive',
      title: 'Terminal: Kill Active Terminal',
      category: 'Terminal',
      enabled: () => terminals.activeTabId !== null,
      disabledReason: () => 'There is no active terminal to kill.',
      run: () => {
        if (terminals.activeTabId) terminals.closeTab(terminals.activeTabId);
      },
    },
    {
      id: 'workbench.action.tasks.runTask',
      title: 'Tasks: Show Task Runner',
      category: 'Run',
      enabled: () => ws.rootPath !== null,
      disabledReason: () => 'Open a folder before viewing workspace tasks.',
      run: () => layout.showView('run'),
    },
    {
      id: 'workbench.action.extensions.showInstalled',
      title: 'Extensions: Show Installed Extensions',
      category: 'Extensions',
      run: () => layout.showView('extensions'),
    },
    {
      id: 'workbench.action.extensions.signIn',
      title: 'Extensions: Sign In & Authenticate Extension Account',
      category: 'Extensions',
      run: () => layout.showView('extensions'),
    },
    {
      id: 'workbench.action.claude.signIn',
      title: 'Claude Code: Sign In / Connect Account',
      category: 'Claude',
      run: () => layout.showView('extensions'),
    },
    {
      id: 'workbench.action.claude.run',
      title: 'Claude Code: Run Interactive Session',
      category: 'Claude',
      run: () => layout.showView('extensions'),
    },
  ];
  useCommands(
    commandDefinitions.map((command): Command => {
      if (command.enabled || !command.id.startsWith('editor.')) return command;
      return {
        ...command,
        enabled: () => ws.activePath !== null,
        disabledReason: () => 'Open a file before running this editor command.',
      };
    }),
  );

  const trustHeading =
    workspaceTrust.status === 'checking'
      ? 'Checking workspace trust'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified'
        : 'Restricted Mode';
  const trustDescription =
    workspaceTrust.status === 'checking'
      ? 'Files stay editable while Axiom checks this workspace. Running workspace code, terminals, tasks, debugging, agents, language services, Git, extensions, and MCP servers remain blocked.'
      : workspaceTrust.status === 'error'
        ? 'Axiom could not verify the saved trust decision, so Restricted Mode remains active. Files stay editable, but running workspace code, terminals, tasks, debugging, agents, language services, Git, extensions, and MCP servers are blocked.'
        : 'Files stay editable. Running workspace code, terminals, tasks, debugging, agents, language services, Git, extensions, and MCP servers are blocked until you trust this workspace.';
  const showTrustBanner = !layout.zenMode && workspaceTrust.restricted;

  return (
    <div
      className={`workbench ${layout.zenMode ? 'zen' : ''} ${
        !layout.zenMode && !layout.statusBarVisible ? 'no-statusbar' : ''
      } ${layout.isCompact ? 'compact-layout' : ''} ${
        layout.isConstrained ? 'constrained-layout' : ''
      } ${layout.sidebarVisible ? 'has-sidebar' : ''} ${
        layout.aiPanelVisible ? 'has-ai-dock' : ''
      } ${layout.activityBarVisible ? '' : 'activity-hidden'} ${
        showTrustBanner ? 'has-trust-banner' : ''
      } ${fileDropActive ? 'file-drop-active' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        fileDragDepthRef.current += 1;
        setFileDropActive(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
        if (fileDragDepthRef.current === 0) setFileDropActive(false);
      }}
      onDragEnd={() => {
        fileDragDepthRef.current = 0;
        setFileDropActive(false);
      }}
      onDrop={(e) => {
        fileDragDepthRef.current = 0;
        setFileDropActive(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          e.preventDefault();
          void openDroppedFiles(files);
        }
      }}
    >
      {fileDropActive ? (
        <div className="workbench-drop-overlay" role="status" aria-live="polite">
          <span className="workbench-drop-icon" aria-hidden="true">
            <ExplorerIcon size={28} />
          </span>
          <strong>Open in Axiom</strong>
          <span>Drop files to edit them, or drop a folder to switch workspaces.</span>
        </div>
      ) : null}
      {layout.zenMode ? null : <TitleBar />}
      {showTrustBanner ? (
        <aside
          className={`workspace-trust-banner workspace-trust-${workspaceTrust.status}`}
          role={workspaceTrust.status === 'error' ? 'alert' : 'status'}
          aria-live={workspaceTrust.status === 'error' ? 'assertive' : 'polite'}
          aria-labelledby="workspace-trust-heading"
          aria-describedby="workspace-trust-description"
        >
          <span className="workspace-trust-icon" aria-hidden="true">
            <ShieldIcon size={18} />
          </span>
          <div className="workspace-trust-copy">
            <strong id="workspace-trust-heading">{trustHeading}</strong>
            <span id="workspace-trust-description">{trustDescription}</span>
          </div>
          <button
            type="button"
            className="btn btn-primary workspace-trust-action"
            disabled={workspaceTrust.status === 'checking'}
            aria-label={
              workspaceTrust.status === 'checking'
                ? 'Workspace trust check in progress'
                : 'Trust Workspace'
            }
            onClick={() => void workspaceTrust.trust()}
          >
            {workspaceTrust.status === 'checking' ? 'Checking\u2026' : 'Trust Workspace'}
          </button>
        </aside>
      ) : null}
      <div className="workbench-body">
        {!layout.zenMode && layout.activityBarVisible ? (
          <ActivityBar
            active={layout.sidebarVisible && activeContainer === undefined ? layout.activeView : ''}
            onChange={(id) => {
              // Choosing a built-in pane gives the sidebar back to AXIOM; the contributed
              // container is deselected rather than hidden behind it.
              contributed.select(null);
              layout.toggleView(id);
            }}
            onOpenSettings={settings.open}
            aiPanelVisible={layout.aiPanelVisible}
            onToggleAi={layout.toggleAiPanel}
            containers={contributed.containers}
            activeContainer={layout.sidebarVisible ? contributed.active : null}
            onSelectContainer={(containerId) => {
              contributed.select(containerId);
              if (!layout.sidebarVisible) layout.toggleSidebar();
            }}
          />
        ) : null}
        {layout.isCompact && (layout.sidebarVisible || layout.aiPanelVisible) ? (
          <button
            type="button"
            className="workbench-overlay-scrim"
            aria-label="Close auxiliary panel"
            onClick={layout.dismissAuxiliary}
          />
        ) : null}
        {layout.sidebarVisible && !layout.zenMode ? (
          <>
            {activeContainer === undefined ? (
              <PrimarySidebar view={layout.activeView} width={layout.sidebarWidth} />
            ) : (
              <ContributedContainerSidebar
                container={activeContainer}
                width={layout.sidebarWidth}
              />
            )}
            {layout.isCompact ? null : (
              <SidebarResizer
                width={layout.sidebarWidth}
                min={MIN_SIDEBAR_WIDTH}
                max={MAX_SIDEBAR_WIDTH}
                onResize={layout.setSidebarWidth}
              />
            )}
          </>
        ) : null}
        <div
          className={`editor-panel-col ${
            notifications.panelOpen && notifications.panelPosition === 'right' && panelCanDockRight
              ? 'panel-right'
              : ''
          } ${notifications.panelOpen && notifications.panelMaximized ? 'panel-maximized' : ''}`}
        >
          <EditorArea
            info={info}
            onCursor={(line, column) => {
              setCursor({ line, column });
              ws.noteCursor(line, column);
            }}
            onLanguage={setLanguage}
            onSelection={setSelectedChars}
            onEol={setEol}
            onEncoding={setEncoding}
            onIndent={setIndent}
            onReveal={handleReveal}
          />
          {layout.zenMode ? null : <Panel />}
        </div>
        {!layout.zenMode && layout.aiPanelVisible ? (
          <>
            {layout.isCompact ? null : (
              <SidebarResizer
                width={layout.aiPanelWidth}
                min={MIN_AI_WIDTH}
                max={MAX_AI_WIDTH}
                onResize={layout.setAiPanelWidth}
                side="right"
                label="Resize AI panel"
              />
            )}
            <aside className="ai-dock" style={{ width: layout.aiPanelWidth }} aria-label="Axiom AI">
              <AiView />
            </aside>
          </>
        ) : null}
      </div>
      {!layout.zenMode && layout.statusBarVisible ? (
        <StatusBar
          info={info}
          cursor={cursor}
          selectedChars={selectedChars}
          language={language}
          eol={eol}
          encoding={encoding}
          indent={indent}
        />
      ) : null}
    </div>
  );
}

function InlineCompletionSettingsSync(): null {
  const { values } = useSettings();
  const enabled = values['ai.completion.enabled'] !== false;
  const priority = parseInlinePriority(values['ai.completion.priority']);
  useEffect(() => {
    setInlineCompletionEnabled(enabled);
    setInlineCompletionPriority(priority);
  }, [enabled, priority]);
  return null;
}

/**
 * Applies the active keymap PRESET (setting `keymap.preset`) to the global command
 * keybindings (Phase 249). Rendered under SettingsProvider (which is nested below
 * KeybindingsProvider), it bridges the preset setting into the keybindings layer so
 * switching preset re-maps the workbench shortcuts app-wide. Renders nothing.
 */
function KeymapPresetSync(): null {
  const { values } = useSettings();
  const { setPresetBindings } = useKeybindings();
  const preset = parseKeymapPreset(values['keymap.preset']);
  useEffect(() => {
    setPresetBindings(presetAppBindings(preset));
  }, [preset, setPresetBindings]);
  return null;
}

function MainApp() {
  return (
    <CommandRegistryProvider>
      <KeybindingsProvider>
        <PaletteProvider>
          <WorkspaceProvider>
            <WorkspaceTrustProvider>
              <SettingsProvider>
                <ThemeController />
                <ContributionsController />
                <ExtensionHostBridge />
                <InlineCompletionSettingsSync />
                <KeymapPresetSync />
                <NotificationsProvider>
                  <DiagnosticsProvider>
                    <LayoutProvider>
                      <TerminalsProvider>
                        <GitDecorationsProvider>
                          <Workbench />
                          <PaletteHost />
                          <SettingsView />
                          <KeybindingsView />
                          <AboutView />
                          <UpdateView />
                          <TimelineView />
                          <ProfilesView />
                          <DiffHost />
                          <Toasts />
                          <LiveRegion />
                          <OnboardingWizard />
                          <WebviewLayer />
                        </GitDecorationsProvider>
                      </TerminalsProvider>
                    </LayoutProvider>
                  </DiagnosticsProvider>
                </NotificationsProvider>
              </SettingsProvider>
            </WorkspaceTrustProvider>
          </WorkspaceProvider>
        </PaletteProvider>
      </KeybindingsProvider>
    </CommandRegistryProvider>
  );
}

/**
 * Gate the workbench on being signed in.
 *
 * Local data is stored per account, so composing the workbench before AXIOM knows the
 * account would open whichever account's stores happened to be bound last — exactly
 * the leak this prevents. `MainApp` is not rendered at all until the session resolves,
 * rather than rendered-and-hidden, so no provider can start reading another account's
 * state behind the gate.
 */
function AuthGate() {
  const { status } = useAuth();
  if (status === 'loading') return <SignInLoading />;
  if (status !== 'signedIn') return <SignInGate />;
  return <MainApp />;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
