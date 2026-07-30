import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clearDebugConsole,
  debugConsoleHistory,
  evaluateInDebugConsole,
  subscribeDebugConsole,
  type DebugConsoleLine,
} from '../state/debugConsole';
import type { DebugState } from '../../../common/ipc';

/**
 * Debug Console — a real REPL against the active debug adapter.
 *
 * Shows the adapter's stdout/stderr as it arrives and evaluates expressions in the
 * stack frame currently selected in Run and Debug. Up/Down recalls previous
 * expressions, and the transcript follows the tail unless the user has scrolled up
 * to read something.
 */
const STATE_LABEL: Record<DebugState, string> = {
  inactive: 'No session',
  initializing: 'Starting…',
  running: 'Running',
  stopped: 'Paused',
  terminated: 'Ended',
};

const PROMPT: Record<DebugConsoleLine['kind'], string> = {
  input: '›',
  result: '',
  error: '',
  stdout: '',
  stderr: '',
  notice: '',
};

function isNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 24;
}

export function DebugConsoleView() {
  const [lines, setLines] = useState<readonly DebugConsoleLine[]>([]);
  const [session, setSession] = useState<DebugState>('inactive');
  const [canEvaluate, setCanEvaluate] = useState(false);
  const [frameId, setFrameId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  useEffect(
    () =>
      subscribeDebugConsole((next) => {
        setLines(next.lines);
        setSession(next.session);
        setCanEvaluate(next.canEvaluate);
        setFrameId(next.frameId);
      }),
    [],
  );

  // Follow the tail, but stop following the moment the user scrolls up so reading
  // older output is not yanked away by new lines.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const submit = (): void => {
    const expression = draft.trim();
    if (expression.length === 0 || busy) return;
    setBusy(true);
    setDraft('');
    setHistoryIndex(-1);
    followRef.current = true;
    void evaluateInDebugConsole(expression).finally(() => setBusy(false));
  };

  const recall = (delta: number): void => {
    const entries = debugConsoleHistory();
    if (entries.length === 0) return;
    const next = Math.min(entries.length - 1, Math.max(-1, historyIndex + delta));
    setHistoryIndex(next);
    setDraft(next < 0 ? '' : (entries[next] ?? ''));
  };

  return (
    <div className="debug-console">
      <div className="debug-console-bar">
        <span className={`debug-console-state s-${session}`}>{STATE_LABEL[session]}</span>
        {frameId !== null ? (
          <span className="debug-console-frame">Evaluating in the selected frame</span>
        ) : canEvaluate ? (
          <span className="debug-console-frame">Evaluating in the global scope</span>
        ) : null}
        <button
          type="button"
          className="debug-console-clear"
          onClick={() => clearDebugConsole()}
          disabled={lines.length === 0}
        >
          Clear
        </button>
      </div>

      <div
        className="debug-console-log"
        ref={scrollRef}
        onScroll={(event) => {
          followRef.current = isNearBottom(event.currentTarget);
        }}
        role="log"
        aria-label="Debug console output"
      >
        {lines.length === 0 ? (
          <div className="panel-empty">
            Start a debug session from Run and Debug. Program output appears here, and you can
            evaluate expressions in the paused frame below.
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`debug-console-line k-${line.kind}`}>
              {PROMPT[line.kind] ? (
                <span className="debug-console-prompt" aria-hidden="true">
                  {PROMPT[line.kind]}
                </span>
              ) : null}
              <span className="debug-console-text">{line.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="debug-console-input-row">
        <span className="debug-console-prompt" aria-hidden="true">
          ›
        </span>
        <input
          className="debug-console-input"
          value={draft}
          spellCheck={false}
          placeholder={canEvaluate ? 'Evaluate an expression…' : 'Start a debug session to evaluate'}
          aria-label="Evaluate a debug expression"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              recall(1);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              recall(-1);
            }
          }}
        />
      </div>
    </div>
  );
}
