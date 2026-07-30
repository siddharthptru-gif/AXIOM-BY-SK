import { monaco } from './monacoEnv';
import type {
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentSymbol,
  LspRange,
  LspTextEdit,
  LspWorkspaceEdit,
} from '../../../common/ipc';

/**
 * Pure conversions between LSP's wire shapes (0-based, its own enums) and
 * Monaco's (1-based, different enums). Kept separate from provider registration
 * so the mappings can be read and checked in one place — an off-by-one or a
 * mismatched enum here is the difference between a working IDE and a subtly
 * wrong one.
 */

export function lspRangeToMonaco(range: LspRange): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

export function monacoRangeToLsp(range: monaco.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function monacoPositionToLsp(position: monaco.IPosition): {
  line: number;
  character: number;
} {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP severity (1 error…4 hint) → Monaco MarkerSeverity. */
export function severityToMarker(severity: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

/** Monaco MarkerSeverity (8/4/2/1) → LSP severity (1/2/3/4). */
export function markerToLspSeverity(sev: monaco.MarkerSeverity): number {
  if (sev === monaco.MarkerSeverity.Error) return 1;
  if (sev === monaco.MarkerSeverity.Warning) return 2;
  if (sev === monaco.MarkerSeverity.Info) return 3;
  return 4;
}

/**
 * LSP CompletionItemKind (1-based, its own order) → Monaco CompletionItemKind
 * (0-based, a different order). Written out in full because the two enums share
 * neither origin nor ordering, and a wrong entry shows the wrong icon.
 */
export function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 1:
      return K.Text;
    case 2:
      return K.Method;
    case 3:
      return K.Function;
    case 4:
      return K.Constructor;
    case 5:
      return K.Field;
    case 6:
      return K.Variable;
    case 7:
      return K.Class;
    case 8:
      return K.Interface;
    case 9:
      return K.Module;
    case 10:
      return K.Property;
    case 11:
      return K.Unit;
    case 12:
      return K.Value;
    case 13:
      return K.Enum;
    case 14:
      return K.Keyword;
    case 15:
      return K.Snippet;
    case 16:
      return K.Color;
    case 17:
      return K.File;
    case 18:
      return K.Reference;
    case 19:
      return K.Folder;
    case 20:
      return K.EnumMember;
    case 21:
      return K.Constant;
    case 22:
      return K.Struct;
    case 23:
      return K.Event;
    case 24:
      return K.Operator;
    case 25:
      return K.TypeParameter;
    default:
      return K.Text;
  }
}

/** LSP SymbolKind (1-based) → Monaco SymbolKind (0-based, same order). */
export function symbolKind(lspKind: number): monaco.languages.SymbolKind {
  const k = lspKind - 1;
  return (
    k >= 0 && k <= 25 ? k : monaco.languages.SymbolKind.Variable
  ) as monaco.languages.SymbolKind;
}

export function highlightKind(kind: number): monaco.languages.DocumentHighlightKind {
  const K = monaco.languages.DocumentHighlightKind;
  if (kind === 2) return K.Read;
  if (kind === 3) return K.Write;
  return K.Text;
}

export function toMonacoSymbol(s: LspDocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? '',
    kind: symbolKind(s.kind),
    tags: [],
    range: lspRangeToMonaco(s.range),
    selectionRange: lspRangeToMonaco(s.selectionRange),
    children: s.children.map(toMonacoSymbol),
  };
}

export function textEditToMonaco(edit: LspTextEdit): monaco.languages.TextEdit {
  return { range: lspRangeToMonaco(edit.range), text: edit.newText };
}

/** Convert an LSP WorkspaceEdit to Monaco workspace text edits. */
export function workspaceEditToMonaco(
  edit: LspWorkspaceEdit,
): monaco.languages.IWorkspaceTextEdit[] {
  const out: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, edits] of Object.entries(edit.changes)) {
    const resource = monaco.Uri.parse(uri);
    for (const e of edits) {
      out.push({
        resource,
        textEdit: { range: lspRangeToMonaco(e.range), text: e.newText },
        versionId: undefined,
      });
    }
  }
  return out;
}

/**
 * LSP DiagnosticTag → Monaco MarkerTag. The values coincide (1 unnecessary,
 * 2 deprecated) but they are mapped explicitly rather than cast, so a future
 * divergence in either enum surfaces here instead of mis-rendering.
 */
function markerTags(tags: number[] | undefined): monaco.MarkerTag[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: monaco.MarkerTag[] = [];
  for (const tag of tags) {
    if (tag === 1) out.push(monaco.MarkerTag.Unnecessary);
    else if (tag === 2) out.push(monaco.MarkerTag.Deprecated);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build the Monaco marker for one diagnostic, preserving everything the server
 * sent: the rule code (linked to its documentation when provided), the tags that
 * make unused code fade and deprecated code strike through, and the related
 * locations that explain *why* — all of which used to be dropped.
 */
export function diagnosticToMarker(
  diagnostic: LspDiagnostic,
  fallbackSource: string,
): monaco.editor.IMarkerData {
  const marker: monaco.editor.IMarkerData = {
    severity: severityToMarker(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? fallbackSource,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  };
  if (diagnostic.code !== undefined) {
    marker.code =
      diagnostic.codeDescription === undefined
        ? diagnostic.code
        : { value: diagnostic.code, target: monaco.Uri.parse(diagnostic.codeDescription) };
  }
  const tags = markerTags(diagnostic.tags);
  if (tags) marker.tags = tags;
  if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
    marker.relatedInformation = diagnostic.relatedInformation.map((related) => ({
      resource: monaco.Uri.parse(related.location.uri),
      message: related.message,
      startLineNumber: related.location.range.start.line + 1,
      startColumn: related.location.range.start.character + 1,
      endLineNumber: related.location.range.end.line + 1,
      endColumn: related.location.range.end.character + 1,
    }));
  }
  return marker;
}

/** A Monaco completion item that remembers its Main-side resolve handle. */
export interface LspBackedCompletionItem extends monaco.languages.CompletionItem {
  /** Handle for `completionItem/resolve`; absent when the server cannot resolve. */
  axiomHandle?: number;
  /** URI the item was produced for, so resolve routes to the right document. */
  axiomUri?: string;
}

const SNIPPET_INSERT_TEXT_FORMAT = 2;

/**
 * Convert one completion item. `defaultRange` is the word Monaco would replace;
 * a server-supplied `textEdit` wins over it, which is what makes member and
 * path completions land in the right place.
 */
export function toMonacoCompletion(
  it: LspCompletionItem,
  defaultRange: monaco.IRange,
  uri: string,
  commandId: string,
): LspBackedCompletionItem {
  const range = it.textEdit ? lspRangeToMonaco(it.textEdit.range) : defaultRange;
  const insertText = it.textEdit?.newText ?? it.insertText ?? it.label;
  const item: LspBackedCompletionItem = {
    label:
      it.labelDetail === undefined && it.labelDescription === undefined
        ? it.label
        : {
            label: it.label,
            ...(it.labelDetail === undefined ? {} : { detail: it.labelDetail }),
            ...(it.labelDescription === undefined ? {} : { description: it.labelDescription }),
          },
    kind: completionKind(it.kind),
    insertText,
    range,
  };
  if (it.insertTextFormat === SNIPPET_INSERT_TEXT_FORMAT) {
    item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  if (it.detail !== undefined) item.detail = it.detail;
  if (it.documentation !== undefined) {
    item.documentation = it.documentationIsMarkdown
      ? { value: it.documentation, isTrusted: false }
      : it.documentation;
  }
  if (it.sortText !== undefined) item.sortText = it.sortText;
  if (it.filterText !== undefined) item.filterText = it.filterText;
  if (it.preselect === true) item.preselect = true;
  if (it.commitCharacters !== undefined) item.commitCharacters = it.commitCharacters;
  if (it.deprecated === true) item.tags = [monaco.languages.CompletionItemTag.Deprecated];
  if (it.additionalTextEdits !== undefined) {
    item.additionalTextEdits = it.additionalTextEdits.map(textEditToMonaco);
  }
  // A completion may carry a server command (tsserver's import fixers). Route it
  // through Main by handle so no command payload crosses back from the renderer.
  if (it.command !== undefined && it.id !== undefined) {
    item.command = { id: commandId, title: it.command.title, arguments: [uri, it.id] };
  }
  if (it.id !== undefined) {
    item.axiomHandle = it.id;
    item.axiomUri = uri;
  }
  return item;
}

/** Merge resolved detail back onto the item Monaco is already showing. */
export function applyResolvedCompletion(
  item: LspBackedCompletionItem,
  resolved: LspCompletionItem,
): void {
  if (resolved.detail !== undefined) item.detail = resolved.detail;
  if (resolved.documentation !== undefined) {
    item.documentation = resolved.documentationIsMarkdown
      ? { value: resolved.documentation, isTrusted: false }
      : resolved.documentation;
  }
  // The reason resolve matters: this is where the import statement arrives.
  if (resolved.additionalTextEdits !== undefined) {
    item.additionalTextEdits = resolved.additionalTextEdits.map(textEditToMonaco);
  }
  if (resolved.insertTextFormat === SNIPPET_INSERT_TEXT_FORMAT) {
    item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }
  if (resolved.textEdit !== undefined) {
    item.insertText = resolved.textEdit.newText;
    item.range = lspRangeToMonaco(resolved.textEdit.range);
  }
}

/** LSP folding-range kind → Monaco's, so imports/comments fold with the right label. */
export function foldingKind(
  kind: string | undefined,
): monaco.languages.FoldingRangeKind | undefined {
  if (kind === 'comment') return monaco.languages.FoldingRangeKind.Comment;
  if (kind === 'imports') return monaco.languages.FoldingRangeKind.Imports;
  if (kind === 'region') return monaco.languages.FoldingRangeKind.Region;
  return undefined;
}

/**
 * tsserver may re-case or re-encode a URI; match the model by fsPath as a
 * fallback so diagnostics still land on the right buffer on Windows.
 */
export function findModel(uri: string): monaco.editor.ITextModel | null {
  const direct = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (direct) return direct;
  let target: string;
  try {
    target = monaco.Uri.parse(uri).fsPath.toLowerCase();
  } catch {
    return null;
  }
  for (const m of monaco.editor.getModels()) {
    if (m.uri.scheme === 'file' && m.uri.fsPath.toLowerCase() === target) return m;
  }
  return null;
}

/** Apply LSP text edits to raw text (for edit targets not open as Monaco models). */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const offsetOf = (line: number, character: number): number => {
    const base = lineStarts[Math.min(line, lineStarts.length - 1)] ?? 0;
    return Math.min(base + character, text.length);
  };
  // Apply from the end backwards so earlier edits don't shift later offsets.
  const sorted = [...edits].sort(
    (a, b) =>
      offsetOf(b.range.start.line, b.range.start.character) -
      offsetOf(a.range.start.line, a.range.start.character),
  );
  let result = text;
  for (const e of sorted) {
    const start = offsetOf(e.range.start.line, e.range.start.character);
    const end = offsetOf(e.range.end.line, e.range.end.character);
    result = result.slice(0, start) + e.newText + result.slice(end);
  }
  return result;
}
