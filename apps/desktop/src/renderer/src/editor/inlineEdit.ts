import { monaco } from './monacoEnv';
import { isMeaningfulEdit } from '../../../common/inlineEdit';
import { notifyInfo } from '../notifications/bus';

/**
 * Inline edit (Cmd-K) widget (PRD Epoch G §129.3 / Phase 187). Anchored input bar
 * over the current selection (or line): the user describes a change, the model
 * rewrites just that region, and the result is applied as a single undoable Monaco
 * edit — snapshot-protected first — then shown as an inline diff decoration with
 * Accept / Reject / Refine. Region-scoped and fully reversible (INV: reviewable +
 * undoable). Only one widget is active at a time.
 */
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;
const WIDGET_ID = 'axiom.inlineEdit.widget';

type Editor = monaco.editor.IStandaloneCodeEditor;

let active: { dispose: () => void } | null = null;

/** Compute the range that `text` occupies when inserted at (startLine, startCol). */
function insertedRange(startLine: number, startCol: number, text: string): monaco.Range {
  const lines = text.split('\n');
  const last = lines.length - 1;
  const endLine = startLine + last;
  const endCol = last === 0 ? startCol + text.length : (lines[last]?.length ?? 0) + 1;
  return new monaco.Range(startLine, startCol, endLine, endCol);
}

export function runInlineEdit(editor: Editor, activePath: string | null): void {
  active?.dispose();
  const model = editor.getModel();
  if (!model || model.uri.scheme !== 'file') return;

  const sel0 = editor.getSelection();
  if (!sel0) return;
  const sel = sel0.isEmpty()
    ? new monaco.Selection(
        sel0.startLineNumber,
        1,
        sel0.startLineNumber,
        model.getLineMaxColumn(sel0.startLineNumber),
      )
    : sel0;

  const original = model.getValueInRange(sel);
  const language = model.getLanguageId();
  const filename = activePath ? (activePath.split(/[\\/]/).pop() ?? activePath) : undefined;
  const full = model.getValue();
  const startOffset = model.getOffsetAt({
    lineNumber: sel.startLineNumber,
    column: sel.startColumn,
  });
  const endOffset = model.getOffsetAt({ lineNumber: sel.endLineNumber, column: sel.endColumn });
  const prefix = full.slice(Math.max(0, startOffset - PREFIX_CHARS), startOffset);
  const suffix = full.slice(endOffset, endOffset + SUFFIX_CHARS);

  // The region currently holding the selection text (moves after an apply).
  let currentRange = new monaco.Range(
    sel.startLineNumber,
    sel.startColumn,
    sel.endLineNumber,
    sel.endColumn,
  );
  const decorations = editor.createDecorationsCollection([]);
  let lastInstruction = '';
  let busy = false;

  // ---- DOM ----
  const dom = document.createElement('div');
  dom.className = 'axiom-inline-edit';
  const input = document.createElement('textarea');
  input.className = 'axiom-inline-edit-input';
  input.rows = 1;
  input.placeholder = 'Describe the edit\u2026  (Enter to generate, Esc to cancel)';
  input.spellcheck = false;
  const status = document.createElement('div');
  status.className = 'axiom-inline-edit-status';
  const actions = document.createElement('div');
  actions.className = 'axiom-inline-edit-actions';
  dom.append(input, status, actions);

  const widget: monaco.editor.IContentWidget = {
    getId: () => WIDGET_ID,
    getDomNode: () => dom,
    getPosition: () => ({
      position: { lineNumber: currentRange.startLineNumber, column: currentRange.startColumn },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    }),
  };

  function dispose(): void {
    decorations.clear();
    editor.removeContentWidget(widget);
    if (active && active.dispose === dispose) active = null;
    editor.focus();
  }
  active = { dispose };

  function setActions(buttons: Array<{ label: string; cls?: string; on: () => void }>): void {
    actions.textContent = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `axiom-inline-edit-btn${b.cls ? ' ' + b.cls : ''}`;
      el.textContent = b.label;
      el.addEventListener('click', b.on);
      actions.append(el);
    }
  }

  // Revert the applied edit back to the original selection text.
  function revert(): void {
    editor.pushUndoStop();
    editor.executeEdits('axiom.inlineEdit.revert', [
      { range: currentRange, text: original, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
    currentRange = insertedRange(currentRange.startLineNumber, currentRange.startColumn, original);
    decorations.clear();
  }

  function toInputPhase(): void {
    status.textContent = '';
    input.style.display = '';
    input.value = lastInstruction;
    setActions([]);
    input.focus();
    input.select();
  }

  function applyResult(text: string): void {
    editor.pushUndoStop();
    editor.executeEdits('axiom.inlineEdit', [
      { range: currentRange, text, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
    currentRange = insertedRange(currentRange.startLineNumber, currentRange.startColumn, text);
    decorations.set([
      {
        range: currentRange,
        options: {
          className: 'axiom-inline-edit-changed',
          isWholeLine: false,
          overviewRuler: {
            color: 'rgba(120,170,255,0.6)',
            position: monaco.editor.OverviewRulerLane.Center,
          },
        },
      },
    ]);
    input.style.display = 'none';
    status.textContent = 'Review the change:';
    setActions([
      {
        label: 'Accept',
        cls: 'is-primary',
        on: () => {
          notifyInfo('Inline edit applied.', { source: 'Axiom AI' });
          dispose();
        },
      },
      {
        label: 'Reject',
        on: () => {
          revert();
          dispose();
        },
      },
      {
        label: 'Refine',
        on: () => {
          revert();
          toInputPhase();
        },
      },
    ]);
  }

  async function generate(): Promise<void> {
    if (busy) return;
    const instruction = input.value.trim();
    if (instruction.length === 0) return;
    lastInstruction = instruction;
    busy = true;
    status.textContent = 'Generating\u2026';
    setActions([{ label: 'Cancel', on: () => dispose() }]);
    try {
      // Snapshot-protect the file before any edit (best-effort; PRD Phase 187/171).
      if (activePath) {
        try {
          await window.axiom.snapshots.capture([activePath], 'Inline edit (Cmd-K)');
        } catch {
          /* snapshot is best-effort */
        }
      }
      const res = await window.axiom.ai.inlineEdit({
        instruction,
        selection: original,
        language,
        ...(filename ? { filename } : {}),
        prefix,
        suffix,
      });
      busy = false;
      if (res.error) {
        status.textContent = res.error;
        setActions([
          { label: 'Retry', on: () => void generate() },
          { label: 'Cancel', on: () => dispose() },
        ]);
        return;
      }
      if (!isMeaningfulEdit(original, res.text)) {
        status.textContent = 'No change suggested. Try rephrasing.';
        toInputPhaseKeepStatus();
        return;
      }
      applyResult(res.text);
    } catch (e) {
      busy = false;
      status.textContent = e instanceof Error ? e.message : 'Inline edit failed.';
      setActions([
        { label: 'Retry', on: () => void generate() },
        { label: 'Cancel', on: () => dispose() },
      ]);
    }
  }

  function toInputPhaseKeepStatus(): void {
    input.style.display = '';
    input.value = lastInstruction;
    setActions([
      { label: 'Generate', cls: 'is-primary', on: () => void generate() },
      { label: 'Cancel', on: () => dispose() },
    ]);
    input.focus();
    input.select();
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void generate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dispose();
    }
  });

  editor.addContentWidget(widget);
  status.textContent = original.trim().length === 0 ? 'Editing the current line' : '';
  setTimeout(() => input.focus(), 0);
}
