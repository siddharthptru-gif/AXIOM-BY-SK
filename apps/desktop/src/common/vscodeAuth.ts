/**
 * The authentication, secret-storage, and URI-callback model.
 *
 * Everything here is pure: the shapes a session has, which scopes satisfy a request, what a
 * provider id or secret key may look like, and how a loopback callback URL is minted and
 * recognised again. Main owns the encrypted store, the loopback server, and the providers;
 * the worker owns the `vscode.authentication` shim; both agree here.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. **A session is never invented.** Sessions come from a provider — Axiom's own
 *      credential for a built-in provider, or an extension that registered one. Nothing here
 *      mints a token, and a provider's answer is validated before any extension sees it.
 *   2. **Scope matching is the reason a sign-in is or is not reused.** `getSession` is called
 *      on nearly every activation of an authenticating extension, so the question "does the
 *      session I already have satisfy what is being asked for" is answered by one tested
 *      function rather than by each call site.
 *   3. **A callback URL is a capability.** The URL handed to a browser during an OAuth round
 *      trip is guessable-by-anyone unless the path carries real entropy, so the token format
 *      is fixed here, checked on the way in, and bound to one extension and one use.
 */

/** An account a provider can sign in. `id` is stable; `label` is what the user reads. */
export interface AuthAccount {
  id: string;
  label: string;
}

/** A session, exactly as `vscode.AuthenticationSession` declares it. */
export interface AuthSession {
  id: string;
  accessToken: string;
  account: AuthAccount;
  scopes: string[];
}

/** A provider an extension registered, or one Axiom ships. */
export interface AuthProviderInfo {
  id: string;
  label: string;
  /** The extension that registered it, or null for a provider Axiom itself backs. */
  extensionId: string | null;
  supportsMultipleAccounts: boolean;
}

/** Providers one extension may register. More than a handful is a bug, not a use case. */
export const MAX_AUTH_PROVIDERS_PER_EXTENSION = 8;
/** Sessions one provider may report in a single answer. */
export const MAX_AUTH_SESSIONS = 16;
/** Scopes one request may carry. */
export const MAX_AUTH_SCOPES = 64;
/** Longest access token Axiom will carry across the boundary. */
export const MAX_TOKEN_CHARS = 8 * 1024;
/** Secrets one extension may store, and how large each may be. */
export const MAX_SECRETS_PER_EXTENSION = 128;
export const MAX_SECRET_CHARS = 64 * 1024;
export const MAX_SECRET_KEY_CHARS = 200;
/** Pending `asExternalUri` callbacks, and how long each stays redeemable. */
export const MAX_PENDING_CALLBACKS = 32;
export const CALLBACK_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Code points a secret key may not carry, named rather than escaped into a regex. */
const CODE_LAST_CONTROL = 0x1f;
const CODE_SLASH = 0x2f;
const CODE_BACKSLASH = 0x5c;

/**
 * A provider id an extension may claim.
 *
 * Deliberately narrow: the id is a key in a shared registry and appears in an activation
 * event (`onAuthenticationRequest:github`), so anything with a separator, a control
 * character, or a leading dot could collide with or hide another provider.
 */
export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID.test(value);
}

/**
 * A secret key an extension may use.
 *
 * Path separators and control characters are refused: keys are namespaced per extension when
 * they are persisted, so a key carrying a separator could be spelled to look like another
 * extension's key, and a control character would make the stored file unreadable to a human
 * auditing what an extension kept.
 */
export function isSecretKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > MAX_SECRET_KEY_CHARS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= CODE_LAST_CONTROL || code === CODE_SLASH || code === CODE_BACKSLASH) return false;
  }
  return true;
}

/** Where one extension's secret lives in the shared store. */
export function secretRecordKey(extensionId: string, key: string): string {
  return extensionId.toLowerCase() + ' ' + key;
}

// ---------------------------------------------------------------------------
// Scopes and sessions
// ---------------------------------------------------------------------------
/**
 * Put a scope list into the one canonical form comparisons use.
 *
 * Sorted and deduplicated, because `['repo','user']` and `['user','repo','repo']` are the
 * same request, and an extension asking twice with the entries in a different order must not
 * be sent through a second sign-in. Empty entries are dropped: a provider handed `['']`
 * cannot do anything useful with it.
 */
export function normalizeScopes(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const scope = entry.trim().slice(0, 200);
    if (scope.length === 0) continue;
    seen.add(scope);
    if (seen.size >= MAX_AUTH_SCOPES) break;
  }
  return [...seen].sort();
}

/** A stable key for a normalized scope set, for memoizing consent and change fanout. */
export function scopeKey(scopes: readonly string[]): string {
  return normalizeScopes(scopes).join(' ');
}

/**
 * Whether a session already covers what is being asked for.
 *
 * A superset satisfies a request — upstream's behaviour, and it matters: an extension that
 * signed in for `['repo','read:user']` and later asks for `['read:user']` must be handed the
 * session it already has rather than sent through a second sign-in for a subset of what the
 * user already granted. A session with no scopes satisfies only a request with no scopes.
 */
export function sessionSatisfies(session: AuthSession, scopes: readonly string[]): boolean {
  const held = new Set(normalizeScopes(session.scopes));
  return normalizeScopes(scopes).every((scope) => held.has(scope));
}

/** The session a `getSession` call should be answered with, or null when none fits. */
export function selectSession(
  sessions: readonly AuthSession[],
  scopes: readonly string[],
): AuthSession | null {
  for (const session of sessions) {
    if (sessionSatisfies(session, scopes)) return session;
  }
  return null;
}

/**
 * Validate one session a provider returned.
 *
 * Providers are extension code, so their answers are parsed with the same suspicion as any
 * other message crossing the boundary: a session with no token, no id, or a token far larger
 * than any real one is dropped rather than handed to the extension that asked, which would
 * otherwise send it to a server as a bearer credential.
 */
export function parseSession(raw: unknown): AuthSession | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.slice(0, 200) : '';
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken : '';
  if (id.length === 0 || accessToken.length === 0 || accessToken.length > MAX_TOKEN_CHARS) {
    return null;
  }
  const accountRaw = record.account;
  const account =
    accountRaw !== null && typeof accountRaw === 'object' && !Array.isArray(accountRaw)
      ? (accountRaw as Record<string, unknown>)
      : {};
  const label = typeof account.label === 'string' ? account.label.slice(0, 200) : '';
  const accountId = typeof account.id === 'string' ? account.id.slice(0, 200) : label;
  if (label.length === 0 && accountId.length === 0) return null;
  return {
    id,
    accessToken,
    account: {
      id: accountId.length > 0 ? accountId : label,
      label: label.length > 0 ? label : accountId,
    },
    scopes: normalizeScopes(record.scopes),
  };
}

/** Validate a provider's whole answer, bounded. */
export function parseSessionList(raw: unknown): AuthSession[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthSession[] = [];
  for (const entry of raw.slice(0, MAX_AUTH_SESSIONS)) {
    const session = parseSession(entry);
    if (session !== null) out.push(session);
  }
  return out;
}

// ---------------------------------------------------------------------------
// URI handlers and the loopback callback
// ---------------------------------------------------------------------------
/** The scheme AXIOM answers to, both as a deep link and inside `asExternalUri`. */
export const HANDLER_URI_SCHEME = 'axiom';
/** The only path prefix the callback server serves. */
export const CALLBACK_PATH_PREFIX = '/axiom-uri/';
/** Longest query AXIOM will carry from a browser redirect into an extension. */
export const MAX_CALLBACK_QUERY_CHARS = 4 * 1024;

const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{32,86}$/;

/**
 * A callback token, as minted by `asExternalUri` and as it comes back from the browser.
 *
 * The length floor is the security property: this token is the only thing standing between
 * an OAuth redirect and any other local process that guesses a URL, so a short or
 * low-entropy token is not accepted even if AXIOM minted it.
 */
export function isCallbackToken(value: unknown): value is string {
  return typeof value === 'string' && CALLBACK_TOKEN.test(value);
}

/** The path the loopback server listens for, for one minted token. */
export function callbackPath(token: string): string {
  return CALLBACK_PATH_PREFIX + token;
}

/**
 * Recover the token from a request the loopback server received.
 *
 * Exact prefix, exactly one segment, nothing else served. A request for anything else gets
 * no answer at all, because the callback server is not a web server: it exists to receive one
 * redirect per minted token and to be uninteresting to everything else on the machine.
 */
export function parseCallbackToken(pathname: string): string | null {
  if (!pathname.startsWith(CALLBACK_PATH_PREFIX)) return null;
  const token = pathname.slice(CALLBACK_PATH_PREFIX.length);
  return isCallbackToken(token) ? token : null;
}

/** The URL an extension hands to a browser as its redirect target. */
export function loopbackCallbackUrl(port: number, token: string): string {
  return 'http://127.0.0.1:' + String(port) + callbackPath(token);
}

export interface ExtensionUri {
  extensionId: string;
  path: string;
  query: string;
  fragment: string;
}

/**
 * Parse a `axiom://<extension.id>/path?query#fragment` URI.
 *
 * The authority is the extension id, which is upstream's convention and the reason this can
 * be routed at all: a deep link arriving from the OS names the extension it is for, and Main
 * can check that against who registered a handler instead of broadcasting it to every host.
 */
export function parseExtensionUri(raw: unknown): ExtensionUri | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8 * 1024) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== HANDLER_URI_SCHEME + ':') return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  const extensionId = url.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(extensionId)) return null;
  return {
    extensionId,
    path: url.pathname.slice(0, 2_048),
    query: url.search.replace(/^\?/, '').slice(0, MAX_CALLBACK_QUERY_CHARS),
    fragment: url.hash.replace(/^#/, '').slice(0, 2_048),
  };
}

/** Rebuild the URI string an extension's handler is given. */
export function formatExtensionUri(uri: ExtensionUri): string {
  const path = uri.path.startsWith('/') ? uri.path : '/' + uri.path;
  const query = uri.query.length > 0 ? '?' + uri.query : '';
  const fragment = uri.fragment.length > 0 ? '#' + uri.fragment : '';
  return HANDLER_URI_SCHEME + '://' + uri.extensionId + path + query + fragment;
}

/**
 * Combine the query recorded when a callback was minted with the one the browser delivered.
 *
 * The redirect carries the answer (`code`, `state`, or `error`), and the extension's own
 * parameters were fixed at mint time. Delivered parameters win on a collision — they are the
 * provider's response, and silently keeping a stale value would make a failed round trip look
 * like a successful one.
 */
export function mergeCallbackQuery(minted: string, delivered: string): string {
  const params = new URLSearchParams(minted.slice(0, MAX_CALLBACK_QUERY_CHARS));
  for (const [key, value] of new URLSearchParams(delivered.slice(0, MAX_CALLBACK_QUERY_CHARS))) {
    params.set(key, value);
  }
  return params.toString().slice(0, MAX_CALLBACK_QUERY_CHARS);
}
