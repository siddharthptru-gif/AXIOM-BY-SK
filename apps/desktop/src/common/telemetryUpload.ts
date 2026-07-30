import { sanitizeProps, isAllowed, TELEMETRY_CATEGORIES } from './telemetry';
import type { TelemetryConsent, TelemetryEvent } from './ipc';

/**
 * Telemetry / crash-report upload client (PRD Epoch E §53 / Phase 126). Pure,
 * I/O-free upload pipeline over the local telemetry buffer: re-check consent at
 * send time, defensively RE-REDACT each event (nothing but bucketed numbers /
 * booleans / short enums leaves the device — INV-3), apply sampling, chunk into
 * batches, map each batch to the deployed `telemetry-ingest` Edge function's body
 * shape, back off on failures, and reconcile the FIFO queue after a successful
 * upload. Crash reports (`crashReports` category) flow through the same pipeline
 * (never sampled out). No network here — the Main `telemetry` service performs the
 * authenticated POST (functions.invoke) under the signed-in user's identity; a
 * remote kill switch (a feature flag) can stop uploads. Smoke-tested.
 */

export const MAX_UPLOAD_BATCH = 200;
export const MIN_UPLOAD_BATCH = 5;

/** Keep only events whose category is still consented (consent may have changed). */
export function selectUploadable(
  events: readonly TelemetryEvent[],
  consent: TelemetryConsent,
): TelemetryEvent[] {
  return events.filter((e) => isAllowed(consent, e.category));
}

/** Defensive re-redaction so nothing unsafe can ever leave the device. */
export function redactEvent(e: TelemetryEvent): TelemetryEvent {
  return { ts: e.ts, category: e.category, type: e.type, props: sanitizeProps(e.props) };
}

/** Split the queue into upload batches of at most `maxBatch`, in FIFO order. */
export function buildBatches(
  events: readonly TelemetryEvent[],
  maxBatch: number = MAX_UPLOAD_BATCH,
): TelemetryEvent[][] {
  const size = Number.isFinite(maxBatch) && maxBatch >= 1 ? Math.floor(maxBatch) : MAX_UPLOAD_BATCH;
  const out: TelemetryEvent[][] = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

export interface UploadMeta {
  appVersion: string;
  sessionId: string;
  installId: string;
  sentAt: number;
}

export interface UploadPayload {
  schema: number;
  appVersion: string;
  sessionId: string;
  installId: string;
  sentAt: number;
  count: number;
  events: TelemetryEvent[];
}

/** Build a versioned, fully-redacted upload payload for a batch. */
export function buildUploadPayload(
  batch: readonly TelemetryEvent[],
  meta: UploadMeta,
): UploadPayload {
  const events = batch.map(redactEvent);
  return {
    schema: 1,
    appVersion: meta.appVersion,
    sessionId: meta.sessionId,
    installId: meta.installId,
    sentAt: meta.sentAt,
    count: events.length,
    events,
  };
}

/**
 * After a successful upload of the first `uploadedCount` events (FIFO), drop them
 * from the queue so they are never sent twice. Out-of-range counts are clamped.
 */
export function dropUploaded(
  queue: readonly TelemetryEvent[],
  uploadedCount: number,
): TelemetryEvent[] {
  const n =
    Number.isFinite(uploadedCount) && uploadedCount > 0
      ? Math.min(Math.floor(uploadedCount), queue.length)
      : 0;
  return queue.slice(n);
}

/** Any telemetry category consented? */
export function anyConsent(consent: TelemetryConsent): boolean {
  return TELEMETRY_CATEGORIES.some((c) => isAllowed(consent, c));
}

/** Whether an upload should be attempted now: some consent + enough queued events. */
export function shouldUpload(
  uploadableCount: number,
  consent: TelemetryConsent,
  minBatch: number = MIN_UPLOAD_BATCH,
): boolean {
  const min = Number.isFinite(minBatch) && minBatch >= 1 ? Math.floor(minBatch) : MIN_UPLOAD_BATCH;
  return anyConsent(consent) && uploadableCount >= min;
}

/** Default periodic upload interval (5 min). */
export const BASE_UPLOAD_MS = 5 * 60_000;

/** Exponential backoff for the upload loop after consecutive failures, capped 6h. */
export function nextUploadDelayMs(
  consecutiveFailures: number,
  baseMs: number = BASE_UPLOAD_MS,
): number {
  const n =
    Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
      ? Math.floor(consecutiveFailures)
      : 0;
  const max = 6 * 3_600_000;
  if (n === 0) return Math.min(baseMs, max);
  return Math.min(baseMs * Math.pow(2, Math.min(n, 6)), max);
}

export interface UploadPreview {
  pending: number;
  uploadable: number;
  batches: number;
  ready: boolean;
}

/** A privacy-transparency summary: how much telemetry would be uploaded. */
export function previewUpload(
  events: readonly TelemetryEvent[],
  consent: TelemetryConsent,
): UploadPreview {
  const uploadable = selectUploadable(events, consent);
  return {
    pending: events.length,
    uploadable: uploadable.length,
    batches: buildBatches(uploadable).length,
    ready: shouldUpload(uploadable.length, consent),
  };
}

// ---------------------------------------------------------------------------
// Ingest envelope + sampling (Phase 126): map the local buffer to the deployed
// `telemetry-ingest` Edge function body, and sample analytics volume down.
// Still PURE — the Main service performs the authenticated POST.
// ---------------------------------------------------------------------------

/** One event in the deployed `telemetry-ingest` Edge function body. */
export interface IngestEvent {
  event: string;
  props: Record<string, number | boolean | string>;
  ts: string;
}

/** The request body the deployed `telemetry-ingest` Edge function expects. */
export interface IngestBody {
  sessionId: string;
  appVersion: string;
  platform: string;
  events: IngestEvent[];
}

/** Per-request metadata for an ingest upload. */
export interface IngestMeta {
  sessionId: string;
  appVersion: string;
  platform: string;
}

/**
 * Map a batch of buffered events to the `telemetry-ingest` body shape: the event
 * name is `category.type`, props are defensively re-sanitized (INV-3), and the
 * timestamp is an ISO-8601 string (the Edge function stores a `timestamptz`).
 */
export function toIngestBody(batch: readonly TelemetryEvent[], meta: IngestMeta): IngestBody {
  return {
    sessionId: meta.sessionId,
    appVersion: meta.appVersion,
    platform: meta.platform,
    events: batch.map((e) => ({
      event: `${e.category}.${e.type}`,
      props: sanitizeProps(e.props),
      ts: new Date(e.ts).toISOString(),
    })),
  };
}

/** Stable 0–99 bucket for an event (FNV-1a), so sampling is deterministic. */
export function eventBucket(e: TelemetryEvent): number {
  let h = 0x811c9dc5;
  const s = `${e.ts}:${e.category}:${e.type}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/**
 * Sample analytics volume down to `samplePct` percent, deterministically (a given
 * event is consistently kept or dropped). Crash reports are NEVER sampled out —
 * they always upload. `samplePct >= 100` keeps everything; `<= 0` keeps only
 * crash reports.
 */
export function sampleEvents(
  events: readonly TelemetryEvent[],
  samplePct: number,
): TelemetryEvent[] {
  const pct = Number.isFinite(samplePct) ? Math.max(0, Math.min(100, Math.floor(samplePct))) : 100;
  if (pct >= 100) return events.slice();
  return events.filter((e) => e.category === 'crashReports' || eventBucket(e) < pct);
}
