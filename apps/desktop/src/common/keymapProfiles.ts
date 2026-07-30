/**
 * Keymap presets + portable settings PROFILES (Phase 249 — Keymaps & Profiles).
 *
 * PURE module (no I/O, no Electron). It is the composable core for:
 *   - well-known keymap PRESETS (VS Code / JetBrains / Sublime / Emacs) as
 *     representative command → keystroke maps;
 *   - order-INDEPENDENT chord normalization, including multi-chord SEQUENCES
 *     (e.g. Emacs "Ctrl+X Ctrl+S") so equivalent bindings compare equal;
 *   - keybinding CONFLICT detection (same keystroke + `when` bound to >1 command);
 *   - portable settings PROFILES (preset + editor keymap + keybinding overrides +
 *     settings + extensions + ui) with resolveKeymap (overrides win over preset)
 *     and JSON export / import round-trip with validation + sanitization.
 *
 * NOTE: this is a SEPARATE axis from common/keymaps.ts, which drives the editor's
 * `default | vim` MODAL toggle. Presets here are the platform keybinding *style*;
 * the modal keymap is orthogonal (captured on a profile as `editorKeymap`).
 */

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type KeymapPreset = 'vscode' | 'jetbrains' | 'sublime' | 'emacs';

export const KEYMAP_PRESETS: readonly KeymapPreset[] = ['vscode', 'jetbrains', 'sublime', 'emacs'];

export const KEYMAP_PRESET_LABELS: Record<KeymapPreset, string> = {
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  sublime: 'Sublime Text',
  emacs: 'Emacs',
};

/** Coerce arbitrary input to a valid preset (default 'vscode'). */
export function parseKeymapPreset(value: unknown): KeymapPreset {
  return typeof value === 'string' && (KEYMAP_PRESETS as readonly string[]).includes(value)
    ? (value as KeymapPreset)
    : 'vscode';
}

// ---------------------------------------------------------------------------
// Chord normalization (order-independent, multi-chord sequences)
// ---------------------------------------------------------------------------

/** Canonical modifier order; comparison is order-independent because we sort to this. */
const MOD_ORDER: readonly string[] = ['ctrl', 'shift', 'alt', 'meta'];

const MOD_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  meta: 'meta',
  option: 'alt',
  opt: 'alt',
  alt: 'alt',
  shift: 'shift',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
};

/**
 * Normalize a SINGLE keystroke (one chord), e.g. "Ctrl+Shift+P" → "ctrl+shift+p".
 * Modifiers are aliased and sorted into MOD_ORDER; the main key is aliased.
 * Splits on '+', trims/lowercases/filters empty tokens.
 */
export function normalizeKeystroke(stroke: string): string {
  const parts = stroke
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  const mods: string[] = [];
  let key = '';
  for (const part of parts) {
    const asMod = MOD_ALIASES[part];
    if (asMod !== undefined) {
      if (!mods.includes(asMod)) mods.push(asMod);
    } else {
      key = KEY_ALIASES[part] ?? part;
    }
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return key.length > 0 ? [...mods, key].join('+') : mods.join('+');
}

/**
 * Normalize a full chord, which may be a space-separated SEQUENCE of keystrokes
 * (Emacs "Ctrl+X Ctrl+S" → "ctrl+x ctrl+s"). Each keystroke is normalized.
 */
export function normalizeChord(chord: string): string {
  return chord
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => normalizeKeystroke(s))
    .filter((s) => s.length > 0)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Keybindings + preset maps
// ---------------------------------------------------------------------------

export interface Keybinding {
  command: string;
  key: string;
  /** Optional `when` context clause; different contexts do NOT conflict. */
  when?: string;
}

/**
 * Representative command → keystroke maps per preset (~12 common commands each).
 * These are deliberately internally conflict-free; the Emacs map exercises
 * multi-chord sequences. They are a starting point users can override per profile.
 */
export const PRESET_BINDINGS: Record<KeymapPreset, Keybinding[]> = {
  vscode: [
    { command: 'workbench.showCommands', key: 'Ctrl+Shift+P' },
    { command: 'workbench.quickOpen', key: 'Ctrl+P' },
    { command: 'workbench.save', key: 'Ctrl+S' },
    { command: 'editor.find', key: 'Ctrl+F' },
    { command: 'editor.replace', key: 'Ctrl+H' },
    { command: 'editor.commentLine', key: 'Ctrl+/' },
    { command: 'editor.gotoLine', key: 'Ctrl+G' },
    { command: 'editor.rename', key: 'F2' },
    { command: 'editor.formatDocument', key: 'Shift+Alt+F' },
    { command: 'workbench.toggleTerminal', key: 'Ctrl+`' },
    { command: 'editor.deleteLine', key: 'Ctrl+Shift+K' },
    { command: 'editor.duplicateLine', key: 'Shift+Alt+Down' },
  ],
  jetbrains: [
    { command: 'workbench.showCommands', key: 'Ctrl+Shift+A' },
    { command: 'workbench.quickOpen', key: 'Ctrl+Shift+N' },
    { command: 'workbench.save', key: 'Ctrl+S' },
    { command: 'editor.find', key: 'Ctrl+F' },
    { command: 'editor.replace', key: 'Ctrl+R' },
    { command: 'editor.commentLine', key: 'Ctrl+/' },
    { command: 'editor.gotoLine', key: 'Ctrl+G' },
    { command: 'editor.rename', key: 'Shift+F6' },
    { command: 'editor.formatDocument', key: 'Ctrl+Alt+L' },
    { command: 'workbench.toggleTerminal', key: 'Alt+F12' },
    { command: 'editor.deleteLine', key: 'Ctrl+Y' },
    { command: 'editor.duplicateLine', key: 'Ctrl+D' },
  ],
  sublime: [
    { command: 'workbench.showCommands', key: 'Ctrl+Shift+P' },
    { command: 'workbench.quickOpen', key: 'Ctrl+P' },
    { command: 'workbench.save', key: 'Ctrl+S' },
    { command: 'editor.find', key: 'Ctrl+F' },
    { command: 'editor.replace', key: 'Ctrl+H' },
    { command: 'editor.commentLine', key: 'Ctrl+/' },
    { command: 'editor.gotoLine', key: 'Ctrl+G' },
    { command: 'editor.rename', key: 'F2' },
    { command: 'editor.formatDocument', key: 'Ctrl+Shift+F' },
    { command: 'workbench.toggleTerminal', key: 'Ctrl+`' },
    { command: 'editor.deleteLine', key: 'Ctrl+Shift+K' },
    { command: 'editor.duplicateLine', key: 'Ctrl+Shift+D' },
  ],
  emacs: [
    { command: 'workbench.showCommands', key: 'Alt+X' },
    { command: 'workbench.quickOpen', key: 'Ctrl+X Ctrl+F' },
    { command: 'workbench.save', key: 'Ctrl+X Ctrl+S' },
    { command: 'editor.find', key: 'Ctrl+S' },
    { command: 'editor.replace', key: 'Alt+%' },
    { command: 'editor.commentLine', key: 'Alt+;' },
    { command: 'editor.gotoLine', key: 'Alt+G G' },
    { command: 'editor.rename', key: 'Ctrl+C Ctrl+R' },
    { command: 'editor.formatDocument', key: 'Ctrl+Alt+\\' },
    { command: 'workbench.toggleTerminal', key: 'Ctrl+C T' },
    { command: 'editor.deleteLine', key: 'Ctrl+K' },
    { command: 'editor.duplicateLine', key: 'Ctrl+C Ctrl+D' },
  ],
};

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface KeyConflict {
  /** Normalized chord shared by the conflicting commands. */
  key: string;
  /** Trimmed `when` context ('' = global). */
  when: string;
  /** The distinct commands bound to this key+context. */
  commands: string[];
}

/**
 * Detect keybinding conflicts: two DISTINCT commands bound to the same normalized
 * keystroke AND the same `when` context. Same command listed twice is deduped
 * (not a conflict); different `when` clauses do NOT conflict.
 */
export function detectConflicts(bindings: readonly Keybinding[]): KeyConflict[] {
  const groups = new Map<string, { key: string; when: string; commands: string[] }>();
  for (const b of bindings) {
    const key = normalizeChord(b.key);
    if (key.length === 0) continue;
    const when = (b.when ?? '').trim();
    const groupKey = `${key}\u0000${when}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { key, when, commands: [] };
      groups.set(groupKey, group);
    }
    if (!group.commands.includes(b.command)) group.commands.push(b.command);
  }
  const conflicts: KeyConflict[] = [];
  for (const group of groups.values()) {
    if (group.commands.length > 1) {
      conflicts.push({ key: group.key, when: group.when, commands: group.commands });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Applying a preset to the app's global command keybindings (Phase 249)
// ---------------------------------------------------------------------------

/**
 * Map the abstract preset command names to Axiom's REAL command ids, for the
 * workbench commands the app dispatches globally (see renderer commands/
 * keybindings DEFAULT_BINDINGS). Preset commands without a mapping here
 * (editor-internal find / replace / comment / rename / line ops handled by Monaco)
 * are intentionally NOT applied app-wide.
 */
export const PRESET_COMMAND_ALIASES: Record<string, string> = {
  'workbench.showCommands': 'workbench.action.showCommands',
  'workbench.quickOpen': 'workbench.action.quickOpen',
  'workbench.save': 'workbench.action.files.save',
  'editor.gotoLine': 'workbench.action.gotoLine',
  'editor.formatDocument': 'editor.action.formatDocument',
  'workbench.toggleTerminal': 'workbench.action.terminal.toggleTerminal',
};

export interface AppKeybinding {
  id: string;
  chord: string;
}

/**
 * The app-command → chord overrides implied by a preset: the preset's bindings for
 * the commands Axiom dispatches globally, restricted to SINGLE-chord keystrokes.
 * Multi-chord SEQUENCES (e.g. Emacs "Ctrl+X Ctrl+S") are excluded because the
 * global dispatcher matches one keystroke at a time — applying them would silently
 * unbind the command. Returns app bindings in the app's own chord format.
 */
export function presetAppBindings(preset: KeymapPreset): AppKeybinding[] {
  const out: AppKeybinding[] = [];
  for (const b of PRESET_BINDINGS[preset]) {
    const id = PRESET_COMMAND_ALIASES[b.command];
    if (id === undefined) continue;
    if (b.key.trim().includes(' ')) continue; // skip multi-chord sequences
    out.push({ id, chord: b.key });
  }
  return out;
}

/**
 * Layer preset bindings over a base command→chord map, returning a NEW map. Each
 * applied chord is first FREED from any other command that held it (so no two
 * commands share a chord — the preset command wins); unaffected commands keep
 * their base chord. Pure — the caller then applies user overrides on top.
 */
export function applyPresetBindings(
  base: ReadonlyMap<string, string>,
  bindings: readonly AppKeybinding[],
): Map<string, string> {
  const map = new Map(base);
  for (const { id, chord } of bindings) {
    for (const [otherId, otherChord] of [...map]) {
      if (otherId !== id && otherChord === chord) map.delete(otherId);
    }
    map.set(id, chord);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Settings profiles
// ---------------------------------------------------------------------------

export type EditorKeymapMode = 'default' | 'vim';

export interface SettingsProfile {
  id: string;
  name: string;
  preset: KeymapPreset;
  editorKeymap: EditorKeymapMode;
  /** Per-command overrides layered over the preset (one binding per command). */
  keybindings: Keybinding[];
  settings: Record<string, unknown>;
  extensions: string[];
  ui: Record<string, unknown>;
}

/**
 * Resolve the effective keymap for a profile: start from the preset, then apply
 * the profile's overrides. Overrides WIN over the preset; the result has at most
 * one binding per command.
 */
export function resolveKeymap(profile: SettingsProfile): Keybinding[] {
  const byCommand = new Map<string, Keybinding>();
  for (const b of PRESET_BINDINGS[profile.preset]) {
    byCommand.set(b.command, b);
  }
  for (const b of profile.keybindings) {
    byCommand.set(b.command, b);
  }
  return [...byCommand.values()];
}

/** Convert a keybinding list to the renderer's command→chord override record. */
export function bindingsToOverrides(bindings: readonly Keybinding[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bindings) {
    if (b.command.length > 0) out[b.command] = b.key;
  }
  return out;
}

/** Convert a command→chord override record to a keybinding list. */
export function overridesToBindings(overrides: Record<string, string>): Keybinding[] {
  return Object.entries(overrides)
    .filter(([command, key]) => command.length > 0 && typeof key === 'string')
    .map(([command, key]) => ({ command, key }));
}

const PROFILE_ENVELOPE_KIND = 'axiom.settingsProfile' as const;
const PROFILE_ENVELOPE_VERSION = 1 as const;

export interface ProfileEnvelope {
  kind: typeof PROFILE_ENVELOPE_KIND;
  version: typeof PROFILE_ENVELOPE_VERSION;
  profile: SettingsProfile;
}

/** Serialize a profile to a portable, versioned JSON envelope. */
export function exportProfile(profile: SettingsProfile): string {
  const envelope: ProfileEnvelope = {
    kind: PROFILE_ENVELOPE_KIND,
    version: PROFILE_ENVELOPE_VERSION,
    profile,
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Parse + validate + sanitize a profile envelope. Returns a discriminated result
 * so callers can surface a friendly error rather than throwing.
 */
export function importProfile(
  json: string,
): { ok: true; profile: SettingsProfile } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  if (!isPlainRecord(parsed)) {
    return { ok: false, error: 'Profile must be a JSON object.' };
  }
  if (parsed['kind'] !== PROFILE_ENVELOPE_KIND) {
    return { ok: false, error: 'Not an Axiom settings profile.' };
  }
  if (parsed['version'] !== PROFILE_ENVELOPE_VERSION) {
    return { ok: false, error: `Unsupported profile version: ${String(parsed['version'])}.` };
  }
  const rawProfile = parsed['profile'];
  if (!isPlainRecord(rawProfile)) {
    return { ok: false, error: 'Profile payload is missing.' };
  }
  return { ok: true, profile: sanitizeProfile(rawProfile) };
}

/**
 * Build a well-formed profile from partial input, coercing/sanitizing every field
 * and slugifying the id (falls back to the name).
 */
export function createProfile(init: { name: string } & Partial<SettingsProfile>): SettingsProfile {
  return sanitizeProfile({ ...init });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitizeProfile(p: Record<string, unknown>): SettingsProfile {
  const nameRaw = p['name'];
  const name = typeof nameRaw === 'string' && nameRaw.length > 0 ? nameRaw : 'Untitled Profile';
  const idRaw = p['id'];
  const idSource = typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : name;
  const settingsRaw = p['settings'];
  const uiRaw = p['ui'];
  return {
    id: slugify(idSource),
    name,
    preset: parseKeymapPreset(p['preset']),
    editorKeymap: p['editorKeymap'] === 'vim' ? 'vim' : 'default',
    keybindings: sanitizeBindings(p['keybindings']),
    settings: isPlainRecord(settingsRaw) ? settingsRaw : {},
    extensions: sanitizeStringArray(p['extensions']),
    ui: isPlainRecord(uiRaw) ? uiRaw : {},
  };
}

function sanitizeBindings(input: unknown): Keybinding[] {
  if (!Array.isArray(input)) return [];
  const out: Keybinding[] = [];
  for (const raw of input) {
    if (!isPlainRecord(raw)) continue;
    const command = raw['command'];
    const key = raw['key'];
    if (typeof command !== 'string' || command.length === 0) continue;
    if (typeof key !== 'string') continue;
    const when = raw['when'];
    out.push({
      command,
      key,
      ...(typeof when === 'string' && when.length > 0 ? { when } : {}),
    });
  }
  return out;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'profile';
}
