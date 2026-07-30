import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { aiSecretKey, type LocalModelProbe } from '../../../common/ipc';
import { defaultBaseUrl } from '../../../common/providers';
import {
  ROUTING_POLICIES,
  ROUTING_POLICY_LABELS,
  parseRoutingPolicy,
} from '../../../common/routing';
import { REASONING_EFFORTS, parseReasoningEffort } from '../../../common/reasoning';
import { parseBudgetEnforcement } from '../../../common/budgetGate';
import type { ProviderHealthSummary } from '../../../common/providerHealth';
import {
  parseThinkingVisibility,
  THINKING_VISIBILITIES,
  THINKING_VISIBILITY_LABELS,
} from '../../../common/thinking';
import { INLINE_PRIORITIES, parseInlinePriority } from '../../../common/nextEdit';
import { setInlineCompletionPriority } from '../editor/inlineCompletion';
import { setAiDockCommandHandler, type AiDockCommandRequest } from '../commands/commandBuses';
import { AUTONOMY_LEVELS, parseAutonomy, type AutonomyLevel } from '../../../common/approval';
import { useSettings } from '../settings/store';
import {
  getAiSettings,
  getCustomProvider,
  parseHeaders,
  MODEL_CATALOG,
  type AiProvider,
} from '../settings/schema';
import { PromptModal } from './Modal';
import { CustomProviderForm } from './CustomProviderForm';
import { ChatPanel } from './ChatPanel';
import { AgentPanel } from './AgentPanel';
import { ComposerPanel } from './ComposerPanel';
import { notifyError, notifyInfo } from '../notifications/bus';
import { AiIcon, CheckIcon, ChevronLeftIcon, SettingsIcon, ShieldIcon, WarningIcon } from './icons';

/**
 * Axiom AI panel (PRD Epoch F). Orchestrates the BYOK setup screen and the chat.
 * When the active provider is configured (a key for built-ins, or a base URL for
 * the Custom provider) it shows the chat; the gear returns to setup. Saved API
 * keys stay in Main's local secret store and are never read back here (INV-3).
 */
const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local, free)',
  custom: 'Custom (OpenAI-Compatible)',
};

const PROVIDERS: readonly AiProvider[] = [
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'custom',
];

const AI_MODES = ['chat', 'agent', 'composer'] as const;
type AiMode = (typeof AI_MODES)[number];

const AI_MODE_LABELS: Record<AiMode, string> = {
  chat: 'Ask',
  agent: 'Build',
  composer: 'Plan',
};

const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  manual: 'Manual — approve every action',
  guided: 'Guided — ask before writes, commands, network',
  autopilot: 'Autopilot — full trusted-folder flow; approve effects (default)',
};

function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AiView() {
  const { values, set } = useSettings();
  const ai = getAiSettings(values);
  const keyName = aiSecretKey(ai.provider);
  const credentialBaseUrl = ai.baseUrl.trim() || defaultBaseUrl(ai.provider);
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [credentialCheckFailed, setCredentialCheckFailed] = useState(false);
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const handleCredentialChange = useCallback(() => setCredentialEpoch((value) => value + 1), []);
  const [prompting, setPrompting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [mode, setMode] = useState<AiMode>('agent');
  const [agentCommandRequest, setAgentCommandRequest] = useState<AiDockCommandRequest | null>(null);
  const [chatActive, setChatActive] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const [composerActive, setComposerActive] = useState(false);
  const handleChatActivityChange = useCallback((active: boolean) => setChatActive(active), []);
  const handleAgentActivityChange = useCallback((active: boolean) => setAgentActive(active), []);
  const handleComposerActivityChange = useCallback(
    (active: boolean) => setComposerActive(active),
    [],
  );
  const workActive = chatActive || agentActive || composerActive;
  const activeWorkMode: AiMode | null = chatActive
    ? 'chat'
    : agentActive
      ? 'agent'
      : composerActive
        ? 'composer'
        : null;
  useEffect(
    () =>
      setAiDockCommandHandler((request) => {
        if (workActive && activeWorkMode !== 'agent') {
          const reason = 'Finish the active Ask or Plan operation before opening Build.';
          if (request.command === 'start-god-mode' && request.launch) {
            void window.axiom.godMode.jobs
              .control(request.launch.root, { id: request.launch.jobId, action: 'pause' })
              .then(() => request.acknowledge({ accepted: false, reason }))
              .catch((cause) =>
                request.acknowledge({
                  accepted: false,
                  reason: cause instanceof Error ? cause.message : reason,
                }),
              );
          } else {
            request.acknowledge({ accepted: false, reason });
          }
          notifyInfo(reason, { source: 'Axiom AI' });
          return;
        }
        setShowSetup(false);
        setMode('agent');
        setAgentCommandRequest(request);
      }),
    [activeWorkMode, workActive],
  );
  const handleChatRequestActivate = useCallback((): boolean => {
    if (workActive && activeWorkMode !== 'chat') {
      notifyInfo('Finish the active Build or Plan operation before opening Ask.', {
        source: 'Axiom AI',
      });
      return false;
    }
    setShowSetup(false);
    setMode('chat');
    return true;
  }, [activeWorkMode, workActive]);
  const modeTabs = useRef<Record<AiMode, HTMLButtonElement | null>>({
    chat: null,
    agent: null,
    composer: null,
  });
  const setupHeading = useRef<HTMLSpanElement | null>(null);

  // Provider health / circuit breaker (PRD Phases 167/168): poll the runtime circuit
  // state so the failover section can flag a tripped-open or recovering provider.
  const [health, setHealth] = useState<ProviderHealthSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void window.axiom.ai
        .providerHealth()
        .then((h) => {
          if (!cancelled) setHealth(h);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Free local AI: detect a loopback Ollama server so a user without any API key
  // can still use Ask, Build, and every agent with zero data leaving the machine.
  const [localModels, setLocalModels] = useState<LocalModelProbe | null>(null);
  const [detectingLocal, setDetectingLocal] = useState(false);
  const detectLocal = useCallback((): void => {
    setDetectingLocal(true);
    void window.axiom.ai
      .detectLocalModels()
      .then(setLocalModels)
      .catch(() => setLocalModels(null))
      .finally(() => setDetectingLocal(false));
  }, []);
  useEffect(() => {
    if (showSetup) detectLocal();
  }, [showSetup, detectLocal]);

  /** Switch to the detected local server in one click (no key, no egress). */
  const useLocalModels = useCallback(
    (probe: LocalModelProbe): void => {
      if (!probe.available) return;
      set('ai.provider', 'ollama', 'user');
      set('ai.baseUrl', probe.baseUrl, 'user');
      const firstModel = probe.models[0];
      if (firstModel) set('ai.model', firstModel, 'user');
      notifyInfo(
        firstModel
          ? `Axiom is now using the local model ${firstModel}. No API key, nothing leaves this machine.`
          : 'Axiom is now set to your local Ollama server. Install a model to start chatting.',
        { source: 'Axiom AI' },
      );
    },
    [set],
  );

  // Keep the inline-completion provider's priority in sync with the setting (Phase 184).
  useEffect(() => {
    setInlineCompletionPriority(parseInlinePriority(values['ai.completion.priority']));
  }, [values]);

  const refresh = useCallback(() => {
    const binding = { provider: ai.provider, baseUrl: credentialBaseUrl };
    void Promise.allSettled([
      window.axiom.secrets.has(keyName),
      window.axiom.secrets.has(keyName, binding),
    ]).then(([presence, authorization]) => {
      setKeyPresent(presence.status === 'fulfilled' ? presence.value : null);
      setKeySet(authorization.status === 'fulfilled' ? authorization.value : false);
      setCredentialCheckFailed(
        presence.status === 'rejected' || authorization.status === 'rejected',
      );
    });
  }, [ai.provider, credentialBaseUrl, credentialEpoch, keyName]);

  useEffect(() => {
    setKeyPresent(null);
    setKeySet(null);
    setCredentialCheckFailed(false);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (workActive) {
      setPrompting(false);
      setShowSetup(false);
    }
  }, [workActive]);

  const removeKey = (): void => {
    if (workActive) return;
    void window.axiom.secrets
      .delete(keyName)
      .then(() => {
        notifyInfo(`Removed ${PROVIDER_LABELS[ai.provider]} API key`, { source: 'Axiom AI' });
        handleCredentialChange();
        refresh();
      })
      .catch((e) =>
        notifyError('Could not remove API key', { source: 'Axiom AI', detail: detailOf(e) }),
      );
  };

  const openSetup = (): void => {
    if (workActive) return;
    setShowSetup(true);
    window.requestAnimationFrame(() => setupHeading.current?.focus());
  };

  const closeSetup = (): void => {
    setShowSetup(false);
    window.requestAnimationFrame(() => modeTabs.current[mode]?.focus());
  };

  const handleModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: AiMode,
  ): void => {
    const currentIndex = AI_MODES.indexOf(currentMode);
    let targetIndex: number;

    switch (event.key) {
      case 'ArrowLeft':
        targetIndex = (currentIndex - 1 + AI_MODES.length) % AI_MODES.length;
        break;
      case 'ArrowRight':
        targetIndex = (currentIndex + 1) % AI_MODES.length;
        break;
      case 'Home':
        targetIndex = 0;
        break;
      case 'End':
        targetIndex = AI_MODES.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextMode = AI_MODES[targetIndex] ?? currentMode;
    if (workActive && nextMode !== activeWorkMode) {
      if (activeWorkMode) modeTabs.current[activeWorkMode]?.focus();
      return;
    }
    setMode(nextMode);
    modeTabs.current[nextMode]?.focus();
  };

  // Built-ins require an endpoint-authorized key. Custom may be keyless only
  // when no stored credential exists; a legacy or differently bound key must be
  // re-entered or removed before the endpoint is considered ready. Ollama is a
  // loopback server that needs no key at all, so a selected model is enough.
  const configured =
    ai.provider === 'custom'
      ? ai.baseUrl.trim().length > 0 && (keyPresent === false || keySet === true)
      : ai.provider === 'ollama'
        ? ai.model.trim().length > 0
        : keySet === true;
  const connectionVersion = JSON.stringify([
    credentialEpoch,
    values['ai.fallbackProviders'] ?? '',
    values['ai.routingPolicy'] ?? 'manual',
  ]);

  if (configured) {
    const headers = ai.provider === 'custom' ? parseHeaders(getCustomProvider(values).headers) : {};
    const modelKey = ai.provider === 'custom' ? 'ai.custom.model' : 'ai.model';
    const connectionStatus =
      ai.provider === 'ollama'
        ? 'Local · free, no key, zero egress'
        : ai.provider !== 'custom' || keySet === true
          ? 'Configured · BYOK'
          : keyPresent === null || keySet === null
            ? 'Configured · checking credentials'
            : 'Configured · keyless endpoint';
    // Ollama models are discovered from the running server; keep the active one listed.
    const localOptions =
      localModels?.available && localModels.models.length > 0 ? localModels.models : [ai.model];
    const providerModelOptions =
      ai.provider === 'custom'
        ? getCustomProvider(values).models
        : ai.provider === 'ollama'
          ? localOptions
          : MODEL_CATALOG[ai.provider];

    return (
      <>
        <div className="ai-panel-wrap" hidden={showSetup}>
          <header className="chat-header ai-dock-header" aria-label="Axiom AI connection">
            <AiIcon size={18} />
            <div
              className="chat-model ai-dock-identity"
              title={`Axiom AI · ${PROVIDER_LABELS[ai.provider]} · ${ai.model}`}
            >
              <span className="ai-dock-title" role="heading" aria-level={2}>
                Axiom AI
              </span>{' '}
              <span className="ai-muted">
                {PROVIDER_LABELS[ai.provider]} · {ai.model}
              </span>
            </div>
            <div className="ai-mode" role="tablist" aria-label="Conversation mode">
              {AI_MODES.map((aiMode) => (
                <button
                  key={aiMode}
                  ref={(node) => {
                    modeTabs.current[aiMode] = node;
                  }}
                  id={`ai-mode-tab-${aiMode}`}
                  type="button"
                  role="tab"
                  aria-selected={mode === aiMode}
                  aria-controls={`ai-mode-panel-${aiMode}`}
                  tabIndex={mode === aiMode ? 0 : -1}
                  className={`ai-mode-btn${mode === aiMode ? ' is-on' : ''}`}
                  disabled={workActive && aiMode !== activeWorkMode}
                  onClick={() => {
                    if (!workActive || aiMode === activeWorkMode) setMode(aiMode);
                  }}
                  onKeyDown={(event) => handleModeKeyDown(event, aiMode)}
                >
                  {AI_MODE_LABELS[aiMode]}
                </button>
              ))}
            </div>
            <span className="ai-connected ai-dock-status" title={connectionStatus}>
              {ai.provider !== 'custom' || keySet === true ? (
                <CheckIcon size={14} />
              ) : (
                <ShieldIcon size={14} />
              )}{' '}
              {connectionStatus}
            </span>
            <div className="chat-header-actions">
              <button
                type="button"
                className="icon-btn"
                title="Provider Settings"
                aria-label="Provider Settings"
                disabled={workActive}
                onClick={openSetup}
              >
                <SettingsIcon size={16} />
              </button>
            </div>
          </header>

          <div
            id="ai-mode-panel-chat"
            className="ai-tabpanel"
            role="tabpanel"
            aria-labelledby="ai-mode-tab-chat"
            hidden={mode !== 'chat'}
          >
            <ChatPanel
              provider={ai.provider}
              model={ai.model}
              baseUrl={ai.baseUrl}
              headers={headers}
              connectionVersion={connectionVersion}
              forcedMode="ask"
              active={mode === 'chat' && !showSetup}
              onActivityChange={handleChatActivityChange}
              onRequestActivate={handleChatRequestActivate}
              modelOptions={providerModelOptions}
              onModelChange={(m) => {
                if (!workActive) set(modelKey, m, 'user');
              }}
              onOpenSettings={openSetup}
              groundedStrict={values['ai.grounded.strict'] === true}
              thinkingVisibility={parseThinkingVisibility(values['ai.thinking.visibility'])}
              dailyBudgetUsd={
                typeof values['ai.dailyBudgetUsd'] === 'number'
                  ? (values['ai.dailyBudgetUsd'] as number)
                  : 0
              }
              budgetEnforcement={parseBudgetEnforcement(values['ai.budgetEnforcement'])}
            />
          </div>

          <div
            id="ai-mode-panel-agent"
            className="ai-tabpanel"
            role="tabpanel"
            aria-labelledby="ai-mode-tab-agent"
            hidden={mode !== 'agent'}
          >
            <AgentPanel
              provider={ai.provider}
              model={ai.model}
              modelOptions={providerModelOptions}
              baseUrl={ai.baseUrl}
              headers={headers}
              approvalMode={parseAutonomy(values['ai.approval.autonomy'])}
              onModelChange={(nextModel) => {
                if (!workActive) set(modelKey, nextModel, 'user');
              }}
              onApprovalModeChange={(nextMode) => set('ai.approval.autonomy', nextMode, 'user')}
              onActivityChange={handleAgentActivityChange}
              commandRequest={agentCommandRequest}
              active={mode === 'agent' && !showSetup}
              dailyBudgetUsd={
                typeof values['ai.dailyBudgetUsd'] === 'number'
                  ? (values['ai.dailyBudgetUsd'] as number)
                  : 0
              }
              budgetEnforcement={parseBudgetEnforcement(values['ai.budgetEnforcement'])}
            />
          </div>

          <div
            id="ai-mode-panel-composer"
            className="ai-tabpanel"
            role="tabpanel"
            aria-labelledby="ai-mode-tab-composer"
            hidden={mode !== 'composer'}
          >
            <ComposerPanel
              provider={ai.provider}
              model={ai.model}
              baseUrl={ai.baseUrl}
              headers={headers}
              onActivityChange={handleComposerActivityChange}
            />
          </div>
        </div>
        {showSetup ? renderSetup() : null}
      </>
    );
  }

  function renderSetup() {
    return (
      <div className="ai-view">
        <header className="ai-field ai-setup-header">
          <div className="settings-row-title">
            <AiIcon size={18} />
            <span
              ref={setupHeading}
              id="ai-setup-title"
              className="settings-title"
              role="heading"
              aria-level={2}
              tabIndex={-1}
            >
              Axiom AI setup
            </span>
          </div>
          <p className="ai-hint">
            Choose your provider, routing, and safeguards before working in Ask, Build, or Plan.
          </p>
          {configured ? (
            <span className="ai-connected">
              <CheckIcon size={14} /> Provider configured
            </span>
          ) : null}
        </header>

        {workActive ? (
          <div className="ai-hint ai-provider-live" role="status" aria-live="polite">
            AI work is in progress. Provider, model, routing, and behavior settings are locked until
            it finishes; Back, export, and sync remain available.
          </div>
        ) : null}

        <aside className="ai-probe ai-trust-summary" aria-label="Trust summary">
          <div className="ai-probe-msg">
            <ShieldIcon size={14} /> BYOK security
          </div>
          <div className="ai-probe-detail">
            Stored API keys stay in Axiom's local secret store and are never read back into this UI.
            Requests can include workspace code, conversation history, rules, memory, and system
            instructions. Enabled context is assembled on this device, then sent according to your
            routing and failover settings; an eligible fallback provider may receive it if the
            primary fails before streaming begins.
          </div>
        </aside>

        <section
          className={`ai-form ai-setup-section ai-local-card${
            localModels?.available ? ' is-available' : ''
          }`}
          aria-labelledby="ai-local-section-title"
        >
          <h3 id="ai-local-section-title" className="settings-group-title">
            Free local AI {'\u00B7'} no API key
          </h3>
          <p className="ai-hint" aria-live="polite">
            {detectingLocal
              ? 'Looking for a local model server\u2026'
              : (localModels?.message ??
                'Axiom can run entirely on your machine with Ollama \u2014 no API key, no subscription, and no code leaving this device.')}
          </p>
          {localModels?.available ? (
            <>
              {localModels.models.length > 0 ? (
                <div className="ai-local-models" aria-label="Installed local models">
                  {localModels.models.slice(0, 12).map((name) => (
                    <span key={name} className="ai-local-model">
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="ai-local-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={workActive || localModels.models.length === 0}
                  onClick={() => useLocalModels(localModels)}
                >
                  <CheckIcon size={14} /> Use local models (free)
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={detectingLocal}
                  onClick={detectLocal}
                >
                  Re-scan
                </button>
              </div>
            </>
          ) : (
            <div className="ai-local-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={detectingLocal}
                onClick={detectLocal}
              >
                {detectingLocal ? 'Scanning\u2026' : 'Scan for local models'}
              </button>
            </div>
          )}
        </section>

        <section className="ai-form ai-setup-section" aria-labelledby="ai-provider-section-title">
          <h3 id="ai-provider-section-title" className="settings-group-title">
            Provider and routing
          </h3>

          <div className="ai-field">
            <label className="ai-label" htmlFor="ai-provider">
              Provider
            </label>
            <select
              id="ai-provider"
              className="ai-select"
              disabled={workActive}
              value={ai.provider}
              onChange={(e) => set('ai.provider', e.target.value, 'user')}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>

          <div className="ai-field">
            <label className="ai-label" htmlFor="ai-fallbacks">
              Failover providers
            </label>
            <input
              id="ai-fallbacks"
              className="ai-select"
              type="text"
              disabled={workActive}
              spellCheck={false}
              placeholder="e.g. openai, gemini"
              value={
                typeof values['ai.fallbackProviders'] === 'string'
                  ? (values['ai.fallbackProviders'] as string)
                  : ''
              }
              onChange={(e) => set('ai.fallbackProviders', e.target.value, 'user')}
            />
            <p className="ai-hint">
              Comma-separated providers to try (in order) if the primary fails, using each
              one&apos;s saved key. Failover happens only before a reply starts streaming.
            </p>
            <div className="ai-provider-health" aria-live="polite">
              {health
                .filter((h) => h.state !== 'closed')
                .map((h) => (
                  <p key={h.provider} className="ai-hint">
                    <WarningIcon size={14} /> {h.provider}:{' '}
                    {h.state === 'open'
                      ? `circuit open${
                          h.cooldownRemainingMs > 0
                            ? ` — retrying in ${Math.ceil(h.cooldownRemainingMs / 1000)}s`
                            : ''
                        }`
                      : 'recovering (half-open)'}
                  </p>
                ))}
            </div>
          </div>

          <div className="ai-field">
            <label className="ai-label" htmlFor="ai-routing">
              Routing policy
            </label>
            <select
              id="ai-routing"
              className="ai-select"
              disabled={workActive}
              value={parseRoutingPolicy(values['ai.routingPolicy'])}
              onChange={(e) => set('ai.routingPolicy', e.target.value, 'user')}
            >
              {ROUTING_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {ROUTING_POLICY_LABELS[p]}
                </option>
              ))}
            </select>
            <p className="ai-hint">
              How Axiom orders the primary and failover providers for each request. Manual keeps
              your order; others optimize for cost, latency, or quality, or prefer local models.
            </p>
          </div>
        </section>

        <section className="ai-form ai-setup-section" aria-labelledby="ai-behavior-section-title">
          <h3 id="ai-behavior-section-title" className="settings-group-title">
            Behavior and context
          </h3>

          <div className="ai-field">
            <label className="ai-label" htmlFor="ai-autonomy">
              Agent autonomy
            </label>
            <select
              id="ai-autonomy"
              className="ai-select"
              disabled={workActive}
              value={parseAutonomy(values['ai.approval.autonomy'])}
              onChange={(e) => set('ai.approval.autonomy', e.target.value, 'user')}
            >
              {AUTONOMY_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {AUTONOMY_LABELS[lvl]}
                </option>
              ))}
            </select>
            <p className="ai-hint">
              Every execution, mutation, Git/network write, and MCP action requires an exact
              Main-native approval. The selected permission changes read-only planning cadence, and
              workspace edits are snapshotted for recovery from the Checkpoints panel.
            </p>
          </div>

          <div className="ai-field">
            <label className="ai-label">Inline completion</label>
            <label className="ai-reasoning-toggle">
              <input
                type="checkbox"
                disabled={workActive}
                checked={values['ai.completion.enabled'] === true}
                onChange={(e) => set('ai.completion.enabled', e.target.checked, 'user')}
              />
              Suggest ghost-text completions as you type (Tab to accept)
            </label>
            {values['ai.completion.enabled'] === true ? (
              <select
                className="ai-select"
                aria-label="Completion priority"
                disabled={workActive}
                value={parseInlinePriority(values['ai.completion.priority'])}
                onChange={(e) => set('ai.completion.priority', e.target.value, 'user')}
              >
                {INLINE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p === 'inline'
                      ? 'Prefer ghost text'
                      : 'Prefer IntelliSense (suppress after . / @)'}
                  </option>
                ))}
              </select>
            ) : null}
            <p className="ai-hint">
              Requests a short AI completion when you pause typing (debounced + cached). Off by
              default because it calls your provider on each pause; your API key is billed per
              request.
            </p>
          </div>

          <div className="ai-field">
            <label className="ai-label">Reasoning</label>
            <label className="ai-reasoning-toggle">
              <input
                type="checkbox"
                disabled={workActive}
                checked={values['ai.reasoning.enabled'] === true}
                onChange={(e) => set('ai.reasoning.enabled', e.target.checked, 'user')}
              />
              Enable on capable models (o-series, Claude thinking, Gemini 2.5)
            </label>
            {values['ai.reasoning.enabled'] === true ? (
              <select
                className="ai-select"
                disabled={workActive}
                value={parseReasoningEffort(values['ai.reasoning.effort'])}
                onChange={(e) => set('ai.reasoning.effort', e.target.value, 'user')}
              >
                {REASONING_EFFORTS.map((ef) => (
                  <option key={ef} value={ef}>
                    {ef.charAt(0).toUpperCase() + ef.slice(1)} effort
                  </option>
                ))}
              </select>
            ) : null}
            <p className="ai-hint">
              Lets reasoning models think before answering (higher quality, more tokens and cost).
              Non-reasoning models ignore it.
            </p>
            <label className="ai-label ai-thinking-label" htmlFor="ai-thinking-vis">
              Show reasoning (Thinking mode)
            </label>
            <select
              id="ai-thinking-vis"
              className="ai-select"
              disabled={workActive}
              value={parseThinkingVisibility(values['ai.thinking.visibility'])}
              onChange={(e) => set('ai.thinking.visibility', e.target.value, 'user')}
            >
              {THINKING_VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {THINKING_VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
            <p className="ai-hint">
              When a model returns its reasoning, show it as a collapsible block above the answer,
              with the reasoning-token cost.
            </p>
          </div>

          <div className="ai-field">
            <label className="ai-label">Grounded answers</label>
            <label className="ai-reasoning-toggle">
              <input
                type="checkbox"
                disabled={workActive}
                checked={values['ai.grounded.strict'] === true}
                onChange={(e) => set('ai.grounded.strict', e.target.checked, 'user')}
              />
              Strict grounding in Ask mode — warn when an answer cites no files
            </label>
            <p className="ai-hint">
              In Ask mode, flags a substantive answer that doesn&apos;t cite any workspace file, so
              you know it may not be grounded in your code. A warning only — never blocks the
              answer.
            </p>
          </div>
        </section>

        <section className="ai-form ai-setup-section" aria-labelledby="ai-connection-section-title">
          <h3 id="ai-connection-section-title" className="settings-group-title">
            Connection
          </h3>

          {ai.provider === 'custom' ? (
            <CustomProviderForm locked={workActive} onCredentialChange={handleCredentialChange} />
          ) : (
            <>
              <div className="ai-field">
                <span className="ai-label">Model</span>
                <span className="ai-model" title={ai.model}>
                  {ai.model}
                </span>
              </div>

              <div className="ai-key-status" role="status" aria-live="polite">
                {credentialCheckFailed && keyPresent !== true ? (
                  <span className="ai-error">
                    <WarningIcon size={14} /> Could not verify the local credential store.
                  </span>
                ) : keyPresent === null || keySet === null ? (
                  <span className="ai-muted">{'Checking key\u2026'}</span>
                ) : keySet ? (
                  <span className="ai-connected">
                    <CheckIcon size={14} /> BYOK configured for this endpoint
                  </span>
                ) : keyPresent ? (
                  <span className="ai-error">
                    <WarningIcon size={14} /> Saved key is not authorized for this endpoint.
                    Re-enter or remove it.
                  </span>
                ) : (
                  <span className="ai-muted">No API key set</span>
                )}
              </div>

              <div className="ai-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={workActive}
                  onClick={() => setPrompting(true)}
                >
                  {keyPresent ? 'Re-enter API Key' : `Connect ${PROVIDER_LABELS[ai.provider]}`}
                </button>
                {keyPresent ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={workActive}
                    onClick={removeKey}
                  >
                    Remove Key
                  </button>
                ) : null}
              </div>

              <p className="ai-hint">
                Your API key is stored locally in Axiom's secret store and is never displayed after
                saving. It is sent only in direct requests to {PROVIDER_LABELS[ai.provider]}.
              </p>
            </>
          )}
        </section>

        <section className="ai-form ai-setup-section" aria-labelledby="ai-data-section-title">
          <h3 id="ai-data-section-title" className="settings-group-title">
            Data and sync
          </h3>

          <div className="ai-field">
            <span className="ai-label">Your data</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                void window.axiom.dataExport
                  .save()
                  .then((res) => {
                    if (res) notifyInfo(`Exported your data to ${res.name}`, { source: 'Axiom' });
                  })
                  .catch((e) =>
                    notifyError('Could not export data', { source: 'Axiom', detail: detailOf(e) }),
                  );
              }}
            >
              Export my data (JSON)
            </button>
            <p className="ai-hint">
              Saves a local copy of your settings, memory, custom agents, feature flags, and audit
              summary. Never includes API keys or code.
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                void window.axiom.sync
                  .snapshot()
                  .then(() => window.axiom.sync.flush())
                  .then((res) =>
                    notifyInfo(
                      res.reason ?? `Synced \u2014 ${res.flushed} change(s) pushed to the cloud.`,
                      {
                        source: 'Axiom',
                      },
                    ),
                  )
                  .catch((e) =>
                    notifyError('Could not sync preferences', {
                      source: 'Axiom',
                      detail: detailOf(e),
                    }),
                  );
              }}
            >
              Back up preferences for sync
            </button>
            <p className="ai-hint">
              Queues your settings locally (last-writer-wins), then pushes/pulls via your Supabase
              account when signed in. Cross-device sync needs the one-time table setup in
              docs/SUPABASE_SYNC_SETUP.md; until then it stays a local backup and never leaves the
              device.
            </p>
          </div>
        </section>

        {configured ? (
          <nav className="ai-actions" aria-label="Return to AI modes">
            <button type="button" className="btn btn-ghost" onClick={closeSetup}>
              <ChevronLeftIcon size={16} /> Back to Chat
            </button>
          </nav>
        ) : null}

        {prompting ? (
          <PromptModal
            title={`${PROVIDER_LABELS[ai.provider]} API Key`}
            label="Paste your API key"
            placeholder={'sk-\u2026'}
            password
            confirmLabel="Save"
            onSubmit={async (key) => {
              if (workActive) {
                setPrompting(false);
                return;
              }
              try {
                await window.axiom.secrets.set(keyName, key, {
                  provider: ai.provider,
                  baseUrl: credentialBaseUrl,
                });
                notifyInfo(`Saved ${PROVIDER_LABELS[ai.provider]} API key`, { source: 'Axiom AI' });
                handleCredentialChange();
                refresh();
              } catch (e) {
                notifyError('Could not save API key', { source: 'Axiom AI', detail: detailOf(e) });
              }
              setPrompting(false);
            }}
            onClose={() => setPrompting(false)}
          />
        ) : null}
      </div>
    );
  }

  return renderSetup();
}
