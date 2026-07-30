/**
 * Wire → Monaco conversions for extension language providers (PRD Phase 6).
 *
 * `common/vscodeLanguageWire.ts` reduced whatever the extension returned to a bounded, sanitised,
 * LSP-shaped value. This module turns that value into what Monaco's provider interfaces demand:
 * 1-based coordinates, Monaco's own enums, `Uint32Array` token data, `IMarkdownString` instead of
 * `MarkdownString`. It is the mirror image of the worker-side normalisers and, like them, contains
 * no I/O — every function here is a total function from a wire value to a Monaco value.
 *
 * The conversions the language-server path already needed are reused from `lspConvert.ts` rather
 * than written a second time: extension providers and language servers reach Monaco through the
 * same code, so an off-by-one can only exist in one place.
 *
 * Two rules are load-bearing rather than stylistic:
 *   - Markdown is never trusted with HTML. `supportHtml` is not set, so Monaco escapes any HTML an
 *     extension put in a hover; command links are enabled only for the commands the sanitiser in
 *     `vscodeLanguageWire.ts` already vetted and listed.
 *   - A `WorkspaceEdit` is split, never forwarded whole. Standalone Monaco's bulk-edit service
 *     accepts text edits for models it has open and throws on anything else, so `splitWorkspaceEdit`
 *     keeps what Monaco can apply and hands the rest back for Main to apply under the same
 *     workspace-boundary check an extension's own `workspace.applyEdit` goes through.
 */
import { monaco } from './monacoEnv';
import type {
  LspCommand,
  LspDocumentSymbol,
  LspFoldingRange,
  LspRange,
  LspSemanticTokens,
  LspSymbolInformation,
  ExtensionProviderEditInput,
} from '../../../common/ipc';
import type {
  WireCodeAction,
  WireCodeLens,
  WireColorInformation,
  WireColorPresentation,
  WireCompletionItem,
  WireCompletionList,
  WireDocumentLink,
  WireHierarchyItem,
  WireHover,
  WireInlayHint,
  WireLinkedEditingRanges,
  WireLocationLink,
  WireMarkdown,
  WirePrepareRename,
  WireSemanticTokensEdits,
  WireSignatureHelp,
  WireTextEdit,
  WireWorkspaceEdit,
} from '../../../common/vscodeLanguageWire';
import type { LanguageConfigurationData } from '../../../common/vscodeLanguages';
import type { RefLocation } from '../../../common/callHierarchy';
import {
  completionKind,
  diagnosticToMarker,
  findModel,
  foldingKind,
  highlightKind,
  lspRangeToMonaco,
  symbolKind,
  toMonacoSymbol,
} from './lspConvert';

/* ------------------------------------------------------------------ markdown */

/**
 * A wire markdown block as an `IMarkdownString`.
 *
 * `supportHtml` is deliberately absent: with it unset Monaco renders the markdown through its own
 * renderer and escapes embedded HTML, which is the whole reason an extension cannot script the
 * window through a hover. `isTrusted` is granted only as `{ enabledCommands }` — never `true` — so
 * a `command:` link works for the commands the sanitiser recognised and for no others.
 */
export function markdownString(block: WireMarkdown): monaco.IMarkdownString {
  const commands = block.commands;
  return {
    value: block.value,
    supportThemeIcons: true,
    isTrusted:
      commands !== undefined && commands.length > 0 ? { enabledCommands: commands } : false,
  };
}

/** Command ids reachable from markdown in the results returned so far. */
export function markdownCommands(blocks: readonly WireMarkdown[]): string[] {
  const out = new Set<string>();
  for (const block of blocks) for (const command of block.commands ?? []) out.add(command);
  return [...out];
}

/* ------------------------------------------------------------------ commands */

/**
 * A provider-supplied `Command` as something Monaco will invoke.
 *
 * Monaco can only run commands registered with its own command service, and an extension's commands
 * live in the extension host. So every provider command becomes an invocation of one shim command
 * that carries the real id and arguments as data — the same indirection the language-server path
 * uses, and the reason no extension-authored payload is ever executed in the renderer.
 */
export function toMonacoCommand(command: LspCommand, shimId: string): monaco.languages.Command {
  return {
    id: shimId,
    title: command.title,
    arguments: [command.command, command.arguments ?? []],
  };
}

/* --------------------------------------------------------------------- hover */

export function toMonacoHover(value: WireHover): monaco.languages.Hover | null {
  if (value.contents.length === 0) return null;
  return {
    contents: value.contents.map(markdownString),
    ...(value.range !== undefined ? { range: lspRangeToMonaco(value.range) } : {}),
  };
}

/* ---------------------------------------------------------------- completion */

/** A Monaco completion item that remembers how to ask its provider to resolve it. */
export interface ExtensionCompletionItem extends monaco.languages.CompletionItem {
  /** Mint token for `resolveCompletionItem`; absent when the provider has no resolve. */
  axiomId?: number;
  /** Provider handle the item came from, so resolve reaches the same provider. */
  axiomHandle?: number;
  /** Document the item was produced for. */
  axiomUri?: string;
}

const SNIPPET_FORMAT = 2;

/** Where the inserted text goes: a provider may give one range, or an insert/replace pair. */
function completionRange(
  item: WireCompletionItem,
  fallback: monaco.IRange,
): monaco.languages.CompletionItem['range'] {
  if (item.insertRange !== undefined && item.replaceRange !== undefined) {
    return {
      insert: lspRangeToMonaco(item.insertRange),
      replace: lspRangeToMonaco(item.replaceRange),
    };
  }
  if (item.textEdit !== undefined) return lspRangeToMonaco(item.textEdit.range);
  return fallback;
}

function insertTextRules(
  item: WireCompletionItem,
): monaco.languages.CompletionItemInsertTextRule | undefined {
  const R = monaco.languages.CompletionItemInsertTextRule;
  let rules = 0;
  if (item.insertTextFormat === SNIPPET_FORMAT) rules |= R.InsertAsSnippet;
  if (item.keepWhitespace === true) rules |= R.KeepWhitespace;
  return rules === 0 ? undefined : (rules as monaco.languages.CompletionItemInsertTextRule);
}

function completionLabel(item: WireCompletionItem): monaco.languages.CompletionItem['label'] {
  if (item.labelDetail === undefined && item.labelDescription === undefined) return item.label;
  return {
    label: item.label,
    ...(item.labelDetail === undefined ? {} : { detail: item.labelDetail }),
    ...(item.labelDescription === undefined ? {} : { description: item.labelDescription }),
  };
}

/** Documentation as markdown when the provider used a `MarkdownString`, plain text otherwise. */
function documentation(item: {
  documentation?: string;
  documentationIsMarkdown?: boolean;
}): string | monaco.IMarkdownString | undefined {
  if (item.documentation === undefined) return undefined;
  return item.documentationIsMarkdown === true
    ? { value: item.documentation, isTrusted: false, supportThemeIcons: true }
    : item.documentation;
}

/**
 * One completion item.
 *
 * `fallback` is the word Monaco would replace if the provider expressed no opinion; a provider's own
 * `textEdit` or insert/replace pair wins over it, which is what makes member and path completions
 * land where the extension intended rather than where the current word happens to end.
 */
export function toMonacoCompletionItem(
  item: WireCompletionItem,
  fallback: monaco.IRange,
  context: { uri: string; handle: number; shimId: string },
): ExtensionCompletionItem {
  const out: ExtensionCompletionItem = {
    label: completionLabel(item),
    kind: completionKind(item.kind),
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    range: completionRange(item, fallback),
  };
  const rules = insertTextRules(item);
  if (rules !== undefined) out.insertTextRules = rules;
  if (item.detail !== undefined) out.detail = item.detail;
  const docs = documentation(item);
  if (docs !== undefined) out.documentation = docs;
  if (item.sortText !== undefined) out.sortText = item.sortText;
  if (item.filterText !== undefined) out.filterText = item.filterText;
  if (item.preselect === true) out.preselect = true;
  if (item.commitCharacters !== undefined) out.commitCharacters = item.commitCharacters;
  if (item.deprecated === true || item.tags?.includes(1) === true) {
    out.tags = [monaco.languages.CompletionItemTag.Deprecated];
  }
  if (item.additionalTextEdits !== undefined) {
    out.additionalTextEdits = item.additionalTextEdits.map(toMonacoTextEdit);
  }
  if (item.command !== undefined) out.command = toMonacoCommand(item.command, context.shimId);
  if (item.id !== undefined) {
    out.axiomId = item.id;
    out.axiomHandle = context.handle;
    out.axiomUri = context.uri;
  }
  return out;
}

export function toMonacoCompletionList(
  list: WireCompletionList,
  fallback: monaco.IRange,
  context: { uri: string; handle: number; shimId: string },
): monaco.languages.CompletionList {
  return {
    suggestions: list.items.map((item) => toMonacoCompletionItem(item, fallback, context)),
    incomplete: list.isIncomplete === true,
  };
}

/**
 * Fold a resolved item back onto the one already on screen.
 *
 * Resolution is where the interesting parts of a completion arrive — the documentation an extension
 * did not want to compute for every candidate, and the `additionalTextEdits` that insert an import.
 * Monaco mutates the item in place, so this assigns onto the object it is holding.
 */
export function applyResolvedExtensionCompletion(
  item: ExtensionCompletionItem,
  resolved: WireCompletionItem,
): void {
  if (resolved.detail !== undefined) item.detail = resolved.detail;
  const docs = documentation(resolved);
  if (docs !== undefined) item.documentation = docs;
  if (resolved.additionalTextEdits !== undefined) {
    item.additionalTextEdits = resolved.additionalTextEdits.map(toMonacoTextEdit);
  }
  const rules = insertTextRules(resolved);
  if (rules !== undefined) item.insertTextRules = rules;
  if (resolved.textEdit !== undefined) {
    item.insertText = resolved.textEdit.newText;
    item.range = lspRangeToMonaco(resolved.textEdit.range);
  }
  if (resolved.commitCharacters !== undefined) item.commitCharacters = resolved.commitCharacters;
}

/* ---------------------------------------------------------------- text edits */

export function toMonacoTextEdit(edit: WireTextEdit): monaco.languages.TextEdit {
  return { range: lspRangeToMonaco(edit.range), text: edit.newText };
}

export function toMonacoTextEdits(edits: readonly WireTextEdit[]): monaco.languages.TextEdit[] {
  return edits.map(toMonacoTextEdit);
}

/* ----------------------------------------------------------- signature help */

export function toMonacoSignatureHelp(
  help: WireSignatureHelp,
): monaco.languages.SignatureHelpResult | null {
  if (help.signatures.length === 0) return null;
  const value: monaco.languages.SignatureHelp = {
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
    signatures: help.signatures.map((signature) => {
      const out: monaco.languages.SignatureInformation = {
        label: signature.label,
        parameters: signature.parameters.map((parameter) => {
          const info: monaco.languages.ParameterInformation = {
            // Offsets are how a provider highlights a parameter inside an overload whose label
            // repeats a name; Monaco takes the pair verbatim and the substring otherwise.
            label: parameter.labelOffsets ?? parameter.label,
          };
          const docs = documentation({
            ...(parameter.documentation === undefined
              ? {}
              : { documentation: parameter.documentation }),
            ...(parameter.documentationIsMarkdown === true
              ? { documentationIsMarkdown: true }
              : {}),
          });
          if (docs !== undefined) info.documentation = docs;
          return info;
        }),
      };
      const docs = documentation(signature);
      if (docs !== undefined) out.documentation = docs;
      if (signature.activeParameter !== undefined) out.activeParameter = signature.activeParameter;
      return out;
    }),
  };
  return { value, dispose: () => undefined };
}

/* ---------------------------------------------------------------- navigation */

/**
 * `Location` and `LocationLink` share one wire shape, and Monaco's `LocationLink` is a superset of
 * its `Location`, so both arrive as links. The extra ranges are simply absent for a plain location,
 * which is exactly what Monaco expects.
 */
export function toMonacoLocationLinks(
  links: readonly WireLocationLink[],
): monaco.languages.LocationLink[] {
  const out: monaco.languages.LocationLink[] = [];
  for (const link of links) {
    let resource: monaco.Uri;
    try {
      resource = monaco.Uri.parse(link.uri);
    } catch {
      continue;
    }
    out.push({
      uri: resource,
      range: lspRangeToMonaco(link.range),
      ...(link.targetSelectionRange !== undefined
        ? { targetSelectionRange: lspRangeToMonaco(link.targetSelectionRange) }
        : {}),
      ...(link.originSelectionRange !== undefined
        ? { originSelectionRange: lspRangeToMonaco(link.originSelectionRange) }
        : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------- symbols */

/** A flat `SymbolInformation` as a childless outline node; its container becomes the detail line. */
function flatSymbolToMonaco(symbol: LspSymbolInformation): monaco.languages.DocumentSymbol {
  const range = lspRangeToMonaco(symbol.location.range);
  return {
    name: symbol.name,
    detail: symbol.containerName ?? '',
    kind: symbolKind(symbol.kind),
    tags: [],
    range,
    selectionRange: range,
  };
}

export function toMonacoDocumentSymbols(result: {
  symbols: LspDocumentSymbol[];
  flat: LspSymbolInformation[];
}): monaco.languages.DocumentSymbol[] {
  return [...result.symbols.map(toMonacoSymbol), ...result.flat.map(flatSymbolToMonaco)];
}

/* ---------------------------------------------------------------- code lenses */

/** A Monaco code lens that remembers the provider and mint token needed to resolve it. */
export interface ExtensionCodeLens extends monaco.languages.CodeLens {
  axiomId?: number;
  axiomHandle?: number;
}

export function toMonacoCodeLens(
  lens: WireCodeLens,
  context: { handle: number; shimId: string },
): ExtensionCodeLens {
  const out: ExtensionCodeLens = { range: lspRangeToMonaco(lens.range) };
  if (lens.command !== undefined) out.command = toMonacoCommand(lens.command, context.shimId);
  if (lens.id !== undefined) {
    out.axiomId = lens.id;
    out.axiomHandle = context.handle;
  }
  return out;
}

/* ------------------------------------------------------------ document links */

/** A Monaco link that remembers how to ask its provider for the target it withheld. */
export interface ExtensionLink extends monaco.languages.ILink {
  axiomId?: number;
  axiomHandle?: number;
}

export function toMonacoLink(
  link: WireDocumentLink,
  context: { handle: number },
): ExtensionLink | null {
  const out: ExtensionLink = { range: lspRangeToMonaco(link.range) };
  if (link.target !== undefined) {
    // `toWireUri` already rejected unsafe schemes; a target Monaco cannot parse is dropped rather
    // than handed over as a string, since Monaco would then treat it as a relative path.
    try {
      out.url = monaco.Uri.parse(link.target);
    } catch {
      return null;
    }
  }
  if (link.tooltip !== undefined) out.tooltip = link.tooltip;
  if (link.id !== undefined) {
    out.axiomId = link.id;
    out.axiomHandle = context.handle;
  }
  return out;
}

/* ----------------------------------------------------------------- inlay hints */

/** LSP/`vscode` InlayHintKind → Monaco's. The values coincide; mapped so a divergence shows here. */
function inlayKind(kind: number | undefined): monaco.languages.InlayHintKind | undefined {
  if (kind === 1) return monaco.languages.InlayHintKind.Type;
  if (kind === 2) return monaco.languages.InlayHintKind.Parameter;
  return undefined;
}

/** A Monaco inlay hint that remembers the provider and mint token needed to resolve it. */
export interface ExtensionInlayHint extends monaco.languages.InlayHint {
  axiomId?: number;
  axiomHandle?: number;
}

export function toMonacoInlayHint(
  hint: WireInlayHint,
  context: { handle: number },
): ExtensionInlayHint {
  const out: ExtensionInlayHint = {
    label: hint.label,
    position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
  };
  const kind = inlayKind(hint.kind);
  if (kind !== undefined) out.kind = kind;
  if (hint.paddingLeft === true) out.paddingLeft = true;
  if (hint.paddingRight === true) out.paddingRight = true;
  if (hint.tooltip !== undefined) out.tooltip = markdownString(hint.tooltip);
  if (hint.textEdits !== undefined) out.textEdits = hint.textEdits.map(toMonacoTextEdit);
  if (hint.id !== undefined) {
    out.axiomId = hint.id;
    out.axiomHandle = context.handle;
  }
  return out;
}

/** Fold a resolved hint back onto the one Monaco is holding. */
export function applyResolvedInlayHint(hint: ExtensionInlayHint, resolved: WireInlayHint): void {
  if (resolved.tooltip !== undefined) hint.tooltip = markdownString(resolved.tooltip);
  if (resolved.textEdits !== undefined) hint.textEdits = resolved.textEdits.map(toMonacoTextEdit);
  hint.label = resolved.label;
}

/* --------------------------------------------------------------------- colour */

export function toMonacoColorInformation(
  info: WireColorInformation,
): monaco.languages.IColorInformation {
  return {
    range: lspRangeToMonaco(info.range),
    color: {
      red: info.color.red,
      green: info.color.green,
      blue: info.color.blue,
      alpha: info.color.alpha,
    },
  };
}

export function toMonacoColorPresentation(
  presentation: WireColorPresentation,
): monaco.languages.IColorPresentation {
  return {
    label: presentation.label,
    ...(presentation.textEdit !== undefined
      ? { textEdit: toMonacoTextEdit(presentation.textEdit) }
      : {}),
    ...(presentation.additionalTextEdits !== undefined
      ? { additionalTextEdits: presentation.additionalTextEdits.map(toMonacoTextEdit) }
      : {}),
  };
}

/* ------------------------------------------------- folding, highlights, ranges */

export function toMonacoFoldingRange(range: LspFoldingRange): monaco.languages.FoldingRange {
  const kind = foldingKind(range.kind);
  return {
    start: range.startLine + 1,
    end: range.endLine + 1,
    ...(kind !== undefined ? { kind } : {}),
  };
}

export function toMonacoHighlight(highlight: {
  range: LspRange;
  kind: number;
}): monaco.languages.DocumentHighlight {
  return { range: lspRangeToMonaco(highlight.range), kind: highlightKind(highlight.kind) };
}

/** One chain per requested position, innermost first — Monaco widens through them in order. */
export function toMonacoSelectionRanges(chains: LspRange[][]): monaco.languages.SelectionRange[][] {
  return chains.map((chain) => chain.map((range) => ({ range: lspRangeToMonaco(range) })));
}

/**
 * Linked editing ranges, with the provider's word pattern compiled here.
 *
 * The pattern crossed the wire as source text precisely so that this compilation happens in one
 * place: an extension can ship an unparseable pattern, and the linked-editing feature degrading to
 * "no word pattern" is preferable to a throw inside Monaco's edit loop.
 */
export function toMonacoLinkedEditingRanges(
  value: WireLinkedEditingRanges,
): monaco.languages.LinkedEditingRanges | null {
  if (value.ranges.length === 0) return null;
  const ranges = value.ranges.map(lspRangeToMonaco);
  if (value.wordPattern === undefined) return { ranges };
  try {
    return { ranges, wordPattern: new RegExp(value.wordPattern) };
  } catch {
    return { ranges };
  }
}

/* ----------------------------------------------------------- semantic tokens */

export function toMonacoSemanticTokens(tokens: LspSemanticTokens): monaco.languages.SemanticTokens {
  const data = new Uint32Array(tokens.data);
  return tokens.resultId === undefined ? { data } : { resultId: tokens.resultId, data };
}

export function toMonacoSemanticTokensEdits(
  value: WireSemanticTokensEdits,
): monaco.languages.SemanticTokensEdits {
  const edits = value.edits.map((edit) => ({
    start: edit.start,
    deleteCount: edit.deleteCount,
    ...(edit.data !== undefined ? { data: new Uint32Array(edit.data) } : {}),
  }));
  return value.resultId === undefined ? { edits } : { resultId: value.resultId, edits };
}

/* --------------------------------------------------------------------- rename */

/**
 * `prepareRename` for Monaco's rename widget.
 *
 * A provider says "this cannot be renamed" by returning a null range, and Monaco says the same by
 * rejecting with a `rejectReason`, so the two are translated rather than passed through.
 */
export function toMonacoRenameLocation(
  value: WirePrepareRename,
  fallbackText: string,
): monaco.languages.RenameLocation & monaco.languages.Rejection {
  if (value.range === null) {
    return {
      range: new monaco.Range(1, 1, 1, 1),
      text: fallbackText,
      rejectReason: 'That symbol cannot be renamed here.',
    };
  }
  return { range: lspRangeToMonaco(value.range), text: value.placeholder ?? fallbackText };
}

/* ------------------------------------------------------------------ hierarchy */

/** A hierarchy node's own position, as the workbench panels express positions (1-based). */
export function hierarchyItemToRef(item: WireHierarchyItem): RefLocation | null {
  let path: string;
  try {
    path = monaco.Uri.parse(item.uri).fsPath;
  } catch {
    return null;
  }
  return {
    path,
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
  };
}

/* ------------------------------------------------------------ snippet edits */

/**
 * Reduce snippet source to the text it inserts.
 *
 * A `SnippetTextEdit` is only interactive when it lands in the editor the user is typing in, and
 * Monaco's public API offers no way to start a snippet session for an arbitrary edit in an arbitrary
 * model. Writing the snippet source verbatim would put `${1:name}` in the user's file, which is the
 * one outcome worse than losing the tabstops, so placeholders collapse to their default text and
 * choices to their first option — the same text the user would get by pressing Escape immediately.
 * The offset of the final tabstop is returned so the caller can leave the cursor there.
 */
export function collapseSnippet(source: string): { text: string; cursor: number | null } {
  let out = '';
  let cursor: number | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\\' && index + 1 < source.length) {
      const next = source[index + 1] as string;
      out += '$}\\'.includes(next) ? next : char + next;
      index += 2;
      continue;
    }
    if (char !== '$') {
      out += char;
      index += 1;
      continue;
    }
    if (source[index + 1] === '{') {
      const end = matchingBrace(source, index + 1);
      if (end === -1) {
        out += char;
        index += 1;
        continue;
      }
      const [name, value] = splitPlaceholder(source.slice(index + 2, end));
      if (name === '0') cursor = out.length;
      out += value === null ? '' : collapseSnippet(value).text;
      index = end + 1;
      continue;
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)/.exec(source.slice(index + 1))?.[1];
    if (name === undefined) {
      out += char;
      index += 1;
      continue;
    }
    if (name === '0') cursor = out.length;
    index += 1 + name.length;
  }
  return { text: out, cursor };
}

/** Index of the `}` closing the `{` at `open`, honouring escapes and nesting. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Split `1:default`, `1|a,b|`, `1/find/replace/g` or a bare name into its name and inserted text.
 *
 * A transform placeholder inserts nothing on its own — it rewrites another tabstop's text — so it
 * collapses to the empty string rather than to its regular expression.
 */
function splitPlaceholder(body: string): [string, string | null] {
  const separator = /[:|/]/.exec(body);
  if (separator === null || separator.index === undefined) return [body, null];
  const name = body.slice(0, separator.index);
  const rest = body.slice(separator.index + 1);
  if (separator[0] === ':') return [name, rest];
  if (separator[0] === '|') return [name, rest.replace(/\|$/, '').split(',')[0] ?? null];
  return [name, null];
}

/* ----------------------------------------------------------- workspace edits */

/** What each part of a provider `WorkspaceEdit` is applied by. */
export interface SplitWorkspaceEdit {
  /** Plain text edits for models Monaco has open: its bulk-edit service, its undo stack. */
  monacoEdits: monaco.languages.IWorkspaceTextEdit[];
  /** Snippet edits for open models, collapsed; applied on the model to keep one undo step. */
  localEdits: Array<{ uri: string; edits: monaco.languages.TextEdit[] }>;
  /** Closed files and file operations, for Main to apply under the workspace-boundary check. */
  residual: ExtensionProviderEditInput | null;
}

/**
 * Decide who applies each part of a provider-returned `WorkspaceEdit`.
 *
 * Standalone Monaco's bulk-edit service accepts exactly one thing — a text edit against a model it
 * already has — and throws on everything else, so handing it a rename that touches twenty closed
 * files or a refactoring that creates a file fails the whole edit. Splitting is what makes those
 * work: Monaco gets the edits it can apply (which is also where the user wants undo and preview),
 * and the rest goes to Main, where `validateWorkspaceEdit` checks it against the live workspace
 * roots exactly as it does for an extension's own `workspace.applyEdit`.
 *
 * An edit containing any file operation goes to Main whole. Upstream's `WorkspaceEdit` is an ordered
 * list, and "create the file, then write to it" is not the same edit as the reverse; splitting an
 * ordered list across two appliers would reorder it. Main preserves the order and pushes back the
 * entries that need an open editor, so nothing is lost and nothing is applied twice.
 */
export function splitWorkspaceEdit(edit: WireWorkspaceEdit): SplitWorkspaceEdit {
  const hasFileOperation = edit.entries.some((entry) => entry.kind !== 'text');
  if (hasFileOperation) {
    return { monacoEdits: [], localEdits: [], residual: { entries: edit.entries } };
  }
  const monacoEdits: monaco.languages.IWorkspaceTextEdit[] = [];
  const localEdits: SplitWorkspaceEdit['localEdits'] = [];
  const residual: ExtensionProviderEditInput['entries'] = [];
  for (const entry of edit.entries) {
    if (entry.kind !== 'text') continue;
    const model = findModel(entry.uri);
    if (model === null) {
      residual.push(entry);
      continue;
    }
    if (entry.edits.some((one) => one.insertAsSnippet === true)) {
      localEdits.push({ uri: model.uri.toString(), edits: entry.edits.map(snippetAwareEdit) });
      continue;
    }
    for (const one of entry.edits) {
      monacoEdits.push({
        resource: model.uri,
        textEdit: { range: lspRangeToMonaco(one.range), text: one.newText },
        versionId: undefined,
      });
    }
  }
  return { monacoEdits, localEdits, residual: residual.length > 0 ? { entries: residual } : null };
}

/** A wire edit as a Monaco text edit, with snippet source reduced to the text it inserts. */
export function snippetAwareEdit(edit: WireTextEdit): monaco.languages.TextEdit {
  return {
    range: lspRangeToMonaco(edit.range),
    text: edit.insertAsSnippet === true ? collapseSnippet(edit.newText).text : edit.newText,
  };
}

/* --------------------------------------------------------------- code actions */

/** A Monaco code action that remembers the provider and mint token needed to resolve it. */
export interface ExtensionCodeAction extends monaco.languages.CodeAction {
  axiomId?: number;
  axiomHandle?: number;
}

/** The residue of a code action's edit, carried as the argument of its follow-up command. */
export interface CodeActionResidue {
  localEdits: SplitWorkspaceEdit['localEdits'];
  residual: ExtensionProviderEditInput | null;
  command: LspCommand | null;
}

/**
 * One code action.
 *
 * Monaco applies `edit` and then runs `command`, which is the order upstream uses, so the parts of
 * the edit Monaco cannot apply ride along as the argument of a follow-up command rather than being
 * applied out of band. An action with nothing left over gets its provider command unchanged.
 */
export function toMonacoCodeAction(
  action: WireCodeAction,
  context: { handle: number; runCommandId: string; applyResidueId: string; fallbackSource: string },
): ExtensionCodeAction {
  const out: ExtensionCodeAction = { title: action.title };
  if (action.kind !== undefined) out.kind = action.kind;
  if (action.isPreferred === true) out.isPreferred = true;
  if (action.disabledReason !== undefined) out.disabled = action.disabledReason;
  if (action.diagnostics !== undefined) {
    out.diagnostics = action.diagnostics.map((diagnostic) =>
      diagnosticToMarker(diagnostic, context.fallbackSource),
    );
  }
  const split =
    action.edit === undefined
      ? { monacoEdits: [], localEdits: [], residual: null }
      : splitWorkspaceEdit(action.edit);
  if (split.monacoEdits.length > 0) out.edit = { edits: split.monacoEdits };
  const residue: CodeActionResidue = {
    localEdits: split.localEdits,
    residual: split.residual,
    command: action.command ?? null,
  };
  if (split.localEdits.length > 0 || split.residual !== null) {
    out.command = { id: context.applyResidueId, title: action.title, arguments: [residue] };
  } else if (action.command !== undefined) {
    out.command = toMonacoCommand(action.command, context.runCommandId);
  }
  if (action.id !== undefined) {
    out.axiomId = action.id;
    out.axiomHandle = context.handle;
  }
  return out;
}

/* -------------------------------------------------------------- inline values */

/* ------------------------------------------------- language configuration */

/** A pattern that an extension shipped: unparseable means "no rule", never a throw. */
function compile(source: string | undefined): RegExp | undefined {
  if (source === undefined) return undefined;
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

const INDENT_ACTIONS: Record<string, monaco.languages.IndentAction> = {
  none: monaco.languages.IndentAction.None,
  indent: monaco.languages.IndentAction.Indent,
  indentOutdent: monaco.languages.IndentAction.IndentOutdent,
  outdent: monaco.languages.IndentAction.Outdent,
};

/**
 * A contributed `language-configuration.json` (or `setLanguageConfiguration()` argument) as Monaco's
 * `LanguageConfiguration`.
 *
 * Patterns crossed the wire as source text — a `RegExp` is not structured-cloneable — so this is
 * where they become regular expressions. Every one is compiled defensively: an extension with one
 * bad `onEnterRule` loses that rule and keeps the rest of its configuration, which is what upstream
 * does too.
 */
export function toMonacoLanguageConfiguration(
  data: LanguageConfigurationData,
): monaco.languages.LanguageConfiguration {
  const config: monaco.languages.LanguageConfiguration = {};
  if (data.comments !== undefined) {
    config.comments = {
      ...(data.comments.lineComment !== undefined
        ? { lineComment: data.comments.lineComment }
        : {}),
      ...(data.comments.blockComment !== undefined
        ? { blockComment: data.comments.blockComment }
        : {}),
    };
  }
  if (data.brackets !== undefined) config.brackets = data.brackets;
  if (data.autoClosingPairs !== undefined) {
    config.autoClosingPairs = data.autoClosingPairs.map((pair) => ({
      open: pair.open,
      close: pair.close,
      ...(pair.notIn !== undefined ? { notIn: pair.notIn } : {}),
    }));
  }
  if (data.surroundingPairs !== undefined) config.surroundingPairs = data.surroundingPairs;
  if (data.colorizedBracketPairs !== undefined) {
    config.colorizedBracketPairs = data.colorizedBracketPairs;
  }
  if (data.autoCloseBefore !== undefined) config.autoCloseBefore = data.autoCloseBefore;
  const wordPattern = compile(data.wordPattern);
  if (wordPattern !== undefined) config.wordPattern = wordPattern;
  const indentation = indentationRules(data.indentationRules);
  if (indentation !== undefined) config.indentationRules = indentation;
  const onEnter = enterRules(data.onEnterRules);
  if (onEnter.length > 0) config.onEnterRules = onEnter;
  const folding = foldingRules(data.folding);
  if (folding !== undefined) config.folding = folding;
  return config;
}

/** Both directions are required by Monaco, so a half-specified rule is no rule. */
function indentationRules(
  data: LanguageConfigurationData['indentationRules'],
): monaco.languages.IndentationRule | undefined {
  if (data === undefined) return undefined;
  const increaseIndentPattern = compile(data.increaseIndentPattern);
  const decreaseIndentPattern = compile(data.decreaseIndentPattern);
  if (increaseIndentPattern === undefined || decreaseIndentPattern === undefined) return undefined;
  const indentNextLinePattern = compile(data.indentNextLinePattern);
  const unIndentedLinePattern = compile(data.unIndentedLinePattern);
  return {
    increaseIndentPattern,
    decreaseIndentPattern,
    ...(indentNextLinePattern !== undefined ? { indentNextLinePattern } : {}),
    ...(unIndentedLinePattern !== undefined ? { unIndentedLinePattern } : {}),
  };
}

function enterRules(
  data: LanguageConfigurationData['onEnterRules'],
): monaco.languages.OnEnterRule[] {
  const out: monaco.languages.OnEnterRule[] = [];
  for (const rule of data ?? []) {
    const beforeText = compile(rule.beforeText);
    const indentAction = INDENT_ACTIONS[rule.action.indent];
    if (beforeText === undefined || indentAction === undefined) continue;
    const afterText = compile(rule.afterText);
    const previousLineText = compile(rule.previousLineText);
    out.push({
      beforeText,
      ...(afterText !== undefined ? { afterText } : {}),
      ...(previousLineText !== undefined ? { previousLineText } : {}),
      action: {
        indentAction,
        ...(rule.action.appendText !== undefined ? { appendText: rule.action.appendText } : {}),
        ...(rule.action.removeText !== undefined ? { removeText: rule.action.removeText } : {}),
      },
    });
  }
  return out;
}

function foldingRules(
  data: LanguageConfigurationData['folding'],
): monaco.languages.FoldingRules | undefined {
  if (data === undefined) return undefined;
  const start = compile(data.markers?.start);
  const end = compile(data.markers?.end);
  const rules: monaco.languages.FoldingRules = {
    ...(data.offSide !== undefined ? { offSide: data.offSide } : {}),
    ...(start !== undefined && end !== undefined ? { markers: { start, end } } : {}),
  };
  return rules.offSide === undefined && rules.markers === undefined ? undefined : rules;
}
