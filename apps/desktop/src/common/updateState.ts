/**
 * Update UI state machine (UPDATEFEATURE §8/§10 — professional update windows).
 *
 * PURE module (no I/O, no Electron, no React). The main process streams update
 * lifecycle EVENTS to the renderer; this reducer folds them into the state the
 * UpdateDialog + MandatoryUpdateGuard render (checking → available → downloading →
 * verifying → ready → installing, plus up-to-date/unavailable/error). It also
 * CLASSIFIES failures into user-actionable kinds and formats the progress readout.
 * Deterministic + smoke-tested so the UI stays a thin projection of this state.
 */

import type { UpdatePlan } from './updateConfig';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'unavailable'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error';

export type UpdateErrorKind =
  'offline' | 'server' | 'corrupt' | 'interrupted' | 'permission' | 'disk' | 'install' | 'unknown';

export interface UpdateUiState {
  phase: UpdatePhase;
  /** Download progress 0–100 (0 outside the downloading phase). */
  progress: number;
  transferred: number;
  total: number;
  message: string;
  errorKind: UpdateErrorKind | null;
  /** True ⇒ the mandatory-update guard must block the whole app. */
  mustBlock: boolean;
  plan: UpdatePlan | null;
  /** True once the current plan's installer has been downloaded and verified. */
  downloaded: boolean;
}

export const initialUpdateState: UpdateUiState = {
  phase: 'idle',
  progress: 0,
  transferred: 0,
  total: 0,
  message: '',
  errorKind: null,
  mustBlock: false,
  plan: null,
  downloaded: false,
};

/** An unversioned lifecycle change folded into the authoritative UI state by main. */
export type UpdateEventPayload =
  | { type: 'checking' }
  | { type: 'up-to-date'; plan: UpdatePlan }
  | { type: 'unavailable' }
  | { type: 'available'; plan: UpdatePlan }
  | { type: 'progress'; transferred: number; total: number; percent: number }
  | { type: 'verifying' }
  | { type: 'ready'; plan: UpdatePlan }
  | { type: 'installing' }
  | { type: 'error'; kind: UpdateErrorKind; message: string };

/** Versioned status envelope sent through the existing IPC/preload event bridge. */
export interface UpdateEvent {
  revision: number;
  event: UpdateEventPayload;
  /** Complete state after folding `event`; safe to apply without prior events. */
  state: UpdateUiState;
}

/** Fold one lifecycle event into the UI state (pure). */
export function reduceUpdate(state: UpdateUiState, event: UpdateEventPayload): UpdateUiState {
  switch (event.type) {
    case 'checking':
      return { ...state, phase: 'checking', message: 'Checking for updates…', errorKind: null };
    case 'up-to-date':
      return {
        ...initialUpdateState,
        phase: 'up-to-date',
        message: 'You are on the latest version.',
        plan: event.plan,
      };
    case 'unavailable':
      return {
        ...initialUpdateState,
        phase: 'unavailable',
        message:
          'Update information is currently unavailable. Check your internet connection or try again later.',
      };
    case 'available':
      return {
        ...state,
        phase: 'available',
        message: event.plan.reason,
        mustBlock: event.plan.mustBlock,
        plan: event.plan,
        downloaded: false,
        errorKind: null,
      };
    case 'progress': {
      const percent = Math.max(0, Math.min(100, Math.round(event.percent)));
      return {
        ...state,
        phase: 'downloading',
        progress: percent,
        transferred: Math.max(0, event.transferred),
        total: Math.max(0, event.total),
        message: 'Downloading update…',
        downloaded: false,
      };
    }
    case 'verifying':
      return {
        ...state,
        phase: 'verifying',
        progress: 100,
        message: 'Verifying update…',
        downloaded: false,
      };
    case 'ready':
      return {
        ...state,
        phase: 'ready',
        progress: 100,
        message: 'Update ready — restart to install.',
        mustBlock: event.plan.mustBlock,
        plan: event.plan,
        downloaded: true,
      };
    case 'installing':
      return { ...state, phase: 'installing', message: 'Installing update…' };
    case 'error':
      return {
        ...state,
        phase: 'error',
        errorKind: event.kind,
        message: event.message,
      };
    default:
      return state;
  }
}

/** Classify a thrown error / Node error code into a user-actionable kind. */
export function classifyError(err: unknown): UpdateErrorKind {
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  const hay = `${code} ${msg}`.toLowerCase();

  if (/enotfound|eai_again|enetunreach|enetdown|offline|getaddrinfo|dns/.test(hay))
    return 'offline';
  if (/enospc|no space|disk full|not enough space/.test(hay)) return 'disk';
  if (/eacces|eperm|permission|access is denied|elevation/.test(hay)) return 'permission';
  if (/checksum|sha-?256|hash mismatch|integrity|corrupt/.test(hay)) return 'corrupt';
  if (/econnreset|etimedout|esockettimedout|aborted|interrupted|socket hang up/.test(hay))
    return 'interrupted';
  if (/http (5\d\d|4\d\d)|server|unavailable|503|502|500|not found|404/.test(hay)) return 'server';
  if (/install|quitandinstall|nsis|squirrel|setup/.test(hay)) return 'install';
  return 'unknown';
}

const ERROR_MESSAGES: Record<UpdateErrorKind, string> = {
  offline: 'No internet connection. Axiom will retry automatically.',
  server: 'The update server is unavailable. Please try again later.',
  corrupt: 'The downloaded update failed its integrity check and was discarded.',
  interrupted: 'The download was interrupted. Axiom will resume when possible.',
  permission: 'Insufficient permissions to install the update. Try running as administrator.',
  disk: 'Not enough disk space to download the update.',
  install: 'The update could not be installed. The previous version is intact.',
  unknown: 'An unexpected error occurred while updating.',
};

/** A friendly, actionable message for an error kind. */
export function errorMessage(kind: UpdateErrorKind): string {
  return ERROR_MESSAGES[kind];
}

/** Format a byte count as a compact human string (e.g. "45.6 MB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Progress readout, e.g. "12.3 MB / 45.6 MB (27%)". */
export function progressText(state: UpdateUiState): string {
  if (state.total <= 0) return `${state.progress}%`;
  return `${formatBytes(state.transferred)} / ${formatBytes(state.total)} (${state.progress}%)`;
}

const PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: '',
  checking: 'Checking for updates',
  'up-to-date': 'Up to date',
  unavailable: 'Update information unavailable',
  available: 'Update available',
  downloading: 'Downloading',
  verifying: 'Verifying',
  ready: 'Restart to update',
  installing: 'Installing',
  error: 'Update error',
};

export function phaseLabel(phase: UpdatePhase): string {
  return PHASE_LABELS[phase];
}

/** An atomic authoritative snapshot used to hydrate a late-subscribing renderer. */
export interface UpdateSnapshot {
  revision: number;
  state: UpdateUiState;
}
