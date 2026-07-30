import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { useTerminals } from '../state/terminals';
import { useNotifications } from '../notifications/store';
import { notifyError, notifyInfo } from '../notifications/bus';
import { subscribeRuntimes } from '../state/runtimes';
import { languageForPath } from '../editor/language';
import {
  missingRuntimesFor,
  resolveRun,
  runCandidates,
  isRuntimeSatisfied,
  type RunContext,
  type RunCandidate,
} from '../../../common/runConfig';
import { runtimeDefinition } from '../../../common/runtimes';
import { languagePackForRuntime } from '../../../common/languagePacks';
import { useLayout } from '../state/layout';
import { ContextMenu, type MenuEntry } from './ContextMenu';

/**
 * Run ▶ — execute the open file with the right toolchain, no command typing.
 *
 * The command is inferred from the file's language plus the project's shape, and
 * gated on what is actually installed: a Java file on a machine without a JDK
 * explains what to install instead of producing a shell error. The chevron opens
 * every applicable command (dev server, cargo run, plain compile) so the inferred
 * default is a starting point rather than the only option.
 *
 * Execution goes through the integrated terminal, so the program is interactive —
 * stdin works, output streams live, and Ctrl+C stops it — and it inherits the same
 * workspace trust boundary as any other terminal.
 */
const MAX_ROOT_ENTRIES = 400;

export function RunButton() {
  const { rootPath, activePath } = useWorkspace();
  const terminals = useTerminals();
  const { setPanelOpen, setPanelTab } = useNotifications();
  const [available, setAvailable] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [rootFiles, setRootFiles] = useState<string[]>([]);
  const [packageScripts, setPackageScripts] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);

  useEffect(
    () =>
      subscribeRuntimes((next) => {
        setAvailable(next.available);
        setLoaded(next.loaded);
      }),
    [],
  );

  // Marker files and package scripts decide between a project command and a
  // single-file one, so they are read once per workspace rather than per render.
  useEffect(() => {
    if (!rootPath) {
      setRootFiles([]);
      setPackageScripts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const listing = await window.axiom.fs.readDirectory(rootPath);
        if (cancelled) return;
        const names = listing.entries.slice(0, MAX_ROOT_ENTRIES).map((entry) => entry.name);
        setRootFiles(names);
        if (!names.includes('package.json')) {
          setPackageScripts([]);
          return;
        }
        const manifest = await window.axiom.fs.readFile(`${rootPath}/package.json`);
        if (cancelled) return;
        const parsed: unknown = JSON.parse(manifest.content);
        const scripts =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { scripts?: unknown }).scripts
            : null;
        setPackageScripts(
          scripts && typeof scripts === 'object' && !Array.isArray(scripts)
            ? Object.keys(scripts as Record<string, unknown>)
            : [],
        );
      } catch {
        // An unreadable root or manifest simply means no project-level commands.
        if (!cancelled) setPackageScripts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const relPath = useMemo(() => {
    if (!rootPath || !activePath) return null;
    if (!activePath.toLowerCase().startsWith(rootPath.toLowerCase())) return null;
    return activePath.slice(rootPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  }, [rootPath, activePath]);

  const context = useMemo<RunContext | null>(() => {
    if (!relPath || !activePath) return null;
    return {
      relPath,
      languageId: languageForPath(activePath),
      rootFiles,
      packageScripts,
      available,
    };
  }, [relPath, activePath, rootFiles, packageScripts, available]);

  const execute = useCallback(
    (candidate: RunCandidate): void => {
      if (!context) return;
      if (!isRuntimeSatisfied(candidate.requires, available)) return;
      if (!terminals.available) {
        notifyError('The integrated terminal is unavailable', {
          source: 'Run',
          detail: 'Trust this folder to run programs from AXIOM.',
        });
        return;
      }
      const command = candidate.command
        .replaceAll('${file}', quote(context.relPath))
        .replaceAll('${fileNameBase}', quote(baseName(context.relPath).replace(/\.[^.]+$/, '')))
        .replaceAll('${fileName}', quote(baseName(context.relPath)))
        .replaceAll('${fileBase}', quote(context.relPath.replace(/\.[^./]+$/, '')));
      // A fresh terminal per run keeps one program's output from being mixed into
      // another's, and the panel is brought forward so the output is not missed.
      setPanelTab('terminal');
      setPanelOpen(true);
      terminals.newTerminal(undefined, command);
      notifyInfo(`${candidate.label}: ${command}`, { source: 'Run', toast: false });
    },
    [context, available, terminals, setPanelOpen, setPanelTab],
  );

  if (!context) return null;

  const resolved = resolveRun(context);
  const all = runCandidates(context);
  if (all.length === 0) return null;

  const missing = missingRuntimesFor(context);
  const blocked = resolved === null && missing.length > 0;
  const missingTool = blocked
    ? (runtimeDefinition(missing[0]?.requires ?? '')?.displayName ?? missing[0]?.requires ?? '')
    : '';

  const layout = useLayout();

  const handleMissingTool = useCallback(
    (reqRuntimeId: string) => {
      const toolName = runtimeDefinition(reqRuntimeId)?.displayName ?? reqRuntimeId;
      const pack = languagePackForRuntime(reqRuntimeId);
      layout.showView('languages');
      if (pack) {
        notifyInfo(`Opening Languages Marketplace for ${pack.displayName} (${toolName})…`, {
          source: 'Run',
          toast: true,
        });
      } else {
        notifyError(`${toolName} is not installed`, {
          source: 'Run',
          detail: installHint(toolName),
        });
      }
    },
    [layout],
  );

  const openMenu = (x: number, y: number): void => {
    const entries: MenuEntry[] = all.map((candidate) => {
      const ok = isRuntimeSatisfied(candidate.requires, available);
      const tool =
        runtimeDefinition(candidate.requires)?.displayName ?? candidate.requires;
      return {
        label: ok ? candidate.label : `${candidate.label} — Install ${tool}`,
        onSelect: () => {
          if (ok) execute(candidate);
          else handleMissingTool(candidate.requires);
        },
      };
    });
    entries.push({ separator: true });
    entries.push({
      label: 'Open Languages & Toolchains Marketplace',
      onSelect: () => layout.showView('languages'),
    });
    entries.push({
      label: 'Re-scan installed toolchains',
      onSelect: () => {
        void import('../state/runtimes').then((module) => module.refreshRuntimes(true));
      },
    });
    setMenu({ x, y, entries });
  };

  return (
    <>
      <div className="run-control">
        <button
          type="button"
          className={`run-button ${blocked ? 'blocked' : ''}`}
          disabled={!loaded && resolved === null}
          title={
            blocked
              ? `${missingTool} is not installed. Click to open Marketplace & install.`
              : resolved
                ? `${resolved.candidate.label} — ${resolved.command}`
                : 'Detecting installed toolchains…'
          }
          onClick={() => {
            if (blocked) {
              handleMissingTool(missing[0]?.requires ?? '');
              return;
            }
            if (resolved) execute(resolved.candidate);
          }}
        >
          <span className="run-glyph" aria-hidden="true">
            ▶
          </span>
          <span className="run-label">
            {blocked
              ? `Needs ${missingTool}`
              : (resolved?.candidate.label ?? (loaded ? 'Run' : 'Detecting…'))}
          </span>
        </button>
        <button
          type="button"
          className="run-more"
          aria-label="Choose how to run this file"
          title="Other run configurations"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.left, rect.bottom);
          }}
        >
          ⌄
        </button>
      </div>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      ) : null}
    </>
  );
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./\\:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** Where the user gets a missing toolchain, so the message is actionable. */
function installHint(tool: string): string {
  return `Install ${tool} and make sure it is on your PATH, then re-scan from the Run menu.`;
}
