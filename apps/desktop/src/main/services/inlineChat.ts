import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import {
  buildInlineChatMessages,
  cleanInlineChatAnswer,
  type InlineChatParams,
} from '../../common/inlineChat';

/**
 * Inline chat runner (Main, PRD Epoch G §129.4 / Phase 188). One-shot, non-streamed
 * local Q&A through the normalized chat path (inherits the response cache + egress
 * gateway). Read-only — it only answers; escalation to an edit goes through the
 * inline-edit action (Phase 187).
 */
export interface InlineChatCreds {
  provider: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKey: string;
  credentialRevision: string;
}

async function accumulate(params: ChatParams, signal: AbortSignal): Promise<string> {
  let out = '';
  await chat(
    params,
    (d) => (out += d),
    () => undefined,
    signal,
  );
  return out;
}

export async function askInline(creds: InlineChatCreds, params: InlineChatParams): Promise<string> {
  const { system, user } = buildInlineChatMessages(params);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const controller = new AbortController();
  const raw = await accumulate({ ...creds, messages }, controller.signal);
  return cleanInlineChatAnswer(raw);
}
