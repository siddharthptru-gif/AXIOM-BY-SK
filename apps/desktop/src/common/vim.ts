/**
 * Vim-mode foundation (PRD Epoch I §115 / Phase 249). A pure, editor-agnostic modal
 * state machine: given the current state and a normalized key, it returns the new
 * state plus abstract actions for the editor to apply, and whether the key was
 * consumed. No Monaco, no DOM — the renderer translates `VimAction`s into editor
 * commands (see renderer/src/editor/vimEditor.ts), so all the modal logic here is
 * fully unit-testable. This is a foundation subset (motions, insert entries, delete,
 * counts, visual selection), not full Vim.
 */

export type VimMode = 'normal' | 'insert' | 'visual';

export interface VimState {
  mode: VimMode;
  /** Pending numeric count as typed (e.g. "12"); empty when none. */
  count: string;
  /** Pending operator awaiting a target ('d', 'g'); empty when none. */
  pending: string;
}

export const INITIAL_VIM_STATE: VimState = { mode: 'normal', count: '', pending: '' };

export type VimMotion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'wordForward'
  | 'wordBackward'
  | 'lineStart'
  | 'lineEnd'
  | 'fileStart'
  | 'fileEnd';

export type InsertPlacement =
  'before' | 'after' | 'lineStart' | 'lineEnd' | 'openBelow' | 'openAbove';

export type VimAction =
  | { type: 'move'; motion: VimMotion; count: number }
  | { type: 'enterInsert'; placement: InsertPlacement }
  | { type: 'enterVisual' }
  | { type: 'enterNormal' }
  | { type: 'deleteChar'; count: number }
  | { type: 'deleteLine'; count: number }
  | { type: 'deleteWord'; count: number }
  | { type: 'deleteSelection' }
  | { type: 'undo' }
  | { type: 'paste'; before: boolean };

export interface VimResult {
  state: VimState;
  actions: VimAction[];
  /** True when Vim consumed the key (the editor should preventDefault). */
  handled: boolean;
}

function parseCount(count: string): number {
  const n = parseInt(count || '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const NORMAL: VimState = { mode: 'normal', count: '', pending: '' };

/**
 * Advance the Vim state machine by one key. `key` is a normalized key name: a single
 * printable character ('h', '$', '0', 'G', …) or 'Escape'. In insert mode only
 * Escape is handled (everything else passes through to the editor as text).
 */
export function handleVimKey(state: VimState, key: string): VimResult {
  // --- Insert mode: only Escape is handled; all other keys pass through. -----
  if (state.mode === 'insert') {
    if (key === 'Escape') {
      return { state: NORMAL, actions: [{ type: 'enterNormal' }], handled: true };
    }
    return { state, actions: [], handled: false };
  }

  const mode = state.mode; // 'normal' | 'visual'

  if (key === 'Escape') {
    return { state: NORMAL, actions: [{ type: 'enterNormal' }], handled: true };
  }

  // --- Pending operator: d (dd / dw) or g (gg). ------------------------------
  if (state.pending === 'd') {
    const count = parseCount(state.count);
    const reset: VimState = { mode, count: '', pending: '' };
    if (key === 'd')
      return { state: reset, actions: [{ type: 'deleteLine', count }], handled: true };
    if (key === 'w')
      return { state: reset, actions: [{ type: 'deleteWord', count }], handled: true };
    return { state: reset, actions: [], handled: true }; // unknown target — cancel
  }
  if (state.pending === 'g') {
    const reset: VimState = { mode, count: '', pending: '' };
    if (key === 'g') {
      return {
        state: reset,
        actions: [{ type: 'move', motion: 'fileStart', count: 1 }],
        handled: true,
      };
    }
    return { state: reset, actions: [], handled: true };
  }

  // --- Count accumulation ('0' is a motion only when no count is pending). ---
  if (/^[1-9]$/.test(key) || (key === '0' && state.count !== '')) {
    return { state: { ...state, count: state.count + key }, actions: [], handled: true };
  }

  const count = parseCount(state.count);
  const cleared: VimState = { mode, count: '', pending: '' };
  const motion = (m: VimMotion): VimResult => ({
    state: cleared,
    actions: [{ type: 'move', motion: m, count }],
    handled: true,
  });
  const enterInsert = (placement: InsertPlacement): VimResult => ({
    state: { mode: 'insert', count: '', pending: '' },
    actions: [{ type: 'enterInsert', placement }],
    handled: true,
  });

  switch (key) {
    case 'h':
      return motion('left');
    case 'l':
      return motion('right');
    case 'j':
      return motion('down');
    case 'k':
      return motion('up');
    case 'w':
      return motion('wordForward');
    case 'b':
      return motion('wordBackward');
    case '0':
      return motion('lineStart');
    case '$':
      return motion('lineEnd');
    case 'G':
      return motion('fileEnd');
    case 'g':
      return { state: { ...state, pending: 'g' }, actions: [], handled: true };
    case 'i':
      return enterInsert('before');
    case 'a':
      return enterInsert('after');
    case 'I':
      return enterInsert('lineStart');
    case 'A':
      return enterInsert('lineEnd');
    case 'o':
      return enterInsert('openBelow');
    case 'O':
      return enterInsert('openAbove');
    case 'x':
      return mode === 'visual'
        ? { state: NORMAL, actions: [{ type: 'deleteSelection' }], handled: true }
        : { state: cleared, actions: [{ type: 'deleteChar', count }], handled: true };
    case 'd':
      return mode === 'visual'
        ? { state: NORMAL, actions: [{ type: 'deleteSelection' }], handled: true }
        : { state: { ...state, pending: 'd' }, actions: [], handled: true };
    case 'v':
      return mode === 'visual'
        ? { state: NORMAL, actions: [{ type: 'enterNormal' }], handled: true }
        : {
            state: { mode: 'visual', count: '', pending: '' },
            actions: [{ type: 'enterVisual' }],
            handled: true,
          };
    case 'u':
      return { state: cleared, actions: [{ type: 'undo' }], handled: true };
    case 'p':
      return { state: cleared, actions: [{ type: 'paste', before: false }], handled: true };
    case 'P':
      return { state: cleared, actions: [{ type: 'paste', before: true }], handled: true };
    default:
      // Normal/visual mode swallows unmapped keys (clearing any pending count).
      return { state: cleared, actions: [], handled: true };
  }
}

/** Short status label for the current mode ('-- NORMAL --' style). */
export function vimModeLabel(mode: VimMode): string {
  return mode === 'normal' ? 'NORMAL' : mode === 'insert' ? 'INSERT' : 'VISUAL';
}
