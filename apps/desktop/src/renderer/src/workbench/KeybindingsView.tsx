import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useCommandRegistry } from '../commands/registry';
import { useKeybindings, eventToChord, chordHasModifier } from '../commands/keybindings';
import { useSettings } from '../settings/store';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { DialogFrame } from './Modal';
import {
  detectConflicts,
  parseKeymapPreset,
  KEYMAP_PRESET_LABELS,
  type Keybinding,
} from '../../../common/keymapProfiles';

/**
 * Keyboard Shortcuts editor (PRD Part VII §103). A searchable list of every
 * registered command with its effective chord. Recording captures a real key
 * combination (a modifier is required); Reset drops the user override. The global
 * dispatcher is suspended while recording so the chord being pressed is not itself
 * executed.
 */
function ChordBadge({ chord }: { chord: string | null }) {
  if (!chord) return <span className="kb-unassigned">Unassigned</span>;
  const parts = chord.split('+');
  return (
    <span className="kb-chord">
      {parts.map((part, i) => (
        <kbd key={`${part}-${i}`} className="kb-key">
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function KeybindingsView() {
  const { getCommands } = useCommandRegistry();
  const { values } = useSettings();
  const { rootPath } = useWorkspace();
  const { trusted } = useWorkspaceTrust();
  const {
    isKbOpen,
    closeKb,
    getChordFor,
    setBinding,
    resetBinding,
    removeBinding,
    isOverridden,
    setCapturing,
  } = useKeybindings();
  const [query, setQuery] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = recordingId;

  const stopRecording = (): void => {
    setRecordingId(null);
    setCapturing(false);
  };

  const startRecording = (id: string): void => {
    setCapturing(true);
    setRecordingId(id);
  };

  const closeView = (): void => {
    stopRecording();
    closeKb();
  };

  // Always release the capture guard when the view unmounts or closes.
  useEffect(() => {
    if (!isKbOpen && recordingRef.current) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKbOpen]);

  const commands = useMemo(
    () =>
      getCommands()
        .filter((command) => command.visible?.() !== false)
        .slice()
        .sort(
          (a, b) =>
            (a.category ?? '').localeCompare(b.category ?? '') || a.title.localeCompare(b.title),
        ),
    // Visibility predicates can depend on the active workspace and its trust state.
    [getCommands, isKbOpen, rootPath, trusted],
  );

  const preset = parseKeymapPreset(values['keymap.preset']);
  const conflictCount = useMemo(() => {
    const bindings: Keybinding[] = [];
    for (const c of commands) {
      const chord = getChordFor(c.id);
      if (chord) bindings.push({ command: c.id, key: chord });
    }
    return detectConflicts(bindings).length;
  }, [commands, getChordFor]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return commands;
    return commands.filter((c) => {
      const chord = getChordFor(c.id) ?? '';
      return (
        c.title.toLowerCase().includes(q) ||
        (c.category ?? '').toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        chord.toLowerCase().includes(q)
      );
    });
  }, [commands, query, getChordFor]);

  if (!isKbOpen) return null;

  const onRecordKeyDown = (id: string, e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      removeBinding(id);
      stopRecording();
      return;
    }
    const chord = eventToChord(e.nativeEvent);
    if (!chord || !chordHasModifier(chord)) return; // wait for a modifier + key
    setBinding(id, chord);
    stopRecording();
  };

  return (
    <DialogFrame
      onClose={closeView}
      onEscape={() => (recordingId ? stopRecording() : closeKb())}
      overlayClassName="settings-overlay"
      cardClassName="settings-panel kb-panel"
      ariaLabel="Keyboard Shortcuts"
    >
      <div className="settings-head">
        <span className="settings-title">Keyboard Shortcuts</span>
        <input
          className="settings-search"
          placeholder="Search by command or key"
          value={query}
          spellCheck={false}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Close keyboard shortcuts"
          onClick={closeView}
        >
          ×
        </button>
      </div>
      <div className="kb-body">
        <div className="kb-cmd-cat" role="note">
          Preset: {KEYMAP_PRESET_LABELS[preset]}
          {conflictCount > 0
            ? ` · ⚠ ${conflictCount} conflicting shortcut${conflictCount === 1 ? '' : 's'}`
            : ' · no conflicts'}
        </div>
        {rows.length === 0 ? (
          <div className="settings-empty">No commands match “{query}”.</div>
        ) : (
          <div className="kb-list" role="table">
            {rows.map((c) => {
              const chord = getChordFor(c.id);
              const recording = recordingId === c.id;
              return (
                <div key={c.id} className="kb-row" role="row">
                  <div className="kb-cell-cmd">
                    <span className="kb-cmd-title">{c.title}</span>
                    {c.category ? <span className="kb-cmd-cat">{c.category}</span> : null}
                  </div>
                  <div className="kb-cell-chord">
                    {recording ? (
                      <input
                        className="kb-record-input"
                        placeholder="Press keys… (Esc cancels, ⌫ unbinds)"
                        readOnly
                        autoFocus
                        onKeyDown={(e) => onRecordKeyDown(c.id, e)}
                        onBlur={stopRecording}
                      />
                    ) : (
                      <ChordBadge chord={chord} />
                    )}
                  </div>
                  <div className="kb-cell-actions">
                    {recording ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={stopRecording}
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="Record a new shortcut"
                        onClick={() => startRecording(c.id)}
                      >
                        Record
                      </button>
                    )}
                    {isOverridden(c.id) && !recording ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="Reset to default"
                        onClick={() => resetBinding(c.id)}
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DialogFrame>
  );
}
