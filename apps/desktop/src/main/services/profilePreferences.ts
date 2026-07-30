import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProfilePreferencesSnapshot, SettingsData } from '../../common/ipc';
import { sanitizeStoredAiHeaders } from '../../common/headerSafety';
import { serializePreferenceMutation } from './preferenceMutation';
import { applyRuntimeSettings } from './runtimeSettings';

const TRANSACTION_FILE = 'profile-preferences-transaction.json';

type TransactionPhase = 'prepared' | 'committed';

interface ProfileTransactionJournal {
  version: 1;
  phase: TransactionPhase;
  previousSettings: string | null;
  previousKeybindings: string | null;
  nextSettings: string;
  nextKeybindings: string;
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function keybindingsPath(): string {
  return join(app.getPath('userData'), 'keybindings.json');
}

function transactionPath(): string {
  return join(app.getPath('userData'), TRANSACTION_FILE);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await fs.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flush a directory namespace after rename/unlink. Node can open directories on
 * Windows but Windows rejects fsync(2) with EPERM; there, the post-rename file
 * flush plus the prepared/committed roll-forward journal provides recovery.
 */
async function syncParent(path: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dirname(path), 'r');
  } catch (error) {
    if (process.platform === 'win32' && hasCode(error, 'EPERM')) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!(process.platform === 'win32' && hasCode(error, 'EPERM'))) throw error;
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-profile-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(text, 'utf-8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  // Flush the renamed target as well as its namespace. This orders each phase
  // after the write-ahead journal on filesystems that expose directory fsync.
  await syncFile(path);
  await syncParent(path);
}

async function removeDurably(path: string): Promise<void> {
  await fs.rm(path, { force: true });
  await syncParent(path);
}

async function restore(path: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await removeDurably(path);
  } else {
    await atomicWrite(path, previous);
  }
}

function parseJournal(raw: string): ProfileTransactionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('The profile preference transaction journal contains invalid JSON.', {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The profile preference transaction journal has an invalid shape.');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    (value.phase !== 'prepared' && value.phase !== 'committed') ||
    (value.previousSettings !== null && typeof value.previousSettings !== 'string') ||
    (value.previousKeybindings !== null && typeof value.previousKeybindings !== 'string') ||
    typeof value.nextSettings !== 'string' ||
    typeof value.nextKeybindings !== 'string'
  ) {
    throw new Error('The profile preference transaction journal has an invalid shape.');
  }
  return {
    version: 1,
    phase: value.phase,
    previousSettings: value.previousSettings,
    previousKeybindings: value.previousKeybindings,
    nextSettings: value.nextSettings,
    nextKeybindings: value.nextKeybindings,
  };
}

/**
 * Repair an interrupted profile transaction before exposing either preference
 * file. Prepared transactions roll back; committed transactions roll forward.
 * Both paths are idempotent, so a second crash during recovery is safe.
 */
export async function recoverProfilePreferenceTransaction(): Promise<void> {
  const journalPath = transactionPath();
  let raw: string;
  try {
    raw = await fs.readFile(journalPath, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const journal = parseJournal(raw);
  if (journal.phase === 'committed') {
    await atomicWrite(settingsPath(), journal.nextSettings);
    await atomicWrite(keybindingsPath(), journal.nextKeybindings);
  } else {
    await restore(settingsPath(), journal.previousSettings);
    await restore(keybindingsPath(), journal.previousKeybindings);
  }
  await removeDurably(journalPath);
}

function serializeObject(value: SettingsData, label: string): {
  text: string;
  value: SettingsData;
} {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== 'string') throw new Error(`${label} could not be serialized.`);
  const roundTrip: unknown = JSON.parse(text);
  if (!roundTrip || typeof roundTrip !== 'object' || Array.isArray(roundTrip)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return { text, value: roundTrip as SettingsData };
}

function normalizeKeybindings(value: SettingsData): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [command, chord] of Object.entries(value)) {
    if (command.length === 0 || typeof chord !== 'string') {
      throw new TypeError('Profile keybindings must map command ids to string chords.');
    }
    normalized[command] = chord;
  }
  return normalized;
}

async function rollbackPrepared(journal: ProfileTransactionJournal): Promise<string[]> {
  const errors: string[] = [];
  try {
    await restore(settingsPath(), journal.previousSettings);
  } catch (error) {
    errors.push(`settings: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await restore(keybindingsPath(), journal.previousKeybindings);
  } catch (error) {
    errors.push(`keybindings: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (errors.length === 0) {
    try {
      await removeDurably(transactionPath());
    } catch (error) {
      errors.push(`journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

/**
 * Commit a profile's complete settings/keybinding pair under a durable two-phase
 * journal. A crash before the committed marker rolls back; a crash afterward
 * rolls forward, so readers can never observe a permanently split pair.
 */
export function applyProfilePreferences(
  settings: SettingsData,
  keybindings: SettingsData,
): Promise<ProfilePreferencesSnapshot> {
  const migrated = sanitizeStoredAiHeaders(settings['ai.custom.headers']);
  const normalizedSettings = migrated.changed
    ? { ...settings, 'ai.custom.headers': migrated.value }
    : settings;
  const settingsPayload = serializeObject(normalizedSettings, 'Profile settings');
  const keybindingsPayload = serializeObject(
    normalizeKeybindings(keybindings),
    'Profile keybindings',
  );

  return serializePreferenceMutation(async () => {
    await recoverProfilePreferenceTransaction();

    const [previousSettings, previousKeybindings] = await Promise.all([
      readOptional(settingsPath()),
      readOptional(keybindingsPath()),
    ]);
    const prepared: ProfileTransactionJournal = {
      version: 1,
      phase: 'prepared',
      previousSettings,
      previousKeybindings,
      nextSettings: settingsPayload.text,
      nextKeybindings: keybindingsPayload.text,
    };

    await atomicWrite(transactionPath(), JSON.stringify(prepared, null, 2));
    try {
      await atomicWrite(settingsPath(), settingsPayload.text);
      await atomicWrite(keybindingsPath(), keybindingsPayload.text);
    } catch (error) {
      const rollbackErrors = await rollbackPrepared(prepared);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        rollbackErrors.length === 0
          ? `Could not apply profile: ${message}`
          : `Could not apply profile: ${message}. Rollback also failed (${rollbackErrors.join('; ')}).`,
        { cause: error },
      );
    }

    const committed: ProfileTransactionJournal = { ...prepared, phase: 'committed' };
    try {
      await atomicWrite(transactionPath(), JSON.stringify(committed, null, 2));
    } catch (error) {
      // The marker may be either old or new after an I/O failure. Resolve from
      // whichever phase is durable before surfacing the error.
      try {
        await recoverProfilePreferenceTransaction();
      } catch (recoveryError) {
        throw new Error(
          `Could not finalize profile preferences and recovery failed: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }`,
          { cause: error },
        );
      }
      throw new Error(
        `Could not finalize profile preferences: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Once the committed marker is durable, cleanup is optional for correctness:
    // a resurrected/undeleted marker simply rolls the exact pair forward again.
    await removeDurably(transactionPath()).catch(() => undefined);

    applyRuntimeSettings(settingsPayload.value);
    return {
      settings: settingsPayload.value,
      keybindings: keybindingsPayload.value as Record<string, string>,
    };
  });
}
