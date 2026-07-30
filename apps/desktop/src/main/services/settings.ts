import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SettingsData } from '../../common/ipc';
import { sanitizeStoredAiHeaders } from '../../common/headerSafety';
import { serializePreferenceMutation } from './preferenceMutation';
import { recoverProfilePreferenceTransaction } from './profilePreferences';
import { applyRuntimeSettings } from './runtimeSettings';

/**
 * Settings persistence (Main process, PRD Part IV §55 / Part VII §120). Only user
 * overrides are stored; the renderer merges them over compiled schema defaults.
 * Scopes (precedence default < user < workspace):
 *   - user:      <userData>/settings.json
 *   - workspace: <root>/.axiom/settings.json
 * Writes are atomic (temp + rename) and share the preference commit FIFO.
 */
const resolvedSettingsFiles = new Map<string, 'user' | 'workspace'>();

function pathKey(path: string): string {
  const key = normalize(resolve(path));
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function sanitizeSettings(values: SettingsData): { values: SettingsData; changed: boolean } {
  const migrated = sanitizeStoredAiHeaders(values['ai.custom.headers']);
  if (!migrated.changed) return { values, changed: false };
  return {
    values: { ...values, 'ai.custom.headers': migrated.value },
    changed: true,
  };
}

function parseSettingsObject(raw: string, path: string): SettingsData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Settings file contains invalid JSON: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file must contain a JSON object: ${path}`);
  }
  return parsed as SettingsData;
}

async function readJsonObject(path: string): Promise<SettingsData> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const sanitized = sanitizeSettings(parseSettingsObject(raw, path));
  if (sanitized.changed) await writeJsonObject(path, sanitized.values);
  return sanitized.values;
}

async function writeJsonObject(
  path: string,
  values: SettingsData,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.axiom-settings-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(values, null, 2), 'utf-8');
    await beforeCommit?.();
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export function userSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function workspaceSettingsPath(root: string): string {
  return join(root, '.axiom', 'settings.json');
}

function withRecoveredPreferences<T>(operation: () => Promise<T>): Promise<T> {
  return serializePreferenceMutation(async () => {
    await recoverProfilePreferenceTransaction();
    return operation();
  });
}

export function readSettings(): Promise<SettingsData> {
  const path = userSettingsPath();
  return withRecoveredPreferences(() => readJsonObject(path));
}

export function writeSettings(values: SettingsData): Promise<void> {
  const path = userSettingsPath();
  const normalized = sanitizeSettings(values).values;
  return withRecoveredPreferences(async () => {
    await writeJsonObject(path, normalized);
    applyRuntimeSettings(normalized);
  });
}

export function readWorkspaceSettings(root: string): Promise<SettingsData> {
  const path = workspaceSettingsPath(root);
  return withRecoveredPreferences(() => readJsonObject(path));
}

export function writeWorkspaceSettings(root: string, values: SettingsData): Promise<void> {
  const path = workspaceSettingsPath(root);
  return withRecoveredPreferences(() => writeJsonObject(path, sanitizeSettings(values).values));
}

/**
 * Returns the absolute settings-file path for a scope, creating an empty `{}`
 * file (and parent dir) if it does not exist yet, so it can be opened in an
 * editor tab. Used by the "Open Settings (JSON)" action.
 */
export function ensureSettingsFile(
  scope: 'user' | 'workspace',
  root: string | null,
): Promise<string> {
  const path = scope === 'workspace' && root ? workspaceSettingsPath(root) : userSettingsPath();
  return withRecoveredPreferences(async () => {
    try {
      await fs.access(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await writeJsonObject(path, {});
    }
    resolvedSettingsFiles.set(pathKey(path), scope);
    // readFile returns canonical targets, so preserve the managed scope under both
    // the lexical settings path and its then-current canonical identity.
    resolvedSettingsFiles.set(pathKey(await fs.realpath(path)), scope);
    return path;
  });
}

/**
 * Route editor saves for settings files opened through ensureSettingsFile back
 * through the preference transaction queue. Other authorized files are left to
 * the generic filesystem writer.
 */
export async function writeResolvedSettingsFile(
  requestedPath: string,
  resolvedPath: string,
  content: string,
  beforeCommit?: () => Promise<void>,
): Promise<number | null> {
  const scope =
    resolvedSettingsFiles.get(pathKey(requestedPath)) ??
    resolvedSettingsFiles.get(pathKey(resolvedPath));
  if (!scope) return null;

  const normalized = sanitizeSettings(parseSettingsObject(content, requestedPath)).values;
  await withRecoveredPreferences(async () => {
    await writeJsonObject(resolvedPath, normalized, beforeCommit);
    if (scope === 'user') applyRuntimeSettings(normalized);
  });
  return Buffer.byteLength(content, 'utf-8');
}
