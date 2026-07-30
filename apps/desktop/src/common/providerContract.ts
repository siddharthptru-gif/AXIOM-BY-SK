/**
 * Provider contract-test & fixture harness (Phase 146).
 *
 * PURE module (no I/O, no Electron). The adjudication core of the adapter
 * contract-test harness: given a RECORDED fixture's observations (how many chunks
 * streamed, whether usage was reported, tool-calls / reasoning seen, the normalized
 * error code for an error fixture), assert that a provider adapter honours the
 * CAPABILITIES it claims and maps errors to the canonical taxonomy. A fixture SUITE
 * rolls per-capability fixtures into a conformance verdict. The recorder/player + the
 * scheduled live refresh are the I/O-bound follow-up; this decides pass/fail.
 * Deterministic.
 */

export type Capability = 'streaming' | 'tools' | 'reasoning' | 'usage' | 'errorMapping';

export const CAPABILITIES: readonly Capability[] = [
  'streaming',
  'tools',
  'reasoning',
  'usage',
  'errorMapping',
];

/** The canonical, provider-agnostic error taxonomy adapters must map onto. */
export const ERROR_CODES: readonly string[] = [
  'rate_limit',
  'auth',
  'context_length',
  'invalid_request',
  'server',
  'network',
  'unknown',
];

export interface Observation {
  /** Number of streamed deltas seen (>1 proves incremental streaming). */
  streamedChunks: number;
  /** Whether the adapter reported token usage. */
  reportedUsage: boolean;
  /** Tool-call invocations observed. */
  toolCalls: number;
  /** Reasoning tokens observed (>0 proves reasoning surfaced). */
  reasoningTokens: number;
  /** For an error fixture, the normalized error code the adapter produced. */
  mappedErrorCode?: string;
}

export interface CapabilityCheck {
  capability: Capability;
  ok: boolean;
  reason: string;
}

/** Assert a single capability against an observation. */
export function checkCapability(cap: Capability, obs: Observation): CapabilityCheck {
  switch (cap) {
    case 'streaming':
      return {
        capability: cap,
        ok: obs.streamedChunks > 1,
        reason:
          obs.streamedChunks > 1
            ? `streamed ${obs.streamedChunks} chunks`
            : 'no incremental streaming observed (<=1 chunk)',
      };
    case 'usage':
      return {
        capability: cap,
        ok: obs.reportedUsage,
        reason: obs.reportedUsage ? 'usage reported' : 'no token usage reported',
      };
    case 'tools':
      return {
        capability: cap,
        ok: obs.toolCalls > 0,
        reason: obs.toolCalls > 0 ? `${obs.toolCalls} tool call(s)` : 'no tool calls observed',
      };
    case 'reasoning':
      return {
        capability: cap,
        ok: obs.reasoningTokens > 0,
        reason:
          obs.reasoningTokens > 0
            ? `${obs.reasoningTokens} reasoning tokens`
            : 'no reasoning tokens observed',
      };
    case 'errorMapping': {
      const code = obs.mappedErrorCode;
      const ok = code !== undefined && ERROR_CODES.includes(code);
      return {
        capability: cap,
        ok,
        reason: ok
          ? `mapped to '${code ?? ''}'`
          : `error not mapped to the canonical taxonomy (got ${code === undefined ? 'none' : `'${code}'`})`,
      };
    }
    default:
      return { capability: cap, ok: false, reason: 'unknown capability' };
  }
}

export interface ProviderContract {
  provider: string;
  /** Capabilities the adapter claims to support (only these are asserted). */
  claims: Capability[];
}

export interface ContractResult {
  provider: string;
  ok: boolean;
  checks: CapabilityCheck[];
  passed: Capability[];
  failed: Capability[];
  summary: string;
}

/** Check every claimed capability of a contract against one aggregate observation. */
export function checkContract(contract: ProviderContract, obs: Observation): ContractResult {
  const checks = contract.claims.map((c) => checkCapability(c, obs));
  const passed = checks.filter((c) => c.ok).map((c) => c.capability);
  const failed = checks.filter((c) => !c.ok).map((c) => c.capability);
  const ok = failed.length === 0 && checks.length > 0;
  const summary =
    checks.length === 0
      ? `${contract.provider}: no capabilities claimed.`
      : ok
        ? `${contract.provider}: PASS — all ${checks.length} claimed capabilities honoured.`
        : `${contract.provider}: FAIL — ${failed.length}/${checks.length} unmet (${failed.join(', ')}).`;
  return { provider: contract.provider, ok, checks, passed, failed, summary };
}

export interface Fixture {
  name: string;
  /** The single capability this fixture is recorded to exercise. */
  capability: Capability;
  observation: Observation;
}

export interface SuiteResult {
  provider: string;
  total: number;
  passed: number;
  failed: number;
  results: { name: string; capability: Capability; ok: boolean; reason: string }[];
  /** 0..1 fraction of fixtures that passed. */
  conformance: number;
  summary: string;
}

/** Run a fixture suite: each fixture must demonstrate the capability it targets. */
export function runFixtureSuite(provider: string, fixtures: readonly Fixture[]): SuiteResult {
  const results = fixtures.map((f) => {
    const chk = checkCapability(f.capability, f.observation);
    return { name: f.name, capability: f.capability, ok: chk.ok, reason: chk.reason };
  });
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const conformance = results.length === 0 ? 1 : Math.round((passed / results.length) * 100) / 100;
  const summary =
    results.length === 0
      ? `${provider}: no fixtures.`
      : `${provider}: ${passed}/${results.length} fixtures passed (${Math.round(conformance * 100)}% conformance).`;
  return { provider, total: results.length, passed, failed, results, conformance, summary };
}

export type StreamEventType = 'delta' | 'usage' | 'toolCall' | 'reasoning' | 'error';

export interface StreamEvent {
  type: StreamEventType;
  /** For 'delta' / 'reasoning': the emitted text. */
  text?: string;
  /** For 'reasoning': explicit token count (else the text length is used). */
  reasoningTokens?: number;
  /** For 'error': the normalized error code the adapter mapped the failure to. */
  errorCode?: string;
}

/**
 * Fold a RECORDED adapter event stream into an {@link Observation} — the pure core
 * of the fixture recorder. The live capture (subscribing to a real provider run and
 * persisting the events) is the I/O-bound half; this deterministically derives the
 * capability observations a fixture asserts against.
 */
export function observeFromEvents(events: readonly StreamEvent[]): Observation {
  let streamedChunks = 0;
  let reportedUsage = false;
  let toolCalls = 0;
  let reasoningTokens = 0;
  let mappedErrorCode: string | undefined;
  for (const ev of events) {
    switch (ev.type) {
      case 'delta':
        streamedChunks += 1;
        break;
      case 'usage':
        reportedUsage = true;
        break;
      case 'toolCall':
        toolCalls += 1;
        break;
      case 'reasoning':
        reasoningTokens += ev.reasoningTokens ?? (ev.text ? ev.text.length : 0);
        break;
      case 'error':
        if (ev.errorCode) mappedErrorCode = ev.errorCode;
        break;
    }
  }
  const obs: Observation = { streamedChunks, reportedUsage, toolCalls, reasoningTokens };
  if (mappedErrorCode !== undefined) obs.mappedErrorCode = mappedErrorCode;
  return obs;
}
