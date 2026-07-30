import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import {
  buildInlineEditMessages,
  cleanInlineEdit,
  type InlineEditParams,
} from '../../common/inlineEdit';

/**
 * Inline edit runner (Main, PRD Epoch G §129.3 / Phase 187). One-shot, non-streamed
 * rewrite of a selected region through the normalized chat path (so it inherits the
 * response cache + egress gateway). Returns cleaned replacement text. Read-only from
 * the model's side; the renderer applies the edit through Monaco (undoable) and
 * snapshots first, so it is fully reversible + reviewable.
 */
export interface InlineEditCreds {
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

export async function editSelection(
  creds: InlineEditCreds,
  params: InlineEditParams,
): Promise<string> {
  const { system, user } = buildInlineEditMessages(params);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const controller = new AbortController();
  const raw = await accumulate({ ...creds, messages }, controller.signal);
  return cleanInlineEdit(raw);
}
