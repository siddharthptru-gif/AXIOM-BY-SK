import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LanguageCatalogEntry,
  LanguageExtraStatus,
  LanguageRuntimeStatus,
  LanguagesCatalog,
} from '../../../common/languagePacks';
import { refreshRuntimes } from '../state/runtimes';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  RefreshIcon,
  StopIcon,
  WarningIcon,
} from './icons';

/**
 * LANGUAGES view.
 *
 * AXIOM cannot bundle SDKs — a ~100 MB installer cannot ship a JDK, the .NET SDK and
 * a Python runtime. So this view does the next best thing: it shows exactly which
 * toolchains a language needs, whether this machine has them, and installs the
 * missing ones with the operating system's own package manager.
 *
 * Everything decided here is decided in Main. This component sends a language pack
 * id and renders what comes back; it cannot choose a package manager, compose a
 * command, or declare something installed. That keeps a renderer compromise from
 * turning into arbitrary execution, and it means the approval dialog the user sees is
 * the literal command that will run.
 */

/** Keep the streamed log bounded so a chatty installer cannot bloat the DOM. */
const MAX_OUTPUT_CHARS = 40_000;

function clipOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(text.length - MAX_OUTPUT_CHARS) : text;
}

interface FinishedInstall {
  languageId: string;
  ok: boolean;
  detected: boolean;
  restartRequired: boolean;
  text: string;
}

function ToolRow({ tool }: { tool: LanguageRuntimeStatus }) {
  return (
    <li className={`languages-tool ${tool.installed ? 'is-present' : 'is-absent'}`}>
      <span className="languages-tool-mark" aria-hidden="true">
        {tool.installed ? <CheckIcon size={12} /> : <span className="languages-dot" />}
      </span>
      <span className="languages-tool-name">{tool.displayName}</span>
      {tool.required ? null : <span className="languages-tool-optional">optional</span>}
      <span className="languages-tool-version">
        {tool.installed ? (tool.version ?? 'installed') : 'not found'}
      </span>
    </li>
  );
}

/**
 * An add-on row. Shown alongside the toolchains because a language that runs but
 * cannot be debugged is a state the user needs to see, not guess at.
 */
function ExtraRow({ extra }: { extra: LanguageExtraStatus }) {
  return (
    <li className={`languages-tool ${extra.installed ? 'is-present' : 'is-absent'}`}>
      <span className="languages-tool-mark" aria-hidden="true">
        {extra.installed ? <CheckIcon size={12} /> : <span className="languages-dot" />}
      </span>
      <span className="languages-tool-name">{extra.packageId}</span>
      <span className="languages-tool-optional" title={extra.purpose}>
        add-on
      </span>
      <span className="languages-tool-version">
        {extra.installed ? 'installed' : 'not installed'}
      </span>
    </li>
  );
}

export function LanguagesView() {
  const [catalog, setCatalog] = useState<LanguagesCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [step, setStep] = useState<{ index: number; total: number; text: string } | null>(null);
  const [output, setOutput] = useState('');
  const [finished, setFinished] = useState<FinishedInstall | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const installIdRef = useRef<string | null>(null);
  const busyIdRef = useRef<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async (rescan: boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = rescan
        ? await window.axiom.languages.rescan()
        : await window.axiom.languages.catalog();
      setCatalog(next);
      // Keep the Run system's copy in step, so a language that just appeared makes
      // the Run button work without the user hunting for a refresh.
      void refreshRuntimes(rescan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the language catalog.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    return window.axiom.languages.onInstallEvent((event) => {
      if (event.installId !== installIdRef.current) return;
      if (event.kind === 'step') {
        setStep({ index: event.index, total: event.total, text: event.text });
        setOutput((current) => clipOutput(`${current}\n$ ${event.text}\n`));
        return;
      }
      if (event.kind === 'output') {
        setOutput((current) => clipOutput(current + event.text));
        return;
      }
      const languageId = busyIdRef.current ?? '';
      installIdRef.current = null;
      busyIdRef.current = null;
      setBusyId(null);
      setStep(null);
      setFinished({
        languageId,
        ok: event.ok,
        detected: event.detected,
        restartRequired: event.restartRequired,
        text: event.text,
      });
      void load(true);
    });
  }, [load]);

  // Follow the log while an install streams.
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [output]);

  const install = useCallback(
    async (languageId: string): Promise<void> => {
      if (busyIdRef.current) return;
      setError(null);
      setFinished(null);
      setOutput('');
      setStep(null);
      busyIdRef.current = languageId;
      setBusyId(languageId);
      try {
        const started = await window.axiom.languages.install(languageId);
        installIdRef.current = started.installId;
      } catch (cause) {
        busyIdRef.current = null;
        setBusyId(null);
        setError(cause instanceof Error ? cause.message : 'The install could not be started.');
      }
    },
    [],
  );

  const cancel = useCallback((): void => {
    const id = installIdRef.current;
    if (!id) return;
    void window.axiom.languages.cancelInstall(id).catch(() => undefined);
  }, []);

  const copy = useCallback((text: string): void => {
    void window.axiom.system.copyText(text).catch(() => undefined);
  }, []);

  const primaryManagers = (catalog?.managers ?? []).filter((manager) => !manager.extrasOnly);
  const activeManager = primaryManagers.find((manager) => manager.available && !manager.needsSudo);

  const renderEntry = (entry: LanguageCatalogEntry) => {
    const installing = busyId === entry.id;
    const done = finished?.languageId === entry.id ? finished : null;
    const missingExtras = entry.extras.filter((extra) => !extra.installed);
    // A ready language with a missing add-on still needs one runnable command; that
    // is the only way to get a debugger onto a machine that already has the runtime.
    const addOnsOnly = entry.ready && missingExtras.length > 0 && entry.plan.runnable;
    return (
      <article
        key={entry.id}
        className={`languages-card ${entry.ready ? 'is-ready' : 'is-missing'}`}
        aria-label={entry.displayName}
      >
        <header className="languages-card-head">
          <div className="languages-card-title">
            <strong>{entry.displayName}</strong>
            <span className={`languages-pill ${entry.ready ? 'ok' : 'warn'}`}>
              {entry.ready ? 'Ready' : 'Not installed'}
            </span>
          </div>
          {!entry.ready && entry.plan.runnable ? (
            <button
              type="button"
              className="btn btn-primary languages-install"
              disabled={busyId !== null}
              title={`Install with ${entry.plan.managerName ?? 'the system package manager'}`}
              onClick={() => void install(entry.id)}
            >
              <DownloadIcon size={14} />
              <span>{installing ? 'Installing…' : 'Install'}</span>
            </button>
          ) : addOnsOnly ? (
            <button
              type="button"
              className="btn languages-install languages-install-extra"
              disabled={busyId !== null}
              title={missingExtras.map((extra) => extra.purpose).join(' · ')}
              onClick={() => void install(entry.id)}
            >
              <DownloadIcon size={14} />
              <span>
                {installing
                  ? 'Installing…'
                  : `Install ${missingExtras.map((extra) => extra.packageId).join(', ')}`}
              </span>
            </button>
          ) : null}
        </header>

        <p className="languages-blurb">{entry.blurb}</p>

        <ul className="languages-tools">
          {entry.runtimes.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
          {entry.extras.map((extra) => (
            <ExtraRow key={extra.packageId} extra={extra} />
          ))}
        </ul>

        {entry.plan.runnable ? (
          <p className="languages-plan">
            {addOnsOnly ? 'Adds' : 'Installs'} with <strong>{entry.plan.managerName}</strong> ·{' '}
            {entry.plan.steps.length === 1 ? '1 command' : `${entry.plan.steps.length} commands`}.
            AXIOM shows you the exact command for approval first.
          </p>
        ) : null}

        {!entry.ready && !entry.plan.runnable ? (
          <div className="languages-manual">
            <p>{entry.plan.blockedReason}</p>
            {entry.plan.manualCommands.map((command) => (
              <div key={command} className="languages-command">
                <code>{command}</code>
                <button
                  type="button"
                  className="languages-copy"
                  title="Copy this command"
                  aria-label={`Copy command ${command}`}
                  onClick={() => copy(command)}
                >
                  <CopyIcon size={12} />
                </button>
              </div>
            ))}
            <div className="languages-command">
              <code>{entry.docsUrl}</code>
              <button
                type="button"
                className="languages-copy"
                title="Copy the official download page"
                aria-label={`Copy download page for ${entry.displayName}`}
                onClick={() => copy(entry.docsUrl)}
              >
                <CopyIcon size={12} />
              </button>
            </div>
          </div>
        ) : null}

        {done ? (
          <div
            className={`languages-result ${done.ok ? (done.detected ? 'ok' : 'warn') : 'bad'}`}
            role="status"
            aria-live="polite"
          >
            {done.ok && done.detected ? <CheckIcon size={14} /> : <WarningIcon size={14} />}
            <div>
              <p>{done.text}</p>
              {done.restartRequired ? (
                <p className="languages-result-hint">
                  Close AXIOM and open it again. Programs that are already running keep the
                  environment they started with, which is why this one restart is needed.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <div className="languages-view">
      <div className="languages-header">
        <div className="languages-header-text">
          <strong>Languages</strong>
          <span>
            {activeManager
              ? `Installs use ${activeManager.displayName}.`
              : 'No package manager AXIOM can drive was found on this machine.'}
          </span>
        </div>
        <button
          type="button"
          className="languages-rescan"
          title="Re-read this machine and detect newly installed toolchains"
          aria-label="Re-scan installed toolchains"
          disabled={loading || busyId !== null}
          onClick={() => void load(true)}
        >
          <RefreshIcon size={14} />
          <span>Re-scan</span>
        </button>
      </div>

      {error ? (
        <div className="languages-error" role="alert">
          <WarningIcon size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="languages-search-shell" style={{ padding: '0.5rem 0.75rem' }}>
        <input
          type="search"
          className="input languages-search-input"
          placeholder="Search compilers & packages (GCC, Clang, Java, Python, Rust, Go)..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search languages and toolchains"
          style={{ width: '100%', padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
        />
      </div>

      {busyId ? (
        <section className="languages-progress" aria-label="Install progress">
          <div className="languages-progress-head">
            <span>
              {step
                ? `Step ${step.index} of ${step.total}`
                : 'Waiting for the package manager…'}
            </span>
            <button type="button" className="languages-cancel" onClick={cancel} title="Stop this install">
              <StopIcon size={12} />
              <span>Stop</span>
            </button>
          </div>
          {step ? <code className="languages-progress-command">{step.text}</code> : null}
          <pre className="languages-log" ref={logRef} aria-live="polite" aria-label="Install output">
            {output}
          </pre>
        </section>
      ) : null}

      {loading && !catalog ? (
        <div className="empty-state">
          <p>Checking which toolchains this machine has…</p>
        </div>
      ) : catalog ? (
        <div className="languages-list">
          {catalog.entries
            .filter((entry) => {
              if (!searchQuery.trim()) return true;
              const q = searchQuery.toLowerCase().trim();
              return (
                entry.displayName.toLowerCase().includes(q) ||
                entry.blurb.toLowerCase().includes(q) ||
                entry.runtimes.some(
                  (r) => r.displayName.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
                ) ||
                entry.extras.some((e) => e.packageId.toLowerCase().includes(q))
              );
            })
            .map(renderEntry)}
        </div>
      ) : null}

      {catalog && !catalog.canAutoInstall ? (
        <div className="languages-footnote">
          <p>
            AXIOM installs toolchains through your operating system&apos;s package manager and never
            downloads an installer itself. Install one of these to enable one-click setup:
          </p>
          <ul>
            {primaryManagers.map((manager) => (
              <li key={manager.id}>
                {manager.displayName}
                {manager.needsSudo ? ' (needs administrator rights)' : ''} — {manager.docsUrl}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
