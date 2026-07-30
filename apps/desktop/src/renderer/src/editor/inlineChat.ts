import { monaco } from './monacoEnv';
import { runInlineEdit } from './inlineEdit';

/**
 * Inline chat (Cmd-I) widget (PRD Epoch G §129.4 / Phase 188). An anchored bubble at
 * the cursor for a quick, read-only question about the selected code (or current
 * line). Shows a one-shot answer and can escalate to the inline edit action
 * (Phase 187) via "Edit with AI". Lightweight — for anything larger, the full chat
 * panel is one click away. Only one widget is active at a time.
 */
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;
const WIDGET_ID = 'axiom.inlineChat.widget';

type Editor = monaco.editor.IStandaloneCodeEditor;

let active: { dispose: () => void } | null = null;

export function runInlineChat(editor: Editor, activePath: string | null): void {
  active?.dispose();
  const model = editor.getModel();
  if (!model || model.uri.scheme !== 'file') return;

  const sel0 = editor.getSelection();
  if (!sel0) return;
  const hasSelection = !sel0.isEmpty();
  const sel = hasSelection
    ? sel0
    : new monaco.Selection(
        sel0.startLineNumber,
        1,
        sel0.startLineNumber,
        model.getLineMaxColumn(sel0.startLineNumber),
      );

  const selection = model.getValueInRange(sel);
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

  let busy = false;

  const dom = document.createElement('div');
  dom.className = 'axiom-inline-chat';
  const input = document.createElement('textarea');
  input.className = 'axiom-inline-chat-input';
  input.rows = 1;
  input.placeholder = 'Ask about this code\u2026  (Enter to ask, Esc to close)';
  input.spellcheck = false;
  const answer = document.createElement('div');
  answer.className = 'axiom-inline-chat-answer';
  answer.style.display = 'none';
  const status = document.createElement('div');
  status.className = 'axiom-inline-chat-status';
  const actions = document.createElement('div');
  actions.className = 'axiom-inline-chat-actions';
  dom.append(input, answer, status, actions);

  const widget: monaco.editor.IContentWidget = {
    getId: () => WIDGET_ID,
    getDomNode: () => dom,
    getPosition: () => ({
      position: { lineNumber: sel.endLineNumber, column: sel.endColumn },
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    }),
  };

  function dispose(): void {
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
      el.className = `axiom-inline-chat-btn${b.cls ? ' ' + b.cls : ''}`;
      el.textContent = b.label;
      el.addEventListener('click', b.on);
      actions.append(el);
    }
  }

  function escalateToEdit(): void {
    dispose();
    // Re-open the Cmd-K inline edit on the same selection.
    editor.setSelection(sel);
    runInlineEdit(editor, activePath);
  }

  async function ask(): Promise<void> {
    if (busy) return;
    const question = input.value.trim();
    if (question.length === 0) return;
    busy = true;
    status.textContent = 'Thinking\u2026';
    setActions([{ label: 'Cancel', on: () => dispose() }]);
    try {
      const res = await window.axiom.ai.inlineChat({
        question,
        selection,
        language,
        ...(filename ? { filename } : {}),
        prefix,
        suffix,
      });
      busy = false;
      if (res.error) {
        status.textContent = res.error;
        setActions([
          { label: 'Retry', on: () => void ask() },
          { label: 'Close', on: () => dispose() },
        ]);
        return;
      }
      status.textContent = '';
      answer.textContent = res.text;
      answer.style.display = '';
      input.style.display = 'none';
      setActions([
        { label: 'Edit with AI', cls: 'is-primary', on: escalateToEdit },
        { label: 'Ask again', on: () => resetToInput() },
        { label: 'Close', on: () => dispose() },
      ]);
    } catch (e) {
      busy = false;
      status.textContent = e instanceof Error ? e.message : 'Inline chat failed.';
      setActions([
        { label: 'Retry', on: () => void ask() },
        { label: 'Close', on: () => dispose() },
      ]);
    }
  }

  function resetToInput(): void {
    answer.style.display = 'none';
    answer.textContent = '';
    input.style.display = '';
    input.value = '';
    status.textContent = '';
    setActions([]);
    input.focus();
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dispose();
    }
  });

  editor.addContentWidget(widget);
  setTimeout(() => input.focus(), 0);
}
