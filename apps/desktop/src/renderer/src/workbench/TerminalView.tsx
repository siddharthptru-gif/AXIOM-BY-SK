import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { ExtensionTerminalEvent } from '../../../common/ipc';
import type { TerminalCursorStyle } from '../settings/schema';
import { APPEARANCE_CHANGED_EVENT } from '../settings/themes';
import {
  consumeSuppressedTerminalFocus,
  registerExtensionTerminalSink,
} from '../state/extensionTerminalBus';
import { recordTerminalInput, recordTerminalOutput } from '../state/terminalOutputBus';

/**
 * A single xterm.js view bound to a Main-process PTY (PRD Epoch D). Owns its
 * terminal instance for its whole lifetime — kept mounted across tab switches so
 * the shell stays alive — and streams I/O over IPC. Supports ANSI/Unicode,
 * scrollback, resize (fit), copy/paste, Ctrl+C/V/L, and in-terminal search.
 *
 * PRD Phase 7 lets an extension own a pane. Two shapes: a real shell the extension configured, which
 * behaves exactly like a user pane and additionally reports its lifecycle by handle; and a
 * `Pseudoterminal`, where the extension *is* the process — nothing is spawned, its writes are drawn
 * here, and what the user types is reported back to it. The distinction lives in one prop so every
 * other path through this view stays as it was.
 */
function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function withAlpha(color: string, alpha: number): string {
  const value = color.trim();
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) return value;
  return `rgba(${parseInt(match[1]!, 16)}, ${parseInt(match[2]!, 16)}, ${parseInt(match[3]!, 16)}, ${alpha})`;
}

export function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const background = cssColor(styles, '--bg-editor', '#1e1d28');
  const foreground = cssColor(styles, '--fg-default', '#ddd8e7');
  const accent = cssColor(styles, '--accent', '#9277ff');
  const accentHover = cssColor(styles, '--accent-hover', '#a995ff');
  const danger = cssColor(styles, '--danger', '#f0808b');
  const success = cssColor(styles, '--success', '#62c88a');
  const warning = cssColor(styles, '--warning', '#ddb667');
  const info = cssColor(styles, '--info', '#76a8f8');
  return {
    background,
    foreground,
    cursor: accentHover,
    cursorAccent: background,
    selectionBackground: withAlpha(accent, 0.28),
    black: cssColor(styles, '--bg-surface', '#24232f'),
    red: danger,
    green: success,
    yellow: warning,
    blue: info,
    magenta: accent,
    cyan: info,
    white: cssColor(styles, '--fg-muted', '#b3adbf'),
    brightBlack: cssColor(styles, '--border-strong', '#504b65'),
    brightRed: danger,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: info,
    brightMagenta: accentHover,
    brightCyan: info,
    brightWhite: cssColor(styles, '--fg-max', '#fbf9fd'),
  };
}

interface TerminalViewProps {
  id: string;
  shell: string;
  cwd: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  scrollback: number;
  active: boolean;
  /** Optional command auto-run once the shell is ready (Run/Tasks view). */
  initialCommand?: string | undefined;
  /** The extension terminal this pane was adopted for (PRD Phase 7), or 0 for a user pane. */
  extensionHandle?: number | undefined;
  /** True when the extension is the process: nothing is spawned and it draws its own output. */
  extensionPty?: boolean | undefined;
  onExited: (id: string, exitCode: number | null) => void;
  onFocusPane: () => void;
}

export function TerminalView({
  id,
  shell,
  cwd,
  fontFamily,
  fontSize,
  cursorStyle,
  scrollback,
  active,
  initialCommand,
  extensionHandle,
  extensionPty,
  onExited,
  onFocusPane,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const initialCommandRef = useRef(initialCommand);
  const initialTimerRef = useRef<number | null>(null);
  /**
   * Pinned for the pane's whole life, like `shell` and `cwd`: a pane is adopted for exactly one
   * extension terminal, and the create-once effect below must not be re-run by a prop change.
   */
  const handleRef = useRef<number>(extensionHandle && extensionHandle > 0 ? extensionHandle : 0);
  const ptyRef = useRef<boolean>(extensionPty === true);
  const activeRef = useRef<boolean>(active);
  const interactedRef = useRef(false);
  const shellIntegrationRef = useRef(false);
  activeRef.current = active;

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Create the terminal exactly once (per session id).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      fontFamily: `${fontFamily}, ui-monospace, monospace`,
      fontSize,
      cursorStyle,
      cursorBlink: true,
      scrollback,
      allowProposedApi: true,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode);
    term.loadAddon(new WebLinksAddon());
    term.unicode.activeVersion = '11';
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not measured yet */
    }
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // PRD Phase 7 — what this pane tells Main about an extension terminal, always by handle. A user
    // pane has handle 0 and reports nothing, so the ordinary path gains no IPC at all.
    const handle = handleRef.current;
    const isExtensionPty = ptyRef.current;
    const report = (event: Omit<ExtensionTerminalEvent, 'handle'>): void => {
      if (handle <= 0) return;
      void window.axiom.extensionRuntime
        .reportTerminal({ ...event, handle })
        .catch(() => undefined);
    };
    let offSink: (() => void) | null = null;
    const bindSink = (): void => {
      if (handle <= 0 || offSink) return;
      offSink = registerExtensionTerminalSink(
        handle,
        // The same `write` command means two different things, and this is where they part: a
        // `Pseudoterminal`'s text is output to draw, while a real shell's is `sendText` — input.
        isExtensionPty
          ? (data) => term.write(data)
          : (data) => void window.axiom.terminal.write(id, data).catch(() => undefined),
      );
    };

    const onAppearanceChange = (): void => {
      term.options.theme = readTerminalTheme();
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChange);

    const offData = window.axiom.terminal.onData((e) => {
      if (e.id !== id) return;
      term.write(e.data);
      // Tee a bounded, ANSI-stripped copy so `@terminal` and the terminal-aware AI
      // fix can read what the user just saw. Renderer-only; never persisted.
      recordTerminalOutput(id, e.data);
      // `Terminal.shellIntegration` is only ever claimed once the shell has actually emitted the
      // sequences, so an extension is told what this pane really supports rather than what it might.
      if (handle > 0 && !shellIntegrationRef.current && /\x1b\][16]33;/.test(e.data)) {
        shellIntegrationRef.current = true;
        report({ kind: 'shell', available: true });
      }
    });
    const offExit = window.axiom.terminal.onExit((e) => {
      if (e.id === id) {
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
        recordTerminalOutput(id, '\n[process exited]\n');
        onExitedRef.current(id, e.exitCode);
      }
    });
    term.onData((data) => {
      // Track what the user typed so "fix the last failing command" knows the exact
      // command, instead of guessing where it starts in the scrollback.
      recordTerminalInput(id, data);
      if (handle > 0 && !interactedRef.current) {
        interactedRef.current = true;
        report({ kind: 'interacted' });
      }
      if (isExtensionPty) {
        report({ kind: 'input', data });
        return;
      }
      void window.axiom.terminal.write(id, data).catch(() => undefined);
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey && !e.altKey;
      if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        setSearchOpen(true);
        return false;
      }
      if (ctrl && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        if (sel) {
          void window.axiom.system.copyText(sel).catch(() => undefined);
          return false; // copied — don't send ETX
        }
        return true; // no selection — send interrupt to the shell
      }
      if (ctrl && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        void window.axiom.system
          .readText()
          .then((text) => {
            if (!text) return;
            if (isExtensionPty) {
              report({ kind: 'input', data: text });
              return;
            }
            void window.axiom.terminal.write(id, text).catch(() => undefined);
          })
          .catch(() => undefined);
        return false;
      }
      if (ctrl && (e.key === 'l' || e.key === 'L')) {
        term.clear();
        return false;
      }
      return true;
    });

    if (isExtensionPty) {
      // Nothing to spawn — the extension is the process. Reporting `opened` is what makes Main call
      // its `Pseudoterminal.open()`, and its writes then arrive on the sink bound here.
      bindSink();
      report({ kind: 'opened', sessionId: id, columns: term.cols, rows: term.rows });
      if (activeRef.current) report({ kind: 'active', sessionId: id });
    } else {
      void window.axiom.terminal
        .create({
          id,
          shell,
          cwd,
          cols: term.cols,
          rows: term.rows,
          // Main reads this pane's real shell, directory and environment out of its own registry; the
          // renderer only ever hands back the handle it was given.
          ...(handle > 0 ? { extensionHandle: handle } : {}),
        })
        .then((info) => {
          if (disposed) {
            void window.axiom.terminal.kill(id).catch(() => undefined);
            return;
          }
          // Only now is there something to type into, so this is where `sendText` becomes
          // deliverable — anything the extension sent earlier was held and is flushed by this bind.
          bindSink();
          report({
            kind: 'opened',
            sessionId: id,
            processId: info.pid,
            columns: term.cols,
            rows: term.rows,
          });
          // The pane may have become active before Main knew its session id, in which case the
          // provider's report found no terminal. Say it again now that the id is known.
          if (activeRef.current) report({ kind: 'active', sessionId: id });
          const cmd = initialCommandRef.current;
          if (cmd) {
            // Let the shell print its prompt before injecting the command.
            initialTimerRef.current = window.setTimeout(() => {
              void window.axiom.terminal.write(id, `${cmd}\r`).catch(() => undefined);
            }, 600);
          }
        })
        .catch(() => {
          if (!disposed) {
            term.write('\r\n\x1b[31m[terminal could not be started]\x1b[0m\r\n');
          }
        });
    }

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        if (!isExtensionPty) {
          void window.axiom.terminal.resize(id, term.cols, term.rows).catch(() => undefined);
        }
        // `Terminal.dimensions` on the extension side follows the pane, including for a
        // `Pseudoterminal`, which has no pty to resize but does get `setDimensions`.
        report({ kind: 'dimensions', columns: term.cols, rows: term.rows });
      } catch {
        /* transient during layout */
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      if (initialTimerRef.current) window.clearTimeout(initialTimerRef.current);
      offData();
      offExit();
      offSink?.();
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChange);
      if (!isExtensionPty) void window.axiom.terminal.kill(id).catch(() => undefined);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // Intentionally create-once: shell/cwd are fixed per session; live setting
    // changes apply to newly created terminals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit + focus when this pane becomes active (e.g., tab switch).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit?.fit();
        if (!ptyRef.current) {
          void window.axiom.terminal.resize(id, term.cols, term.rows).catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      // `Terminal.show(true)` must not move the caret out of the editor, so a reveal that asked to
      // preserve focus leaves a mark here and the pane declines to take it — this once.
      if (!consumeSuppressedTerminalFocus(id)) term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, id]);

  const runSearch = (dir: 1 | -1): void => {
    const search = searchRef.current;
    if (!search || !query) return;
    if (dir === 1) search.findNext(query);
    else search.findPrevious(query);
  };

  return (
    <div className="terminal-pane" onMouseDown={onFocusPane}>
      <div className="terminal-host" ref={hostRef} />
      {searchOpen ? (
        <div className="terminal-search" onMouseDown={(e) => e.stopPropagation()}>
          <input
            className="terminal-search-input"
            placeholder="Find"
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <button type="button" className="icon-btn" title="Previous" onClick={() => runSearch(-1)}>
            {'\u2191'}
          </button>
          <button type="button" className="icon-btn" title="Next" onClick={() => runSearch(1)}>
            {'\u2193'}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            {'\u00D7'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
