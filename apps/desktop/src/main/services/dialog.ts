import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import type {
  OpenFileResult,
  OpenFolderResult,
  OpenPathResult,
  SaveFileResult,
} from '../../common/ipc';
import { knownRecentIdentity } from './recents';
import {
  assertAuthorizedPath,
  authorizeFilePath,
  authorizeWorkspaceRoot,
  canonicalPathIdentity,
} from './pathAuthorization';

function dialogOwner(owner: BrowserWindow): BrowserWindow | null {
  return owner.isDestroyed() ? null : owner;
}

async function authorizeExistingPath(path: string): Promise<OpenPathResult> {
  const stat = await fs.stat(path);
  if (stat.isDirectory()) {
    const authorized = await authorizeWorkspaceRoot(path);
    return { path: authorized, name: basename(authorized) || authorized, kind: 'directory' };
  }
  if (stat.isFile()) {
    const authorized = await authorizeFilePath(path);
    return { path: authorized, name: basename(authorized) || authorized, kind: 'file' };
  }
  throw new Error('The selected path is not a regular file or directory.');
}

/** Native folder picker (PRD Part VI §90), owned by the requesting window. */
export async function openFolder(owner: BrowserWindow): Promise<OpenFolderResult | null> {
  const win = dialogOwner(owner);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });

  if (win.isDestroyed() || result.canceled) return null;
  const selected = result.filePaths[0];
  if (!selected) return null;
  const path = await authorizeWorkspaceRoot(selected);
  if (win.isDestroyed()) return null;
  return { path, name: basename(path) || path };
}

/** Native multi-file picker. Each selected file receives an exact Main capability. */
export async function openFiles(owner: BrowserWindow): Promise<OpenFileResult[]> {
  const win = dialogOwner(owner);
  if (!win) return [];
  const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'] };
  const result = await dialog.showOpenDialog(win, options);

  if (win.isDestroyed() || result.canceled) return [];
  const entries = await Promise.all(result.filePaths.map(authorizeExistingPath));
  if (win.isDestroyed()) return [];
  return entries.filter((entry) => entry.kind === 'file').map(({ path, name }) => ({ path, name }));
}

/**
 * Native picker for a single extension package.
 *
 * The path is authorized the same way any other opened file is, so "Install from VSIX"
 * cannot be turned into a way for the renderer to name an arbitrary file: the renderer
 * asks for a picker, the user chooses, and Main returns a path it has already granted.
 * The `.vsix` filter is a convenience; the install pipeline re-checks the extension and
 * validates the archive regardless of what the dialog allowed through.
 */
export async function openExtensionPackage(owner: BrowserWindow): Promise<OpenFileResult | null> {
  const win = dialogOwner(owner);
  if (!win) return null;
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Extension package', extensions: ['vsix'] }],
  };
  const result = await dialog.showOpenDialog(win, options);
  if (win.isDestroyed() || result.canceled) return null;
  const selected = result.filePaths[0];
  if (!selected) return null;
  const entry = await authorizeExistingPath(selected);
  if (win.isDestroyed() || entry.kind !== 'file') return null;
  return { path: entry.path, name: entry.name };
}

/**
 * Grant a path obtained by preload from Electron's `webUtils.getPathForFile`.
 * Renderer strings never reach this function through the exposed bridge.
 */
export function authorizeDroppedPath(path: string): Promise<OpenPathResult> {
  return authorizeExistingPath(path);
}

/** Native "Save As" picker for untitled buffers (PRD Part VII §106). */
export async function saveFile(
  defaultName: string | undefined,
  owner: BrowserWindow,
): Promise<SaveFileResult | null> {
  const win = dialogOwner(owner);
  if (!win) return null;
  const options = defaultName ? { defaultPath: defaultName } : {};
  const result = await dialog.showSaveDialog(win, options);

  if (win.isDestroyed() || result.canceled || !result.filePath) return null;
  const path = await authorizeFilePath(result.filePath);
  const canonicalPath = await assertAuthorizedPath(path, { allowMissing: true });
  if (win.isDestroyed()) return null;
  return {
    path,
    canonicalPath,
    canonicalIdentity: canonicalPathIdentity(canonicalPath),
    name: basename(path) || path,
  };
}

/** Validate and authorize only a directory recorded by Main as a recent workspace. */
export async function validateFolder(path: string): Promise<OpenFolderResult | null> {
  try {
    const expectedIdentity = await knownRecentIdentity(path);
    if (!expectedIdentity) return null;
    // Re-resolve and compare in the granting operation so retargeting a persisted
    // recent through a symlink cannot establish a different workspace root.
    const authorized = await authorizeWorkspaceRoot(path, expectedIdentity);
    return { path: authorized, name: basename(authorized) || authorized };
  } catch {
    return null;
  }
}
