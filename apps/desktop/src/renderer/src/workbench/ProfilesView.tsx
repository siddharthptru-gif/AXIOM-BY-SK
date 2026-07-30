import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { onProfilesOpen } from './profilesBus';
import { useSettings } from '../settings/store';
import { SETTINGS } from '../settings/schema';
import { useKeybindings } from '../commands/keybindings';
import {
  createProfile,
  exportProfile,
  importProfile,
  bindingsToOverrides,
  overridesToBindings,
  parseKeymapPreset,
  KEYMAP_PRESET_LABELS,
  type SettingsProfile,
} from '../../../common/keymapProfiles';

/**
 * Keymap & settings PROFILES manager (Phase 249 — completes "profile-manager UI").
 * Save the current preset + editor keymap + keybinding overrides as a named,
 * portable profile; apply / delete saved profiles; and export / import a profile
 * as JSON (round-trips via the pure `exportProfile`/`importProfile`). Profiles are
 * stored under the `keymap.profiles` user setting; applying one sets `keymap.preset`
 * + `editor.keymap` and replaces the keybinding overrides live. Reuses modal / btn /
 * spend / ai classes — no new CSS.
 */
function readProfiles(raw: unknown): SettingsProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: SettingsProfile[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const rec = item as { name?: unknown };
      const name = typeof rec.name === 'string' ? rec.name : 'Profile';
      out.push(createProfile({ ...(item as Partial<SettingsProfile>), name }));
    }
  }
  return out;
}

// Consent choices are device/account decisions, not portable appearance/editor
// preferences. Keymap metadata has dedicated strongly typed profile fields.
const PROFILE_SETTING_KEYS = new Set(
  SETTINGS.map((setting) => setting.key).filter(
    (key) => key !== 'keymap.preset' && key !== 'editor.keymap' && !key.startsWith('telemetry.'),
  ),
);

const SETTINGS_BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting] as const));

function validateProfileSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const definition = SETTINGS_BY_KEY.get(key);
    if (!definition || !PROFILE_SETTING_KEYS.has(key)) {
      throw new Error(`Unsupported profile setting “${key}”.`);
    }

    let valid = false;
    let expected: string = definition.type;
    if (definition.type === 'boolean') {
      valid = typeof value === 'boolean';
    } else if (definition.type === 'string') {
      valid = typeof value === 'string';
    } else if (definition.type === 'enum') {
      const options = definition.options ?? [];
      valid = typeof value === 'string' && options.includes(value);
      expected = `one of ${options.map((option) => `“${option}”`).join(', ')}`;
    } else {
      valid =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (definition.min === undefined || value >= definition.min) &&
        (definition.max === undefined || value <= definition.max);
      if (definition.min !== undefined && definition.max !== undefined) {
        expected = `a number from ${definition.min} to ${definition.max}`;
      } else {
        expected = 'a finite number';
      }
    }

    if (!valid) {
      throw new Error(`Invalid value for profile setting “${key}”; expected ${expected}.`);
    }
    validated[key] = value;
  }
  return validated;
}

export function ProfilesView() {
  const {
    values,
    loaded: settingsLoaded,
    set,
    setMany,
    getScopeValues,
    adoptScopeValues,
    getScopeValue,
  } = useSettings();
  const { loaded: keybindingsLoaded, adoptOverrides } = useKeybindings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [importText, setImportText] = useState('');
  const [exportText, setExportText] = useState('');
  const [msg, setMsg] = useState('');
  const [applyingId, setApplyingId] = useState<string | null>(null);

  useEffect(() => onProfilesOpen(() => setOpen(true)), []);
  if (!open) return null;

  const profiles = readProfiles(values['keymap.profiles']);
  const activeId =
    typeof values['keymap.activeProfile'] === 'string' ? values['keymap.activeProfile'] : '';

  const persist = (next: SettingsProfile[]): void => set('keymap.profiles', next, 'user');

  const saveCurrent = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setMsg('Enter a profile name.');
      return;
    }
    try {
      const overridesRaw = await window.axiom.keybindings.read();
      const overrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(overridesRaw)) {
        if (typeof v === 'string') overrides[k] = v;
      }
      const profileSettings: Record<string, unknown> = {};
      for (const key of PROFILE_SETTING_KEYS) {
        const value = getScopeValue(key, 'user');
        if (value !== undefined) profileSettings[key] = value;
      }
      const profile = createProfile({
        name: trimmed,
        preset: parseKeymapPreset(values['keymap.preset']),
        editorKeymap: values['editor.keymap'] === 'vim' ? 'vim' : 'default',
        keybindings: overridesToBindings(overrides),
        settings: profileSettings,
      });
      persist([...profiles.filter((p) => p.id !== profile.id), profile]);
      setName('');
      setMsg(`Saved profile “${profile.name}”.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMsg(`Could not read the current keyboard shortcuts: ${detail}`);
    }
  };

  const apply = async (profile: SettingsProfile): Promise<void> => {
    if (!settingsLoaded || !keybindingsLoaded) {
      setMsg('Preferences are still loading. Try again in a moment.');
      return;
    }

    setApplyingId(profile.id);
    setMsg('');
    try {
      const profileSettings = validateProfileSettings(profile.settings);
      const nextSettings = getScopeValues('user');
      // Profiles are replacement snapshots for portable settings: an omitted key
      // resets to its inherited/default value instead of retaining stale state.
      for (const key of PROFILE_SETTING_KEYS) delete nextSettings[key];
      Object.assign(nextSettings, profileSettings, {
        'keymap.preset': profile.preset,
        'editor.keymap': profile.editorKeymap,
        'keymap.activeProfile': profile.id,
      });
      const nextOverrides = bindingsToOverrides(profile.keybindings);

      const committed = await window.axiom.preferences.applyProfile(nextSettings, nextOverrides);
      adoptScopeValues(committed.settings, 'user');
      adoptOverrides(committed.keybindings);
      setMsg(`Applied “${profile.name}”.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMsg(`Could not apply “${profile.name}”: ${detail}`);
    } finally {
      setApplyingId(null);
    }
  };

  const remove = (id: string): void => {
    const next = profiles.filter((p) => p.id !== id);
    if (id === activeId) {
      setMany({ 'keymap.profiles': next, 'keymap.activeProfile': '' }, 'user');
    } else {
      persist(next);
    }
    setMsg('Profile deleted.');
  };

  const doExport = (profile: SettingsProfile): void => {
    setExportText(exportProfile(profile));
    setMsg(`Exported “${profile.name}” — copy the JSON below.`);
  };

  const doImport = (): void => {
    const result = importProfile(importText);
    if (!result.ok) {
      setMsg(`Import failed: ${result.error}`);
      return;
    }
    persist([...profiles.filter((p) => p.id !== result.profile.id), result.profile]);
    setImportText('');
    setMsg(`Imported “${result.profile.name}”.`);
  };

  return (
    <Modal title="Keymap Profiles" onClose={() => setOpen(false)}>
      <div className="spend-dash">
        <p className="ai-hint">
          Save your current editor preferences, keymap preset, editor mode, and shortcut overrides
          as a portable profile you can apply later or share as JSON.
        </p>

        <div className="spend-subhead">Save current as a profile</div>
        <div className="update-actions">
          <input
            className="modal-input"
            placeholder="Profile name (e.g. My Setup)"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveCurrent();
            }}
          />
          <button type="button" className="btn" onClick={() => void saveCurrent()}>
            Save
          </button>
        </div>

        <div className="spend-subhead">Saved profiles</div>
        {!settingsLoaded || !keybindingsLoaded ? (
          <p className="ai-hint">Loading preferences before profiles can be applied…</p>
        ) : null}
        {profiles.length === 0 ? (
          <p className="ai-hint">No saved profiles yet.</p>
        ) : (
          profiles.map((p) => (
            <div key={p.id} className="spend-row">
              <span>
                <strong>{p.name}</strong>{' '}
                <span className="spend-muted">
                  · {KEYMAP_PRESET_LABELS[p.preset]} · {p.editorKeymap}
                  {p.id === activeId ? ' · active' : ''}
                </span>
              </span>
              <span className="update-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void apply(p)}
                  disabled={!settingsLoaded || !keybindingsLoaded || applyingId !== null}
                >
                  {applyingId === p.id ? 'Applying…' : 'Apply'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => doExport(p)}>
                  Export
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(p.id)}>
                  Delete
                </button>
              </span>
            </div>
          ))
        )}

        {exportText ? (
          <>
            <div className="spend-subhead">Exported JSON (copy)</div>
            <textarea className="modal-input" readOnly rows={6} value={exportText} />
          </>
        ) : null}

        <div className="spend-subhead">Import a profile (paste JSON)</div>
        <textarea
          className="modal-input"
          rows={5}
          placeholder="Paste an exported profile JSON here…"
          value={importText}
          spellCheck={false}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="update-actions">
          <button type="button" className="btn" onClick={doImport} disabled={!importText.trim()}>
            Import
          </button>
        </div>

        {msg ? <p className="ai-hint">{msg}</p> : null}
      </div>
    </Modal>
  );
}
