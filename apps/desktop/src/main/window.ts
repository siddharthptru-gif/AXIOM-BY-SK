import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol } from 'electron';
import { rootLogger } from '@axiom/shared';
import { attachDirtyCloseGuard } from './services/dirtyWindow';
import { WEBVIEW_SCHEME } from '../common/vscodeWebview';
import {
  RENDERER_ENTRY_URL,
  RENDERER_PROTOCOL_SCHEME,
  isProductionRuntime,
  rendererAssetRelativePath,
  runtimeErrorDetails,
  windowLoadFailureDetails,
} from './runtimeSecurity';

// This must run before app ready. The packaged binary deliberately removes the
// legacy file:// privileges, so production assets are served from a secure origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
  {
    // Extension webviews. Registering the scheme costs nothing at startup — no handler is
    // installed until an extension actually asks for a webview — but it has to be declared
    // here, because Chromium decides a scheme's privileges once, before app ready.
    //
    // `standard` is what gives each `axiom-webview://<token>` a real, distinct origin, which is
    // the whole isolation model: separate storage per webview and an `event.origin` the
    // workbench can check. `secure` keeps it out of the mixed-content and
    // insecure-origin buckets so normal web APIs work inside a webview. `corsEnabled` is
    // deliberately absent: a webview's own resources are same-origin to it, and nothing else
    // should be able to fetch them cross-origin.
    scheme: WEBVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let rendererProtocolHandled = false;

/** Register the default-session handler once app ready has been emitted. */
function ensureRendererProtocol(): void {
  if (rendererProtocolHandled) return;
  const rendererRoot = join(app.getAppPath(), 'out', 'renderer');
  protocol.handle(RENDERER_PROTOCOL_SCHEME, (request) => {
    const relativePath = request.method === 'GET' ? rendererAssetRelativePath(request.url) : null;
    if (!relativePath) return new Response(null, { status: 404 });
    const filePath = join(rendererRoot, ...relativePath.split('/'));
    return net.fetch(pathToFileURL(filePath).toString());
  });
  rendererProtocolHandled = true;
}

/** Exact privileged renderer entry used by loading and navigation validation. */
export function getRendererEntryUrl(): string {
  const developmentUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
  return developmentUrl ? new URL(developmentUrl).toString() : RENDERER_ENTRY_URL;
}

const log = rootLogger.child('window');
const isProduction = isProductionRuntime(app.isPackaged, process.env['ELECTRON_RENDERER_URL']);
type ShowReason =
  'ready-to-show' | 'did-finish-load' | 'did-fail-load' | 'visibility-timeout' | 'load-error';

/**
 * Creates the main application window with a sandboxed, context-isolated renderer.
 */
export function createMainWindow(): BrowserWindow {
  ensureRendererProtocol();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#1e1d28',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1A1923',
      symbolColor: '#DDD8E7',
      height: 40,
    },
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !isProduction,
      spellcheck: false,
    },
  });

  if (isProduction) win.removeMenu();
  attachDirtyCloseGuard(win);

  let visibilityTimer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  const showWindow = (reason: ShowReason): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (visibilityTimer) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
    win.show();
    log.info(`Main window shown (${reason})`);
  };

  win.once('ready-to-show', () => showWindow('ready-to-show'));
  win.webContents.once('did-finish-load', () => showWindow('did-finish-load'));
  win.webContents.once('did-fail-load', (_event, code, description) => {
    log.error('Renderer failed to load', windowLoadFailureDetails(code, description, isProduction));
    showWindow('did-fail-load');
  });
  visibilityTimer = setTimeout(() => showWindow('visibility-timeout'), 4_000);
  win.once('closed', () => {
    if (visibilityTimer) clearTimeout(visibilityTimer);
    visibilityTimer = null;
  });

  void win.loadURL(getRendererEntryUrl()).catch((error: unknown) => {
    log.error('Renderer navigation failed', runtimeErrorDetails(error, isProduction));
    showWindow('load-error');
  });

  return win;
}
