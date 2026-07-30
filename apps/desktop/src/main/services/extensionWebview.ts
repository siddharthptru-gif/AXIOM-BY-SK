/**
 * The webview runtime's privileged half (PRD Phase 4).
 *
 * `common/vscodeWebview.ts` decides what a webview URL means, what a document looks like and
 * what a message may contain. This file owns the things only Main can own: minting a token,
 * serving the `axiom-webview://` origin, deciding whether a file is inside a webview's
 * `localResourceRoots`, keeping the registry of live webviews, and persisting the handful of
 * panels a serializer will be asked to restore.
 *
 * Three properties this file is responsible for:
 *
 *   - **Nothing is created until an extension asks.** No protocol handler is installed, no
 *     persistence file is read and no timer is armed until the first `createWebviewPanel` or the
 *     first time the workbench shows a contributed view. Startup cost is unchanged.
 *   - **A webview reads exactly its own allow-list.** Every resource fetch is resolved,
 *     normalized and compared against that webview's roots — never against another webview's,
 *     and never against the filesystem at large. Decisions are cached per webview and the cache
 *     dies with the webview.
 *   - **The frame is content, not code.** Documents are served with their own CSP, and the only
 *     way out of a frame is `postMessage` to the workbench, which validates the envelope before
 *     anything reaches this file. There is no preload, no Node and no Electron in a webview.
 */
import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, net, protocol } from 'electron';
import { rootLogger } from '@axiom/shared';
import type { HostRequestKind, MainToWorker } from '../../common/vscodeHost';
import {
  MAX_PERSISTED_PANELS,
  MAX_WEBVIEWS_PER_EXTENSION,
  MAX_WEBVIEW_ICON_BYTES,
  MAX_WEBVIEW_RESOURCE_BYTES,
  WEBVIEW_PERMISSIONS_POLICY,
  WEBVIEW_SCHEME,
  isCommandUriAllowed,
  isPathInsideRoots,
  isWebviewHandle,
  isWebviewViewType,
  normalizeLocalResourceRoots,
  normalizeWebviewPath,
  parsePersistedWebviewPanels,
  parseWebviewCommandUri,
  parseWebviewFrameMessage,
  parseWebviewUrl,
  rewriteWebviewHtml,
  sanitizeWebviewThemeVariables,
  serializePersistedWebviewPanels,
  trimResourceCache,
  webviewCspSource,
  webviewDocumentCsp,
  webviewDocumentUrl,
  webviewHostEnvelope,
  webviewOrigin,
  webviewResourceCacheKey,
  webviewResourceUrl,
  webviewSandboxAttribute,
  webviewThemeBodyClass,
  type PersistedWebviewPanel,
  type WebviewContentOptions,
  type WebviewHostMessage,
  type WebviewPanelBehaviour,
  type WebviewSnapshot,
  type WebviewThemeKind,
} from '../../common/vscodeWebview';
import { RENDERER_PROTOCOL_HOST, RENDERER_PROTOCOL_SCHEME } from '../runtimeSecurity';
import { extensionStorageRoot } from './marketplaceExtensions';

const log = rootLogger.child('extension-webview');

/** Messages held for a frame that has not reported `ready` yet. */
const MAX_QUEUED_MESSAGES = 64;
/** How long a serializer or a view provider gets to build its document. */
const RESOLVE_TIMEOUT_MS = 30_000;
/** Debounce on writing the restorable-panel list. */
const PERSIST_DELAY_MS = 1_000;

interface WebviewRecord {
  handle: string;
  token: string;
  extensionId: string;
  displayName: string;
  surface: 'panel' | 'view';
  viewType: string;
  title: string;
  description: string;
  iconLight: string | null;
  iconDark: string | null;
  iconDataUri: string | null;
  badge: { value: number; tooltip: string } | null;
  options: WebviewContentOptions;
  panelOptions: WebviewPanelBehaviour;
  /** The effective allow-list: what the extension asked for, contained by what it may reach. */
  roots: string[];
  /** The document exactly as the extension set it. Rewritten when the frame fetches it. */
  html: string | null;
  htmlVersion: number;
  nonce: string;
  visible: boolean;
  active: boolean;
  viewColumn: number;
  /** The frame's own `setState` blob, replayed on reload and handed to a serializer. */
  state: string | null;
  /** True while a persisted panel has not been handed back to its serializer yet. */
  restored: boolean;
  ready: boolean;
  queued: unknown[];
  resourceCache: Map<string, string | null>;
  disposed: boolean;
}

const webviews = new Map<string, WebviewRecord>();
const byToken = new Map<string, WebviewRecord>();
/** `registerWebviewViewProvider`: view type → the extension that will resolve it. */
const viewProviders = new Map<string, { extensionId: string; retainContextWhenHidden: boolean }>();
/** `registerWebviewPanelSerializer`: view type → the extension that can restore it. */
const serializers = new Map<string, string>();
/** Panels read from disk that no serializer has claimed yet. */
let persistedPanels: PersistedWebviewPanel[] = [];
let persistedLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let protocolHandled = false;

let theme: { kind: WebviewThemeKind; name: string; variables: Record<string, string> } = {
  kind: 'dark',
  name: '',
  variables: {},
};
let codiconFontPath: string | null = null;
let codiconResolved = false;
/** Windows and macOS compare paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

// ---------------------------------------------------------------------------
// The bridge to the extension host and the workbench
// ---------------------------------------------------------------------------
export interface WebviewHostBridge {
  /** Post to the worker owning an extension. False when it has no running host. */
  deliver(extensionId: string, message: MainToWorker): boolean;
  /**
   * Call into a worker and await its reply, reusing the host's own invocation id space so a
   * stopped extension rejects everything outstanding in one place.
   */
  call(
    extensionId: string,
    build: (id: number) => MainToWorker,
    timeoutMs: number,
  ): Promise<unknown>;
  /** The webview list changed: the renderer should re-read it. */
  notifyChanged(): void;
  /** Hand one host→frame envelope to the renderer, which owns the iframes. */
  postToFrame(handle: string, envelope: Record<string, unknown>): void;
  /** Run a command id, through the same path `commands.execute` uses. */
  runCommand(command: string, args: unknown[]): Promise<void>;
  /** Fire `onView:`/`onWebviewPanel:` for the extension that contributed a type. */
  activateForViewType(kind: 'view' | 'webviewPanel', viewType: string): Promise<void>;
  /** An installed extension's directory, for default roots and icon resolution. */
  extensionDirectory(extensionId: string): string | null;
  /** The display name to show against a webview in the workbench. */
  displayName(extensionId: string): string;
  /** The current workspace root, the other default resource root. */
  workspaceRoot(): string | null;
}

let bridge: WebviewHostBridge | null = null;

export function configureExtensionWebview(next: WebviewHostBridge): void {
  bridge = next;
}

function requireBridge(): WebviewHostBridge {
  if (bridge === null) throw new Error('The webview runtime is not configured.');
  return bridge;
}

/** The one document allowed to frame a webview, in both development and production. */
function workbenchOrigin(): string {
  const development = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
  if (development !== undefined && development.length > 0) {
    try {
      return new URL(development).origin;
    } catch {
      // Fall through to the packaged origin.
    }
  }
  return `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}`;
}

// ---------------------------------------------------------------------------
// Serving the webview origin
// ---------------------------------------------------------------------------
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Install the `axiom-webview://` handler, once, on first use.
 *
 * Lazy on purpose: an AXIOM session with no webview-bearing extension never registers a
 * handler, never resolves the codicon font and pays nothing at startup for a feature it is not
 * using.
 */
function ensureProtocol(): void {
  if (protocolHandled) return;
  protocolHandled = true;
  protocol.handle(WEBVIEW_SCHEME, (request) => serve(request));
  log.info('Webview protocol registered');
}

async function serve(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const target = parseWebviewUrl(request.url);
  if (target === null) return new Response(null, { status: 400 });
  const record = byToken.get(target.token);
  if (record === undefined || record.disposed) return new Response(null, { status: 404 });
  if (target.kind === 'document') return serveDocument(record);
  return serveResource(record, target.fsPath);
}

/**
 * Find the workbench's codicon font once, if it is there at all.
 *
 * The file is a hashed build artefact, so it is located by pattern rather than by name, and a
 * missing font is not an error: `codiconFontUrl: null` simply omits the `@font-face` rule and
 * extensions that ship their own copy are unaffected.
 */
async function ensureCodiconFont(): Promise<string | null> {
  if (codiconResolved) return codiconFontPath;
  codiconResolved = true;
  const assets = join(app.getAppPath(), 'out', 'renderer', 'assets');
  try {
    const entries = await readdir(assets);
    const match = entries.find((name) => /^codicon[\w.-]*\.ttf$/i.test(name));
    if (match !== undefined) codiconFontPath = join(assets, match);
  } catch {
    codiconFontPath = null;
  }
  return codiconFontPath;
}

async function serveDocument(record: WebviewRecord): Promise<Response> {
  const font = await ensureCodiconFont();
  const document = rewriteWebviewHtml(record.html ?? '', {
    token: record.token,
    handle: record.handle,
    nonce: record.nonce,
    workbenchOrigin: workbenchOrigin(),
    themeKind: theme.kind,
    themeVariables: theme.variables,
    codiconFontUrl: font === null ? null : webviewResourceUrl(record.token, font),
    state: record.state,
    enableCommandUris: record.options.enableCommandUris !== false,
  });
  return new Response(document, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': webviewDocumentCsp({
        token: record.token,
        enableScripts: record.options.enableScripts,
        enableForms: record.options.enableForms,
        workbenchOrigin: workbenchOrigin(),
      }),
      'permissions-policy': WEBVIEW_PERMISSIONS_POLICY,
      'x-content-type-options': 'nosniff',
      // The document is generated per request from live state, so caching it would serve a
      // stale `setHtml` after a reload.
      'cache-control': 'no-store',
    },
  });
}

function mimeTypeFor(path: string): string {
  const value = MIME_TYPES[extname(path).toLowerCase()];
  return typeof value === 'string' ? value : 'application/octet-stream';
}

/**
 * Decide whether this webview may read this path — the whole of `localResourceRoots`.
 *
 * Purely a function of the request and the record, so the answer can be cached per webview and
 * the cache can never answer for a different webview: the key carries the token, and the map
 * lives on the record and dies with it.
 */
function authorizePath(record: WebviewRecord, fsPath: string): string | null {
  const normalized = normalizeWebviewPath(fsPath);
  if (normalized === null) return null;
  if (isPathInsideRoots(normalized, record.roots, CASE_INSENSITIVE_PATHS)) return normalized;
  // The workbench's own codicon font is the single file outside the allow-list any webview may
  // read. It is an application asset referenced by the stylesheet AXIOM injects; allow-listing
  // the directory it lives in instead would hand every webview the renderer bundle for nothing.
  if (
    codiconFontPath !== null &&
    isPathInsideRoots(normalized, [codiconFontPath], CASE_INSENSITIVE_PATHS)
  ) {
    return normalized;
  }
  return null;
}

async function serveResource(record: WebviewRecord, fsPath: string): Promise<Response> {
  const key = webviewResourceCacheKey(record.token, fsPath);
  let resolved = record.resourceCache.get(key);
  if (resolved === undefined) {
    resolved = authorizePath(record, fsPath);
    record.resourceCache.set(key, resolved);
    trimResourceCache(record.resourceCache);
    if (resolved === null) {
      log.warn('A webview asked for a file outside its resource roots', {
        id: record.extensionId,
        viewType: record.viewType,
      });
    }
  }
  if (resolved === null) return new Response(null, { status: 404 });
  // Statted per request rather than cached with the decision: a file can grow after it was
  // first served, and the size limit has to hold for the request that is actually happening.
  let size: number;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return new Response(null, { status: 404 });
    size = info.size;
  } catch {
    return new Response(null, { status: 404 });
  }
  if (size > MAX_WEBVIEW_RESOURCE_BYTES) return new Response(null, { status: 413 });
  const response = await net.fetch(pathToFileURL(resolved).toString());
  if (!response.ok) return new Response(null, { status: 404 });
  return new Response(response.body, {
    status: 200,
    headers: {
      'content-type': mimeTypeFor(resolved),
      'content-length': String(size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      // Nothing outside this webview's own origin may fetch its resources.
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
/** 128 bits of `randomBytes`: the token *is* the origin, so guessing one must be hopeless. */
function mintToken(): string {
  let token = randomBytes(16).toString('hex');
  while (byToken.has(token)) token = randomBytes(16).toString('hex');
  return token;
}

function mintHandle(): string {
  let handle = randomBytes(8).toString('hex');
  while (webviews.has(handle)) handle = randomBytes(8).toString('hex');
  return handle;
}

/** A fresh nonce per document version, cryptographically random and base64url as CSP wants. */
function mintNonce(): string {
  return randomBytes(20).toString('base64url');
}

/**
 * The effective `localResourceRoots`.
 *
 * An extension may narrow what its webview can read; it may not widen it. Whatever it declares
 * is intersected with the places that extension can already reach through the host — its own
 * installation directory, its storage directories and the open workspace — so
 * `localResourceRoots: ['/']` yields the defaults' subset rather than a filesystem. Declaring
 * nothing means the defaults, and declaring an empty array means no local files at all, which
 * upstream also treats as distinct.
 */
function effectiveRoots(extensionId: string, requested: string[] | null): string[] {
  const host = requireBridge();
  const directory = host.extensionDirectory(extensionId);
  const workspace = host.workspaceRoot();
  const reachable = normalizeLocalResourceRoots([
    ...(directory === null ? [] : [directory]),
    ...(workspace === null ? [] : [workspace]),
    extensionStorageRoot(extensionId, 'global'),
    extensionStorageRoot(extensionId, 'workspace'),
    extensionStorageRoot(extensionId, 'logs'),
  ]);
  if (requested === null) return reachable;
  const out: string[] = [];
  for (const root of normalizeLocalResourceRoots(requested)) {
    if (isPathInsideRoots(root, reachable, CASE_INSENSITIVE_PATHS)) out.push(root);
    else
      log.warn('Dropped a webview resource root the extension cannot reach', { id: extensionId });
  }
  return out;
}

interface CreateOptions {
  extensionId: string;
  surface: 'panel' | 'view';
  viewType: string;
  title: string;
  viewColumn: number;
  options: WebviewContentOptions;
  panelOptions: WebviewPanelBehaviour;
  state: string | null;
  restored: boolean;
  /**
   * The identity the extension host declared for a webview it is creating. The API it implements
   * is synchronous — `asWebviewUri()` and `cspSource` must answer in the same tick as
   * `createWebviewPanel()` — so the worker mints these (128 bits of `randomBytes`) and names them
   * here instead of awaiting a round trip. Ownership still lives in Main: the caller rejects an
   * identity that is already registered, and the origin only ever serves what `roots` allows.
   */
  handle?: string;
  token?: string;
}

function createRecord(input: CreateOptions): WebviewRecord {
  ensureProtocol();
  const record: WebviewRecord = {
    handle: input.handle ?? mintHandle(),
    token: input.token ?? mintToken(),
    extensionId: input.extensionId,
    displayName: requireBridge().displayName(input.extensionId),
    surface: input.surface,
    viewType: input.viewType,
    title: input.title,
    description: '',
    iconLight: null,
    iconDark: null,
    iconDataUri: null,
    badge: null,
    options: input.options,
    panelOptions: input.panelOptions,
    roots: effectiveRoots(input.extensionId, input.options.localResourceRoots),
    html: null,
    htmlVersion: 0,
    nonce: mintNonce(),
    visible: false,
    active: false,
    viewColumn: input.viewColumn,
    state: input.state,
    restored: input.restored,
    ready: false,
    queued: [],
    resourceCache: new Map<string, string | null>(),
    disposed: false,
  };
  webviews.set(record.handle, record);
  byToken.set(record.token, record);
  return record;
}

function snapshotOf(record: WebviewRecord): WebviewSnapshot {
  return {
    handle: record.handle,
    token: record.token,
    extensionId: record.extensionId,
    displayName: record.displayName,
    kind: record.surface,
    viewType: record.viewType,
    title: record.title.length > 0 ? record.title : record.displayName,
    iconDataUri: record.iconDataUri,
    badge: record.badge,
    documentUrl: webviewDocumentUrl(record.token),
    origin: webviewOrigin(record.token),
    htmlVersion: record.htmlVersion,
    hasHtml: record.html !== null,
    visible: record.visible,
    active: record.active,
    retainContextWhenHidden: record.panelOptions.retainContextWhenHidden,
    enableScripts: record.options.enableScripts,
    enableForms: record.options.enableForms,
    enableFindWidget: record.panelOptions.enableFindWidget,
    enableCommandUris: record.options.enableCommandUris !== false,
    sandbox: webviewSandboxAttribute({
      enableScripts: record.options.enableScripts,
      enableForms: record.options.enableForms,
    }),
    viewColumn: record.viewColumn,
    restored: record.restored,
  };
}

/** Everything the workbench should be drawing, in creation order. */
export function listWebviewSnapshots(): WebviewSnapshot[] {
  const out: WebviewSnapshot[] = [];
  for (const record of webviews.values()) {
    if (!record.disposed) out.push(snapshotOf(record));
  }
  return out;
}

function changed(): void {
  requireBridge().notifyChanged();
}

/** A record an extension is allowed to act on: its own, and not already disposed. */
function ownRecord(extensionId: string, handle: unknown): WebviewRecord | null {
  if (!isWebviewHandle(handle)) return null;
  const record = webviews.get(handle);
  if (record === undefined || record.disposed) return null;
  return record.extensionId === extensionId ? record : null;
}

// ---------------------------------------------------------------------------
// Host → frame
// ---------------------------------------------------------------------------
/**
 * Send one envelope to a frame, or hold it until the frame says it is ready.
 *
 * Extensions post messages immediately after `setHtml`, long before the document has parsed the
 * bootstrap. Upstream queues those; so does this. The queue is bounded and drops the oldest
 * entries, because an extension messaging a webview that never loads must not grow memory.
 */
function postToFrame(record: WebviewRecord, message: WebviewHostMessage): boolean {
  const envelope = webviewHostEnvelope(record.handle, message);
  if (!record.ready) {
    record.queued.push(envelope);
    if (record.queued.length > MAX_QUEUED_MESSAGES) {
      record.queued.splice(0, record.queued.length - MAX_QUEUED_MESSAGES);
    }
    return true;
  }
  requireBridge().postToFrame(record.handle, envelope);
  return true;
}

function flushQueue(record: WebviewRecord): void {
  if (record.queued.length === 0) return;
  const pending = record.queued.splice(0, record.queued.length);
  const host = requireBridge();
  for (const envelope of pending) {
    host.postToFrame(record.handle, envelope as Record<string, unknown>);
  }
}

/**
 * Read an `iconPath` into a bounded `data:` URI.
 *
 * A snapshot crosses IPC into the workbench, where a path would then have to be fetched by the
 * renderer — so the bytes travel instead, capped, and only from inside the extension's own
 * reachable roots. An icon that fails any check simply does not appear.
 */
async function resolveIcon(record: WebviewRecord, raw: string): Promise<string | null> {
  if (raw.length === 0) return null;
  const normalized = normalizeWebviewPath(raw);
  if (normalized === null) return null;
  const reachable = effectiveRoots(record.extensionId, null);
  if (!isPathInsideRoots(normalized, reachable, CASE_INSENSITIVE_PATHS)) return null;
  try {
    const info = await stat(normalized);
    if (!info.isFile() || info.size > MAX_WEBVIEW_ICON_BYTES) return null;
    const bytes = await readFile(normalized);
    const mime = mimeTypeFor(normalized);
    if (!mime.startsWith('image/')) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------
/**
 * Tear one webview down.
 *
 * Everything that holds memory is released here — the document, the queued messages and the
 * authorization cache — and the token is unregistered, so a request already in flight from the
 * frame resolves to a 404 rather than to a record that is being freed. `notifyHost` is false
 * when the extension asked for the disposal itself: it already knows.
 */
function disposeRecord(record: WebviewRecord, notifyHost: boolean): void {
  if (record.disposed) return;
  record.disposed = true;
  record.html = null;
  record.queued = [];
  record.resourceCache.clear();
  record.visible = false;
  record.active = false;
  webviews.delete(record.handle);
  byToken.delete(record.token);
  if (notifyHost) {
    requireBridge().deliver(record.extensionId, { t: 'webviewDispose', handle: record.handle });
  }
  if (record.surface === 'panel') schedulePersist();
}

/** Called when an extension host stops: its webviews cannot outlive the code behind them. */
export function disposeWebviewsForExtension(extensionId: string): void {
  const doomed: WebviewRecord[] = [];
  for (const record of webviews.values()) {
    if (record.extensionId === extensionId) doomed.push(record);
  }
  if (doomed.length === 0) return;
  // Persist before the records go, so a restart can restore what was open.
  capturePersistablePanels(doomed);
  for (const record of doomed) disposeRecord(record, false);
  for (const [viewType, provider] of viewProviders) {
    if (provider.extensionId === extensionId) viewProviders.delete(viewType);
  }
  for (const [viewType, owner] of serializers) {
    if (owner === extensionId) serializers.delete(viewType);
  }
  changed();
}

// ---------------------------------------------------------------------------
// Requests from the extension host
// ---------------------------------------------------------------------------
/** True for the `webview.*` request kinds this service owns. */
export function isWebviewRequestKind(kind: HostRequestKind): boolean {
  return typeof kind === 'string' && kind.startsWith('webview.');
}

/**
 * Handle one validated `webview.*` request.
 *
 * `validateHostRequest` in `common/vscodeHost.ts` has already bounded and coerced every field,
 * so this function's job is state and ownership: an extension may only name handles it created,
 * and a handle it does not own is indistinguishable from a handle that does not exist.
 */
export async function handleWebviewRequest(
  extensionId: string,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (kind) {
    case 'webview.create': {
      const mine = countFor(extensionId);
      if (mine >= MAX_WEBVIEWS_PER_EXTENSION) {
        throw new Error(`That extension already has ${String(mine)} open webviews.`);
      }
      // A declared identity must be unused. Refusing a duplicate is what stops one extension from
      // naming another's origin, and it is also the only way a `randomBytes` collision could ever
      // matter, so both maps are consulted before the record exists.
      const handle = String(payload.handle ?? '');
      const token = String(payload.token ?? '');
      if (webviews.has(handle) || byToken.has(token)) {
        throw new Error('That webview identity is already in use.');
      }
      const record = createRecord({
        extensionId,
        surface: payload.surface === 'view' ? 'view' : 'panel',
        viewType: String(payload.viewType),
        title: String(payload.title ?? ''),
        viewColumn: typeof payload.viewColumn === 'number' ? payload.viewColumn : -1,
        options: payload.options as WebviewContentOptions,
        panelOptions: payload.panelOptions as WebviewPanelBehaviour,
        state: null,
        restored: false,
        handle,
        token,
      });
      record.visible = payload.preserveFocus !== true;
      record.active = record.visible;
      changed();
      return {
        handle: record.handle,
        token: record.token,
        origin: webviewOrigin(record.token),
        cspSource: webviewCspSource(record.token),
      };
    }
    case 'webview.setHtml': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      record.html = String(payload.html ?? '');
      record.htmlVersion += 1;
      // A new document gets a new nonce, and the previous document's authorization decisions
      // are not reused: `setHtml` is where an extension changes what it references.
      record.nonce = mintNonce();
      record.resourceCache.clear();
      record.ready = false;
      record.restored = false;
      changed();
      return true;
    }
    case 'webview.setOptions': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      const next = payload.options as WebviewContentOptions;
      const sandboxChanged =
        next.enableScripts !== record.options.enableScripts ||
        next.enableForms !== record.options.enableForms;
      record.options = next;
      record.roots = effectiveRoots(extensionId, next.localResourceRoots);
      record.resourceCache.clear();
      // `sandbox` and the header CSP are decided when the frame loads, so a change to either has
      // to reload the frame; anything else (roots, command URIs) takes effect on the next fetch.
      if (sandboxChanged && record.html !== null) {
        record.htmlVersion += 1;
        record.nonce = mintNonce();
        record.ready = false;
      }
      changed();
      return true;
    }
    case 'webview.setTitle': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      record.title = String(payload.title ?? '');
      record.description = String(payload.description ?? '');
      changed();
      schedulePersist();
      return true;
    }
    case 'webview.setIconPath': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      const light = String(payload.light ?? '');
      const dark = String(payload.dark ?? '');
      if (light === record.iconLight && dark === record.iconDark) return true;
      record.iconLight = light;
      record.iconDark = dark;
      const wanted = theme.kind === 'light' || theme.kind === 'high-contrast-light' ? light : dark;
      record.iconDataUri = await resolveIcon(record, wanted.length > 0 ? wanted : light);
      if (!record.disposed) changed();
      return true;
    }
    case 'webview.setBadge': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      const value = payload.value;
      record.badge =
        typeof value === 'number' ? { value, tooltip: String(payload.tooltip ?? '') } : null;
      changed();
      return true;
    }
    case 'webview.reveal': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      if (typeof payload.viewColumn === 'number') record.viewColumn = payload.viewColumn;
      record.visible = true;
      if (payload.preserveFocus !== true) {
        record.active = true;
        // Focus is the frame's to take: the workbench brings the panel forward, and the frame
        // moves the caret, which is the only way focus can land inside sandboxed content.
        postToFrame(record, { kind: 'focus' });
      }
      requireBridge().deliver(extensionId, {
        t: 'webviewVisibility',
        handle: record.handle,
        visible: record.visible,
        active: record.active,
      });
      changed();
      return true;
    }
    case 'webview.dispose': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      disposeRecord(record, false);
      changed();
      return true;
    }
    case 'webview.postMessage': {
      const record = ownRecord(extensionId, payload.handle);
      if (record === null) return false;
      // Upstream resolves `false` for a webview whose scripts are off — nothing there can
      // receive the message — rather than throwing.
      if (!record.options.enableScripts) return false;
      return postToFrame(record, { kind: 'message', payload: payload.payload });
    }
    case 'webview.registerViewProvider': {
      const viewType = String(payload.viewType);
      viewProviders.set(viewType, {
        extensionId,
        retainContextWhenHidden: payload.retainContextWhenHidden === true,
      });
      changed();
      return true;
    }
    case 'webview.unregisterViewProvider': {
      const viewType = String(payload.viewType);
      const provider = viewProviders.get(viewType);
      if (provider !== undefined && provider.extensionId === extensionId) {
        viewProviders.delete(viewType);
        for (const record of [...webviews.values()]) {
          if (record.surface === 'view' && record.viewType === viewType) {
            disposeRecord(record, true);
          }
        }
        changed();
      }
      return true;
    }
    case 'webview.registerSerializer': {
      const viewType = String(payload.viewType);
      serializers.set(viewType, extensionId);
      await restoreForSerializer(extensionId, viewType);
      return true;
    }
    default:
      throw new Error(`${String(kind)} is not a webview request.`);
  }
}

function countFor(extensionId: string): number {
  let count = 0;
  for (const record of webviews.values()) {
    if (record.extensionId === extensionId && !record.disposed) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Frame → host
// ---------------------------------------------------------------------------
/**
 * One message out of one webview frame.
 *
 * The renderer has already checked `event.source` and `event.origin`; this re-checks the data,
 * because those two prove where a message came from and say nothing about what it contains. A
 * message that fails validation is dropped and logged without its payload — it is
 * extension-authored content, and it does not belong in the log.
 */
export async function receiveFrameMessage(handle: string, raw: unknown): Promise<void> {
  const record = isWebviewHandle(handle) ? webviews.get(handle) : undefined;
  if (record === undefined || record.disposed) return;
  const message = parseWebviewFrameMessage(raw, handle);
  if (message === null) {
    log.warn('Dropped a malformed webview message', {
      id: record.extensionId,
      viewType: record.viewType,
    });
    return;
  }
  const host = requireBridge();
  switch (message.kind) {
    case 'ready':
      record.ready = true;
      flushQueue(record);
      if (record.state !== null) postToFrame(record, { kind: 'state', state: record.state });
      return;
    case 'message':
      host.deliver(record.extensionId, {
        t: 'webviewMessage',
        handle: record.handle,
        payload: message.payload,
      });
      return;
    case 'state':
      record.state = message.state;
      host.deliver(record.extensionId, {
        t: 'webviewState',
        handle: record.handle,
        state: message.state,
      });
      schedulePersist();
      return;
    case 'command': {
      const parsed = parseWebviewCommandUri(message.href);
      if (parsed === null) return;
      if (!isCommandUriAllowed(parsed.command, record.options.enableCommandUris)) {
        log.warn('Refused a command URI a webview is not allowed to run', {
          id: record.extensionId,
          command: parsed.command,
        });
        return;
      }
      await host.runCommand(parsed.command, parsed.args);
      return;
    }
    case 'error':
      log.warn('A webview reported an error', {
        id: record.extensionId,
        viewType: record.viewType,
        message: message.message,
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Workbench → host
// ---------------------------------------------------------------------------
/** The workbench showed, hid, focused or blurred a webview. */
export function setWebviewVisibility(handle: string, visible: boolean, active: boolean): void {
  const record = isWebviewHandle(handle) ? webviews.get(handle) : undefined;
  if (record === undefined || record.disposed) return;
  if (record.visible === visible && record.active === active) return;
  record.visible = visible;
  record.active = visible && active;
  if (!visible && !record.panelOptions.retainContextWhenHidden) {
    // The frame is being unmounted, so the next mount starts from a fresh document. The state
    // blob is kept: replaying it is exactly what `retainContextWhenHidden: false` costs an
    // extension, and it is what `getState` returns after the reload.
    record.ready = false;
    record.queued = [];
  }
  requireBridge().deliver(record.extensionId, {
    t: 'webviewVisibility',
    handle: record.handle,
    visible: record.visible,
    active: record.active,
  });
}

/** The user closed a panel, or the workbench tore a view down. */
export function closeWebview(handle: string): void {
  const record = isWebviewHandle(handle) ? webviews.get(handle) : undefined;
  if (record === undefined || record.disposed) return;
  disposeRecord(record, true);
  changed();
}

/**
 * Push the workbench's current theme to every live frame.
 *
 * Cached in Main as well as sent, so the *next* document served already carries the variables in
 * its `:root` block and a webview never flashes unstyled while waiting for a message.
 */
export function setWebviewTheme(input: {
  kind: WebviewThemeKind;
  name: string;
  variables: unknown;
}): void {
  theme = {
    kind: input.kind,
    name: input.name.slice(0, 200),
    variables: sanitizeWebviewThemeVariables(input.variables),
  };
  const message: WebviewHostMessage = {
    kind: 'theme',
    variables: theme.variables,
    bodyClass: webviewThemeBodyClass(theme.kind),
    themeKind: theme.kind,
    themeName: theme.name,
  };
  for (const record of webviews.values()) {
    if (!record.disposed && record.ready) postToFrame(record, message);
  }
}

// ---------------------------------------------------------------------------
// Webview views
// ---------------------------------------------------------------------------
/**
 * Make sure the view of `viewType` exists, activating the extension that provides it if needed.
 *
 * This is the lazy edge of the whole feature: a contributed view costs nothing until the user
 * opens it, at which point `onView:<viewType>` fires, the provider registers, and the extension
 * builds its document inside `resolveWebviewView`.
 */
export async function ensureWebviewView(viewType: string): Promise<WebviewSnapshot | null> {
  if (!isWebviewViewType(viewType)) return null;
  for (const record of webviews.values()) {
    if (!record.disposed && record.surface === 'view' && record.viewType === viewType) {
      return snapshotOf(record);
    }
  }
  const host = requireBridge();
  if (!viewProviders.has(viewType)) await host.activateForViewType('view', viewType);
  const provider = viewProviders.get(viewType);
  if (provider === undefined) {
    log.warn('No installed extension provides that webview view', { viewType });
    return null;
  }
  const record = createRecord({
    extensionId: provider.extensionId,
    surface: 'view',
    viewType,
    title: '',
    viewColumn: -1,
    // Whatever the provider asks for in `resolveWebviewView` replaces these; until then the
    // view can do nothing, which is also upstream's starting point.
    options: {
      enableScripts: false,
      enableForms: false,
      enableCommandUris: false,
      localResourceRoots: null,
    },
    panelOptions: {
      enableFindWidget: false,
      retainContextWhenHidden: provider.retainContextWhenHidden,
    },
    state: null,
    restored: false,
  });
  record.visible = true;
  changed();
  try {
    await host.call(
      provider.extensionId,
      (id) => ({
        t: 'webviewResolveView',
        id,
        handle: record.handle,
        token: record.token,
        viewType,
        state: record.state,
        visible: true,
      }),
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    log.warn('A webview view provider did not resolve', {
      id: provider.extensionId,
      viewType,
    });
    disposeRecord(record, false);
    changed();
    return null;
  }
  return record.disposed ? null : snapshotOf(record);
}

// ---------------------------------------------------------------------------
// Serializers and restoration
// ---------------------------------------------------------------------------
/**
 * Bring back the panels an extension's serializer owns, as placeholders.
 *
 * A restored panel is a tab with a title and no frame: no document is built and no extension
 * code runs until the user actually looks at it, which is what keeps a session with twenty
 * remembered panels as cheap to start as a session with none.
 */
async function restoreForSerializer(extensionId: string, viewType: string): Promise<void> {
  await ensurePersistedLoaded();
  const mine = persistedPanels.filter(
    (panel) => panel.extensionId === extensionId && panel.viewType === viewType,
  );
  if (mine.length === 0) return;
  persistedPanels = persistedPanels.filter(
    (panel) => !(panel.extensionId === extensionId && panel.viewType === viewType),
  );
  for (const panel of mine) {
    createRecord({
      extensionId,
      surface: 'panel',
      viewType,
      title: panel.title,
      viewColumn: panel.viewColumn,
      options: {
        enableScripts: panel.enableScripts,
        enableForms: panel.enableForms,
        enableCommandUris: panel.enableCommandUris,
        localResourceRoots: panel.localResourceRoots,
      },
      panelOptions: {
        enableFindWidget: false,
        retainContextWhenHidden: panel.retainContextWhenHidden,
      },
      state: panel.state,
      restored: true,
    });
  }
  log.info('Restored webview panels', { id: extensionId, viewType, count: mine.length });
  changed();
}

/**
 * Fire `onWebviewPanel:<viewType>` for everything that was open last time.
 *
 * Called by the workbench once it is up, never at startup: reading one small JSON file and
 * activating the extensions that own remembered panels is work that belongs after the window is
 * interactive, and it does nothing at all when the file is absent.
 */
export async function restorePersistedWebviews(): Promise<void> {
  await ensurePersistedLoaded();
  if (persistedPanels.length === 0) return;
  const seen = new Set<string>();
  for (const panel of [...persistedPanels]) {
    if (seen.has(panel.viewType)) continue;
    seen.add(panel.viewType);
    try {
      await requireBridge().activateForViewType('webviewPanel', panel.viewType);
    } catch {
      log.warn('Could not activate an extension to restore its panels', {
        viewType: panel.viewType,
      });
    }
  }
}

/**
 * Hand a restored placeholder to its serializer, the first time it is looked at.
 *
 * Returns false when nothing can restore it — no serializer, or the extension failed — and the
 * placeholder is removed rather than left as a tab that can never show anything.
 */
export async function revealRestoredPanel(handle: string): Promise<boolean> {
  const record = isWebviewHandle(handle) ? webviews.get(handle) : undefined;
  if (record === undefined || record.disposed) return false;
  if (!record.restored) return true;
  const host = requireBridge();
  if (!serializers.has(record.viewType)) {
    await host.activateForViewType('webviewPanel', record.viewType);
  }
  if (serializers.get(record.viewType) !== record.extensionId) {
    log.warn('No serializer claimed a restored webview panel', { viewType: record.viewType });
    disposeRecord(record, false);
    changed();
    return false;
  }
  try {
    await host.call(
      record.extensionId,
      (id) => ({
        t: 'webviewRestorePanel',
        id,
        handle: record.handle,
        token: record.token,
        viewType: record.viewType,
        title: record.title,
        state: record.state,
        viewColumn: record.viewColumn,
      }),
      RESOLVE_TIMEOUT_MS,
    );
  } catch {
    log.warn('A webview serializer did not restore a panel', {
      id: record.extensionId,
      viewType: record.viewType,
    });
    disposeRecord(record, false);
    changed();
    return false;
  }
  if (record.disposed) return false;
  // The serializer normally calls `setHtml`, which clears this; clear it anyway so a serializer
  // that sets no document still stops being treated as a placeholder.
  record.restored = false;
  changed();
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function persistenceFile(): string {
  return join(app.getPath('userData'), 'webview-panels.json');
}

async function ensurePersistedLoaded(): Promise<void> {
  if (persistedLoaded) return;
  persistedLoaded = true;
  try {
    const raw = await readFile(persistenceFile(), 'utf8');
    persistedPanels = parsePersistedWebviewPanels(JSON.parse(raw) as unknown);
  } catch {
    // No file, or a file nobody can parse: an empty restore is the correct outcome either way.
    persistedPanels = [];
  }
}

/** Only panels whose view type still has a serializer can be restored, so only those are kept. */
function persistableFrom(record: WebviewRecord): PersistedWebviewPanel | null {
  if (record.surface !== 'panel' || record.disposed) return null;
  if (serializers.get(record.viewType) !== record.extensionId) return null;
  return {
    extensionId: record.extensionId,
    viewType: record.viewType,
    title: record.title,
    state: record.state,
    viewColumn: record.viewColumn,
    retainContextWhenHidden: record.panelOptions.retainContextWhenHidden,
    enableScripts: record.options.enableScripts,
    enableForms: record.options.enableForms,
    enableCommandUris: record.options.enableCommandUris !== false,
    localResourceRoots: record.options.localResourceRoots,
  };
}

/** Move panels that are about to be disposed back into the pending list, so a restart sees them. */
function capturePersistablePanels(records: readonly WebviewRecord[]): void {
  for (const record of records) {
    if (persistedPanels.length >= MAX_PERSISTED_PANELS) break;
    const entry = record.restored ? persistableSnapshotOfRestored(record) : persistableFrom(record);
    if (entry !== null) persistedPanels.push(entry);
  }
}

/**
 * A placeholder that was never revealed still deserves to survive: its serializer registration is
 * what put it here, and losing it on an extension restart would quietly forget the user's panel.
 */
function persistableSnapshotOfRestored(record: WebviewRecord): PersistedWebviewPanel {
  return {
    extensionId: record.extensionId,
    viewType: record.viewType,
    title: record.title,
    state: record.state,
    viewColumn: record.viewColumn,
    retainContextWhenHidden: record.panelOptions.retainContextWhenHidden,
    enableScripts: record.options.enableScripts,
    enableForms: record.options.enableForms,
    enableCommandUris: record.options.enableCommandUris !== false,
    localResourceRoots: record.options.localResourceRoots,
  };
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void writePersisted();
  }, PERSIST_DELAY_MS);
}

/** Write on the way out, so the last `setState` before a quit is not the one that is lost. */
export async function flushWebviewPersistence(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistedLoaded && webviews.size === 0) return;
  await writePersisted();
}

async function writePersisted(): Promise<void> {
  await ensurePersistedLoaded();
  const panels: PersistedWebviewPanel[] = [...persistedPanels];
  for (const record of webviews.values()) {
    const entry = record.restored ? persistableSnapshotOfRestored(record) : persistableFrom(record);
    if (entry !== null) panels.push(entry);
  }
  const file = persistenceFile();
  // Temp file plus rename, the same shape the rest of the app writes user data with: a crash
  // mid-write leaves the previous list intact rather than a truncated one.
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(serializePersistedWebviewPanels(panels)), 'utf8');
    await rename(temporary, file);
  } catch {
    log.warn('Could not write the restorable webview panel list');
  }
}
