import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SettingsData } from '../../../common/ipc';
import { useCommandRegistry } from './registry';
import { notifyError } from '../notifications/bus';
import type { AppKeybinding } from '../../../common/keymapProfiles';
import {
  assignKeybindingOverride,
  resolveKeybindingLayers,
} from '../../../common/keybindingResolution';

/**
 * Keybindings (PRD Part VII §103). The single source of truth for chord→command
 * dispatch. Compiled defaults are merged with user overrides persisted in
 * userData/keybindings.json ('' = explicitly unbound). One capture-phase keydown
 * listener runs the matching command by id, so Monaco and other widgets cannot
 * shadow workbench shortcuts.
 */
export interface DefaultBinding {
  chord: string;
  id: string;
}

/** Compiled defaults. Kept minimal; commands without a default are simply absent. */
export const DEFAULT_BINDINGS: DefaultBinding[] = [
  { chord: 'F1', id: 'workbench.action.showCommands' },
  { chord: 'Ctrl+Shift+P', id: 'workbench.action.showCommands' },
  { chord: 'Ctrl+P', id: 'workbench.action.quickOpen' },
  { chord: 'Ctrl+Shift+E', id: 'workbench.view.explorer' },
  { chord: 'Ctrl+Shift+G', id: 'workbench.view.scm' },
  { chord: 'Ctrl+Shift+L', id: 'workbench.action.ai.focusBuild' },
  { chord: 'Ctrl+Shift+F', id: 'workbench.view.search' },
  { chord: 'Ctrl+Shift+M', id: 'workbench.view.semanticSearch' },
  { chord: 'Ctrl+Alt+T', id: 'workbench.action.timeline' },
  { chord: 'Ctrl+Alt+F', id: 'workbench.action.ai.fixLastCommand' },
  { chord: 'Ctrl+B', id: 'workbench.action.toggleSidebar' },
  { chord: 'Ctrl+G', id: 'workbench.action.gotoLine' },
  { chord: 'Shift+Alt+F', id: 'editor.action.formatDocument' },
  { chord: 'Alt+Z', id: 'editor.action.toggleWordWrap' },
  { chord: 'Ctrl+,', id: 'workbench.action.openSettings' },
  { chord: 'Ctrl+J', id: 'workbench.action.togglePanel' },
  { chord: 'Ctrl+N', id: 'workbench.action.files.newUntitledFile' },
  { chord: 'Ctrl+O', id: 'workbench.action.files.openFile' },
  { chord: 'Ctrl+S', id: 'workbench.action.files.save' },
  { chord: 'Ctrl+Shift+S', id: 'workbench.action.files.saveAs' },
  { chord: 'Ctrl+Alt+S', id: 'workbench.action.files.saveAll' },
  { chord: 'Ctrl+W', id: 'workbench.action.closeActiveEditor' },
  { chord: 'Ctrl+Shift+T', id: 'workbench.action.reopenClosedEditor' },
  { chord: 'Ctrl+Shift+O', id: 'editor.action.quickOutline' },
  { chord: 'F8', id: 'editor.action.marker.next' },
  { chord: 'Shift+F8', id: 'editor.action.marker.prev' },
  // Code-intelligence navigation. F12 alone is unavailable: Main blocks it as a
  // DevTools accelerator, so Go to Definition takes Ctrl+F12 (Ctrl+Click too).
  { chord: 'Ctrl+F12', id: 'editor.action.revealDefinition' },
  { chord: 'Alt+F12', id: 'editor.action.peekDefinition' },
  { chord: 'Shift+F12', id: 'editor.action.goToReferences' },
  { chord: 'Ctrl+Shift+F12', id: 'editor.action.goToImplementation' },
  { chord: 'F2', id: 'editor.action.rename' },
  { chord: 'Ctrl+.', id: 'editor.action.quickFix' },
  { chord: 'Ctrl+Shift+R', id: 'editor.action.refactor' },
  { chord: 'Shift+Alt+O', id: 'editor.action.sourceAction' },
  // Hover / suggest / parameter hints are intentionally NOT bound here. Monaco
  // already owns Ctrl+Space and Ctrl+Shift+Space, and Ctrl+K belongs to the AI
  // inline edit; a workbench binding would shadow them in the capture phase.
  { chord: 'Alt+ArrowLeft', id: 'workbench.action.navigateBack' },
  { chord: 'Alt+ArrowRight', id: 'workbench.action.navigateForward' },
  { chord: 'Ctrl+=', id: 'editor.action.fontZoomIn' },
  { chord: 'Ctrl+-', id: 'editor.action.fontZoomOut' },
  { chord: 'Ctrl+0', id: 'editor.action.fontZoomReset' },
  { chord: 'Ctrl+\\', id: 'workbench.action.splitEditor' },
  { chord: 'Ctrl+1', id: 'workbench.action.focusFirstEditorGroup' },
  { chord: 'Ctrl+2', id: 'workbench.action.focusSecondEditorGroup' },
  { chord: 'Ctrl+`', id: 'workbench.action.terminal.toggleTerminal' },
  { chord: 'Ctrl+Shift+`', id: 'workbench.action.terminal.new' },
];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph']);

/**
 * Normalize a keyboard event into a chord string such as `Ctrl+Shift+K`. Modifier
 * order is fixed (Ctrl, Shift, Alt) so equality is stable. Returns null while only
 * a bare modifier is held (no primary key yet). `Ctrl` also covers Cmd (metaKey).
 */
export function eventToChord(e: KeyboardEvent): string | null {
  if (e.isComposing || e.keyCode === 229 || MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** True when a chord uses at least one modifier — required to record a binding. */
export function chordHasModifier(chord: string): boolean {
  return chord.startsWith('Ctrl+') || chord.startsWith('Alt+') || chord.startsWith('Shift+');
}

interface KeybindingsValue {
  /** True once persisted keybinding overrides have hydrated successfully. */
  loaded: boolean;
  /** Effective chord for a command id, or null if unbound. */
  getChordFor: (id: string) => string | null;
  /** Assign a chord to a command, unbinding any command currently on that chord. */
  setBinding: (id: string, chord: string) => void;
  /** Drop the user override for a command, reverting to its default. */
  resetBinding: (id: string) => void;
  /** Explicitly unbind a command (persists an empty chord). */
  removeBinding: (id: string) => void;
  /** True if the command has a user override (added, changed, or removed). */
  isOverridden: (id: string) => boolean;
  /** Suspend the global dispatcher while recording a chord in the editor UI. */
  setCapturing: (capturing: boolean) => void;
  /** Apply a keymap preset's bindings to the global command map (Phase 249). */
  setPresetBindings: (bindings: AppKeybinding[]) => void;
  /** Replace ALL user keybinding overrides and persist them. */
  replaceOverrides: (overrides: Record<string, string>) => void;
  /** Adopt an already-committed complete override snapshot without writing it again. */
  adoptOverrides: (overrides: Record<string, string>) => void;
  isKbOpen: boolean;
  openKb: () => void;
  closeKb: () => void;
}

const KeybindingsContext = createContext<KeybindingsValue | null>(null);

export function KeybindingsProvider({ children }: { children: ReactNode }) {
  const { runCommand } = useCommandRegistry();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [presetBindings, setPresetBindings] = useState<AppKeybinding[]>([]);
  const [isKbOpen, setKbOpen] = useState(false);
  const capturingRef = useRef(false);
  const overridesRef = useRef<Record<string, string>>({});
  const overridesHydratedRef = useRef(false);
  const pendingOverrideTransformsRef = useRef<
    Array<(current: Record<string, string>) => Record<string, string>>
  >([]);

  // Load persisted overrides once. Mutations made while this read is in flight
  // are replayed over the disk snapshot, then flushed as one merged object.
  useEffect(() => {
    let cancelled = false;
    void window.axiom.keybindings
      .read()
      .then((data: SettingsData) => {
        if (cancelled) return;
        let next: Record<string, string> = {};
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string') next[key] = value;
        }
        const pending = pendingOverrideTransformsRef.current;
        for (const transform of pending) next = transform(next);
        pendingOverrideTransformsRef.current = [];
        overridesHydratedRef.current = true;
        overridesRef.current = next;
        setOverrides(next);
        setLoaded(true);
        if (pending.length > 0) {
          void window.axiom.keybindings.write(next).catch((error: unknown) => {
            notifyError('Could not save keyboard shortcuts.', {
              source: 'Keyboard Shortcuts',
              detail: error instanceof Error ? error.message : String(error),
            });
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          notifyError('Could not load keyboard shortcuts.', {
            source: 'Keyboard Shortcuts',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve ordered compiled aliases, then preset bindings, then persisted user
  // overrides. Explicit entries (including same-primary assignments and '')
  // suppress every lower-priority alias; only Reset removes an override.
  const resolved = useMemo(
    () => resolveKeybindingLayers(DEFAULT_BINDINGS, presetBindings, overrides),
    [presetBindings, overrides],
  );
  const effective = resolved.effective;
  const chordToId = resolved.chordToId;

  const chordToIdRef = useRef(chordToId);
  chordToIdRef.current = chordToId;
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  // One global capture-phase listener. Wins over Monaco and other widgets.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (
        e.isComposing ||
        e.keyCode === 229 ||
        capturingRef.current ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return;
      const id = chordToIdRef.current.get(chord);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      runCommandRef.current(id);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const persist = useCallback(
    (transform: (current: Record<string, string>) => Record<string, string>): void => {
      const current = overridesRef.current;
      const next = transform(current);
      if (!overridesHydratedRef.current) {
        pendingOverrideTransformsRef.current.push(transform);
      } else if (next === current) {
        return;
      }
      if (next !== current) {
        overridesRef.current = next;
        setOverrides(next);
      }
      if (overridesHydratedRef.current) {
        void window.axiom.keybindings.write(next).catch((error: unknown) => {
          notifyError('Could not save keyboard shortcuts.', {
            source: 'Keyboard Shortcuts',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },
    [],
  );

  const getChordFor = useCallback(
    (id: string): string | null => effective.get(id) ?? null,
    [effective],
  );

  const setBinding = useCallback(
    (id: string, chord: string): void => {
      persist((current) =>
        assignKeybindingOverride(current, id, chord, DEFAULT_BINDINGS, presetBindings),
      );
    },
    [persist, presetBindings],
  );

  const resetBinding = useCallback(
    (id: string): void => {
      persist((current) => {
        if (current[id] === undefined) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [persist],
  );

  const removeBinding = useCallback(
    (id: string): void => {
      persist((current) => (current[id] === '' ? current : { ...current, [id]: '' }));
    },
    [persist],
  );

  const isOverridden = useCallback(
    (id: string): boolean => overrides[id] !== undefined,
    [overrides],
  );

  const setCapturing = useCallback((capturing: boolean): void => {
    capturingRef.current = capturing;
  }, []);

  // Apply a preset's bindings (Phase 249). Dedupe so an unchanged preset does not
  // churn the effective map / re-render the global dispatcher.
  const applyPreset = useCallback((bindings: AppKeybinding[]): void => {
    setPresetBindings((prev) =>
      prev.length === bindings.length &&
      prev.every((p, i) => p.id === bindings[i]?.id && p.chord === bindings[i]?.chord)
        ? prev
        : bindings,
    );
  }, []);

  const openKb = useCallback(() => setKbOpen(true), []);
  const closeKb = useCallback(() => setKbOpen(false), []);

  // Replace all overrides and persist the snapshot.
  const replaceOverrides = useCallback(
    (next: Record<string, string>): void => {
      const clean: Record<string, string> = {};
      for (const [id, chord] of Object.entries(next)) {
        if (typeof chord === 'string') clean[id] = chord;
      }
      persist(() => clean);
    },
    [persist],
  );

  // Main has already atomically committed this complete snapshot as part of a
  // profile transaction. Clear pending transforms and update memory only.
  const adoptOverrides = useCallback((next: Record<string, string>): void => {
    const clean: Record<string, string> = {};
    for (const [id, chord] of Object.entries(next)) {
      if (typeof chord === 'string') clean[id] = chord;
    }
    pendingOverrideTransformsRef.current = [];
    overridesHydratedRef.current = true;
    overridesRef.current = clean;
    setOverrides(clean);
    setLoaded(true);
  }, []);

  const value = useMemo<KeybindingsValue>(
    () => ({
      loaded,
      getChordFor,
      setBinding,
      resetBinding,
      removeBinding,
      isOverridden,
      setCapturing,
      setPresetBindings: applyPreset,
      replaceOverrides,
      adoptOverrides,
      isKbOpen,
      openKb,
      closeKb,
    }),
    [
      loaded,
      getChordFor,
      setBinding,
      resetBinding,
      removeBinding,
      isOverridden,
      setCapturing,
      applyPreset,
      replaceOverrides,
      adoptOverrides,
      isKbOpen,
      openKb,
      closeKb,
    ],
  );

  return <KeybindingsContext.Provider value={value}>{children}</KeybindingsContext.Provider>;
}

export function useKeybindings(): KeybindingsValue {
  const ctx = useContext(KeybindingsContext);
  if (!ctx) throw new Error('useKeybindings must be used within KeybindingsProvider');
  return ctx;
}
