/**
 * The language platform runtime: provider registries, dispatch, document sync and workspace edits.
 *
 * Phase 6's division of labour follows Phases 4 and 5 exactly:
 *
 *   - `common/vscodeLanguages.ts`, `common/documentSelector.ts`, `common/vscodeLanguageWire.ts`,
 *     `common/vscodeDocumentSync.ts`, `common/vscodeSemanticTokens.ts` and
 *     `common/vscodeWorkspaceEdit.ts` are pure. Registration, selector scoring, result
 *     normalisation, document versioning, token encoding and edit policy live there.
 *   - This file owns the state, the I/O and the extension hosts: which provider belongs to which
 *     worker, which document is open, which tokens are cached, and every round trip.
 *   - The renderer registers Monaco providers and asks this file to answer them. It never learns
 *     which extension answered, and never receives a provider object.
 *
 * Two things here are worth stating plainly, because they are the reason the file is shaped this way.
 *
 * First, handles. A worker mints its own provider handles, because `registerHoverProvider` returns a
 * `Disposable` synchronously and that disposable has to close over something. Two extensions
 * therefore both own a handle `1`. Main keeps its own global handle per registration and a map back
 * to the worker's, so a request can be routed to one process without extensions being able to name
 * each other's providers.
 *
 * Second, mint tokens. `resolveCompletionItem` and the hierarchy traversals are calls *about a
 * previous result*, so the object the extension returned has to still exist in the worker that made
 * it. Wire items carry an integer token for that object; the token in a worker is worker-local, so
 * every token is re-minted here before it reaches the renderer and translated back on the way in.
 * The renderer holds Main's tokens and never sees a worker's.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { rootLogger } from '@axiom/shared';
import type {
  ExtensionDocumentInput,
  ExtensionDocumentResult,
  ExtensionLanguageDescriptor,
  ExtensionLanguageRegistry,
  ExtensionProvideInput,
  ExtensionProvideResult,
  ExtensionProviderDescriptor,
  ExtensionProviderEditInput,
  LspSemanticTokens,
} from '../../common/ipc';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  LanguageRegistry,
  ProviderRegistry,
  isLanguageFeature,
  isProviderOp,
  limitProviders,
  normalizeLanguageConfiguration,
  normalizeLanguageDefinition,
  type LanguageConfigurationData,
  type LanguageDefinition,
  type LanguageFeature,
  type LanguageProviderRegistration,
  type ProviderOp,
} from '../../common/vscodeLanguages';
import {
  mergeStrategyFor,
  type DocumentCandidate,
  type DocumentFilter,
  type DocumentSelector,
} from '../../common/documentSelector';
import {
  mergeWireResults,
  type WireTextEdit,
  type WireWorkspaceEdit,
} from '../../common/vscodeLanguageWire';
import {
  DocumentStore,
  offsetAt,
  toDocumentCandidate,
  type DocumentContentChange,
} from '../../common/vscodeDocumentSync';
import {
  SemanticTokensCache,
  applySemanticTokensEdits,
  computeSemanticTokensDelta,
  normalizeSemanticTokensData,
  normalizeSemanticTokensEdits,
} from '../../common/vscodeSemanticTokens';
import {
  ProviderChangeCoalescer,
  isChangeableFeature,
  type ProviderChangeBatch,
} from '../../common/vscodeProviderEvents';
import {
  describeWorkspaceEditRejection,
  fileUriToPath,
  sortTextEditsForApply,
  validateWorkspaceEdit,
  type WorkspaceEditPlan,
} from '../../common/vscodeWorkspaceEdit';
import { assertAuthorizedPath, assertAuthorizedMutationPath } from './pathAuthorization';

const log = rootLogger.child('extension-languages');

/** How long one provider gets to answer. Formatters and workspace symbols are the slow ones. */
const PROVIDER_TIMEOUT_MS = 8_000;
const SLOW_PROVIDER_TIMEOUT_MS = 30_000;
const SLOW_FEATURES: ReadonlySet<LanguageFeature> = new Set([
  'formatting',
  'rangeFormatting',
  'workspaceSymbol',
  'semanticTokens',
  'semanticTokensRange',
  'callHierarchy',
  'typeHierarchy',
  'rename',
]);
/** Live references to provider-owned objects, across every extension. */
const MAX_MAIN_TOKENS = 50_000;
/** Documents Main mirrors for the extension hosts. */
const MAX_SYNCED_DOCUMENTS = 200;
/** Bytes one `WorkspaceEdit` may write to a single closed file. */
const MAX_EDITED_FILE_BYTES = 8 * 1024 * 1024;
/** Depth the mint-token rewrite walks. Wire results nest at most a few levels. */
const MAX_REWRITE_DEPTH = 6;
/** A `language-configuration.json` past this is not a configuration file. */
const MAX_LANGUAGE_CONFIGURATION_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// The bridge to the extension hosts and the workbench
// ---------------------------------------------------------------------------
export interface LanguagesHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /** Post to every running host — how a document event reaches all of them. */
  broadcast(message: MainToWorker): void;
  /** Call into a worker and await its reply, on the host's own invocation id space. */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The provider set or the language registry changed: the renderer must re-register. */
  notifyChanged(): void;
  /**
   * Named providers invalidated their own answers, so the editor must ask them again.
   *
   * Separate from `notifyChanged` because the cost is different by orders of magnitude: a registry
   * change rebuilds every Monaco registration, while this fires one provider's own change event.
   */
  notifyProviderChanged(batch: ProviderChangeBatch): void;
  /** Ask the renderer to apply text edits to models it already has open. */
  applyEditInEditor(payload: { entries: WorkspaceEditPlan['entries']; touched: string[] }): void;
  /** Fire `onLanguage:<id>` for anything waiting on a language. */
  activateForLanguage(languageId: string): Promise<void>;
  /** Absolute workspace folder paths, for the `WorkspaceEdit` boundary check. */
  workspaceRoots(): string[];
  /** Every enabled extension's `contributes.languages`, with its directory. */
  contributors(): Promise<LanguageContributor[]>;
  /** Diagnostics every host has published, for `languages.getDiagnostics`. */
  publishedDiagnostics(): Array<{ owner: string; diagnostics: readonly PublishedDiagnostic[] }>;
}

/** One extension's language contributions, as the manifest declares them. */
export interface LanguageContributor {
  extensionId: string;
  directory: string;
  languages: unknown[];
}

/** The subset of `HostDiagnostic` this file reads. Kept structural to avoid a circular import. */
export interface PublishedDiagnostic {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: string;
  source: string;
  code: string;
}

let bridge: LanguagesHostBridge | null = null;

export function configureExtensionLanguages(next: LanguagesHostBridge): void {
  bridge = next;
}

function requireBridge(): LanguagesHostBridge {
  if (bridge === null) throw new Error('The language platform is not configured.');
  return bridge;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** One registration, on both sides of the boundary. */
interface ProviderLink {
  /** Main's handle, which is what the renderer sees. */
  global: number;
  /** The worker's own handle, which is what a `languageProvide` must carry. */
  worker: number;
  extensionId: string;
  feature: LanguageFeature;
}

const providers = new ProviderRegistry();
const linksByGlobal = new Map<number, ProviderLink>();
const linksByWorker = new Map<string, ProviderLink>();
const languages = new LanguageRegistry();
/** Language id → the configuration the renderer feeds Monaco. Last writer wins, as upstream. */
const languageConfigurations = new Map<string, LanguageConfigurationData>();
/** Language id → the extension that last configured it, so deactivation can take it away. */
const configurationOwners = new Map<string, string>();
/** Documents Main mirrors so the workers' `TextDocument`s stay in step with the editor. */
const documents = new DocumentStore(MAX_SYNCED_DOCUMENTS);
const semanticTokens = new SemanticTokensCache();
/** `${globalHandle}:${uri}` → the resultId the *provider* minted, for its own delta method. */
const providerResultIds = new Map<string, string>();

/** A reference to an object a worker still holds. */
interface MintedRef {
  link: ProviderLink;
  workerToken: number;
}
const mainTokens = new Map<number, MintedRef>();
let nextMainToken = 1;
let nextGlobalHandle = 1;
/** Bumped on every registry change so the renderer can discard a snapshot it has been overtaken on. */
let registryRevision = 1;

/** Renderer request id → the worker calls it fanned out to, so a cancel reaches all of them. */
const inFlight = new Map<number, Array<{ extensionId: string; workerId: number }>>();

function linkKey(extensionId: string, workerHandle: number): string {
  return `${extensionId}:${workerHandle}`;
}

function changed(): void {
  registryRevision += 1;
  bridge?.notifyChanged();
}

// ---------------------------------------------------------------------------
// Provider refresh events
// ---------------------------------------------------------------------------
/**
 * Fires waiting to be delivered, and the single timer that delivers them.
 *
 * One timer for the whole process, armed only while something is pending and always for the earliest
 * deadline the coalescer reports. That is what makes the claim "no polling" true here rather than
 * aspirational: with no provider firing, there is no timer, and the cost of the whole refresh
 * pipeline at rest is one empty map.
 */
const providerChanges = new ProviderChangeCoalescer();
let providerChangeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A provider fired its change event.
 *
 * The semantic-tokens case does more than queue, and it has to: Monaco's next request carries the
 * `resultId` of the tokens it is already showing, and Main would answer it with a delta computed
 * against a baseline the provider has just disowned. Dropping the baseline forces the next answer to
 * be a full set, which is the only honest response to "my tokens have changed".
 */
function providerChanged(extensionId: string, workerHandle: number): boolean {
  const link = linksByWorker.get(linkKey(extensionId, workerHandle));
  if (!link) return false;
  if (!isChangeableFeature(link.feature)) return false;
  if (link.feature === 'semanticTokens') {
    semanticTokens.invalidateProvider(link.global);
    forgetProviderResultIds(link.global);
  }
  const outcome = providerChanges.record(link.global, link.feature, Date.now());
  if (outcome === 'dropped') {
    log.warn('Provider refresh dropped: too many providers pending', {
      extensionId,
      feature: link.feature,
      dropped: providerChanges.dropped,
    });
    return false;
  }
  scheduleProviderChangeFlush();
  return true;
}

function scheduleProviderChangeFlush(): void {
  const dueAt = providerChanges.nextDueAt();
  if (dueAt === null) return;
  if (providerChangeTimer !== null) clearTimeout(providerChangeTimer);
  providerChangeTimer = setTimeout(flushProviderChanges, Math.max(0, dueAt - Date.now()));
  // The refresh pipeline must never be the reason the process stays alive.
  providerChangeTimer.unref?.();
}

function flushProviderChanges(): void {
  providerChangeTimer = null;
  const changes = providerChanges.drain(Date.now());
  if (changes.length > 0) {
    bridge?.notifyProviderChanged({ revision: registryRevision, changes });
  }
  // A provider held back by its rate window is still pending; re-arm for whatever is left.
  scheduleProviderChangeFlush();
}

/** Drop a provider's pending refresh. Its registration is gone, so its refresh means nothing. */
function forgetProviderChanges(handles: readonly number[]): void {
  if (handles.length === 0) return;
  providerChanges.forgetMany(handles);
  if (providerChanges.size === 0 && providerChangeTimer !== null) {
    clearTimeout(providerChangeTimer);
    providerChangeTimer = null;
  }
}

function forgetProviderResultIds(globalHandle: number): void {
  const prefix = `${globalHandle}:`;
  for (const key of providerResultIds.keys()) {
    if (key.startsWith(prefix)) providerResultIds.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Requests from the extension hosts
// ---------------------------------------------------------------------------
const LANGUAGE_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>([
  'languages.registerProvider',
  'languages.unregisterProvider',
  'languages.refreshProvider',
  'languages.providerChanged',
  'languages.registerLanguage',
  'languages.setLanguageConfiguration',
  'languages.setTextDocumentLanguage',
  'languages.getLanguages',
  'languages.getDiagnostics',
  'languages.applyWorkspaceEdit',
]);

export function isLanguagesRequestKind(kind: HostRequestKind): boolean {
  return LANGUAGE_REQUEST_KINDS.has(kind);
}

export async function handleLanguagesRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'languages.registerProvider':
      return registerProvider(extensionId, payload);
    case 'languages.unregisterProvider':
      return unregisterProvider(extensionId, Number(payload.handle));
    case 'languages.refreshProvider':
      // The worker could not follow a change batch and has thrown away its copy of the document.
      // Answering with the full text is the only recovery: anything less leaves it guessing.
      return resendDocument(extensionId, payload);
    case 'languages.providerChanged':
      // `onDidChangeCodeLenses` and its four siblings. The handle is the worker's; the refresh is
      // queued against Main's, so an extension can only ever invalidate its own providers.
      return providerChanged(extensionId, Number(payload.handle));
    case 'languages.registerLanguage':
      return registerLanguageFromExtension(extensionId, payload.definition);
    case 'languages.setLanguageConfiguration':
      return setLanguageConfiguration(
        extensionId,
        String(payload.languageId),
        payload.configuration,
      );
    case 'languages.setTextDocumentLanguage':
      return setTextDocumentLanguage(String(payload.uri), String(payload.languageId));
    case 'languages.getLanguages':
      return languages.ids();
    case 'languages.getDiagnostics':
      return readDiagnostics(typeof payload.uri === 'string' ? payload.uri : undefined);
    case 'languages.applyWorkspaceEdit':
      return applyWorkspaceEdit(payload.edit as WireWorkspaceEdit | undefined);
    default:
      throw new Error(`${kind} is not a language request.`);
  }
}

/**
 * Mirror a worker's registration.
 *
 * The payload has already been validated by `validateHostRequest`, which is where the selector was
 * normalised and the feature name checked; what is left here is the part only Main can do — minting a
 * handle that is unique across every extension, and refusing a second registration under a worker
 * handle already in use, which would otherwise leave one of the two providers unreachable.
 */
function registerProvider(extensionId: string, payload: Record<string, unknown>): number {
  const feature = payload.feature;
  if (!isLanguageFeature(feature)) throw new Error(`Unknown language feature ${String(feature)}.`);
  const workerHandle = Number(payload.handle);
  const key = linkKey(extensionId, workerHandle);
  if (linksByWorker.has(key)) {
    throw new Error(`${extensionId} already registered a provider with handle ${workerHandle}.`);
  }
  const global = nextGlobalHandle;
  nextGlobalHandle += 1;
  providers.register({
    extensionId,
    feature,
    selector: payload.selector as never,
    metadata: payload.metadata as never,
    handle: global,
  });
  const link: ProviderLink = { global, worker: workerHandle, extensionId, feature };
  linksByGlobal.set(global, link);
  linksByWorker.set(key, link);
  log.debug('Language provider registered', { extensionId, feature, handle: global });
  changed();
  return global;
}

function unregisterProvider(extensionId: string, workerHandle: number): boolean {
  const link = linksByWorker.get(linkKey(extensionId, workerHandle));
  if (!link) return false;
  linksByWorker.delete(linkKey(extensionId, workerHandle));
  linksByGlobal.delete(link.global);
  providers.unregister(link.global);
  semanticTokens.invalidateProvider(link.global);
  forgetTokensFor(link.global);
  forgetProviderChanges([link.global]);
  changed();
  return true;
}

/** Full-text resend for a worker that lost synchronisation. */
function resendDocument(extensionId: string, payload: Record<string, unknown>): boolean {
  const uri = typeof payload.uri === 'string' ? payload.uri : '';
  const snapshot = documents.get(uri);
  if (!snapshot) return false;
  return requireBridge().deliver(extensionId, {
    t: 'documentReplace',
    uri,
    version: snapshot.version,
    text: snapshot.text,
  });
}

function registerLanguageFromExtension(extensionId: string, raw: unknown): boolean {
  const definition = normalizeLanguageDefinition(raw, { extensionId });
  if (definition === null) return false;
  const added = languages.register(definition);
  if (added) changed();
  return added;
}

function setLanguageConfiguration(extensionId: string, languageId: string, raw: unknown): boolean {
  const configuration = normalizeLanguageConfiguration(raw);
  if (Object.keys(configuration).length === 0) {
    // An empty configuration is how the shim's disposable un-sets one.
    if (configurationOwners.get(languageId) !== extensionId) return false;
    languageConfigurations.delete(languageId);
    configurationOwners.delete(languageId);
    changed();
    return true;
  }
  languageConfigurations.set(languageId, configuration);
  configurationOwners.set(languageId, extensionId);
  changed();
  return true;
}

/**
 * `setTextDocumentLanguage`, which upstream models as a close followed by an open.
 *
 * Every provider registered for the old language must stop being consulted and every provider for the
 * new one must start, so the semantic-token baseline is dropped with it: token type 3 means whatever
 * the *old* provider's legend said, and keeping the tokens would recolour the file with a legend that
 * no longer applies.
 */
function setTextDocumentLanguage(uri: string, languageId: string): boolean {
  const event = documents.setLanguage(uri, languageId);
  if (!event) return false;
  semanticTokens.invalidateDocument(uri);
  requireBridge().broadcast({ t: 'documentLanguage', uri, languageId });
  changed();
  return true;
}

/** Every diagnostic any host published, in the shape `languages.getDiagnostics` returns. */
function readDiagnostics(uri?: string): unknown {
  const wanted = uri === undefined ? null : fileUriToPath(uri);
  const grouped = new Map<string, PublishedDiagnostic[]>();
  for (const { diagnostics } of requireBridge().publishedDiagnostics()) {
    for (const diagnostic of diagnostics) {
      if (wanted !== null && !samePathText(diagnostic.path, wanted)) continue;
      const bucket = grouped.get(diagnostic.path);
      if (bucket) bucket.push(diagnostic);
      else grouped.set(diagnostic.path, [diagnostic]);
    }
  }
  if (uri !== undefined) return [...grouped.values()].flat();
  return [...grouped].map(([path, diagnostics]) => ({ path, diagnostics }));
}

function samePathText(a: string, b: string): boolean {
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
  return fold(a) === fold(b);
}

// ---------------------------------------------------------------------------
// Workspace edits
// ---------------------------------------------------------------------------
/**
 * Apply a `WorkspaceEdit`, or refuse the whole thing.
 *
 * Policy is decided by `validateWorkspaceEdit` against the live workspace roots; this function only
 * carries it out. The split matters: an edit is the one provider result that writes to disk, and the
 * decision about whether a path may be written has to be made in one place, from one list of roots,
 * before any file has been touched.
 *
 * Text edits for a document the editor has open are applied *by the editor*, not on disk. That is
 * upstream's behaviour and it is the only version that is correct: the buffer may be dirty, the user
 * expects one undo step, and writing the file underneath an open model would lose whatever they had
 * typed. Files that are not open are read, edited and written here.
 */
async function applyWorkspaceEdit(edit: WireWorkspaceEdit | undefined): Promise<boolean> {
  const host = requireBridge();
  const validation = validateWorkspaceEdit(edit, {
    roots: host.workspaceRoots(),
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
    allowUntitled: true,
  });
  if (!validation.ok) {
    log.warn('A workspace edit was refused', {
      reason: describeWorkspaceEditRejection(validation.rejection),
    });
    return false;
  }
  const plan = validation.plan;
  const inEditor: WorkspaceEditPlan['entries'] = [];
  try {
    for (const entry of plan.entries) {
      if (entry.kind === 'text') {
        if (needsEditor(entry)) {
          inEditor.push(entry);
          continue;
        }
        await applyTextEditsOnDisk(entry.uri, entry.edits);
        continue;
      }
      await applyFileOperation(entry);
    }
  } catch (error) {
    log.warn('A workspace edit failed part way through', { error: String(error) });
    return false;
  }
  if (inEditor.length > 0) {
    host.applyEditInEditor({ entries: inEditor, touched: plan.touched });
  }
  return true;
}

/**
 * Whether a text entry must be applied by the editor rather than on disk.
 *
 * Three cases: the document is open (its buffer, not the file, is the truth), the URI is `untitled:`
 * (there is no file), or the edit is a `SnippetTextEdit`. A snippet is tabstops and placeholders, not
 * text — writing `${1:name}` into a file would corrupt it, so upstream opens the document and inserts
 * the snippet through the editor, and so do we.
 */
function needsEditor(entry: { uri: string; edits: readonly WireTextEdit[] }): boolean {
  if (documents.has(entry.uri)) return true;
  if (fileUriToPath(entry.uri) === null) return true;
  return entry.edits.some((edit) => edit.insertAsSnippet === true);
}

/**
 * Apply text edits to a closed file.
 *
 * Last-to-first, because every range in a `WorkspaceEdit` is stated against the file as it was before
 * any of them were applied — `sortTextEditsForApply` already ordered and `validateWorkspaceEdit`
 * already proved they do not overlap, so applying in that order means no offset has to be adjusted.
 * The write goes to a temporary file and is renamed into place, so a crash mid-write cannot leave a
 * half-edited source file behind.
 */
async function applyTextEditsOnDisk(uri: string, edits: readonly WireTextEdit[]): Promise<void> {
  const target = fileUriToPath(uri);
  if (target === null) throw new Error(`${uri} is not a writable file path.`);
  const path = await assertAuthorizedPath(target);
  const original = await readFile(path, 'utf8');
  if (original.length > MAX_EDITED_FILE_BYTES) {
    throw new Error(`${uri} is larger than an edit may rewrite.`);
  }
  let text = original;
  for (const edit of sortTextEditsForApply(edits)) {
    const start = offsetAt(text, edit.range.start);
    const end = offsetAt(text, edit.range.end);
    if (end < start) throw new Error(`${uri} received a reversed edit range.`);
    text = text.slice(0, start) + edit.newText + text.slice(end);
    if (text.length > MAX_EDITED_FILE_BYTES) {
      throw new Error(`${uri} grew past the edit size limit.`);
    }
  }
  if (text === original) return;
  const temporary = `${path}.axiom-edit-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, path);
}

/**
 * Carry out one `createFile` / `renameFile` / `deleteFile`.
 *
 * `assertAuthorizedMutationPath` is used for rename and delete rather than `assertAuthorizedPath`,
 * because a destructive operation on a symlink must act on the link and not on whatever it points at,
 * while ancestor symlinks still have to be resolved before the containment check. `overwrite` and
 * `ignoreIfExists` follow upstream: `ignoreIfExists` wins, and without `overwrite` an existing target
 * is an error rather than a silent replacement.
 */
async function applyFileOperation(entry: WorkspaceEditPlan['entries'][number]): Promise<void> {
  if (entry.kind === 'text') return;
  const target = fileUriToPath(entry.uri);
  if (target === null) throw new Error(`${entry.uri} is not a writable file path.`);

  if (entry.kind === 'create') {
    const path = await assertAuthorizedPath(target, { allowMissing: true });
    if (await pathExists(path)) {
      if (entry.ignoreIfExists === true) return;
      if (entry.overwrite !== true) throw new Error(`${entry.uri} already exists.`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.contents ?? '', 'utf8');
    return;
  }

  if (entry.kind === 'rename') {
    const newTarget = fileUriToPath(entry.newUri);
    if (newTarget === null) throw new Error(`${entry.newUri} is not a writable file path.`);
    const from = await assertAuthorizedMutationPath(target);
    const to = await assertAuthorizedMutationPath(newTarget, { allowMissing: true });
    if (await pathExists(to)) {
      if (entry.ignoreIfExists === true) return;
      if (entry.overwrite !== true) throw new Error(`${entry.newUri} already exists.`);
      await rm(to, { recursive: true, force: true });
    }
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return;
  }

  const path = await assertAuthorizedMutationPath(target, {
    allowMissing: entry.ignoreIfNotExists === true,
  });
  if (entry.ignoreIfNotExists === true && !(await pathExists(path))) return;
  await rm(path, { recursive: entry.recursive === true, force: entry.ignoreIfNotExists === true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the part of a provider-returned `WorkspaceEdit` the editor handed back.
 *
 * A rename provider answers with edits for the whole workspace, most of whose files are not open.
 * Monaco applies the ones that are — they belong in its undo stack — and the rest arrive here, where
 * they take exactly the path an extension's own `workspace.applyEdit` takes: validated against the
 * live workspace roots first, applied only if the whole edit is acceptable.
 *
 * Entries this function decides the editor must apply after all (an `untitled:` document, a snippet)
 * are pushed back with `applyEditInEditor`, so the split the renderer made is a starting point rather
 * than a decision Main is bound by.
 */
export async function applyProviderWorkspaceEdit(
  edit: ExtensionProviderEditInput,
): Promise<boolean> {
  return applyWorkspaceEdit(edit as WireWorkspaceEdit);
}

// ---------------------------------------------------------------------------
// Mint tokens: references to objects a worker still holds
// ---------------------------------------------------------------------------
/**
 * Give a worker-local token a Main-global identity.
 *
 * `resolveCompletionItem`, `resolveCodeAction` and the hierarchy traversals are calls *about a result*,
 * so the object the extension returned has to still be alive in the process that made it. The worker
 * keeps it under an integer; that integer means nothing outside that worker, so it is re-minted here.
 * The renderer only ever holds Main's tokens, which is what stops one extension from asking about
 * another's objects.
 *
 * The map is bounded. When it is full the oldest quarter is dropped, because insertion order is
 * age order and the oldest entries belong to results the user has long since scrolled past. A
 * resolve against a dropped token fails and the renderer keeps the unresolved item — which is what
 * upstream shows while a resolve is in flight anyway.
 */
function mintMainToken(link: ProviderLink, workerToken: number): number {
  if (mainTokens.size >= MAX_MAIN_TOKENS) {
    const drop = Math.floor(MAX_MAIN_TOKENS / 4);
    let dropped = 0;
    for (const key of mainTokens.keys()) {
      mainTokens.delete(key);
      dropped += 1;
      if (dropped >= drop) break;
    }
  }
  const token = nextMainToken;
  nextMainToken += 1;
  mainTokens.set(token, { link, workerToken });
  return token;
}

/**
 * Rewrite every `id` in a wire result to a Main token.
 *
 * Mutates in place: the value was just structured-cloned out of the worker message and nothing else
 * holds a reference to it, so copying it would only double the allocation on the hot path. Depth is
 * bounded because a wire result nests a few levels at most and a cyclic object would otherwise hang
 * Main — the wire types cannot express a cycle, but the value came from another process.
 */
function remapMintIds(value: unknown, link: ProviderLink, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_REWRITE_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = remapMintIds(value[index], link, depth + 1);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'id' && typeof record.id === 'number' && Number.isInteger(record.id)) {
      record.id = mintMainToken(link, record.id);
      continue;
    }
    record[key] = remapMintIds(record[key], link, depth + 1);
  }
  return record;
}

/** The worker and provider a Main token refers to, or `undefined` once it has been dropped. */
function resolveMintedToken(token: unknown): MintedRef | undefined {
  if (typeof token !== 'number' || !Number.isInteger(token)) return undefined;
  return mainTokens.get(token);
}

/** Drop every token minted for one provider — called when it is disposed. */
function forgetTokensFor(globalHandle: number): void {
  for (const [token, ref] of mainTokens) {
    if (ref.link.global === globalHandle) mainTokens.delete(token);
  }
}

/** Drop every token minted for one extension — called when its host goes away. */
function forgetTokensForExtension(extensionId: string): void {
  for (const [token, ref] of mainTokens) {
    if (ref.link.extensionId === extensionId) mainTokens.delete(token);
  }
}

// ---------------------------------------------------------------------------
// The registry, as the renderer registers it in Monaco
// ---------------------------------------------------------------------------
/**
 * Flatten a `DocumentSelector` into plain filters.
 *
 * The renderer needs the selector to build Monaco's own registration filter, and Monaco takes a
 * language/scheme/pattern object. A `RelativePattern` is joined into one glob here rather than in the
 * renderer, so only one place has to know that the base and the pattern are separate fields.
 */
function describeSelector(selector: DocumentSelector): ExtensionProviderDescriptor['selector'] {
  const list: ReadonlyArray<string | DocumentFilter> = Array.isArray(selector)
    ? (selector as ReadonlyArray<string | DocumentFilter>)
    : [selector as string | DocumentFilter];
  const out: ExtensionProviderDescriptor['selector'] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      out.push({ language: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const filter: ExtensionProviderDescriptor['selector'][number] = {};
    if (typeof entry.language === 'string') filter.language = entry.language;
    if (typeof entry.scheme === 'string') filter.scheme = entry.scheme;
    if (typeof entry.pattern === 'string') filter.pattern = entry.pattern;
    else if (entry.pattern && typeof entry.pattern === 'object') {
      const base = entry.pattern.base.replace(/[\\/]+$/, '');
      filter.pattern = `${base}/${entry.pattern.pattern}`;
    }
    if (typeof entry.notebookType === 'string') filter.notebookType = entry.notebookType;
    out.push(filter);
  }
  return out;
}

function toProviderDescriptor(
  registration: LanguageProviderRegistration,
): ExtensionProviderDescriptor {
  const metadata = registration.metadata;
  const descriptor: ExtensionProviderDescriptor = {
    handle: registration.handle,
    extensionId: registration.extensionId,
    selector: describeSelector(registration.selector),
  };
  if (metadata.triggerCharacters?.length)
    descriptor.triggerCharacters = [...metadata.triggerCharacters];
  if (metadata.retriggerCharacters?.length)
    descriptor.retriggerCharacters = [...metadata.retriggerCharacters];
  if (metadata.firstTriggerCharacter !== undefined)
    descriptor.firstTriggerCharacter = metadata.firstTriggerCharacter;
  if (metadata.moreTriggerCharacter?.length)
    descriptor.moreTriggerCharacter = [...metadata.moreTriggerCharacter];
  if (metadata.codeActionKinds?.length) descriptor.codeActionKinds = [...metadata.codeActionKinds];
  if (metadata.legend) {
    descriptor.legend = {
      tokenTypes: [...metadata.legend.tokenTypes],
      tokenModifiers: [...metadata.legend.tokenModifiers],
    };
  }
  if (metadata.hasResolve === true) descriptor.hasResolve = true;
  if (metadata.hasEdits === true) descriptor.hasEdits = true;
  if (metadata.hasPrepare === true) descriptor.hasPrepare = true;
  if (metadata.hasChangeEvent === true) descriptor.hasChangeEvent = true;
  if (metadata.displayName !== undefined) descriptor.displayName = metadata.displayName;
  return descriptor;
}

function toLanguageDescriptor(definition: LanguageDefinition): ExtensionLanguageDescriptor {
  const descriptor: ExtensionLanguageDescriptor = {
    id: definition.id,
    aliases: [...definition.aliases],
    extensions: [...definition.extensions],
    filenames: [...definition.filenames],
    filenamePatterns: [...definition.filenamePatterns],
    mimetypes: [...definition.mimetypes],
  };
  if (definition.firstLine !== undefined) descriptor.firstLine = definition.firstLine;
  const configuration = languageConfigurations.get(definition.id);
  if (configuration !== undefined) descriptor.configuration = configuration;
  return descriptor;
}

/**
 * Everything the renderer needs to rebuild its Monaco registrations, in one read.
 *
 * One snapshot rather than a stream of deltas: the renderer disposes its whole provider set and
 * re-registers when the revision changes, which is both simpler to reason about and impossible to get
 * half-right. Registration is cheap; a registry that drifts from the providers actually running is not.
 */
export function languageRegistrySnapshot(): ExtensionLanguageRegistry {
  const features: Record<string, ExtensionProviderDescriptor[]> = {};
  for (const feature of providers.activeFeatures()) {
    features[feature] = providers.forFeature(feature).map(toProviderDescriptor);
  }
  return {
    revision: registryRevision,
    features,
    languages: languages.all().map(toLanguageDescriptor),
  };
}

// ---------------------------------------------------------------------------
// Dispatch: one renderer request, many extension hosts
// ---------------------------------------------------------------------------
/**
 * Operations routed by mint token rather than by selector.
 *
 * A `resolve` or a hierarchy traversal is a question about an object one worker is holding. Scoring
 * selectors again would be worse than pointless: the merged result the renderer holds has no provider
 * identity left in it, so selection could route the call to a different extension, which would be
 * handed a token it never minted.
 */
const TOKEN_ROUTED_OPS: ReadonlySet<ProviderOp> = new Set<ProviderOp>([
  'resolve',
  'incoming',
  'outgoing',
  'supertypes',
  'subtypes',
]);

function timeoutFor(feature: LanguageFeature): number {
  return SLOW_FEATURES.has(feature) ? SLOW_PROVIDER_TIMEOUT_MS : PROVIDER_TIMEOUT_MS;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * What the selector is scored against.
 *
 * A synced document is preferred over anything the renderer says, because it is the copy the providers
 * will actually be given; a URI Main has never seen still has to score (the renderer asks for
 * `documentSymbol` on a file the moment it opens it), so the renderer's `languageId` is the fallback.
 * `workspaceSymbol` has no document at all and scores against a bare candidate, which is why those
 * providers register for `{ scheme: '*' }`.
 */
function candidateFor(uri: string | undefined, languageId: string | undefined): DocumentCandidate {
  if (typeof uri === 'string' && uri.length > 0) {
    const snapshot = documents.get(uri);
    if (snapshot) return toDocumentCandidate(snapshot);
    return toDocumentCandidate({ uri, languageId: languageId ?? '' });
  }
  return { languageId: languageId ?? '', scheme: '*', path: '' };
}

/**
 * Call one provider, recording the worker invocation so a cancel can reach it.
 *
 * The invocation id is captured inside `build`, which the bridge calls synchronously before it posts:
 * that is the only point at which the id exists and the message has not yet been sent, so recording it
 * there is what makes cancellation race-free. A provider that throws or times out becomes a failure
 * string rather than an exception, because one extension's broken hover must not remove another's.
 */
async function callProvider(
  link: ProviderLink,
  requestId: number,
  op: ProviderOp,
  uri: string | null,
  payload: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const host = requireBridge();
  try {
    const value = await host.call(
      link.extensionId,
      (workerId) => {
        inFlight.get(requestId)?.push({ extensionId: link.extensionId, workerId });
        return {
          t: 'languageProvide',
          id: workerId,
          handle: link.worker,
          feature: link.feature,
          op,
          uri,
          payload,
        };
      },
      timeoutFor(link.feature),
    );
    return { ok: true, value: remapMintIds(value, link) };
  } catch (error) {
    return { ok: false, error: `${link.extensionId}: ${errorText(error)}` };
  }
}

/**
 * The single entry point the renderer's Monaco providers call.
 *
 * Everything a provider invocation needs to decide is decided here: whether the feature and operation
 * exist, which providers apply, whether they are called in parallel or one is chosen, and how their
 * answers combine. Results are merged by `mergeWireResults` using the feature's own strategy — hovers
 * stack, completions concatenate, formatting takes the single best provider — because "ordering must
 * match VS Code behaviour" is a per-feature rule, not a global one.
 *
 * A failing provider never fails the request. Its error is collected and the surviving results are
 * returned, which is what upstream does and the only behaviour that keeps one bad extension from
 * taking the language features of a file with it.
 */
export async function provideLanguageFeature(
  input: ExtensionProvideInput,
): Promise<ExtensionProvideResult> {
  if (!isLanguageFeature(input.feature)) {
    return { ok: false, error: `Unknown language feature ${String(input.feature)}.` };
  }
  const feature = input.feature;
  if (!isProviderOp(feature, input.op)) {
    return { ok: false, error: `${feature} does not answer ${String(input.op)}.` };
  }
  const op = input.op as ProviderOp;
  const requestId = Number(input.requestId);
  if (!Number.isInteger(requestId)) return { ok: false, error: 'A request id is required.' };
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  const uri = typeof input.uri === 'string' && input.uri.length > 0 ? input.uri : null;

  const routed = routeRequest(feature, op, input, payload);
  if (!routed.ok) return { ok: false, error: routed.error };
  if (routed.links.length === 0) return { ok: true, value: null };

  inFlight.set(requestId, []);
  try {
    if (feature === 'semanticTokens' && op === 'edits') {
      return await provideSemanticTokensEdits(
        routed.links[0] as ProviderLink,
        requestId,
        uri,
        input,
      );
    }
    if (feature === 'semanticTokens' || feature === 'semanticTokensRange') {
      return await provideSemanticTokens(
        routed.links[0] as ProviderLink,
        requestId,
        uri,
        payload,
        feature,
      );
    }
    const settled = await Promise.all(
      routed.links.map((link) => callProvider(link, requestId, op, uri, payload)),
    );
    const values: unknown[] = [];
    const failures: string[] = [];
    for (const result of settled) {
      if (result.ok) values.push(result.value);
      else failures.push(result.error);
    }
    if (values.length === 0 && failures.length > 0) {
      return { ok: false, error: failures[0] as string, failures };
    }
    const merged = mergeWireResults(feature, values);
    return failures.length > 0
      ? { ok: true, value: merged, failures }
      : { ok: true, value: merged };
  } finally {
    inFlight.delete(requestId);
  }
}

/** Which providers answer this request: one named by a token, one named by handle, or a selection. */
function routeRequest(
  feature: LanguageFeature,
  op: ProviderOp,
  input: ExtensionProvideInput,
  payload: Record<string, unknown>,
): { ok: true; links: ProviderLink[] } | { ok: false; error: string } {
  if (TOKEN_ROUTED_OPS.has(op)) {
    const ref = resolveMintedToken(payload.id);
    if (!ref) return { ok: false, error: 'That result is no longer available.' };
    if (ref.link.feature !== feature)
      return { ok: false, error: 'That result is not a ' + feature };
    // The worker knows the object under its own token, never Main's.
    payload.id = ref.workerToken;
    return { ok: true, links: [ref.link] };
  }
  if (typeof input.handle === 'number') {
    const link = linksByGlobal.get(input.handle);
    if (!link) return { ok: true, links: [] };
    if (link.feature !== feature) return { ok: false, error: 'That provider is not a ' + feature };
    return { ok: true, links: [link] };
  }
  const candidate = candidateFor(
    input.uri,
    typeof payload.languageId === 'string' ? payload.languageId : undefined,
  );
  const selection = providers.select(feature, candidate);
  const links: ProviderLink[] = [];
  for (const registration of limitProviders(selection.providers)) {
    const link = linksByGlobal.get(registration.handle);
    if (link) links.push(link);
  }
  return { ok: true, links: mergeStrategyFor(feature) === 'single' ? links.slice(0, 1) : links };
}

/**
 * Abandon an in-flight request.
 *
 * Every worker the request fanned out to is told, because a `CancellationToken` that only fires in one
 * of three processes leaves two providers working on a result nobody will read. The map entry is left
 * for the request's own `finally` to remove, so a cancel arriving after the last reply is a no-op.
 */
export function cancelLanguageRequest(requestId: number): boolean {
  const calls = inFlight.get(requestId);
  if (!calls || calls.length === 0) return false;
  const host = requireBridge();
  for (const call of calls) {
    host.deliver(call.extensionId, { t: 'languageCancel', id: call.workerId });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Semantic tokens: two result id spaces, one cache
// ---------------------------------------------------------------------------
/**
 * Full semantic tokens for a document or a range.
 *
 * The `resultId` the renderer receives is Main's, not the provider's. There have to be two: the
 * provider's id is the only thing `provideDocumentSemanticTokensEdits` will accept, and Main's is the
 * only thing that identifies the baseline *Main* holds — a provider that restarts and reuses its ids
 * would otherwise be handed a baseline belonging to its previous life.
 *
 * A range result is never stored as a baseline. It describes part of the document, so a later delta
 * spliced onto it would colour the file from an array that was never the whole file.
 */
async function provideSemanticTokens(
  link: ProviderLink,
  requestId: number,
  uri: string | null,
  payload: Record<string, unknown>,
  feature: 'semanticTokens' | 'semanticTokensRange',
): Promise<ExtensionProvideResult> {
  const result = await callProvider(link, requestId, 'provide', uri, payload);
  if (!result.ok) return { ok: false, error: result.error, failures: [result.error] };
  const tokens = result.value as LspSemanticTokens | null;
  if (tokens === null || typeof tokens !== 'object') return { ok: true, value: null };
  const data = normalizeSemanticTokensData(tokens.data);
  if (data === null) {
    return { ok: false, error: `${link.extensionId} returned unusable semantic tokens.` };
  }
  if (feature === 'semanticTokensRange' || uri === null) return { ok: true, value: { data } };
  const version = documents.get(uri)?.version ?? 0;
  const resultId = semanticTokens.store(link.global, uri, version, data);
  rememberProviderResultId(link, uri, tokens.resultId);
  return { ok: true, value: { resultId, data } };
}

/** Keep the id the *provider* minted, which is the only one its own delta method understands. */
function rememberProviderResultId(link: ProviderLink, uri: string, resultId: unknown): void {
  const key = `${link.global}:${uri}`;
  if (typeof resultId === 'string' && resultId.length > 0) providerResultIds.set(key, resultId);
  else providerResultIds.delete(key);
}

/**
 * A delta request.
 *
 * Three paths, in order of preference: the provider implements `provideDocumentSemanticTokensEdits`
 * and its edits fit the baseline; the provider only implements the full method, so Main diffs the two
 * arrays itself and sends the edit; or there is no usable baseline and the answer is the full set. The
 * middle path is why `computeSemanticTokensDelta` exists — most extensions implement only the full
 * method, and re-sending a megabyte of tokens on every keystroke is what makes a large file stutter.
 */
async function provideSemanticTokensEdits(
  link: ProviderLink,
  requestId: number,
  uri: string | null,
  input: ExtensionProvideInput,
): Promise<ExtensionProvideResult> {
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  const previousResultId =
    typeof payload.previousResultId === 'string' ? payload.previousResultId : undefined;
  if (uri === null || previousResultId === undefined) {
    return provideSemanticTokens(link, requestId, uri, payload, 'semanticTokens');
  }
  const version = documents.get(uri)?.version ?? 0;
  const baseline = semanticTokens.lookup(link.global, uri, previousResultId, version);
  if (!baseline) return provideSemanticTokens(link, requestId, uri, {}, 'semanticTokens');

  const registration = providers.get(link.global);
  const providerResultId = providerResultIds.get(`${link.global}:${uri}`);
  if (registration?.metadata.hasEdits === true && providerResultId !== undefined) {
    const result = await callProvider(link, requestId, 'edits', uri, {
      previousResultId: providerResultId,
    });
    if (!result.ok) return { ok: false, error: result.error, failures: [result.error] };
    const absorbed = absorbProviderTokenEdits(
      link,
      uri,
      baseline.entry.data,
      result.value,
      version,
    );
    if (absorbed !== null) return { ok: true, value: absorbed };
    log.debug('A semantic-token delta did not fit its baseline; re-requesting in full', {
      extensionId: link.extensionId,
    });
  }
  return diffFullSemanticTokens(link, requestId, uri, baseline.entry.data);
}

/** Take whatever `provideDocumentSemanticTokensEdits` returned — full tokens, or edits. */
function absorbProviderTokenEdits(
  link: ProviderLink,
  uri: string,
  baseline: readonly number[],
  value: unknown,
  version: number,
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as { resultId?: unknown; data?: unknown; edits?: unknown };
  if (record.data !== undefined) {
    const data = normalizeSemanticTokensData(record.data);
    if (data === null) return null;
    const resultId = semanticTokens.store(link.global, uri, version, data);
    rememberProviderResultId(link, uri, record.resultId);
    return { resultId, data };
  }
  const edits = normalizeSemanticTokensEdits(record.edits, baseline.length);
  if (edits === null) return null;
  const data = applySemanticTokensEdits(baseline, edits);
  if (data === null) return null;
  const resultId = semanticTokens.store(link.global, uri, version, data);
  rememberProviderResultId(link, uri, record.resultId);
  return { resultId, edits };
}

/** Ask for the whole document and answer with a delta, for providers with no delta method. */
async function diffFullSemanticTokens(
  link: ProviderLink,
  requestId: number,
  uri: string,
  baseline: readonly number[],
): Promise<ExtensionProvideResult> {
  const result = await callProvider(link, requestId, 'provide', uri, {});
  if (!result.ok) return { ok: false, error: result.error, failures: [result.error] };
  const tokens = result.value as LspSemanticTokens | null;
  if (tokens === null || typeof tokens !== 'object') return { ok: true, value: null };
  const data = normalizeSemanticTokensData(tokens.data);
  if (data === null) {
    return { ok: false, error: `${link.extensionId} returned unusable semantic tokens.` };
  }
  const version = documents.get(uri)?.version ?? 0;
  const resultId = semanticTokens.store(link.global, uri, version, data);
  rememberProviderResultId(link, uri, tokens.resultId);
  const edits = computeSemanticTokensDelta(baseline, data);
  const spliced = edits.reduce((total, edit) => total + (edit.data?.length ?? 0), 0);
  // Only worth sending as a delta while the delta is genuinely smaller than the document.
  if (spliced * 2 < data.length) return { ok: true, value: { resultId, edits } };
  return { ok: true, value: { resultId, data } };
}

// ---------------------------------------------------------------------------
// Document synchronisation
// ---------------------------------------------------------------------------
/**
 * Mirror one editor document event into every extension host.
 *
 * "No stale document state may exist" is the requirement, and the version is what enforces it: a
 * change that does not follow the version Main holds is refused and answered with `resync: true`,
 * which makes the renderer resend the full text. Refusing is the point — applying a change to the
 * wrong baseline produces a document that looks synchronised and answers every provider call with
 * positions that are quietly wrong.
 *
 * Opening a document is also what fires `onLanguage:` activation, exactly as upstream: an extension
 * contributing TypeScript providers must not be started because the workbench launched, only because a
 * TypeScript file was opened.
 */
export async function reportDocumentEvent(
  input: ExtensionDocumentInput,
): Promise<ExtensionDocumentResult> {
  const host = requireBridge();
  const uri = typeof input.uri === 'string' ? input.uri : '';
  if (uri.length === 0) return { ok: false };

  switch (input.type) {
    case 'open': {
      const languageId = resolveLanguageId(uri, input.languageId);
      const event = documents.open({
        uri,
        languageId,
        ...(Number.isInteger(input.version) ? { version: Number(input.version) } : {}),
        text: typeof input.text === 'string' ? input.text : '',
        isDirty: input.isDirty === true,
      });
      if (!event) return { ok: false };
      const snapshot = event.snapshot;
      host.broadcast({
        t: 'documentOpen',
        uri,
        languageId: snapshot.languageId,
        version: snapshot.version,
        text: snapshot.text,
        isDirty: snapshot.isDirty,
      });
      await host.activateForLanguage(snapshot.languageId);
      return { ok: true };
    }
    case 'change': {
      const version = Number(input.version);
      if (typeof input.text === 'string' && !Array.isArray(input.changes)) {
        // The resync path: the renderer is telling us what the document is, not how it changed.
        const replaced = documents.replace(uri, version, input.text);
        if (!replaced) return { ok: false, resync: true };
        semanticTokens.invalidateDocument(uri);
        host.broadcast({
          t: 'documentReplace',
          uri,
          version: replaced.snapshot.version,
          text: replaced.snapshot.text,
        });
        return { ok: true };
      }
      const changes = (input.changes ?? []) as DocumentContentChange[];
      const result = documents.change(uri, version, changes, {
        ...(typeof input.isDirty === 'boolean' ? { isDirty: input.isDirty } : {}),
      });
      if (!result.ok) {
        if (result.reason === 'unknown') return { ok: false };
        log.debug('A document change was refused', { uri, reason: result.reason });
        return { ok: false, resync: true };
      }
      host.broadcast({
        t: 'documentChange',
        uri,
        version: result.event.snapshot.version,
        changes,
        isDirty: result.event.snapshot.isDirty,
      });
      return { ok: true };
    }
    case 'save': {
      if (!documents.save(uri)) return { ok: false };
      host.broadcast({ t: 'documentSave', uri });
      return { ok: true };
    }
    case 'close': {
      if (!documents.close(uri)) return { ok: false };
      forgetDocumentTokens(uri);
      host.broadcast({ t: 'documentClose', uri });
      return { ok: true };
    }
    case 'language': {
      const languageId = resolveLanguageId(uri, input.languageId);
      if (!setTextDocumentLanguage(uri, languageId)) return { ok: false };
      await host.activateForLanguage(languageId);
      return { ok: true };
    }
    default:
      return { ok: false };
  }
}

/** The renderer's language id, or the one the contributed definitions imply for the path. */
function resolveLanguageId(uri: string, languageId: string | undefined): string {
  if (typeof languageId === 'string' && languageId.length > 0) return languageId;
  const candidate = toDocumentCandidate({ uri, languageId: '' });
  return languages.detect({ path: candidate.path }) ?? 'plaintext';
}

function forgetDocumentTokens(uri: string): void {
  semanticTokens.invalidateDocument(uri);
  const suffix = `:${uri}`;
  for (const key of providerResultIds.keys()) {
    if (key.endsWith(suffix)) providerResultIds.delete(key);
  }
}

/**
 * Send a freshly started host every document already open.
 *
 * Without this an extension activated by a command — or by a second file — would hold an empty
 * document set and every provider call would be refused for a document it has never been told about.
 */
export function seedDocumentsForExtension(extensionId: string): void {
  const host = requireBridge();
  for (const snapshot of documents.all()) {
    host.deliver(extensionId, {
      t: 'documentOpen',
      uri: snapshot.uri,
      languageId: snapshot.languageId,
      version: snapshot.version,
      text: snapshot.text,
      isDirty: snapshot.isDirty,
    });
  }
}

// ---------------------------------------------------------------------------
// Contributed languages, from the manifests
// ---------------------------------------------------------------------------
/**
 * Load `contributes.languages` for every enabled extension.
 *
 * Declarative language contributions are already read elsewhere for the workbench's own purposes, in
 * the reduced shape the theme and snippet machinery needs. The language platform needs the full one —
 * `indentationRules`, `onEnterRules`, `wordPattern`, `folding` — because Monaco applies all of it and
 * an extension that ships an `onEnterRules` file expects its language to indent the way it says. So
 * this reads the same files and normalises them for Monaco, without disturbing the existing path.
 *
 * Registration is idempotent: a language already registered by an earlier call, or by another
 * extension, is left alone rather than replaced, matching upstream's first-writer-wins for languages
 * (and last-writer-wins for configurations, which is why the configuration is set unconditionally).
 */
export async function refreshLanguageContributions(): Promise<number> {
  const host = requireBridge();
  let registered = 0;
  let dirty = false;
  for (const contributor of await host.contributors()) {
    for (const raw of contributor.languages) {
      const definition = normalizeLanguageDefinition(raw, { extensionId: contributor.extensionId });
      if (definition === null) continue;
      if (languages.register(definition)) {
        registered += 1;
        dirty = true;
      }
      if (definition.configurationPath === undefined) continue;
      const configuration = await readLanguageConfigurationFile(
        contributor.directory,
        definition.configurationPath,
      );
      if (configuration === null) continue;
      languageConfigurations.set(definition.id, configuration);
      configurationOwners.set(definition.id, contributor.extensionId);
      dirty = true;
    }
  }
  if (dirty) changed();
  contributionsLoaded = true;
  return registered;
}

let contributionsLoaded = false;
let contributionsPending: Promise<number> | null = null;

/**
 * Load contributed languages once, on first demand.
 *
 * The renderer reads the registry snapshot on every change event, and a change event fires whenever an
 * extension registers a provider — far too often to re-read every manifest and configuration file. So
 * the declarative half is loaded on the first read and afterwards only when something that could have
 * changed it happens (an install, an enable, a disable), which
 * {@link refreshLanguageContributions} handles directly. Failures are logged and not retried on the
 * spot: a snapshot missing one language is better than a registry read that throws at the renderer.
 */
export async function ensureLanguageContributions(): Promise<number> {
  if (contributionsLoaded) return 0;
  contributionsPending ??= refreshLanguageContributions();
  try {
    return await contributionsPending;
  } catch (error) {
    log.warn('Could not load contributed languages', { error: String(error) });
    return 0;
  } finally {
    contributionsPending = null;
  }
}

/**
 * Read one `language-configuration.json`.
 *
 * JSONC, not JSON: these files routinely carry comments and trailing commas, and `JSON.parse` rejects
 * a large fraction of real ones. The path comes out of a manifest, so it is resolved and then required
 * to still be inside the extension's own directory — a `configuration` of `../../../etc/passwd` reads
 * nothing.
 */
async function readLanguageConfigurationFile(
  directory: string,
  configurationPath: string,
): Promise<LanguageConfigurationData | null> {
  const target = resolve(directory, configurationPath);
  const relation = relative(directory, target);
  if (relation.length === 0 || relation.startsWith('..') || isAbsolute(relation)) {
    log.warn('A language configuration path pointed outside its extension', { configurationPath });
    return null;
  }
  let text: string;
  try {
    text = await readFile(target, 'utf-8');
  } catch {
    return null;
  }
  if (text.length > MAX_LANGUAGE_CONFIGURATION_BYTES) return null;
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(stripBom(text), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (value === null || typeof value !== 'object') return null;
  const configuration = normalizeLanguageConfiguration(value);
  return Object.keys(configuration).length === 0 ? null : configuration;
}

/** Files written on Windows frequently start with a byte-order mark, which JSONC will not accept. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
/**
 * Remove everything one extension owns.
 *
 * Called on deactivation and on a host crash, and both need the same thing: after this returns no
 * provider belonging to the extension can be selected, no baseline it produced can be handed to
 * anything, and no token it minted resolves. A crashed host's in-flight calls are dropped rather than
 * cancelled — there is no process left to tell.
 */
export function disposeLanguagesForExtension(extensionId: string): void {
  const removed: number[] = [];
  for (const [key, link] of linksByWorker) {
    if (link.extensionId !== extensionId) continue;
    linksByWorker.delete(key);
    linksByGlobal.delete(link.global);
    removed.push(link.global);
  }
  for (const handle of removed) {
    semanticTokens.invalidateProvider(handle);
    forgetTokensFor(handle);
    const prefix = `${handle}:`;
    for (const key of providerResultIds.keys()) {
      if (key.startsWith(prefix)) providerResultIds.delete(key);
    }
  }
  forgetProviderChanges(removed);
  providers.removeExtension(extensionId);
  const languagesRemoved = languages.removeExtension(extensionId);
  let configurationsRemoved = 0;
  for (const [languageId, owner] of configurationOwners) {
    if (owner !== extensionId) continue;
    configurationOwners.delete(languageId);
    languageConfigurations.delete(languageId);
    configurationsRemoved += 1;
  }
  forgetTokensForExtension(extensionId);
  for (const [requestId, calls] of inFlight) {
    const kept = calls.filter((call) => call.extensionId !== extensionId);
    if (kept.length === calls.length) continue;
    if (kept.length === 0) inFlight.delete(requestId);
    else inFlight.set(requestId, kept);
  }
  if (removed.length > 0 || languagesRemoved > 0 || configurationsRemoved > 0) changed();
}

/** Counts the validators assert against, and the only window into this module's state. */
export function extensionLanguagesState(): {
  providers: number;
  languages: number;
  configurations: number;
  documents: number;
  tokenBaselines: number;
  mintedTokens: number;
  inFlight: number;
  revision: number;
  /** Provider refreshes queued but not yet delivered. */
  pendingProviderChanges: number;
  /** Refreshes ever refused by the pending-entry valve. Non-zero is worth investigating. */
  droppedProviderChanges: number;
} {
  return {
    providers: providers.size,
    languages: languages.size,
    configurations: languageConfigurations.size,
    documents: documents.size,
    tokenBaselines: semanticTokens.size,
    mintedTokens: mainTokens.size,
    inFlight: inFlight.size,
    revision: registryRevision,
    pendingProviderChanges: providerChanges.size,
    droppedProviderChanges: providerChanges.dropped,
  };
}

export function resetExtensionLanguagesForTesting(): void {
  providers.clear();
  linksByGlobal.clear();
  linksByWorker.clear();
  languages.clear();
  languageConfigurations.clear();
  configurationOwners.clear();
  documents.clear();
  semanticTokens.clear();
  providerResultIds.clear();
  mainTokens.clear();
  inFlight.clear();
  providerChanges.clear();
  if (providerChangeTimer !== null) {
    clearTimeout(providerChangeTimer);
    providerChangeTimer = null;
  }
  nextMainToken = 1;
  nextGlobalHandle = 1;
  registryRevision = 1;
  contributionsLoaded = false;
  contributionsPending = null;
  bridge = null;
}
