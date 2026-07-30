/**
 * Credential-bearing custom headers are forbidden because custom headers are
 * ordinary settings (and may be exported or synced). Provider credentials must
 * use the Main-process secret store instead.
 */
const CREDENTIAL_HEADER_NAME =
  /(^|[-_])(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:api|auth|access|refresh|id|security)?[-_]?(?:key|token)|credential|secret)([-_]|$)/i;

export interface HeaderSanitization {
  headers: Record<string, string>;
  rejectedNames: string[];
}

export function isCredentialHeaderName(name: string): boolean {
  const trimmed = name.trim();
  if (CREDENTIAL_HEADER_NAME.test(trimmed)) return true;
  // HTTP header names are case-insensitive and vendors commonly compact words
  // (`XApiKey`, `XAuthToken`). Remove punctuation/casing before checking the
  // credential-bearing suffixes so delimiter tricks cannot bypass the gate.
  const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    compact === 'key' ||
    compact === 'token' ||
    compact.endsWith('authorization') ||
    compact.endsWith('authentication') ||
    compact.endsWith('auth') ||
    compact.endsWith('apikey') ||
    compact.endsWith('authkey') ||
    compact.endsWith('accesskey') ||
    compact.endsWith('securitykey') ||
    compact.endsWith('secretkey') ||
    compact.endsWith('token') ||
    compact.endsWith('cookie') ||
    compact.endsWith('credential') ||
    compact.endsWith('credentials') ||
    compact.endsWith('secret')
  );
}

/**
 * Coerce an untrusted value to string headers while removing names that could
 * carry credentials. Callers at an outbound boundary should reject when
 * `rejectedNames` is non-empty; persistence callers may safely migrate by using
 * the returned `headers`.
 */
export function sanitizeAiHeaders(value: unknown): HeaderSanitization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { headers: {}, rejectedNames: [] };
  }

  const headers: Record<string, string> = {};
  const rejectedNames: string[] = [];
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name || typeof rawValue !== 'string') continue;
    if (isCredentialHeaderName(name)) {
      rejectedNames.push(name);
      continue;
    }
    headers[name] = rawValue;
  }
  return { headers, rejectedNames };
}

/** Strip forbidden names from the JSON-encoded custom-header setting. */
export function sanitizeStoredAiHeaders(value: unknown): {
  value: unknown;
  changed: boolean;
  rejectedNames: string[];
} {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = value.trim().length > 0 ? JSON.parse(value) : {};
    } catch {
      return { value: '{}', changed: value !== '{}', rejectedNames: [] };
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    parsed = value;
  } else {
    return { value: '{}', changed: value !== '{}', rejectedNames: [] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: '{}', changed: value !== '{}', rejectedNames: [] };
  }
  const result = sanitizeAiHeaders(parsed);
  const serialized = JSON.stringify(result.headers);
  return {
    value: serialized,
    changed: typeof value !== 'string' || value !== serialized,
    rejectedNames: result.rejectedNames,
  };
}
