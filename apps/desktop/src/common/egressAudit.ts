/**
 * Secrets & egress hardening audit (PRD Epoch J §177/§183 / Phase 272). Pure
 * assertions for the sovereignty core: an outbound URL is allowed only over HTTPS
 * (or plain HTTP to loopback for local model servers), a URL is redacted to host-
 * only for logging (so a Gemini-style query-string key never leaks), and log text
 * is checked for secret-shaped content. No I/O — mirrors the runtime egress gateway
 * as testable assertions. Smoke-tested.
 */
export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether a host is loopback (local model servers may use plain HTTP). */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Audit an outbound URL against the egress policy: HTTPS is always allowed; plain
 * HTTP only to loopback; anything else is denied (INV: no plaintext egress).
 */
export function auditEgressUrl(url: string): EgressDecision {
  const u = parseUrl(url);
  if (!u) return { allowed: false, reason: 'Not a valid URL.' };
  if (u.protocol === 'https:') return { allowed: true, reason: 'HTTPS.' };
  if (u.protocol === 'http:') {
    return isLoopback(u.hostname)
      ? { allowed: true, reason: 'HTTP to loopback (local server).' }
      : { allowed: false, reason: 'Plain HTTP to a non-loopback host is not allowed.' };
  }
  return { allowed: false, reason: `Unsupported protocol: ${u.protocol}` };
}

/** Redact a URL to scheme://host[:port]/path — dropping the query (may carry a key). */
export function redactUrl(url: string): string {
  const u = parseUrl(url);
  if (!u) return '[invalid-url]';
  const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
  return `${u.protocol}//${u.host}${path}${u.search ? '?…' : ''}`;
}

// Secret-shaped patterns that must never appear in logs/telemetry/diagnostics.
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
];

/** Whether a log/diagnostic string contains secret-shaped content (should be redacted). */
export function needsRedaction(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

/** Redact secret-shaped substrings in a log line (mask the value). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
      '[REDACTED]',
    );
  }
  return out;
}
