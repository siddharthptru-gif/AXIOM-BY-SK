import { BrowserWindow, app, clipboard, utilityProcess } from 'electron';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { rootLogger } from '@axiom/shared';
import { IPC } from '../../common/ipc';
import {
  HOST_PROTOCOL_VERSION,
  MAX_HOST_FILE_BYTES,
  MAX_HOST_STATE_BYTES,
  MAX_HOST_STATUS_ITEMS,
  decideCrashResponse,
  normalizeHostDiagnostics,
  parseWorkerMessage,
  pruneCrashTimes,
  validateHostRequest,
  type HostDiagnostic,
  type HostRequestKind,
  type HostState,
  type HostStatus,
  type HostStatusBarItem,
  type MainToWorker,
} from '../../common/vscodeHost';
import {
  activatesEagerly,
  activationLanguages,
  activationMatches,
  activationWorkspaceFiles,
  type ActivationTrigger,
} from '../../common/vscodeHost';
import type { ActivationEventKind } from '../../common/activationIndex';
import { matchesVsCodeGlob } from '../../common/vscodeGlob';
import type { VsCodeManifest } from '../../common/vscodeManifest';
import { externalUrlForOpen } from '../runtimeSecurity';
import { appendAudit } from './audit';
import {
  extensionStorageRoot,
  installedExtensionDetail,
  listEnabledExtensionManifests,
  listInstalledExtensions,
  readHostConsent,
  writeHostConsent,
} from './marketplaceExtensions';
import { assertAuthorizedPath } from './pathAuthorization';
import { buildChildProcessEnvironment } from './processEnvironment';
import { readSettings } from './settings';
import {
  clearAuthProvidersForExtension,
  configureExtensionAuth,
  getAccountsForExtension,
  getSessionForExtension,
  notifyProviderSessionsChanged,
  registerExtensionAuthProvider,
  removeSessionForExtension,
  resetExtensionAuthState,
  unregisterExtensionAuthProvider,
} from './extensionAuth';
import {
  deleteExtensionSecret,
  readExtensionSecret,
  writeExtensionSecret,
} from './extensionSecrets';
import {
  configureExtensionUri,
  mintExternalUri,
  registerExtensionUriHandler,
  resetExtensionUriState,
  unregisterExtensionUriHandler,
} from './extensionUri';
import {
  configureExtensionWebview,
  disposeWebviewsForExtension,
  handleWebviewRequest,
  isWebviewRequestKind,
} from './extensionWebview';
import {
  configureExtensionViews,
  disposeViewsForExtension,
  flushViewState,
  handleViewsRequest,
  isViewsRequestKind,
  refreshViewRegistry,
} from './extensionViews';
import {
  configureExtensionLanguages,
  disposeLanguagesForExtension,
  handleLanguagesRequest,
  isLanguagesRequestKind,
  refreshLanguageContributions,
  seedDocumentsForExtension,
} from './extensionLanguages';
import {
  configureExtensionTerminals,
  disposeTerminalsForExtension,
  handleTerminalsRequest,
  isTerminalsRequestKind,
  restoreEnvironmentCollections,
} from './extensionTerminals';
import {
  configureExtensionTasks,
  disposeTasksForExtension,
  handleTasksRequest,
  invalidateWorkspaceTasks,
  isTasksRequestKind,
} from './extensionTasks';
import {
  configureExtensionDebug,
  disposeDebugForExtension,
  handleDebugRequest,
  isDebugRequestKind,
} from './extensionDebug';
import {
  configureExtensionFileEvents,
  disposeFileEventsForExtension,
  handleFileEventsRequest,
  isFileEventsRequestKind,
} from './extensionFileEvents';
import type { MenuCommandInfo } from '../../common/vscodeMenus';
import type { ViewContributor } from '../../common/vscodeViews';

/**
 * Supervision of the extension hosts.
 *
 * One `utilityProcess` per activated extension. That is more memory than VS Code spends —
 * it runs every extension in one shared host — and it is the deliberate cost of the property
 * the design asks for: when an extension crashes, only that extension goes down, only that
 * extension is restarted, and the crash is attributable to it without guessing. A shared host
 * cannot offer any of the three, because one bad `activate()` takes the whole host with it.
 *
 * The order of operations for anything to run at all:
 *
 *   1. The extension must be installed and enabled.
 *   2. It must declare an entry point. Declarative-only extensions never start a process.
 *   3. **The user must have granted consent for that specific extension.** This is asked
 *      once per extension, in plain terms, because the honest description of the privilege
 *      is not reassuring: extension code runs as a Node process with the user's own OS
 *      privileges. The capability broker below bounds what the `vscode` shim offers; it does
 *      not sandbox Node. Anyone reading this file should understand that distinction.
 *   4. An activation event must fire — startup, an opened language, or an invoked command.
 *
 * Everything the shim asks for arrives here as a validated request and is answered by a
 * handler that re-checks the effect at the point of use: paths go through the same
 * workspace authorization as any renderer request, URLs through the same external-open
 * policy, and anything not in the request set is refused by construction.
 */
const log = rootLogger.child('extension-host');

/** Time an extension gets to acknowledge `init` before it counts as a failed start. */
const READY_TIMEOUT_MS = 15_000;
/** Time a single command invocation may take before the caller stops waiting. */
const INVOKE_TIMEOUT_MS = 60_000;
/** Time a user-facing prompt stays outstanding before it resolves as dismissed. */
const UI_TIMEOUT_MS = 5 * 60 * 1000;
/** Output lines retained per channel. Enough to diagnose, bounded enough to hold in memory. */
const MAX_OUTPUT_LINES = 500;
/** Files a `findFiles` request may return, and directories it may walk. */
const MAX_FIND_RESULTS = 2_000;
const MAX_FIND_DIRECTORIES = 5_000;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.axiom']);

interface HostRecord {
  extensionId: string;
  displayName: string;
  version: string;
  directory: string;
  mainFile: string;
  activationEvents: string[];
  child: ReturnType<typeof utilityProcess.fork> | null;
  state: HostState;
  detail: string | null;
  commands: string[];
  activationMs: number | null;
  crashTimes: number[];
  workspaceRoot: string | null;
  ready: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  pendingInvocations: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  nextInvokeId: number;
  statusItems: Map<string, HostStatusBarItem>;
  diagnostics: Map<string, HostDiagnostic[]>;
  output: string[];
}

const hosts = new Map<string, HostRecord>();
const languageActivated = new Set<string>();
/** `kind:value` pairs already fired this session, so activation stays idempotent (LA-6). */
const triggerActivated = new Set<string>();
let eagerActivated = false;

// ---------------------------------------------------------------------------
// Renderer notification
// ---------------------------------------------------------------------------
function broadcast(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}

function notifyChanged(): void {
  broadcast(IPC.hostChanged);
}

// ---------------------------------------------------------------------------
// User-facing prompts, answered by the focused window
// ---------------------------------------------------------------------------
interface PendingPrompt {
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const prompts = new Map<number, PendingPrompt>();
let nextPromptId = 1;

/**
 * Ask the user something on an extension's behalf.
 *
 * Routed to the focused window rather than a native dialog for two reasons: a quick pick and
 * an input box have no native equivalent, and a modal native dialog from a background
 * extension would be a way for an extension to seize the user's screen. With no window open
 * the prompt resolves as dismissed, which is a real outcome extensions already handle —
 * inventing an answer would be worse than reporting that nobody answered.
 */
function askUser(
  kind: 'message' | 'quickPick' | 'inputBox',
  extensionId: string,
  displayName: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (target === null || target.webContents.isDestroyed()) return Promise.resolve(null);
  const id = nextPromptId++;
  return new Promise<string | null>((resolvePrompt) => {
    const timer = setTimeout(() => {
      prompts.delete(id);
      resolvePrompt(null);
    }, UI_TIMEOUT_MS);
    prompts.set(id, { resolve: resolvePrompt, timer });
    target.webContents.send(IPC.hostPrompt, { id, kind, extensionId, displayName, ...payload });
  });
}

/** Answer an outstanding prompt. Called from IPC when the renderer replies. */
export function resolveHostPrompt(id: number, value: string | null): void {
  const pending = prompts.get(id);
  if (!pending) return;
  prompts.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(value);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
interface Candidate {
  id: string;
  displayName: string;
  version: string;
  directory: string;
  mainFile: string;
  activationEvents: string[];
}

/**
 * Enabled extensions that ship code, with their entry point resolved and contained.
 *
 * The containment check is not a formality. `main` comes from a manifest a publisher wrote,
 * and an entry point resolving outside its own directory would be a way to make AXIOM
 * execute a file the package does not contain.
 */
async function candidates(workspaceRoot: string | null): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const summary of await listInstalledExtensions(workspaceRoot)) {
    if (!summary.enabled) continue;
    let detail: { manifest: VsCodeManifest; directory: string };
    try {
      detail = await installedExtensionDetail(summary.id, workspaceRoot);
    } catch {
      continue;
    }
    const main = detail.manifest.main;
    if (typeof main !== 'string' || main.length === 0) continue;
    const directory = resolve(detail.directory);
    const mainFile = resolve(directory, main);
    const rel = relative(directory, mainFile);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      log.warn('An extension entry point resolved outside its package and was ignored', {
        id: summary.id,
      });
      continue;
    }
    try {
      const stats = await stat(mainFile);
      if (!stats.isFile()) continue;
    } catch {
      // A manifest naming a file the package does not ship cannot be activated. Reported at
      // activation time rather than here so the user sees it against the extension.
      continue;
    }
    out.push({
      id: summary.id,
      displayName: summary.displayName,
      version: summary.version,
      directory,
      mainFile,
      activationEvents: detail.manifest.activationEvents ?? [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration exposed to extensions
// ---------------------------------------------------------------------------
/**
 * The settings one extension may read.
 *
 * Its own contributed keys plus a small editor set, never the whole settings file. AXIOM's
 * settings hold provider choices, telemetry consent and account preferences; an extension
 * reading `vscode.workspace.getConfiguration()` has no business seeing any of it, and VS
 * Code's own API shape does not require it to.
 */
const SHARED_CONFIGURATION_KEYS = [
  'editor.fontSize',
  'editor.fontFamily',
  'editor.tabSize',
  'editor.insertSpaces',
  'editor.wordWrap',
  'editor.formatOnSave',
  'files.encoding',
  'files.eol',
] as const;

async function configurationFor(extensionId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let settings: Record<string, unknown> = {};
  try {
    settings = (await readSettings()) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  for (const key of SHARED_CONFIGURATION_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  const prefix = `${extensionId.split('.')[1] ?? extensionId}.`;
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(prefix)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persisted extension state
// ---------------------------------------------------------------------------
async function readPersistedState(
  extensionId: string,
  scope: 'global' | 'workspace',
): Promise<Record<string, unknown>> {
  try {
    const file = join(extensionStorageRoot(extensionId, scope), 'state.json');
    const text = await readFile(file, 'utf-8');
    if (text.length > MAX_HOST_STATE_BYTES) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writePersistedState(
  extensionId: string,
  scope: 'global' | 'workspace',
  values: Record<string, unknown>,
): Promise<void> {
  const encoded = JSON.stringify(values);
  if (encoded.length > MAX_HOST_STATE_BYTES) return;
  const root = extensionStorageRoot(extensionId, scope);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'state.json'), encoded, 'utf-8');
}

// ---------------------------------------------------------------------------
// Capability broker
// ---------------------------------------------------------------------------
/**
 * A path an extension asked to touch, authorized the same way a renderer path is.
 *
 * Reusing `assertAuthorizedPath` is the point: extension code is exactly as untrusted as the
 * renderer, so it gets exactly the same containment, trust and canonicalization checks rather
 * than a second, parallel set that could drift out of agreement with the first.
 */
async function authorizedPath(
  raw: unknown,
  options: { allowMissing?: boolean; directory?: boolean } = {},
): Promise<string> {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('A path is required.');
  return assertAuthorizedPath(raw, options);
}

function globToRegExp(pattern: string): RegExp {
  // A deliberately small subset: `**`, `*`, `?` and `{a,b}`. Extensions overwhelmingly use
  // `**/*.ext`, and a partial implementation that is honest about its shape beats pulling in
  // a full matcher for a request that is already bounded to a workspace walk.
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index);
      if (close > index) {
        const options = pattern.slice(index + 1, close).split(',');
        source += `(?:${options.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        index = close;
        continue;
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

async function findFiles(root: string, include: string, maxResults: number): Promise<string[]> {
  const matcher = globToRegExp(include);
  const results: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && results.length < Math.min(maxResults, MAX_FIND_RESULTS)) {
    const directory = queue.shift();
    if (directory === undefined) break;
    if (++visited > MAX_FIND_DIRECTORIES) break;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).replaceAll('\\', '/');
      if (matcher.test(rel)) results.push(full);
      if (results.length >= Math.min(maxResults, MAX_FIND_RESULTS)) break;
    }
  }
  return results;
}

async function handleRequest(
  record: HostRecord,
  kind: HostRequestKind,
  payload: Record<string, unknown>,
): Promise<unknown> {
  // Phase 4: the webview runtime owns its twelve request kinds and keeps its own state. Routed
  // here rather than added to the switch so this function is unchanged for every other kind.
  if (isWebviewRequestKind(kind)) return handleWebviewRequest(record.extensionId, kind, payload);
  // Phase 5: the workbench view runtime owns the tree and context-key kinds, on the same terms.
  if (isViewsRequestKind(kind)) return handleViewsRequest(record.extensionId, kind, payload);
  // Phase 6: the language platform owns provider registration, document sync and workspace edits.
  if (isLanguagesRequestKind(kind)) {
    return handleLanguagesRequest(record.extensionId, kind, payload);
  }
  // Phase 7: four runtimes on the same terms — terminals, tasks, debugging, and file watching with
  // the rest of `workspace.fs`. Each owns its own registry, limits and teardown.
  if (isTerminalsRequestKind(kind)) {
    return handleTerminalsRequest(record.extensionId, kind, payload);
  }
  if (isTasksRequestKind(kind)) return handleTasksRequest(record.extensionId, kind, payload);
  if (isDebugRequestKind(kind)) return handleDebugRequest(record.extensionId, kind, payload);
  if (isFileEventsRequestKind(kind)) {
    return handleFileEventsRequest(record.extensionId, kind, payload);
  }
  switch (kind) {
    case 'window.showMessage': {
      const chosen = await askUser('message', record.extensionId, record.displayName, payload);
      return chosen;
    }
    case 'window.showQuickPick':
      return askUser('quickPick', record.extensionId, record.displayName, payload);
    case 'window.showInputBox':
      return askUser('inputBox', record.extensionId, record.displayName, payload);
    case 'window.setStatusBarItem': {
      if (
        record.statusItems.size >= MAX_HOST_STATUS_ITEMS &&
        !record.statusItems.has(String(payload.id))
      ) {
        throw new Error(`An extension may show at most ${MAX_HOST_STATUS_ITEMS} status bar items.`);
      }
      record.statusItems.set(String(payload.id), {
        extensionId: record.extensionId,
        id: String(payload.id),
        text: String(payload.text ?? ''),
        tooltip: String(payload.tooltip ?? ''),
        command: String(payload.command ?? ''),
        alignment: payload.alignment === 'left' ? 'left' : 'right',
        priority: Number(payload.priority ?? 0),
      });
      notifyChanged();
      return true;
    }
    case 'window.removeStatusBarItem':
      record.statusItems.delete(String(payload.id));
      notifyChanged();
      return true;
    case 'window.appendOutput': {
      const text = String(payload.text ?? '');
      if (text === '\u0000clear') {
        record.output.length = 0;
      } else {
        for (const line of text.split('\n')) {
          if (line.length === 0) continue;
          record.output.push(`[${String(payload.channel)}] ${line}`);
        }
        if (record.output.length > MAX_OUTPUT_LINES) {
          record.output.splice(0, record.output.length - MAX_OUTPUT_LINES);
        }
      }
      notifyChanged();
      return true;
    }
    case 'window.showTextDocument': {
      const target = await authorizedPath(payload.path);
      broadcast(IPC.hostOpenFile, { path: target });
      return true;
    }
    case 'languages.setDiagnostics': {
      const entries = normalizeHostDiagnostics(
        Array.isArray(payload.entries) ? payload.entries : [],
      );
      // Paths are authorized before publishing: a diagnostic is a decoration the editor draws
      // against a file, so an unauthorized path would be a way to name files outside the
      // workspace in the UI.
      const authorized: HostDiagnostic[] = [];
      for (const entry of entries) {
        try {
          authorized.push({
            ...entry,
            path: await authorizedPath(entry.path, { allowMissing: true }),
          });
        } catch {
          continue;
        }
      }
      record.diagnostics.set(String(payload.owner), authorized);
      notifyChanged();
      return true;
    }
    case 'workspace.readFile': {
      const target = await authorizedPath(payload.path);
      const stats = await stat(target);
      if (!stats.isFile()) throw new Error('Not a file.');
      if (stats.size > MAX_HOST_FILE_BYTES) throw new Error('The file is too large to read.');
      return (await readFile(target)).toString('base64');
    }
    case 'workspace.writeFile': {
      const target = await authorizedPath(payload.path, { allowMissing: true });
      const bytes = Buffer.from(String(payload.content), 'base64');
      if (bytes.length > MAX_HOST_FILE_BYTES) throw new Error('The file is too large to write.');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      await appendAudit(
        'extension.host.write',
        `${record.extensionId} wrote ${bytes.length} bytes to ${target}`,
      );
      return true;
    }
    case 'workspace.readDirectory': {
      const target = await authorizedPath(payload.path, { directory: true });
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .slice(0, MAX_FIND_RESULTS)
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 64]);
    }
    case 'workspace.stat': {
      const target = await authorizedPath(payload.path);
      const stats = await stat(target);
      return {
        type: stats.isDirectory() ? 2 : stats.isFile() ? 1 : 64,
        size: stats.size,
        ctime: Math.round(stats.birthtimeMs),
        mtime: Math.round(stats.mtimeMs),
      };
    }
    case 'workspace.createDirectory': {
      const target = await authorizedPath(payload.path, { allowMissing: true, directory: true });
      await mkdir(target, { recursive: true });
      return true;
    }
    case 'workspace.delete': {
      const target = await authorizedPath(payload.path);
      await rm(target, { recursive: payload.recursive === true, force: false });
      await appendAudit('extension.host.delete', `${record.extensionId} deleted ${target}`);
      return true;
    }
    case 'workspace.findFiles': {
      if (record.workspaceRoot === null) return [];
      const root = await authorizedPath(record.workspaceRoot, { directory: true });
      return findFiles(root, String(payload.include), Number(payload.maxResults ?? 500));
    }
    case 'workspace.getConfiguration':
      return configurationFor(record.extensionId);
    case 'commands.execute': {
      const command = String(payload.command);
      const args = Array.isArray(payload.args) ? payload.args : [];
      const owner = ownerOfCommand(command);
      if (owner !== null) return invokeCommand(owner, command, args);
      // AXIOM's own commands live in the renderer, where the command registry is. Forwarding
      // rather than refusing means an extension can drive the workbench, and the renderer
      // remains the one place that decides what a command id means.
      broadcast(IPC.hostWorkbenchCommand, { command, args });
      return undefined;
    }
    case 'commands.registered': {
      const out: string[] = [];
      for (const host of hosts.values()) out.push(...host.commands);
      return out;
    }
    case 'env.clipboardWrite':
      clipboard.writeText(String(payload.text));
      return true;
    case 'env.clipboardRead':
      return clipboard.readText();
    case 'env.openExternal': {
      const url = externalUrlForOpen(String(payload.url), false);
      if (url === null) throw new Error('Only https URLs without credentials can be opened.');
      const { shell } = await import('electron');
      await shell.openExternal(url);
      await appendAudit('extension.host.open-external', `${record.extensionId} opened ${url}`);
      return true;
    }
    case 'env.asExternalUri':
      return mintExternalUri(record.extensionId, String(payload.uri));
    case 'window.registerUriHandler':
      registerExtensionUriHandler(record.extensionId);
      return true;
    case 'authentication.getSession': {
      const session = await getSessionForExtension(
        { extensionId: record.extensionId, displayName: record.displayName },
        {
          providerId: String(payload.providerId),
          scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
          createIfNone: payload.createIfNone === true,
          clearSessionPreference: payload.clearSessionPreference === true,
          forceNewSession: payload.forceNewSession === true,
          silent: payload.silent === true,
        },
      );
      if (session !== null) {
        // Audited without the token: that an extension obtained a credential for a provider is
        // exactly the kind of thing a user should be able to review afterwards.
        await appendAudit(
          'extension.host.auth-session',
          `${record.extensionId} received a ${String(payload.providerId)} session for [${session.scopes.join(' ')}]`,
        );
      }
      return session;
    }
    case 'authentication.removeSession':
      await removeSessionForExtension(
        { extensionId: record.extensionId, displayName: record.displayName },
        String(payload.providerId),
        String(payload.sessionId),
      );
      return true;
    case 'authentication.getAccounts':
      return getAccountsForExtension(String(payload.providerId));
    case 'authentication.registerProvider':
      registerExtensionAuthProvider(record.extensionId, {
        providerId: String(payload.providerId),
        label: String(payload.label),
        supportsMultipleAccounts: payload.supportsMultipleAccounts === true,
      });
      return true;
    case 'authentication.unregisterProvider':
      unregisterExtensionAuthProvider(record.extensionId, String(payload.providerId));
      return true;
    case 'authentication.sessionsChanged':
      notifyProviderSessionsChanged(String(payload.providerId));
      return true;
    case 'secrets.get':
      return readExtensionSecret(record.extensionId, String(payload.key));
    case 'secrets.store': {
      await writeExtensionSecret(record.extensionId, String(payload.key), String(payload.value));
      notifySecretChanged(record, String(payload.key));
      return true;
    }
    case 'secrets.delete': {
      await deleteExtensionSecret(record.extensionId, String(payload.key));
      notifySecretChanged(record, String(payload.key));
      return true;
    }
    default:
      throw new Error(`${String(kind)} is not supported.`);
  }
}
/**
 * Tell an extension one of its own secrets changed.
 *
 * Only its own host is told, because the store is namespaced per extension and no other
 * extension can observe or address the key that moved.
 */
function notifySecretChanged(record: HostRecord, key: string): void {
  if (record.child === null) return;
  record.child.postMessage({ t: 'secretChanged', key } satisfies MainToWorker);
}

// ---------------------------------------------------------------------------
// Authentication and URI wiring
// ---------------------------------------------------------------------------
/**
 * Ask one extension's registered authentication provider to do something.
 *
 * Reuses `pendingInvocations` and the worker's `result` reply — the same mechanism a command
 * invocation uses — rather than a second request/response channel. One id space, one timeout
 * policy, one place where a stopped host rejects everything outstanding.
 */
function callExtensionProvider(
  extensionId: string,
  providerId: string,
  op: 'getSessions' | 'createSession' | 'removeSession',
  scopes: string[],
  sessionId: string | null,
): Promise<unknown> {
  const record = hosts.get(extensionId.toLowerCase());
  if (!record || record.child === null || record.state !== 'active') {
    return Promise.reject(new Error(`The extension providing ${providerId} is not running.`));
  }
  const child = record.child;
  const id = record.nextInvokeId++;
  return new Promise<unknown>((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      record.pendingInvocations.delete(id);
      rejectCall(new Error(`${providerId} did not answer in time.`));
    }, INVOKE_TIMEOUT_MS);
    record.pendingInvocations.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    child.postMessage({
      t: 'provider',
      id,
      providerId,
      op,
      scopes,
      sessionId,
    } satisfies MainToWorker);
  });
}

configureExtensionAuth({
  askUser: (extensionId, message, items) => {
    const record = hosts.get(extensionId.toLowerCase());
    return askUser('message', extensionId, record?.displayName ?? extensionId, {
      message,
      severity: 'warning',
      items,
    });
  },
  callProvider: callExtensionProvider,
  notifySessionsChanged: (providerId) => {
    for (const record of hosts.values()) {
      if (record.state !== 'active' || record.child === null) continue;
      record.child.postMessage({ t: 'sessionsChanged', providerId } satisfies MainToWorker);
    }
  },
  activateProvider: async (providerId) => {
    await activateForTrigger('authentication', providerId, currentWorkspaceRoot());
  },
  runWorkbenchCommand: (command) => {
    broadcast(IPC.hostWorkbenchCommand, { command, args: [] });
  },
});

configureExtensionUri({
  deliverUri: (extensionId, uri) => {
    const record = hosts.get(extensionId.toLowerCase());
    if (!record || record.child === null || record.state !== 'active') return false;
    record.child.postMessage({ t: 'uri', uri } satisfies MainToWorker);
    return true;
  },
  activateForUri: async (extensionId) => {
    await activateForTrigger('uri', extensionId, currentWorkspaceRoot());
  },
});

/**
 * Call into one extension host and await its reply.
 *
 * The generic form of `callExtensionProvider`: same id space, same `pendingInvocations` map,
 * same rejection on teardown. The webview runtime needs it for `resolveWebviewView` and
 * `deserializeWebviewPanel`, both of which are calls that return only when extension code has
 * finished building a document.
 */
function callWorker(
  extensionId: string,
  build: (id: number) => MainToWorker,
  timeoutMs: number,
): Promise<unknown> {
  const record = hosts.get(extensionId.toLowerCase());
  if (!record || record.child === null || record.state !== 'active') {
    return Promise.reject(new Error(`${extensionId} is not running.`));
  }
  const child = record.child;
  const id = record.nextInvokeId++;
  return new Promise<unknown>((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      record.pendingInvocations.delete(id);
      rejectCall(new Error(`${extensionId} did not answer in time.`));
    }, timeoutMs);
    record.pendingInvocations.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    child.postMessage(build(id) satisfies MainToWorker);
  });
}

configureExtensionWebview({
  deliver: (extensionId, message) => {
    const record = hosts.get(extensionId.toLowerCase());
    if (!record || record.child === null || record.state !== 'active') return false;
    record.child.postMessage(message);
    return true;
  },
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.webviewChanged);
  },
  postToFrame: (handle, envelope) => {
    broadcast(IPC.webviewPost, { handle, envelope });
  },
  runCommand: async (command, args) => {
    const owner = ownerOfCommand(command);
    if (owner !== null) {
      await invokeCommand(owner, command, args);
      return;
    }
    // Same fallback as `commands.execute`: a command the renderer owns is run by the renderer.
    broadcast(IPC.hostWorkbenchCommand, { command, args });
  },
  activateForViewType: async (kind, viewType) => {
    await activateForTrigger(kind, viewType, currentWorkspaceRoot());
  },
  extensionDirectory: (extensionId) => hosts.get(extensionId.toLowerCase())?.directory ?? null,
  displayName: (extensionId) => hosts.get(extensionId.toLowerCase())?.displayName ?? extensionId,
  workspaceRoot: () => currentWorkspaceRoot(),
});

/**
 * Command metadata for contributed menus.
 *
 * A menu row shows the title from `contributes.commands`, and `resolveMenu` drops a row whose
 * command was never declared. The map is rebuilt whenever the contributor list is, so it is a
 * synchronous read for every menu resolution afterwards.
 */
const declaredCommands = new Map<string, MenuCommandInfo>();

configureExtensionViews({
  deliver: (extensionId, message) => {
    const record = hosts.get(extensionId.toLowerCase());
    if (!record || record.child === null || record.state !== 'active') return false;
    record.child.postMessage(message);
    return true;
  },
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.viewsChanged);
  },
  runCommand: async (command, args) => {
    const owner = ownerOfCommand(command);
    if (owner !== null) {
      await invokeCommand(owner, command, args);
      return;
    }
    broadcast(IPC.hostWorkbenchCommand, { command, args });
  },
  activateForView: async (viewId) => {
    await activateForTrigger('view', viewId, currentWorkspaceRoot());
  },
  contributors: async () => {
    const installed = await listEnabledExtensionManifests(currentWorkspaceRoot());
    declaredCommands.clear();
    const out: ViewContributor[] = [];
    for (const { manifest, directory } of installed) {
      for (const command of manifest.contributes.commands) {
        if (declaredCommands.has(command.command)) continue;
        declaredCommands.set(command.command, {
          title:
            command.category === undefined
              ? command.title
              : `${command.category}: ${command.title}`,
          icon: null,
          enablement: command.enablement ?? null,
        });
      }
      out.push({
        extensionId: manifest.id,
        displayName: manifest.displayName,
        directory,
        containers: manifest.contributes.viewsContainers,
        views: manifest.contributes.views,
        welcome: manifest.contributes.viewsWelcome,
        menus: manifest.contributes.menus,
        submenus: manifest.contributes.submenus,
      });
    }
    return out;
  },
  commands: () => declaredCommands,
});

configureExtensionLanguages({
  deliver: (extensionId, message) => {
    const record = hosts.get(extensionId.toLowerCase());
    if (!record || record.child === null || record.state !== 'active') return false;
    record.child.postMessage(message);
    return true;
  },
  broadcast: (message) => {
    for (const record of hosts.values()) {
      if (record.child === null || record.state !== 'active') continue;
      record.child.postMessage(message);
    }
  },
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.languagesChanged);
  },
  notifyProviderChanged: (batch) => {
    broadcast(IPC.languagesProviderChanged, batch);
  },
  applyEditInEditor: (payload) => {
    broadcast(IPC.languagesApplyEdit, payload);
  },
  activateForLanguage: async (languageId) => {
    await activateForTrigger('language', languageId, currentWorkspaceRoot());
  },
  workspaceRoots: () => {
    const root = currentWorkspaceRoot();
    return root === null ? [] : [root];
  },
  contributors: async () => {
    const installed = await listEnabledExtensionManifests(currentWorkspaceRoot());
    return installed.map(({ manifest, directory }) => ({
      extensionId: manifest.id,
      directory,
      languages: manifest.contributes.languages,
    }));
  },
  publishedDiagnostics: () => listHostDiagnostics(),
});

// ---------------------------------------------------------------------------
// Phase 7 runtimes
// ---------------------------------------------------------------------------
/** Post to one running host. The single predicate every Phase 7 bridge delivers through. */
function deliverToHost(extensionId: string, message: MainToWorker): boolean {
  const record = hosts.get(extensionId.toLowerCase());
  if (!record || record.child === null || record.state !== 'active') return false;
  record.child.postMessage(message);
  return true;
}

/** Post to every running host. Lifecycle events are observable by every extension, as upstream. */
function broadcastToHosts(message: MainToWorker): void {
  for (const record of hosts.values()) {
    if (record.child === null || record.state !== 'active') continue;
    record.child.postMessage(message);
  }
}

/**
 * The environment a terminal or a task starts from.
 *
 * `buildChildProcessEnvironment` is the same allowlist the extension hosts themselves are spawned
 * with, so a task inherits exactly what an extension already runs with — and nothing an extension
 * could not already read. Undefined values are dropped rather than passed on as the string
 * "undefined", which is what assigning them would do.
 */
function runtimeBaseEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildChildProcessEnvironment())) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function workspaceRootList(): string[] {
  const root = currentWorkspaceRoot();
  return root === null ? [] : [root];
}

/**
 * Where the persistent environment variable collections live.
 *
 * One file for every extension's collections rather than one per extension: the store is serialized
 * as a whole, and a terminal is built from all of them together, so splitting it would only add
 * failure modes. Writes are serialized behind one promise chain so two extensions mutating their
 * collections in the same tick cannot interleave into a truncated file.
 */
function envCollectionPath(): string {
  return join(app.getPath('userData'), 'extension-environments.json');
}

let envCollectionWrite: Promise<void> = Promise.resolve();

function persistEnvCollections(state: Record<string, unknown>): void {
  const encoded = JSON.stringify(state);
  if (encoded.length > MAX_HOST_STATE_BYTES) return;
  envCollectionWrite = envCollectionWrite
    .then(() => writeFile(envCollectionPath(), encoded, 'utf-8'))
    .catch((error: unknown) => {
      log.warn('Could not persist the extension environment collections', {
        error: String(error),
      });
    });
}

/** Rehydrate the persistent collections. Called once, before any host starts. */
export async function restoreExtensionEnvironments(): Promise<void> {
  try {
    const text = await readFile(envCollectionPath(), 'utf-8');
    if (text.length > MAX_HOST_STATE_BYTES) return;
    const restored = restoreEnvironmentCollections(JSON.parse(text) as unknown);
    if (restored > 0) {
      log.info('Restored persistent terminal environment mutations', { mutations: restored });
    }
  } catch {
    // No file yet, or an unreadable one: terminals start from the plain environment.
  }
}

configureExtensionTerminals({
  deliver: deliverToHost,
  broadcast: broadcastToHosts,
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.runtimeTerminalsChanged);
  },
  command: (command) => {
    broadcast(IPC.runtimeTerminalCommand, command);
  },
  workspaceRoots: workspaceRootList,
  baseEnvironment: runtimeBaseEnvironment,
  persistEnvCollections,
});

configureExtensionTasks({
  deliver: deliverToHost,
  broadcast: broadcastToHosts,
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.runtimeTasksChanged);
  },
  output: (executionId, stream, data) => {
    broadcast(IPC.runtimeTaskOutput, { executionId, stream, data });
  },
  workspaceRoots: workspaceRootList,
  baseEnvironment: runtimeBaseEnvironment,
});

configureExtensionDebug({
  deliver: deliverToHost,
  broadcast: broadcastToHosts,
  call: callWorker,
  notifyChanged: () => {
    broadcast(IPC.runtimeDebugChanged);
  },
  console: (sessionId, text) => {
    broadcast(IPC.runtimeDebugConsole, { sessionId, text });
  },
  workspaceRoots: workspaceRootList,
});

configureExtensionFileEvents({
  deliver: deliverToHost,
  broadcast: broadcastToHosts,
  workspaceRoots: workspaceRootList,
});

/**
 * Rebuild the workbench view model.
 *
 * Called after anything that changes which extensions are enabled — an install, an uninstall, an
 * enable, a disable — and once at startup. Cheap enough to call unconditionally: it reads manifests
 * that are already on disk and does not start a host.
 */
export async function syncWorkbenchViews(): Promise<void> {
  try {
    await refreshViewRegistry();
  } catch (error) {
    log.warn('Could not rebuild the workbench view model', { error: String(error) });
  }
}

/**
 * Rebuild the contributed language registry.
 *
 * Kept separate from {@link syncWorkbenchViews} because the two read different parts of the same
 * manifests and either can fail on its own: a malformed `language-configuration.json` must not cost
 * the sidebar its views. Called from the same places, for the same reason — enabling an extension
 * has to make its languages known before a document of that language is opened.
 */
export async function syncLanguageContributions(): Promise<void> {
  try {
    await refreshLanguageContributions();
  } catch (error) {
    log.warn('Could not rebuild the contributed language registry', { error: String(error) });
  }
}

/** Write the workbench's view state now, for quit. */
export async function flushWorkbenchViews(): Promise<void> {
  await flushViewState();
}

/**
 * The workspace the running hosts were started against.
 *
 * Activation needs a root, and the subsystems that arrive here — a redirect from a browser, a
 * provider being asked for a session — have no workspace of their own to pass. Taking it from
 * whatever is already running keeps one answer rather than threading a root through both.
 */
function currentWorkspaceRoot(): string | null {
  for (const record of hosts.values()) {
    if (record.workspaceRoot !== null) return record.workspaceRoot;
  }
  return null;
}

let activeEditor: { path: string; languageId: string } | null = null;

/**
 * Record which file the user is editing, and activate anything waiting on its language.
 *
 * This is the lazy-activation trigger that matters most in practice: a Python extension
 * should start when a Python file is opened and never otherwise.
 */
export function reportActiveEditor(
  path: string | null,
  languageId: string | null,
  workspaceRoot: string | null,
): void {
  activeEditor = path === null ? null : { path, languageId: languageId ?? '' };
  for (const host of hosts.values()) {
    if (host.state === 'active' && host.child) {
      host.child.postMessage({ t: 'editor', editor: activeEditor } as unknown as MainToWorker);
    }
  }
  if (languageId !== null && languageId.length > 0) {
    void activateForLanguage(languageId, workspaceRoot);
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------
function workerEntry(): string {
  return join(app.getAppPath(), 'out', 'main', 'extensionHostWorker.js');
}

function setState(record: HostRecord, state: HostState, detail: string | null): void {
  record.state = state;
  record.detail = detail;
  notifyChanged();
}

function teardown(record: HostRecord): void {
  if (record.readyTimer) clearTimeout(record.readyTimer);
  if (record.restartTimer) clearTimeout(record.restartTimer);
  record.readyTimer = null;
  record.restartTimer = null;
  for (const pending of record.pendingInvocations.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('The extension host stopped.'));
  }
  record.pendingInvocations.clear();
  record.statusItems.clear();
  record.diagnostics.clear();
  record.commands = [];
  record.ready = false;
  // A stopped host has no provider and no URI handler. Leaving either registered would make
  // `getSession` wait on a process that is gone, or route a redirect into nothing.
  clearAuthProvidersForExtension(record.extensionId);
  unregisterExtensionUriHandler(record.extensionId);
  // A webview cannot outlive the code that draws it: the frame would keep running with no host
  // to answer its messages. Panels a serializer owns are written out first, so a restart or a
  // crash restore brings them back rather than losing them.
  disposeWebviewsForExtension(record.extensionId);
  // Same for a tree provider: the view stays in the sidebar (it is declared in the manifest) but its
  // content and the context keys it set are dropped, so nothing keeps drawing stale rows.
  disposeViewsForExtension(record.extensionId);
  // And for a language provider: a hover answered by a process that is gone would hang the editor,
  // so the registrations, the token baselines and the minted results all go with the host.
  disposeLanguagesForExtension(record.extensionId);
  // Phase 7. Everything the extension owned outside its own process goes with it, in the order that
  // leaves nothing running: panes and ptys, then processes, then debug adapters, then the OS watches.
  // A `Pseudoterminal` whose extension is gone would be a pane nothing writes to; a task process would
  // be an orphan; an adapter would hold a port; a watch would hold a descriptor and deliver to nobody.
  disposeTerminalsForExtension(record.extensionId);
  disposeTasksForExtension(record.extensionId);
  disposeDebugForExtension(record.extensionId);
  disposeFileEventsForExtension(record.extensionId);
  const child = record.child;
  record.child = null;
  if (child) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

async function spawnHost(record: HostRecord, reason: string): Promise<void> {
  const [globalState, workspaceState] = await Promise.all([
    readPersistedState(record.extensionId, 'global'),
    readPersistedState(record.extensionId, 'workspace'),
  ]);
  const storage = extensionStorageRoot(record.extensionId, 'global');
  const workspaceStorage = extensionStorageRoot(record.extensionId, 'workspace');
  const logs = extensionStorageRoot(record.extensionId, 'logs');
  await Promise.all([
    mkdir(storage, { recursive: true }),
    mkdir(workspaceStorage, { recursive: true }),
    mkdir(logs, { recursive: true }),
  ]);

  setState(record, 'starting', null);
  const child = utilityProcess.fork(workerEntry(), [], {
    serviceName: `axiom-extension-${record.extensionId}`,
    cwd: record.directory,
    env: buildChildProcessEnvironment(),
    stdio: 'pipe',
  });
  record.child = child;

  child.stdout?.on('data', (chunk: Buffer) => appendOutput(record, chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput(record, chunk.toString('utf8')));

  child.on('message', (raw: unknown) => {
    const message = parseWorkerMessage(raw);
    if (message === null) return;
    void onWorkerMessage(record, message);
  });

  child.on('exit', (code: number) => {
    if (record.child !== child) return;
    onExit(record, code);
  });

  record.readyTimer = setTimeout(() => {
    if (record.ready) return;
    log.warn('An extension host did not start in time', { id: record.extensionId });
    teardown(record);
    setState(record, 'failed', 'The extension did not start in time.');
  }, READY_TIMEOUT_MS);

  child.postMessage({
    t: 'init',
    version: HOST_PROTOCOL_VERSION,
    extensionId: record.extensionId,
    extensionPath: record.directory,
    mainFile: record.mainFile,
    displayName: record.displayName,
    version_: record.version,
    workspaceRoot: record.workspaceRoot,
    globalStoragePath: storage,
    workspaceStoragePath: workspaceStorage,
    logPath: logs,
    configuration: await configurationFor(record.extensionId),
    globalState,
    workspaceState,
  } satisfies MainToWorker);
  child.postMessage({ t: 'activate', reason } satisfies MainToWorker);
}

function appendOutput(record: HostRecord, text: string): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    record.output.push(trimmed.slice(0, 2_000));
  }
  if (record.output.length > MAX_OUTPUT_LINES) {
    record.output.splice(0, record.output.length - MAX_OUTPUT_LINES);
  }
}

async function onWorkerMessage(
  record: HostRecord,
  message: ReturnType<typeof parseWorkerMessage>,
): Promise<void> {
  if (message === null) return;
  switch (message.t) {
    case 'ready': {
      if (message.version !== HOST_PROTOCOL_VERSION) {
        teardown(record);
        setState(record, 'failed', 'The extension host protocol version did not match.');
        return;
      }
      record.ready = true;
      if (record.readyTimer) clearTimeout(record.readyTimer);
      record.readyTimer = null;
      return;
    }
    case 'activated':
      record.commands = message.commands;
      record.activationMs = message.ms;
      setState(record, 'active', null);
      // A host that has just started holds no documents. Anything the editor already has open has to
      // reach it now, or its first provider call is refused for a document it was never told about.
      seedDocumentsForExtension(record.extensionId);
      return;
    case 'failed':
      log.warn('An extension failed', {
        id: record.extensionId,
        phase: message.phase,
        reason: message.message,
      });
      appendOutput(record, `[${message.phase} error] ${message.message}`);
      if (message.stack) appendOutput(record, message.stack);
      setState(record, 'failed', message.message);
      return;
    case 'commands':
      record.commands = message.commands;
      notifyChanged();
      return;
    case 'request': {
      const validated = validateHostRequest(message.kind, message.payload);
      if (!validated.ok) {
        record.child?.postMessage({
          t: 'reply',
          id: message.id,
          ok: false,
          error: validated.error,
        } satisfies MainToWorker);
        return;
      }
      try {
        const value = await handleRequest(record, message.kind, validated.payload);
        record.child?.postMessage({
          t: 'reply',
          id: message.id,
          ok: true,
          value: value === undefined ? null : value,
        } satisfies MainToWorker);
      } catch (error) {
        record.child?.postMessage({
          t: 'reply',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies MainToWorker);
      }
      return;
    }
    case 'result': {
      const pending = record.pendingInvocations.get(message.id);
      if (!pending) return;
      record.pendingInvocations.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      return;
    }
    case 'log':
      appendOutput(record, `[${message.level}] ${message.message}`);
      return;
    case 'state':
      await writePersistedState(record.extensionId, message.scope, message.values);
      return;
    case 'deactivated':
      teardown(record);
      setState(record, 'inactive', null);
      return;
    default:
      return;
  }
}

/**
 * React to a host process that ended.
 *
 * A clean exit after `deactivate` is not a crash. Anything else is, and the response comes
 * from the pure crash policy so that "three strikes inside three minutes" is a rule with one
 * definition rather than a condition scattered through this function.
 */
function onExit(record: HostRecord, code: number): void {
  const wasActive = record.state === 'active' || record.state === 'starting';
  teardown(record);
  if (!wasActive) {
    setState(record, 'inactive', null);
    return;
  }
  const now = Date.now();
  const decision = decideCrashResponse(pruneCrashTimes(record.crashTimes, now), now);
  record.crashTimes = [...pruneCrashTimes(record.crashTimes, now), now];
  void appendAudit(
    'extension.host.crash',
    `${record.extensionId} exited with code ${code} (${decision.recentCrashes} recent)`,
  );
  if (decision.restart) {
    setState(
      record,
      'crashed',
      `The extension crashed (exit ${code}). Restarting attempt ${decision.recentCrashes}.`,
    );
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      void spawnHost(record, 'restart-after-crash').catch((error: unknown) => {
        setState(record, 'failed', error instanceof Error ? error.message : String(error));
      });
    }, decision.delayMs);
    return;
  }
  setState(
    record,
    'disabled-after-crashes',
    `The extension crashed ${decision.recentCrashes} times. AXIOM stopped restarting it.`,
  );
  broadcast(IPC.hostCrashLoop, {
    extensionId: record.extensionId,
    displayName: record.displayName,
    crashes: decision.recentCrashes,
  });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
function recordFor(candidate: Candidate, workspaceRoot: string | null): HostRecord {
  const existing = hosts.get(candidate.id);
  if (existing) {
    existing.displayName = candidate.displayName;
    existing.directory = candidate.directory;
    existing.mainFile = candidate.mainFile;
    existing.activationEvents = candidate.activationEvents;
    existing.workspaceRoot = workspaceRoot;
    return existing;
  }
  const created: HostRecord = {
    extensionId: candidate.id,
    displayName: candidate.displayName,
    version: candidate.version,
    directory: candidate.directory,
    mainFile: candidate.mainFile,
    activationEvents: candidate.activationEvents,
    child: null,
    state: 'inactive',
    detail: null,
    commands: [],
    activationMs: null,
    crashTimes: [],
    workspaceRoot,
    ready: false,
    readyTimer: null,
    restartTimer: null,
    pendingInvocations: new Map(),
    nextInvokeId: 1,
    statusItems: new Map(),
    diagnostics: new Map(),
    output: [],
  };
  hosts.set(candidate.id, created);
  return created;
}

/**
 * Start one extension, asking for consent the first time.
 *
 * Consent is requested here rather than at install time on purpose: installing a package is
 * not the moment a user is deciding to run code, and asking then would train them to click
 * through it. Asking when something actually wants to activate puts the question next to the
 * reason for it.
 */
async function ensureStarted(record: HostRecord, reason: string): Promise<boolean> {
  if (record.state === 'active') return true;
  if (record.state === 'starting') return true;
  if (record.state === 'disabled-after-crashes') return false;

  const consent = await readHostConsent(record.extensionId);
  if (consent === 'denied') {
    setState(record, 'inactive', 'Running this extension\u2019s code was declined.');
    return false;
  }
  if (consent === 'unset') {
    const answer = await askUser('message', record.extensionId, record.displayName, {
      message: `${record.displayName} wants to run its own code. Extension code runs as a separate process with your user account\u2019s full privileges — it can read and write your files and reach the network. Only allow extensions you trust.`,
      severity: 'warning',
      items: ['Allow', 'Never allow'],
    });
    if (answer !== 'Allow') {
      await writeHostConsent(record.extensionId, answer === 'Never allow' ? 'denied' : 'unset');
      setState(record, 'inactive', 'Waiting for permission to run this extension\u2019s code.');
      return false;
    }
    await writeHostConsent(record.extensionId, 'granted');
  }

  try {
    await spawnHost(record, reason);
    return true;
  } catch (error) {
    setState(record, 'failed', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Activate everything that asked for startup activation. Called once per session. */
export async function activateEagerExtensions(workspaceRoot: string | null): Promise<void> {
  if (eagerActivated) return;
  eagerActivated = true;
  for (const candidate of await candidates(workspaceRoot)) {
    if (!activatesEagerly(candidate.activationEvents)) continue;
    await ensureStarted(recordFor(candidate, workspaceRoot), 'startup');
  }
  // `workspaceContains:` is a startup trigger in upstream too: the workspace is known, so
  // the answer cannot change until it is reopened. Deliberately after the eager pass, so a
  // slow directory scan never delays an extension that asked for `onStartupFinished`.
  await activateForWorkspaceContents(workspaceRoot);
}

/** Activate anything waiting for a language, once per language per session. */
export async function activateForLanguage(
  languageId: string,
  workspaceRoot: string | null,
): Promise<void> {
  if (languageActivated.has(languageId)) return;
  languageActivated.add(languageId);
  for (const candidate of await candidates(workspaceRoot)) {
    if (!activationLanguages(candidate.activationEvents).includes(languageId)) continue;
    await ensureStarted(recordFor(candidate, workspaceRoot), `onLanguage:${languageId}`);
  }
}

/**
 * Activate everything waiting for one trigger.
 *
 * This is the single path every non-startup, non-command trigger goes through — a view being
 * revealed, a debug session starting, a deep link arriving, a task type being resolved, an
 * authentication provider being asked for a session. Each subsystem reports *what happened*
 * and this decides who cares, which is the only arrangement that keeps activation lazy: no
 * caller has to know which extensions exist, and no extension starts because some unrelated
 * surface was touched.
 *
 * Each `kind:value` pair fires at most once per session. Activation is idempotent (LA-6) and
 * a second pass would re-ask consent and re-register commands for anything already running.
 */
export async function activateForTrigger(
  kind: Exclude<ActivationEventKind, 'unknown' | 'startup'>,
  value: string | null,
  workspaceRoot: string | null,
): Promise<string[]> {
  const key = `${kind}:${value ?? ''}`;
  if (triggerActivated.has(key)) return [];
  triggerActivated.add(key);
  const trigger: ActivationTrigger =
    value === null || value.length === 0 ? { kind } : { kind, value };
  const started: string[] = [];
  for (const candidate of await candidates(workspaceRoot)) {
    if (hosts.get(candidate.id)?.state === 'active') continue;
    if (!candidate.activationEvents.some((event) => activationMatches(event, trigger))) continue;
    if (await ensureStarted(recordFor(candidate, workspaceRoot), key)) started.push(candidate.id);
  }
  return started;
}

/**
 * Fire `workspaceContains:` for the workspace as it is now.
 *
 * The scan is bounded twice over — by the shared find budget and by skipping the same
 * directories the finder skips — because this runs at every launch and an unbounded walk of
 * a large monorepo at startup is exactly the cost lazy activation exists to avoid. A
 * declared pattern with no glob character is checked as a path directly, so the common case
 * (`workspaceContains:package.json`) costs one `stat` rather than a walk.
 */
export async function activateForWorkspaceContents(workspaceRoot: string | null): Promise<void> {
  if (workspaceRoot === null) return;
  const declared = new Set<string>();
  for (const candidate of await candidates(workspaceRoot)) {
    for (const pattern of activationWorkspaceFiles(candidate.activationEvents)) {
      declared.add(pattern);
    }
  }
  if (declared.size === 0) return;

  const direct: string[] = [];
  const globbed: string[] = [];
  for (const pattern of declared) {
    (/[*?{}[\]]/.test(pattern) ? globbed : direct).push(pattern);
  }

  const found: string[] = [];
  for (const pattern of direct) {
    const target = resolve(workspaceRoot, pattern);
    const rel = relative(workspaceRoot, target);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      await stat(target);
      found.push(pattern);
    } catch {
      // Not present, which is the whole point of the check.
    }
  }
  if (globbed.length > 0) {
    for (const path of await listWorkspacePaths(workspaceRoot)) {
      for (const pattern of globbed) {
        if (!found.includes(pattern) && matchesVsCodeGlob(pattern, path)) found.push(pattern);
      }
    }
  }
  for (const pattern of found) {
    await activateForTrigger('workspaceContains', pattern, workspaceRoot);
  }
}

/**
 * Workspace-relative paths, bounded, for glob-shaped `workspaceContains:` patterns.
 *
 * Reuses the finder's own skip list and budgets rather than introducing a second traversal
 * policy: whatever `findFiles` is willing to walk for an extension is what activation walks.
 */
async function listWorkspacePaths(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  let directories = 0;
  while (queue.length > 0 && out.length < MAX_FIND_RESULTS && directories < MAX_FIND_DIRECTORIES) {
    const current = queue.shift();
    if (current === undefined) break;
    directories += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(relative(root, full).split('\\').join('/'));
      if (out.length >= MAX_FIND_RESULTS) break;
    }
  }
  return out;
}

function ownerOfCommand(command: string): HostRecord | null {
  for (const record of hosts.values()) {
    if (record.commands.includes(command)) return record;
  }
  return null;
}

function invokeCommand(record: HostRecord, command: string, args: unknown[]): Promise<unknown> {
  const child = record.child;
  if (child === null || record.state !== 'active') {
    return Promise.reject(new Error(`${record.displayName} is not running.`));
  }
  const id = record.nextInvokeId++;
  return new Promise<unknown>((resolveInvoke, rejectInvoke) => {
    const timer = setTimeout(() => {
      record.pendingInvocations.delete(id);
      rejectInvoke(new Error(`${command} did not finish in time.`));
    }, INVOKE_TIMEOUT_MS);
    record.pendingInvocations.set(id, { resolve: resolveInvoke, reject: rejectInvoke, timer });
    child.postMessage({ t: 'invoke', id, command, args } satisfies MainToWorker);
  });
}

/**
 * Run a command an extension contributed, activating its extension if needed.
 *
 * This is the `onCommand:` activation path: the palette lists a command an extension
 * declared, the user picks it, and only then does the extension start. It is also the only
 * way a command reaches extension code — the renderer never holds a handle to a host.
 */
export async function runExtensionCommand(
  command: string,
  args: unknown[],
  workspaceRoot: string | null,
): Promise<unknown> {
  const running = ownerOfCommand(command);
  if (running !== null) return invokeCommand(running, command, args);
  for (const candidate of await candidates(workspaceRoot)) {
    const declares = candidate.activationEvents.some((event) =>
      activationMatches(event, { kind: 'command', value: command }),
    );
    if (!declares) continue;
    const record = recordFor(candidate, workspaceRoot);
    if (!(await ensureStarted(record, `onCommand:${command}`))) {
      throw new Error(`${record.displayName} could not be started.`);
    }
    // The host publishes its command list as part of activating, so by here the command is
    // either registered or the extension did not do what its manifest said it would.
    if (!record.commands.includes(command)) {
      throw new Error(`${record.displayName} did not register ${command}.`);
    }
    return invokeCommand(record, command, args);
  }
  throw new Error(`No installed extension provides ${command}.`);
}

/** Stop one extension's host without changing its consent. */
export async function stopExtensionHost(extensionId: string): Promise<void> {
  const record = hosts.get(extensionId.toLowerCase());
  if (!record) return;
  const child = record.child;
  if (child && record.state === 'active') {
    child.postMessage({ t: 'deactivate' } satisfies MainToWorker);
    // Give deactivate a moment to run its own cleanup before the process is taken away.
    await new Promise((done) => setTimeout(done, 250));
  }
  teardown(record);
  setState(record, 'inactive', null);
}

/** Stop every host. Used on workspace change and shutdown. */
export async function stopAllExtensionHosts(): Promise<void> {
  for (const id of [...hosts.keys()]) await stopExtensionHost(id);
  eagerActivated = false;
  languageActivated.clear();
  triggerActivated.clear();
  resetExtensionAuthState();
  resetExtensionUriState();
  // The workspace may be a different folder when hosts start again, and a parsed `tasks.json` is
  // keyed by root: dropping the cache here is what keeps `fetchTasks` from answering for the folder
  // that was open before.
  invalidateWorkspaceTasks();
}

/** Record a consent decision and act on it immediately. */
export async function setExtensionHostConsent(
  extensionId: string,
  granted: boolean,
  workspaceRoot: string | null,
): Promise<void> {
  await writeHostConsent(extensionId, granted ? 'granted' : 'denied');
  if (!granted) {
    await stopExtensionHost(extensionId);
    return;
  }
  const record = hosts.get(extensionId.toLowerCase());
  if (record) {
    // A user who just granted permission expects the crash counter to start over.
    record.crashTimes = [];
    if (record.state === 'disabled-after-crashes') setState(record, 'inactive', null);
    await ensureStarted(record, 'consent-granted');
    return;
  }
  for (const candidate of await candidates(workspaceRoot)) {
    if (candidate.id !== extensionId.toLowerCase()) continue;
    await ensureStarted(recordFor(candidate, workspaceRoot), 'consent-granted');
  }
}

/** Forget a crash loop and try again. */
export async function restartExtensionHost(extensionId: string): Promise<void> {
  const record = hosts.get(extensionId.toLowerCase());
  if (!record) return;
  teardown(record);
  record.crashTimes = [];
  setState(record, 'inactive', null);
  await ensureStarted(record, 'manual-restart');
}

// ---------------------------------------------------------------------------
// What the UI and the model read
// ---------------------------------------------------------------------------
export async function listExtensionHosts(workspaceRoot: string | null): Promise<HostStatus[]> {
  const out: HostStatus[] = [];
  const seen = new Set<string>();
  for (const record of hosts.values()) {
    seen.add(record.extensionId);
    out.push({
      extensionId: record.extensionId,
      displayName: record.displayName,
      state: record.state,
      commands: [...record.commands],
      recentCrashes: pruneCrashTimes(record.crashTimes, Date.now()).length,
      detail: record.detail,
      activationMs: record.activationMs,
    });
  }
  // Extensions that ship code but have not been asked about yet still belong in the list:
  // "installed, has code, waiting for permission" is the state a user needs to see to act.
  for (const candidate of await candidates(workspaceRoot)) {
    if (seen.has(candidate.id)) continue;
    const consent = await readHostConsent(candidate.id);
    out.push({
      extensionId: candidate.id,
      displayName: candidate.displayName,
      state: 'inactive',
      commands: [],
      recentCrashes: 0,
      detail:
        consent === 'denied'
          ? 'Running this extension\u2019s code was declined.'
          : consent === 'granted'
            ? 'Not activated yet.'
            : 'Waiting for permission to run this extension\u2019s code.',
      activationMs: null,
    });
  }
  return out.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function listHostStatusBarItems(): HostStatusBarItem[] {
  const out: HostStatusBarItem[] = [];
  for (const record of hosts.values()) {
    if (record.state !== 'active') continue;
    out.push(...record.statusItems.values());
  }
  return out.sort((left, right) => right.priority - left.priority);
}

export function listHostDiagnostics(): Array<{ owner: string; diagnostics: HostDiagnostic[] }> {
  const out: Array<{ owner: string; diagnostics: HostDiagnostic[] }> = [];
  for (const record of hosts.values()) {
    for (const [owner, diagnostics] of record.diagnostics) {
      out.push({ owner: `${record.extensionId}/${owner}`, diagnostics });
    }
  }
  return out;
}

export function readHostOutput(extensionId: string): string[] {
  return [...(hosts.get(extensionId.toLowerCase())?.output ?? [])];
}

/** Commands extension hosts can actually run right now, for the palette and the model. */
export function liveHostCommands(): Array<{ extensionId: string; command: string }> {
  const out: Array<{ extensionId: string; command: string }> = [];
  for (const record of hosts.values()) {
    if (record.state !== 'active') continue;
    for (const command of record.commands) out.push({ extensionId: record.extensionId, command });
  }
  return out;
}

/** Push new settings into every running host. */
export async function refreshHostConfiguration(): Promise<void> {
  for (const record of hosts.values()) {
    if (record.state !== 'active' || record.child === null) continue;
    record.child.postMessage({
      t: 'configuration',
      configuration: await configurationFor(record.extensionId),
    } satisfies MainToWorker);
  }
}
