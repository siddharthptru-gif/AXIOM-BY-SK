import {
  formatMentionBlock,
  requestedSpecialMentions,
  type SpecialMention,
} from '../../../common/mentions';
import { buildReviewHunks } from '../../../common/reviewSession';
import type { GitDiffMode } from '../../../common/ipc';
import type { Diagnostic } from '../state/diagnostics';
import { activeSelection } from '../editor/activeEditorBus';
import { recentTerminalOutput, recentTerminalTitle } from '../state/terminalOutputBus';

/**
 * Resolve chat `@mentions` into real context (T2.7).
 *
 * `@file` mentions already become attachments in the composer. This module handles
 * the non-file sources — selection, repo profile, git changes, terminal output,
 * problems — which were previously inserted as decorative text that the model could
 * not act on.
 *
 * Rules that keep this trustworthy:
 *  - Only sources the message actually names are collected. No implicit widening.
 *  - Every block is bounded, so one mention cannot dominate the request.
 *  - A source that is empty or unavailable says so explicitly rather than being
 *    silently dropped, so the model never invents what it could not see.
 *  - Resolution is best-effort per source: one failure never blocks the message.
 *  - The result is injected as UNTRUSTED content by the caller, exactly like
 *    workspace retrieval context — repository text is evidence, never instructions.
 */
const MAX_BLOCK_CHARS = 6_000;
const MAX_GIT_FILES = 12;
const MAX_PROBLEMS = 40;

export interface ResolvedMentions {
  /** Combined, labelled blocks ready to attach as one untrusted message. */
  text: string;
  /** Names of the sources that produced content, for the UI note. */
  included: string[];
  /** Names of the sources that were asked for but had nothing to give. */
  empty: string[];
}

function clip(text: string, max = MAX_BLOCK_CHARS): string {
  const trimmed = text.trimEnd();
  return trimmed.length > max
    ? `${trimmed.slice(0, max)}\n… (truncated at ${max} characters)`
    : trimmed;
}

function relTo(root: string | null, path: string): string {
  if (!root || !path.startsWith(root)) return path;
  return path
    .slice(root.length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
}

function resolveSelection(root: string | null): string {
  const selection = activeSelection();
  if (!selection || selection.text.trim().length === 0) return '';
  const where = `${relTo(root, selection.path)}:${selection.startLine}-${selection.endLine}`;
  return clip(`${where}\n\`\`\`${selection.language}\n${selection.text}\n\`\`\``);
}

function resolveTerminal(): string {
  const output = recentTerminalOutput();
  if (output.length === 0) return '';
  const title = recentTerminalTitle();
  return clip(`${title ? `Terminal: ${title}\n` : ''}\`\`\`\n${output}\n\`\`\``);
}

function resolveProblems(root: string | null, diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return '';
  const shown = diagnostics.slice(0, MAX_PROBLEMS);
  const lines = shown.map(
    (item) =>
      `${item.severity.toUpperCase()} ${relTo(root, item.path)}:${item.line}:${item.column} — ${
        item.message
      }${item.source ? ` (${item.source})` : ''}`,
  );
  const omitted = diagnostics.length - shown.length;
  if (omitted > 0) lines.push(`… ${omitted} more problem(s) not shown`);
  return clip(lines.join('\n'));
}

async function resolveRepo(root: string | null): Promise<string> {
  if (!root) return '';
  try {
    const profile = await window.axiom.core.project.understand(root);
    const parts = [
      `Name: ${profile.name ?? '(unnamed)'}`,
      `Files indexed: ${profile.totalFiles}`,
    ];
    if (profile.languages.length > 0) {
      parts.push(
        `Languages: ${profile.languages
          .slice(0, 8)
          .map((language) => `${language.name} (${language.files})`)
          .join(', ')}`,
      );
    }
    if (profile.frameworks.length > 0) parts.push(`Frameworks: ${profile.frameworks.join(', ')}`);
    if (profile.packageManagers.length > 0) {
      parts.push(`Package managers: ${profile.packageManagers.join(', ')}`);
    }
    if (profile.testFramework) parts.push(`Tests: ${profile.testFramework}`);
    if (profile.entryPoints.length > 0) {
      parts.push(`Entry points: ${profile.entryPoints.slice(0, 8).join(', ')}`);
    }
    if (profile.scripts.length > 0) {
      parts.push(
        `Scripts: ${profile.scripts
          .slice(0, 12)
          .map((script) => script.name)
          .join(', ')}`,
      );
    }
    if (profile.monorepo) {
      parts.push(`Monorepo workspaces: ${profile.workspaces.slice(0, 12).join(', ') || 'yes'}`);
    }
    return clip(parts.join('\n'));
  } catch {
    return '';
  }
}

/** Render a git comparison as changed lines only, so the block stays small. */
function renderPatch(original: string, modified: string): string {
  const { hunks } = buildReviewHunks(original, modified);
  if (hunks.length === 0) return '(no textual change)';
  const lines: string[] = [];
  for (const hunk of hunks) {
    lines.push(`@@ line ${hunk.newStart} @@`);
    for (const op of hunk.ops) {
      lines.push(`${op.op === 'add' ? '+' : '-'}${op.line}`);
    }
  }
  return lines.join('\n');
}

async function resolveGit(root: string | null): Promise<string> {
  if (!root) return '';
  try {
    const status = await window.axiom.git.status(root);
    const changed: Array<{ path: string; type: string; mode: GitDiffMode }> = [
      ...status.staged.map((entry) => ({
        path: entry.path,
        type: entry.type as string,
        mode: 'staged' as GitDiffMode,
      })),
      ...status.unstaged.map((entry) => ({
        path: entry.path,
        type: entry.type as string,
        mode: 'unstaged' as GitDiffMode,
      })),
    ];
    if (changed.length === 0) return '';
    const shown = changed.slice(0, MAX_GIT_FILES);
    const blocks: string[] = [
      `Branch: ${status.branch ?? '(detached)'} · ${changed.length} changed file(s)`,
    ];
    for (const entry of shown) {
      try {
        const diff = await window.axiom.git.diff(root, entry.path, entry.mode);
        blocks.push(
          `${entry.path} (${entry.type}, ${entry.mode})\n${clip(
            renderPatch(diff.original, diff.modified),
            1_500,
          )}`,
        );
      } catch {
        blocks.push(`${entry.path} (${entry.type}, ${entry.mode}) — diff unavailable`);
      }
    }
    if (changed.length > shown.length) {
      blocks.push(`… ${changed.length - shown.length} more changed file(s) not shown`);
    }
    return clip(blocks.join('\n\n'));
  } catch {
    return '';
  }
}

async function resolveOne(
  mention: SpecialMention,
  root: string | null,
  diagnostics: readonly Diagnostic[],
): Promise<string> {
  switch (mention.kind) {
    case 'selection':
      return resolveSelection(root);
    case 'terminal':
      return resolveTerminal();
    case 'problems':
      return resolveProblems(root, diagnostics);
    case 'repo':
      return resolveRepo(root);
    case 'git':
      return resolveGit(root);
    default:
      return '';
  }
}

/**
 * Resolve every special mention named in `text`. Returns empty `text` when the
 * message names none, so the caller can skip attaching anything.
 */
export async function resolveMentionContext(
  text: string,
  root: string | null,
  diagnostics: readonly Diagnostic[],
): Promise<ResolvedMentions> {
  const wanted = requestedSpecialMentions(text);
  if (wanted.length === 0) return { text: '', included: [], empty: [] };

  const blocks: string[] = [];
  const included: string[] = [];
  const empty: string[] = [];
  for (const mention of wanted) {
    let content = '';
    try {
      content = await resolveOne(mention, root, diagnostics);
    } catch {
      content = '';
    }
    if (content.length > 0) included.push(mention.name);
    else empty.push(mention.name);
    blocks.push(formatMentionBlock(mention, content));
  }
  return { text: blocks.join('\n\n'), included, empty };
}
