import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { rootLogger } from '@axiom/shared';
import type { TelemetryCategory, TelemetryConsent, TelemetryEvent } from '../../common/ipc';
import { isAllowed, sanitizeEvent } from '../../common/telemetry';
import {
  previewUpload,
  selectUploadable,
  sampleEvents,
  buildBatches,
  toIngestBody,
  shouldUpload,
  nextUploadDelayMs,
  MAX_UPLOAD_BATCH,
  type IngestMeta,
  type UploadPreview,
} from '../../common/telemetryUpload';
import { readSettings } from './settings';
import { getSupabase } from './supabase';
import { isFlagEnabled } from './featureFlags';
import { validateAnalyticsEvent } from '../../common/analyticsEvents';

/**
 * Telemetry service (Main, PRD Epoch E §52–53 / Part X §188). Consent is read
 * from settings (default off — opt-in). Allowed events are sanitized (bucketed
 * numbers, booleans, short enums only — never code/PII/free text) and appended to
 * a capped LOCAL buffer. Nothing is uploaded here — the buffer is the local-first
 * stage; upload is a later phase gated by the same consent. A disabled category
 * records nothing at all (not just hidden — no data is written).
 */
const MAX_EVENTS = 1000;

const log = rootLogger.child('telemetry');
/** A per-process session id tagged onto every uploaded batch (non-PII, random). */
const SESSION_ID = randomUUID();

function bufferPath(): string {
  return join(app.getPath('userData'), 'telemetry-buffer.json');
}

/** Current per-category consent, derived from settings (absent = off). */
export async function getConsent(): Promise<TelemetryConsent> {
  const s = (await readSettings()) as Record<string, unknown>;
  return {
    crashReports: s['telemetry.crashReports'] === true,
    analytics: s['telemetry.analytics'] === true,
    performance: s['telemetry.performance'] === true,
  };
}

async function readBuffer_(): Promise<TelemetryEvent[]> {
  try {
    const raw = await fs.readFile(bufferPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

async function write(list: TelemetryEvent[]): Promise<void> {
  const path = bufferPath();
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.axiom-telemetry-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

// Serialize writes so concurrent records can't clobber the buffer.
let queue: Promise<void> = Promise.resolve();

/**
 * Record an event if its category is consented. No-op (nothing written) when
 * consent is off. The event is sanitized before it touches disk.
 */
export function recordEvent(
  category: TelemetryCategory,
  type: string,
  props?: unknown,
): Promise<void> {
  const run = queue.then(async () => {
    const consent = await getConsent();
    if (!isAllowed(consent, category)) return;
    const event = sanitizeEvent(category, type, props, Date.now());
    const list = await readBuffer_();
    list.push(event);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    await write(list);
  });
  queue = run.catch(() => undefined);
  return queue;
}

/**
 * Record an analytics event by its registry name (PRD Phase 127). The event is
 * validated against the reviewed analytics taxonomy — unknown events are dropped
 * and only declared, correctly-typed props survive (no PII / code) — then routed
 * to the registry's category via `recordEvent` (still consent-gated + sanitized).
 * Returns whether the event was accepted for recording.
 */
export async function recordAnalytics(
  name: string,
  props?: Record<string, unknown>,
): Promise<boolean> {
  const v = validateAnalyticsEvent(name, props);
  if (!v.known || !v.category) {
    log.warn('dropped unknown analytics event (Phase 127)', { name });
    return false;
  }
  await recordEvent(v.category, name, v.props);
  return true;
}

/** Read the local telemetry buffer (for the privacy inspector / diagnostics). */
export function readBuffer(): Promise<TelemetryEvent[]> {
  return readBuffer_();
}

/** Clear the local telemetry buffer. */
export async function clearBuffer(): Promise<void> {
  await write([]);
}

export interface TelemetryUploadStatus extends UploadPreview {
  /** True when uploads are active — the deployed ingest endpoint exists and is not killed. */
  endpointConfigured: boolean;
}

/**
 * Privacy-transparency preview of the telemetry/crash upload client (PRD Epoch E
 * §53 / Phase 126): how many buffered events would be uploaded, in how many
 * batches, whether an upload is due, and whether uploads are active (the deployed
 * `telemetry-ingest` endpoint exists unless a remote kill switch disables it).
 * Builds the plan via the pure `telemetryUpload` client; NOTHING is uploaded here
 * (no network) — `uploadTelemetry()` performs the authenticated POST.
 */
export async function uploadPreview(): Promise<TelemetryUploadStatus> {
  const [consent, buffer] = await Promise.all([getConsent(), readBuffer_()]);
  const killed = isFlagEnabled('telemetry.killSwitch');
  return { ...previewUpload(buffer, consent), endpointConfigured: !killed };
}

let uploadTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Drop the first `count` consented events (FIFO) from the buffer after a
 * successful upload — including sampled-out ones (sampling intentionally discards
 * them). Runs on the shared write `queue` so a concurrent `recordEvent` can't be
 * clobbered; non-consented events and any events appended during the upload stay.
 */
function reconcileAfterUpload(consent: TelemetryConsent, count: number): Promise<void> {
  const run = queue.then(async () => {
    const current = await readBuffer_();
    let dropped = 0;
    const remaining: TelemetryEvent[] = [];
    for (const e of current) {
      if (dropped < count && isAllowed(consent, e.category)) {
        dropped++;
        continue;
      }
      remaining.push(e);
    }
    await write(remaining);
  });
  queue = run.catch(() => undefined);
  return queue;
}

/**
 * Upload the local telemetry buffer to the deployed `telemetry-ingest` Edge
 * function under the signed-in user's identity (PRD Phase 126). Fully gated: off
 * unless the user consented, a remote kill switch (feature flag) can disable it,
 * events are re-redacted + sampled, sent in batches, and the FIFO buffer is
 * reconciled only on full success (crash reports are never sampled out).
 * Best-effort + backoff — nothing is lost on failure (the buffer persists, capped).
 */
export async function uploadTelemetry(): Promise<{ uploaded: number; reason?: string }> {
  if (isFlagEnabled('telemetry.killSwitch')) {
    return { uploaded: 0, reason: 'Telemetry upload disabled by remote kill switch.' };
  }
  const consent = await getConsent();
  const [buffer, settings] = await Promise.all([readBuffer_(), readSettings()]);
  const consented = selectUploadable(buffer, consent);
  const rawRate = (settings as Record<string, unknown>)['telemetry.sampleRate'];
  const samplePct = typeof rawRate === 'number' ? rawRate : 100;
  const toSend = sampleEvents(consented, samplePct);
  if (!shouldUpload(toSend.length, consent)) {
    return { uploaded: 0, reason: 'Nothing to upload yet.' };
  }

  const supa = getSupabase();
  try {
    const {
      data: { user },
    } = await supa.auth.getUser();
    if (!user) return { uploaded: 0, reason: 'Not signed in — telemetry stays local.' };
  } catch (e) {
    return { uploaded: 0, reason: `Telemetry stays local: ${detail(e)}` };
  }

  const meta: IngestMeta = {
    sessionId: SESSION_ID,
    appVersion: app.getVersion(),
    platform: process.platform,
  };
  const batches = buildBatches(toSend, MAX_UPLOAD_BATCH);
  let uploaded = 0;
  for (const batch of batches) {
    try {
      const { error } = await supa.functions.invoke('telemetry-ingest', {
        body: toIngestBody(batch, meta),
      });
      if (error) {
        consecutiveFailures++;
        log.warn('telemetry upload batch failed (Phase 126)', { reason: error.message, uploaded });
        return { uploaded, reason: error.message };
      }
    } catch (e) {
      consecutiveFailures++;
      return { uploaded, reason: detail(e) };
    }
    uploaded += batch.length;
  }
  consecutiveFailures = 0;
  // All batches sent: consume every consented event processed this cycle
  // (uploaded + sampled-out) from the FIFO buffer.
  await reconcileAfterUpload(consent, consented.length);
  log.info('telemetry uploaded (Phase 126)', {
    uploaded,
    sampledOut: consented.length - toSend.length,
  });
  return { uploaded };
}

function scheduleUpload(): void {
  const delay = nextUploadDelayMs(consecutiveFailures);
  uploadTimer = setTimeout(() => {
    void uploadTelemetry()
      .catch(() => undefined)
      .finally(() => scheduleUpload());
  }, delay);
  if (typeof uploadTimer.unref === 'function') uploadTimer.unref();
}

/** Start the periodic, consent-gated telemetry upload loop (backoff on failure). */
export function startTelemetryUpload(): void {
  if (uploadTimer) return;
  scheduleUpload();
}

/** Stop the telemetry upload loop (clean shutdown). */
export function stopTelemetryUpload(): void {
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
}
