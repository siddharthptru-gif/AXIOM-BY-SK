import { useEffect, useState } from 'react';
import type { LocalModelProbe } from '../../../common/ipc';
import { useSettings } from '../settings/store';
import { DialogFrame } from './Modal';

/**
 * First-run onboarding wizard (PRD Epoch E, Phase 132). A short, skippable modal
 * that sets up appearance + the AI provider on first launch, then records
 * `onboarding.done` so it never shows again. Self-contained: it only touches
 * local settings, so it works before sign-in and offline.
 */
export const ONBOARDING_STEPS = ['welcome', 'appearance', 'ai', 'godmode', 'finish'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Whether the wizard should show (first run — not yet completed). */
export function onboardingNeeded(values: Record<string, unknown>): boolean {
  return values['onboarding.done'] !== true;
}

/** Clamp a step index to a valid step id (pure). */
export function stepAt(index: number): OnboardingStep {
  const i = Math.min(Math.max(0, index), ONBOARDING_STEPS.length - 1);
  return ONBOARDING_STEPS[i] as OnboardingStep;
}

const THEMES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'axiom-royal', label: 'Royal Indigo' },
  { id: 'axiom-royal-light', label: 'Royal Indigo Light' },
  { id: 'axiom-dark', label: 'Royal Graphite' },
  { id: 'axiom-light', label: 'Royal Graphite Light' },
  { id: 'axiom-midnight', label: 'Midnight' },
  { id: 'axiom-high-contrast', label: 'High Contrast' },
];
const ACCENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gold', label: 'Gold' },
  { id: 'sapphire', label: 'Sapphire' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'mono', label: 'Monochrome' },
  { id: 'violet', label: 'Violet' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
];
const CORNERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'sharp', label: 'Sharp' },
  { id: 'soft', label: 'Soft' },
  { id: 'round', label: 'Rounded' },
];
const PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ollama', label: 'Ollama (local, free — no key)' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'custom', label: 'Custom (OpenAI-Compatible)' },
];

function strVal(values: Record<string, unknown>, key: string, fallback: string): string {
  return typeof values[key] === 'string' ? (values[key] as string) : fallback;
}

export function OnboardingWizard() {
  const { values, set, loaded } = useSettings();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Free local models (Ollama). Probed only while the AI step is on screen so the
  // wizard can hand a keyless, zero-egress setup to users with no API key.
  const [localProbe, setLocalProbe] = useState<LocalModelProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const step = stepAt(index);
  const onAiStep = loaded && !dismissed && onboardingNeeded(values) && step === 'ai';

  useEffect(() => {
    if (!onAiStep || localProbe !== null) return;
    let active = true;
    setProbing(true);
    void window.axiom.ai
      .detectLocalModels()
      .then((probe) => {
        if (active) setLocalProbe(probe);
      })
      .catch(() => {
        if (active) setLocalProbe(null);
      })
      .finally(() => {
        if (active) setProbing(false);
      });
    return () => {
      active = false;
    };
  }, [onAiStep, localProbe]);

  // Do not project compiled defaults before persisted user settings hydrate; that
  // caused a completed wizard to flash (and allowed early choices to overwrite it).
  if (!loaded || dismissed || !onboardingNeeded(values)) return null;

  const theme = strVal(values, 'workbench.colorTheme', 'axiom-royal');
  const accent = strVal(values, 'workbench.accentColor', 'gold');
  const corner = strVal(values, 'workbench.cornerStyle', 'soft');
  const provider = strVal(values, 'ai.provider', 'anthropic');

  const finish = (): void => {
    set('onboarding.done', true, 'user');
    setDismissed(true);
  };
  const next = (): void => {
    if (index >= ONBOARDING_STEPS.length - 1) finish();
    else setIndex((i) => i + 1);
  };
  const back = (): void => setIndex((i) => Math.max(0, i - 1));

  return (
    <DialogFrame
      onClose={finish}
      closeOnBackdrop={false}
      overlayClassName="onboarding-overlay"
      cardClassName="onboarding-card"
      ariaLabel="Welcome to Axiom"
    >
      <div className="onboarding-progress">
        {ONBOARDING_STEPS.map((s, i) => (
          <span key={s} className={`onboarding-dot${i === index ? ' is-on' : ''}`} />
        ))}
      </div>

      {step === 'welcome' ? (
        <div className="onboarding-step">
          <h1 className="onboarding-title">Welcome to Axiom</h1>
          <p className="onboarding-lead">
            An AI-native IDE. Let&apos;s set up the essentials — it takes a few seconds and you can
            change everything later in Settings.
          </p>
        </div>
      ) : step === 'appearance' ? (
        <div className="onboarding-step">
          <h2 className="onboarding-title">Appearance</h2>
          <p className="onboarding-lead">Pick a theme and accent.</p>
          <div className="onboarding-label">Theme</div>
          <div className="onboarding-choices" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`onboarding-choice${theme === t.id ? ' is-on' : ''}`}
                aria-pressed={theme === t.id}
                onClick={() => set('workbench.colorTheme', t.id, 'user')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="onboarding-label">Accent</div>
          <div className="onboarding-choices" role="group" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`onboarding-choice${accent === a.id ? ' is-on' : ''}`}
                aria-pressed={accent === a.id}
                onClick={() => set('workbench.accentColor', a.id, 'user')}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="onboarding-label">Corners</div>
          <div className="onboarding-choices" role="group" aria-label="Corner style">
            {CORNERS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`onboarding-choice${corner === c.id ? ' is-on' : ''}`}
                aria-pressed={corner === c.id}
                onClick={() => set('workbench.cornerStyle', c.id, 'user')}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ) : step === 'ai' ? (
        <div className="onboarding-step">
          <h2 className="onboarding-title">AI Provider</h2>
          <p className="onboarding-lead">
            Axiom works with your own key, or with a free local model server. Credentials are stored
            only when OS encryption is available, and keys are sent directly to the provider
            endpoint you configure.
          </p>
          {localProbe?.available && localProbe.models.length > 0 ? (
            <div className="onboarding-local is-available">
              <strong>Free local AI detected</strong>
              <p>
                {localProbe.label} is running with {localProbe.models.length} model
                {localProbe.models.length === 1 ? '' : 's'}. Use it and you are done — no API key, no
                account, and nothing leaves this machine.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const first = localProbe.models[0];
                  if (!first) return;
                  set('ai.provider', 'ollama', 'user');
                  set('ai.baseUrl', localProbe.baseUrl, 'user');
                  set('ai.model', first, 'user');
                }}
              >
                Use {localProbe.models[0]} (free)
              </button>
            </div>
          ) : (
            <div className="onboarding-local">
              <strong>Want AI without an API key?</strong>
              <p>
                {probing
                  ? 'Checking for a local model server\u2026'
                  : (localProbe?.message ??
                    'Install Ollama and pull a model; Axiom detects it on loopback automatically and sends nothing off your machine.')}
              </p>
            </div>
          )}
          <div className="onboarding-choices" role="group" aria-label="AI provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`onboarding-choice${provider === p.id ? ' is-on' : ''}`}
                aria-pressed={provider === p.id}
                onClick={() => set('ai.provider', p.id, 'user')}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ) : step === 'godmode' ? (
        <div className="onboarding-step">
          <h2 className="onboarding-title">God Mode, with guardrails</h2>
          <p className="onboarding-lead">
            The God Mode activity unifies context evaluation, durable Build jobs, isolated preview,
            verification, issue-to-PR, workspaces, sandboxed extensions, collaboration, and preview
            deployment. Main retains authority over workspace trust, processes, credentials,
            approvals, Git, and network access. Provider and cloud features show setup-required until
            they are actually configured.
          </p>
        </div>
      ) : (
        <div className="onboarding-step">
          <h2 className="onboarding-title">You&apos;re all set</h2>
          <p className="onboarding-lead">
            Open a folder to start coding. Use the command palette (Ctrl+Shift+P) for everything,
            and the Axiom AI panel for chat, inline actions, and the agent.
          </p>
        </div>
      )}

      <div className="onboarding-actions">
        <button type="button" className="btn btn-ghost" onClick={finish}>
          Skip
        </button>
        <div className="onboarding-nav">
          {index > 0 ? (
            <button type="button" className="btn btn-ghost" onClick={back}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={next}>
            {index >= ONBOARDING_STEPS.length - 1 ? 'Get Started' : 'Next'}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
