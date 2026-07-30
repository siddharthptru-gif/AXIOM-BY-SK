/**
 * Git AI core (PRD Epoch H §113.8 / Phase 231). Pure prompt builders + cleaners for
 * AI in the Git flow: a commit message from a staged diff, a PR description, and a
 * changelog from commit subjects. No I/O — the Main runner streams through the chat
 * path; the SCM view inserts the result (always editable). Smoke-tested.
 */
import { computeLineDiff } from './lineDiff';
const MAX_DIFF_CHARS = 12000;

/** Clamp a diff so a huge staged change can't blow the model's context. */
export function clampDiff(diff: string): string {
  return diff.length <= MAX_DIFF_CHARS
    ? diff
    : `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated for length)`;
}

export interface StagedFileDiff {
  path: string;
  original: string;
  modified: string;
}

/**
 * Assemble a compact unified-ish diff from per-file before/after content (reuses
 * the shared line-diff). Only changed lines are emitted, with a header per file.
 */
export function buildDiffText(files: readonly StagedFileDiff[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const ops = computeLineDiff(f.original, f.modified);
    const changed = ops.filter((o) => o.op !== 'eq');
    if (changed.length === 0) continue;
    const body = changed.map((o) => `${o.op === 'add' ? '+' : '-'}${o.line}`).join('\n');
    parts.push(`--- a/${f.path}\n+++ b/${f.path}\n${body}`);
  }
  return parts.join('\n\n');
}

const COMMIT_SYSTEM = [
  'You write high-quality Git commit messages from a staged diff.',
  'Follow Conventional Commits: a `type(scope): subject` header in the imperative mood,',
  '<= 72 characters, no trailing period. Add a short body ONLY if it adds real information',
  '(what/why, not how). Output ONLY the commit message — no code fences, no preamble.',
].join(' ');

export function buildCommitMessagePrompt(diff: string): { system: string; user: string } {
  return {
    system: COMMIT_SYSTEM,
    user: `Write a commit message for this staged diff:\n\n\`\`\`diff\n${clampDiff(diff)}\n\`\`\``,
  };
}

const PR_SYSTEM = [
  'You write clear pull-request descriptions from a diff.',
  'Structure: a one-line summary, then "## Summary" (bullet points of the changes),',
  '"## Testing" (how it was or should be verified), and "## Notes" if relevant.',
  'Be concise and factual. Output Markdown only — no code fences around the whole thing.',
].join(' ');

export function buildPrDescriptionPrompt(
  diff: string,
  title?: string,
): { system: string; user: string } {
  const head = title && title.trim().length > 0 ? `Proposed title: ${title.trim()}\n\n` : '';
  return {
    system: PR_SYSTEM,
    user: `${head}Write a PR description for this diff:\n\n\`\`\`diff\n${clampDiff(diff)}\n\`\`\``,
  };
}

const CHANGELOG_SYSTEM = [
  'You write a concise changelog from a list of commit subjects.',
  'Group entries under Added / Changed / Fixed / Removed as appropriate, as short bullet points,',
  'in the past tense, user-facing where possible. Output Markdown only.',
].join(' ');

export function buildChangelogPrompt(commitSubjects: readonly string[]): {
  system: string;
  user: string;
} {
  const list = commitSubjects
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 200)
    .map((s) => `- ${s}`)
    .join('\n');
  return {
    system: CHANGELOG_SYSTEM,
    user: `Write a changelog from these commits:\n\n${list}`,
  };
}

/** Extract a fenced block's body, if the model wrapped the reply despite instructions. */
function stripFences(text: string): string {
  const m = /^```[\w+#.-]*\n?([\s\S]*?)```\s*$/.exec(text.trim());
  return m ? (m[1] ?? '') : text;
}

/**
 * Clean a commit message: unwrap fences, drop a leading "Commit message:" style
 * label, strip surrounding quotes, and trim. Preserves the subject/body structure.
 */
export function cleanCommitMessage(raw: string): string {
  let text = stripFences(raw).trim();
  text = text.replace(/^(commit message|message)\s*:\s*/i, '');
  // Strip wrapping quotes/backticks around a single-line message.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

/** Clean a PR description / changelog: unwrap an outer fence, trim. */
export function cleanMarkdownReply(raw: string): string {
  return stripFences(raw).trim();
}
