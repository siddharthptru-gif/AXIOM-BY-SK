import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { rootLogger } from '@axiom/shared';
import type {
  PreviewConsoleEntry,
  PreviewElementSelection,
  PreviewOpenInput,
  PreviewRuntimeError,
  PreviewSnapshot,
} from '../../common/godMode';
import { isSafePreviewUrl } from '../../common/godMode';
import { terminateProcessTree } from './processTree';
import { buildChildProcessEnvironment } from './processEnvironment';

const log = rootLogger.child('preview');
const MAX_CONSOLE_ENTRIES = 300;
const MAX_RUNTIME_ERRORS = 100;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_COMMAND_CHARS = 2_000;
const MAX_SCREENSHOT_DATA_URL = 8 * 1024 * 1024;
const SELECTION_TIMEOUT_MS = 30_000;

interface PreviewRecord {
  ownerId: number;
  window: BrowserWindow;
  previewSession: Session;
  child: ChildProcess | null;
  snapshot: PreviewSnapshot;
}

const previews = new Map<number, PreviewRecord>();
const previewSessions = new Set<Session>();

function sanitizeText(value: unknown, max = MAX_MESSAGE_CHARS): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(?:https?:\/\/)?[^\s/@]+:[^\s/@]+@/gi, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/([?&](?:access[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|signature)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function snapshotOf(record: PreviewRecord): PreviewSnapshot {
  return {
    ...record.snapshot,
    console: record.snapshot.console.map((entry) => ({ ...entry })),
    runtimeErrors: record.snapshot.runtimeErrors.map((entry) => ({ ...entry })),
    selectedElement: record.snapshot.selectedElement
      ? {
          ...record.snapshot.selectedElement,
          classes: [...record.snapshot.selectedElement.classes],
          rect: { ...record.snapshot.selectedElement.rect },
        }
      : null,
  };
}

function update(record: PreviewRecord, patch: Partial<PreviewSnapshot>): void {
  record.snapshot = { ...record.snapshot, ...patch, updatedAt: Date.now() };
}

function consoleLevel(level: number): PreviewConsoleEntry['level'] {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 0) return 'debug';
  return 'info';
}

function isSamePreviewOrigin(record: PreviewRecord, rawUrl: string): boolean {
  try {
    const next = new URL(rawUrl);
    return next.origin === record.snapshot.origin && !next.username && !next.password;
  } catch {
    return false;
  }
}

function appendConsole(record: PreviewRecord, entry: PreviewConsoleEntry): void {
  const console = [...record.snapshot.console, entry].slice(-MAX_CONSOLE_ENTRIES);
  update(record, { console });
}

function appendRuntimeError(record: PreviewRecord, entry: PreviewRuntimeError): void {
  const runtimeErrors = [...record.snapshot.runtimeErrors, entry].slice(-MAX_RUNTIME_ERRORS);
  update(record, { runtimeErrors });
}

function bindPreviewWindow(record: PreviewRecord): void {
  const contents = record.window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isSamePreviewOrigin(record, url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isSamePreviewOrigin(record, url)) event.preventDefault();
  });
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    const safe = sanitizeText(message);
    if (!safe) return;
    const entry: PreviewConsoleEntry = {
      level: consoleLevel(level),
      message: safe,
      source: sanitizeText(sourceId, 500),
      line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
      at: Date.now(),
    };
    appendConsole(record, entry);
    if (entry.level === 'error') {
      appendRuntimeError(record, {
        message: entry.message,
        source: entry.source,
        line: entry.line,
        column: 0,
        at: entry.at,
      });
    }
  });
  contents.on('page-title-updated', (_event, title) => update(record, { title: sanitizeText(title, 200) }));
  contents.on('did-start-loading', () => update(record, { phase: 'loading', error: null }));
  contents.on('did-finish-load', () => {
    if (!contents.isDestroyed()) update(record, { phase: 'ready', url: contents.getURL() });
  });
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    update(record, {
      phase: 'error',
      url: sanitizeText(validatedUrl, 2_000) || record.snapshot.url,
      error: sanitizeText(description) || `Preview failed to load (${code}).`,
    });
  });
  contents.on('render-process-gone', (_event, details) => {
    update(record, {
      phase: 'error',
      error: `Preview renderer stopped: ${sanitizeText(details.reason, 200)}.`,
    });
  });
  record.window.on('closed', () => {
    if (previews.get(record.ownerId) === record) previews.delete(record.ownerId);
    previewSessions.delete(record.previewSession);
    if (record.child) void terminateProcessTree(record.child).catch(() => undefined);
  });
}

function spawnLaunchCommand(root: string, rawCommand: string): ChildProcess {
  const command = rawCommand.replace(/\0/g, '').trim().slice(0, MAX_COMMAND_CHARS);
  if (!command) throw new Error('Enter an application launch command.');
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  const child = spawn(shell, args, {
    cwd: root,
    env: buildChildProcessEnvironment({ ci: true, color: false }),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function closeRecord(record: PreviewRecord): Promise<void> {
  if (!record.window.isDestroyed()) record.window.destroy();
  if (record.child) {
    const child = record.child;
    record.child = null;
    await terminateProcessTree(child).catch((error: unknown) => {
      log.warn('Preview child cleanup failed', {
        reason: error instanceof Error ? sanitizeText(error.message) : 'unknown',
      });
    });
  }
  previewSessions.delete(record.previewSession);
  if (previews.get(record.ownerId) === record) previews.delete(record.ownerId);
}

export function isManagedPreviewWebContents(contents: WebContents): boolean {
  return previewSessions.has(contents.session);
}

export async function openPreview(
  owner: WebContents,
  parent: BrowserWindow | null,
  input: PreviewOpenInput,
): Promise<PreviewSnapshot> {
  if (!isSafePreviewUrl(input.url, false)) {
    throw new Error('Preview URLs must use HTTP(S) on localhost or a loopback address.');
  }
  const existing = previews.get(owner.id);
  if (existing) await closeRecord(existing);

  const parsed = new URL(input.url);
  const id = randomUUID();
  const partition = `axiom-preview-${id}`;
  const previewSession = session.fromPartition(partition, { cache: false });
  previewSessions.add(previewSession);
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.setDevicePermissionHandler(() => false);
  previewSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  previewSession.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  previewSession.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  previewSession.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  previewSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      const requested = new URL(details.url);
      const networkProtocol = ['http:', 'https:', 'ws:', 'wss:'].includes(requested.protocol);
      const expectedProtocols =
        parsed.protocol === 'https:' ? new Set(['https:', 'wss:']) : new Set(['http:', 'ws:']);
      const embeddedProtocol = ['data:', 'blob:', 'about:'].includes(requested.protocol);
      const sameEndpoint =
        embeddedProtocol ||
        (networkProtocol &&
          expectedProtocols.has(requested.protocol) &&
          requested.hostname.toLowerCase() === parsed.hostname.toLowerCase() &&
          requested.port === parsed.port &&
          !requested.username &&
          !requested.password);
      callback({ cancel: !sameEndpoint });
    } catch {
      callback({ cancel: true });
    }
  });
  previewSession.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });

  let child: ChildProcess | null = null;
  const launchCommand = typeof input.launchCommand === 'string' ? input.launchCommand.trim() : '';
  if (launchCommand && input.confirmation !== true) {
    previewSessions.delete(previewSession);
    throw new Error('Launching a workspace command requires explicit confirmation.');
  }

  const now = Date.now();
  let window: BrowserWindow;
  try {
    window = new BrowserWindow({
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    title: 'Axiom Application Preview',
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      session: previewSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: false,
      navigateOnDragDrop: false,
    },
    });
  } catch (error) {
    previewSessions.delete(previewSession);
    throw new Error(
      error instanceof Error ? sanitizeText(error.message) : 'Preview window could not be created.',
    );
  }
  if (launchCommand) {
    try {
      child = spawnLaunchCommand(input.root, launchCommand);
    } catch (error) {
      window.destroy();
      previewSessions.delete(previewSession);
      throw new Error(
        error instanceof Error ? sanitizeText(error.message) : 'Preview command could not start.',
      );
    }
  }
  const record: PreviewRecord = {
    ownerId: owner.id,
    window,
    previewSession,
    child,
    snapshot: {
      id,
      root: input.root,
      url: parsed.toString(),
      origin: parsed.origin,
      phase: launchCommand ? 'launching' : 'loading',
      title: 'Axiom Application Preview',
      startedAt: now,
      updatedAt: now,
      launchCommand: launchCommand || null,
      launchPid: child?.pid ?? null,
      console: [],
      runtimeErrors: [],
      selectedElement: null,
      screenshotDataUrl: null,
      error: null,
    },
  };
  previews.set(owner.id, record);
  bindPreviewWindow(record);
  owner.once('destroyed', () => void closeRecord(record));
  child?.once('error', (error) => {
    if (previews.get(owner.id) !== record) return;
    update(record, { phase: 'error', error: sanitizeText(error.message) });
  });
  child?.once('exit', (code, signal) => {
    if (previews.get(owner.id) !== record || record.child !== child) return;
    record.child = null;
    update(record, {
      launchPid: null,
      ...(code && code !== 0
        ? { error: `Preview command exited with code ${code}${signal ? ` (${signal})` : ''}.` }
        : {}),
    });
  });

  try {
    await window.loadURL(parsed.toString());
  } catch (error) {
    await closeRecord(record);
    throw new Error(
      error instanceof Error ? sanitizeText(error.message) : 'Preview failed to load.',
    );
  }
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
  }
  return snapshotOf(record);
}

function previewRootKey(root: string): string {
  const canonical = resolve(root);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function previewForRoot(ownerId: number, root: string): PreviewRecord {
  const record = previews.get(ownerId);
  if (!record || record.window.isDestroyed()) throw new Error('No preview is open.');
  if (previewRootKey(record.snapshot.root) !== previewRootKey(root)) {
    throw new Error('The open preview belongs to a different workspace.');
  }
  return record;
}

export async function getPreview(
  ownerId: number,
  root: string,
): Promise<PreviewSnapshot | null> {
  const record = previews.get(ownerId);
  if (!record) return null;
  if (previewRootKey(record.snapshot.root) !== previewRootKey(root)) {
    await closeRecord(record);
    return null;
  }
  return snapshotOf(record);
}

export async function closePreview(ownerId: number, root: string): Promise<void> {
  const record = previews.get(ownerId);
  if (!record) return;
  if (previewRootKey(record.snapshot.root) !== previewRootKey(root)) {
    throw new Error('The open preview belongs to a different workspace.');
  }
  await closeRecord(record);
}

export async function refreshPreview(ownerId: number, root: string): Promise<PreviewSnapshot> {
  const record = previewForRoot(ownerId, root);
  record.window.webContents.reloadIgnoringCache();
  update(record, { phase: 'loading', screenshotDataUrl: null, selectedElement: null, error: null });
  return snapshotOf(record);
}

export async function capturePreview(ownerId: number, root: string): Promise<PreviewSnapshot> {
  const record = previewForRoot(ownerId, root);
  const image = await record.window.webContents.capturePage();
  const dataUrl = image.toDataURL();
  if (dataUrl.length > MAX_SCREENSHOT_DATA_URL) {
    throw new Error('Preview screenshot exceeded the 8 MiB transfer limit.');
  }
  update(record, { screenshotDataUrl: dataUrl });
  return snapshotOf(record);
}

const SELECTION_SCRIPT = `(() => new Promise((resolve) => {
  const deadline = setTimeout(() => { cleanup(); resolve(null); }, ${SELECTION_TIMEOUT_MS});
  const priorCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = 'crosshair';
  const text = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const selector = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList || []).slice(0, 2);
      if (classes.length) part += classes.map((name) => '.' + CSS.escape(name)).join('');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ').slice(0, 500);
  };
  const cleanup = () => {
    clearTimeout(deadline);
    document.removeEventListener('click', pick, true);
    document.documentElement.style.cursor = priorCursor;
  };
  const pick = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const el = event.target instanceof Element ? event.target : null;
    if (!el) { cleanup(); resolve(null); return; }
    const rect = el.getBoundingClientRect();
    const result = {
      tag: text(el.tagName.toLowerCase(), 80),
      id: el.id ? text(el.id, 200) : null,
      classes: Array.from(el.classList || []).slice(0, 20).map((name) => text(name, 100)),
      text: text(el.textContent, 500),
      ariaLabel: el.getAttribute('aria-label') ? text(el.getAttribute('aria-label'), 300) : null,
      role: el.getAttribute('role') ? text(el.getAttribute('role'), 100) : null,
      selector: selector(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      at: Date.now(),
    };
    cleanup();
    resolve(result);
  };
  document.addEventListener('click', pick, true);
}))()`;

function selectionOf(value: unknown): PreviewElementSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rectRaw = record.rect as Record<string, unknown> | undefined;
  const number = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) ? Math.round(input * 100) / 100 : 0;
  return {
    tag: sanitizeText(record.tag, 80),
    id: typeof record.id === 'string' ? sanitizeText(record.id, 200) : null,
    classes: Array.isArray(record.classes)
      ? record.classes.map((item) => sanitizeText(item, 100)).filter(Boolean).slice(0, 20)
      : [],
    text: sanitizeText(record.text, 500),
    ariaLabel:
      typeof record.ariaLabel === 'string' ? sanitizeText(record.ariaLabel, 300) : null,
    role: typeof record.role === 'string' ? sanitizeText(record.role, 100) : null,
    selector: sanitizeText(record.selector, 500),
    rect: {
      x: number(rectRaw?.x),
      y: number(rectRaw?.y),
      width: number(rectRaw?.width),
      height: number(rectRaw?.height),
    },
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
  };
}

export async function selectPreviewElement(
  ownerId: number,
  root: string,
): Promise<PreviewSnapshot> {
  const record = previewForRoot(ownerId, root);
  if (record.snapshot.phase !== 'ready') throw new Error('Wait for the preview to finish loading.');
  const selected = selectionOf(await record.window.webContents.executeJavaScript(SELECTION_SCRIPT, true));
  if (!selected) throw new Error('Element selection timed out or was cancelled.');
  update(record, { selectedElement: selected });
  return snapshotOf(record);
}

export async function closePreviewsForWorkspace(root: string): Promise<void> {
  const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const matching = [...previews.values()].filter((record) => {
    const recordRoot = resolve(record.snapshot.root);
    return (process.platform === 'win32' ? recordRoot.toLowerCase() : recordRoot) === key;
  });
  await Promise.allSettled(matching.map(closeRecord));
}

export async function closePreviewsForOwner(ownerId: number): Promise<void> {
  const record = previews.get(ownerId);
  if (record) await closeRecord(record);
}

export async function closeAllPreviews(): Promise<void> {
  await Promise.allSettled([...previews.values()].map(closeRecord));
}
