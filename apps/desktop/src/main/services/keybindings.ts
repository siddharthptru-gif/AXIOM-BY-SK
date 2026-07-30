import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SettingsData } from '../../common/ipc';
import { serializePreferenceMutation } from './preferenceMutation';
import { recoverProfilePreferenceTransaction } from './profilePreferences';

/**
 * Keybinding overrides persistence (Main process, PRD Part VII §103). Stores only
 * the user's changes as a { commandId: chord } map ('' = explicitly unbound) in
 * userData/keybindings.json; the renderer merges these over the compiled defaults.
 * Atomic writes share the preference commit FIFO with settings/profile updates.
 */
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export function keybindingsPath(): string {
  return join(app.getPath('userData'), 'keybindings.json');
}

function parseKeybindings(raw: string, path: string): SettingsData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Keybindings file contains invalid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Keybindings file must contain a JSON object: ${path}`);
  }
  return parsed as SettingsData;
}

export function readKeybindings(): Promise<SettingsData> {
  return serializePreferenceMutation(async () => {
    await recoverProfilePreferenceTransaction();
    const path = keybindingsPath();
    try {
      return parseKeybindings(await fs.readFile(path, 'utf-8'), path);
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
  });
}

export function writeKeybindings(values: SettingsData): Promise<void> {
  return serializePreferenceMutation(async () => {
    await recoverProfilePreferenceTransaction();
    const path = keybindingsPath();
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.axiom-keys-${randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(values, null, 2), 'utf-8');
    try {
      await fs.rename(tmp, path);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  });
}
