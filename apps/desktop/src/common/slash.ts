/**
 * Slash commands (PRD Epoch G §128.4 / Phase 180). Pure registry + parser +
 * autocomplete matcher + expander that turns a typed `/command args` into the
 * actual prompt sent to the model (reusing the versioned prompt-template registry
 * in prompts.ts). No I/O — unit-tested. The chat composer renders the matches and
 * expands on send.
 */
import { renderTemplate } from './prompts';

export interface SlashCommand {
  name: string;
  title: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'explain', title: '/explain', description: 'Explain the selected code or a topic' },
  { name: 'fix', title: '/fix', description: 'Find and fix bugs in the code' },
  { name: 'tests', title: '/tests', description: 'Generate tests for the code' },
  { name: 'docs', title: '/docs', description: 'Write documentation / docstrings' },
  { name: 'review', title: '/review', description: 'Review a diff or code for issues' },
  { name: 'plan', title: '/plan', description: 'Draft a step-by-step plan (no code yet)' },
  { name: 'search', title: '/search', description: 'Find where something is implemented' },
];

export interface ParsedSlash {
  name: string;
  args: string;
}

/** Parse `/command rest…` → { name, args }, or null when the text is not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  const m = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: m[2] ?? '' };
}

/**
 * Autocomplete: while the user is still typing the command word (`/`, `/ex`, …,
 * no space yet), return the commands whose name starts with what's typed.
 */
export function matchSlashCommands(input: string): SlashCommand[] {
  const m = /^\/([a-zA-Z]*)$/.exec(input);
  if (!m) return [];
  const prefix = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export interface SlashContext {
  lang?: string;
  framework?: string;
}

/**
 * Expand a slash command into the prompt to send. Non-slash text and unknown
 * commands are returned unchanged, so ordinary messages are never altered.
 */
export function expandSlash(input: string, ctx: SlashContext = {}): string {
  const parsed = parseSlash(input);
  if (!parsed) return input;
  const known = SLASH_COMMANDS.some((c) => c.name === parsed.name);
  if (!known) return input;
  const args = parsed.args.trim();
  const lang = ctx.lang ?? '';
  switch (parsed.name) {
    case 'explain':
      return renderTemplate('explain', { lang, depth: 'normal', code: args });
    case 'fix':
      return renderTemplate('fix', { lang, code: args });
    case 'tests':
      return renderTemplate('tests', { framework: ctx.framework ?? '', lang, code: args });
    case 'docs':
      return renderTemplate('docs', { lang, code: args });
    case 'review':
      return renderTemplate('review', { diff: args });
    case 'plan':
      return `Create a detailed, step-by-step implementation plan for the following. Do not write code yet — outline the approach, files to touch, and risks.\n\n${args}`;
    case 'search':
      return `Search the workspace and explain where the following is implemented, citing files:\n\n${args}`;
    default:
      return input;
  }
}
