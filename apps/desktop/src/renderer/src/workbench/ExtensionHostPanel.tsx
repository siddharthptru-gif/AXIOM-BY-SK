import { useCallback, useEffect, useState } from 'react';
import type { HostStatus } from '../../../common/vscodeHost';
import { useWorkspace } from '../state/workspace';
import { ShieldIcon } from './icons';

/**
 * Control over extension code: what is running, what is waiting for permission, and what
 * stopped.
 *
 * This panel exists because the alternative is a product that runs third-party code and gives
 * the user no view of it. Every state an extension host can be in is shown by name rather than
 * collapsed into on/off, since the difference between "declined", "not activated yet" and
 * "crashed three times and stopped" is the difference between three completely different
 * things for the user to do.
 *
 * Hidden entirely when nothing installed ships code — an empty panel about extension processes
 * is noise in a workspace that has none.
 */
const STATE_LABEL: Record<HostStatus['state'], string> = {
  inactive: 'Not running',
  starting: 'Starting…',
  active: 'Running',
  failed: 'Failed to start',
  crashed: 'Crashed — restarting',
  'disabled-after-crashes': 'Stopped after repeated crashes',
};

export function ExtensionHostPanel() {
  const { rootPath } = useWorkspace();
  const [hosts, setHosts] = useState<HostStatus[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ id: string; lines: string[] } | null>(null);

  const reload = useCallback(async () => {
    try {
      setHosts(await window.axiom.host.list(rootPath ?? null));
    } catch {
      setHosts([]);
    }
  }, [rootPath]);

  useEffect(() => {
    void reload();
    const stopHost = window.axiom.host.onChanged(() => void reload());
    const stopMarket = window.axiom.market.onChanged(() => void reload());
    return () => {
      stopHost();
      stopMarket();
    };
  }, [reload]);

  const act = useCallback(
    async (id: string, operation: () => Promise<unknown>) => {
      setBusy(id);
      try {
        await operation();
        await reload();
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const showOutput = useCallback(async (id: string) => {
    try {
      setOutput({ id, lines: await window.axiom.host.output(id) });
    } catch {
      setOutput({ id, lines: [] });
    }
  }, []);

  if (hosts.length === 0) return null;

  const running = hosts.filter((host) => host.state === 'active').length;

  return (
    <section className="ext-contrib">
      <button
        type="button"
        className="ext-contrib-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <ShieldIcon size={13} />
        <span className="ext-contrib-title">Extensions that run code</span>
        <span className="ext-badge ext-badge-quiet">
          {running}/{hosts.length}
        </span>
        <span className="ext-contrib-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <div className="ext-contrib-body">
          <p className="ext-host-note">
            Extension code runs as a separate process with your user account&rsquo;s full
            privileges. It can read and write your files and reach the network. Only allow
            extensions you trust.
          </p>
          {hosts.map((host) => (
            <div key={host.extensionId} className="ext-host-row">
              <div className="ext-host-main">
                <span className="ext-host-name">{host.displayName}</span>
                <span className={`ext-host-state is-${host.state}`}>{STATE_LABEL[host.state]}</span>
                {host.activationMs !== null && host.state === 'active' ? (
                  <span className="ext-host-meta">activated in {host.activationMs}ms</span>
                ) : null}
                {host.recentCrashes > 0 ? (
                  <span className="ext-host-meta">
                    {host.recentCrashes} recent crash{host.recentCrashes === 1 ? '' : 'es'}
                  </span>
                ) : null}
              </div>
              {host.detail !== null ? <p className="ext-host-detail">{host.detail}</p> : null}
              {host.commands.length > 0 ? (
                <p className="ext-host-detail">
                  {host.commands.length} command{host.commands.length === 1 ? '' : 's'} available in
                  the palette
                </p>
              ) : null}
              <div className="ext-host-actions">
                <button
                  type="button"
                  className="btn btn-ghost ext-action"
                  disabled={busy === host.extensionId}
                  onClick={() =>
                    void act(host.extensionId, () =>
                      window.axiom.host.setConsent(host.extensionId, true, rootPath ?? null),
                    )
                  }
                >
                  Allow and run
                </button>
                <button
                  type="button"
                  className="btn btn-ghost ext-action"
                  disabled={busy === host.extensionId}
                  onClick={() =>
                    void act(host.extensionId, () =>
                      window.axiom.host.setConsent(host.extensionId, false, rootPath ?? null),
                    )
                  }
                >
                  Never allow
                </button>
                <button
                  type="button"
                  className="btn btn-ghost ext-action"
                  disabled={busy === host.extensionId || host.state === 'inactive'}
                  onClick={() =>
                    void act(host.extensionId, () => window.axiom.host.stop(host.extensionId))
                  }
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="btn btn-ghost ext-action"
                  disabled={busy === host.extensionId}
                  onClick={() =>
                    void act(host.extensionId, () => window.axiom.host.restart(host.extensionId))
                  }
                >
                  Restart
                </button>
                <button
                  type="button"
                  className="btn btn-ghost ext-action"
                  onClick={() => void showOutput(host.extensionId)}
                >
                  Output
                </button>
              </div>
              {output?.id === host.extensionId ? (
                <pre className="ext-host-output" aria-label={`${host.displayName} output`}>
                  {output.lines.length === 0 ? 'Nothing logged yet.' : output.lines.join('\n')}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
