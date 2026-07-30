import type { TelemetryCategory, TelemetryConsent, TelemetryEvent } from './ipc';

/**
 * Telemetry sanitization + consent gating (PRD Epoch E §52–53 / Part X §188).
 * Pure, deterministic helpers so the privacy invariants are unit-tested: events
 * carry only bucketed numbers, booleans, and short enum-like strings — never
 * free text, code, prompts, or PII. Consent is per-category and default-off; a
 * disabled category records nothing. No I/O here; the Main service persists.
 */

export const TELEMETRY_CATEGORIES: readonly TelemetryCategory[] = [
  'crashReports',
  'analytics',
  'performance',
];

/** True only when the user has explicitly consented to this category. */
export function isAllowed(consent: TelemetryConsent, category: TelemetryCategory): boolean {
  return consent[category] === true;
}

/** Bucket a count to a coarse lower bound so exact values can't fingerprint. */
export function bucketNumber(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 5) return 5;
  if (n <= 10) return 10;
  if (n <= 50) return 50;
  if (n <= 100) return 100;
  if (n <= 500) return 500;
  if (n <= 1000) return 1000;
  return 5000;
}

// A short identifier / enum token — no spaces, no free text, bounded length.
const SHORT_ENUM = /^[a-z0-9_.-]{1,32}$/i;

/**
 * Keep only privacy-safe property values: bucketed numbers, booleans, and short
 * enum-like strings (e.g. a provider or event name). Free text, code, long
 * strings, objects, arrays, and non-identifier keys are dropped entirely.
 */
export function sanitizeProps(props: unknown): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (!SHORT_ENUM.test(k)) continue;
    if (typeof v === 'number') out[k] = bucketNumber(v);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && SHORT_ENUM.test(v)) out[k] = v;
    // objects, arrays, long/free-text strings, functions → dropped
  }
  return out;
}

/** Build a sanitized event (safe type + safe props) ready to buffer. */
export function sanitizeEvent(
  category: TelemetryCategory,
  type: string,
  props: unknown,
  now: number,
): TelemetryEvent {
  const safeType = SHORT_ENUM.test(type)
    ? type
    : type.replace(/[^a-z0-9_.-]/gi, '').slice(0, 32) || 'event';
  return { ts: now, category, type: safeType, props: sanitizeProps(props) };
}
