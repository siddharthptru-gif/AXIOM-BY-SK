import { app, BrowserWindow, Menu, session, shell, type Event as ElectronEvent } from 'electron';
import { rootLogger } from '@axiom/shared';
import { createMainWindow, getRendererEntryUrl } from './window';
import { registerIpcHandlers } from './ipc';
import { coreDispose } from './services/core';
import { disposeLsp } from './services/lsp';
import { disposeDebug } from './services/dap';
import { initCrashJournal, recordPhase, markClean } from './services/crashJournal';
import { warmRuntimeDetection } from './services/runtimes';
import { warmExecutionConsent } from './services/executionConsent';
import { bindActiveProfile, captureRootUserData } from './services/accountProfile';
import { initCommandConsent } from './services/commandConsent';
import { markStartup, getStartupPlan } from './services/startupTiming';
import { validateServiceGraph } from './services/serviceGraph';
import { readSettings } from './services/settings';
import { setEgressSafetyPolicy } from './services/aiGateway';
import { startAutoUpdates, stopAutoUpdates } from './services/updateService';
import { startBackendSync, stopBackendSync } from './services/backendSync';
import { recordAnalytics } from './services/telemetry';
import { parseEgressPolicy } from '../common/aiSafety';
import { osFromPlatform, normalizeArch, targetLabel } from '../common/platformTargets';
import { stopWatching } from './services/watcher';
import { killAllTerminals } from './services/terminal';
import { disconnectAll as disconnectAllMcp } from './services/mcp';
import { deactivateAllExtensions } from './services/extensionHost';
import { cancelAllAgentsAndDrain } from './services/agent';
import { drainProcessTerminations } from './services/processTree';
import { cancelAllGithubFlows } from './services/githubScm';
import { closeAllPreviews, isManagedPreviewWebContents } from './services/preview';
import { cancelAllVerifications } from './services/verification';
import { cancelAllIsolatedCommands } from './services/isolatedWorkspaces';
import { terminateAllExtensionSandboxes } from './services/extensionSandbox';
import { stopAllDeployments } from './services/deployment';
import { cancelAllPredictions } from './services/predictiveCompletion';
import { recoverInterruptedGodModeJobs } from './services/godModeJobs';
import { authorizeDroppedPath } from './services/dialog';
import { flushWebviewPersistence } from './services/extensionWebview';
import { flushWorkbenchViews, restoreExtensionEnvironments } from './services/marketplaceHost';
import { IPC } from '../common/ipc';
import { WEBVIEW_SCHEME } from '../common/vscodeWebview';
import {
  DEVELOPMENT_CSP,
  PRODUCTION_CSP,
  externalUrlForOpen,
  isBlockedDevToolsInput,
  isExactRendererNavigation,
  isProductionRuntime,
  runtimeErrorDetails,
} from './runtimeSecurity';

const log = rootLogger.child('main');
const rendererDevelopmentUrl = process.env['ELECTRON_RENDERER_URL'];
const isProduction = isProductionRuntime(app.isPackaged, rendererDevelopmentUrl);
const isDev = !isProduction;

function isRendererNavigation(rawUrl: string): boolean {
  return isExactRendererNavigation(rawUrl, getRendererEntryUrl());
}

async function safeOpenExternal(rawUrl: string): Promise<void> {
  const url = externalUrlForOpen(rawUrl, isDev);
  if (!url) {
    log.warn('Rejected renderer external URL');
    return;
  }
  await shell.openExternal(url);
}

/**
 * OS "Open with AXIOM" support. Windows launches the app with the chosen file or
 * folder as an argument (and routes later launches through `second-instance`).
 *
 * Main is still the only authority: the raw OS string is canonicalized and
 * authorized by the same resolver used for drag-and-drop, and only the resulting
 * authorized descriptor is forwarded to the renderer. Chromium/Electron switches
 * are ignored so a flag can never be mistaken for a path.
 */
const MAX_LAUNCH_PATH_CHARS = 1_024;

function launchPathFromArgv(argv: readonly string[]): string | null {
  for (const raw of argv.slice(1)) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.length > MAX_LAUNCH_PATH_CHARS ||
      value.startsWith('-') ||
      value.includes('\u0000')
    ) {
      continue;
    }
    return value;
  }
  return null;
}

/** Authorize a launch path in Main, then hand the descriptor to the renderer. */
async function deliverLaunchPath(rawPath: string | null): Promise<void> {
  if (!rawPath) return;
  try {
    const entry = await authorizeDroppedPath(rawPath);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send(IPC.appOpenPath, entry);
  } catch (error) {
    log.warn('Rejected an OS launch path', runtimeErrorDetails(error, isProduction));
  }
}

let shutdownStarted = false;
let shutdownComplete = false;

async function shutdownServices(): Promise<void> {
  stopAutoUpdates();
  stopBackendSync();
  stopWatching();
  cancelAllGithubFlows();
  cancelAllPredictions();
  const serviceResults = await Promise.allSettled([
    closeAllPreviews(),
    cancelAllVerifications(),
    cancelAllIsolatedCommands(),
    terminateAllExtensionSandboxes(),
    stopAllDeployments(),
    killAllTerminals(),
    cancelAllAgentsAndDrain(),
    disconnectAllMcp(),
    deactivateAllExtensions(),
    disposeDebug(),
    disposeLsp(),
    coreDispose(),
    // The restorable-panel list is debounced while the app runs, so the last `setState` before
    // a quit is only on disk if it is flushed here.
    flushWebviewPersistence(),
    // Same for expanded tree nodes, selection, the active activity-bar container and view sizes.
    flushWorkbenchViews(),
  ]);
  const drainResults = await Promise.allSettled([drainProcessTerminations()]);
  const errors = [...serviceResults, ...drainResults].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length > 0) {
    log.warn(
      'One or more services failed to stop cleanly',
      isProduction
        ? { count: errors.length }
        : {
            count: errors.length,
            errors: errors.map((error) => runtimeErrorDetails(error, false)),
          },
    );
  }
}

// Last-resort handlers deliberately avoid arbitrary values in production logs.
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception in main process', runtimeErrorDetails(error, isProduction));
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection in main process', runtimeErrorDetails(reason, isProduction));
});

// Per-account data isolation. This MUST be the first thing that happens after the
// single-instance decision and before any service is imported for use: it repoints
// userData at the signed-in account's profile directory, which is what makes every
// existing store account-scoped without touching thirty-five separate path helpers.
// Electron requires `setPath` before `whenReady`, and the real root is captured first
// so the auth session and the profile pointer keep their unmovable home.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  captureRootUserData();
  bindActiveProfile();

  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // A second launch is how Windows delivers another "Open with AXIOM" target.
    void deliverLaunchPath(launchPathFromArgv(argv));
  });

  app.whenReady().then(async () => {
    markStartup('app-ready');
    if (isProduction) Menu.setApplicationMenu(null);

    try {
      await recoverInterruptedGodModeJobs();
    } catch (error) {
      log.error(
        'God Mode job recovery failed; continuing without changing the ledger',
        runtimeErrorDetails(error, isProduction),
      );
    }

    // Apply a strict production CSP to every renderer response. Development keeps
    // only the Vite/HMR allowances required for local tooling.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // A webview document and its resources carry the policy the webview runtime minted for
      // that one origin (see `services/extensionWebview.ts`). Overwriting it with the
      // workbench's policy would replace a per-webview floor with one that was never written
      // for extension content — `default-src 'none'` would blank every webview.
      if (details.url.startsWith(`${WEBVIEW_SCHEME}:`)) {
        callback({});
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [isProduction ? PRODUCTION_CSP : DEVELOPMENT_CSP],
        },
      });
    });

    // Axiom does not require Chromium permission, capture, download, or device APIs.
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    defaultSession.setPermissionCheckHandler(() => false);
    defaultSession.setDevicePermissionHandler(() => false);
    defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    defaultSession.on('select-hid-device', (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    defaultSession.on('select-usb-device', (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    defaultSession.on('select-serial-port', (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback('');
    });
    defaultSession.on('will-download', (event, item) => {
      event.preventDefault();
      item.cancel();
      log.warn('Blocked renderer-created download');
    });

    // Register IPC handlers defensively — a failure here must never stop the main
    // window from opening (the app must always launch, even if a subsystem is broken).
    try {
      registerIpcHandlers();
    } catch (error) {
      log.error(
        'IPC registration failed; continuing with a restricted window',
        runtimeErrorDetails(error, isProduction),
      );
    }
    try {
      initCrashJournal();
    } catch {
      /* crash journal is best-effort */
    }

    // Phase 170 — apply the persisted AI egress safety policy (audit/sanitize/block).
    // Best-effort + async; the safe 'audit' default stands until settings resolve.
    void readSettings()
      .then((s) => {
        const rec = s as Record<string, unknown>;
        setEgressSafetyPolicy(
          parseEgressPolicy(rec['ai.safety.egressMode'], rec['ai.safety.blockSeverity']),
        );
        startAutoUpdates({
          channel: typeof rec['update.channel'] === 'string' ? rec['update.channel'] : 'stable',
          autoDownload: rec['update.autoDownload'] !== false,
        });
      })
      .catch(() => {
        /* default 'audit' policy stands */
        startAutoUpdates();
      });

    const mainWindow = createMainWindow();
    recordPhase('window-created');
    markStartup('window-created');

    // Warm the toolchain scan and load remembered command approvals after the
    // window exists, so neither delays first paint. Both are best-effort: a failed
    // scan simply means Run ▶ reports nothing detected yet.
    warmRuntimeDetection();
    void initCommandConsent().catch(() => undefined);
    // Resolve the install-time permission now, so the first approval settles without
    // waiting on a registry probe.
    warmExecutionConsent();
    // PRD Phase 7 — rehydrate the persistent terminal environment collections before any extension
    // host can start, so a terminal an early activation creates already carries them. Best-effort:
    // a missing or unreadable file simply means terminals start from the plain environment.
    void restoreExtensionEnvironments();

    // "Open with AXIOM" on a cold start: wait for the renderer to finish loading
    // so the descriptor is never dropped, then deliver the authorized target.
    const coldStartPath = launchPathFromArgv(process.argv);
    if (coldStartPath) {
      mainWindow.webContents.once('did-finish-load', () => {
        void deliverLaunchPath(coldStartPath);
      });
    }

    try {
      startBackendSync();
    } catch (error) {
      log.error('Backend sync failed to start', runtimeErrorDetails(error, isProduction));
    }

    void recordAnalytics('app_start', { coldMs: Math.round(process.uptime() * 1000) }).catch(
      () => undefined,
    );

    try {
      if (isProduction) {
        log.info('Deferred startup plan initialized');
      } else {
        log.info('startup plan (Phase 268)', { summary: getStartupPlan().summary });
      }
    } catch {
      /* startup planning is best-effort */
    }

    try {
      validateServiceGraph();
    } catch {
      /* service-graph validation is diagnostic-only */
    }

    log.info('Platform target detected', {
      target: targetLabel({
        os: osFromPlatform(process.platform),
        arch: normalizeArch(process.arch),
      }),
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });

    if (isProduction) {
      log.info('Axiom main process ready');
    } else {
      log.info('Axiom main process ready', { isDev, versions: process.versions.electron });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void shutdownServices()
      .catch((error: unknown) => {
        log.error('Shutdown coordinator failed', runtimeErrorDetails(error, isProduction));
      })
      .finally(() => {
        try {
          markClean();
        } catch {
          // Crash journal is best-effort; shutdown must still finish.
        }
        shutdownComplete = true;
        app.quit();
      });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });

    if (isProduction) {
      contents.on('before-input-event', (event, input) => {
        if (isBlockedDevToolsInput(input)) event.preventDefault();
      });
      contents.on('devtools-opened', () => {
        if (!contents.isDestroyed()) contents.closeDevTools();
      });
    }

    const handleNavigation = (event: ElectronEvent, url: string): void => {
      if (isManagedPreviewWebContents(contents)) return;
      if (isRendererNavigation(url)) return;
      event.preventDefault();
      void safeOpenExternal(url).catch((error: unknown) => {
        log.warn('Could not open approved external URL', runtimeErrorDetails(error, isProduction));
      });
    };
    contents.on('will-navigate', handleNavigation);
    contents.on('will-redirect', handleNavigation);
    contents.setWindowOpenHandler(({ url }) => {
      if (!isManagedPreviewWebContents(contents)) {
        void safeOpenExternal(url).catch((error: unknown) => {
          log.warn(
            'Could not open approved external URL',
            runtimeErrorDetails(error, isProduction),
          );
        });
      }
      return { action: 'deny' };
    });
  });
}
