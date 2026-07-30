import { useSyncExternalStore } from 'react';
import type { IconDefinition, IconThemeDefinition } from '../../../common/contributions';

/**
 * The active file-icon theme, and how a filename resolves to one of its icons.
 *
 * Kept as a module-level store rather than React context on purpose. File icons are drawn
 * by six different views — the tree, breadcrumbs, tabs, open editors, search results and
 * source control — several of which render hundreds of rows. Threading a context through
 * all of them would put every one of those rows in the same re-render as the theme, for a
 * value that changes about once a session. A module store with an explicit subscription
 * lets each icon read the current theme and re-render only when it actually changes.
 *
 * Resolution follows VS Code's order, which matters because icon themes are authored
 * against it: an exact filename beats a compound extension, which beats a simple one.
 * `languageIds` is consulted last and only when a caller knows the language, since nothing
 * in a filename identifies a language on its own.
 */
let active: IconThemeDefinition | null = null;
const listeners = new Set<() => void>();

export function setActiveIconTheme(theme: IconThemeDefinition | null): void {
  if (active === theme) return;
  active = theme;
  for (const listener of [...listeners]) listener();
}

export function activeIconTheme(): IconThemeDefinition | null {
  return active;
}

/** Subscribe to icon-theme changes. Returns the unsubscribe function. */
export function subscribeIconTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Every extension candidate for a filename, longest first.
 *
 * `component.spec.ts` offers `spec.ts` before `ts`, so a theme that styles test files
 * differently wins over the generic TypeScript icon — the same precedence VS Code applies.
 */
function extensionCandidates(lowerName: string): string[] {
  const parts = lowerName.split('.');
  const candidates: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    candidates.push(parts.slice(index).join('.'));
  }
  return candidates;
}

export interface ResolvedIcon {
  definition: IconDefinition;
  /** The definition name, useful as a stable React key and for diagnostics. */
  name: string;
}

function lookup(theme: IconThemeDefinition, name: string | null): ResolvedIcon | null {
  if (name === null) return null;
  const definition = theme.iconDefinitions[name];
  return definition === undefined ? null : { definition, name };
}

/** The icon a file should use, or null when the theme has nothing for it. */
export function resolveFileIcon(fileName: string, languageId?: string | null): ResolvedIcon | null {
  if (active === null) return null;
  const lower = fileName.toLowerCase();
  const byName = lookup(active, active.fileNames[lower] ?? null);
  if (byName !== null) return byName;
  for (const candidate of extensionCandidates(lower)) {
    const byExtension = lookup(active, active.fileExtensions[candidate] ?? null);
    if (byExtension !== null) return byExtension;
  }
  if (languageId) {
    const byLanguage = lookup(active, active.languageIds[languageId.toLowerCase()] ?? null);
    if (byLanguage !== null) return byLanguage;
  }
  return lookup(active, active.file);
}

/** The icon a folder should use, or null when the theme has nothing for it. */
export function resolveFolderIcon(open: boolean, root = false): ResolvedIcon | null {
  if (active === null) return null;
  if (root) {
    const rootIcon = lookup(active, active.rootFolder);
    if (rootIcon !== null) return rootIcon;
  }
  const opened = open ? lookup(active, active.folderExpanded) : null;
  return opened ?? lookup(active, active.folder);
}

function iconThemeSnapshot(): string | null {
  return active === null ? null : active.key;
}

/**
 * Re-render the calling component when the icon theme changes.
 *
 * `useSyncExternalStore` rather than state plus an effect: an icon renders once per row, so
 * the mount path has to stay as cheap as a subscription and nothing more. The snapshot is
 * the theme key — a primitive React can compare without allocating — while the lookups
 * above read the theme itself.
 */
export function useIconThemeKey(): string | null {
  return useSyncExternalStore(subscribeIconTheme, iconThemeSnapshot);
}
