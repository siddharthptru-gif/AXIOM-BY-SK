import type { ChatMessage } from '../../common/ipc';
import { chat, type ChatParams } from './ai';
import {
  buildCommitMessagePrompt,
  buildPrDescriptionPrompt,
  buildChangelogPrompt,
  cleanCommitMessage,
  cleanMarkdownReply,
} from '../../common/gitAi';

/**
 * Git AI runner (Main, PRD Epoch H §113.8 / Phase 231). One-shot generation through
 * the normalized chat path (inherits the response cache + egress gateway). Read-only
 * from Git's side — it only produces text the user reviews/edits before committing.
 */
export interface GitAiCreds {
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

async function run(creds: GitAiCreds, system: string, user: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const controller = new AbortController();
  return accumulate({ ...creds, messages }, controller.signal);
}

export async function generateCommitMessage(creds: GitAiCreds, diff: string): Promise<string> {
  const { system, user } = buildCommitMessagePrompt(diff);
  return cleanCommitMessage(await run(creds, system, user));
}

export async function generatePrDescription(
  creds: GitAiCreds,
  diff: string,
  title?: string,
): Promise<string> {
  const { system, user } = buildPrDescriptionPrompt(diff, title);
  return cleanMarkdownReply(await run(creds, system, user));
}

export async function generateChangelog(
  creds: GitAiCreds,
  commitSubjects: readonly string[],
): Promise<string> {
  const { system, user } = buildChangelogPrompt(commitSubjects);
  return cleanMarkdownReply(await run(creds, system, user));
}
