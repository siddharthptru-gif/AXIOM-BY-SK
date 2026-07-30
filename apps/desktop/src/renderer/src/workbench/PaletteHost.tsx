import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFile } from '../../../common/ipc';
import type { WireWorkspaceSymbol } from '../../../common/vscodeLanguageWire';
import { usePalette, type PaletteMode } from '../commands/palette';
import { useCommandRegistry } from '../commands/registry';
import { useKeybindings } from '../commands/keybindings';
import { useWorkspace } from '../state/workspace';
import { useSettings } from '../settings/store';
import { SETTINGS } from '../settings/schema';
import { monaco } from '../editor/monacoEnv';
import { setEditorLanguage } from '../editor/languageBus';
import { setEditorEol } from '../editor/eolBus';
import {
  indentSetInsertSpaces,
  indentSetTabSize,
  indentConvertToSpaces,
  indentConvertToTabs,
  indentDetect,
} from '../editor/indentBus';
import { activeGoToSymbol } from '../editor/activeEditorBus';
import { queryWorkspaceSymbols, resolveWorkspaceSymbol } from '../editor/extensionProviders';
import { QuickPick, type QuickPickItem } from './QuickPick';
import { GotoLineInput } from './GotoLineInput';

/**
 * Hosts the Command Palette and Quick Open (PRD Part VII §103/§105). The chords
 * that open them are dispatched by the global keybindings service; here we only
 * render palettes and derive each command's shortcut hint from effective bindings.
 * Lazily lists + caches workspace files for Quick Open.
 */
export function PaletteHost() {
  const { mode, close, openCommands, openGoto, openWorkspaceSymbols, initialQuery } = usePalette();
  const { getCommands, runCommand, markRecent, getRecentCommandIds } = useCommandRegistry();
  const { getChordFor } = useKeybindings();
  const { rootPath, openFile, openFileAt, recentFiles, activePath, refreshNonce } = useWorkspace();
  const { set } = useSettings();

  // Quick Open file cache, keyed by both root and the Explorer refresh generation.
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [filesKey, setFilesKey] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const cacheKeyRef = useRef<string | null>(null);
  const fileCacheKey = rootPath ? `${rootPath}\u0000${refreshNonce}` : null;
  const fileStateCurrent = filesKey === fileCacheKey;

  // A refresh or root switch invalidates the stored cache. Render-time key
  // gating below hides the old generation even before this effect runs.
  useEffect(() => {
    cacheKeyRef.current = null;
    setFiles([]);
    setFilesKey(null);
    setFileListError(null);
    setLoadingFiles(false);
  }, [fileCacheKey]);

  useEffect(() => {
    if (mode !== 'files' || !rootPath || !fileCacheKey || cacheKeyRef.current === fileCacheKey) {
      return;
    }
    let cancelled = false;
    setFiles([]);
    setFilesKey(fileCacheKey);
    setFileListError(null);
    setLoadingFiles(true);
    void window.axiom.fs
      .listFiles(rootPath)
      .then((res) => {
        if (cancelled) return;
        setFiles(res.files);
        setFilesKey(fileCacheKey);
        cacheKeyRef.current = fileCacheKey;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setFiles([]);
        setFilesKey(fileCacheKey);
        setFileListError(
          `Could not list workspace files: ${detail}. Refresh Explorer and try again.`,
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileCacheKey, mode, rootPath]);

  const commandItems = useMemo<QuickPickItem[]>(() => {
    if (mode !== 'commands') return [];
    const recents = getRecentCommandIds();
    const rank = (id: string): number => {
      const i = recents.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return getCommands()
      .filter((command) => command.visible?.() !== false)
      .slice()
      .sort(
        (a, b) =>
          rank(a.id) - rank(b.id) ||
          (a.category ?? '').localeCompare(b.category ?? '') ||
          a.title.localeCompare(b.title),
      )
      .map((c) => {
        const disabled = c.enabled?.() === false;
        return {
          id: c.id,
          label: c.title,
          description: disabled ? (c.disabledReason?.() ?? 'Unavailable') : c.category,
          keybinding: getChordFor(c.id) ?? undefined,
          disabled,
          disabledReason: disabled ? c.disabledReason?.() : undefined,
          matchField: 'label' as const,
        };
      });
  }, [mode, getCommands, getChordFor, getRecentCommandIds]);

  const fileItems = useMemo<QuickPickItem[]>(() => {
    if (mode !== 'files') return [];
    // Recent files lead; the active file is deprioritized so Ctrl+P → Enter jumps
    // to the previously used file. Non-recent files keep their order (stable sort).
    const rank = new Map<string, number>();
    recentFiles.forEach((p, i) => {
      if (p !== activePath) rank.set(p, i);
    });
    return (fileStateCurrent ? files : [])
      .map((f) => ({
        id: f.path,
        label: f.name,
        description: f.rel,
        matchField: 'description' as const,
      }))
      .sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
  }, [mode, fileStateCurrent, files, recentFiles, activePath]);

  const languageItems = useMemo<QuickPickItem[]>(() => {
    if (mode !== 'language') return [];
    return monaco.languages
      .getLanguages()
      .map((l) => ({
        id: l.id,
        label: l.aliases?.[0] ?? l.id,
        description: (l.extensions ?? []).join(' ') || l.id,
        matchField: 'label' as const,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [mode]);

  const indentItems = useMemo<QuickPickItem[]>(() => {
    if (mode !== 'indent') return [];
    return [
      { id: 'spaces', label: 'Indent Using Spaces', matchField: 'label' as const },
      { id: 'tabs', label: 'Indent Using Tabs', matchField: 'label' as const },
      { id: 'size:2', label: 'Tab Size: 2', matchField: 'label' as const },
      { id: 'size:4', label: 'Tab Size: 4', matchField: 'label' as const },
      { id: 'size:8', label: 'Tab Size: 8', matchField: 'label' as const },
      { id: 'toSpaces', label: 'Convert Indentation to Spaces', matchField: 'label' as const },
      { id: 'toTabs', label: 'Convert Indentation to Tabs', matchField: 'label' as const },
      { id: 'detect', label: 'Detect Indentation from Content', matchField: 'label' as const },
    ];
  }, [mode]);

  const eolItems = useMemo<QuickPickItem[]>(() => {
    if (mode !== 'eol') return [];
    return [
      { id: 'LF', label: 'LF', description: 'Unix (\\n)', matchField: 'label' as const },
      { id: 'CRLF', label: 'CRLF', description: 'Windows (\\r\\n)', matchField: 'label' as const },
    ];
  }, [mode]);

  const appearanceItems = (settingKey: string, forMode: PaletteMode): QuickPickItem[] => {
    if (mode !== forMode) return [];
    const def = SETTINGS.find((s) => s.key === settingKey);
    return (def?.options ?? []).map((opt) => ({
      id: opt,
      label: def?.optionLabels?.[opt] ?? opt,
      matchField: 'label' as const,
    }));
  };
  const themeItems = appearanceItems('workbench.colorTheme', 'theme');
  const accentItems = appearanceItems('workbench.accentColor', 'accent');

  /**
   * Workspace symbols contributed by extensions (PRD Phase 6).
   *
   * Standalone Monaco has no workspace-symbol provider to register, so the query is asked of the
   * extension hosts directly and the matching is theirs — a `WorkspaceSymbolProvider` is defined to
   * receive the user's text and decide what matches, which is why the results are shown in the order
   * the providers returned them. Each keystroke supersedes the one before it: the token for an
   * abandoned query is cancelled, so a slow provider stops working on text the user has moved past.
   */
  const [symbolQuery, setSymbolQuery] = useState(initialQuery);
  const [symbolItems, setSymbolItems] = useState<QuickPickItem[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const symbolTargets = useRef(new Map<string, WireWorkspaceSymbol>());

  /**
   * Open the symbol the user picked, giving its provider the chance to resolve it first.
   *
   * A `WorkspaceSymbolProvider` may answer the query from an index and implement
   * `resolveWorkspaceSymbol` to compute the real range only for the symbol that is about to be opened —
   * so the list is built from what the provider returned, and the position is taken from the resolved
   * symbol. A provider without the method resolves to the item unchanged, which is why the unresolved
   * location is still expected to be usable.
   */
  const openWorkspaceSymbol = async (symbol: WireWorkspaceSymbol): Promise<void> => {
    const resolved = await resolveWorkspaceSymbol(symbol);
    let path: string;
    try {
      path = monaco.Uri.parse(resolved.location.uri).fsPath;
    } catch {
      return;
    }
    if (path.length === 0) return;
    openFileAt(
      path,
      path.split(/[\\/]/).pop() ?? path,
      resolved.location.range.start.line + 1,
      resolved.location.range.start.character + 1,
    );
  };

  // Text carried in from the Quick Open '#' prefix is the first query, not an empty one.
  useEffect(() => {
    if (mode === 'workspaceSymbols') setSymbolQuery(initialQuery);
  }, [mode, initialQuery]);

  useEffect(() => {
    if (mode !== 'workspaceSymbols') {
      setSymbolItems([]);
      setSymbolsLoading(false);
      return;
    }
    const source = new monaco.CancellationTokenSource();
    const timer = setTimeout(() => {
      setSymbolsLoading(true);
      void queryWorkspaceSymbols(symbolQuery, source.token)
        .then((symbols) => {
          if (source.token.isCancellationRequested) return;
          const targets = new Map<string, WireWorkspaceSymbol>();
          const items: QuickPickItem[] = [];
          symbols.forEach((symbol, index) => {
            let path: string;
            try {
              path = monaco.Uri.parse(symbol.location.uri).fsPath;
            } catch {
              return;
            }
            if (path.length === 0) return;
            const id = `${index}:${path}:${symbol.name}`;
            targets.set(id, symbol);
            const where =
              rootPath !== null && path.startsWith(rootPath)
                ? path.slice(rootPath.length + 1)
                : path;
            items.push({
              id,
              label: symbol.name,
              description:
                symbol.containerName !== undefined && symbol.containerName.length > 0
                  ? `${symbol.containerName} — ${where}`
                  : where,
              matchField: 'label',
            });
          });
          symbolTargets.current = targets;
          setSymbolItems(items);
        })
        .finally(() => {
          if (!source.token.isCancellationRequested) setSymbolsLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      source.cancel();
      source.dispose();
    };
  }, [mode, symbolQuery, rootPath]);

  // Quick Open prefix routing: '>' commands, ':' go to line, '@' go to symbol,
  // '#' workspace symbols from extension providers.
  const routeFilesPrefix = (q: string): void => {
    const first = q[0];
    if (first === '>') openCommands(q.slice(1));
    else if (first === ':') openGoto(q.slice(1));
    else if (first === '#') openWorkspaceSymbols(q.slice(1));
    else if (first === '@') {
      close();
      activeGoToSymbol();
    }
  };

  if (mode === 'commands') {
    return (
      <QuickPick
        placeholder="Type a command…"
        items={commandItems}
        initialQuery={initialQuery}
        emptyMessage="No matching commands"
        onAccept={(item) => {
          close();
          markRecent(item.id);
          runCommand(item.id);
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'files') {
    return (
      <QuickPick
        placeholder={
          rootPath
            ? 'Search files  (> commands, : line, @ symbol, # workspace symbols)'
            : 'Open a folder to search files'
        }
        items={fileItems}
        loading={fileStateCurrent && loadingFiles}
        emptyMessage={
          (fileStateCurrent ? fileListError : null) ??
          (rootPath ? 'No matching files' : 'No folder open')
        }
        onQueryChange={routeFilesPrefix}
        onAccept={(item) => {
          close();
          openFile(item.id, item.label);
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'workspaceSymbols') {
    return (
      <QuickPick
        placeholder="Search workspace symbols…"
        items={symbolItems}
        initialQuery={initialQuery}
        loading={symbolsLoading}
        emptyMessage={
          symbolQuery.length === 0 ? 'Type to search symbols' : 'No matching workspace symbols'
        }
        onQueryChange={setSymbolQuery}
        onAccept={(item) => {
          const symbol = symbolTargets.current.get(item.id);
          close();
          if (symbol === undefined) return;
          void openWorkspaceSymbol(symbol);
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'language') {
    return (
      <QuickPick
        placeholder="Select language mode…"
        items={languageItems}
        emptyMessage="No languages available"
        onAccept={(item) => {
          close();
          setEditorLanguage(item.id);
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'indent') {
    return (
      <QuickPick
        placeholder="Select indentation action…"
        items={indentItems}
        emptyMessage="No options"
        onAccept={(item) => {
          close();
          const id = item.id;
          if (id === 'spaces') indentSetInsertSpaces(true);
          else if (id === 'tabs') indentSetInsertSpaces(false);
          else if (id === 'toSpaces') indentConvertToSpaces();
          else if (id === 'toTabs') indentConvertToTabs();
          else if (id === 'detect') indentDetect();
          else if (id.startsWith('size:')) indentSetTabSize(Number(id.slice(5)));
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'eol') {
    return (
      <QuickPick
        placeholder="Select end of line sequence…"
        items={eolItems}
        emptyMessage="No options"
        onAccept={(item) => {
          close();
          setEditorEol(item.id === 'CRLF' ? 'CRLF' : 'LF');
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'theme') {
    return (
      <QuickPick
        placeholder="Select color theme…"
        items={themeItems}
        emptyMessage="No themes"
        onAccept={(item) => {
          close();
          set('workbench.colorTheme', item.id, 'user');
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'accent') {
    return (
      <QuickPick
        placeholder="Select accent color…"
        items={accentItems}
        emptyMessage="No accent colors"
        onAccept={(item) => {
          close();
          set('workbench.accentColor', item.id, 'user');
        }}
        onClose={close}
      />
    );
  }

  if (mode === 'gotoLine') {
    return <GotoLineInput />;
  }

  return null;
}
