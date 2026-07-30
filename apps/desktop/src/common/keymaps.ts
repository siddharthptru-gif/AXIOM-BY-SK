/**
 * Keymap profiles (PRD Epoch I §115 / Phase 249). A tiny pure model for the editor
 * keybinding profile the user selects. Today it toggles the modal Vim keymap (see
 * common/vim.ts) on or off; more profiles (Emacs, Sublime) can extend the union.
 * No I/O — the settings schema stores `editor.keymap` and the editor reads it here.
 */

export type KeymapProfile = 'default' | 'vim';

export const KEYMAP_PROFILES: readonly KeymapProfile[] = ['default', 'vim'] as const;

export const KEYMAP_LABELS: Record<KeymapProfile, string> = {
  default: 'Default',
  vim: 'Vim',
};

/** Coerce a persisted value into a known keymap profile (defaults to 'default'). */
export function parseKeymap(value: unknown): KeymapProfile {
  return typeof value === 'string' && (KEYMAP_PROFILES as readonly string[]).includes(value)
    ? (value as KeymapProfile)
    : 'default';
}

/** True when the Vim modal keymap is active. */
export function isVim(value: unknown): boolean {
  return parseKeymap(value) === 'vim';
}
