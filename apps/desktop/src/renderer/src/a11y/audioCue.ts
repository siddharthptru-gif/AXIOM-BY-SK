import { onNotification } from '../notifications/bus';
import {
  selectCue,
  cueForLevel,
  shouldThrottle,
  type CueDef,
  type CuePrefs,
} from '../../../common/audioCues';

/**
 * Audio-cue player (PRD Epoch I §94 / Phase 254). Subscribes to the notification bus
 * and plays a short WebAudio tone for error/warning notifications when audio cues
 * are enabled (setting a11y.audioCues) — an accessibility aid so problems are
 * audible without looking. All cue selection + throttling is the pure
 * `common/audioCues` module; this only synthesizes the tone. Best-effort: if
 * WebAudio is unavailable it silently no-ops.
 */
let ctx: AudioContext | null = null;
let lastPlayed = 0;

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function oscType(kind: CueDef['kind']): OscillatorType {
  if (kind === 'buzz') return 'sawtooth';
  if (kind === 'ding') return 'sine';
  return 'triangle';
}

function playCue(def: CueDef): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    const gapMs = def.durationMs + 60;
    for (let i = 0; i < def.pulses; i++) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = oscType(def.kind);
      osc.frequency.value = def.freq;
      const start = ac.currentTime + (i * gapMs) / 1000;
      const end = start + def.durationMs / 1000;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* audio is best-effort */
  }
}

/**
 * Install the notification→audio-cue bridge. `getPrefs` is read fresh on each
 * notification so live setting changes take effect. Returns an unsubscribe fn.
 */
export function installAudioCues(getPrefs: () => CuePrefs): () => void {
  return onNotification((n) => {
    const prefs = getPrefs();
    if (!prefs.enabled) return;
    const def = selectCue(cueForLevel(n.level), prefs);
    if (!def) return;
    const now = Date.now();
    if (shouldThrottle(lastPlayed, now)) return;
    lastPlayed = now;
    playCue(def);
  });
}
