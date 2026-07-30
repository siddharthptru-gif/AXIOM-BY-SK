import { useCallback, useEffect, useMemo, useRef } from 'react';
import { monaco, ensureAxiomTheme, currentMonacoTheme } from './monacoEnv';
import { languageForPath } from './language';
import { useWorkspace, isUntitledPath } from '../state/workspace';
import { useSettings } from '../settings/store';
import {
  getEditorSettings,
  getAutoSaveSettings,
  getOnSaveHygiene,
  type AutoSaveSettings,
  type OnSaveHygiene,
} from '../settings/schema';
import { notifyError, notifyInfo } from '../notifications/bus';
import { emitFileSaved } from '../state/fileEvents';
import { addSaver, type SaveResult } from './saveBus';
import { setLanguageSetter } from './languageBus';
import { setEolSetter, type EolKind } from './eolBus';
import { setIndentActions, type IndentInfo } from './indentBus';
import { setActiveEditor, setActiveCursor } from './activeEditorBus';
import { revealAgentEdit } from './agentTyping';
import { settleAgentTyping, subscribeAgentTyping } from './agentTypingBus';
import { requestAiAction, type AiActionKind } from './aiActionBus';
import { registerAiEditorProviders } from './aiCodeActions';
import { showCallHierarchy } from './callHierarchyBus';
import { showHierarchy } from './hierarchyBus';
import { inlineValueContext, subscribeInlineValues } from './inlineValuesBus';
import {
  onExtensionProviderChanged,
  prepareCallHierarchy,
  prepareTypeHierarchy,
  queryInlineValues,
} from './extensionProviders';
import {
  composeInlineValueDecorations,
  findInlineVariable,
  inlineValueKey,
  inlineValueRequests,
  planInlineValues,
  sameInlineValuePath,
  type InlineValueRequest,
} from '../../../common/inlineValues';
import type { DebugVariable, LspRange } from '../../../common/ipc';
import type { RefLocation } from '../../../common/callHierarchy';
import { runInlineEdit } from './inlineEdit';
import { runInlineChat } from './inlineChat';
import type { ExplainDepth } from '../../../common/explain';
import { diffLineToken, predictNextEdit, type Occurrence } from '../../../common/nextEdit';
import { toggleBreakpoint, linesFor, subscribeBreakpoints } from './breakpoints';
import {
  clearAiReview,
  getAiReview,
  resolveAiReviewHunk,
  subscribeAiReviews,
} from './aiEditReviewBus';
import { isDeletionOnly, type AiReviewHunk } from '../../../common/aiEditReview';
import { getSavedVersion, setSavedVersion, clearSavedVersion } from './savedVersions';
import {
  classifyFileForEditor,
  NORMAL_FILE_CLASS,
  type EditorFileClass,
} from '../../../common/largeFile';
import { parseKeymap } from '../../../common/keymaps';
import { handleVimKey, INITIAL_VIM_STATE, type VimState } from '../../../common/vim';
import { applyVimActions } from './vimEditor';
import { setVimStatus } from './vimBus';
import { editorAriaLabel, announceForFileOpen } from '../../../common/a11y';
import { announce } from '../a11y/announcer';

/** Single-pass metrics (byte proxy, line count, longest line) for large-file mode. */
function computeFileMetrics(
  content: string,
  truncated: boolean,
): { bytes: number; lineCount: number; maxLineLength: number; truncated: boolean } {
  let maxLineLength = 0;
  let lineCount = 1;
  let cur = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      if (cur > maxLineLength) maxLineLength = cur;
      cur = 0;
      lineCount++;
    } else {
      cur++;
    }
  }
  if (cur > maxLineLength) maxLineLength = cur;
  return { bytes: content.length, lineCount, maxLineLength, truncated };
}

/** Dirty = the model's current version differs from its last-saved baseline. */
function isModelDirty(path: string, model: monaco.editor.ITextModel): boolean {
  const saved = getSavedVersion(path);
  return saved !== undefined && model.getAlternativeVersionId() !== saved;
}

/** Scrolling and typing are asked again once they settle, not per event. */
const INLINE_VALUE_DEBOUNCE_MS = 200;

/** A 1-based line number that certainly exists in a model of `lineCount` lines. */
function clampLine(line: number, lineCount: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(1, Math.trunc(line)), Math.max(1, lineCount));
}

/** A 1-based Monaco line span as the 0-based wire range a provider is asked for. */
function wireLineRange(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): LspRange {
  return {
    start: { line: startLine - 1, character: 0 },
    end: { line: endLine - 1, character: Math.max(0, model.getLineMaxColumn(endLine) - 1) },
  };
}

/**
 * Answer the lookups a set of inline-value slots needs, the cheapest way each can be answered.
 *
 * One scopes read serves every variable lookup: those values are already in the frame the debugger
 * stopped in, so asking per name would be a round trip for data the adapter has already sent.
 * Expensive scopes are skipped, exactly as the variables view leaves them collapsed — a global scope an
 * adapter marks expensive can be enormous, and paying for it on every step is what would make inline
 * values feel slower than stepping without them. Only an evaluatable expression reaches `evaluate`, and
 * `live()` is re-checked between requests so a resumed program stops the queue instead of draining it.
 */
async function resolveInlineValues(
  requests: readonly InlineValueRequest[],
  frameId: number,
  live: () => boolean,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (requests.length === 0) return resolved;
  if (requests.some((request) => request.kind === 'variable')) {
    const variables: DebugVariable[] = [];
    const scopes = await window.axiom.debug.scopes(frameId);
    if (!live()) return resolved;
    for (const scope of scopes) {
      if (scope.expensive || scope.variablesReference === 0) continue;
      variables.push(...(await window.axiom.debug.variables(scope.variablesReference)));
      if (!live()) return resolved;
    }
    for (const request of requests) {
      if (request.kind !== 'variable') continue;
      const value = findInlineVariable(variables, request.name, request.caseSensitive);
      if (value !== null) resolved.set(inlineValueKey(request), value);
    }
  }
  for (const request of requests) {
    if (request.kind !== 'expression') continue;
    const result = await window.axiom.debug.evaluate(request.name, frameId).catch(() => null);
    if (!live()) return resolved;
    if (result !== null && result.ok && result.result.length > 0) {
      resolved.set(inlineValueKey(request), result.result);
    }
  }
  return resolved;
}

/** Append a single trailing newline (matching the model's EOL) if missing. */
function ensureFinalNewline(model: monaco.editor.ITextModel): void {
  const value = model.getValue();
  if (value.length === 0 || value.endsWith('\n')) return;
  const eol = model.getEOL();
  const lineCount = model.getLineCount();
  const column = model.getLineMaxColumn(lineCount);
  model.applyEdits([{ range: new monaco.Range(lineCount, column, lineCount, column), text: eol }]);
}

export type EditorEncoding = '' | 'UTF-8' | 'Binary / non-UTF-8';

const UTF8_ENCODING: EditorEncoding = 'UTF-8';
const BINARY_ENCODING: EditorEncoding = 'Binary / non-UTF-8';

interface EditorPaneProps {
  activePath: string | null;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onCursorChange: (line: number, column: number) => void;
  onLanguageChange: (language: string) => void;
  onSelectionChange: (selectedChars: number) => void;
  onEolChange: (eol: EolKind) => void;
  onEncodingChange: (encoding: EditorEncoding) => void;
  onIndentChange: (indent: IndentInfo) => void;
  /** Id of the editor group this pane renders. */
  groupId: string;
  /** True when this pane's group is focused (owns the workbench editor actions). */
  isActive: boolean;
  /** Called when this pane gains focus, to make its group active. */
  onFocusGroup: (id: string) => void;
}

/**
 * Monaco-backed editor host (PRD Part VII §105/§106). One editor + one model per
 * open file (per-file undo). Multiple panes can exist (split groups); only the
 * focused pane owns the workbench editor actions and status-bar reports, while
 * saving is routed by path so any pane can save its own files.
 */
export function EditorPane({
  activePath,
  onDirtyChange,
  onCursorChange,
  onLanguageChange,
  onSelectionChange,
  onEolChange,
  onEncodingChange,
  onIndentChange,
  groupId,
  isActive,
  onFocusGroup,
}: EditorPaneProps) {
  const { rootPath, groups, revealTarget, applyRename, isFileOpen, getOpenFileSnapshot } =
    useWorkspace();
  const applyRenameRef = useRef(applyRename);
  applyRenameRef.current = applyRename;
  const isFileOpenRef = useRef(isFileOpen);
  isFileOpenRef.current = isFileOpen;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bpDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  // Inline AI edit review: one decoration per pending hunk, in hunk order, so the
  // live (drift-corrected) range for hunk i is always getRanges()[i].
  const aiReviewDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  // Inline values (PRD Phase 7): one end-of-line decoration per decorated line, replaced whole on
  // each refresh, plus an epoch so an in-flight refresh cannot land after the frame or file moved.
  const inlineValueDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const inlineValueEpochRef = useRef(0);
  const aiReviewHunksRef = useRef<AiReviewHunk[]>([]);
  const aiReviewPathRef = useRef<string | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const fileEtagsRef = useRef<Map<string, string | null>>(new Map());
  const editableRef = useRef<Map<string, boolean>>(new Map());
  const encodingRef = useRef<Map<string, EditorEncoding>>(new Map());
  const externalConflictRef = useRef<Set<string>>(new Set());
  const activePathRef = useRef<string | null>(null);
  const autoSaveRef = useRef<AutoSaveSettings>({ mode: 'off', delay: 1000 });
  const autoSaveTimersRef = useRef<Map<string, number>>(new Map());
  const formatOnSaveRef = useRef(false);
  const hygieneRef = useRef<OnSaveHygiene>({
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
  });

  const onDirtyRef = useRef(onDirtyChange);
  const onCursorRef = useRef(onCursorChange);
  const onLanguageRef = useRef(onLanguageChange);
  const onSelectionRef = useRef(onSelectionChange);
  const onEolRef = useRef(onEolChange);
  const onEncodingRef = useRef(onEncodingChange);
  const onIndentRef = useRef(onIndentChange);
  const isActiveRef = useRef(isActive);
  const groupIdRef = useRef(groupId);
  const onFocusGroupRef = useRef(onFocusGroup);
  onDirtyRef.current = onDirtyChange;
  onCursorRef.current = onCursorChange;
  onLanguageRef.current = onLanguageChange;
  onSelectionRef.current = onSelectionChange;
  onEolRef.current = onEolChange;
  onEncodingRef.current = onEncodingChange;
  onIndentRef.current = onIndentChange;
  isActiveRef.current = isActive;
  groupIdRef.current = groupId;
  onFocusGroupRef.current = onFocusGroup;

  // --- Status-bar reports (only meaningful for the focused pane) -----------
  const reportLanguage = useCallback((): void => {
    const model = editorRef.current?.getModel();
    onLanguageRef.current(model ? model.getLanguageId() : '');
  }, []);

  const reportEol = useCallback((): void => {
    const model = editorRef.current?.getModel();
    if (model) onEolRef.current(model.getEOL() === '\r\n' ? 'CRLF' : 'LF');
  }, []);

  const reportEncoding = useCallback((): void => {
    const path = activePathRef.current;
    if (!path) {
      onEncodingRef.current('');
      return;
    }
    onEncodingRef.current(
      isUntitledPath(path) ? UTF8_ENCODING : (encodingRef.current.get(path) ?? ''),
    );
  }, []);

  const reportIndent = useCallback((): void => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const opts = model.getOptions();
    onIndentRef.current({ tabSize: opts.tabSize, insertSpaces: opts.insertSpaces });
  }, []);

  const reportCursor = useCallback((): void => {
    const pos = editorRef.current?.getPosition();
    if (pos) onCursorRef.current(pos.lineNumber, pos.column);
  }, []);

  const reportSelection = useCallback((): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      onSelectionRef.current(0);
      return;
    }
    let chars = 0;
    for (const sel of editor.getSelections() ?? []) {
      if (!sel.isEmpty()) chars += model.getValueInRange(sel).length;
    }
    onSelectionRef.current(chars);
  }, []);

  const destinationHasOwner = useCallback(
    (targetPath: string, sourcePath?: string, sourceModel?: monaco.editor.ITextModel): boolean => {
      if (targetPath !== sourcePath && isFileOpenRef.current(targetPath)) return true;
      const registered = monaco.editor.getModel(monaco.Uri.file(targetPath));
      return registered !== null && registered !== sourceModel;
    },
    [],
  );

  const canonicalTabAuthority = useCallback(
    async (targetIdentity: string, sourcePath?: string): Promise<number | null> => {
      const snapshot = (): { paths: string[]; generation: number } => {
        const current = getOpenFileSnapshot();
        return {
          paths: [
            ...new Set(
              current.paths.filter((path) => path !== sourcePath && !isUntitledPath(path)),
            ),
          ].sort(),
          generation: current.generation,
        };
      };

      // A path resolution yields to Main. If the tab generation changes while it
      // is in flight, repeat against the new live set; fail closed under churn.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = snapshot();
        const identities = await Promise.all(
          before.paths.map((path) =>
            window.axiom.fs
              .resolveIdentity(path)
              .then((result) => result.identity)
              .catch(() => null),
          ),
        );
        if (identities.some((identity) => identity === null || identity === targetIdentity)) {
          return null;
        }
        const after = snapshot();
        if (
          before.generation === after.generation &&
          before.paths.length === after.paths.length &&
          before.paths.every((path, index) => path === after.paths[index])
        ) {
          return after.generation;
        }
      }
      return null;
    },
    [getOpenFileSnapshot],
  );

  // Move an open buffer (an untitled save, or a real file "Saved As") onto
  // `targetPath`: swap in a file-backed model, drop the old one, and re-key the
  // tab together with its dirty / pinned / preview state. A null result means
  // another Monaco model claimed the canonical destination before this commit.
  const rekeyToFile = useCallback(
    (
      oldPath: string,
      targetPath: string,
      targetName: string,
      writtenContent: string,
      writtenEtag: string,
    ): boolean | null => {
      const oldModel = modelsRef.current.get(oldPath);
      const currentContent = oldModel?.getValue() ?? writtenContent;
      const fileUri = monaco.Uri.file(targetPath);
      const registeredModel = monaco.editor.getModel(fileUri);
      if (registeredModel && registeredModel !== oldModel) return null;
      const fileModel =
        registeredModel ??
        monaco.editor.createModel(writtenContent, languageForPath(targetPath), fileUri);
      if (fileModel.getValue() !== writtenContent) fileModel.setValue(writtenContent);
      setSavedVersion(targetPath, fileModel.getAlternativeVersionId());
      // Preserve edits made while the asynchronous write was in flight. The new
      // file-backed model remains dirty relative to the exact bytes written.
      if (currentContent !== writtenContent) fileModel.setValue(currentContent);
      fileModel.updateOptions({
        tabSize: editorSettingsRef.current.tabSize,
        insertSpaces: editorSettingsRef.current.insertSpaces,
      });
      modelsRef.current.set(targetPath, fileModel);
      fileEtagsRef.current.set(targetPath, writtenEtag);
      editableRef.current.set(targetPath, true);
      encodingRef.current.set(targetPath, UTF8_ENCODING);
      externalConflictRef.current.delete(targetPath);
      if (oldModel && editorRef.current && editorRef.current.getModel() === oldModel) {
        editorRef.current.setModel(fileModel);
      }
      if (oldPath !== targetPath) {
        modelsRef.current.delete(oldPath);
        fileEtagsRef.current.delete(oldPath);
        editableRef.current.delete(oldPath);
        encodingRef.current.delete(oldPath);
        externalConflictRef.current.delete(oldPath);
        clearSavedVersion(oldPath);
        if (oldModel && oldModel !== fileModel && !oldModel.isDisposed()) oldModel.dispose();
      }
      applyRenameRef.current(oldPath, targetPath, targetName);
      const clean = !isModelDirty(targetPath, fileModel);
      onDirtyRef.current(targetPath, !clean);
      emitFileSaved(targetPath);
      return clean;
    },
    [],
  );

  // Save a specific file's model atomically. Returns false when this pane does
  // not own the path (so the save bus can route to the pane that does).
  const savePath = useCallback(
    async (path: string): Promise<SaveResult | false> => {
      const model = modelsRef.current.get(path);
      if (!model) return false;
      const untitled = isUntitledPath(path);
      if (!untitled && editableRef.current.get(path) === false) {
        notifyError('This preview is read-only', {
          source: 'Editor',
          detail: 'Large, binary, and non-UTF-8 previews cannot be written as text.',
        });
        return false;
      }

      // Untitled buffers need a destination before they can be written ("Save As").
      let targetPath = path;
      let targetName = path.split(/[\\/]/).pop() ?? path;
      let targetIdentity: string | undefined;
      if (untitled) {
        const chosen = await window.axiom.dialog.saveFile(path.slice('untitled:'.length));
        if (!chosen) return false; // dialog cancelled
        const tabAuthority = await canonicalTabAuthority(chosen.canonicalIdentity);
        if (
          tabAuthority === null ||
          getOpenFileSnapshot().generation !== tabAuthority ||
          destinationHasOwner(chosen.canonicalPath)
        ) {
          notifyError(`${chosen.name} is already open`, {
            source: 'Editor',
            detail: 'Close that editor before saving this untitled buffer to the same file.',
          });
          return false;
        }
        targetPath = chosen.path;
        targetName = chosen.name;
        targetIdentity = chosen.canonicalIdentity;
      }

      try {
        const editor = editorRef.current;
        const activeEditor = editor && editor.getModel() === model ? editor : null;
        // Format / trim act on the live editor; skip for untitled (Save As).
        if (!untitled && formatOnSaveRef.current && activeEditor) {
          try {
            await activeEditor.getAction('editor.action.formatDocument')?.run();
          } catch {
            /* formatting is best-effort; persist the current text regardless */
          }
        }
        if (!untitled && hygieneRef.current.trimTrailingWhitespace && activeEditor) {
          try {
            await activeEditor.getAction('editor.action.trimTrailingWhitespace')?.run();
          } catch {
            /* best-effort */
          }
        }
        if (hygieneRef.current.insertFinalNewline) ensureFinalNewline(model);

        const content = model.getValue();
        const writtenVersion = model.getAlternativeVersionId();
        const expectedEtag = untitled ? undefined : fileEtagsRef.current.get(path);
        const result = await window.axiom.fs.writeFile(
          targetPath,
          content,
          expectedEtag,
          targetIdentity,
        );

        if (untitled) {
          const committedPath = result.path;
          const committedName = committedPath.split(/[\\/]/).pop() ?? targetName;
          const committedAuthority = await canonicalTabAuthority(result.identity);
          if (
            committedAuthority === null ||
            getOpenFileSnapshot().generation !== committedAuthority ||
            destinationHasOwner(committedPath)
          ) {
            emitFileSaved(committedPath);
            notifyError(`${committedName} opened while it was being saved`, {
              source: 'Editor',
              detail:
                'The bytes were written, but the untitled buffer was kept open to avoid replacing or closing another editor.',
            });
            return false;
          }
          const clean = rekeyToFile(path, committedPath, committedName, content, result.etag);
          if (clean === null) {
            emitFileSaved(committedPath);
            notifyError(`${committedName} opened while it was being saved`, {
              source: 'Editor',
              detail:
                'The bytes were written, but the untitled buffer was kept open because another editor model claimed the destination.',
            });
            return false;
          }
          notifyInfo(`Saved ${committedName}`, { source: 'Editor', toast: false });
          return { path: committedPath, clean };
        }

        fileEtagsRef.current.set(targetPath, result.etag);
        externalConflictRef.current.delete(targetPath);
        setSavedVersion(targetPath, writtenVersion);
        const clean = !isModelDirty(targetPath, model);
        onDirtyRef.current(targetPath, !clean);
        notifyInfo(`Saved ${targetName}`, { source: 'Editor', toast: false });
        emitFileSaved(targetPath);
        return { path: targetPath, clean };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const marker = raw.lastIndexOf('Error: ');
        notifyError(`Could not save ${targetName}`, {
          source: 'Editor',
          detail: marker >= 0 ? raw.slice(marker + 7) : raw,
        });
        return false;
      }
    },
    [canonicalTabAuthority, destinationHasOwner, getOpenFileSnapshot, rekeyToFile],
  );

  const saveActive = useCallback((): void => {
    const path = activePathRef.current;
    if (path) void savePath(path);
  }, [savePath]);

  const defaultSaveName = (path: string): string =>
    isUntitledPath(path) ? path.slice('untitled:'.length) : (path.split(/[\\/]/).pop() ?? path);

  // Save the active editor to a chosen destination and move the tab to it. The
  // original file (if any) is left untouched on disk (PRD Part VII §106).
  const saveAsActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    if (!path) return;
    const model = modelsRef.current.get(path);
    if (!model) return;
    if (!isUntitledPath(path) && editableRef.current.get(path) === false) {
      notifyError('This preview cannot be saved as text', {
        source: 'Editor',
        detail: 'Large, binary, and non-UTF-8 files remain read-only to prevent corruption.',
      });
      return;
    }
    const chosen = await window.axiom.dialog.saveFile(defaultSaveName(path));
    if (!chosen) return;
    let sourceIdentity: string | null = null;
    if (!isUntitledPath(path)) {
      try {
        sourceIdentity = (await window.axiom.fs.resolveIdentity(path)).identity;
      } catch (error) {
        notifyError('Could not verify the active file identity', {
          source: 'Editor',
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    // Choosing an alias of the current file is just an ordinary in-place save,
    // retaining its external-change ETag protection.
    if (
      chosen.path === path ||
      chosen.canonicalPath === path ||
      chosen.canonicalIdentity === sourceIdentity ||
      model.uri.toString() === monaco.Uri.file(chosen.canonicalPath).toString()
    ) {
      void savePath(path);
      return;
    }
    // Don't clobber a canonical file identity owned by another tab or model.
    const tabAuthority = await canonicalTabAuthority(chosen.canonicalIdentity, path);
    if (
      tabAuthority === null ||
      getOpenFileSnapshot().generation !== tabAuthority ||
      destinationHasOwner(chosen.canonicalPath, path, model)
    ) {
      notifyError(`${chosen.name} is already open`, {
        source: 'Editor',
        detail: 'Close that editor before saving over it.',
      });
      return;
    }
    try {
      const content = model.getValue();
      const result = await window.axiom.fs.writeFile(
        chosen.path,
        content,
        undefined,
        chosen.canonicalIdentity,
      );
      const committedPath = result.path;
      const committedName = committedPath.split(/[\\/]/).pop() ?? chosen.name;
      const committedAuthority = await canonicalTabAuthority(result.identity, path);
      if (
        committedAuthority === null ||
        getOpenFileSnapshot().generation !== committedAuthority ||
        destinationHasOwner(committedPath, path, model)
      ) {
        emitFileSaved(committedPath);
        notifyError(`${committedName} opened while it was being saved`, {
          source: 'Editor',
          detail:
            'The bytes were written, but this editor was not moved to avoid replacing another open model.',
        });
        return;
      }
      const clean = rekeyToFile(path, committedPath, committedName, content, result.etag);
      if (clean === null) {
        emitFileSaved(committedPath);
        notifyError(`${committedName} opened while it was being saved`, {
          source: 'Editor',
          detail:
            'The bytes were written, but this editor was not moved because another editor model claimed the destination.',
        });
        return;
      }
      notifyInfo(`Saved ${committedName}`, { source: 'Editor', toast: false });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const marker = raw.lastIndexOf('Error: ');
      notifyError(`Could not save ${chosen.name}`, {
        source: 'Editor',
        detail: marker >= 0 ? raw.slice(marker + 7) : raw,
      });
    }
  }, [canonicalTabAuthority, destinationHasOwner, getOpenFileSnapshot, savePath, rekeyToFile]);

  // Write a copy of the active editor's content elsewhere, leaving the live
  // editor (and its dirty state) unchanged.
  const saveCopyAsActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    if (!path) return;
    const model = modelsRef.current.get(path);
    if (!model) return;
    if (!isUntitledPath(path) && editableRef.current.get(path) === false) {
      notifyError('This preview cannot be saved as text', {
        source: 'Editor',
        detail: 'Large, binary, and non-UTF-8 files remain read-only to prevent corruption.',
      });
      return;
    }
    const chosen = await window.axiom.dialog.saveFile(defaultSaveName(path));
    if (!chosen) return;
    let content = model.getValue();
    if (hygieneRef.current.insertFinalNewline && content.length > 0 && !content.endsWith('\n')) {
      content += model.getEOL();
    }
    try {
      await window.axiom.fs.writeFile(chosen.path, content);
      notifyInfo(`Saved a copy to ${chosen.name}`, { source: 'Editor', toast: false });
      emitFileSaved(chosen.path);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const marker = raw.lastIndexOf('Error: ');
      notifyError(`Could not save a copy to ${chosen.name}`, {
        source: 'Editor',
        detail: marker >= 0 ? raw.slice(marker + 7) : raw,
      });
    }
  }, []);

  const formatActive = useCallback(async (): Promise<void> => {
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;
    try {
      await editor.getAction('editor.action.formatDocument')?.run();
    } catch {
      /* no formatter for this language — ignore */
    }
  }, []);

  const goToSymbol = useCallback(async (): Promise<void> => {
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;
    editor.focus();
    try {
      await editor.getAction('editor.action.quickOutline')?.run();
    } catch {
      /* no symbol provider — ignore */
    }
  }, []);

  const revertActive = useCallback(async (): Promise<void> => {
    const path = activePathRef.current;
    if (!path) return;
    const model = modelsRef.current.get(path);
    if (!model) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      const file = await window.axiom.fs.readFile(path);
      if (model.getValue() !== file.content) model.setValue(file.content);
      fileEtagsRef.current.set(path, file.etag);
      editableRef.current.set(path, file.editable);
      encodingRef.current.set(path, file.binary ? BINARY_ENCODING : UTF8_ENCODING);
      externalConflictRef.current.delete(path);
      const cls = classifyFileForEditor(computeFileMetrics(file.content, file.truncated));
      fileClassRef.current.set(path, cls);
      setSavedVersion(path, model.getAlternativeVersionId());
      onDirtyRef.current(path, false);
      if (activePathRef.current === path) {
        editorRef.current?.updateOptions({ readOnly: !file.editable });
        if (isActiveRef.current) reportEncoding();
      }
      notifyInfo(file.readOnlyReason ?? `Reverted ${name}`, { source: 'Editor', toast: false });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      notifyError(`Could not revert ${name}`, { source: 'Editor', detail: raw });
    }
  }, [reportEncoding]);

  // --- Auto save (PRD Part VII §106; files.autoSave) -----------------------
  const isDirtyPath = useCallback((path: string): boolean => {
    const model = modelsRef.current.get(path);
    return model ? isModelDirty(path, model) : false;
  }, []);

  const clearAutoSaveTimer = useCallback((path: string): void => {
    const id = autoSaveTimersRef.current.get(path);
    if (id !== undefined) {
      window.clearTimeout(id);
      autoSaveTimersRef.current.delete(path);
    }
  }, []);

  const scheduleAutoSave = useCallback(
    (path: string): void => {
      clearAutoSaveTimer(path);
      const id = window.setTimeout(() => {
        autoSaveTimersRef.current.delete(path);
        if (isDirtyPath(path)) void savePath(path);
      }, autoSaveRef.current.delay);
      autoSaveTimersRef.current.set(path, id);
    },
    [clearAutoSaveTimer, isDirtyPath, savePath],
  );

  const autoSaveActiveIfDirty = useCallback((): void => {
    const path = activePathRef.current;
    if (path && isDirtyPath(path)) void savePath(path);
  }, [isDirtyPath, savePath]);

  const autoSaveAllDirty = useCallback((): void => {
    for (const [path, model] of modelsRef.current) {
      if (isModelDirty(path, model)) void savePath(path);
    }
  }, [savePath]);

  // Insert text at the cursor (replacing any selection) — used by AI "Insert".
  const insertAtCursor = useCallback((text: string): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    if (!selection) return;
    editor.executeEdits('axiom.ai.insert', [{ range: selection, text, forceMoveMarkers: true }]);
    editor.focus();
  }, []);

  // Hand the current selection (or the whole file when nothing is selected) to
  // the AI chat as an inline action (PRD Epoch G — explain/refactor/fix/docs).
  const runAiAction = useCallback((kind: AiActionKind, depth?: ExplainDepth): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const sel = editor.getSelection();
    const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
    const code = model.getValueInRange(range);
    if (code.trim().length === 0) return;
    const path = activePathRef.current;
    const fileLabel = path ? (path.split(/[\\/]/).pop() ?? path) : 'untitled';
    requestAiAction({
      kind,
      code,
      fileLabel,
      language: model.getLanguageId(),
      startLine: range.startLineNumber,
      endLine: range.endLineNumber,
      ...(depth ? { depth } : {}),
    });
  }, []);

  // Call hierarchy (PRD Phase 95): resolve the incoming references ("callers")
  // for the symbol under the cursor via the language server and show them,
  // grouped by file, in the Explorer Call Hierarchy panel (click-to-jump).
  // Monaco has no native call-hierarchy provider, so this drives a custom panel.
  // When no language server answered, an extension's `CallHierarchyProvider`
  // (PRD Phase 6) does — and it answers with a real bidirectional hierarchy, so
  // its result goes to the lazy tree panel instead of being flattened.
  const runCallHierarchy = useCallback((): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const wordInfo = model.getWordAtPosition(position);
    if (!wordInfo) {
      notifyInfo('Place the cursor on a symbol to show its call hierarchy.', { source: 'Axiom' });
      return;
    }
    const symbol = wordInfo.word;
    const uri = model.uri.toString();
    const point = { line: position.lineNumber - 1, character: position.column - 1 };
    const unavailable = (): void => {
      notifyError('Call hierarchy unavailable — no provider answered for this file.', {
        source: 'Axiom',
      });
    };
    const lspRefs = window.axiom.lsp
      .references(uri, point.line, point.character)
      .then((res) =>
        res.locations.map((loc) => ({
          path: monaco.Uri.parse(loc.uri).fsPath,
          line: loc.range.start.line + 1,
          column: loc.range.start.character + 1,
        })),
      )
      .catch((): RefLocation[] => []);
    void lspRefs
      .then(async (refs) => {
        if (refs.length > 0) {
          showCallHierarchy({ symbol, refs });
          return;
        }
        const roots = await prepareCallHierarchy(uri, point);
        if (roots.length === 0) {
          unavailable();
          return;
        }
        showHierarchy({ kind: 'call', symbol, roots });
      })
      .catch(unavailable);
  }, []);

  /**
   * Type hierarchy (PRD Phase 7): the supertypes and subtypes of the type under the
   * cursor, from an extension's `TypeHierarchyProvider`.
   *
   * Only the roots are prepared here. Each level below them is fetched by the panel as the
   * user opens a row, because that is the shape of the API — every item carries the token
   * its provider minted, and asking for a level costs a provider round trip.
   */
  const runTypeHierarchy = useCallback((): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const wordInfo = model.getWordAtPosition(position);
    if (!wordInfo) {
      notifyInfo('Place the cursor on a type to show its hierarchy.', { source: 'Axiom' });
      return;
    }
    const symbol = wordInfo.word;
    const unavailable = (): void => {
      notifyError('Type hierarchy unavailable — no provider answered for this file.', {
        source: 'Axiom',
      });
    };
    void prepareTypeHierarchy(model.uri.toString(), {
      line: position.lineNumber - 1,
      character: position.column - 1,
    })
      .then((roots) => {
        if (roots.length === 0) {
          unavailable();
          return;
        }
        showHierarchy({ kind: 'type', symbol, roots });
      })
      .catch(unavailable);
  }, []);

  /**
   * Redraw the inline AI edit review for the active file: every line the agent
   * added is highlighted with a gutter marker, so an AI change is reviewed in the
   * file instead of a chat card. Ranges are tracked by Monaco, so later typing
   * cannot desynchronize a hunk from its text.
   */
  const refreshAiReview = useCallback((): void => {
    const editor = editorRef.current;
    const collection = aiReviewDecorationsRef.current;
    if (!editor || !collection) return;
    const path = activePathRef.current;
    const model = editor.getModel();
    const review = path ? getAiReview(path) : null;
    aiReviewPathRef.current = path;
    if (!path || !model || !review) {
      aiReviewHunksRef.current = [];
      collection.set([]);
      return;
    }
    const maxLine = model.getLineCount();
    aiReviewHunksRef.current = review.hunks;
    collection.set(
      review.hunks.map((hunk) => {
        const deletion = isDeletionOnly(hunk);
        const start = Math.min(Math.max(1, hunk.startLine || 1), maxLine);
        const end = Math.min(Math.max(start, hunk.endLine || start), maxLine);
        const label = deletion
          ? `Axiom AI removed ${hunk.removedText.length} line(s) here`
          : `Axiom AI change · +${hunk.addedText.length}${
              hunk.removedText.length > 0 ? ` −${hunk.removedText.length}` : ''
            }`;
        return {
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            className: deletion ? 'axiom-ai-review-removed' : 'axiom-ai-review-added',
            glyphMarginClassName: 'axiom-ai-review-glyph',
            glyphMarginHoverMessage: {
              value: `${label}\n\nAccept: keep it · Revert: restore the original`,
            },
            overviewRuler: {
              color: 'rgba(120, 170, 255, 0.65)',
              position: monaco.editor.OverviewRulerLane.Left,
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      }),
    );
  }, []);

  /** Index of the pending hunk containing (or nearest above) the cursor line. */
  const aiHunkIndexAtCursor = useCallback((): number => {
    const editor = editorRef.current;
    const collection = aiReviewDecorationsRef.current;
    if (!editor || !collection) return -1;
    const line = editor.getPosition()?.lineNumber ?? 0;
    const ranges = collection.getRanges();
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range && line >= range.startLineNumber && line <= range.endLineNumber) return index;
    }
    return -1;
  }, []);

  /**
   * Revert one AI hunk in the open buffer: added lines are replaced by the exact
   * original text Main captured. This is a normal, undoable model edit — the file
   * on disk changes only when the user saves through the authorized path.
   */
  const revertAiHunk = useCallback((index: number): void => {
    const editor = editorRef.current;
    const collection = aiReviewDecorationsRef.current;
    const model = editor?.getModel();
    const path = aiReviewPathRef.current;
    const hunk = aiReviewHunksRef.current[index];
    if (!editor || !collection || !model || !path || !hunk) return;
    const range = collection.getRanges()[index];
    if (!range) return;

    const eol = model.getEOL();
    const original = hunk.removedText.join(eol);
    if (isDeletionOnly(hunk)) {
      // Re-insert the removed block after its anchor line.
      const anchor = Math.min(Math.max(0, range.startLineNumber), model.getLineCount());
      const insertAt =
        anchor <= 0
          ? new monaco.Range(1, 1, 1, 1)
          : new monaco.Range(
              anchor,
              model.getLineMaxColumn(anchor),
              anchor,
              model.getLineMaxColumn(anchor),
            );
      editor.executeEdits('axiom.ai.revertHunk', [
        { range: insertAt, text: anchor <= 0 ? `${original}${eol}` : `${eol}${original}` },
      ]);
    } else {
      const lastLine = Math.min(range.endLineNumber, model.getLineCount());
      const full = new monaco.Range(
        range.startLineNumber,
        1,
        lastLine,
        model.getLineMaxColumn(lastLine),
      );
      editor.executeEdits('axiom.ai.revertHunk', [{ range: full, text: original }]);
      if (hunk.removedText.length === 0) {
        // A pure insertion leaves an empty line behind; remove it.
        const line = range.startLineNumber;
        if (line < model.getLineCount()) {
          editor.executeEdits('axiom.ai.revertHunk', [
            { range: new monaco.Range(line, 1, line + 1, 1), text: '' },
          ]);
        }
      }
    }
    resolveAiReviewHunk(path, hunk.id);
  }, []);

  /**
   * Draw an extension's inline values at the ends of the lines they belong to (PRD Phase 7).
   *
   * Only the buffer the debugger is stopped in is decorated, and only its visible range is asked for —
   * that is what `InlineValuesProvider` is specified against, and it is what keeps a 10,000-line file
   * from costing 10,000 lines of lookups. The answer is then resolved by `resolveInlineValues` and
   * drawn as injected text; `epoch` invalidates a refresh whose frame, file or viewport moved while it
   * was in flight, so a stale answer can never land on the new view.
   */
  const refreshInlineValues = useCallback((): void => {
    const editor = editorRef.current;
    const collection = inlineValueDecorationsRef.current;
    if (!editor || !collection) return;
    const epoch = (inlineValueEpochRef.current += 1);
    const live = (): boolean =>
      inlineValueEpochRef.current === epoch && editorRef.current === editor;
    const model = editor.getModel();
    const context = inlineValueContext();
    const path = activePathRef.current;
    // Values belong to the stopped frame's own file; every other buffer keeps its own view clean.
    if (!model || !context || path === null || !sameInlineValuePath(path, context.path)) {
      collection.clear();
      return;
    }
    const lineCount = model.getLineCount();
    const visible = editor.getVisibleRanges();
    const startLine = clampLine(visible[0]?.startLineNumber ?? 1, lineCount);
    const endLine = clampLine(visible[visible.length - 1]?.endLineNumber ?? lineCount, lineCount);
    const stoppedLine = clampLine(context.line, lineCount);
    void (async () => {
      const values = await queryInlineValues(
        model.uri.toString(),
        wireLineRange(model, startLine, Math.max(startLine, endLine)),
        context.frameId,
        wireLineRange(model, stoppedLine, stoppedLine),
      );
      if (!live()) return;
      const slots = planInlineValues(values, (line) =>
        line >= 0 && line < model.getLineCount() ? model.getLineContent(line + 1) : '',
      );
      const resolved = await resolveInlineValues(inlineValueRequests(slots), context.frameId, live);
      if (!live()) return;
      collection.set(
        composeInlineValueDecorations(slots, resolved).map((decoration) => {
          const line = clampLine(decoration.line + 1, model.getLineCount());
          const column = model.getLineMaxColumn(line);
          return {
            range: new monaco.Range(line, column, line, column),
            options: {
              // Injected text, never HTML: Monaco renders `content` as a text node.
              after: { content: `  ${decoration.label}`, inlineClassName: 'axiom-inline-value' },
              showIfCollapsed: true,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          };
        }),
      );
    })().catch(() => {
      if (live()) collection.clear();
    });
  }, []);

  // Redraw breakpoint glyphs for the active file (PRD Phase 96/98).
  const refreshBreakpoints = useCallback((): void => {
    const editor = editorRef.current;
    const coll = bpDecorationsRef.current;
    if (!editor || !coll) return;
    const path = activePathRef.current;
    const lines = path ? linesFor(path) : [];
    coll.set(
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'axiom-bp-glyph',
          glyphMarginHoverMessage: { value: 'Breakpoint' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  }, []);

  // The focused pane owns the workbench editor actions + language/EOL setters.
  useEffect(() => {
    if (!isActive) return;
    return setActiveEditor({
      save: saveActive,
      saveAs: () => void saveAsActive(),
      saveCopyAs: () => void saveCopyAsActive(),
      format: () => void formatActive(),
      goToSymbol: () => void goToSymbol(),
      revert: () => void revertActive(),
      runAction: (id) => editorRef.current?.trigger('axiom.menu', id, null),
      insertText: insertAtCursor,
      getSelection: () => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        const selection = editor?.getSelection();
        if (!editor || !model || !selection || selection.isEmpty()) return null;
        return {
          path: activePathRef.current ?? model.uri.fsPath,
          language: model.getLanguageId(),
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
          text: model.getValueInRange(selection),
        };
      },
    });
  }, [
    isActive,
    saveActive,
    saveAsActive,
    saveCopyAsActive,
    formatActive,
    goToSymbol,
    revertActive,
    insertAtCursor,
  ]);

  // Every pane can save its own files (routed by path via the save bus).
  useEffect(() => addSaver(savePath), [savePath]);

  useEffect(() => {
    if (!isActive) return;
    return setLanguageSetter((languageId) => {
      const model = editorRef.current?.getModel();
      if (!model) return;
      monaco.editor.setModelLanguage(model, languageId);
      reportLanguage();
    });
  }, [isActive, reportLanguage]);

  useEffect(() => {
    if (!isActive) return;
    return setEolSetter((eol) => {
      const model = editorRef.current?.getModel();
      if (!model) return;
      model.setEOL(
        eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
      );
      reportEol();
    });
  }, [isActive, reportEol]);

  useEffect(() => {
    if (!isActive) return;
    return setIndentActions({
      setInsertSpaces: (insertSpaces) => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        model.updateOptions({ insertSpaces });
        reportIndent();
      },
      setTabSize: (tabSize) => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        model.updateOptions({ tabSize });
        reportIndent();
      },
      convertToSpaces: () => {
        void editorRef.current
          ?.getAction('editor.action.indentationToSpaces')
          ?.run()
          ?.then(() => reportIndent());
      },
      convertToTabs: () => {
        void editorRef.current
          ?.getAction('editor.action.indentationToTabs')
          ?.run()
          ?.then(() => reportIndent());
      },
      detect: () => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        model.detectIndentation(
          editorSettingsRef.current.insertSpaces,
          editorSettingsRef.current.tabSize,
        );
        reportIndent();
      },
    });
  }, [isActive, reportIndent]);

  // When this pane becomes focused, push its current state to the status bar.
  useEffect(() => {
    if (!isActive) return;
    reportLanguage();
    reportEol();
    reportEncoding();
    reportIndent();
    reportCursor();
    reportSelection();
  }, [
    isActive,
    reportLanguage,
    reportEol,
    reportEncoding,
    reportIndent,
    reportCursor,
    reportSelection,
  ]);

  // Reveal a search/goto target once the matching model is active in this pane.
  const revealTargetRef = useRef(revealTarget);
  revealTargetRef.current = revealTarget;
  const appliedRevealRef = useRef(0);

  const maybeReveal = useCallback(() => {
    const target = revealTargetRef.current;
    const editor = editorRef.current;
    if (!target || !editor) return;
    if (target.nonce <= appliedRevealRef.current) return;
    if (target.path !== activePathRef.current) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, target.line), model.getLineCount());
    const column = Math.max(1, target.column);
    editor.setPosition({ lineNumber: line, column });
    editor.revealLineInCenter(line);
    editor.focus();
    appliedRevealRef.current = target.nonce;
  }, []);

  useEffect(() => {
    maybeReveal();
  }, [revealTarget, maybeReveal]);

  useEffect(() => subscribeBreakpoints(refreshBreakpoints), [refreshBreakpoints]);

  /**
   * Inline values follow the debugger and the providers.
   *
   * The bus fires on every stop, frame selection, resume and session end, and delivers the live
   * context on subscribe so a pane opened while paused decorates immediately. A provider that fires
   * `onDidChangeInlineValues` is asking to be re-consulted, which is the same refresh.
   */
  useEffect(() => {
    const offContext = subscribeInlineValues(() => refreshInlineValues());
    const offProviders = onExtensionProviderChanged('inlineValue', refreshInlineValues);
    return () => {
      offContext();
      offProviders();
    };
  }, [refreshInlineValues]);

  // Re-render the inline AI review when the active file changes.
  useEffect(() => {
    refreshAiReview();
  }, [activePath, refreshAiReview]);

  /**
   * Show the agent's change being typed into this pane.
   *
   * Only the pane actually holding that model animates, and only when the buffer is
   * clean: if the user has unsaved edits in the file we leave their view alone
   * rather than covering their text. The reveal is purely decorative (see
   * editor/agentTyping.ts), so cancelling on a tab switch needs no cleanup.
   */
  useEffect(() => {
    let active: { cancel: () => void } | null = null;
    const stop = (): void => {
      active?.cancel();
      active = null;
    };
    const off = subscribeAgentTyping((request) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      if (activePathRef.current !== request.path) return;
      if (isModelDirty(request.path, model)) {
        settleAgentTyping(request.path);
        return;
      }
      stop();
      active = revealAgentEdit(editor, model, request.review);
      settleAgentTyping(request.path);
    });
    return () => {
      off();
      stop();
    };
  }, [activePath]);

  useEffect(() => {
    const onWindowBlur = (): void => {
      if (autoSaveRef.current.mode === 'onWindowChange') autoSaveAllDirty();
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [autoSaveAllDirty]);

  // Editor options derived from user settings; applied at create and on change.
  const { values } = useSettings();
  const editorSettings = getEditorSettings(values);
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;

  // Keymap profile + Vim modal state (PRD Phase 249).
  const keymap = parseKeymap(values['editor.keymap']);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const vimStateRef = useRef<VimState>(INITIAL_VIM_STATE);

  // Reflect the focused pane's Vim mode in the status bar. Clear the indicator when
  // Vim is off; an inactive pane leaves whatever the active pane last set.
  useEffect(() => {
    if (!isActive) return;
    setVimStatus(keymap === 'vim' ? vimStateRef.current.mode : null);
  }, [isActive, keymap]);

  const autoSave = getAutoSaveSettings(values);
  autoSaveRef.current = autoSave;
  formatOnSaveRef.current = editorSettings.formatOnSave;
  hygieneRef.current = getOnSaveHygiene(values);
  useEffect(() => {
    if (autoSave.mode !== 'afterDelay') {
      for (const id of autoSaveTimersRef.current.values()) window.clearTimeout(id);
      autoSaveTimersRef.current.clear();
    }
  }, [autoSave.mode]);

  const monacoOptions = useMemo<monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions>(
    () => ({
      fontSize: editorSettings.fontSize,
      lineHeight: 0,
      fontFamily: editorSettings.fontFamily,
      fontLigatures: editorSettings.fontLigatures,
      wordWrap: editorSettings.wordWrap,
      minimap: { enabled: editorSettings.minimap },
      lineNumbers: editorSettings.lineNumbers,
      renderWhitespace: editorSettings.renderWhitespace,
      stickyScroll: { enabled: editorSettings.stickyScroll },
      cursorBlinking: editorSettings.cursorBlinking,
      cursorStyle: editorSettings.cursorStyle,
      smoothScrolling: editorSettings.smoothScrolling,
      renderLineHighlight: editorSettings.renderLineHighlight,
      rulers: editorSettings.rulers,
      bracketPairColorization: { enabled: editorSettings.bracketPairColorization },
    }),
    [
      editorSettings.fontSize,
      editorSettings.fontFamily,
      editorSettings.fontLigatures,
      editorSettings.wordWrap,
      editorSettings.minimap,
      editorSettings.lineNumbers,
      editorSettings.renderWhitespace,
      editorSettings.stickyScroll,
      editorSettings.cursorBlinking,
      editorSettings.cursorStyle,
      editorSettings.smoothScrolling,
      editorSettings.renderLineHighlight,
      // Array identity changes each render; use a stable primitive key.
      editorSettings.rulers.join(','),
      editorSettings.bracketPairColorization,
    ],
  );
  const monacoOptionsRef = useRef(monacoOptions);
  monacoOptionsRef.current = monacoOptions;

  // Large-file mode (PRD Phases 267–269): a per-path perf classification. applyFileMode
  // merges the base editor options with the active file's class — disabling the minimap,
  // word-wrap, and bracket colorization for big/minified files (syntax highlighting is
  // dropped separately by backing huge files with a plaintext model).
  const fileClassRef = useRef<Map<string, EditorFileClass>>(new Map());
  const applyFileMode = useCallback((path: string | null): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const cls = (path ? fileClassRef.current.get(path) : undefined) ?? NORMAL_FILE_CLASS;
    const base = monacoOptionsRef.current;
    editor.updateOptions({
      readOnly: path ? editableRef.current.get(path) === false : false,
      readOnlyMessage: {
        value:
          path && editableRef.current.get(path) === false
            ? 'This file is shown as a read-only preview to prevent data loss.'
            : '',
      },
      minimap: { enabled: (base.minimap?.enabled ?? true) && cls.minimap },
      wordWrap: cls.wordWrap ? (base.wordWrap ?? 'off') : 'off',
      bracketPairColorization: {
        enabled: (base.bracketPairColorization?.enabled ?? true) && cls.bracketColorization,
      },
    });
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions(monacoOptions);
    for (const model of modelsRef.current.values()) {
      model.updateOptions({
        tabSize: editorSettings.tabSize,
        insertSpaces: editorSettings.insertSpaces,
      });
    }
    applyFileMode(activePathRef.current);
    if (isActiveRef.current) reportIndent();
  }, [monacoOptions, editorSettings.tabSize, editorSettings.insertSpaces, reportIndent]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureAxiomTheme();

    const editor = monaco.editor.create(host, {
      model: null,
      theme: currentMonacoTheme(),
      automaticLayout: true,
      scrollBeyondLastLine: false,
      glyphMargin: true,
      inlineSuggest: { enabled: true },
      // Standalone Monaco themes report semanticHighlighting: false, so the
      // default 'configuredByTheme' would silently discard every semantic token
      // the language servers produce. Opt in explicitly.
      'semanticHighlighting.enabled': true,
      // Server-provided folding regions (functions, classes, imports, #region)
      // instead of indentation guesses.
      folding: true,
      foldingStrategy: 'auto',
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      matchBrackets: 'always',
      guides: { bracketPairs: true, bracketPairsHorizontal: 'active', indentation: true },
      // Inline diagnostics: keep the message compact and non-blocking while typing.
      hover: { enabled: true, delay: 250, sticky: true },
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
      suggest: {
        showWords: false,
        showStatusBar: true,
        preview: true,
        insertMode: 'insert',
        localityBonus: true,
        shareSuggestSelections: true,
        snippetsPreventQuickSuggestions: false,
      },
      suggestSelection: 'first',
      quickSuggestions: { other: true, comments: false, strings: true },
      parameterHints: { enabled: true, cycle: true },
      inlayHints: { enabled: 'on' },
      occurrencesHighlight: 'singleFile',
      definitionLinkOpensInPeek: false,
      gotoLocation: {
        multipleDefinitions: 'peek',
        multipleTypeDefinitions: 'peek',
        multipleDeclarations: 'peek',
        multipleImplementations: 'peek',
        multipleReferences: 'peek',
      },
      accessibilitySupport: 'auto',
      ariaLabel: 'Axiom code editor',
      padding: { top: 10 },
      ...monacoOptionsRef.current,
    });
    editorRef.current = editor;
    bpDecorationsRef.current = editor.createDecorationsCollection([]);
    aiReviewDecorationsRef.current = editor.createDecorationsCollection([]);
    inlineValueDecorationsRef.current = editor.createDecorationsCollection([]);

    // Inline AI edit review actions (context menu + command palette + keybindings).
    editor.addAction({
      id: 'axiom.ai.review.acceptHunk',
      label: 'Axiom AI: Accept This Change',
      contextMenuGroupId: 'axiom-ai-review',
      contextMenuOrder: 1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyY],
      run: () => {
        const index = aiHunkIndexAtCursor();
        const path = aiReviewPathRef.current;
        const hunk = index >= 0 ? aiReviewHunksRef.current[index] : undefined;
        if (path && hunk) resolveAiReviewHunk(path, hunk.id);
      },
    });
    editor.addAction({
      id: 'axiom.ai.review.revertHunk',
      label: 'Axiom AI: Revert This Change',
      contextMenuGroupId: 'axiom-ai-review',
      contextMenuOrder: 2,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
      run: () => {
        const index = aiHunkIndexAtCursor();
        if (index >= 0) revertAiHunk(index);
      },
    });
    editor.addAction({
      id: 'axiom.ai.review.acceptFile',
      label: 'Axiom AI: Accept All Changes In This File',
      contextMenuGroupId: 'axiom-ai-review',
      contextMenuOrder: 3,
      run: () => {
        const path = aiReviewPathRef.current;
        if (path) clearAiReview(path);
      },
    });
    editor.addAction({
      id: 'axiom.ai.review.revertFile',
      label: 'Axiom AI: Revert All Changes In This File',
      contextMenuGroupId: 'axiom-ai-review',
      contextMenuOrder: 4,
      run: () => {
        // Revert bottom-up so earlier ranges stay valid while editing.
        for (let index = aiReviewHunksRef.current.length - 1; index >= 0; index -= 1) {
          revertAiHunk(index);
        }
      },
    });
    editor.addAction({
      id: 'axiom.ai.review.nextChange',
      label: 'Axiom AI: Go To Next AI Change',
      contextMenuGroupId: 'axiom-ai-review',
      contextMenuOrder: 5,
      run: () => {
        const ranges = aiReviewDecorationsRef.current?.getRanges() ?? [];
        if (ranges.length === 0) return;
        const line = editor.getPosition()?.lineNumber ?? 0;
        const next = ranges.find((range) => range.startLineNumber > line) ?? ranges[0]!;
        editor.revealLineInCenter(next.startLineNumber);
        editor.setPosition({ lineNumber: next.startLineNumber, column: 1 });
      },
    });

    // Toggle a breakpoint when the glyph margin is clicked (PRD Phase 96/98).
    const bpMouseSub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const path = activePathRef.current;
      if (line && path) toggleBreakpoint(path, line);
    });
    const bpModelSub = editor.onDidChangeModel(() => {
      refreshBreakpoints();
      refreshAiReview();
      refreshInlineValues();
    });
    // Inline values are asked for the visible range, so scrolling needs a fresh answer, and an edit
    // moves the lines the last answer was drawn against. Both settle before anything is asked again,
    // and neither costs a request while no debug session is paused.
    let inlineValueTimer = 0;
    const scheduleInlineValues = (): void => {
      if (inlineValueContext() === null) return;
      window.clearTimeout(inlineValueTimer);
      inlineValueTimer = window.setTimeout(refreshInlineValues, INLINE_VALUE_DEBOUNCE_MS);
    };
    const inlineValueScrollSub = editor.onDidScrollChange((e) => {
      if (e.scrollTopChanged || e.scrollHeightChanged) scheduleInlineValues();
    });
    const inlineValueEditSub = editor.onDidChangeModelContent(() => scheduleInlineValues());
    // Re-render pending AI changes whenever Build applies another edit.
    const aiReviewSub = subscribeAiReviews(() => refreshAiReview());

    // Inline AI actions in the right-click menu + command palette (PRD Epoch G).
    // AI lightbulb + hover-explain providers (PRD Phase 189) — registered once,
    // globally, so they persist across editor re-mounts.
    registerAiEditorProviders();

    const aiActions: ReadonlyArray<{
      id: string;
      label: string;
      kind: AiActionKind;
      depth?: ExplainDepth;
    }> = [
      { id: 'axiom.ai.explain', label: 'Axiom AI: Explain', kind: 'explain', depth: 'normal' },
      {
        id: 'axiom.ai.explain.brief',
        label: 'Axiom AI: Explain (brief)',
        kind: 'explain',
        depth: 'brief',
      },
      {
        id: 'axiom.ai.explain.deep',
        label: 'Axiom AI: Explain (in depth)',
        kind: 'explain',
        depth: 'deep',
      },
      { id: 'axiom.ai.refactor', label: 'Axiom AI: Refactor', kind: 'refactor' },
      { id: 'axiom.ai.fix', label: 'Axiom AI: Fix / Improve', kind: 'fix' },
      { id: 'axiom.ai.docstring', label: 'Axiom AI: Add Docs', kind: 'docstring' },
    ];
    aiActions.forEach((a, i) =>
      editor.addAction({
        id: a.id,
        label: a.label,
        contextMenuGroupId: 'axiom-ai',
        contextMenuOrder: i,
        run: () => runAiAction(a.kind, a.depth),
      }),
    );

    // Call hierarchy (PRD Phase 95): incoming references for the symbol under the
    // cursor, shown in the Explorer Call Hierarchy panel. In the "navigation"
    // context-menu group (with Go to Definition) and the command palette.
    editor.addAction({
      id: 'axiom.nav.callHierarchy',
      label: 'Axiom: Show Call Hierarchy',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: () => runCallHierarchy(),
    });

    // Type hierarchy (PRD Phase 7): supertypes/subtypes of the type under the cursor,
    // from an extension's TypeHierarchyProvider, in the same navigation group.
    editor.addAction({
      id: 'axiom.nav.typeHierarchy',
      label: 'Axiom: Show Type Hierarchy',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      run: () => runTypeHierarchy(),
    });

    // Inline edit (PRD Phase 187): Cmd/Ctrl+K opens an anchored input to rewrite the
    // selection (or current line) via natural language — reviewable + reversible.
    editor.addAction({
      id: 'axiom.ai.inlineEdit',
      label: 'Axiom AI: Inline Edit (Cmd-K)',
      contextMenuGroupId: 'axiom-ai',
      contextMenuOrder: 0.5,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
      run: () => runInlineEdit(editor, activePathRef.current),
    });

    // Inline chat (PRD Phase 188): Cmd/Ctrl+I opens an anchored bubble for a quick,
    // read-only question about the code; it can escalate to the Cmd-K inline edit.
    editor.addAction({
      id: 'axiom.ai.inlineChat',
      label: 'Axiom AI: Inline Chat (Cmd-I)',
      contextMenuGroupId: 'axiom-ai',
      contextMenuOrder: 0.6,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      run: () => runInlineChat(editor, activePathRef.current),
    });

    // Next-edit prediction (PRD Phase 186): after a single-token rename on a line,
    // find the other occurrences and offer to propagate them (tab-to-jump / apply).
    let focusedLine: { line: number; text: string } | null = null;
    let pendingRename: { oldToken: string; newToken: string; occ: Occurrence[] } | null = null;
    const maybeProposeRename = (prev: { line: number; text: string }): void => {
      const model = editor.getModel();
      if (!model || prev.line > model.getLineCount()) return;
      const rename = diffLineToken(prev.text, model.getLineContent(prev.line));
      if (!rename) return;
      const occ = predictNextEdit(model.getValue(), rename, prev.line);
      if (occ.length === 0) {
        pendingRename = null;
        return;
      }
      pendingRename = { ...rename, occ };
      notifyInfo(
        `Renamed ${rename.oldToken} \u2192 ${rename.newToken}. ${occ.length} more occurrence(s) \u2014 run "Axiom AI: Propagate Rename".`,
        { source: 'Axiom AI' },
      );
    };
    const nextEditModelSub = editor.onDidChangeModel(() => {
      focusedLine = null;
      pendingRename = null;
    });
    editor.addAction({
      id: 'axiom.ai.propagateRename',
      label: 'Axiom AI: Propagate Rename',
      contextMenuGroupId: 'axiom-ai',
      contextMenuOrder: 10,
      run: () => {
        const model = editor.getModel();
        if (!pendingRename || !model) return;
        const { oldToken, newToken, occ } = pendingRename;
        const edits = occ.map((o) => ({
          range: new monaco.Range(o.line, o.column, o.line, o.column + oldToken.length),
          text: newToken,
        }));
        editor.pushUndoStop();
        model.applyEdits(edits);
        editor.pushUndoStop();
        notifyInfo(`Propagated rename to ${edits.length} occurrence(s).`, { source: 'Axiom AI' });
        pendingRename = null;
      },
    });

    const changeSub = editor.onDidChangeModelContent(() => {
      const path = activePathRef.current;
      if (!path) return;
      const model = modelsRef.current.get(path);
      if (!model) return;
      const dirty = isModelDirty(path, model);
      onDirtyRef.current(path, dirty);
      if (dirty && autoSaveRef.current.mode === 'afterDelay') scheduleAutoSave(path);
    });

    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      if (isActiveRef.current) {
        onCursorRef.current(e.position.lineNumber, e.position.column);
        // Publish for the symbol breadcrumb, which needs to know which function
        // the caret is inside.
        setActiveCursor(e.position.lineNumber, e.position.column);
      }
      const model = editor.getModel();
      if (!model) return;
      const line = e.position.lineNumber;
      if (!focusedLine || focusedLine.line !== line) {
        if (focusedLine) maybeProposeRename(focusedLine);
        focusedLine = { line, text: model.getLineContent(line) };
      }
    });

    const selectionSub = editor.onDidChangeCursorSelection(() => {
      if (isActiveRef.current) reportSelection();
    });

    const focusSub = editor.onDidFocusEditorText(() => {
      onFocusGroupRef.current(groupIdRef.current);
    });

    const blurSub = editor.onDidBlurEditorWidget(() => {
      if (autoSaveRef.current.mode === 'onFocusChange') autoSaveActiveIfDirty();
    });

    // Vim modal keymap (PRD Phase 249): when Vim is active, intercept keys and drive
    // the pure state machine, applying the resulting actions as Monaco commands.
    // Modifier chords (Ctrl/Cmd/Alt) pass through so editor shortcuts still work.
    const vimKeySub = editor.onKeyDown((e) => {
      if (keymapRef.current !== 'vim') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const raw = e.browserEvent.key;
      const key = raw === 'Escape' ? 'Escape' : raw.length === 1 ? raw : null;
      if (key === null) return;
      const res = handleVimKey(vimStateRef.current, key);
      vimStateRef.current = res.state;
      setVimStatus(res.state.mode);
      if (res.handled) {
        e.preventDefault();
        e.stopPropagation();
        applyVimActions(editor, res.actions, res.state.mode);
      }
    });

    return () => {
      changeSub.dispose();
      cursorSub.dispose();
      selectionSub.dispose();
      focusSub.dispose();
      blurSub.dispose();
      vimKeySub.dispose();
      bpMouseSub.dispose();
      bpModelSub.dispose();
      inlineValueScrollSub.dispose();
      inlineValueEditSub.dispose();
      window.clearTimeout(inlineValueTimer);
      aiReviewSub();
      nextEditModelSub.dispose();
      editor.dispose();
      editorRef.current = null;
      for (const id of autoSaveTimersRef.current.values()) window.clearTimeout(id);
      autoSaveTimersRef.current.clear();
      modelsRef.current.clear();
      encodingRef.current.clear();
    };
  }, [
    scheduleAutoSave,
    autoSaveActiveIfDirty,
    reportSelection,
    runAiAction,
    refreshBreakpoints,
    refreshInlineValues,
  ]);

  useEffect(() => {
    const previous = activePathRef.current;
    if (
      previous &&
      previous !== activePath &&
      autoSaveRef.current.mode === 'onFocusChange' &&
      isDirtyPath(previous)
    ) {
      void savePath(previous);
    }
    activePathRef.current = activePath;
    if (isActiveRef.current) reportEncoding();
    const editor = editorRef.current;
    if (!editor) return;
    if (!activePath) {
      editor.setModel(null);
      applyFileMode(null);
      if (isActiveRef.current) {
        reportLanguage();
        reportEncoding();
      }
      return;
    }

    const existing = modelsRef.current.get(activePath);
    if (existing) {
      editor.setModel(existing);
      applyFileMode(activePath);
      if (isActiveRef.current) {
        reportLanguage();
        reportEol();
        reportEncoding();
        reportIndent();
      }
      maybeReveal();
      return;
    }

    // Untitled buffers have no file to read: back them with an empty in-memory model.
    if (isUntitledPath(activePath)) {
      const uri = monaco.Uri.parse(activePath);
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', 'plaintext', uri);
      if (getSavedVersion(activePath) === undefined) {
        setSavedVersion(activePath, model.getAlternativeVersionId());
      }
      editableRef.current.set(activePath, true);
      encodingRef.current.set(activePath, UTF8_ENCODING);
      fileEtagsRef.current.set(activePath, null);
      model.updateOptions({
        tabSize: editorSettingsRef.current.tabSize,
        insertSpaces: editorSettingsRef.current.insertSpaces,
      });
      modelsRef.current.set(activePath, model);
      editor.setModel(model);
      applyFileMode(activePath);
      if (isActiveRef.current) {
        reportLanguage();
        reportEol();
        reportEncoding();
        reportIndent();
      }
      return;
    }

    let cancelled = false;
    void window.axiom.fs
      .readFile(activePath)
      .then((file) => {
        if (cancelled) return;
        // Large-file mode (PRD Phases 267–269): classify the file and, when huge, back it
        // with a plaintext model so Monaco skips tokenization entirely.
        const cls = classifyFileForEditor(computeFileMetrics(file.content, file.truncated));
        fileClassRef.current.set(activePath, cls);
        fileEtagsRef.current.set(activePath, file.etag);
        editableRef.current.set(activePath, file.editable);
        encodingRef.current.set(activePath, file.binary ? BINARY_ENCODING : UTF8_ENCODING);
        externalConflictRef.current.delete(activePath);
        const uri = monaco.Uri.file(file.path);
        const existingModel = monaco.editor.getModel(uri);
        const languageId = cls.syntaxHighlight ? languageForPath(activePath) : 'plaintext';
        let model: monaco.editor.ITextModel;
        if (existingModel && !existingModel.isDisposed()) {
          model = existingModel;
          if (model.getValue() !== file.content) {
            model.setValue(file.content);
          }
          monaco.editor.setModelLanguage(model, languageId);
        } else {
          try {
            model = monaco.editor.createModel(file.content, languageId, uri);
          } catch {
            const fallbackUri = monaco.Uri.parse(
              `axiom-fallback://${encodeURIComponent(activePath)}`,
            );
            model =
              monaco.editor.getModel(fallbackUri) ??
              monaco.editor.createModel(file.content, 'plaintext', fallbackUri);
          }
        }
        if (!existingModel || getSavedVersion(activePath) === undefined) {
          setSavedVersion(activePath, model.getAlternativeVersionId());
        }
        model.updateOptions({
          tabSize: editorSettingsRef.current.tabSize,
          insertSpaces: editorSettingsRef.current.insertSpaces,
        });
        if (!existingModel && editorSettingsRef.current.detectIndentation) {
          model.detectIndentation(
            editorSettingsRef.current.insertSpaces,
            editorSettingsRef.current.tabSize,
          );
        }
        modelsRef.current.set(activePath, model);
        if (activePathRef.current === activePath) {
          editor.setModel(model);
          applyFileMode(activePath);
          if (file.readOnlyReason) notifyInfo(file.readOnlyReason, { source: 'Editor' });
          else if (cls.mode !== 'normal') notifyInfo(cls.reason, { source: 'Editor' });
          if (isActiveRef.current) {
            reportLanguage();
            reportEol();
            reportEncoding();
            reportIndent();
          }
          maybeReveal();
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        encodingRef.current.delete(activePath);
        if (activePathRef.current === activePath) {
          editor.setModel(null);
          if (isActiveRef.current) reportEncoding();
        }
        const name = activePath.split(/[\\/]/).pop() ?? activePath;
        notifyError(`Could not open ${name}`, {
          source: 'Editor',
          detail: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activePath, reportEncoding]);

  // Dispose closed-file models and metadata so reopening always reads current disk
  // content. Monaco models are global by URI, so guard against another pane having
  // already disposed the same shared instance.
  useEffect(() => {
    const open = new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.path)));
    for (const [path, model] of modelsRef.current) {
      if (open.has(path)) continue;
      modelsRef.current.delete(path);
      fileEtagsRef.current.delete(path);
      editableRef.current.delete(path);
      encodingRef.current.delete(path);
      externalConflictRef.current.delete(path);
      fileClassRef.current.delete(path);
      clearSavedVersion(path);
      clearAutoSaveTimer(path);
      if (!model.isDisposed()) model.dispose();
    }
  }, [groups, clearAutoSaveTimer]);

  // Reconcile Agent/Safe Edit and other external writes into clean open models.
  // Dirty models are never overwritten; their next save is rejected by the etag
  // guard until the user explicitly reverts or saves elsewhere.
  useEffect(() => {
    if (!rootPath) return;
    let generation = 0;
    const off = window.axiom.fs.onDidChange((event) => {
      if (event.root !== rootPath) return;
      const currentGeneration = ++generation;
      for (const [path, model] of modelsRef.current) {
        if (isUntitledPath(path) || model.isDisposed()) continue;
        void window.axiom.fs
          .readFile(path)
          .then((file) => {
            if (currentGeneration !== generation || model.isDisposed()) return;
            if (fileEtagsRef.current.get(path) === file.etag) return;
            if (isModelDirty(path, model)) {
              if (!externalConflictRef.current.has(path)) {
                externalConflictRef.current.add(path);
                notifyError(`${path.split(/[\\/]/).pop() ?? path} changed on disk`, {
                  source: 'Editor',
                  detail:
                    'Your unsaved editor was preserved. Use Revert to load disk changes or Save As to keep your version.',
                });
              }
              return;
            }
            if (model.getValue() !== file.content) model.setValue(file.content);
            fileEtagsRef.current.set(path, file.etag);
            editableRef.current.set(path, file.editable);
            encodingRef.current.set(path, file.binary ? BINARY_ENCODING : UTF8_ENCODING);
            externalConflictRef.current.delete(path);
            fileClassRef.current.set(
              path,
              classifyFileForEditor(computeFileMetrics(file.content, file.truncated)),
            );
            setSavedVersion(path, model.getAlternativeVersionId());
            onDirtyRef.current(path, false);
            if (activePathRef.current === path) {
              applyFileMode(path);
              if (isActiveRef.current) reportEncoding();
            }
          })
          .catch(() => {
            if (currentGeneration !== generation || externalConflictRef.current.has(path)) return;
            externalConflictRef.current.add(path);
            notifyError(`${path.split(/[\\/]/).pop() ?? path} is no longer available on disk`, {
              source: 'Editor',
              detail: 'The open buffer was preserved. Use Save As if you need to keep it.',
            });
          });
      }
    });
    return () => {
      generation += 1;
      off();
    };
  }, [rootPath, applyFileMode, reportEncoding]);

  // Editor accessibility (PRD Phases 253/254): keep the ARIA label in sync with the
  // active file and announce file opens to screen readers (only the focused pane).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!activePath) {
      editor.updateOptions({ ariaLabel: 'Axiom code editor' });
      return;
    }
    const name = activePath.split(/[\\/]/).pop() ?? activePath;
    const language = languageForPath(activePath);
    editor.updateOptions({ ariaLabel: editorAriaLabel(name, language) });
    if (isActiveRef.current) announce(announceForFileOpen(name, language).text, 'polite');
  }, [activePath]);

  return <div className="editor-host" ref={hostRef} />;
}
