/**
 * Command-palette parity for editor AI actions (T3.15).
 *
 * Every AI action lived only on the editor context menu, which makes it invisible to
 * keyboard users and to anyone searching the palette. This table is the single source
 * of truth mapping a workbench command to the Monaco action it delegates to, so the
 * palette, the keybinding layer, and the context menu can never drift apart.
 *
 * Pure data — App registers these, and each `run` delegates through the
 * active-editor bus so it always targets the focused pane.
 */
export interface AiEditorCommand {
  /** Workbench command id (namespaced, stable). */
  id: string;
  title: string;
  category: string;
  /** The Monaco action id registered by EditorPane. */
  editorAction: string;
}

export const AI_EDITOR_COMMANDS: readonly AiEditorCommand[] = [
  {
    id: 'workbench.action.ai.explain',
    title: 'AI: Explain Selection',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.explain',
  },
  {
    id: 'workbench.action.ai.explainBrief',
    title: 'AI: Explain Selection (brief)',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.explain.brief',
  },
  {
    id: 'workbench.action.ai.explainDeep',
    title: 'AI: Explain Selection (in depth)',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.explain.deep',
  },
  {
    id: 'workbench.action.ai.refactor',
    title: 'AI: Refactor Selection',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.refactor',
  },
  {
    id: 'workbench.action.ai.fixSelection',
    title: 'AI: Fix / Improve Selection',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.fix',
  },
  {
    id: 'workbench.action.ai.docstring',
    title: 'AI: Add Docs To Selection',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.docstring',
  },
  {
    id: 'workbench.action.ai.inlineEdit',
    title: 'AI: Inline Edit At Cursor',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.inlineEdit',
  },
  {
    id: 'workbench.action.ai.inlineChat',
    title: 'AI: Inline Chat At Cursor',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.inlineChat',
  },
  {
    id: 'workbench.action.ai.acceptChange',
    title: 'AI Review: Accept This Change',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.review.acceptHunk',
  },
  {
    id: 'workbench.action.ai.revertChange',
    title: 'AI Review: Revert This Change',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.review.revertHunk',
  },
  {
    id: 'workbench.action.ai.acceptFileChanges',
    title: 'AI Review: Accept All Changes In This File',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.review.acceptFile',
  },
  {
    id: 'workbench.action.ai.revertFileChanges',
    title: 'AI Review: Revert All Changes In This File',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.review.revertFile',
  },
  {
    id: 'workbench.action.ai.nextChange',
    title: 'AI Review: Go To Next AI Change',
    category: 'Axiom AI',
    editorAction: 'axiom.ai.review.nextChange',
  },
] as const;
