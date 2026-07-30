import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import { buildCompletionMessages, cleanCompletion } from '../../common/completion';

/**
 * Inline completion runner (Main, PRD Epoch G §129.1 / Phase 183). One-shot, non-
 * streamed completion through the normalized chat path (so it inherits the response
 * cache + egress gateway). Returns cleaned, insertable text. Read-only. Kept cheap
 * by a short prompt + line cap in cleanCompletion; the renderer debounces + caches.
 */
export interface CompleteCreds {
  provider: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKey: string;
  credentialRevision: string;
}

/** Recommended default model per provider when none is configured. */
export const DEFAULT_COMPLETION_MODELS: Record<string, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
};

const MAX_RAW_COMPLETION_CHARS = 64 * 1024;

async function accumulate(params: ChatParams, signal: AbortSignal): Promise<string> {
  let out = '';
  await chat(
    params,
    (delta) => {
      if (out.length >= MAX_RAW_COMPLETION_CHARS) return;
      out += delta.slice(0, MAX_RAW_COMPLETION_CHARS - out.length);
    },
    () => undefined,
    signal,
  );
  return out;
}

export async function completeCode(
  creds: CompleteCreds,
  prefix: string,
  suffix: string,
  language: string,
  signal: AbortSignal,
): Promise<string> {
  const { system, user } = buildCompletionMessages(prefix, suffix, language);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const raw = await accumulate({ ...creds, messages }, signal);
  return cleanCompletion(raw, prefix);
}
