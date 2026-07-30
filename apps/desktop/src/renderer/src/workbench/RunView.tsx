import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { useTerminals } from '../state/terminals';
import { useNotifications } from '../notifications/store';
import { DebugPanel } from './DebugPanel';
import { PlayIcon, ShieldIcon } from './icons';

/**
 * Run / Tasks view (PRD Epoch D). Lists the workspace's package.json scripts and
 * runs a chosen script in a dedicated integrated terminal, using the detected
 * package manager. A pragmatic, dependency-free task runner.
 */
interface ScriptEntry {
  name: string;
  command: string;
}

function sepOf(root: string): string {
  return root.includes('\\') ? '\\' : '/';
}

async function detectPackageManager(root: string): Promise<string> {
  try {
    const res = await window.axiom.fs.readDirectory(root);
    const names = new Set(res.entries.map((e) => e.name));
    if (names.has('pnpm-lock.yaml')) return 'pnpm';
    if (names.has('yarn.lock')) return 'yarn';
    if (names.has('bun.lockb')) return 'bun';
    return 'npm';
  } catch {
    return 'npm';
  }
}

function parseScripts(content: string): ScriptEntry[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
    const out: ScriptEntry[] = [];
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command === 'string') out.push({ name, command });
    }
    return out;
  } catch {
    return [];
  }
}

export function RunView() {
  const { rootPath, refreshNonce } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const terminals = useTerminals();
  const notifications = useNotifications();
  const [scripts, setScripts] = useState<ScriptEntry[] | null>(null);
  const [pm, setPm] = useState('npm');

  useEffect(() => {
    if (!rootPath) {
      setScripts(null);
      return;
    }
    let cancelled = false;
    const pkgPath = rootPath + sepOf(rootPath) + 'package.json';
    void window.axiom.fs
      .readFile(pkgPath)
      .then((f) => {
        if (!cancelled) setScripts(parseScripts(f.content));
      })
      .catch(() => {
        if (!cancelled) setScripts(null);
      });
    void detectPackageManager(rootPath).then((p) => {
      if (!cancelled) setPm(p);
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath, refreshNonce]);

  const tasksAvailable = rootPath !== null && workspaceTrust.trusted;
  const taskRestriction =
    workspaceTrust.status === 'checking'
      ? 'Checking workspace trust. Tasks remain disabled until the check finishes.'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified. Tasks remain disabled in Restricted Mode.'
        : 'Restricted Mode blocks tasks and workspace code execution. Trust this workspace to run a script.';

  const runScript = useCallback(
    (name: string) => {
      if (!tasksAvailable) return;
      notifications.setPanelTab('terminal');
      notifications.setPanelOpen(true);
      terminals.newTerminal(undefined, `${pm} run ${name}`);
    },
    [notifications, terminals, pm, tasksAvailable],
  );

  const scriptsContent = !rootPath ? (
    <div className="empty-state">
      <p>Open a folder to run tasks.</p>
    </div>
  ) : scripts === null ? (
    <div className="empty-state">
      <p>No package.json found in this folder.</p>
    </div>
  ) : scripts.length === 0 ? (
    <div className="empty-state">
      <p>No scripts defined in package.json.</p>
    </div>
  ) : (
    <div className="run-view">
      <div className="run-header">
        <span className="run-title">NPM Scripts</span>
        <span className="run-pm">{pm}</span>
      </div>
      {scripts.map((s) => (
        <div key={s.name} className="run-row" title={s.command}>
          <button
            type="button"
            className="run-play"
            aria-label={`Run ${s.name}`}
            aria-describedby={!tasksAvailable ? 'run-restricted-message' : undefined}
            title={tasksAvailable ? `Run "${s.name}"` : taskRestriction}
            disabled={!tasksAvailable}
            onClick={() => runScript(s.name)}
          >
            <PlayIcon />
          </button>
          <span className="run-name">{s.name}</span>
          <span className="run-cmd">{s.command}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="rundebug-view">
      <DebugPanel />
      <div className="rundebug-divider" />
      {rootPath && !workspaceTrust.trusted ? (
        <div
          id="run-restricted-message"
          className="capability-disabled"
          role="status"
          aria-live="polite"
        >
          <span className="capability-disabled-icon" aria-hidden="true">
            <ShieldIcon size={16} />
          </span>
          <div>
            <strong>Tasks unavailable</strong>
            <p>{taskRestriction}</p>
          </div>
        </div>
      ) : null}
      {scriptsContent}
    </div>
  );
}
