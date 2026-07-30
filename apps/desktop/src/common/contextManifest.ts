/**
 * Context manifest + cost footer core (PRD Epoch G §150 / Phase 181). Pure helpers
 * that turn "what the chat actually sent" into an inspectable manifest (system
 * prompt, attachments, auto-context sources, long-term memory, conversation
 * history — each with an estimated token cost) and format the per-turn footer
 * (model · tokens · cost · latency). No I/O — the renderer builds the manifest at
 * send time from data it already has, and renders these. Unit-smoke-tested.
 */

/** Rough token estimate (~4 chars/token) — matches the context builder's heuristic. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Token estimate from a character count (for parts whose text we don't re-hold). */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export type ManifestKind = 'system' | 'attachment' | 'context' | 'memory' | 'history';

/** One line in the "what was sent" manifest, with its estimated token cost. */
export interface ManifestEntry {
  kind: ManifestKind;
  label: string;
  detail?: string;
  tokens: number;
}

/** A single auto-context file included for grounding (shown under the manifest). */
export interface ManifestSource {
  rel: string;
  startLine: number;
  endLine: number;
  reason: string;
}

/** The full per-turn manifest: token-costed entries + the context file breakdown. */
export interface ContextManifest {
  entries: ManifestEntry[];
  sources: ManifestSource[];
  totalTokens: number;
  truncated: boolean;
}

/** The parts the chat composer assembled for a turn, before formatting to wire messages. */
export interface ManifestInput {
  systemPrompt: string;
  attachments: ReadonlyArray<{ rel: string; chars: number }>;
  context?: {
    sources: ReadonlyArray<{ rel: string; startLine: number; endLine: number; reason: string }>;
    tokensEstimated: number;
    truncated: boolean;
  };
  memoryChars?: number;
  history: { count: number; chars: number };
}

/** Assemble the manifest from the composed parts (token totals stay accurate). */
export function buildManifest(input: ManifestInput): ContextManifest {
  const entries: ManifestEntry[] = [];

  if (input.systemPrompt.trim().length > 0) {
    entries.push({
      kind: 'system',
      label: 'System prompt',
      tokens: estimateTokens(input.systemPrompt),
    });
  }

  for (const a of input.attachments) {
    entries.push({
      kind: 'attachment',
      label: a.rel,
      detail: `${a.chars.toLocaleString()} chars`,
      tokens: estimateTokensFromChars(a.chars),
    });
  }

  const sources: ManifestSource[] = [];
  if (input.context && input.context.sources.length > 0) {
    const n = input.context.sources.length;
    entries.push({
      kind: 'context',
      label: `Workspace context (${n} ${n === 1 ? 'file' : 'files'})`,
      tokens: input.context.tokensEstimated,
      ...(input.context.truncated ? { detail: 'trimmed to token budget' } : {}),
    });
    for (const s of input.context.sources) {
      sources.push({ rel: s.rel, startLine: s.startLine, endLine: s.endLine, reason: s.reason });
    }
  }

  if (input.memoryChars && input.memoryChars > 0) {
    entries.push({
      kind: 'memory',
      label: 'Long-term memory',
      tokens: estimateTokensFromChars(input.memoryChars),
    });
  }

  if (input.history.count > 0) {
    entries.push({
      kind: 'history',
      label: `Conversation history (${input.history.count} ${input.history.count === 1 ? 'message' : 'messages'})`,
      tokens: estimateTokensFromChars(input.history.chars),
    });
  }

  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  return { entries, sources, totalTokens, truncated: input.context?.truncated ?? false };
}

/** One-line summary of a manifest — "N items · ~T tokens". */
export function summarizeManifest(m: ContextManifest): string {
  const n = m.entries.length;
  return `${n} ${n === 1 ? 'item' : 'items'} \u00B7 ~${m.totalTokens.toLocaleString()} tokens${
    m.truncated ? ' (trimmed)' : ''
  }`;
}

/** Format an estimated USD cost compactly (more precision for tiny amounts). */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const decimals = usd >= 0.01 ? 3 : usd >= 0.001 ? 4 : 6;
  const trimmed = usd.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  return `$${trimmed}`;
}

/** Parts of a finished turn's footer. All optional — only present pieces render. */
export interface FooterParts {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  latencyMs?: number;
}

/**
 * Compose the per-turn footer: model · ↑input ↓output · $cost · latency. Only the
 * parts that are present are shown (PRD Phase 181: model/tokens/cost/latency).
 */
export function formatFooter(parts: FooterParts): string {
  const out: string[] = [];
  if (parts.model && parts.model.length > 0) out.push(parts.model);
  if (parts.inputTokens !== undefined && parts.outputTokens !== undefined) {
    out.push(`\u2191${parts.inputTokens} \u2193${parts.outputTokens}`);
  }
  if (parts.costUsd !== undefined && parts.costUsd !== null) out.push(formatCost(parts.costUsd));
  if (parts.latencyMs !== undefined) out.push(`${(parts.latencyMs / 1000).toFixed(1)}s`);
  return out.join(' \u00B7 ');
}
