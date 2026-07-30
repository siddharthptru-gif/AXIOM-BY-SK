import { rootLogger } from '@axiom/shared';
import { getSupabase } from './supabase';
import { startFlagSync, fetchFlags, stopFlagSync } from './featureFlags';
import {
  startTelemetryUpload,
  uploadTelemetry,
  stopTelemetryUpload,
  recordAnalytics,
} from './telemetry';
import { startSyncEngine, flushQueue, stopSyncEngine } from './sync';

/**
 * Epoch E cloud-delivery orchestrator (PRD Phases 120 / 126 / 129), activated now
 * that the Supabase backend is live. Starts the three best-effort, internally
 * consent/auth-gated loops — Realtime feature-flag delivery, the telemetry upload
 * pipeline, and the preferences sync engine — and re-kicks an immediate reconcile
 * (fetch flags + flush the sync queue + upload telemetry) whenever a session
 * becomes available (sign-in, restored session, or token refresh). Every layer
 * fails safe when signed out / offline, so this never blocks startup.
 */
const log = rootLogger.child('backendSync');
let started = false;

export function startBackendSync(): void {
  if (started) return;
  started = true;

  startFlagSync();
  startTelemetryUpload();
  startSyncEngine();

  try {
    getSupabase().auth.onAuthStateChange((event, session) => {
      const active =
        !!session &&
        (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED');
      if (!active) return;
      // Phase 127 — emit the signin analytics event on an actual sign-in only
      // (consent-gated downstream; no-op unless the user opted in).
      if (event === 'SIGNED_IN') {
        void recordAnalytics('signin', { provider: 'google' }).catch(() => undefined);
      }
      void fetchFlags().catch(() => undefined);
      void flushQueue().catch(() => undefined);
      void uploadTelemetry().catch(() => undefined);
    });
  } catch (e) {
    log.warn('auth-change hook unavailable', {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Tear down every cloud loop (clean shutdown). */
export function stopBackendSync(): void {
  stopFlagSync();
  stopTelemetryUpload();
  stopSyncEngine();
  started = false;
}
