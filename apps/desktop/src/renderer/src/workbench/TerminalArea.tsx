import { useEffect, useState } from 'react';
import { useTerminals } from '../state/terminals';
import { useWorkspace } from '../state/workspace';
import { useSettings } from '../settings/store';
import { getTerminalSettings } from '../settings/schema';
import { TerminalView } from './TerminalView';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { CloseIcon, PlusIcon, ShieldIcon, SparkIcon, SplitIcon, TerminalIcon } from './icons';
import { requestTerminalFix } from './terminalFixAction';

/**
 * Terminal area (PRD Epoch D): tab bar + split-pane layout for the integrated
 * terminal. Kept mounted whenever the panel exists so terminals survive tab
 * switches and panel close; it lazily creates the first terminal when it first
 * becomes visible.
 */
export function TerminalArea({ visible }: { visible: boolean }) {
  const term = useTerminals();
  const { rootPath } = useWorkspace();
  const { values } = useSettings();
  const settings = getTerminalSettings(values);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const canUseTerminal = term.available && rootPath !== null;

  // Create the first terminal the moment the area is first shown and trusted.
  useEffect(() => {
    if (visible && canUseTerminal) term.ensureOne();
  }, [visible, canUseTerminal, term.ensureOne]);

  useEffect(() => {
    if (!canUseTerminal) setShellMenu(null);
  }, [canUseTerminal]);

  const shellEntries: MenuEntry[] =
    term.shells.length > 0
      ? term.shells.map((s) => ({ label: s.label, onSelect: () => term.newTerminal(s.id) }))
      : [{ label: 'Default Shell', onSelect: () => term.newTerminal() }];

  return (
    <div className="terminal-area">
      <div className="terminal-tabbar">
        <div className="terminal-tablist" role="tablist" aria-label="Terminals">
          {term.tabs.map((t, i) => {
            const first = term.sessions[t.paneIds[0] ?? ''];
            const base = first ? first.title : 'Terminal';
            const label = t.paneIds.length > 1 ? `${base} (${t.paneIds.length})` : base;
            const selected = t.id === term.activeTabId;
            return (
              <div
                key={t.id}
                role="presentation"
                className={`terminal-tab ${selected ? 'active' : ''}`}
              >
                <button
                  id={`terminal-tab-${t.id}`}
                  type="button"
                  role="tab"
                  className="terminal-tab-main"
                  aria-selected={selected}
                  aria-controls={`terminal-panel-${t.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => term.setActiveTab(t.id)}
                  onKeyDown={(e) => {
                    let nextIndex: number;
                    switch (e.key) {
                      case 'ArrowLeft':
                        nextIndex = (i - 1 + term.tabs.length) % term.tabs.length;
                        break;
                      case 'ArrowRight':
                        nextIndex = (i + 1) % term.tabs.length;
                        break;
                      case 'Home':
                        nextIndex = 0;
                        break;
                      case 'End':
                        nextIndex = term.tabs.length - 1;
                        break;
                      default:
                        return;
                    }
                    e.preventDefault();
                    const nextTab = term.tabs[nextIndex];
                    if (!nextTab) return;
                    term.setActiveTab(nextTab.id);
                    e.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      [nextIndex]?.focus();
                  }}
                >
                  <span className="terminal-tab-glyph" aria-hidden="true">
                    <TerminalIcon size={13} />
                  </span>
                  <span className="terminal-tab-index">{i + 1}</span>
                  <span className="terminal-tab-label">{label}</span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={`Close terminal ${i + 1}`}
                  title="Close Terminal"
                  onClick={() => term.closeTab(t.id)}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="terminal-tab-actions">
          {/* The failing command is right here — one click sends it to Ask as evidence. */}
          <button
            type="button"
            className="terminal-fix-btn"
            title={
              canUseTerminal
                ? 'Send the last command and its output to Ask for a diagnosis'
                : term.disabledReason
            }
            disabled={!canUseTerminal}
            onClick={() => requestTerminalFix(rootPath)}
          >
            <SparkIcon size={13} />
            Fix last command
          </button>
          <button
            type="button"
            className="icon-btn"
            title={canUseTerminal ? 'Split Terminal' : term.disabledReason}
            aria-label="Split Terminal"
            disabled={!canUseTerminal}
            onClick={() => term.splitActive()}
          >
            <SplitIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={canUseTerminal ? 'New Terminal' : term.disabledReason}
            aria-label="New Terminal"
            disabled={!canUseTerminal}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setShellMenu({ x: r.left, y: r.bottom });
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="terminal-stage">
        {!canUseTerminal ? (
          <div className="capability-disabled terminal-disabled" role="status" aria-live="polite">
            <span className="capability-disabled-icon" aria-hidden="true">
              <ShieldIcon size={16} />
            </span>
            <div>
              <strong>Terminal unavailable</strong>
              <p>{term.disabledReason}</p>
            </div>
          </div>
        ) : term.tabs.length === 0 ? (
          <div className="terminal-empty">Starting terminal{'\u2026'}</div>
        ) : (
          term.tabs.map((t) => (
            <div
              key={t.id}
              id={`terminal-panel-${t.id}`}
              className="terminal-panes"
              role="tabpanel"
              aria-labelledby={`terminal-tab-${t.id}`}
              style={{ display: t.id === term.activeTabId ? 'flex' : 'none' }}
            >
              {t.paneIds.map((pid) => {
                const s = term.sessions[pid];
                if (!s) return null;
                return (
                  <div
                    key={pid}
                    className={`terminal-pane-wrap ${
                      pid === term.activePaneId ? 'active-pane' : ''
                    }`}
                  >
                    <TerminalView
                      id={s.id}
                      shell={s.shell}
                      cwd={rootPath}
                      fontFamily={settings.fontFamily}
                      fontSize={settings.fontSize}
                      cursorStyle={settings.cursorStyle}
                      scrollback={settings.scrollback}
                      active={t.id === term.activeTabId && pid === term.activePaneId}
                      initialCommand={s.initialCommand}
                      extensionHandle={s.extensionHandle}
                      extensionPty={s.extensionPty}
                      onExited={(_paneId, exitCode) => term.paneExited(pid, exitCode)}
                      onFocusPane={() => term.setActivePane(pid)}
                    />
                    {t.paneIds.length > 1 ? (
                      <button
                        type="button"
                        className="icon-btn terminal-pane-close"
                        title="Close Pane"
                        aria-label="Close Pane"
                        onClick={() => term.closePane(pid)}
                      >
                        <CloseIcon size={14} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {/*
          Panes an extension created with `hideFromUser` (PRD Phase 7). Their shell is real and is
          expected to answer `sendText`, so they are laid out and measurable — just off-screen. They
          leave here for a tab of their own the moment the extension calls `show()`.
        */}
        {canUseTerminal && term.hiddenPaneIds.length > 0 ? (
          <div className="terminal-hidden-stage" aria-hidden="true">
            {term.hiddenPaneIds.map((pid) => {
              const s = term.sessions[pid];
              if (!s) return null;
              return (
                <div key={pid} className="terminal-pane-wrap">
                  <TerminalView
                    id={s.id}
                    shell={s.shell}
                    cwd={rootPath}
                    fontFamily={settings.fontFamily}
                    fontSize={settings.fontSize}
                    cursorStyle={settings.cursorStyle}
                    scrollback={settings.scrollback}
                    active={false}
                    extensionHandle={s.extensionHandle}
                    extensionPty={s.extensionPty}
                    onExited={(_paneId, exitCode) => term.paneExited(pid, exitCode)}
                    onFocusPane={() => undefined}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {shellMenu && canUseTerminal ? (
        <ContextMenu
          x={shellMenu.x}
          y={shellMenu.y}
          entries={shellEntries}
          onClose={() => setShellMenu(null)}
        />
      ) : null}
    </div>
  );
}
