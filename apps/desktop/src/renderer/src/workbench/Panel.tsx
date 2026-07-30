import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PanelTab } from '../notifications/store';
import { PANEL_SIZE_BOUNDS, useNotifications } from '../notifications/store';
import { useLayout } from '../state/layout';

import { useDiagnostics } from '../state/diagnostics';
import { ProblemsView } from './ProblemsView';
import { DebugConsoleView } from './DebugConsoleView';
import { TerminalArea } from './TerminalArea';
import {
  ClearIcon,
  CloseIcon,
  MaximizeIcon,
  RestoreIcon,
  PanelBottomIcon,
  PanelRightIcon,
} from './icons';

const TABS: Array<{ id: PanelTab; label: string; disabled?: boolean; reason?: string }> = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'output', label: 'Output' },
  { id: 'problems', label: 'Problems' },
  // A real REPL against the active debug adapter. It captures output from startup,
  // so the tab is useful before a session exists and does not need Run and Debug open.
  { id: 'debug', label: 'Debug Console' },
];

const OUTPUT_PAGE_SIZE = 250;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

/** Persistent Terminal, Output, and Problems workbench panel. */
export function Panel() {
  const {
    entries,
    clear,
    panelOpen,
    togglePanel,
    panelTab,
    setPanelTab,
    panelMaximized,
    toggleMaximizePanel,
    panelPosition,
    togglePanelPosition,
    panelHeight,
    panelWidth,
    setPanelSize,
  } = useNotifications();
  const layout = useLayout();
  const canDockRight = !layout.aiPanelVisible && !layout.isConstrained;
  const effectivePanelPosition = panelPosition === 'right' && canDockRight ? 'right' : 'bottom';
  const rightDockUnavailableReason = layout.isConstrained
    ? 'Right panel docking is unavailable at the current window width.'
    : 'Right panel docking is unavailable while the Axiom AI dock is open.';
  const dockActionDisabled = panelPosition === 'bottom' && !canDockRight;
  const dockActionLabel =
    panelPosition === 'right'
      ? canDockRight
        ? 'Move Panel to Bottom'
        : 'Cancel pending right dock request; panel is currently at bottom'
      : canDockRight
        ? 'Move Panel Right'
        : rightDockUnavailableReason;

  const { errorCount, warningCount } = useDiagnostics();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [outputEndIndex, setOutputEndIndex] = useState<number | null>(null);
  const effectiveOutputEnd = Math.min(outputEndIndex ?? entries.length, entries.length);
  const outputStartIndex = Math.max(0, effectiveOutputEnd - OUTPUT_PAGE_SIZE);
  const visibleEntries = useMemo(
    () => entries.slice(outputStartIndex, effectiveOutputEnd),
    [effectiveOutputEnd, entries, outputStartIndex],
  );
  const olderOutputCount = outputStartIndex;
  const newerOutputCount = entries.length - effectiveOutputEnd;

  const clearOutput = useCallback((): void => {
    clear();
    setOutputEndIndex(null);
  }, [clear]);

  const showOlderOutput = useCallback((): void => {
    setOutputEndIndex(outputStartIndex);
  }, [outputStartIndex]);

  const showNewerOutput = useCallback((): void => {
    const nextEnd = Math.min(entries.length, effectiveOutputEnd + OUTPUT_PAGE_SIZE);
    setOutputEndIndex(nextEnd === entries.length ? null : nextEnd);
  }, [effectiveOutputEnd, entries.length]);

  useEffect(() => {
    if (panelOpen && panelTab === 'output' && outputEndIndex === null) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [entries, outputEndIndex, panelOpen, panelTab]);

  const badgeFor = (tab: PanelTab): number => {
    if (tab === 'output') return entries.length;
    if (tab === 'problems') return errorCount + warningCount;
    return 0;
  };

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (panelMaximized) return;
      event.preventDefault();
      const position = effectivePanelPosition;
      const startX = event.clientX;
      const startY = event.clientY;
      const startSize = position === 'bottom' ? panelHeight : panelWidth;
      document.body.classList.add(position === 'bottom' ? 'resizing-row' : 'resizing-col');
      const onMove = (moveEvent: PointerEvent): void => {
        const delta =
          position === 'bottom' ? startY - moveEvent.clientY : startX - moveEvent.clientX;
        setPanelSize(position, startSize + delta);
      };
      const onEnd = (): void => {
        document.body.classList.remove('resizing-row', 'resizing-col');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd, { once: true });
      window.addEventListener('pointercancel', onEnd, { once: true });
    },
    [effectivePanelPosition, panelHeight, panelMaximized, panelWidth, setPanelSize],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (panelMaximized) return;
      const position = effectivePanelPosition;
      const bounds = PANEL_SIZE_BOUNDS[position];
      const current = position === 'bottom' ? panelHeight : panelWidth;
      const step = event.shiftKey ? 50 : 10;
      let next: number;
      switch (event.key) {
        case 'ArrowUp':
          if (position !== 'bottom') return;
          next = current + step;
          break;
        case 'ArrowDown':
          if (position !== 'bottom') return;
          next = current - step;
          break;
        case 'ArrowLeft':
          if (position !== 'right') return;
          next = current + step;
          break;
        case 'ArrowRight':
          if (position !== 'right') return;
          next = current - step;
          break;
        case 'Home':
          next = bounds.min;
          break;
        case 'End':
          next = bounds.max;
          break;
        default:
          return;
      }
      event.preventDefault();
      setPanelSize(position, next);
    },
    [effectivePanelPosition, panelHeight, panelMaximized, panelWidth, setPanelSize],
  );

  const panelSize = effectivePanelPosition === 'bottom' ? panelHeight : panelWidth;
  const panelSizeBounds = PANEL_SIZE_BOUNDS[effectivePanelPosition];

  return (
    <section
      className={`panel ${panelOpen ? '' : 'panel-hidden'}`}
      style={
        {
          '--panel-h': `${panelHeight}px`,
          '--panel-w': `${panelWidth}px`,
        } as CSSProperties
      }
      aria-label="Workbench panel"
      aria-hidden={!panelOpen}
    >
      <div
        className={`panel-resizer panel-resizer-${effectivePanelPosition}`}
        role="separator"
        tabIndex={panelOpen && !panelMaximized ? 0 : -1}
        aria-label={`Resize ${effectivePanelPosition} panel`}
        aria-orientation={effectivePanelPosition === 'bottom' ? 'horizontal' : 'vertical'}
        aria-valuemin={panelSizeBounds.min}
        aria-valuemax={panelSizeBounds.max}
        aria-valuenow={panelSize}
        aria-valuetext={`${panelSize} pixels`}
        aria-disabled={panelMaximized}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
      <div className="panel-tabs" role="tablist" aria-label="Panel views">
        {TABS.map((tab) => {
          const selected = panelTab === tab.id;
          const badge = badgeFor(tab.id);
          return (
            <button
              key={tab.id}
              id={`panel-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-disabled={tab.disabled === true}
              aria-controls="workbench-panel-content"
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              title={tab.reason}
              className={`panel-tab ${selected ? 'active' : ''}${tab.disabled ? ' disabled' : ''}`}
              onClick={() => {
                if (!tab.disabled) setPanelTab(tab.id);
              }}
              onKeyDown={(event) => {
                const enabledTabs = TABS.filter((item) => !item.disabled);
                const currentIndex = enabledTabs.findIndex((item) => item.id === tab.id);
                let nextIndex: number;
                switch (event.key) {
                  case 'ArrowLeft':
                    nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
                    break;
                  case 'ArrowRight':
                    nextIndex = (currentIndex + 1) % enabledTabs.length;
                    break;
                  case 'Home':
                    nextIndex = 0;
                    break;
                  case 'End':
                    nextIndex = enabledTabs.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                const nextTab = enabledTabs[nextIndex];
                if (!nextTab) return;
                setPanelTab(nextTab.id);
                document.getElementById(`panel-tab-${nextTab.id}`)?.focus();
              }}
            >
              <span className="panel-tab-label">{tab.label}</span>
              {badge > 0 ? (
                <span className="panel-tab-badge">{badge > 999 ? '999+' : badge}</span>
              ) : null}
            </button>
          );
        })}
        <div className="panel-actions">
          {panelTab === 'output' ? (
            <button
              type="button"
              className="icon-btn"
              title="Clear Output"
              aria-label="Clear Output"
              disabled={entries.length === 0}
              onClick={clearOutput}
            >
              <ClearIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            title={dockActionLabel}
            aria-label={dockActionLabel}
            disabled={dockActionDisabled}
            onClick={togglePanelPosition}
          >
            {panelPosition === 'bottom' ? <PanelRightIcon /> : <PanelBottomIcon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={panelMaximized ? 'Restore Panel Size' : 'Maximize Panel Size'}
            aria-label={panelMaximized ? 'Restore Panel Size' : 'Maximize Panel Size'}
            onClick={toggleMaximizePanel}
          >
            {panelMaximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close Panel"
            aria-label="Close Panel"
            onClick={togglePanel}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div
        id="workbench-panel-content"
        className="panel-body"
        role="tabpanel"
        aria-labelledby={`panel-tab-${panelTab}`}
      >
        {panelTab === 'output' ? (
          entries.length === 0 ? (
            <div className="panel-empty">No output yet. Actions and messages appear here.</div>
          ) : (
            <div className="output-log" role="log" aria-label="Application output">
              {olderOutputCount > 0 || newerOutputCount > 0 ? (
                <div className="update-actions" aria-label="Output history pages">
                  {olderOutputCount > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label={`Show ${Math.min(OUTPUT_PAGE_SIZE, olderOutputCount)} older output entries; ${olderOutputCount} older retained`}
                      onClick={showOlderOutput}
                    >
                      Older ({olderOutputCount})
                    </button>
                  ) : null}
                  {newerOutputCount > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      aria-label={`Show ${Math.min(OUTPUT_PAGE_SIZE, newerOutputCount)} newer output entries; ${newerOutputCount} newer retained`}
                      onClick={showNewerOutput}
                    >
                      Newer ({newerOutputCount})
                    </button>
                  ) : null}
                </div>
              ) : null}
              {visibleEntries.map((entry) => (
                <div key={entry.id} className={`output-row output-${entry.level}`}>
                  <span className="output-time">{formatTime(entry.time)}</span>
                  <span className="output-dot" aria-hidden="true" />
                  {entry.source ? <span className="output-source">{entry.source}</span> : null}
                  <span className="output-message">
                    {entry.message}
                    {entry.detail ? <span className="output-detail"> — {entry.detail}</span> : null}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )
        ) : null}
        {panelTab === 'problems' ? <ProblemsView /> : null}
        {panelTab === 'debug' ? <DebugConsoleView /> : null}
        <div
          className="panel-terminal-slot"
          style={{ display: panelTab === 'terminal' ? 'flex' : 'none' }}
        >
          <TerminalArea visible={panelOpen && panelTab === 'terminal'} />
        </div>
      </div>
    </section>
  );
}
