import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import { fetchReleaseConfig } from './releaseService';
import { decideUpdate, describePlan, type UpdatePlan } from '../../common/updateConfig';
import {
  classifyError,
  errorMessage as updateErrorMessage,
  initialUpdateState,
  reduceUpdate,
  type UpdateEvent,
  type UpdateEventPayload,
  type UpdateSnapshot,
  type UpdateUiState,
} from '../../common/updateState';
import { nextCheckDelayMs, verifyDownload, type ReleaseInfo } from '../../common/autoUpdate';
import {
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  assertUpdateResponseBounds,
  assertUpdateResponseUrl,
  assertUpdateTransferredBytes,
  updateFetchOptions,
  validateUpdateDownloadUrl,
} from '../../common/updateNetwork';

/**
 * UpdateService (UPDATEFEATURE §1/§2/§5/§6/§7/§9/§10 — the orchestrator).
 *
 * Backend-driven: fetch the Supabase release config → decide (pure `decideUpdate`,
 * with downgrade + minimum-version + mandatory policy) → download in the background
 * with progress → verify integrity (SHA-256) → notify / block → install + restart.
 *
 * The Supabase release row is the single artifact authority. Its validated HTTPS
 * URL is streamed directly to disk, checked against the row's SHA-256 (and size
 * when supplied), then launched as an NSIS installer. This prevents the policy
 * shown by the UI from drifting from a separate electron-updater feed.
 *
 * Lifecycle events are pushed to subscribers (main/ipc bridges them to the
 * renderer's update UI). Deterministic policy lives in the pure cores; this file
 * is the I/O shell.
 */
const log = rootLogger.child('update');

// ---- subscribers ------------------------------------------------------------

const listeners = new Set<(e: UpdateEvent) => void>();

/** Subscribe to update lifecycle events; returns an unsubscribe fn. */
export function onUpdateEvent(cb: (e: UpdateEvent) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(payload: UpdateEventPayload): void {
  const reduced = reduceUpdate(updateState, payload);
  updateState = reconcileUpdateState(reduced, payload);
  updateRevision += 1;
  const event: UpdateEvent = { revision: updateRevision, event: payload, state: updateState };
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      /* a listener must never break the update flow */
    }
  }
}

// ---- module state -----------------------------------------------------------

interface DownloadedInstaller {
  path: string;
  fingerprint: string;
  sha256: string;
  sizeBytes: number;
}

let channel = 'stable';
let autoDownload = true;
let currentPlan: UpdatePlan | null = null;
let updateState: UpdateUiState = initialUpdateState;
let updateRevision = 0;
let downloadedInstaller: DownloadedInstaller | null = null;
let downloadGeneration = 0;
let downloading = false;
let activeCheck: Promise<UpdatePlan | null> | null = null;
let activeInstall: Promise<void> | null = null;
let installerLaunchStarted = false;
let consecutiveFailures = 0;
let periodicTimer: ReturnType<typeof setTimeout> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

function artifactFingerprint(plan: UpdatePlan): string {
  return JSON.stringify([plan.latestVersion, plan.downloadURL, plan.checksum, plan.sizeBytes]);
}

function hasCurrentInstaller(): boolean {
  return (
    downloadedInstaller !== null &&
    currentPlan !== null &&
    downloadedInstaller.fingerprint === artifactFingerprint(currentPlan)
  );
}

/** Reconcile reducer output with service-owned plan and installer authority. */
function reconcileUpdateState(state: UpdateUiState, payload: UpdateEventPayload): UpdateUiState {
  const plan = currentPlan;
  const downloaded = hasCurrentInstaller();
  const authoritative: UpdateUiState = {
    ...state,
    plan,
    mustBlock: plan?.mustBlock === true,
    downloaded,
  };

  // A periodic check must not roll a verified installer back to checking/available.
  if (
    downloaded &&
    plan !== null &&
    plan.status !== 'up-to-date' &&
    (payload.type === 'checking' || payload.type === 'available')
  ) {
    return {
      ...authoritative,
      phase: 'ready',
      progress: 100,
      message: 'Update ready — restart to install.',
      errorKind: null,
    };
  }

  return authoritative;
}

/** Current atomic snapshot so a late renderer can seed its UI + mandatory guard. */
export function getUpdateSnapshot(): UpdateSnapshot {
  const revision = updateRevision;
  const state = updateState;
  return { revision, state };
}

export function configureUpdates(opts: { channel?: string; autoDownload?: boolean }): void {
  if (typeof opts.channel === 'string' && opts.channel.length > 0) channel = opts.channel;
  if (typeof opts.autoDownload === 'boolean') autoDownload = opts.autoDownload;
}

function errMsg(e: unknown): string {
  return updateErrorMessage(classifyError(e));
}

// ---- version check ----------------------------------------------------------

/**
 * Check for an update: fetch config → decide → emit. On success may auto-start the
 * background download (when enabled, or always for a mandatory update). Offline /
 * missing config terminates as unavailable until a plan is known and backs off the
 * next check; any prior plan remains authoritative.
 */
export async function checkForUpdate(): Promise<UpdatePlan | null> {
  if (activeCheck) return activeCheck;
  const check = performUpdateCheck();
  activeCheck = check;
  try {
    return await check;
  } finally {
    if (activeCheck === check) activeCheck = null;
  }
}

async function performUpdateCheck(): Promise<UpdatePlan | null> {
  emit({ type: 'checking' });
  const config = await fetchReleaseConfig(channel);
  if (!config) {
    consecutiveFailures += 1;
    scheduleNextCheck();
    log.info('update check: no config (offline or unpublished)');
    // Do not replace a known policy with a connectivity/publication failure.
    if (currentPlan?.status === 'up-to-date') {
      emit({ type: 'up-to-date', plan: currentPlan });
    } else if (currentPlan) {
      emit({ type: 'available', plan: currentPlan });
    } else {
      emit({ type: 'unavailable' });
    }
    return currentPlan;
  }
  consecutiveFailures = 0;
  const plan = decideUpdate(app.getVersion(), config);
  const planChanged =
    currentPlan === null || artifactFingerprint(currentPlan) !== artifactFingerprint(plan);
  let staleInstaller: DownloadedInstaller | null = null;
  if (planChanged) {
    downloadGeneration += 1;
    staleInstaller = downloadedInstaller;
    downloadedInstaller = null;
  }
  currentPlan = plan;
  log.info(describePlan(plan));
  scheduleNextCheck();

  if (plan.status === 'up-to-date') {
    emit({ type: 'up-to-date', plan });
    if (staleInstaller) await rm(staleInstaller.path, { force: true }).catch(() => undefined);
    return plan;
  }
  emit({ type: 'available', plan });
  // Publish the new authoritative policy before asynchronous stale-artifact cleanup
  // so snapshots cannot observe currentPlan ahead of its matching UI state.
  if (staleInstaller) await rm(staleInstaller.path, { force: true }).catch(() => undefined);
  // Background download: always for mandatory (so the block clears fast), and for
  // optional when auto-download is enabled.
  if (plan.mustBlock || autoDownload) {
    void downloadUpdate().catch((e) => log.warn('auto download failed', { message: errMsg(e) }));
  }
  return plan;
}

// ---- download + verify ------------------------------------------------------

function isCurrentDownload(fingerprint: string, generation: number): boolean {
  return (
    generation === downloadGeneration &&
    currentPlan !== null &&
    artifactFingerprint(currentPlan) === fingerprint
  );
}

function publishCurrentPlanState(): void {
  const plan = currentPlan;
  if (!plan) {
    emit({ type: 'unavailable' });
  } else if (plan.status === 'up-to-date') {
    emit({ type: 'up-to-date', plan });
  } else if (hasCurrentInstaller()) {
    emit({ type: 'ready', plan });
  } else {
    emit({ type: 'available', plan });
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Start the background download of the current update (idempotent while running). */
export async function downloadUpdate(): Promise<void> {
  const plan = currentPlan;
  if (!plan || plan.status === 'up-to-date' || !plan.downloadURL) return;
  const fingerprint = artifactFingerprint(plan);
  if (downloading || downloadedInstaller?.fingerprint === fingerprint) return;
  if (downloadedInstaller) {
    await rm(downloadedInstaller.path, { force: true }).catch(() => undefined);
    downloadedInstaller = null;
  }

  const generation = downloadGeneration;
  downloading = true;
  try {
    // The validated Supabase plan is authoritative: download exactly its URL and
    // verify exactly its SHA-256 against bytes read back from the completed file.
    await downloadAndVerify(plan, fingerprint, generation);
  } catch (e) {
    // A newer plan supersedes this attempt; do not surface its stale failure as
    // an error for the replacement plan.
    if (generation === downloadGeneration) {
      emit({ type: 'error', kind: classifyError(e), message: errMsg(e) });
    }
  } finally {
    downloading = false;
    if (generation !== downloadGeneration) {
      // A stale attempt must not leave its last progress event authoritative.
      publishCurrentPlanState();
      if (currentPlan && currentPlan.status !== 'up-to-date' && !hasCurrentInstaller()) {
        // Preserve the original download intent for the replacement plan once
        // the superseded attempt has released the single-download slot.
        void downloadUpdate().catch(() => undefined);
      }
    }
  }
}

async function downloadAndVerify(
  plan: UpdatePlan,
  fingerprint: string,
  generation: number,
): Promise<void> {
  const requestedUrl = plan.downloadURL;
  const url = requestedUrl ? validateUpdateDownloadUrl(requestedUrl) : null;
  if (!url || url !== requestedUrl) throw new Error('The update URL is not approved.');
  const dir = join(app.getPath('userData'), 'updates', 'download');
  await mkdir(dir, { recursive: true });
  const fileName = safeInstallerName(url);
  const dest = join(dir, `.axiom-${randomBytes(8).toString('hex')}-${fileName}`);

  log.info('downloading update (direct)', { fileName });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
  let transferred = 0;
  let total = 0;
  let lastPercent = -1;
  let writeComplete = false;
  let superseded = false;

  try {
    let res: Response;
    try {
      res = await fetch(url, updateFetchOptions(controller.signal));
    } catch {
      if (controller.signal.aborted) {
        throw new Error('The update download timed out.');
      }
      throw new Error('The update download request failed.');
    }
    assertUpdateResponseUrl(url, res.url, res.redirected);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching the update.`);
    const body = res.body;
    if (!body) throw new Error('Empty download response.');
    total = assertUpdateResponseBounds(res.headers.get('content-length'), plan.sizeBytes);

    const reader = body.getReader();
    const handle = await open(dest, 'wx', 0o600);
    try {
      for (;;) {
        if (!isCurrentDownload(fingerprint, generation)) {
          superseded = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          await handle.sync();
          writeComplete = true;
          break;
        }
        if (!value) continue;
        const chunk = Buffer.from(value);
        transferred += chunk.length;
        assertUpdateTransferredBytes(transferred, plan.sizeBytes);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error('The update file write made no progress.');
          offset += bytesWritten;
        }
        if (!isCurrentDownload(fingerprint, generation)) {
          superseded = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        const percent = total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          emit({ type: 'progress', transferred, total, percent });
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (controller.signal.aborted) throw new Error('The update download timed out.');
      throw error;
    } finally {
      try {
        await handle.close();
      } catch (closeError) {
        writeComplete = false;
        await rm(dest, { force: true }).catch(() => undefined);
        throw closeError;
      }
      if (!writeComplete) await rm(dest, { force: true }).catch(() => undefined);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (superseded || !isCurrentDownload(fingerprint, generation)) {
    await rm(dest, { force: true }).catch(() => undefined);
    return;
  }

  emit({ type: 'verifying' });
  let diskSize: number;
  let diskHash: string;
  try {
    diskSize = (await stat(dest)).size;
    diskHash = await hashFile(dest);
  } catch (error) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw error;
  }
  if (!isCurrentDownload(fingerprint, generation)) {
    await rm(dest, { force: true }).catch(() => undefined);
    return;
  }

  const release: ReleaseInfo = {
    version: plan.latestVersion ?? '0.0.0',
    channel: 'stable',
    url,
    sha256: plan.checksum ?? '',
    ...(plan.sizeBytes != null ? { sizeBytes: plan.sizeBytes } : {}),
  };
  const verdict = verifyDownload(release, { sha256: diskHash, sizeBytes: diskSize });
  if (!verdict.ok) {
    await rm(dest, { force: true }).catch(() => undefined);
    throw new Error(`Integrity check failed: ${verdict.reason}`);
  }
  downloadedInstaller = { path: dest, fingerprint, sha256: diskHash, sizeBytes: diskSize };
  log.info('update downloaded + verified', { fileName });
  emit({ type: 'ready', plan: currentPlan! });
}

function safeInstallerName(url: string): string {
  const raw = basename(new URL(url).pathname) || 'AxiomSetup.exe';
  // Keep it to a safe filename (no path separators / traversal).
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'AxiomSetup.exe';
}

// ---- install ----------------------------------------------------------------

async function revalidateInstaller(
  installer: DownloadedInstaller,
  plan: UpdatePlan,
): Promise<void> {
  const fileStat = await lstat(installer.path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error('The verified update installer path is no longer a regular file.');
  }
  if (fileStat.size !== installer.sizeBytes) {
    throw new Error('Integrity check failed: the verified update installer size changed.');
  }
  const sha256 = await hashFile(installer.path);
  if (sha256 !== installer.sha256 || !plan.checksum || sha256 !== plan.checksum.toLowerCase()) {
    throw new Error('Integrity check failed: the verified update installer hash changed.');
  }
}

/**
 * Install the verified update + restart. Revalidate the on-disk bytes immediately
 * before launching the detached NSIS installer.
 */
async function performInstall(): Promise<void> {
  emit({ type: 'installing' });
  const installer = downloadedInstaller;
  const plan = currentPlan;
  if (installer && plan && installer.fingerprint === artifactFingerprint(plan)) {
    try {
      await revalidateInstaller(installer, plan);
    } catch (error) {
      downloadedInstaller = null;
      await rm(installer.path, { force: true }).catch(() => undefined);
      emit({ type: 'error', kind: classifyError(error), message: errMsg(error) });
      return;
    }
    const stillCurrent =
      downloadedInstaller === installer &&
      currentPlan !== null &&
      installer.fingerprint === artifactFingerprint(currentPlan);
    if (!stillCurrent) {
      if (downloadedInstaller === installer) downloadedInstaller = null;
      await rm(installer.path, { force: true }).catch(() => undefined);
      publishCurrentPlanState();
      return;
    }
    installerLaunchStarted = true;
    downloadedInstaller = null;
    try {
      // No await belongs between the authority recheck above and this synchronous
      // spawn. External path replacement still requires platform signing/handles
      // for complete exclusion and is recorded as a release limitation.
      const child = spawn(installer.path, [], { detached: true, stdio: 'ignore' });
      let launchSettled = false;
      child.once('error', (error) => {
        if (launchSettled) return;
        launchSettled = true;
        installerLaunchStarted = false;
        void rm(installer.path, { force: true })
          .catch(() => undefined)
          .then(() => {
            emit({ type: 'error', kind: classifyError(error), message: errMsg(error) });
          });
      });
      child.once('spawn', () => {
        if (launchSettled) return;
        launchSettled = true;
        child.unref();
        setTimeout(() => app.quit(), 400);
      });
    } catch (e) {
      installerLaunchStarted = false;
      await rm(installer.path, { force: true }).catch(() => undefined);
      emit({ type: 'error', kind: classifyError(e), message: errMsg(e) });
    }
    return;
  }
  if (installer) {
    downloadedInstaller = null;
    await rm(installer.path, { force: true }).catch(() => undefined);
    emit({ type: 'error', kind: 'install', message: 'Downloaded update is no longer current.' });
    return;
  }
  emit({ type: 'error', kind: 'install', message: 'No downloaded update to install.' });
}

export async function installUpdate(): Promise<void> {
  if (installerLaunchStarted) return;
  if (activeInstall) {
    await activeInstall;
    return;
  }
  const install = performInstall();
  activeInstall = install;
  try {
    await install;
  } finally {
    if (activeInstall === install) activeInstall = null;
  }
}

// ---- periodic scheduling ----------------------------------------------------

function scheduleNextCheck(): void {
  if (periodicTimer) clearTimeout(periodicTimer);
  const delay = nextCheckDelayMs(consecutiveFailures);
  periodicTimer = setTimeout(() => {
    void checkForUpdate().catch(() => undefined);
  }, delay);
}

/** Start the auto-update loop: an initial check shortly after launch, then periodic. */
export function startAutoUpdates(opts: { channel?: string; autoDownload?: boolean } = {}): void {
  configureUpdates(opts);
  if (initialTimer) clearTimeout(initialTimer);
  // Defer the first check so it never competes with first paint (Phase 268).
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void checkForUpdate().catch(() => undefined);
  }, 8000);
}

/** Stop the periodic loop (used on shutdown / tests). */
export function stopAutoUpdates(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (periodicTimer) clearTimeout(periodicTimer);
  initialTimer = null;
  periodicTimer = null;
}
