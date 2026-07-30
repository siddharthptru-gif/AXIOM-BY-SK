import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../common/ipc';
import { Modal } from './Modal';
import { onAboutOpen } from './aboutBus';

/** Production-facing product, runtime, privacy, and legal information. */
export function AboutView() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState(false);

  useEffect(() => onAboutOpen(() => setOpen(true)), []);

  useEffect(() => {
    if (!open || info) return;
    let cancelled = false;
    setInfoError(false);
    void window.axiom.app
      .getInfo()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setInfoError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, info]);

  if (!open) return null;

  return (
    <Modal title="About Axiom" onClose={() => setOpen(false)}>
      <div className="spend-dash">
        <div className="spend-row">
          <span>
            <strong>{info?.name ?? 'Axiom'}</strong> — {info?.tagline ?? 'Think. Build. Ship.'}
          </span>
          <span className="spend-muted">{info ? `v${info.version}` : 'Loading version…'}</span>
        </div>
        <p className="ai-hint">
          An AI-native, local-first desktop IDE. Your BYOK requests travel directly from this device
          to the provider you select; Axiom does not proxy your code or prompts.
        </p>

        <div className="spend-subhead">Build information</div>
        {info ? (
          <div className="ai-hint">
            <div>
              Platform: {info.platform} · {info.arch}
            </div>
            <div>
              Runtime: Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
            </div>
          </div>
        ) : (
          <p className="ai-hint" role={infoError ? 'alert' : 'status'}>
            {infoError ? 'Build information is temporarily unavailable.' : 'Reading build details…'}
          </p>
        )}

        <div className="spend-subhead">Pricing</div>
        <p className="ai-hint">
          <strong>Axiom is free to use.</strong> You are responsible only for charges from AI
          providers you choose to connect with your own API keys; Axiom does not bill provider
          usage.
        </p>

        <div className="spend-subhead">Privacy</div>
        <p className="ai-hint">
          Your settings and local history stay on this device by default. Provider credentials are
          stored only when operating-system encryption is available, and keys are sent directly to
          the provider endpoints you configure. Optional cloud features are account- and
          consent-gated; telemetry and crash reporting remain opt-in.
        </p>

        <div className="spend-subhead">Optional cloud features</div>
        <p className="ai-hint">
          Google sign-in can enable services such as preference and prompt sync when they are
          available. Signing in is never required for the editor, Git, terminals, local models, or
          direct BYOK workflows.
        </p>

        <div className="spend-subhead">Terms</div>
        <p className="ai-hint">
          Axiom is provided as is. You remain responsible for protecting provider credentials,
          reviewing generated code, and complying with the terms and usage policies of connected
          providers. Your code and content remain yours.
        </p>
      </div>
    </Modal>
  );
}
