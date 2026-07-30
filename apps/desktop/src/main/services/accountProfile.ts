import { app } from 'electron';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import type { AccountProfileInfo } from '../../common/ipc';

export type { AccountProfileInfo };

/**
 * Per-account data isolation.
 *
 * Every local store — conversations, Build run history, recent folders, workspace
 * trust, settings, memory, secrets, the audit log — resolved its path from
 * `app.getPath('userData')`. Roughly thirty-five separate helpers did so
 * independently, which meant signing in as a different Google account showed the
 * previous account's projects and chats.
 *
 * Retrofitting an account id into thirty-five path helpers would be thirty-five
 * chances to miss one, and every missed store leaks data across accounts. So the
 * binding happens ONCE, at the only place that governs all of them: the userData
 * path itself is repointed at `profiles/<accountKey>` before any store is touched.
 * Every existing helper becomes account-scoped with no edit at all, and no future
 * store can accidentally escape the isolation.
 *
 * Two things must NOT move, or the app would forget who is signed in and could never
 * find its way back to an account's data:
 *
 *   - `auth-store.enc`  — the encrypted Supabase session
 *   - `active-profile.json` — the pointer naming the account bound at last start
 *
 * Both stay at the real userData root, which is captured before the redirect.
 *
 * The directory name is a hash, never the email or the raw user id: a folder listing
 * of someone's machine should not enumerate the accounts they have used.
 *
 * Switching accounts relaunches AXIOM. The alternative — reopening thirty-five live
 * stores mid-session — is precisely how half-old/half-new state bugs happen, and a
 * restart is both honest and verifiable.
 */
const log = rootLogger.child('account-profile');

const POINTER_FILE = 'active-profile.json';
const PROFILES_DIR = 'profiles';
/** Profile used before anyone signs in. The login gate keeps it nearly empty. */
const GUEST_KEY = 'guest';
/** Written once a profile has taken ownership of pre-isolation data. */
const ADOPTION_MARKER = '.axiom-profile-adopted';

interface ActiveProfilePointer {
  /** Opaque directory name for the account. Never an email or a raw user id. */
  accountKey: string;
  /** Supabase user id, so a returning session is matched rather than guessed. */
  userId: string | null;
  at: number;
}

/**
 * AXIOM-owned state that predates isolation, adopted by the first real account so an
 * upgrade does not look like data loss.
 *
 * An explicit allowlist, not "everything at the root": Electron keeps its own
 * `Cache`, `GPUCache`, `Local Storage`, `Crashpad` and similar directories there, and
 * moving those would break the installation rather than migrate it.
 *
 * Two AXIOM-owned directories are deliberately absent because both are caches that cost
 * nothing to rebuild: `updates/` holds a re-downloadable installer, and
 * `extension-registry/` holds public marketplace metadata that is one round trip away.
 * Carrying either into a profile would copy bulk to preserve nothing.
 */
const LEGACY_ENTRIES: readonly string[] = [
  'agent-runs.json',
  'ai-conversations.json',
  'ai-spend.json',
  'audit-log.jsonl',
  'command-consent.json',
  'crash-journal.json',
  'custom-agents.json',
  'editor-state.json',
  'execution-consent.json',
  'extension-state.json',
  'feature-flags-cache.json',
  'global-rules.json',
  'keybindings.json',
  'layout.json',
  'mcp-servers.json',
  'memory.json',
  'profile-preferences-transaction.json',
  'prompts.json',
  'recent-folders.json',
  'recovery-crashes.json',
  'secrets.json',
  'settings.json',
  'telemetry-buffer.json',
  'workflows.json',
  'workspace-trust.json',
  'write-consent.json',
  'extensions',
  'god-mode',
  'registry',
  'snapshots',
];

/** The real userData root, captured before any redirect can move it. */
let rootUserData: string | null = null;
/** The profile key bound for this process, or null before `bindActiveProfile`. */
let boundKey: string | null = null;

/**
 * Capture and return the real userData root.
 *
 * Called before the redirect, so later callers still reach the unmovable root even
 * though `app.getPath('userData')` now answers with the profile directory.
 */
export function rootUserDataPath(): string {
  if (rootUserData === null) rootUserData = app.getPath('userData');
  return rootUserData;
}

/** Idempotent, and safe to call first thing at startup. */
export function captureRootUserData(): void {
  rootUserDataPath();
}

/**
 * Directory name for an account.
 *
 * A salted digest of the user id: stable across sessions, but not reversible into an
 * email, and not a value an attacker can precompute from a guessed address alone.
 */
export function profileKeyForUserId(userId: string | null): string {
  const trimmed = typeof userId === 'string' ? userId.trim() : '';
  if (trimmed.length === 0) return GUEST_KEY;
  return createHash('sha256')
    .update(`axiom-account-profile:${trimmed}`, 'utf-8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * A pointer is only honoured if it names a key this module could have produced.
 * Without this, a hand-edited pointer could aim the userData path anywhere on disk.
 */
function isSafeProfileKey(value: unknown): value is string {
  return typeof value === 'string' && (value === GUEST_KEY || /^[0-9a-f]{32}$/.test(value));
}

function pointerPath(): string {
  return join(rootUserDataPath(), POINTER_FILE);
}

function readPointer(): ActiveProfilePointer | null {
  let raw: string;
  try {
    raw = readFileSync(pointerPath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!isSafeProfileKey(record.accountKey)) return null;
    return {
      accountKey: record.accountKey,
      userId: typeof record.userId === 'string' ? record.userId : null,
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
    };
  } catch {
    return null;
  }
}

/** Written atomically: a truncated pointer would strand an account's data. */
function writePointer(pointer: ActiveProfilePointer): void {
  const target = pointerPath();
  const temporary = join(
    rootUserDataPath(),
    `.${POINTER_FILE}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    mkdirSync(rootUserDataPath(), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is already gone.
    }
    log.warn('Could not record the active account profile', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Move pre-isolation state into this profile, once.
 *
 * Only entries that do NOT already exist in the profile are moved, so an interrupted
 * adoption can be re-run without overwriting newer per-account state. A rename that
 * fails is logged and skipped rather than aborting the whole startup: losing one
 * store's history is recoverable, refusing to launch is not.
 */
function adoptLegacyData(profileDirectory: string): void {
  const marker = join(profileDirectory, ADOPTION_MARKER);
  if (existsSync(marker)) return;
  const root = rootUserDataPath();
  let adopted = 0;
  for (const entry of LEGACY_ENTRIES) {
    const from = join(root, entry);
    const to = join(profileDirectory, entry);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
      adopted += 1;
    } catch (error) {
      log.warn('Could not adopt existing local data into the account profile', {
        entry,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf-8');
  } catch {
    // Without the marker adoption is simply attempted again; the existence checks
    // above keep that harmless.
  }
  if (adopted > 0) log.info('Existing local data adopted by this account profile', { adopted });
}

/**
 * Point userData at the active account's profile directory.
 *
 * MUST run before any service reads or writes a store — that is the whole basis of
 * the isolation. Returns the bound directory.
 */
export function bindActiveProfile(): string {
  const root = rootUserDataPath();
  const pointer = readPointer();
  const key = pointer ? pointer.accountKey : GUEST_KEY;
  const directory = join(root, PROFILES_DIR, key);
  mkdirSync(directory, { recursive: true });
  // Only a signed-in profile adopts the pre-isolation data. Doing it for `guest`
  // would hide an existing user's history behind a signed-out session.
  if (key !== GUEST_KEY) adoptLegacyData(directory);
  app.setPath('userData', directory);
  boundKey = key;
  log.info('Account profile bound', { signedIn: key !== GUEST_KEY });
  return directory;
}

export type AccountReconciliation = 'unchanged' | 'relaunch';

/**
 * Record which account should own local data, and report whether the process must
 * restart to honour it.
 *
 * Signing OUT records the intent but does not relaunch: the login gate blocks the
 * workbench, so nothing can write to the previous account's profile, and the guest
 * profile binds cleanly at the next start. Signing IN as a different account does
 * require the restart, because the stores for the previous account are already open.
 */
export function reconcileActiveAccount(userId: string | null): AccountReconciliation {
  if (boundKey === null) return 'unchanged';
  const desired = profileKeyForUserId(userId);
  const pointer = readPointer();
  if (desired === boundKey) {
    // Self-heal: signing back into the same account after a sign-out must restore
    // the pointer, or the next start would drop to the guest profile.
    if (pointer?.accountKey !== desired) {
      writePointer({ accountKey: desired, userId, at: Date.now() });
    }
    return 'unchanged';
  }
  writePointer({ accountKey: desired, userId, at: Date.now() });
  return userId === null ? 'unchanged' : 'relaunch';
}

export function activeProfileInfo(): AccountProfileInfo {
  const key = boundKey ?? GUEST_KEY;
  let entries = 0;
  try {
    entries = readdirSync(app.getPath('userData')).filter(
      (name) => !name.startsWith('.') && name !== POINTER_FILE,
    ).length;
  } catch {
    entries = 0;
  }
  return {
    signedInProfile: key !== GUEST_KEY,
    reference: key === GUEST_KEY ? GUEST_KEY : key.slice(0, 8),
    entries,
  };
}
