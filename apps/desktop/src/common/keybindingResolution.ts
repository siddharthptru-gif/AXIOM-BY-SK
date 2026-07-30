export interface LayeredBinding {
  id: string;
  chord: string;
}

export interface ResolvedKeybindings {
  /** One display/edit chord per command (the last compiled alias is primary). */
  effective: Map<string, string>;
  /** Complete dispatch map, including unsuppressed compiled aliases. */
  chordToId: Map<string, string>;
}

function removeCommand(map: Map<string, string>, id: string): void {
  for (const [chord, command] of [...map]) {
    if (command === id) map.delete(chord);
  }
}

function assignExclusive(map: Map<string, string>, id: string, chord: string): void {
  removeCommand(map, id);
  const displaced = map.get(chord);
  if (displaced && displaced !== id) removeCommand(map, displaced);
  map.set(chord, id);
}

/**
 * Resolve compiled aliases, then preset bindings, then persisted user overrides.
 * A preset equal to the compiled primary is a no-op (the default profile keeps
 * useful aliases such as F1). Any real preset change or explicit user entry
 * suppresses all lower-priority aliases before adding its single chord.
 */
export function resolveKeybindingLayers(
  defaults: readonly LayeredBinding[],
  presetBindings: readonly LayeredBinding[],
  overrides: Readonly<Record<string, string>>,
): ResolvedKeybindings {
  const primary = new Map<string, string>();
  const dispatch = new Map<string, string>();
  for (const binding of defaults) {
    primary.set(binding.id, binding.chord);
    dispatch.set(binding.chord, binding.id);
  }

  const effectivePreset = new Map<string, string>();
  for (const binding of presetBindings) {
    if (primary.get(binding.id) === binding.chord) continue;
    assignExclusive(dispatch, binding.id, binding.chord);
    effectivePreset.set(binding.id, binding.chord);
  }

  for (const [id, chord] of Object.entries(overrides)) {
    removeCommand(dispatch, id);
    if (chord === '') continue;
    const displaced = dispatch.get(chord);
    if (displaced && displaced !== id) removeCommand(dispatch, displaced);
    dispatch.set(chord, id);
  }

  const effective = new Map<string, string>();
  const ids = new Set<string>([
    ...primary.keys(),
    ...effectivePreset.keys(),
    ...Object.keys(overrides),
  ]);
  for (const id of ids) {
    const userChord = overrides[id];
    const preferred =
      userChord !== undefined ? userChord : (effectivePreset.get(id) ?? primary.get(id) ?? '');
    if (preferred && dispatch.get(preferred) === id) effective.set(id, preferred);
  }

  return { effective, chordToId: dispatch };
}

/** Re-evaluated against hydrated overrides so queued edits preserve disk state. */
export function assignKeybindingOverride(
  current: Readonly<Record<string, string>>,
  id: string,
  chord: string,
  defaults: readonly LayeredBinding[],
  presetBindings: readonly LayeredBinding[],
): Record<string, string> {
  const next = { ...current };
  const resolved = resolveKeybindingLayers(defaults, presetBindings, current);
  const conflictId = resolved.chordToId.get(chord);
  if (conflictId && conflictId !== id) next[conflictId] = '';
  // Explicit assignment is always persisted; only Reset deletes an override.
  next[id] = chord;
  return next;
}
