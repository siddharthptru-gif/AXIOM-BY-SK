import { useCallback, useEffect, useState } from 'react';
import { aiSecretKey, type LocalModelProbe } from '../../../common/ipc';
import { defaultBaseUrl } from '../../../common/providers';
import { useSettings } from '../settings/store';
import { getAiSettings } from '../settings/schema';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { useLayout } from '../state/layout';
import { notifyError, notifyInfo } from '../notifications/bus';
import { CheckIcon, ShieldIcon, SparkIcon } from './icons';

/**
 * Getting started checklist (first-run value in ~60 seconds).
 *
 * The onboarding wizard collects preferences; this proves the product works. Every
 * row reflects REAL, live state — an open folder, granted trust, a usable AI
 * endpoint — so a tick is never a claim we have not verified. Each unfinished row
 * carries the single action that finishes it, and the free local-AI path means a
 * user with no API key and no account can reach a working assistant.
 *
 * Dismissal is persisted (`onboarding.checklist.done`), and the list hides itself
 * once every step is genuinely complete.
 */
const DISMISS_KEY = 'onboarding.checklist.done';

type StepState = 'done' | 'todo' | 'blocked';

interface Step {
  id: string;
  title: string;
  detail: string;
  state: StepState;
  actionLabel?: string;
  action?: () => void;
  busy?: boolean;
}

export function GettingStarted() {
  const ws = useWorkspace();
  const trust = useWorkspaceTrust();
  const layout = useLayout();
  const { values, set, loaded } = useSettings();
  const ai = getAiSettings(values);

  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [localProbe, setLocalProbe] = useState<LocalModelProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [trusting, setTrusting] = useState(false);

  const provider = ai.provider;
  const model = ai.model.trim();
  const baseUrl = ai.baseUrl.trim();

  // Honest readiness: a selected model plus an endpoint-authorized credential.
  // Ollama is a loopback server that needs no key, so a model is sufficient.
  useEffect(() => {
    let active = true;
    if (provider === 'ollama') {
      setAiReady(model.length > 0);
      return () => {
        active = false;
      };
    }
    if (provider === 'custom') {
      setAiReady(baseUrl.length > 0 && model.length > 0);
      return () => {
        active = false;
      };
    }
    setAiReady(null);
    void window.axiom.secrets
      .has(aiSecretKey(provider), {
        provider,
        baseUrl: baseUrl || defaultBaseUrl(provider),
      })
      .then((present) => {
        if (active) setAiReady(present && model.length > 0);
      })
      .catch(() => {
        if (active) setAiReady(false);
      });
    return () => {
      active = false;
    };
  }, [provider, baseUrl, model]);

  // Probe the free local server once, only while the AI step is still unfinished.
  useEffect(() => {
    if (aiReady !== false || localProbe !== null) return;
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
  }, [aiReady, localProbe]);

  const useLocalAi = useCallback((): void => {
    const probe = localProbe;
    const first = probe?.models[0];
    if (!probe?.available || !first) return;
    set('ai.provider', 'ollama', 'user');
    set('ai.baseUrl', probe.baseUrl, 'user');
    set('ai.model', first, 'user');
    notifyInfo(`Local AI connected: ${first}. No API key, no account, nothing leaves this machine.`, {
      source: 'Axiom AI',
    });
    layout.showAiPanel();
  }, [localProbe, set, layout]);

  const grantTrust = useCallback((): void => {
    if (trusting) return;
    setTrusting(true);
    void trust
      .trust()
      .catch((cause: unknown) =>
        notifyError('Could not trust this workspace', {
          source: 'Workspace',
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setTrusting(false));
  }, [trust, trusting]);

  const folderOpen = ws.rootPath !== null;
  const trusted = folderOpen && trust.trusted;
  const localReady = localProbe?.available === true && localProbe.models.length > 0;

  const steps: Step[] = [
    {
      id: 'folder',
      title: 'Open a folder',
      detail: folderOpen
        ? `Working in ${ws.rootName ?? ws.rootPath}.`
        : 'Everything — search, intelligence, agents — is scoped to the folder you choose.',
      state: folderOpen ? 'done' : 'todo',
      actionLabel: 'Open Folder',
      action: () => void ws.openFolder(),
    },
    {
      id: 'trust',
      title: 'Trust this workspace',
      detail: !folderOpen
        ? 'Open a folder first. Until you trust it, Axiom stays read-only.'
        : trusted
          ? 'Trusted. Agents, terminals, and debugging are enabled for this folder.'
          : 'Restricted Mode blocks code execution. Trust unlocks agents, terminals, and debugging — you can revoke it any time.',
      state: !folderOpen ? 'blocked' : trusted ? 'done' : 'todo',
      ...(folderOpen && !trusted
        ? { actionLabel: trusting ? 'Trusting\u2026' : 'Trust Folder', action: grantTrust }
        : {}),
      busy: trusting,
    },
    {
      id: 'ai',
      title: 'Connect AI — free, no API key',
      detail:
        aiReady === true
          ? `Ready: ${provider} · ${model}.`
          : aiReady === null
            ? 'Checking your saved provider credentials\u2026'
            : localReady
              ? `Ollama is running locally with ${localProbe.models.length} model(s). One click connects it — no key, no account, zero egress.`
              : probing
                ? 'Looking for a free local model server\u2026'
                : 'Bring your own key, or install Ollama for free local models that never leave this machine.',
      state: aiReady === true ? 'done' : 'todo',
      ...(aiReady !== true && localReady
        ? { actionLabel: 'Use free local AI', action: useLocalAi }
        : aiReady !== true
          ? { actionLabel: 'Open AI setup', action: () => layout.showAiPanel() }
          : {}),
    },
  ];

  const remaining = steps.filter((step) => step.state !== 'done').length;
  const dismissed = values[DISMISS_KEY] === true;

  // Don't project compiled defaults before persisted settings hydrate, and get out
  // of the way once the user is genuinely set up.
  if (!loaded || dismissed || remaining === 0) return null;

  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <div className="getting-started-head">
        <span className="getting-started-icon" aria-hidden="true">
          <SparkIcon size={16} />
        </span>
        <div>
          <h2 id="getting-started-title" className="getting-started-title">
            Get productive in about a minute
          </h2>
          <p className="getting-started-lead">
            {steps.length - remaining} of {steps.length} done. Each step reflects real state, not a
            tour.
          </p>
        </div>
        <button
          type="button"
          className="getting-started-dismiss"
          title="Hide this checklist (you can still reach everything from the command palette)"
          onClick={() => set(DISMISS_KEY, true, 'user')}
        >
          Dismiss
        </button>
      </div>

      <ol className="getting-started-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={`getting-started-step is-${step.state}`}>
            <span className="getting-started-marker" aria-hidden="true">
              {step.state === 'done' ? <CheckIcon size={14} /> : index + 1}
            </span>
            <div className="getting-started-body">
              <span className="getting-started-step-title">
                {step.title}
                <span className="sr-only">
                  {step.state === 'done' ? ' (complete)' : ' (not complete)'}
                </span>
              </span>
              <span className="getting-started-step-detail">{step.detail}</span>
            </div>
            {step.state !== 'done' && step.action && step.actionLabel ? (
              <button
                type="button"
                className="btn btn-primary getting-started-action"
                disabled={step.busy === true}
                onClick={step.action}
              >
                {step.actionLabel}
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="getting-started-foot">
        <ShieldIcon size={13} />
        Nothing runs and nothing is sent until you complete these steps. Trust is per folder and
        revocable.
      </p>
    </section>
  );
}
