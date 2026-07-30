import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setDebugConsoleFrame } from '../state/debugConsole';
import { frameInlineValueContext, setInlineValueContext } from '../editor/inlineValuesBus';
import type {
  DebugControlAction,
  DebugScope,
  DebugStackFrame,
  DebugState,
  DebugVariable,
  DiscoveredDebugConfig,
} from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { useSettings } from '../settings/store';
import { notifyError } from '../notifications/bus';
import { ShieldIcon } from './icons';
import {
  allBreakpoints,
  breakpointCount,
  listBreakpoints,
  setBreakpointCondition,
  setBreakpointSyncEnabled,
  subscribeBreakpoints,
} from '../editor/breakpoints';

/**
 * Debug panel (PRD Epoch D, Phases 96–101). Drives a DAP session: an
 * adapter-agnostic launch config (persisted), run/step/stop controls, the call
 * stack, scope variables, and adapter output. Set a DAP adapter command (e.g. a
 * js-debug or debugpy launcher) to debug; breakpoints are toggled in the editor
 * gutter. The DAP client lives in Main; no code leaves the machine.
 */
interface ScopeVars {
  scope: DebugScope;
  vars: DebugVariable[];
}

function strSetting(values: Record<string, unknown>, key: string): string {
  return typeof values[key] === 'string' ? (values[key] as string) : '';
}

const STATE_LABEL: Record<DebugState, string> = {
  inactive: 'Not running',
  initializing: 'Starting…',
  running: 'Running',
  stopped: 'Paused',
  terminated: 'Ended',
};

export function DebugPanel() {
  const { rootPath, activePath } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const debugCapability = rootPath && workspaceTrust.trusted ? rootPath : null;
  const { values, set } = useSettings();
  const [state, setState] = useState<DebugState>('inactive');
  const [threadId, setThreadId] = useState<number | null>(null);
  const [frames, setFrames] = useState<DebugStackFrame[]>([]);
  const [selectedFrame, setSelectedFrameState] = useState<number | null>(null);
  /**
   * Selecting a frame also retargets the Debug Console, so an expression typed
   * there resolves in the frame the user is looking at rather than the global scope.
   */
  const setSelectedFrame = useCallback((next: number | null): void => {
    setSelectedFrameState(next);
    setDebugConsoleFrame(next);
  }, []);
  const [scopeVars, setScopeVars] = useState<ScopeVars[]>([]);
  const [output, setOutput] = useState<string[]>([]);
  const [bpCount, setBpCount] = useState(breakpointCount());
  const [bpList, setBpList] = useState(listBreakpoints());
  const [watches, setWatches] = useState<string[]>([]);
  const [newWatch, setNewWatch] = useState('');
  const [watchResults, setWatchResults] = useState<Record<string, string>>({});
  const [launchPending, setLaunchPending] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredDebugConfig[]>([]);
  /**
   * The detected configuration a launch will use. Held in renderer state rather than
   * written into user settings so nothing is silently persisted: it is re-derived on
   * every workspace open, which is what makes debugging zero-config.
   */
  const [selected, setSelected] = useState<DiscoveredDebugConfig | null>(null);

  const [discovering, setDiscovering] = useState(false);
  const capabilityRef = useRef<string | null>(debugCapability);
  const launchRootRef = useRef<string | null>(null);
  const previousCapabilityRef = useRef<string | null>(debugCapability);
  const mountedRef = useRef(false);
  capabilityRef.current = debugCapability;

  useEffect(() => {
    mountedRef.current = true;
    capabilityRef.current = debugCapability;
    return () => {
      mountedRef.current = false;
      capabilityRef.current = null;
      setBreakpointSyncEnabled(false);
      setInlineValueContext(null);
      const hadSession = launchRootRef.current !== null;
      launchRootRef.current = null;
      if (hadSession) void window.axiom.debug.stop().catch(() => undefined);
    };
    // Mount ownership only; capability changes are handled by the transition effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adapterCommand = strSetting(values, 'debug.adapterCommand');
  const adapterArgs = strSetting(values, 'debug.adapterArgs');
  const program = strSetting(values, 'debug.program');

  // Detect the workspace runtime and resolve which real DAP adapters are present,
  // so the user picks a ready configuration instead of hand-typing an adapter.
  const discover = useCallback((): void => {
    const root = debugCapability;
    if (!root) {
      setDiscovered([]);
      return;
    }
    setDiscovering(true);
    void window.axiom.debug
      .discover(root)
      .then((configs) => {
        if (capabilityRef.current !== root) return;
        setDiscovered(configs);
        // Pre-select the ready runtime so Start Debugging works with no setup.
        setSelected(configs.find((config) => config.available) ?? null);
      })
      .catch(() => {
        if (capabilityRef.current !== root) return;
        setDiscovered([]);
        setSelected(null);
      })
      .finally(() => {
        if (mountedRef.current && capabilityRef.current === root) setDiscovering(false);
      });
  }, [debugCapability]);

  useEffect(() => {
    if (!debugCapability) {
      setDiscovered([]);
      setSelected(null);
      return;
    }
    discover();
  }, [debugCapability, discover]);

  const applyDiscovered = useCallback(
    (config: DiscoveredDebugConfig): void => {
      if (!config.available) return;
      setSelected(config);
      set('debug.adapterCommand', config.adapterCommand, 'user');
      set('debug.adapterArgs', config.adapterArgs.join(' '), 'user');
      if (config.programPath) set('debug.program', config.programPath, 'user');
      else if (config.program === 'active-file' && activePath) {
        set('debug.program', activePath, 'user');
      }
    },
    [activePath, set],
  );

  /**
   * Hand-editing any adapter field takes over from the detected configuration, so
   * the launch never silently mixes a manual command with a detected transport.
   */
  const overrideSetting = useCallback(
    (key: string, value: string): void => {
      setSelected(null);
      set(key, value, 'user');
    },
    [set],
  );

  const selectFrame = useCallback(
    async (frameId: number): Promise<void> => {
      const root = debugCapability;
      if (!root || capabilityRef.current !== root || launchRootRef.current !== root) return;
      try {
        setSelectedFrame(frameId);
        const scopes = await window.axiom.debug.scopes(frameId);
        if (capabilityRef.current !== root || launchRootRef.current !== root) return;
        const sv: ScopeVars[] = [];
        for (const scope of scopes) {
          if (capabilityRef.current !== root || launchRootRef.current !== root) return;
          const vars = scope.variablesReference
            ? await window.axiom.debug.variables(scope.variablesReference)
            : [];
          if (capabilityRef.current !== root || launchRootRef.current !== root) return;
          sv.push({ scope, vars });
        }
        setScopeVars(sv);
      } catch {
        if (capabilityRef.current === root && launchRootRef.current === root) setScopeVars([]);
      }
    },
    [debugCapability],
  );

  const loadStack = useCallback(
    async (tid: number): Promise<void> => {
      const root = debugCapability;
      if (!root || capabilityRef.current !== root || launchRootRef.current !== root) return;
      try {
        const f = await window.axiom.debug.stackTrace(tid);
        if (capabilityRef.current !== root || launchRootRef.current !== root) return;
        setFrames(f);
        const top = f[0];
        if (top) await selectFrame(top.id);
        else {
          setSelectedFrame(null);
          setScopeVars([]);
        }
      } catch {
        if (capabilityRef.current !== root || launchRootRef.current !== root) return;
        setFrames([]);
        setSelectedFrame(null);
        setScopeVars([]);
      }
    },
    [debugCapability, selectFrame],
  );

  useEffect(() => {
    const root = debugCapability;
    if (!root) return;
    const unsub = window.axiom.debug.onEvent((e) => {
      if (capabilityRef.current !== root || launchRootRef.current !== root) return;
      if (e.kind === 'output') {
        setOutput((o) => [...o.slice(-200), e.output]);
        return;
      }
      setState(e.state);
      if (e.state === 'stopped') {
        setThreadId(e.threadId);
        if (e.threadId != null) void loadStack(e.threadId);
      } else if (e.state === 'running') {
        setFrames([]);
        setScopeVars([]);
        setSelectedFrame(null);
      } else if (e.state === 'terminated' || e.state === 'inactive') {
        launchRootRef.current = null;
        setFrames([]);
        setScopeVars([]);
        setSelectedFrame(null);
        setThreadId(null);
      }
    });
    return unsub;
  }, [debugCapability, loadStack]);

  useEffect(
    () =>
      subscribeBreakpoints(() => {
        setBpCount(breakpointCount());
        setBpList(listBreakpoints());
      }),
    [],
  );

  /**
   * Publish the frame the user is inspecting, so the editor can draw an extension's inline values at
   * the end of the lines they belong to (PRD Phase 7). Anything other than a paused session with a
   * source-backed frame publishes null, which clears the decorations.
   */
  useEffect(() => {
    if (state !== 'stopped' || selectedFrame === null) {
      setInlineValueContext(null);
      return;
    }
    setInlineValueContext(frameInlineValueContext(frames.find((f) => f.id === selectedFrame)));
  }, [state, selectedFrame, frames]);

  // Re-evaluate watch expressions whenever we stop or change frame.
  useEffect(() => {
    const root = debugCapability;
    if (
      !root ||
      capabilityRef.current !== root ||
      launchRootRef.current !== root ||
      state !== 'stopped' ||
      watches.length === 0
    ) {
      if (!root || state !== 'stopped') setWatchResults({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const results: Record<string, string> = {};
      for (const expr of watches) {
        if (capabilityRef.current !== root || launchRootRef.current !== root) return;
        const r = await window.axiom.debug.evaluate(expr, selectedFrame);
        if (capabilityRef.current !== root || launchRootRef.current !== root) return;
        results[expr] = r.result;
      }
      if (!cancelled) setWatchResults(results);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debugCapability, state, selectedFrame, watches]);

  const start = useCallback(async (): Promise<void> => {
    const root = debugCapability;
    if (!root || capabilityRef.current !== root || launchPending) return;
    // A detected configuration is complete on its own; a manual one needs a command.
    const resolvedCommand = selected ? selected.adapterCommand : adapterCommand.trim();
    const resolvedArgs = selected
      ? selected.adapterArgs
      : adapterArgs.trim()
        ? adapterArgs.trim().split(/\s+/)
        : [];
    if (!resolvedCommand) {
      notifyError('No debug adapter configured', {
        source: 'Debug',
        detail:
          'No debuggable runtime was detected and no adapter is set. Install Node.js with the JavaScript Debugger, or Python with debugpy, then Re-scan — or set a DAP adapter command below.',
      });
      return;
    }
    launchRootRef.current = root;
    setLaunchPending(true);
    setState('initializing');
    setOutput([]);
    // Detected runtimes contribute source maps / loaders / skipped internals; the
    // caller's cwd and run shape always win over adapter-supplied defaults.
    const launchArgs: Record<string, unknown> = {
      ...(selected?.launchArgs ?? {}),
      args: [],
      stopOnEntry: false,
      cwd: root,
    };
    // An explicit Program entry wins; otherwise use the detected entry, then the tab.
    const resolvedProgram =
      program.trim() || (selected?.programPath ?? '').trim() || (activePath ?? '');
    if (resolvedProgram) launchArgs.program = resolvedProgram;
    try {
      const res = await window.axiom.debug.start(
        {
          name: 'Debug',
          adapterCommand: resolvedCommand,
          adapterArgs: resolvedArgs,
          request: 'launch',
          launchArgs,
          cwd: root,
          transport: selected?.transport ?? 'stdio',
        },
        allBreakpoints(),
      );
      if (capabilityRef.current !== root) {
        await window.axiom.debug.stop().catch(() => undefined);
        if (launchRootRef.current === root) launchRootRef.current = null;
        if (mountedRef.current) setState('inactive');
        return;
      }
      if (!res.ok) {
        if (launchRootRef.current === root) launchRootRef.current = null;
        if (mountedRef.current) setState('inactive');
        notifyError('Could not start debugging', {
          source: 'Debug',
          detail: res.message ?? 'The debug adapter failed to start.',
        });
      }
    } catch (error) {
      if (launchRootRef.current === root) launchRootRef.current = null;
      if (mountedRef.current) setState('inactive');
      if (mountedRef.current && capabilityRef.current === root) {
        notifyError('Could not start debugging', {
          source: 'Debug',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (mountedRef.current) setLaunchPending(false);
    }
  }, [adapterCommand, adapterArgs, program, activePath, selected, debugCapability, launchPending]);

  const control = (action: DebugControlAction): void => {
    const root = debugCapability;
    if (!root || capabilityRef.current !== root || launchRootRef.current !== root) return;
    if (threadId != null) {
      void window.axiom.debug.control(action, threadId).catch(() => undefined);
    } else if (action === 'pause') {
      void window.axiom.debug.control(action, 0).catch(() => undefined);
    }
  };
  const stop = (): void => {
    void window.axiom.debug.stop().catch(() => undefined);
  };

  const active = state === 'running' || state === 'stopped' || state === 'initializing';
  const paused = state === 'stopped';
  const liveSession = debugCapability !== null && launchRootRef.current === debugCapability;

  useLayoutEffect(() => {
    setBreakpointSyncEnabled(active && liveSession);
    return () => setBreakpointSyncEnabled(false);
  }, [active, liveSession]);
  const debugRestriction = !rootPath
    ? 'Open a folder to configure and start a debug session.'
    : workspaceTrust.status === 'checking'
      ? 'Checking workspace trust. Debug adapters remain disabled until the check finishes.'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified. Debugging remains disabled in Restricted Mode.'
        : 'Restricted Mode blocks debug adapters and workspace code execution. Trust this workspace to start debugging.';

  useEffect(() => {
    const previousCapability = previousCapabilityRef.current;
    previousCapabilityRef.current = debugCapability;
    if (!previousCapability || previousCapability === debugCapability) return;
    if (!active && launchRootRef.current !== previousCapability) return;

    if (launchPending) {
      void window.axiom.debug.stop().catch(() => undefined);
    } else {
      setLaunchPending(true);
      void window.axiom.debug
        .stop()
        .catch(() => undefined)
        .finally(() => {
          if (launchRootRef.current === previousCapability) launchRootRef.current = null;
          if (mountedRef.current) setLaunchPending(false);
        });
    }
    setState('inactive');
    setThreadId(null);
    setFrames([]);
    setSelectedFrame(null);
    setScopeVars([]);
    setWatchResults({});
    setOutput([]);
  }, [active, debugCapability, launchPending]);

  return (
    <div className="debug-panel">
      {!debugCapability ? (
        <div
          id="debug-restricted-message"
          className="capability-disabled"
          role="status"
          aria-live="polite"
        >
          <span className="capability-disabled-icon" aria-hidden="true">
            <ShieldIcon size={16} />
          </span>
          <div>
            <strong>Debugging unavailable</strong>
            <p>{debugRestriction}</p>
          </div>
        </div>
      ) : null}
      <div className="debug-toolbar">
        {active ? (
          <>
            <button
              type="button"
              className="debug-btn"
              title="Continue"
              disabled={!debugCapability || !paused}
              onClick={() => control('continue')}
            >
              {'\u25B6'}
            </button>
            <button
              type="button"
              className="debug-btn"
              title="Step Over"
              disabled={!debugCapability || !paused}
              onClick={() => control('next')}
            >
              {'\u2938'}
            </button>
            <button
              type="button"
              className="debug-btn"
              title="Step Into"
              disabled={!debugCapability || !paused}
              onClick={() => control('stepIn')}
            >
              {'\u2913'}
            </button>
            <button
              type="button"
              className="debug-btn"
              title="Step Out"
              disabled={!debugCapability || !paused}
              onClick={() => control('stepOut')}
            >
              {'\u2912'}
            </button>
            <button
              type="button"
              className="debug-btn"
              title="Pause"
              disabled={!debugCapability || state !== 'running'}
              onClick={() => control('pause')}
            >
              {'\u23F8'}
            </button>
            <button type="button" className="debug-btn debug-stop" title="Stop" onClick={stop}>
              {'\u23F9'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="debug-start"
            disabled={!debugCapability || launchPending}
            aria-describedby={!debugCapability ? 'debug-restricted-message' : undefined}
            onClick={() => void start()}
          >
            {'\u25B6'} Start Debugging
          </button>
        )}
        <span className={`debug-state debug-state-${state}`}>{STATE_LABEL[state]}</span>
      </div>

      {!active ? (
        <div className="debug-config">
          {debugCapability ? (
            <div className="debug-detected" aria-label="Detected debug configurations">
              <div className="debug-subhead debug-detected-head">
                <span>Detected configurations</span>
                <button
                  type="button"
                  className="debug-mini"
                  disabled={discovering}
                  title="Re-scan the workspace for debuggable runtimes"
                  onClick={discover}
                >
                  {discovering ? 'Scanning\u2026' : 'Re-scan'}
                </button>
              </div>
              {discovered.length === 0 ? (
                <div className="debug-hint">
                  {discovering
                    ? 'Detecting project runtimes\u2026'
                    : 'No debuggable runtime detected. Configure a DAP adapter below.'}
                </div>
              ) : (
                discovered.map((config) => {
                  const active = selected?.id === config.id;
                  return (
                    <div
                      key={config.id}
                      className={`debug-detected-row${config.available ? ' is-available' : ''}${
                        active ? ' is-selected' : ''
                      }`}
                    >
                      <div className="debug-detected-info">
                        <span className="debug-detected-label">
                          {config.label}
                          {active ? <span className="debug-detected-active"> · in use</span> : null}
                        </span>
                        <span className="debug-detected-detail">{config.detail}</span>
                      </div>
                      {config.available && !active ? (
                        <button
                          type="button"
                          className="debug-mini"
                          title="Use this detected runtime for the next launch"
                          onClick={() => applyDiscovered(config)}
                        >
                          Use
                        </button>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
          {selected ? (
            <div className="debug-hint">
              Zero-config launch ready: {selected.label}. Editing a field below switches to a manual
              adapter.
            </div>
          ) : null}
          <label className="debug-field">
            <span>Adapter command</span>
            <input
              type="text"
              spellCheck={false}
              placeholder={selected ? selected.adapterCommand : 'e.g. node'}
              value={adapterCommand}
              onChange={(e) => overrideSetting('debug.adapterCommand', e.target.value)}
            />
          </label>
          <label className="debug-field">
            <span>Adapter args</span>
            <input
              type="text"
              spellCheck={false}
              placeholder={
                selected ? selected.adapterArgs.join(' ') : 'args to launch the DAP adapter'
              }
              value={adapterArgs}
              onChange={(e) => overrideSetting('debug.adapterArgs', e.target.value)}
            />
          </label>
          <label className="debug-field">
            <span>Program</span>
            <div className="debug-field-row">
              <input
                type="text"
                spellCheck={false}
                placeholder={
                  selected?.programPath
                    ? selected.programPath
                    : 'path to the program to debug (defaults to the active file)'
                }
                value={program}
                onChange={(e) => set('debug.program', e.target.value, 'user')}
              />
              <button
                type="button"
                className="debug-mini"
                disabled={!activePath}
                title="Use the active editor file"
                onClick={() => {
                  if (activePath) set('debug.program', activePath, 'user');
                }}
              >
                Active file
              </button>
            </div>
          </label>
          <div className="debug-hint">
            {bpCount} breakpoint{bpCount === 1 ? '' : 's'} set · toggle them in the editor gutter.
          </div>
        </div>
      ) : null}

      {bpList.length > 0 ? (
        <div className="debug-section">
          <div className="debug-subhead">Breakpoints</div>
          {bpList.map((b) => (
            <div className="debug-bp" key={`${b.path}:${b.line}`}>
              <span className="debug-bp-loc" title={b.path}>
                {b.path.split(/[\\/]/).pop()}:{b.line}
              </span>
              <input
                type="text"
                className="debug-bp-cond"
                spellCheck={false}
                disabled={!debugCapability}
                placeholder="condition…"
                defaultValue={b.condition ?? ''}
                onBlur={(e) => {
                  if (debugCapability) setBreakpointCondition(b.path, b.line, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {frames.length > 0 ? (
        <div className="debug-section">
          <div className="debug-subhead">Call Stack</div>
          {frames.map((f) => (
            <button
              type="button"
              key={f.id}
              className={`debug-frame${selectedFrame === f.id ? ' is-selected' : ''}`}
              title={f.path ?? f.name}
              disabled={!debugCapability}
              onClick={() => void selectFrame(f.id)}
            >
              <span className="debug-frame-name">{f.name}</span>
              <span className="debug-frame-loc">
                {f.path ? `${f.path.split(/[\\/]/).pop()}:${f.line}` : `:${f.line}`}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {scopeVars.length > 0 ? (
        <div className="debug-section">
          <div className="debug-subhead">Variables</div>
          {scopeVars.map((sv) => (
            <div key={sv.scope.name} className="debug-scope">
              <div className="debug-scope-name">{sv.scope.name}</div>
              {sv.vars.slice(0, 100).map((v, i) => (
                <div className="debug-var" key={`${v.name}:${i}`} title={`${v.name}: ${v.value}`}>
                  <span className="debug-var-name">{v.name}</span>
                  <span className="debug-var-value">{v.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="debug-section">
        <div className="debug-subhead">Watch</div>
        <form
          className="debug-watch-add"
          onSubmit={(e) => {
            e.preventDefault();
            const expr = newWatch.trim();
            if (expr && !watches.includes(expr)) setWatches((w) => [...w, expr]);
            setNewWatch('');
          }}
        >
          <input
            type="text"
            spellCheck={false}
            disabled={!debugCapability}
            placeholder={'add expression\u2026'}
            value={newWatch}
            onChange={(e) => setNewWatch(e.target.value)}
          />
        </form>
        {watches.map((expr) => (
          <div className="debug-watch" key={expr} title={expr}>
            <span className="debug-watch-expr">{expr}</span>
            <span className="debug-watch-val">
              {watchResults[expr] ?? (state === 'stopped' ? '\u2026' : '\u2014')}
            </span>
            <button
              type="button"
              className="debug-watch-x"
              aria-label={`Remove ${expr}`}
              onClick={() => setWatches((w) => w.filter((x) => x !== expr))}
            >
              {'\u00D7'}
            </button>
          </div>
        ))}
      </div>

      {output.length > 0 ? (
        <div className="debug-section">
          <div className="debug-subhead">Output</div>
          <pre className="debug-output">{output.join('')}</pre>
        </div>
      ) : null}
    </div>
  );
}
