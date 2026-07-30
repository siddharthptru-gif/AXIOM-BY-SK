/**
 * The extension-provider wire format and its normalisers (PRD Phase 6).
 *
 * Everything an extension's provider returns crosses two process boundaries before Monaco sees it:
 * worker → Main → renderer. This module defines what may cross and reduces whatever the extension
 * actually returned to it. That is not defensiveness for its own sake — a provider result is
 * arbitrary JavaScript from a third party, and the two failure modes it can cause are both real:
 * an unbounded result (a completion list with a million items, a hover holding a megabyte of text)
 * stalls the editor, and an unsafe one (a `javascript:` link target, raw HTML in a hover) turns a
 * hover into a script-execution vector.
 *
 * The format is deliberately LSP-shaped and reuses the `Lsp*` types the renderer's converters in
 * `editor/lspConvert.ts` already speak, so extension providers and language servers arrive at
 * Monaco through the same converters instead of a second parallel set. Types the language-server
 * path never needed — colours, hierarchies, inline values, linked editing, snippet and file-level
 * workspace edits — are added here rather than in `common/ipc.ts`, so the existing LSP wire surface
 * is not disturbed.
 *
 * Pure: no I/O, no Electron, no Monaco.
 */
import type {
  LspCommand,
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentLink,
  LspDocumentSymbol,
  LspFoldingRange,
  LspInlayHint,
  LspLocation,
  LspPosition,
  LspRange,
  LspSemanticTokens,
  LspSymbolInformation,
  LspTextEdit,
} from './ipc';
import type { LanguageFeature, ProviderOp } from './vscodeLanguages';

/** Caps. Each one is the point past which a result stops being useful and starts being a cost. */
export const MAX_WIRE_STRING = 8 * 1024;
export const MAX_MARKDOWN = 32 * 1024;
export const MAX_COMPLETION_ITEMS = 1000;
export const MAX_RESULT_ITEMS = 500;
export const MAX_EDITS = 2000;
export const MAX_HOVER_BLOCKS = 16;
export const MAX_SIGNATURES = 32;
export const MAX_PARAMETERS = 64;
export const MAX_SYMBOL_DEPTH = 16;
export const MAX_LINK_COMMANDS = 32;

/* ---------------------------------------------------------------- primitives */

function str(value: unknown, limit = MAX_WIRE_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length === 0 ? undefined : value.slice(0, limit);
}

function int(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** Line and character caps: a position beyond these is not a position in a document. */
const MAX_LINE = 1_000_000_000;
const MAX_CHARACTER = 1_000_000_000;

/**
 * Read a `vscode.Position`.
 *
 * The shim's `Position` is `{ line, character }`, but an extension may hand back a plain object,
 * an array (some helper libraries do), or a `Position` from a *different* copy of the shim, so the
 * shape is read structurally rather than by instance check.
 */
export function toWirePosition(value: unknown): LspPosition | undefined {
  if (Array.isArray(value)) return toWirePosition({ line: value[0], character: value[1] });
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const line = int(source.line, 0, MAX_LINE);
  const character = int(source.character, 0, MAX_CHARACTER);
  if (line === undefined || character === undefined) return undefined;
  return { line, character };
}

/** Read a `vscode.Range` (or a `Selection`, or a two-element array of positions). */
export function toWireRange(value: unknown): LspRange | undefined {
  if (Array.isArray(value)) return toWireRange({ start: value[0], end: value[1] });
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const start = toWirePosition(source.start ?? source.anchor);
  const end = toWirePosition(source.end ?? source.active);
  if (start === undefined || end === undefined) return undefined;
  // An inverted range is an ordering mistake, not a rejection: upstream's Range constructor
  // normalises it, and a provider that built one by hand means the span between the two.
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
    return { start: end, end: start };
  }
  return { start, end };
}
/* ----------------------------------------------------------------------- URIs */

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;
const MAX_URI_LENGTH = 2048;

/**
 * Schemes a provider result may point a document at.
 *
 * A `Location` is something the editor will *open*, so the set is a whitelist rather than a
 * blacklist: an unknown scheme is refused instead of being handed to the workbench to interpret.
 * `file` and `untitled` are the editable ones; the rest are read-only views the workbench already
 * knows how to show.
 */
export const SAFE_DOCUMENT_SCHEMES: ReadonlySet<string> = new Set([
  'file',
  'untitled',
  'vscode-userdata',
  'vscode-notebook-cell',
  'git',
  'output',
  'axiom',
]);

/** Schemes that must never reach a link target or a document URI. */
export const UNSAFE_URI_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'about',
  'filesystem',
  'view-source',
  'jar',
]);

interface UriParts {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

function formatUri(parts: UriParts): string {
  const { scheme, authority, path, query, fragment } = parts;
  const head =
    authority.length > 0 || path.startsWith('/')
      ? `${scheme}://${authority}${path}`
      : `${scheme}:${path}`;
  return `${head}${query.length > 0 ? `?${query}` : ''}${fragment.length > 0 ? `#${fragment}` : ''}`;
}
const URI_STRING_RE =
  /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

/**
 * Read a URI from either a string or a `vscode.Uri`-shaped object.
 *
 * The object form is read field by field rather than through `toString()`: that method belongs to
 * the extension, it can be overridden, and a URI is exactly the value that must not be whatever an
 * arbitrary function chose to return. Percent-encoding is checked with `decodeURI` — a URI that
 * cannot be decoded is malformed, and passing it on would leave each consumer to guess.
 */
export function toWireUri(
  value: unknown,
  schemes: ReadonlySet<string> = SAFE_DOCUMENT_SCHEMES,
): string | undefined {
  let parts: UriParts | undefined;
  if (typeof value === 'string') {
    const match = URI_STRING_RE.exec(value.slice(0, MAX_URI_LENGTH));
    if (match) {
      parts = {
        scheme: match[1] as string,
        authority: match[2] ?? '',
        path: match[3] ?? '',
        query: match[4] ?? '',
        fragment: match[5] ?? '',
      };
    }
  } else if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const scheme = str(source.scheme, 64);
    if (scheme !== undefined) {
      parts = {
        scheme,
        authority: str(source.authority, 256) ?? '',
        path: str(source.path, MAX_URI_LENGTH) ?? '',
        query: str(source.query, MAX_URI_LENGTH) ?? '',
        fragment: str(source.fragment, 512) ?? '',
      };
    }
  }
  if (parts === undefined) return undefined;
  const scheme = parts.scheme.toLowerCase();
  if (!URI_SCHEME_RE.test(scheme) || UNSAFE_URI_SCHEMES.has(scheme)) return undefined;
  if (!schemes.has(scheme)) return undefined;
  if (parts.path.length === 0 && parts.authority.length === 0) return undefined;
  const formatted = formatUri({ ...parts, scheme });
  if (formatted.length > MAX_URI_LENGTH) return undefined;
  try {
    decodeURI(formatted);
  } catch {
    return undefined;
  }
  return formatted;
}
/* ------------------------------------------------------------------- markdown */

/**
 * Markdown as it crosses the boundary: sanitised text plus the command ids it references.
 *
 * Monaco is given `isTrusted: { enabledCommands }` built from `commands`, so a hover can carry the
 * `command:` links extensions like GitLens are built around while still being unable to invoke a
 * command it did not name. `supportHtml` stays false on every path.
 */
export interface WireMarkdown {
  value: string;
  commands?: string[];
}

const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'file']);
const COMMAND_ID_RE = /^[A-Za-z0-9_.\-:]+$/;
const SCHEME_PREFIX_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function fenceLanguage(value: string): string {
  return value.replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 32);
}

/**
 * Flatten whatever a provider used for documentation into markdown source.
 *
 * `string`, `MarkdownString`, LSP's `MarkedString` (`{ language, value }`, which becomes a fenced
 * block) and arrays of any of those are all legal in the API and all appear in real extensions.
 * Blocks are joined with a rule, which is how upstream renders a multi-part hover.
 */
export function markdownSource(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.slice(0, MAX_MARKDOWN);
  if (depth > 2) return '';
  if (Array.isArray(value)) {
    const blocks: string[] = [];
    for (const entry of value.slice(0, MAX_HOVER_BLOCKS)) {
      const block = markdownSource(entry, depth + 1);
      if (block.trim().length > 0) blocks.push(block);
    }
    return blocks.join('\n\n---\n\n').slice(0, MAX_MARKDOWN);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const text = typeof source.value === 'string' ? source.value : undefined;
    if (text === undefined) return '';
    const language = typeof source.language === 'string' ? fenceLanguage(source.language) : '';
    if (language.length > 0) return `\`\`\`${language}\n${text.slice(0, MAX_MARKDOWN)}\n\`\`\``;
    return text.slice(0, MAX_MARKDOWN);
  }
  return '';
}
/**
 * Decide what a link may point at.
 *
 * Returns the target to keep, or null to unlink. A scheme-less target (a relative path, a `#`
 * anchor) is kept: it cannot execute anything. `command:` is kept only when the caller allows it,
 * and only for a syntactically valid command id, which is recorded so the renderer can enable that
 * id and nothing else.
 */
function linkTarget(raw: string, commands: Set<string>, allowCommands: boolean): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URI_LENGTH) return null;
  const match = SCHEME_PREFIX_RE.exec(trimmed);
  if (!match) return trimmed;
  const scheme = (match[1] as string).toLowerCase();
  if (scheme === 'command') {
    if (!allowCommands) return null;
    const rest = trimmed.slice('command:'.length);
    const id = rest.split('?')[0] ?? '';
    if (id.length === 0 || id.length > 200 || !COMMAND_ID_RE.test(id)) return null;
    if (commands.size < MAX_LINK_COMMANDS) commands.add(id);
    else if (!commands.has(id)) return null;
    return trimmed;
  }
  return SAFE_LINK_SCHEMES.has(scheme) ? trimmed : null;
}

/** Split `(url "title")` contents into target and title, preserving the title. */
function rewriteLinkBody(
  body: string,
  commands: Set<string>,
  allowCommands: boolean,
): string | null {
  const trimmed = body.trim();
  const space = trimmed.search(/\s/);
  const rawTarget = space === -1 ? trimmed : trimmed.slice(0, space);
  const title = space === -1 ? '' : trimmed.slice(space).trim();
  const target = linkTarget(rawTarget, commands, allowCommands);
  if (target === null) return null;
  return title.length > 0 ? `${target} ${title}` : target;
}

const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*)>/g;
const INLINE_LINK_RE = /(!?)\[([^\]]{0,200})\]\(([^)]{0,2100})\)/g;
const REFERENCE_DEF_RE = /^\s{0,3}\[([^\]]{1,200})\]:\s*(\S+)(.*)$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
/**
 * Sanitise markdown from an extension before anything renders it.
 *
 * Fenced code blocks are passed through untouched — `<div>` inside a TypeScript sample is content,
 * not markup, and Monaco escapes it because `supportHtml` is false. Outside a fence: raw HTML tags
 * and comments are removed, and every link (inline, autolink or reference definition) has its
 * target checked, with an unsafe one unlinked rather than dropped so the user still reads the text.
 */
export function sanitizeMarkdown(
  value: unknown,
  options: { allowCommands?: boolean } = {},
): WireMarkdown {
  const allowCommands = options.allowCommands === true;
  const commands = new Set<string>();
  const source = markdownSource(value);
  if (source.length === 0) return { value: '' };
  const lines = source.slice(0, MAX_MARKDOWN).split('\n');
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (fenceMatch && (fenceMatch[1] as string).startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      out.push(line);
      continue;
    }
    let text = line.replace(HTML_COMMENT_RE, '').replace(HTML_TAG_RE, '');
    text = text.replace(AUTOLINK_RE, (_all, target: string) => {
      const safe = linkTarget(target, commands, allowCommands);
      return safe === null ? '' : `<${safe}>`;
    });
    text = text.replace(INLINE_LINK_RE, (_all, bang: string, label: string, body: string) => {
      const rewritten = rewriteLinkBody(body, commands, allowCommands);
      if (rewritten === null) return label;
      return `${bang}[${label}](${rewritten})`;
    });
    const reference = REFERENCE_DEF_RE.exec(text);
    if (reference) {
      const safe = linkTarget(reference[2] as string, commands, allowCommands);
      if (safe === null) continue;
      text = `[${reference[1] as string}]: ${safe}${reference[3] ?? ''}`;
    }
    out.push(text);
  }
  const result: WireMarkdown = { value: out.join('\n').slice(0, MAX_MARKDOWN) };
  if (commands.size > 0) result.commands = [...commands];
  return result;
}
/* --------------------------------------------------------------- wire results */

/** A text edit that may be a snippet (`SnippetTextEdit`), which Monaco applies differently. */
export interface WireTextEdit extends LspTextEdit {
  insertAsSnippet?: boolean;
}

/**
 * A `WorkspaceEdit` on the wire.
 *
 * Upstream's `WorkspaceEdit` is an ordered list of operations, not a map of files to edits, and the
 * order is load-bearing: "create the file, then write to it" and "write to it, then create it" are
 * not the same edit. `LspWorkspaceEdit`'s `changes` map cannot express that, so text edits and file
 * operations share one ordered list here.
 */
export type WireWorkspaceEditEntry =
  | { kind: 'text'; uri: string; edits: WireTextEdit[] }
  | {
      kind: 'create';
      uri: string;
      overwrite?: boolean;
      ignoreIfExists?: boolean;
      contents?: string;
    }
  | { kind: 'rename'; uri: string; newUri: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'delete'; uri: string; recursive?: boolean; ignoreIfNotExists?: boolean };

export interface WireWorkspaceEdit {
  entries: WireWorkspaceEditEntry[];
}

export interface WireHover {
  contents: WireMarkdown[];
  range?: LspRange;
}

/** `Location` and `LocationLink` unified: the extra ranges are present only for the latter. */
export interface WireLocationLink {
  uri: string;
  range: LspRange;
  /** `LocationLink.targetSelectionRange` — where the cursor lands inside the target. */
  targetSelectionRange?: LspRange;
  /** `LocationLink.originSelectionRange` — the span in the source document that is the link. */
  originSelectionRange?: LspRange;
}

export interface WireCodeAction {
  title: string;
  kind?: string;
  edit?: WireWorkspaceEdit;
  command?: LspCommand;
  isPreferred?: boolean;
  disabledReason?: string;
  diagnostics?: LspDiagnostic[];
  /** Resolution token; present when the provider implements `resolveCodeAction`. */
  id?: number;
}
export interface WireCodeLens {
  range: LspRange;
  command?: LspCommand;
  /** Resolution token, present while the lens has no command yet. */
  id?: number;
}

export interface WireDocumentLink extends LspDocumentLink {
  id?: number;
}

export interface WireInlayHint extends LspInlayHint {
  tooltip?: WireMarkdown;
  textEdits?: WireTextEdit[];
  id?: number;
}

export interface WireColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface WireColorInformation {
  range: LspRange;
  color: WireColor;
}

export interface WireColorPresentation {
  label: string;
  textEdit?: WireTextEdit;
  additionalTextEdits?: WireTextEdit[];
}

/** One node of a call or type hierarchy. `id` is how the traversal ops name it again. */
export interface WireHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  tags?: number[];
  id?: number;
}

export interface WireIncomingCall {
  from: WireHierarchyItem;
  fromRanges: LspRange[];
}

export interface WireOutgoingCall {
  to: WireHierarchyItem;
  fromRanges: LspRange[];
}
/** `InlineValueText` | `InlineValueVariableLookup` | `InlineValueEvaluatableExpression`. */
export type WireInlineValue =
  | { kind: 'text'; range: LspRange; text: string }
  | { kind: 'variable'; range: LspRange; variableName?: string; caseSensitiveLookup: boolean }
  | { kind: 'expression'; range: LspRange; expression?: string };

export interface WireLinkedEditingRanges {
  ranges: LspRange[];
  /** `wordPattern` as source text; the renderer compiles it. */
  wordPattern?: string;
}

export interface WireCompletionList {
  items: LspCompletionItem[];
  isIncomplete?: boolean;
}

export interface WireSelectionRanges {
  /** One chain per requested position, innermost first. */
  ranges: LspRange[][];
}

export interface WirePrepareRename {
  range: LspRange | null;
  placeholder?: string;
}

/** Everything a provider call can answer with, keyed by the feature and op that produced it. */
export type WireProviderResult =
  | WireHover
  | WireCompletionList
  | WireLocationLink[]
  | WireCodeAction[]
  | WireCodeLens[]
  | WireDocumentLink[]
  | WireInlayHint[]
  | WireColorInformation[]
  | WireColorPresentation[]
  | WireHierarchyItem[]
  | WireIncomingCall[]
  | WireOutgoingCall[]
  | WireInlineValue[]
  | WireLinkedEditingRanges
  | WireWorkspaceEdit
  | WirePrepareRename
  | WireSelectionRanges
  | WireTextEdit[]
  | WireSignatureHelp
  | WireSemanticTokensEdits
  | Array<{ range: LspRange; kind: number }>
  | LspFoldingRange[]
  | { symbols: LspDocumentSymbol[]; flat: LspSymbolInformation[] }
  | LspSymbolInformation[]
  | LspSemanticTokens
  | LspCompletionItem
  | null;
/**
 * What a normaliser is allowed to do beyond reading values.
 *
 * `mint` is how an item that can be resolved later keeps a link back to the object the extension
 * returned: the worker stores that object and hands back a token, and `resolve` arrives with the
 * token rather than with a reconstructed item. Without it (Main re-normalising a result it received,
 * say) items simply come back unresolvable, which is a degradation and not a failure.
 */
export interface WireContext {
  mint?: (original: unknown) => number;
  allowCommands?: boolean;
  schemes?: ReadonlySet<string>;
}

function wireUri(value: unknown, context: WireContext): string | undefined {
  return toWireUri(value, context.schemes ?? SAFE_DOCUMENT_SCHEMES);
}

function markdown(value: unknown, context: WireContext): WireMarkdown | undefined {
  const result = sanitizeMarkdown(value, { allowCommands: context.allowCommands === true });
  return result.value.length === 0 ? undefined : result;
}

/** Documentation as a plain string plus a flag, which is what `LspCompletionItem` carries. */
function documentation(value: unknown): { text: string; isMarkdown: boolean } | undefined {
  if (typeof value === 'string') {
    const text = str(value, MAX_MARKDOWN);
    return text === undefined ? undefined : { text, isMarkdown: false };
  }
  const sanitized = sanitizeMarkdown(value);
  return sanitized.value.length === 0 ? undefined : { text: sanitized.value, isMarkdown: true };
}

export function toWireTextEdit(value: unknown): WireTextEdit | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  const newText = typeof source.newText === 'string' ? source.newText.slice(0, MAX_MARKDOWN) : '';
  // A `SnippetTextEdit` carries `snippet: SnippetString`; its text lives in `.value`.
  const snippet = source.snippet;
  if (typeof snippet === 'object' && snippet !== null) {
    const text = (snippet as Record<string, unknown>).value;
    if (typeof text === 'string') {
      return { range, newText: text.slice(0, MAX_MARKDOWN), insertAsSnippet: true };
    }
  }
  return { range, newText };
}

function toWireTextEdits(value: unknown): WireTextEdit[] {
  if (!Array.isArray(value)) {
    const single = toWireTextEdit(value);
    return single === undefined ? [] : [single];
  }
  const out: WireTextEdit[] = [];
  for (const entry of value) {
    const edit = toWireTextEdit(entry);
    if (edit !== undefined) out.push(edit);
    if (out.length >= MAX_EDITS) break;
  }
  return out;
}
/**
 * Read a `WorkspaceEdit`.
 *
 * The shim's `WorkspaceEdit` keeps its operations in registration order on `_operations`; a
 * `changes`-map form is also accepted so an edit that has already been over the wire can be
 * re-read. Order is preserved exactly as the extension built it, and only the file operations
 * upstream defines are recognised — anything else is dropped rather than guessed at.
 */
export function toWireWorkspaceEdit(
  value: unknown,
  context: WireContext = {},
): WireWorkspaceEdit | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const entries: WireWorkspaceEditEntry[] = [];
  const operations = Array.isArray(source._operations)
    ? source._operations
    : Array.isArray(source.entries)
      ? source.entries
      : undefined;
  if (operations !== undefined) {
    for (const item of operations) {
      const entry = toWireWorkspaceEditEntry(item, context);
      if (entry !== undefined) entries.push(entry);
      if (entries.length >= MAX_RESULT_ITEMS) break;
    }
  } else if (typeof source.changes === 'object' && source.changes !== null) {
    for (const [uri, edits] of Object.entries(source.changes as Record<string, unknown>)) {
      const safeUri = wireUri(uri, context);
      if (safeUri === undefined) continue;
      const list = toWireTextEdits(edits);
      if (list.length > 0) entries.push({ kind: 'text', uri: safeUri, edits: list });
      if (entries.length >= MAX_RESULT_ITEMS) break;
    }
  }
  return entries.length === 0 ? undefined : { entries };
}

function toWireWorkspaceEditEntry(
  value: unknown,
  context: WireContext,
): WireWorkspaceEditEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const uri = wireUri(source.uri, context);
  if (uri === undefined) return undefined;
  const options = (
    typeof source.options === 'object' && source.options !== null ? source.options : {}
  ) as Record<string, unknown>;
  switch (source.kind) {
    case 'text': {
      const edits = toWireTextEdits(source.edits);
      return edits.length === 0 ? undefined : { kind: 'text', uri, edits };
    }
    case 'create': {
      const contents = typeof source.contents === 'string' ? source.contents : undefined;
      return {
        kind: 'create',
        uri,
        ...(options.overwrite === true ? { overwrite: true } : {}),
        ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
        ...(contents !== undefined ? { contents } : {}),
      };
    }
    case 'rename': {
      const newUri = wireUri(source.newUri, context);
      if (newUri === undefined) return undefined;
      return {
        kind: 'rename',
        uri,
        newUri,
        ...(options.overwrite === true ? { overwrite: true } : {}),
        ...(options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
      };
    }
    case 'delete':
      return {
        kind: 'delete',
        uri,
        ...(options.recursive === true ? { recursive: true } : {}),
        ...(options.ignoreIfNotExists === true ? { ignoreIfNotExists: true } : {}),
      };
    default:
      return undefined;
  }
}
/**
 * Read a `Location`, a `LocationLink`, or the `{ uri, range }` shape both share.
 *
 * `LocationLink` names its fields `targetUri`/`targetRange`; `Location` uses `uri`/`range`. Both
 * spellings are accepted from the same function because a provider may legally return a mixed
 * array, and upstream's `DefinitionProvider` signature says so.
 */
export function toWireLocationLink(
  value: unknown,
  context: WireContext = {},
): WireLocationLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const uri = wireUri(source.targetUri ?? source.uri, context);
  const range = toWireRange(source.targetRange ?? source.range);
  if (uri === undefined || range === undefined) return undefined;
  const targetSelectionRange = toWireRange(source.targetSelectionRange);
  const originSelectionRange = toWireRange(source.originSelectionRange);
  return {
    uri,
    range,
    ...(targetSelectionRange !== undefined ? { targetSelectionRange } : {}),
    ...(originSelectionRange !== undefined ? { originSelectionRange } : {}),
  };
}

function toWireLocationLinks(value: unknown, context: WireContext): WireLocationLink[] {
  const items = Array.isArray(value) ? value : [value];
  const out: WireLocationLink[] = [];
  for (const entry of items) {
    const link = toWireLocationLink(entry, context);
    if (link !== undefined) out.push(link);
    if (out.length >= MAX_RESULT_ITEMS) break;
  }
  return out;
}

/** A plain `Location` for features that only ever produce one (workspace symbols). */
function toWireLocation(value: unknown, context: WireContext): LspLocation | undefined {
  const link = toWireLocationLink(value, context);
  return link === undefined ? undefined : { uri: link.uri, range: link.range };
}
/**
 * Read a `Hover`.
 *
 * `contents` stays an array: upstream renders each entry as its own block with a rule between, and
 * flattening them into one string here would lose the boundaries a provider chose. Command links
 * are allowed — hovers are where extensions put their actions — and each block reports which
 * commands it references so nothing broader can be invoked.
 */
export function toWireHover(value: unknown, context: WireContext = {}): WireHover | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const raw = Array.isArray(source.contents) ? source.contents : [source.contents];
  const contents: WireMarkdown[] = [];
  for (const entry of raw.slice(0, MAX_HOVER_BLOCKS)) {
    const block = sanitizeMarkdown(entry, { allowCommands: context.allowCommands !== false });
    if (block.value.trim().length > 0) contents.push(block);
  }
  if (contents.length === 0) return undefined;
  const range = toWireRange(source.range);
  return { contents, ...(range !== undefined ? { range } : {}) };
}

/** Read a `Command`. Arguments are dropped when they are not structured-cloneable data. */
export function toWireCommand(value: unknown): LspCommand | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const command = str(source.command, 200);
  if (command === undefined || !COMMAND_ID_RE.test(command)) return undefined;
  const title = str(source.title, 200) ?? command;
  const args = Array.isArray(source.arguments)
    ? source.arguments.slice(0, 16).map((entry) => cloneable(entry))
    : undefined;
  return { title, command, ...(args !== undefined ? { arguments: args } : {}) };
}

/**
 * Reduce a value to something that survives structured clone.
 *
 * Command arguments are arbitrary — extensions pass `Uri`s, class instances, sometimes functions.
 * A function would throw when the message is serialised and take the whole result with it, so
 * anything not plainly cloneable becomes null rather than a failed dispatch.
 */
function cloneable(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return (value as string).slice(0, MAX_WIRE_STRING);
  if (type === 'number' || type === 'boolean') return value;
  if (type !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => cloneable(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (typeof entry === 'function') continue;
    out[key] = cloneable(entry, depth + 1);
  }
  return out;
}
/**
 * `vscode` enums are zero-based where the LSP ones are one-based.
 *
 * `CompletionItemKind.Text` is 0 in the extension API and 1 in LSP, and the same one-place shift
 * runs through `SymbolKind`, `DiagnosticSeverity` and `DocumentHighlightKind`. The renderer's
 * converters speak LSP, so the shift happens once, here, rather than being rediscovered per
 * feature — getting it wrong silently recolours every completion icon in the list.
 */
function shiftKind(value: unknown, max: number, fallback: number): number {
  const kind = int(value, 0, max);
  return kind === undefined ? fallback : kind + 1;
}

/** Trailing `vscode` kinds with no LSP counterpart fall back rather than encode a wrong icon. */
const LSP_COMPLETION_KIND_MAX = 25;

export interface WireCompletionItem extends LspCompletionItem {
  additionalTextEdits?: WireTextEdit[];
  /** `range` given as `{ inserting, replacing }`, which Monaco takes as insert/replace. */
  insertRange?: LspRange;
  replaceRange?: LspRange;
  keepWhitespace?: boolean;
  tags?: number[];
}

export function toWireCompletionItem(
  value: unknown,
  context: WireContext = {},
): WireCompletionItem | undefined {
  if (typeof value === 'string') {
    const label = str(value, 512);
    return label === undefined ? undefined : { label };
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const rawLabel = source.label;
  const labelRecord =
    typeof rawLabel === 'object' && rawLabel !== null
      ? (rawLabel as Record<string, unknown>)
      : null;
  const label = str(labelRecord ? labelRecord.label : rawLabel, 512);
  if (label === undefined) return undefined;
  const item: WireCompletionItem = { label };
  if (labelRecord) {
    const detail = str(labelRecord.detail, 200);
    const description = str(labelRecord.description, 200);
    if (detail !== undefined) item.labelDetail = detail;
    if (description !== undefined) item.labelDescription = description;
  }
  const kind = shiftKind(source.kind, LSP_COMPLETION_KIND_MAX - 1, 1);
  item.kind = kind > LSP_COMPLETION_KIND_MAX ? 1 : kind;
  const detail = str(source.detail, 1024);
  if (detail !== undefined) item.detail = detail;
  const docs = documentation(source.documentation);
  if (docs !== undefined) {
    item.documentation = docs.text;
    if (docs.isMarkdown) item.documentationIsMarkdown = true;
  }
  const sortText = str(source.sortText, 512);
  if (sortText !== undefined) item.sortText = sortText;
  const filterText = str(source.filterText, 512);
  if (filterText !== undefined) item.filterText = filterText;
  if (source.preselect === true) item.preselect = true;
  if (source.keepWhitespace === true) item.keepWhitespace = true;
  const commitCharacters = normalizeCommitCharacters(source.commitCharacters);
  if (commitCharacters.length > 0) item.commitCharacters = commitCharacters;
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => int(tag, 1, 8)).filter((tag): tag is number => tag !== undefined)
    : [];
  if (tags.length > 0) {
    item.tags = tags;
    if (tags.includes(1)) item.deprecated = true;
  }
  // `insertText` is a string or a `SnippetString`; the latter is what `insertTextRules` means.
  const insertText = source.insertText;
  if (typeof insertText === 'string') {
    item.insertText = insertText.slice(0, MAX_MARKDOWN);
    item.insertTextFormat = 1;
  } else if (typeof insertText === 'object' && insertText !== null) {
    const snippet = (insertText as Record<string, unknown>).value;
    if (typeof snippet === 'string') {
      item.insertText = snippet.slice(0, MAX_MARKDOWN);
      item.insertTextFormat = 2;
    }
  }
  const range = source.range;
  if (typeof range === 'object' && range !== null && !Array.isArray(range)) {
    const entry = range as Record<string, unknown>;
    const inserting = toWireRange(entry.inserting);
    const replacing = toWireRange(entry.replacing);
    if (inserting !== undefined || replacing !== undefined) {
      if (inserting !== undefined) item.insertRange = inserting;
      if (replacing !== undefined) item.replaceRange = replacing;
    } else {
      const plain = toWireRange(range);
      if (plain !== undefined) item.replaceRange = plain;
    }
  }
  const textEdit = toWireTextEdit(source.textEdit);
  if (textEdit !== undefined) item.textEdit = textEdit;
  const additional = toWireTextEdits(source.additionalTextEdits);
  if (additional.length > 0) item.additionalTextEdits = additional;
  const command = toWireCommand(source.command);
  if (command !== undefined) item.command = command;
  if (context.mint !== undefined) item.id = context.mint(value);

  return item;
}
/** Commit characters are single characters; a longer string contributes its first. */
function normalizeCommitCharacters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const ch = Array.from(entry)[0] as string;
    if (!out.includes(ch)) out.push(ch);
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * Read a `CompletionList` or a bare array of items.
 *
 * `isIncomplete` matters more than it looks: a list marked incomplete is recomputed on the next
 * keystroke, and one that is wrongly marked complete leaves stale suggestions on screen while the
 * user keeps typing.
 */
export function toWireCompletionList(
  value: unknown,
  context: WireContext = {},
): WireCompletionList | undefined {
  if (value === null || value === undefined) return undefined;
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)
      ? ((value as Record<string, unknown>).items as unknown[])
      : undefined;
  if (rawItems === undefined) return undefined;
  const items: WireCompletionItem[] = [];
  for (const entry of rawItems) {
    const item = toWireCompletionItem(entry, context);
    if (item !== undefined) items.push(item);
    if (items.length >= MAX_COMPLETION_ITEMS) break;
  }
  const isIncomplete =
    !Array.isArray(value) && (value as Record<string, unknown>).isIncomplete === true;
  // A truncated list is incomplete by definition: there were more items than were sent.
  const truncated = items.length >= MAX_COMPLETION_ITEMS && rawItems.length > items.length;
  return { items, ...(isIncomplete || truncated ? { isIncomplete: true } : {}) };
}
export interface WireSignatureParam {
  label: string;
  /** `[start, end]` offsets into the signature label, which is how upstream anchors a parameter. */
  labelOffsets?: [number, number];
  documentation?: string;
  documentationIsMarkdown?: boolean;
}

export interface WireSignature {
  label: string;
  documentation?: string;
  documentationIsMarkdown?: boolean;
  parameters: WireSignatureParam[];
  activeParameter?: number;
}

export interface WireSignatureHelp {
  signatures: WireSignature[];
  activeSignature: number;
  activeParameter: number;
}

export function toWireSignatureHelp(value: unknown): WireSignatureHelp | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.signatures)) return undefined;
  const signatures: WireSignature[] = [];
  for (const entry of source.signatures.slice(0, MAX_SIGNATURES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const label = str(record.label, 2048);
    if (label === undefined) continue;
    const signature: WireSignature = { label, parameters: [] };
    const docs = documentation(record.documentation);
    if (docs !== undefined) {
      signature.documentation = docs.text;
      if (docs.isMarkdown) signature.documentationIsMarkdown = true;
    }
    const active = int(record.activeParameter, 0, MAX_PARAMETERS);
    if (active !== undefined) signature.activeParameter = active;
    if (Array.isArray(record.parameters)) {
      for (const raw of record.parameters.slice(0, MAX_PARAMETERS)) {
        const parameter = toWireSignatureParam(raw);
        if (parameter !== undefined) signature.parameters.push(parameter);
      }
    }
    signatures.push(signature);
  }
  if (signatures.length === 0) return undefined;
  return {
    signatures,
    activeSignature: Math.min(
      int(source.activeSignature, 0, MAX_SIGNATURES) ?? 0,
      signatures.length - 1,
    ),
    activeParameter: int(source.activeParameter, 0, MAX_PARAMETERS) ?? 0,
  };
}
function toWireSignatureParam(value: unknown): WireSignatureParam | undefined {
  if (typeof value === 'string') {
    const label = str(value, 512);
    return label === undefined ? undefined : { label };
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const rawLabel = source.label;
  let label: string | undefined;
  let labelOffsets: [number, number] | undefined;
  if (Array.isArray(rawLabel)) {
    const start = int(rawLabel[0], 0, 100_000);
    const end = int(rawLabel[1], 0, 100_000);
    if (start === undefined || end === undefined) return undefined;
    labelOffsets = [Math.min(start, end), Math.max(start, end)];
    label = '';
  } else {
    label = str(rawLabel, 512);
  }
  if (label === undefined) return undefined;
  const parameter: WireSignatureParam = { label };
  if (labelOffsets !== undefined) parameter.labelOffsets = labelOffsets;
  const docs = documentation(source.documentation);
  if (docs !== undefined) {
    parameter.documentation = docs.text;
    if (docs.isMarkdown) parameter.documentationIsMarkdown = true;
  }
  return parameter;
}

/** Read a `DocumentSymbol` tree, or the flat `SymbolInformation[]` an older provider returns. */
export function toWireDocumentSymbols(
  value: unknown,
  context: WireContext = {},
): { symbols: LspDocumentSymbol[]; flat: LspSymbolInformation[] } {
  const symbols: LspDocumentSymbol[] = [];
  const flat: LspSymbolInformation[] = [];
  if (!Array.isArray(value)) return { symbols, flat };
  for (const entry of value.slice(0, MAX_RESULT_ITEMS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as Record<string, unknown>;
    // `SymbolInformation` is the one with a `location`; `DocumentSymbol` has `range`.
    if (source.location !== undefined) {
      const symbol = toWireSymbolInformation(entry, context);
      if (symbol !== undefined) flat.push(symbol);
      continue;
    }
    const symbol = toWireDocumentSymbol(entry, 0);
    if (symbol !== undefined) symbols.push(symbol);
  }
  return { symbols, flat };
}
const LSP_SYMBOL_KIND_MAX = 26;

function toWireDocumentSymbol(value: unknown, depth: number): LspDocumentSymbol | undefined {
  if (depth > MAX_SYMBOL_DEPTH || typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const name = str(source.name, 512);
  const range = toWireRange(source.range);
  if (name === undefined || range === undefined) return undefined;
  const selectionRange = toWireRange(source.selectionRange) ?? range;
  const detail = str(source.detail, 512);
  const children: LspDocumentSymbol[] = [];
  if (Array.isArray(source.children)) {
    for (const child of source.children.slice(0, MAX_RESULT_ITEMS)) {
      const symbol = toWireDocumentSymbol(child, depth + 1);
      if (symbol !== undefined) children.push(symbol);
    }
  }
  return {
    name,
    ...(detail !== undefined ? { detail } : {}),
    kind: Math.min(shiftKind(source.kind, LSP_SYMBOL_KIND_MAX - 1, 1), LSP_SYMBOL_KIND_MAX),
    range,
    selectionRange,
    children,
  };
}

function toWireSymbolInformation(
  value: unknown,
  context: WireContext,
): LspSymbolInformation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const name = str(source.name, 512);
  const location = toWireLocation(source.location, context);
  if (name === undefined || location === undefined) return undefined;
  const containerName = str(source.containerName, 512);
  return {
    name,
    kind: Math.min(shiftKind(source.kind, LSP_SYMBOL_KIND_MAX - 1, 1), LSP_SYMBOL_KIND_MAX),
    location,
    ...(containerName !== undefined ? { containerName } : {}),
  };
}

/**
 * A workspace symbol as it crosses the wire.
 *
 * `id` is the mint token the provider's own object was registered under, and it is what makes
 * `resolveWorkspaceSymbol` possible: upstream hands the *same object* back to the provider, and a
 * structural copy is not the same object — a provider that stored a private field on its symbol
 * (which is how every real workspace-symbol provider carries the information it needs to resolve a
 * location) would be handed a stranger. The token names the original, so the resolve call reaches it.
 */
export type WireWorkspaceSymbol = LspSymbolInformation & { id?: number };

/** `provideWorkspaceSymbols` — always flat, and resolvable when the provider says so. */
export function toWireWorkspaceSymbols(
  value: unknown,
  context: WireContext = {},
): WireWorkspaceSymbol[] {
  if (!Array.isArray(value)) return [];
  const out: WireWorkspaceSymbol[] = [];
  for (const entry of value.slice(0, MAX_RESULT_ITEMS)) {
    const symbol = toWireSymbolInformation(entry, context);
    if (symbol === undefined) continue;
    out.push(context.mint !== undefined ? { ...symbol, id: context.mint(entry) } : symbol);
  }
  return out;
}
const LSP_SEVERITY_MAX = 4;

/** A diagnostic as carried *inside* another result (a code action's `diagnostics`). */
export function toWireDiagnostic(value: unknown): LspDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  const message = str(source.message, MAX_WIRE_STRING);
  if (range === undefined || message === undefined) return undefined;
  const rawCode = source.code;
  const code =
    typeof rawCode === 'number'
      ? String(rawCode)
      : typeof rawCode === 'string'
        ? rawCode.slice(0, 200)
        : typeof rawCode === 'object' && rawCode !== null
          ? str((rawCode as Record<string, unknown>).value, 200)
          : undefined;
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => int(tag, 1, 2)).filter((tag): tag is number => tag !== undefined)
    : [];
  const source_ = str(source.source, 200);
  return {
    range,
    message,
    severity: Math.min(shiftKind(source.severity, LSP_SEVERITY_MAX - 1, 1), LSP_SEVERITY_MAX),
    ...(source_ !== undefined ? { source: source_ } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Read one `CodeAction`, or a bare `Command` — `provideCodeActions` may return either, and the
 * lightweight `Command` form is what several linters still use for their quick fixes.
 */
export function toWireCodeAction(
  value: unknown,
  context: WireContext = {},
): WireCodeAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const title = str(source.title, 512);
  if (title === undefined) return undefined;
  // A `Command` has `command` as a string; a `CodeAction` has it as a nested object.
  if (typeof source.command === 'string') {
    const command = toWireCommand(source);
    return command === undefined ? undefined : { title, command };
  }
  const action: WireCodeAction = { title };
  // `CodeActionKind` is a class wrapping a dotted string; both spellings reach here.
  const kind =
    str(source.kind, 128) ??
    (typeof source.kind === 'object' && source.kind !== null
      ? str((source.kind as Record<string, unknown>).value, 128)
      : undefined);
  if (kind !== undefined) action.kind = kind;
  const edit = toWireWorkspaceEdit(source.edit, context);
  if (edit !== undefined) action.edit = edit;
  const command = toWireCommand(source.command);
  if (command !== undefined) action.command = command;
  if (source.isPreferred === true) action.isPreferred = true;
  // `disabled: { reason }` — the action is listed but not invocable, with the reason shown.
  const disabled = source.disabled;
  if (typeof disabled === 'object' && disabled !== null) {
    const reason = str((disabled as Record<string, unknown>).reason, 512);
    if (reason !== undefined) action.disabledReason = reason;
  }
  if (Array.isArray(source.diagnostics)) {
    const diagnostics: LspDiagnostic[] = [];
    for (const entry of source.diagnostics.slice(0, 64)) {
      const diagnostic = toWireDiagnostic(entry);
      if (diagnostic !== undefined) diagnostics.push(diagnostic);
    }
    if (diagnostics.length > 0) action.diagnostics = diagnostics;
  }
  // An action with neither an edit nor a command has nothing to do yet — that is exactly the
  // case `resolveCodeAction` exists for, so a token is minted whenever resolution is available.
  if (context.mint !== undefined) action.id = context.mint(value);

  return action;
}
export function toWireCodeLens(
  value: unknown,
  context: WireContext = {},
): WireCodeLens | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  const command = toWireCommand(source.command);
  const lens: WireCodeLens = { range };
  if (command !== undefined) lens.command = command;
  // An unresolved lens has no command; without a token it would stay blank forever.
  if (context.mint !== undefined) lens.id = context.mint(value);
  return lens;
}

/** Link targets are stricter than document URIs: a link is followed, so `http(s)` is allowed too. */
const LINK_SCHEMES: ReadonlySet<string> = new Set([
  ...SAFE_DOCUMENT_SCHEMES,
  'http',
  'https',
  'mailto',
]);

export function toWireDocumentLink(
  value: unknown,
  context: WireContext = {},
): WireDocumentLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  const target = toWireUri(source.target, LINK_SCHEMES);
  const tooltip = str(source.tooltip, 512);
  const link: WireDocumentLink = { range };
  if (target !== undefined) link.target = target;
  if (tooltip !== undefined) link.tooltip = tooltip;
  if (context.mint !== undefined) link.id = context.mint(value);
  return link;
}

export function toWireColorInformation(value: unknown): WireColorInformation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  const color = toWireColor(source.color);
  if (range === undefined || color === undefined) return undefined;
  return { range, color };
}

function channel(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function toWireColor(value: unknown): WireColor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const red = channel(source.red);
  const green = channel(source.green);
  const blue = channel(source.blue);
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  return { red, green, blue, alpha: channel(source.alpha) ?? 1 };
}
export function toWireColorPresentation(value: unknown): WireColorPresentation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const label = str(source.label, 200);
  if (label === undefined) return undefined;
  const textEdit = toWireTextEdit(source.textEdit);
  const additional = toWireTextEdits(source.additionalTextEdits);
  return {
    label,
    ...(textEdit !== undefined ? { textEdit } : {}),
    ...(additional.length > 0 ? { additionalTextEdits: additional } : {}),
  };
}

const FOLDING_KINDS: Readonly<Record<number, string>> = { 1: 'comment', 2: 'imports', 3: 'region' };

export function toWireFoldingRange(value: unknown): LspFoldingRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const start = int(source.start, 0, MAX_LINE);
  const end = int(source.end, 0, MAX_LINE);
  if (start === undefined || end === undefined) return undefined;
  const kindValue = int(source.kind, 1, 3);
  const kind = kindValue === undefined ? undefined : FOLDING_KINDS[kindValue];
  return {
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
    ...(kind !== undefined ? { kind } : {}),
  };
}

const LSP_HIGHLIGHT_KIND_MAX = 3;

export function toWireDocumentHighlight(
  value: unknown,
): { range: LspRange; kind: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  return {
    range,
    kind: Math.min(shiftKind(source.kind, LSP_HIGHLIGHT_KIND_MAX - 1, 1), LSP_HIGHLIGHT_KIND_MAX),
  };
}

/** Flatten a `SelectionRange` parent chain into innermost-first order. */
export function toWireSelectionRange(value: unknown): LspRange[] {
  const chain: LspRange[] = [];
  let current: unknown = value;
  while (typeof current === 'object' && current !== null && chain.length < 64) {
    const source = current as Record<string, unknown>;
    const range = toWireRange(source.range);
    if (range === undefined) break;
    chain.push(range);
    current = source.parent;
  }
  return chain;
}
/**
 * Read an `InlayHint`.
 *
 * `label` is a string or an array of `InlayHintLabelPart`s, each of which may carry its own
 * tooltip, location and command. Monaco takes a plain string or its own label parts; the parts are
 * flattened to text here and the tooltip is kept at hint level, which is what the editor shows.
 */
export function toWireInlayHint(
  value: unknown,
  context: WireContext = {},
): WireInlayHint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const position = toWirePosition(source.position);
  if (position === undefined) return undefined;
  const rawLabel = source.label;
  let label: string | undefined;
  if (typeof rawLabel === 'string') label = rawLabel.slice(0, 512);
  else if (Array.isArray(rawLabel)) {
    label = rawLabel
      .slice(0, 64)
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part === 'object' && part !== null
            ? (str((part as Record<string, unknown>).value, 200) ?? '')
            : '',
      )
      .join('')
      .slice(0, 512);
  }
  if (label === undefined || label.length === 0) return undefined;
  const hint: WireInlayHint = { position, label };
  const kind = int(source.kind, 1, 2);
  if (kind !== undefined) hint.kind = kind;
  if (source.paddingLeft === true) hint.paddingLeft = true;
  if (source.paddingRight === true) hint.paddingRight = true;
  const tooltip = markdown(source.tooltip, context);
  if (tooltip !== undefined) hint.tooltip = tooltip;
  const edits = toWireTextEdits(source.textEdits);
  if (edits.length > 0) hint.textEdits = edits;
  if (context.mint !== undefined) hint.id = context.mint(value);
  return hint;
}

export function toWireInlineValue(value: unknown): WireInlineValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  const text = str(source.text, 512);
  if (text !== undefined) return { kind: 'text', range, text };
  if ('variableName' in source || source.caseSensitiveLookup !== undefined) {
    const variableName = str(source.variableName, 512);
    return {
      kind: 'variable',
      range,
      ...(variableName !== undefined ? { variableName } : {}),
      caseSensitiveLookup: source.caseSensitiveLookup !== false,
    };
  }
  const expression = str(source.expression, 512);
  return { kind: 'expression', range, ...(expression !== undefined ? { expression } : {}) };
}
export function toWireHierarchyItem(
  value: unknown,
  context: WireContext = {},
): WireHierarchyItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const name = str(source.name, 512);
  const uri = wireUri(source.uri, context);
  const range = toWireRange(source.range);
  if (name === undefined || uri === undefined || range === undefined) return undefined;
  const detail = str(source.detail, 512);
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => int(tag, 1, 2)).filter((tag): tag is number => tag !== undefined)
    : [];
  const item: WireHierarchyItem = {
    name,
    kind: Math.min(shiftKind(source.kind, LSP_SYMBOL_KIND_MAX - 1, 1), LSP_SYMBOL_KIND_MAX),
    uri,
    range,
    selectionRange: toWireRange(source.selectionRange) ?? range,
    ...(detail !== undefined ? { detail } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  // A hierarchy item is the argument to the next traversal call, so it must be nameable again.
  if (context.mint !== undefined) item.id = context.mint(value);
  return item;
}

export function toWireIncomingCall(
  value: unknown,
  context: WireContext = {},
): WireIncomingCall | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const from = toWireHierarchyItem(source.from, context);
  if (from === undefined) return undefined;
  return { from, fromRanges: rangeList(source.fromRanges) };
}

export function toWireOutgoingCall(
  value: unknown,
  context: WireContext = {},
): WireOutgoingCall | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const to = toWireHierarchyItem(source.to, context);
  if (to === undefined) return undefined;
  return { to, fromRanges: rangeList(source.fromRanges) };
}

function rangeList(value: unknown): LspRange[] {
  if (!Array.isArray(value)) return [];
  const out: LspRange[] = [];
  for (const entry of value.slice(0, MAX_RESULT_ITEMS)) {
    const range = toWireRange(entry);
    if (range !== undefined) out.push(range);
  }
  return out;
}
export function toWireLinkedEditingRanges(value: unknown): WireLinkedEditingRanges | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const ranges = rangeList(source.ranges);
  if (ranges.length === 0) return undefined;
  const raw = source.wordPattern;
  const wordPattern =
    typeof raw === 'object' && raw !== null
      ? str((raw as Record<string, unknown>).source, 1024)
      : str(raw, 1024);
  return { ranges, ...(wordPattern !== undefined ? { wordPattern } : {}) };
}

export function toWirePrepareRename(value: unknown): WirePrepareRename | undefined {
  if (value === null || value === undefined) return undefined;
  // `prepareRename` may return a bare `Range` or `{ range, placeholder }`.
  const direct = toWireRange(value);
  if (direct !== undefined) return { range: direct };
  if (typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const range = toWireRange(source.range);
  if (range === undefined) return undefined;
  const placeholder = str(source.placeholder, 512);
  return { range, ...(placeholder !== undefined ? { placeholder } : {}) };
}

/**
 * Read a `SemanticTokens` result.
 *
 * `data` is already the flat five-integer-per-token encoding upstream defines; it is validated for
 * length and integrality but not re-encoded, because re-deriving it would mean re-deriving the
 * provider's legend indices. A `Uint32Array` is converted to a plain array so it survives the
 * structured clone that a `Uint32Array` from another realm would not.
 */
export function toWireSemanticTokens(
  value: unknown,
  maxTokens: number,
): LspSemanticTokens | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const raw = source.data;
  const array = raw instanceof Uint32Array ? Array.from(raw) : Array.isArray(raw) ? raw : undefined;
  if (array === undefined) return undefined;
  const limit = Math.max(0, Math.min(array.length - (array.length % 5), maxTokens * 5));
  const data: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const entry = array[i];
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) return undefined;
    data.push(Math.trunc(entry));
  }
  const resultId = str(source.resultId, 128);
  return { data, ...(resultId !== undefined ? { resultId } : {}) };
}
/** Tokens one semantic-tokens result may carry — 100k is well past any real file. */
export const MAX_SEMANTIC_TOKENS = 100_000;

export interface WireSemanticTokensEdits {
  resultId?: string;
  edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
}

/**
 * Read the result of `provideDocumentSemanticTokensEdits`, which may be either a delta or a full
 * replacement — upstream lets a provider give up on the delta and resend everything.
 */
export function toWireSemanticTokensEdits(
  value: unknown,
): LspSemanticTokens | WireSemanticTokensEdits | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.edits)) return toWireSemanticTokens(value, MAX_SEMANTIC_TOKENS);
  const edits: WireSemanticTokensEdits['edits'] = [];
  for (const entry of source.edits.slice(0, 1000)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const start = int(record.start, 0, MAX_SEMANTIC_TOKENS * 5);
    const deleteCount = int(record.deleteCount, 0, MAX_SEMANTIC_TOKENS * 5);
    if (start === undefined || deleteCount === undefined) return undefined;
    const data =
      record.data === undefined ? [] : wireTokenIntegers(record.data, MAX_SEMANTIC_TOKENS * 5);
    if (data === undefined) return undefined;
    edits.push({
      start,
      deleteCount,
      ...(data.length > 0 ? { data } : {}),
    });
  }
  const resultId = str(source.resultId, 128);
  return { edits, ...(resultId !== undefined ? { resultId } : {}) };
}

/**
 * Read one edit's payload.
 *
 * Deliberately *not* routed through `toWireSemanticTokens`: an edit's `data` replaces a run of
 * integers, not a run of tokens, so real deltas are routinely not a multiple of five — renaming a
 * symbol to a shorter name changes one `length` field and nothing else. Truncating to whole tokens
 * here would silently drop the tail of the commonest delta there is, and the consumer would splice
 * a short run into its baseline and mis-phase every token after it.
 */
function wireTokenIntegers(value: unknown, maxIntegers: number): number[] | undefined {
  const array =
    value instanceof Uint32Array ? Array.from(value) : Array.isArray(value) ? value : undefined;
  if (array === undefined || array.length > maxIntegers) return undefined;
  const data: number[] = [];
  for (const entry of array) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) return undefined;
    data.push(Math.trunc(entry));
  }
  return data;
}

function mapItems<T>(
  value: unknown,
  read: (entry: unknown) => T | undefined,
  limit = MAX_RESULT_ITEMS,
): T[] {
  if (!Array.isArray(value)) {
    const single = read(value);
    return single === undefined ? [] : [single];
  }
  const out: T[] = [];
  for (const entry of value.slice(0, limit)) {
    const item = read(entry);
    if (item !== undefined) out.push(item);
  }
  return out;
}
/**
 * Normalise one provider result for one feature and operation.
 *
 * This is the single boundary every provider result passes through, and the reason there is one
 * function rather than 28 call sites: the worker does not decide per feature what is safe to send,
 * it asks here, and a feature added without a case falls through to `null` rather than sending an
 * arbitrary object onward.
 */
export function normalizeProviderResult(
  feature: LanguageFeature,
  op: ProviderOp,
  value: unknown,
  context: WireContext = {},
): unknown {
  if (value === null || value === undefined) return null;
  switch (feature) {
    case 'completion':
      return op === 'resolve'
        ? (toWireCompletionItem(value, context) ?? null)
        : (toWireCompletionList(value, context) ?? null);
    case 'hover':
      return toWireHover(value, context) ?? null;
    case 'signatureHelp':
      return toWireSignatureHelp(value) ?? null;
    case 'definition':
    case 'typeDefinition':
    case 'implementation':
    case 'declaration':
    case 'reference':
      return toWireLocationLinks(value, context);
    case 'rename':
      return op === 'prepare'
        ? (toWirePrepareRename(value) ?? null)
        : (toWireWorkspaceEdit(value, context) ?? null);
    case 'documentSymbol':
      return toWireDocumentSymbols(value, context);
    case 'workspaceSymbol':
      return op === 'resolve'
        ? (mapItems(value, (entry) => toWireSymbolInformation(entry, context))[0] ?? null)
        : toWireWorkspaceSymbols(value, context);
    case 'formatting':
    case 'rangeFormatting':
    case 'onTypeFormatting':
      return toWireTextEdits(value);
    case 'codeAction':
      return op === 'resolve'
        ? (toWireCodeAction(value, context) ?? null)
        : mapItems(value, (entry) => toWireCodeAction(entry, context));
    case 'codeLens':
      return op === 'resolve'
        ? (toWireCodeLens(value, context) ?? null)
        : mapItems(value, (entry) => toWireCodeLens(entry, context));
    case 'color':
      return op === 'presentations'
        ? mapItems(value, toWireColorPresentation)
        : mapItems(value, toWireColorInformation);
    case 'documentHighlight':
      return mapItems(value, toWireDocumentHighlight);
    case 'documentLink':
      return op === 'resolve'
        ? (toWireDocumentLink(value, context) ?? null)
        : mapItems(value, (entry) => toWireDocumentLink(entry, context));
    case 'selectionRange': {
      const chains = Array.isArray(value) ? value : [value];
      const ranges = chains
        .slice(0, MAX_RESULT_ITEMS)
        .map((entry) => toWireSelectionRange(entry))
        .filter((chain) => chain.length > 0);
      return { ranges } satisfies WireSelectionRanges;
    }
    case 'foldingRange':
      return mapItems(value, toWireFoldingRange);
    case 'linkedEditingRange':
      return toWireLinkedEditingRanges(value) ?? null;
    case 'inlayHint':
      return op === 'resolve'
        ? (toWireInlayHint(value, context) ?? null)
        : mapItems(value, (entry) => toWireInlayHint(entry, context));
    case 'inlineValue':
      return mapItems(value, toWireInlineValue);
    case 'typeHierarchy':
    case 'callHierarchy': {
      if (op === 'incoming') return mapItems(value, (entry) => toWireIncomingCall(entry, context));
      if (op === 'outgoing') return mapItems(value, (entry) => toWireOutgoingCall(entry, context));
      return mapItems(value, (entry) => toWireHierarchyItem(entry, context));
    }
    case 'semanticTokens':
      return op === 'edits'
        ? (toWireSemanticTokensEdits(value) ?? null)
        : (toWireSemanticTokens(value, MAX_SEMANTIC_TOKENS) ?? null);
    case 'semanticTokensRange':
      return toWireSemanticTokens(value, MAX_SEMANTIC_TOKENS) ?? null;
  }
}
/**
 * Merge results from several providers for one feature.
 *
 * `concat` and `merge` both mean "keep everything, in provider order" for array results; the
 * difference upstream draws between them is about *who* asks, not how the arrays combine, and
 * `documentSelector.ts` has already made that decision by the time results arrive. `stack` keeps
 * each provider's result as its own block (hover), and `single` never has more than one.
 */
export function mergeWireResults(feature: LanguageFeature, results: readonly unknown[]): unknown {
  const present = results.filter((entry) => entry !== null && entry !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  if (feature === 'hover') {
    const contents: WireMarkdown[] = [];
    let range: LspRange | undefined;
    for (const entry of present) {
      const hover = entry as WireHover;
      if (!Array.isArray(hover.contents)) continue;
      for (const block of hover.contents) {
        if (contents.length < MAX_HOVER_BLOCKS) contents.push(block);
      }
      if (range === undefined && hover.range !== undefined) range = hover.range;
    }
    return contents.length === 0 ? null : { contents, ...(range !== undefined ? { range } : {}) };
  }
  if (feature === 'completion') {
    const items: WireCompletionItem[] = [];
    let isIncomplete = false;
    for (const entry of present) {
      const list = entry as WireCompletionList;
      if (!Array.isArray(list.items)) continue;
      for (const item of list.items) if (items.length < MAX_COMPLETION_ITEMS) items.push(item);
      if (list.isIncomplete === true) isIncomplete = true;
    }
    return { items, ...(isIncomplete ? { isIncomplete: true } : {}) };
  }
  if (feature === 'documentSymbol') {
    const symbols: LspDocumentSymbol[] = [];
    const flat: LspSymbolInformation[] = [];
    for (const entry of present) {
      const result = entry as { symbols?: LspDocumentSymbol[]; flat?: LspSymbolInformation[] };
      if (Array.isArray(result.symbols)) symbols.push(...result.symbols);
      if (Array.isArray(result.flat)) flat.push(...result.flat);
    }
    return { symbols: symbols.slice(0, MAX_RESULT_ITEMS), flat: flat.slice(0, MAX_RESULT_ITEMS) };
  }
  if (feature === 'selectionRange') {
    // Only the first provider's chains are used: two providers' chains cannot be interleaved
    // without producing a selection that grows and shrinks as the user presses the key.
    return present[0];
  }
  if (present.every((entry) => Array.isArray(entry))) {
    return (present as unknown[][]).flat().slice(0, MAX_RESULT_ITEMS);
  }
  return present[0];
}
