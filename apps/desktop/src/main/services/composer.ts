import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import { buildComposeMessages, parseEditPlan, type EditPlan } from '../../common/editPlan';

/**
 * Multi-file Composer runner (Main, PRD Epoch G §130 / Phase 193). Prompts the model
 * for a coordinated multi-file edit plan and parses it into planned edits. Reuses
 * the normalized chat path (egress gateway, cache, routing). It does NOT touch the
 * filesystem — the renderer reviews the plan and applies it through the Safe Edit
 * Engine (Phase 172), which snapshots first and applies all-or-nothing.
 */
export interface ComposeCreds {
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

export async function composeEdits(
  creds: ComposeCreds,
  instruction: string,
  context?: string,
): Promise<EditPlan> {
  const { system, user } = buildComposeMessages(instruction, context);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const controller = new AbortController();
  const raw = await accumulate({ ...creds, messages }, controller.signal);
  return { edits: parseEditPlan(raw), raw };
}
