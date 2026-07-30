/**
 * AI quick-action lightbulb + hover-explain (PRD Phase 189 — Quick Actions, Hover
 * Explain & Lightbulb). Complements the editor context-menu AI actions with:
 *   • a CODE-ACTION provider so Explain / Refactor / Fix / Add-Docs appear in the
 *     Monaco lightbulb (Ctrl+.) on the current selection or line, and
 *   • a HOVER provider that offers an "Explain this" trusted command link.
 * Both route through the existing {@link requestAiAction} bus (reveal AI panel →
 * deliver to chat). Registered ONCE (Monaco language providers are global), so this
 * is import-idempotent and safe across editor re-mounts.
 */
import * as monaco from 'monaco-editor';
import { requestAiAction, type AiActionKind, type AiEditorAction } from './aiActionBus';
import type { ExplainDepth } from '../../../common/explain';

const CMD_ID = 'axiom.ai.runFromLightbulb';

let registered = false;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function buildRequest(
  model: monaco.editor.ITextModel,
  range: monaco.IRange,
  kind: AiActionKind,
  depth?: ExplainDepth,
): AiEditorAction {
  const req: AiEditorAction = {
    kind,
    code: model.getValueInRange(range),
    fileLabel: baseName(model.uri.path),
    language: model.getLanguageId(),
    startLine: range.startLineNumber,
    endLine: range.endLineNumber,
  };
  if (depth) req.depth = depth;
  return req;
}

/** Register the AI lightbulb + hover-explain providers exactly once. */
export function registerAiEditorProviders(): void {
  if (registered) return;
  registered = true;

  // A single command both the lightbulb code-actions and the hover link invoke.
  monaco.editor.registerCommand(CMD_ID, (_accessor, action: AiEditorAction) => {
    if (action && typeof action.code === 'string') requestAiAction(action);
  });

  const SPECS: ReadonlyArray<{ title: string; kind: AiActionKind; depth?: ExplainDepth }> = [
    { title: 'Axiom AI: Explain', kind: 'explain', depth: 'normal' },
    { title: 'Axiom AI: Refactor', kind: 'refactor' },
    { title: 'Axiom AI: Fix / Improve', kind: 'fix' },
    { title: 'Axiom AI: Add Docs', kind: 'docstring' },
  ];

  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions: (model, range) => {
      // Use the selection when there is one, else the current line.
      const hasSelection = model.getValueInRange(range).trim().length > 0;
      const effRange: monaco.IRange = hasSelection
        ? range
        : {
            startLineNumber: range.startLineNumber,
            startColumn: 1,
            endLineNumber: range.startLineNumber,
            endColumn: model.getLineMaxColumn(range.startLineNumber),
          };
      if (model.getValueInRange(effRange).trim().length === 0) {
        return { actions: [], dispose: () => undefined };
      }
      const actions: monaco.languages.CodeAction[] = SPECS.map((s) => ({
        title: s.title,
        kind: 'refactor',
        command: {
          id: CMD_ID,
          title: s.title,
          arguments: [buildRequest(model, effRange, s.kind, s.depth)],
        },
      }));
      return { actions, dispose: () => undefined };
    },
  });

  monaco.languages.registerHoverProvider('*', {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const lineRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: model.getLineMaxColumn(position.lineNumber),
      };
      if (model.getValueInRange(lineRange).trim().length === 0) return null;
      const args = encodeURIComponent(
        JSON.stringify([buildRequest(model, lineRange, 'explain', 'brief')]),
      );
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents: [
          {
            value: `[$(sparkle) Axiom AI: Explain this line](command:${CMD_ID}?${args} "Explain with Axiom AI")`,
            isTrusted: true,
            supportThemeIcons: true,
          },
        ],
      };
    },
  });
}
