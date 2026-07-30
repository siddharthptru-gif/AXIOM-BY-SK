import { monaco } from './monacoEnv';
import type { VimAction, VimMode, VimMotion } from '../../../common/vim';

/**
 * Vim action translator (PRD Phase 249). Turns the pure state machine's abstract
 * VimActions (see common/vim.ts) into Monaco editor commands. Motions use Monaco's
 * built-in cursor commands (the `*Select` variants when in visual mode so the
 * selection extends), keeping this layer thin and the modal logic pure + tested.
 */
type Editor = monaco.editor.IStandaloneCodeEditor;

const MOTION_CMD: Record<VimMotion, { normal: string; select: string }> = {
  left: { normal: 'cursorLeft', select: 'cursorLeftSelect' },
  right: { normal: 'cursorRight', select: 'cursorRightSelect' },
  up: { normal: 'cursorUp', select: 'cursorUpSelect' },
  down: { normal: 'cursorDown', select: 'cursorDownSelect' },
  wordForward: { normal: 'cursorWordStartRight', select: 'cursorWordStartRightSelect' },
  wordBackward: { normal: 'cursorWordStartLeft', select: 'cursorWordStartLeftSelect' },
  lineStart: { normal: 'cursorHome', select: 'cursorHomeSelect' },
  lineEnd: { normal: 'cursorEnd', select: 'cursorEndSelect' },
  fileStart: { normal: 'cursorTop', select: 'cursorTopSelect' },
  fileEnd: { normal: 'cursorBottom', select: 'cursorBottomSelect' },
};

function trigger(editor: Editor, id: string, times = 1): void {
  for (let i = 0; i < Math.max(1, times); i++) editor.trigger('vim', id, null);
}

function collapseSelection(editor: Editor): void {
  const pos = editor.getPosition();
  if (pos) {
    editor.setSelection(new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column));
  }
}

/** Apply the actions from handleVimKey. `mode` is the resulting Vim mode. */
export function applyVimActions(
  editor: Editor,
  actions: readonly VimAction[],
  mode: VimMode,
): void {
  for (const action of actions) {
    switch (action.type) {
      case 'move': {
        const cmd = MOTION_CMD[action.motion];
        trigger(editor, mode === 'visual' ? cmd.select : cmd.normal, action.count);
        break;
      }
      case 'enterInsert': {
        if (action.placement === 'after') trigger(editor, 'cursorRight');
        else if (action.placement === 'lineStart') trigger(editor, 'cursorHome');
        else if (action.placement === 'lineEnd') trigger(editor, 'cursorEnd');
        else if (action.placement === 'openBelow') trigger(editor, 'editor.action.insertLineAfter');
        else if (action.placement === 'openAbove')
          trigger(editor, 'editor.action.insertLineBefore');
        break;
      }
      case 'enterVisual':
        break; // the selection grows via subsequent *Select motions
      case 'enterNormal':
        collapseSelection(editor);
        break;
      case 'deleteChar':
        trigger(editor, 'deleteRight', action.count);
        break;
      case 'deleteWord':
        trigger(editor, 'deleteWordRight', action.count);
        break;
      case 'deleteLine':
        trigger(editor, 'editor.action.deleteLines', action.count);
        break;
      case 'deleteSelection':
        trigger(editor, 'deleteRight');
        break;
      case 'undo':
        trigger(editor, 'undo');
        break;
      case 'paste':
        trigger(editor, 'editor.action.clipboardPasteAction');
        break;
      default:
        break;
    }
  }
}
