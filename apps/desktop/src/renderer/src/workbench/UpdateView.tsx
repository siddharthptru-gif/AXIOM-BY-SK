import { useEffect, useRef, useState } from 'react';
import { DialogFrame, Modal } from './Modal';
import { onUpdateOpen } from './updateBus';
import {
  initialUpdateState,
  progressText,
  errorMessage,
  type UpdateUiState,
} from '../../../common/updateState';

/**
 * Update UI (UPDATEFEATURE §3/§8/§10). A single mounted controller that:
 *   - subscribes to the main-process update status stream (reduced into UI state);
 *   - seeds from a getState() snapshot so a mandatory block survives a reload;
 *   - renders the OPTIONAL update dialog (Update now / Remind me later / progress /
 *     restart / release notes / error+retry), auto-surfaced on available/ready/error;
 *   - renders the MANDATORY full-screen guard that blocks all app use until the
 *     update is installed (no close, only "Restart & Install").
 *
 * Reuses existing modal/spend/ai/btn classes plus `update-*` classes in global.css.
 */
const AUTO_SURFACE: ReadonlySet<UpdateUiState['phase']> = new Set(['available', 'ready', 'error']);

export function UpdateView() {
  const [state, setState] = useState<UpdateUiState>(initialUpdateState);
  const [hydrated, setHydrated] = useState(false);
  const [visible, setVisible] = useState(false);
  const prevPhase = useRef(state.phase);

  // Status envelopes and snapshots both contain complete authoritative state.
  // Subscribe first, accept whichever arrives first, and retry failed snapshots
  // while the UI remains fail-closed behind the hydration guard below.
  useEffect(() => {
    let cancelled = false;
    let appliedRevision = -1;
    let appliedPhase: UpdateUiState['phase'] = initialUpdateState.phase;
    let retryDelayMs = 250;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const install = (revision: number, next: UpdateUiState): void => {
      if (cancelled || revision <= appliedRevision) return;
      appliedRevision = revision;
      if (next.phase !== appliedPhase && AUTO_SURFACE.has(next.phase)) setVisible(true);
      appliedPhase = next.phase;
      setState(next);
      setHydrated(true);
    };

    const off = window.axiom.update.onStatus((status) => {
      install(status.revision, status.state);
    });

    const hydrate = (): void => {
      void window.axiom.update
        .getState()
        .then((snapshot) => {
          if (cancelled) return;
          install(snapshot.revision, snapshot.state);
        })
        .catch(() => {
          if (cancelled || appliedRevision >= 0) return;
          retryTimer = setTimeout(hydrate, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5000);
        });
    };
    hydrate();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      off();
    };
  }, []);

  // "Check for Updates" opens the dialog before triggering a fresh check, so an
  // unavailable result is visible here without auto-surfacing background checks.
  useEffect(
    () =>
      onUpdateOpen(() => {
        setVisible(true);
        void window.axiom.update.check();
      }),
    [],
  );

  // Auto-surface the optional dialog on meaningful transitions (so "Remind me
  // later" sticks until the next real change, e.g. download → ready).
  useEffect(() => {
    if (state.phase !== prevPhase.current) {
      if (AUTO_SURFACE.has(state.phase)) setVisible(true);
      prevPhase.current = state.phase;
    }
  }, [state.phase]);

  const download = (): void => void window.axiom.update.download();
  const install = (): void => void window.axiom.update.install();
  const recheck = (): void => void window.axiom.update.check();
  const dismiss = (): void => setVisible(false);

  const version = state.plan?.latestVersion ?? '';

  // Until Main supplies authoritative policy, do not expose the workbench. This
  // prevents a reload from briefly bypassing an already-active mandatory update.
  if (!hydrated) {
    return (
      <DialogFrame
        overlayClassName="update-guard"
        cardClassName="update-guard-card"
        ariaLabel="Verifying update policy"
        closeOnBackdrop={false}
      >
        <div className="update-guard-brand">AXIOM</div>
        <h2 className="update-guard-title">Verifying update policy</h2>
        <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
          Confirming whether this version can continue securely. Axiom will retry automatically.
        </p>
        <div className="update-actions">
          <button type="button" className="btn" disabled>
            Checking…
          </button>
        </div>
      </DialogFrame>
    );
  }

  // ---- mandatory guard: full-screen, non-dismissible --------------------------
  if (state.mustBlock) {
    return (
      <DialogFrame
        overlayClassName="update-guard"
        cardClassName="update-guard-card"
        ariaLabel="Update required"
        closeOnBackdrop={false}
      >
        <div className="update-guard-brand">AXIOM</div>
        <h2 className="update-guard-title">A required update must be installed</h2>
        <p className="ai-hint">
          This version of Axiom is no longer supported. To keep you secure, the app is locked until
          the latest version {version ? <strong>({version})</strong> : null} is installed.
        </p>
        {state.phase === 'error' ? (
          <p className="ai-hint" role="alert" aria-atomic="true">
            {state.errorKind ? errorMessage(state.errorKind) : 'An update error occurred.'}
          </p>
        ) : (
          <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
            {state.message}
          </p>
        )}
        <UpdateProgress state={state} />
        <div className="update-actions">
          {state.phase === 'ready' ? (
            <button type="button" className="btn" onClick={install}>
              Restart &amp; Install
            </button>
          ) : state.phase === 'error' ? (
            <button type="button" className="btn" onClick={download}>
              Retry
            </button>
          ) : (
            <button type="button" className="btn" disabled>
              {state.phase === 'downloading' || state.phase === 'verifying'
                ? 'Preparing update…'
                : 'Starting…'}
            </button>
          )}
        </div>
        {state.plan?.releaseNotes ? (
          <details className="update-notes">
            <summary>What&apos;s new</summary>
            <pre>{state.plan.releaseNotes}</pre>
          </details>
        ) : null}
      </DialogFrame>
    );
  }

  // ---- optional dialog --------------------------------------------------------
  if (!visible) return null;

  return (
    <Modal title="Software Update" onClose={dismiss}>
      <div className="spend-dash">
        {state.phase === 'checking' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              Checking for updates…
            </p>
            <div className="update-actions">
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : state.phase === 'up-to-date' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              You are on the latest version of Axiom.
            </p>
            <div className="update-actions">
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : state.phase === 'unavailable' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              {state.message}
            </p>
            <div className="update-actions">
              <button type="button" className="btn" onClick={recheck}>
                Retry
              </button>
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : state.phase === 'available' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              <strong>Axiom {version}</strong> is available. {state.plan?.reason}
            </p>
            <div className="update-actions">
              <button type="button" className="btn" onClick={download}>
                Update now
              </button>
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Remind me later
              </button>
            </div>
          </>
        ) : state.phase === 'downloading' || state.phase === 'verifying' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              {state.phase === 'verifying' ? 'Verifying update…' : 'Downloading update…'}
            </p>
            <UpdateProgress state={state} />
            <div className="update-actions">
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Hide
              </button>
            </div>
          </>
        ) : state.phase === 'ready' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              Axiom {version} has been downloaded and verified.
            </p>
            <div className="update-actions">
              <button type="button" className="btn" onClick={install}>
                Restart &amp; Install
              </button>
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Later
              </button>
            </div>
          </>
        ) : state.phase === 'installing' ? (
          <>
            <p className="ai-hint" role="status" aria-live="polite" aria-atomic="true">
              Installing update…
            </p>
            <div className="update-actions">
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : state.phase === 'error' ? (
          <>
            <p className="ai-hint" role="alert" aria-atomic="true">
              {state.errorKind ? errorMessage(state.errorKind) : 'An update error occurred.'}
            </p>
            <div className="update-actions">
              <button type="button" className="btn" onClick={recheck}>
                Retry
              </button>
              <button type="button" className="btn btn-ghost" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        ) : null}

        {state.plan?.releaseNotes && (state.phase === 'available' || state.phase === 'ready') ? (
          <details className="update-notes">
            <summary>What&apos;s new in {version}</summary>
            <pre>{state.plan.releaseNotes}</pre>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}

function UpdateProgress({ state }: { state: UpdateUiState }) {
  const progress = Math.max(0, Math.min(100, state.progress));
  const text = progressText(state);
  return (
    <div className="update-progress-wrap">
      <div
        className="update-progress"
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={text}
      >
        <div className="update-progress-bar" style={{ width: `${progress}%` }} />
      </div>
      <span className="update-progress-text">{text}</span>
    </div>
  );
}
