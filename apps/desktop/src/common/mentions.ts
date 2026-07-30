/**
 * Context attachment @-mentions (PRD Epoch G §128.2 / Phase 177). Pure helpers for
 * the chat composer: detect the `@token` the caret is currently in (to drive an
 * autocomplete), rank workspace files against the query, list the special context
 * sources (@selection, @repo, @git, …), and replace the active token on selection.
 * No I/O — unit-tested; the composer supplies the file list and applies the result.
 */
import type { WorkspaceFile } from './ipc';

export type MentionKind =
  'file' | 'folder' | 'symbol' | 'selection' | 'repo' | 'git' | 'terminal' | 'problems';

export interface SpecialMention {
  kind: MentionKind;
  name: string;
  description: string;
}

/** Non-file context sources offered in the mention menu. */
export const SPECIAL_MENTIONS: readonly SpecialMention[] = [
  { kind: 'selection', name: 'selection', description: 'The current editor selection' },
  { kind: 'repo', name: 'repo', description: 'Project profile: languages, frameworks, scripts' },
  { kind: 'git', name: 'git', description: 'Uncommitted git changes in this workspace' },
  { kind: 'terminal', name: 'terminal', description: 'Recent terminal output' },
  { kind: 'problems', name: 'problems', description: 'Current problems / diagnostics' },
];

/** Special-mention name → kind, for resolving tokens found in a sent message. */
const SPECIAL_BY_NAME: ReadonlyMap<string, SpecialMention> = new Map(
  SPECIAL_MENTIONS.map((mention) => [mention.name, mention]),
);

/**
 * The special context sources a message actually asks for, in menu order and
 * deduplicated. Anything that is not a known source is left alone — a stray
 * `@something` stays ordinary prose rather than silently pulling in context.
 */
export function requestedSpecialMentions(text: string): SpecialMention[] {
  const wanted = new Set<string>();
  for (const { token } of parseMentions(text)) {
    const mention = SPECIAL_BY_NAME.get(token.toLowerCase());
    if (mention) wanted.add(mention.name);
  }
  return SPECIAL_MENTIONS.filter((mention) => wanted.has(mention.name));
}

/**
 * Render one resolved source as a labelled block for the prompt. Empty content
 * becomes an explicit "not available" line so the model is never left guessing
 * whether a source was empty or simply failed.
 */
export function formatMentionBlock(mention: SpecialMention, content: string): string {
  const body = content.trim();
  return body.length > 0
    ? `@${mention.name} — ${mention.description}:\n${body}`
    : `@${mention.name}: not available (nothing to include).`;
}

export interface ActiveMention {
  /** Text typed after '@' (may be empty right after '@'). */
  query: string;
  /** Index of the '@'. */
  start: number;
  /** Caret index (end of the token). */
  end: number;
}

/**
 * If the caret sits inside an `@token`, return the token text + range. The '@' must
 * be at the start of the input or follow whitespace / an opening bracket, so email
 * addresses and mid-word '@' don't trigger the menu.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const upto = text.slice(0, Math.max(0, caret));
  const m = /@([\w.\-/]*)$/.exec(upto);
  if (!m) return null;
  const start = caret - m[0].length;
  const before = start > 0 ? text[start - 1]! : '';
  if (before !== '' && !/[\s([{]/.test(before)) return null;
  return { query: m[1] ?? '', start, end: caret };
}

/** All `@word` mentions in a message (for send-time resolution). */
export function parseMentions(text: string): { token: string; start: number; end: number }[] {
  const out: { token: string; start: number; end: number }[] = [];
  const re = /(^|[\s([{])@([\w.\-/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index + m[1]!.length;
    out.push({ token: m[2]!, start: at, end: at + 1 + m[2]!.length });
  }
  return out;
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

function scoreFile(file: WorkspaceFile, query: string): number {
  if (query === '') return 1;
  const name = file.name.toLowerCase();
  const rel = file.rel.toLowerCase();
  if (name.startsWith(query)) return 1000 - name.length;
  if (name.includes(query)) return 600 - name.length;
  if (rel.includes(query)) return 400 - rel.length;
  if (isSubsequence(query, rel)) return 200 - rel.length;
  return -1;
}

/** Rank workspace files against a query (name-prefix > name > path > subsequence). */
export function matchMentionFiles(
  query: string,
  files: readonly WorkspaceFile[],
  limit = 8,
): WorkspaceFile[] {
  const q = query.toLowerCase();
  if (q === '') return files.slice(0, limit);
  return files
    .map((f) => ({ f, s: scoreFile(f, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

/** Special mentions whose name starts with the query. */
export function matchSpecialMentions(query: string): SpecialMention[] {
  const q = query.toLowerCase();
  return SPECIAL_MENTIONS.filter((m) => m.name.startsWith(q));
}

/** Replace the active `@token` (start..end) with `replacement`. */
export function replaceActiveMention(
  text: string,
  active: ActiveMention,
  replacement: string,
): string {
  return text.slice(0, active.start) + replacement + text.slice(active.end);
}

/**
 * Trigger-parameterised variants, for composers that use a different sigil.
 *
 * The Build composer uses `#` for file references (matching the convention users
 * arrive with from other IDEs) while Ask keeps `@` for context sources. Both go
 * through the same tested matching logic rather than a second copy of it — a
 * divergence between the two would be invisible until one of them misbehaved.
 */

/** Sigils a composer may use to open the reference menu. */
export type MentionTrigger = '@' | '#';

/** Escape a trigger for use inside a character class / literal position. */
function triggerPattern(trigger: MentionTrigger): string {
  return trigger === '#' ? '#' : '@';
}

/**
 * As {@link activeMention}, for an arbitrary trigger. The trigger must start the
 * input or follow whitespace or an opening bracket, so `a#b` and an email address
 * never open the menu.
 */
export function activeMentionFor(
  text: string,
  caret: number,
  trigger: MentionTrigger,
): ActiveMention | null {
  const upto = text.slice(0, Math.max(0, caret));
  const matcher = new RegExp(`${triggerPattern(trigger)}([\\w.\\-/\\\\]*)$`);
  const m = matcher.exec(upto);
  if (!m) return null;
  const start = caret - m[0].length;
  const before = start > 0 ? (text[start - 1] ?? '') : '';
  if (before !== '' && !/[\s([{]/.test(before)) return null;
  return { query: m[1] ?? '', start, end: caret };
}

/** Every `#token` in a message, for send-time resolution. */
export function parseFileReferences(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s([{])#([\w.\-/\\]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[2];
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Turn `#path` references into an explicit instruction naming the exact files.
 *
 * The paths are named rather than their contents inlined: the agent already has a
 * `read_file` tool, so telling it WHICH files matter keeps the prompt small and
 * lets it read the current bytes instead of a snapshot that may already be stale.
 */
export function formatFileReferenceBlock(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const list = paths.map((path) => `- ${path}`).join('\n');
  return `Focus on these workspace files — read them before acting:\n${list}`;
}
