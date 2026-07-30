import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { notifyInfo, notifyError } from '../notifications/bus';
import { ChevronIcon } from './treeIcons';
import { ShieldIcon } from './icons';
import type { McpServerConfig, McpConnectionStatus } from '../../../common/mcp';

/**
 * MCP panel (PRD Epoch H §80.3 / Phase 237). Manage Model Context Protocol servers:
 * add a server (command + args), enable/disable, connect (spawns it over stdio,
 * runs the initialize handshake, discovers tools), and view its tools. Connected
 * tools are bridged into the agent registry as approval-gated tools. SECURITY:
 * servers default disabled; a server runs a local process you configure, and its
 * tool output is treated as untrusted data.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function McpView() {
  const { rootPath } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const mcpCapability = rootPath && workspaceTrust.trusted ? rootPath : null;
  const [collapsed, setCollapsed] = useState(true);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [connectionSnapshot, setConnectionSnapshot] = useState<{
    root: string | null;
    list: McpConnectionStatus[];
  }>({ root: null, list: [] });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const busyRootRef = useRef<string | null>(null);
  const refreshRequestRef = useRef(0);
  const rootRef = useRef<string | null>(rootPath);
  const capabilityRef = useRef<string | null>(mcpCapability);
  const previousRootRef = useRef<string | null>(rootPath);
  const previousCapabilityRef = useRef<string | null>(mcpCapability);
  const connectionsRef = useRef(connectionSnapshot);
  rootRef.current = rootPath;
  capabilityRef.current = mcpCapability;
  connectionsRef.current = connectionSnapshot;

  // Never render a snapshot returned for a previous workspace, even for one frame.
  const connections = connectionSnapshot.root === rootPath ? connectionSnapshot.list : [];

  const replaceConnections = (root: string | null, list: McpConnectionStatus[]): void => {
    const snapshot = { root, list };
    connectionsRef.current = snapshot;
    setConnectionSnapshot(snapshot);
  };

  const disconnectConnections = (root: string, list: McpConnectionStatus[]): void => {
    for (const connection of list) {
      void window.axiom.mcp.disconnect(root, connection.id).catch(() => undefined);
    }
  };

  const refresh = (root: string | null = rootRef.current): void => {
    const request = ++refreshRequestRef.current;
    if (!root) {
      setServers([]);
      replaceConnections(null, []);
      return;
    }

    // Server definitions are user configuration, but Main requires an authorized
    // active workspace for every read or mutation.
    void window.axiom.mcp
      .listServers(root)
      .then((list) => {
        if (request === refreshRequestRef.current && rootRef.current === root) setServers(list);
      })
      .catch(() => undefined);

    // Connection status and disconnect are authorized by owner + root, not trust,
    // so surviving processes can still be stopped while the workspace is restricted.
    void window.axiom.mcp
      .connections(root)
      .then((list) => {
        if (rootRef.current !== root) {
          disconnectConnections(root, list);
          return;
        }
        if (request !== refreshRequestRef.current) return;
        replaceConnections(root, list);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    const previousRoot = previousRootRef.current;
    const previousCapability = previousCapabilityRef.current;
    previousRootRef.current = rootPath;
    previousCapabilityRef.current = mcpCapability;

    const teardownRoot =
      previousRoot && previousRoot !== rootPath
        ? previousRoot
        : previousCapability && previousCapability !== mcpCapability
          ? previousCapability
          : null;
    if (teardownRoot) {
      refreshRequestRef.current += 1;
      void window.axiom.mcp.disconnectWorkspace(teardownRoot).catch(() => undefined);
      const snapshot = connectionsRef.current;
      if (snapshot.root === teardownRoot) replaceConnections(null, []);
      if (busyRootRef.current === teardownRoot) busyRootRef.current = null;
      setCreating(false);
    }

    if (!rootPath) replaceConnections(null, []);
    if (!collapsed) refresh(rootPath);
  }, [collapsed, mcpCapability, rootPath]);

  useEffect(() => {
    rootRef.current = rootPath;
    capabilityRef.current = mcpCapability;
    return () => {
      rootRef.current = null;
      capabilityRef.current = null;
      busyRootRef.current = null;
      refreshRequestRef.current += 1;
      connectionsRef.current = { root: null, list: [] };
    };
    // Presentation unmount only. Main owns process teardown on explicit disconnect,
    // workspace replacement/revocation, renderer destruction, and app shutdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connOf = (id: string): McpConnectionStatus | undefined =>
    connections.find((connection) => connection.id === id);

  const save = (): void => {
    const root = capabilityRef.current;
    if (!root || name.trim().length === 0 || command.trim().length === 0) return;
    const parsedArgs = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
    void window.axiom.mcp
      .saveServer(root, {
        name: name.trim(),
        command: command.trim(),
        args: parsedArgs,
        enabled: false,
      })
      .then((list) => {
        if (capabilityRef.current !== root) return;
        setServers(list);
        setName('');
        setCommand('');
        setArgs('');
        setCreating(false);
        notifyInfo('MCP server saved (disabled until you enable + connect it).', { source: 'MCP' });
      })
      .catch((e) =>
        notifyError('Could not save MCP server', { source: 'MCP', detail: detailOf(e) }),
      );
  };

  const toggleEnabled = (server: McpServerConfig): void => {
    const requestedRoot = rootRef.current;
    const nextEnabled = !server.enabled;
    if (!requestedRoot || (!mcpCapability && nextEnabled)) return;
    void window.axiom.mcp
      .setEnabled(requestedRoot, server.id, nextEnabled)
      .then((list) => {
        if (rootRef.current !== requestedRoot) return;
        setServers(list);
        if (requestedRoot) refresh(requestedRoot);
      })
      .catch((e) =>
        notifyError('Could not update MCP server', { source: 'MCP', detail: detailOf(e) }),
      );
  };

  const remove = (server: McpServerConfig): void => {
    const root = capabilityRef.current;
    if (!root) return;
    void window.axiom.mcp
      .deleteServer(root, server.id)
      .then((list) => {
        if (capabilityRef.current !== root) return;
        setServers(list);
        refresh(root);
      })
      .catch((e) =>
        notifyError('Could not delete MCP server', { source: 'MCP', detail: detailOf(e) }),
      );
  };

  const connect = (server: McpServerConfig): void => {
    const root = capabilityRef.current;
    if (!root || busyRootRef.current !== null) return;
    busyRootRef.current = root;
    void window.axiom.mcp
      .connect(root, server.id)
      .then((res) => {
        if (capabilityRef.current !== root) {
          void window.axiom.mcp.disconnect(root, server.id).catch(() => undefined);
          return;
        }
        if (res.ok) {
          notifyInfo(`Connected to ${server.name} \u2014 ${res.tools.length} tool(s) available.`, {
            source: 'MCP',
          });
        } else {
          notifyError(`Could not connect to ${server.name}`, {
            source: 'MCP',
            detail: res.error ?? '',
          });
        }
        refresh(root);
      })
      .catch((e) => {
        if (capabilityRef.current === root) {
          notifyError('MCP connect failed', { source: 'MCP', detail: detailOf(e) });
        }
      })
      .finally(() => {
        if (busyRootRef.current === root) busyRootRef.current = null;
      });
  };

  const disconnect = (server: McpServerConfig): void => {
    const root = rootRef.current;
    if (!root) return;
    void window.axiom.mcp
      .disconnect(root, server.id)
      .then(() => {
        if (rootRef.current !== root) return;
        const snapshot = connectionsRef.current;
        if (snapshot.root === root) {
          replaceConnections(
            root,
            snapshot.list.filter((connection) => connection.id !== server.id),
          );
        }
        refresh(root);
      })
      .catch((e) => {
        if (rootRef.current === root) {
          notifyError('Could not disconnect MCP server', {
            source: 'MCP',
            detail: detailOf(e),
          });
        }
      });
  };

  const restrictedDetail = !rootPath
    ? 'Open a folder to connect an MCP server.'
    : workspaceTrust.status === 'checking'
      ? 'Checking workspace trust. MCP server processes remain disconnected until the check finishes.'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified. MCP server processes remain disabled.'
        : 'Restricted Mode blocks MCP server processes and tool calls. Connected servers are disconnected; enabled servers can still be disabled.';

  return (
    <div className="mcp-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">MCP Servers</span>
        {!collapsed ? <span className="oe-count">{servers.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="mcp-body">
          {!mcpCapability ? (
            <div
              className="capability-disabled mcp-capability-disabled"
              role="status"
              aria-live="polite"
            >
              <span className="capability-disabled-icon" aria-hidden="true">
                <ShieldIcon size={16} />
              </span>
              <div>
                <strong>MCP servers unavailable</strong>
                <p>{restrictedDetail}</p>
              </div>
            </div>
          ) : null}

          {servers.length === 0 ? (
            <div className="outline-empty">No MCP servers configured.</div>
          ) : (
            servers.map((s) => {
              const conn = connOf(s.id);
              const canToggle = mcpCapability !== null || s.enabled;
              return (
                <div key={s.id} className="mcp-row">
                  <div className="mcp-main">
                    <label
                      className="mcp-enable"
                      title={
                        canToggle
                          ? s.enabled
                            ? 'Enabled'
                            : 'Disabled'
                          : 'Trust this workspace to enable MCP servers'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={!canToggle}
                        onChange={() => toggleEnabled(s)}
                      />
                    </label>
                    <div className="mcp-info">
                      <div className="mcp-name">
                        {s.name}
                        {conn ? <span className="mcp-dot" title="Connected" /> : null}
                      </div>
                      <div className="mcp-meta" title={`${s.command} ${s.args.join(' ')}`}>
                        {s.command} {s.args.join(' ')}
                      </div>
                    </div>
                    {conn ? (
                      <button
                        type="button"
                        className="mcp-act"
                        title="Disconnect"
                        aria-label={`Disconnect ${s.name}`}
                        onClick={() => disconnect(s)}
                      >
                        {'\u23F9'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="mcp-act"
                        title={mcpCapability ? 'Connect' : restrictedDetail}
                        aria-label={`Connect ${s.name}`}
                        disabled={!s.enabled || !mcpCapability}
                        onClick={() => connect(s)}
                      >
                        {'\u25B6'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="mcp-act is-danger"
                      title={mcpCapability ? 'Delete server' : restrictedDetail}
                      aria-label={`Delete ${s.name}`}
                      disabled={!mcpCapability}
                      onClick={() => remove(s)}
                    >
                      {'\u00D7'}
                    </button>
                  </div>
                  {conn && conn.tools.length > 0 ? (
                    <div className="mcp-tools">
                      {conn.tools.map((t) => (
                        <span key={t.name} className="mcp-tool" title={t.description}>
                          {t.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          {creating ? (
            <div className="mcp-form">
              <input
                className="mcp-input"
                placeholder="Server name"
                value={name}
                spellCheck={false}
                disabled={!mcpCapability}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="mcp-input"
                placeholder="Command (e.g. npx)"
                value={command}
                spellCheck={false}
                disabled={!mcpCapability}
                onChange={(e) => setCommand(e.target.value)}
              />
              <input
                className="mcp-input"
                placeholder="Arguments (space-separated)"
                value={args}
                spellCheck={false}
                disabled={!mcpCapability}
                onChange={(e) => setArgs(e.target.value)}
              />
              <div className="mcp-form-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    !mcpCapability || name.trim().length === 0 || command.trim().length === 0
                  }
                  onClick={save}
                >
                  Save server
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
              <p className="mcp-hint">
                Runs a local process you configure. Its tools become available to the agent under
                approval; tool output is treated as untrusted data.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost mcp-new"
              disabled={!mcpCapability}
              title={mcpCapability ? 'Add MCP server' : restrictedDetail}
              onClick={() => setCreating(true)}
            >
              {'\uFF0B'} Add MCP server
            </button>
          )}
        </div>
      )}
    </div>
  );
}
