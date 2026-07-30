/**
 * Audio cues (PRD Epoch I §94 / Phase 254 — screen-reader & editor a11y). Pure
 * cue-definition + selection + throttling logic (no WebAudio, no I/O) so it is
 * fully unit-testable; the renderer plays the selected tone via an oscillator. Cues
 * are an accessibility aid (announce errors / warnings / breakpoints / task
 * completion without needing to look), OFF by default, per-event configurable, and
 * rate-limited so a burst never becomes noise. Deepens the already-partial 254
 * (announcements + LiveRegion + Monaco SR mode landed s45); a full UIA bridge +
 * accessible diff/merge/terminal remain.
 */

export type CueEvent =
  'error' | 'warning' | 'success' | 'info' | 'breakpoint' | 'taskComplete' | 'agentApproval';

export type CueKind = 'beep' | 'chirp' | 'buzz' | 'ding';

export interface CueDef {
  /** Base frequency (Hz). */
  freq: number;
  /** Duration of a single pulse (ms). */
  durationMs: number;
  kind: CueKind;
  /** Number of tone pulses. */
  pulses: number;
}

/** Distinct, short tones per event (low/buzzy = bad, high/ding = good). */
export const CUE_DEFS: Record<CueEvent, CueDef> = {
  error: { freq: 220, durationMs: 200, kind: 'buzz', pulses: 2 },
  warning: { freq: 330, durationMs: 150, kind: 'beep', pulses: 1 },
  success: { freq: 660, durationMs: 120, kind: 'ding', pulses: 1 },
  info: { freq: 440, durationMs: 90, kind: 'beep', pulses: 1 },
  breakpoint: { freq: 520, durationMs: 120, kind: 'chirp', pulses: 1 },
  taskComplete: { freq: 700, durationMs: 140, kind: 'ding', pulses: 2 },
  agentApproval: { freq: 500, durationMs: 130, kind: 'chirp', pulses: 2 },
};

export const ALL_CUE_EVENTS: readonly CueEvent[] = Object.keys(CUE_DEFS) as CueEvent[];

/** Which events cue by default (only the important, low-frequency ones). */
const DEFAULT_ON: Record<CueEvent, boolean> = {
  error: true,
  warning: true,
  success: false,
  info: false,
  breakpoint: true,
  taskComplete: false,
  agentApproval: false,
};

export interface CuePrefs {
  /** Master switch (setting a11y.audioCues). */
  enabled: boolean;
  /** Optional per-event overrides of the defaults. */
  events?: Partial<Record<CueEvent, boolean>>;
}

/** Is this event's cue enabled? Master switch first, then a per-event override, else the default. */
export function isCueEnabled(event: CueEvent, prefs: CuePrefs): boolean {
  if (!prefs.enabled) return false;
  const override = prefs.events?.[event];
  return override !== undefined ? override : DEFAULT_ON[event];
}

/** The cue definition to play for an event, or null when it is disabled. */
export function selectCue(event: CueEvent, prefs: CuePrefs): CueDef | null {
  return isCueEnabled(event, prefs) ? CUE_DEFS[event] : null;
}

/** Map a notification level to its cue event. */
export function cueForLevel(level: 'info' | 'warn' | 'error'): CueEvent {
  return level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
}

/**
 * Map an LSP diagnostic severity (1=error, 2=warning, 3=info, 4=hint) to a cue
 * event, or null when it shouldn't cue (info/hint are too frequent).
 */
export function cueForDiagnosticSeverity(severity: number): CueEvent | null {
  if (severity === 1) return 'error';
  if (severity === 2) return 'warning';
  return null;
}

/** Minimum gap between cues so a burst of events doesn't become noise. */
export const MIN_CUE_GAP_MS = 400;

/** True when a cue should be suppressed because one played too recently. */
export function shouldThrottle(
  lastPlayedAt: number,
  now: number,
  minGapMs: number = MIN_CUE_GAP_MS,
): boolean {
  const gap = Number.isFinite(minGapMs) && minGapMs > 0 ? minGapMs : MIN_CUE_GAP_MS;
  return now - lastPlayedAt < gap;
}

/** A short human summary of the active cue configuration. */
export function summarizeCues(prefs: CuePrefs): string {
  if (!prefs.enabled) return 'Audio cues off.';
  const on = ALL_CUE_EVENTS.filter((e) => isCueEnabled(e, prefs));
  return on.length > 0 ? `Audio cues: ${on.join(', ')}.` : 'Audio cues on (none selected).';
}
