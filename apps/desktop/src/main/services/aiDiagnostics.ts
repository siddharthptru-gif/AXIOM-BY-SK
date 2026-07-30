import type {
  AiConnectionTestDiagnostic,
  AiCredentialStatus,
  AiDiagnosticsInput,
  AiDiagnosticsSnapshot,
} from '../../common/ipc';

const MAX_SNAPSHOTS = 64;
const snapshots = new Map<string, AiDiagnosticsSnapshot>();

function endpointParts(baseUrl: string): { host: string; path: string; key: string } {
  try {
    const url = new URL(baseUrl.trim());
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const host = url.host.toLowerCase();
    return { host, path, key: `${url.protocol.toLowerCase()}//${host}${path}` };
  } catch {
    return { host: '(invalid endpoint)', path: '/', key: baseUrl.trim().toLowerCase() };
  }
}

function keyOf(input: AiDiagnosticsInput): string {
  return `${input.provider}\u0000${input.model}\u0000${endpointParts(input.baseUrl).key}`;
}

function initial(input: AiDiagnosticsInput): AiDiagnosticsSnapshot {
  const endpoint = endpointParts(input.baseUrl);
  return {
    provider: input.provider,
    model: input.model,
    endpointHost: endpoint.host,
    endpointPath: endpoint.path,
    credentialStatus: 'missing',
    lastConnectionTest: null,
    lastRequestPhase: 'idle',
    lastSafeError: null,
    failoverUsed: false,
    responseFormat: null,
    updatedAt: Date.now(),
  };
}

function prune(): void {
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    snapshots.delete(oldest);
  }
}

export function getAiDiagnostics(input: AiDiagnosticsInput): AiDiagnosticsSnapshot {
  return snapshots.get(keyOf(input)) ?? initial(input);
}

export function updateAiDiagnostics(
  input: AiDiagnosticsInput,
  patch: Partial<AiDiagnosticsSnapshot>,
): AiDiagnosticsSnapshot {
  const current = getAiDiagnostics(input);
  const next: AiDiagnosticsSnapshot = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  snapshots.delete(keyOf(input));
  snapshots.set(keyOf(input), next);
  prune();
  return next;
}

export function recordAiConnectionTest(
  input: AiDiagnosticsInput,
  test: Omit<AiConnectionTestDiagnostic, 'at'>,
  credentialStatus: AiCredentialStatus,
): AiDiagnosticsSnapshot {
  return updateAiDiagnostics(input, {
    credentialStatus,
    lastConnectionTest: { ...test, at: Date.now() },
    lastRequestPhase: test.ok ? 'idle' : 'failed',
    lastSafeError: test.ok ? null : safeAiError(test.message),
  });
}

/**
 * Keep diagnostics useful without retaining provider bodies, URLs with queries,
 * credentials, prompts, or source text. Provider HTTP errors are normalized at
 * the adapter boundary; this is a final defense for local/network exceptions.
 *
 * The length cap bounds the string, it is not a privacy control — the adapter
 * already redacts and screens the provider's structured reason. It has room for
 * that reason plus Axiom's guidance and the retry suffix, which together exceeded
 * the previous 240-character cap and silently dropped the actionable part.
 */
const MAX_SAFE_ERROR_CHARS = 600;

export function safeAiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutUrls = raw.replace(/https?:\/\/[^\s)]+/gi, (value) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[endpoint]';
    }
  });
  return (
    withoutUrls
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, '[redacted credential]')
      .replace(/([?&](?:key|token|api[_-]?key)=)[^&#\s]+/gi, '$1[redacted]')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, MAX_SAFE_ERROR_CHARS) || 'Unknown AI request error.'
  );
}
