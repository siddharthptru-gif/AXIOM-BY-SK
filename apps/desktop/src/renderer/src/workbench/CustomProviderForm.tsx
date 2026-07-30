import { useCallback, useEffect, useState } from 'react';
import { aiSecretKey, type AiConnectionInput } from '../../../common/ipc';
import { useSettings } from '../settings/store';
import { getCustomProvider, parseHeaders } from '../settings/schema';
import { validateProviderAdapter } from '../../../common/sdkDescriptor';
import { sanitizeAiHeaders } from '../../../common/headerSafety';
import { notifyError, notifyInfo } from '../notifications/bus';
import { AiIcon, CheckIcon, ShieldIcon, WarningIcon } from './icons';

/**
 * Custom OpenAI-compatible provider configuration (PRD Epoch F). Lets the user
 * connect any OpenAI-compatible endpoint (LiteLLM, vLLM, LocalAI, LM Studio,
 * Ollama's OpenAI endpoint, gateways, self-hosted servers, …). The API key is
 * stored by Main's local secret store and only ever sent to the configured
 * endpoint; Test Connection and Fetch Models are proxied through Main so the key
 * never appears in the renderer's network logs.
 */
interface Probe {
  ok: boolean;
  message: string;
  detail?: string;
}

const CUSTOM_KEY = aiSecretKey('custom');

function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CustomProviderForm({
  locked,
  onCredentialChange,
}: {
  locked: boolean;
  onCredentialChange: () => void;
}) {
  const { values, set } = useSettings();
  const stored = getCustomProvider(values);

  const [name, setName] = useState(stored.name);
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl);
  const [model, setModel] = useState(stored.model);
  const [headers, setHeaders] = useState(stored.headers);
  // Empty means "leave the stored key unchanged" only when that key is
  // authorized for the Base URL currently shown in the form.
  const [apiKey, setApiKey] = useState('');
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [keyAuthorized, setKeyAuthorized] = useState<boolean | null>(null);
  const [credentialCheckFailed, setCredentialCheckFailed] = useState(false);
  const [credentialCheckEpoch, setCredentialCheckEpoch] = useState(0);
  const [models, setModels] = useState<string[]>(stored.models);
  const [busy, setBusy] = useState<'test' | 'fetch' | 'save' | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<{ ok: boolean; errors: string[] } | null>(null);
  const disabled = locked || busy !== null;

  const invalidateProbe = (): void => {
    setProbe(null);
    setDescriptor(null);
  };

  const refreshKey = useCallback(() => {
    setCredentialCheckEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    setKeyPresent(null);
    setKeyAuthorized(null);
    setCredentialCheckFailed(false);
    void Promise.allSettled([
      window.axiom.secrets.has(CUSTOM_KEY),
      window.axiom.secrets.has(CUSTOM_KEY, {
        provider: 'custom',
        baseUrl: baseUrl.trim(),
      }),
    ]).then(([presence, authorization]) => {
      if (!active) return;
      setKeyPresent(presence.status === 'fulfilled' ? presence.value : null);
      setKeyAuthorized(authorization.status === 'fulfilled' ? authorization.value : false);
      setCredentialCheckFailed(
        presence.status === 'rejected' || authorization.status === 'rejected',
      );
    });
    return () => {
      active = false;
    };
  }, [baseUrl, credentialCheckEpoch]);

  const validateHeaders = (): boolean => {
    const raw = headers.trim();
    if (!raw) {
      setHeadersError(null);
      return true;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setHeadersError('Headers must be a JSON object, e.g. {"X-Org": "acme"}.');
        return false;
      }
      const sanitized = sanitizeAiHeaders(parsed);
      const credentialHeader = sanitized.rejectedNames[0] ?? null;
      if (credentialHeader) {
        setHeadersError(
          `${credentialHeader} is a credential-bearing header. Use the API Key field for credentials.`,
        );
        return false;
      }
      setHeadersError(null);
      return true;
    } catch {
      setHeadersError('Headers must be valid JSON.');
      return false;
    }
  };

  /**
   * Fetch Models omits the model so a dead saved model cannot block discovering a
   * working one; Test/Save include it so the probe verifies the exact model that
   * Ask and Build will send.
   */
  const buildInput = (includeModel = false): AiConnectionInput => ({
    baseUrl: baseUrl.trim(),
    apiKey,
    headers: parseHeaders(headers),
    ...(includeModel && model.trim() ? { model: model.trim() } : {}),
  });

  const canProbeWithCurrentCredential = (): boolean => {
    if (apiKey.trim().length > 0 || keyPresent !== true || keyAuthorized === true) return true;
    setProbe({
      ok: false,
      message: 'Saved API key is not authorized for this Base URL.',
      detail: 'Re-enter the key to authorize this endpoint, or remove it to use a keyless server.',
    });
    return false;
  };

  const testConnection = (): void => {
    if (disabled) return;
    if (!baseUrl.trim()) {
      setProbe({ ok: false, message: 'Base URL is required.' });
      return;
    }
    if (!validateHeaders() || !canProbeWithCurrentCredential()) return;
    setBusy('test');
    setProbe(null);
    void window.axiom.ai
      .testConnection(buildInput(true))
      .then(setProbe)
      .catch((e) => setProbe({ ok: false, message: 'Test failed', detail: detailOf(e) }))
      .finally(() => setBusy(null));
  };

  const fetchModels = (): void => {
    if (disabled) return;
    if (!baseUrl.trim()) {
      setProbe({ ok: false, message: 'Base URL is required.' });
      return;
    }
    if (!validateHeaders() || !canProbeWithCurrentCredential()) return;
    setBusy('fetch');
    setProbe(null);
    void window.axiom.ai
      .fetchModels(buildInput())
      .then((res) => {
        if (!res.ok) {
          setProbe({
            ok: false,
            message: 'Could not fetch models',
            ...(res.message ? { detail: res.message } : {}),
          });
          return;
        }
        setModels(res.models);
        if (res.models.length === 0) {
          setProbe({ ok: false, message: 'No models returned — enter a model name manually.' });
          return;
        }
        setProbe({ ok: true, message: `Found ${res.models.length} model(s).` });
        const first = res.models[0];
        if (!model && first) setModel(first);
      })
      .catch((e) => setProbe({ ok: false, message: 'Could not fetch models', detail: detailOf(e) }))
      .finally(() => setBusy(null));
  };

  const save = (): void => {
    if (disabled) return;
    if (!name.trim()) {
      setProbe({ ok: false, message: 'Provider Name is required.' });
      return;
    }
    if (!baseUrl.trim()) {
      setProbe({ ok: false, message: 'Base URL is required.' });
      return;
    }
    if (!model.trim()) {
      setProbe({ ok: false, message: 'Default Model is required.' });
      return;
    }
    if (!validateHeaders()) return;
    if (apiKey.trim().length === 0) {
      if (keyPresent === null || keyAuthorized === null) {
        setProbe({ ok: false, message: 'Wait for the saved credential check to finish.' });
        return;
      }
      if (keyPresent && !keyAuthorized) {
        setProbe({
          ok: false,
          message: 'The saved API key cannot be reused for this Base URL.',
          detail:
            'Re-enter the key to authorize this endpoint, or remove it before saving a keyless connection.',
        });
        return;
      }
    }

    setBusy('save');
    setProbe(null);
    void (async () => {
      const tested = await window.axiom.ai.testConnection(buildInput(true));
      if (!tested.ok) {
        setProbe({
          ok: false,
          message: 'Connection must pass before this provider can be saved.',
          detail: tested.detail || tested.message,
        });
        return;
      }
      if (apiKey.trim().length > 0) {
        await window.axiom.secrets.set(CUSTOM_KEY, apiKey, {
          provider: 'custom',
          baseUrl: baseUrl.trim(),
        });
        setApiKey('');
        onCredentialChange();
        refreshKey();
      }
      set('ai.custom.name', name.trim(), 'user');
      set('ai.custom.baseUrl', baseUrl.trim(), 'user');
      set('ai.custom.model', model.trim(), 'user');
      set('ai.custom.headers', headers.trim(), 'user');
      set('ai.custom.models', JSON.stringify(models), 'user');
      set('ai.provider', 'custom', 'user');
      setProbe({ ok: true, message: 'Custom provider tested and saved.' });
      notifyInfo('Saved custom provider', { source: 'Axiom AI' });
    })()
      .catch((cause) => {
        setProbe({
          ok: false,
          message: 'Could not validate or save the custom provider.',
          detail: detailOf(cause),
        });
        notifyError('Could not save custom provider', {
          source: 'Axiom AI',
          detail: detailOf(cause),
        });
      })
      .finally(() => setBusy(null));
  };

  const validateDescriptor = (): void => {
    if (disabled) return;
    // Validate the configured custom provider against the public provider-adapter SDK
    // contract (PRD Phase 246). The plugin SDK ships this same descriptor schema, so a
    // config that passes here would load as a first-class adapter.
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const modelList = model.trim() ? [model.trim()] : models;
    const res = validateProviderAdapter({
      id: slug,
      displayName: name.trim(),
      family: 'custom',
      auth: apiKey.trim().length > 0 || keyAuthorized === true ? 'apiKey' : 'none',
      models: modelList,
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      capabilities: { streaming: true },
    });
    setDescriptor({ ok: res.ok, errors: res.errors });
    notifyInfo(
      res.ok
        ? 'Custom provider is a valid SDK provider-adapter descriptor.'
        : `Provider descriptor has ${res.errors.length} issue(s).`,
      { source: 'Axiom AI' },
    );
  };

  const cancel = (): void => {
    const s = getCustomProvider(values);
    setName(s.name);
    setBaseUrl(s.baseUrl);
    setModel(s.model);
    setHeaders(s.headers);
    setModels(s.models);
    setApiKey('');
    setProbe(null);
    setHeadersError(null);
    setDescriptor(null);
    refreshKey();
  };

  const removeKey = (): void => {
    if (disabled) return;
    void window.axiom.secrets
      .delete(CUSTOM_KEY)
      .then(() => {
        notifyInfo('Removed API key', { source: 'Axiom AI' });
        onCredentialChange();
        refreshKey();
      })
      .catch((e) =>
        notifyError('Could not remove API key', { source: 'Axiom AI', detail: detailOf(e) }),
      );
  };

  const endpointConfigured = baseUrl.trim().length > 0;
  const busyMessage =
    busy === 'test'
      ? 'Testing connection…'
      : busy === 'fetch'
        ? 'Fetching models…'
        : busy === 'save'
          ? 'Saving custom provider…'
          : '';

  return (
    <section
      className="ai-form"
      aria-labelledby="custom-provider-title"
      aria-describedby="cp-connection-summary cp-security-summary cp-credential-summary"
    >
      <header className="ai-field ai-provider-header">
        <div className="settings-row-title">
          <AiIcon size={16} />
          <span id="custom-provider-title" className="settings-title" role="heading" aria-level={4}>
            Custom provider connection
          </span>
        </div>
        <p className="ai-hint">
          Configure and verify an OpenAI-compatible endpoint before using it across Axiom AI.
        </p>
      </header>

      <aside className="ai-probe ai-provider-summary" aria-label="Connection and security summary">
        <div className="ai-probe-msg">
          {endpointConfigured ? <CheckIcon size={14} /> : <WarningIcon size={14} />}{' '}
          <span id="cp-connection-summary">
            Connection:{' '}
            {endpointConfigured
              ? 'endpoint configured; use Test Connection to verify it.'
              : 'a Base URL is required.'}
          </span>
        </div>
        <div id="cp-security-summary" className="ai-probe-detail">
          <ShieldIcon size={14} /> Security: saved API keys stay in Axiom's local secret store and
          are never read back into this form.
        </div>
        <div
          id="cp-credential-summary"
          className={
            credentialCheckFailed || (keyPresent === true && keyAuthorized === false)
              ? 'ai-probe-detail ai-error'
              : 'ai-probe-detail'
          }
          role={
            credentialCheckFailed || (keyPresent === true && keyAuthorized === false)
              ? 'alert'
              : 'status'
          }
          aria-live="polite"
        >
          {credentialCheckFailed ? (
            <WarningIcon size={14} />
          ) : keyAuthorized === true ? (
            <CheckIcon size={14} />
          ) : keyPresent === true ? (
            <WarningIcon size={14} />
          ) : (
            <ShieldIcon size={14} />
          )}{' '}
          Credential status:{' '}
          {credentialCheckFailed
            ? keyPresent === true
              ? 'a saved key exists but could not be authorized; re-enter or remove it.'
              : 'the local credential store could not be verified.'
            : keyPresent === null || keyAuthorized === null
              ? 'checking for a saved key.'
              : keyAuthorized
                ? 'the saved key is authorized for this Base URL.'
                : keyPresent
                  ? 'the saved key is legacy or bound elsewhere; re-enter or remove it.'
                  : 'no saved key; keys are optional for local servers.'}
        </div>
      </aside>

      {locked ? (
        <div className="ai-hint ai-provider-live" role="status" aria-live="polite">
          Custom provider settings are locked while AI work is active. Stop it or wait for it to
          finish before changing this connection.
        </div>
      ) : null}

      <div className="ai-field">
        <label className="ai-label" htmlFor="cp-name">
          Provider Name
        </label>
        <input
          id="cp-name"
          className="ai-input"
          value={name}
          disabled={disabled}
          placeholder="My Gateway"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
            setDescriptor(null);
          }}
        />
      </div>

      <div className="ai-field">
        <label className="ai-label" htmlFor="cp-base">
          Base URL
        </label>
        <input
          id="cp-base"
          className="ai-input"
          value={baseUrl}
          disabled={disabled}
          placeholder="https://host:port/v1"
          spellCheck={false}
          autoComplete="off"
          aria-describedby="cp-connection-summary"
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setKeyAuthorized(null);
            setModels([]);
            invalidateProbe();
          }}
        />
      </div>

      <div className="ai-field">
        <label className="ai-label" htmlFor="cp-key">
          API Key{' '}
          {keyPresent ? (
            <span className={keyAuthorized ? 'ai-connected' : 'ai-error'}>
              {keyAuthorized ? <CheckIcon size={14} /> : <WarningIcon size={14} />}{' '}
              {keyAuthorized ? 'saved for this endpoint' : 're-entry required'}
            </span>
          ) : null}
        </label>
        <input
          id="cp-key"
          className="ai-input"
          type="password"
          value={apiKey}
          disabled={disabled}
          placeholder={
            keyAuthorized
              ? '\u2022\u2022\u2022\u2022\u2022 (unchanged for this endpoint)'
              : keyPresent
                ? 'Re-enter key to authorize this Base URL'
                : 'sk-\u2026 (optional for local servers)'
          }
          spellCheck={false}
          autoComplete="off"
          aria-describedby="cp-security-summary cp-credential-summary"
          onChange={(e) => {
            setApiKey(e.target.value);
            invalidateProbe();
          }}
        />
      </div>

      <div className="ai-field">
        <label className="ai-label" htmlFor="cp-model">
          Default Model
        </label>
        {models.length > 0 ? (
          <select
            className="ai-select"
            value={models.includes(model) ? model : ''}
            disabled={disabled}
            onChange={(e) => {
              setModel(e.target.value);
              setDescriptor(null);
            }}
          >
            <option value="">{'Select a model\u2026'}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : null}
        <input
          id="cp-model"
          className="ai-input"
          value={model}
          disabled={disabled}
          placeholder="Enter the provider's model ID"
          spellCheck={false}
          autoComplete="off"
          aria-required="true"
          onChange={(e) => {
            setModel(e.target.value);
            setDescriptor(null);
          }}
        />
      </div>

      <div className="ai-field">
        <label className="ai-label" htmlFor="cp-headers">
          Custom Headers (optional)
        </label>
        <textarea
          id="cp-headers"
          className="ai-textarea"
          value={headers}
          disabled={disabled}
          placeholder={'{"X-Org": "acme"}'}
          spellCheck={false}
          rows={2}
          aria-invalid={headersError !== null}
          aria-describedby={
            headersError ? 'cp-headers-guidance cp-headers-error' : 'cp-headers-guidance'
          }
          onChange={(e) => {
            setHeaders(e.target.value);
            setModels([]);
            invalidateProbe();
          }}
        />
        <p id="cp-headers-guidance" className="ai-hint">
          Custom headers are ordinary settings and must not contain Authorization,
          Proxy-Authorization, X-API-Key, or other credentials. Use the API Key field for secrets.
        </p>
        {headersError ? (
          <div id="cp-headers-error" className="ai-error" role="alert">
            <WarningIcon size={14} /> {headersError}
          </div>
        ) : null}
      </div>

      <div className="ai-btn-row" aria-busy={busy !== null}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          onClick={testConnection}
        >
          {busy === 'test' ? 'Testing\u2026' : 'Test Connection'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={disabled} onClick={fetchModels}>
          {busy === 'fetch' ? 'Fetching\u2026' : 'Fetch Models'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          onClick={validateDescriptor}
          title="Validate this config against the plugin SDK's provider-adapter contract (PRD Phase 246)"
        >
          Validate descriptor
        </button>
      </div>

      <div className="ai-hint ai-provider-live" role="status" aria-live="polite" aria-atomic="true">
        {busyMessage}
      </div>

      {probe ? (
        <div
          className={`ai-probe ${probe.ok ? 'ai-probe-ok' : 'ai-probe-err'}`}
          role={probe.ok ? 'status' : 'alert'}
          aria-live={probe.ok ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <div className="ai-probe-msg">
            {probe.ok ? <CheckIcon size={14} /> : <WarningIcon size={14} />} {probe.message}
          </div>
          {probe.detail ? <div className="ai-probe-detail">{probe.detail}</div> : null}
        </div>
      ) : null}

      {descriptor ? (
        <div
          className={`ai-probe ${descriptor.ok ? 'ai-probe-ok' : 'ai-probe-err'}`}
          role={descriptor.ok ? 'status' : 'alert'}
          aria-live={descriptor.ok ? 'polite' : 'assertive'}
          aria-atomic="true"
        >
          <div className="ai-probe-msg">
            {descriptor.ok ? <CheckIcon size={14} /> : <WarningIcon size={14} />}{' '}
            {descriptor.ok
              ? 'Valid provider-adapter descriptor (SDK contract).'
              : 'Provider descriptor validation failed:'}
          </div>
          {descriptor.errors.length > 0 ? (
            <ul className="ai-probe-details">
              {descriptor.errors.map((er, i) => (
                <li key={`desc-${i}`} className="ai-probe-detail">
                  {er}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="ai-btn-row" aria-busy={busy !== null}>
        <button type="button" className="btn btn-primary" disabled={disabled} onClick={save}>
          {busy === 'save' ? 'Saving\u2026' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={cancel}>
          Cancel
        </button>
        {keyPresent ? (
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={removeKey}>
            Remove Key
          </button>
        ) : null}
      </div>

      <p className="ai-hint">
        Works with any OpenAI-compatible API (LiteLLM, vLLM, LocalAI, LM Studio, Ollama, gateways,
        self-hosted). Your saved key stays in the local secret store and is sent only to this
        endpoint.
      </p>
    </section>
  );
}
