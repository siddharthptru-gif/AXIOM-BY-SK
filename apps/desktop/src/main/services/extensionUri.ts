import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { rootLogger } from '@axiom/shared';
import {
  CALLBACK_TTL_MS,
  HANDLER_URI_SCHEME,
  MAX_CALLBACK_QUERY_CHARS,
  MAX_PENDING_CALLBACKS,
  formatExtensionUri,
  loopbackCallbackUrl,
  mergeCallbackQuery,
  parseCallbackToken,
  parseExtensionUri,
} from '../../common/vscodeAuth';

/**
 * `window.registerUriHandler` and `env.asExternalUri` — how an extension's own OAuth round trip
 * gets back into AXIOM.
 *
 * The problem this solves is specific. An extension that authenticates against its own service
 * does the whole flow itself: it builds an authorization URL with PKCE, opens the system
 * browser, and needs the provider's redirect to arrive back in its own process. Upstream gives
 * it `asExternalUri(Uri.parse('vscode://publisher.name/callback'))` and routes the answer
 * through the desktop protocol handler.
 *
 * AXIOM does not claim an OS protocol handler, so a redirect to `axiom://…` would land nowhere.
 * Instead `asExternalUri` mints a **single-use loopback URL** and hands that to the extension as
 * its redirect target. When the browser follows the redirect, the local server recognises the
 * token, rebuilds the `axiom://<extension id>/…` URI with the delivered query merged in, and
 * calls the extension's registered handler. This is the same mechanism `googleOAuth.ts` uses for
 * Axiom's own sign-in, for the same reason: no embedded webview, and no protocol registration.
 *
 * The security properties this file is responsible for:
 *
 *   - **A callback belongs to one extension.** The token is minted against the extension that
 *     asked, and the URI delivered to a handler is rebuilt from the recorded extension id, so a
 *     redirect cannot be steered into a different extension's handler.
 *   - **A callback is single-use and short-lived.** Redeemed once, then forgotten; expired after
 *     `CALLBACK_TTL_MS`. An OAuth `code` replayed against a stale URL reaches nobody.
 *   - **The server exists only while it is needed.** It binds an ephemeral port on 127.0.0.1
 *     when the first callback is minted and closes as soon as none are outstanding, so AXIOM is
 *     not holding an open local port for the life of the session.
 *   - **Nothing else is served.** Any path that is not exactly one valid token gets 404 and
 *     nothing is logged about it.
 */
const log = rootLogger.child('extension-uri');

/** What the browser shows after a redirect lands, before the user returns to AXIOM. */
const DELIVERED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>AXIOM</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0e0e11;color:#e7e7ef;
font-family:system-ui,Segoe UI,sans-serif}.card{text-align:center}.card h1{font-size:20px;margin:0 0 8px}
.card p{color:#a2a2b0;margin:0}</style></head><body><div class="card">
<h1>Signed in</h1><p>You can close this tab and return to AXIOM.</p>
</div></body></html>`;

export interface UriHostBridge {
  /** Post a URI to an extension's host. False when it has no running host. */
  deliverUri(extensionId: string, uri: string): boolean;
  /** Fire `onUri` for one extension so a handler can register before delivery. */
  activateForUri(extensionId: string): Promise<void>;
}

let bridge: UriHostBridge | null = null;

export function configureExtensionUri(next: UriHostBridge): void {
  bridge = next;
}

function requireBridge(): UriHostBridge {
  if (bridge === null) throw new Error('The extension URI broker is not configured.');
  return bridge;
}

/** Extensions that have called `registerUriHandler` in their current host. */
const handlers = new Set<string>();

export function registerExtensionUriHandler(extensionId: string): void {
  handlers.add(extensionId.toLowerCase());
}

export function unregisterExtensionUriHandler(extensionId: string): void {
  handlers.delete(extensionId.toLowerCase());
}

export function listExtensionUriHandlers(): string[] {
  return [...handlers].sort();
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
/**
 * Route one `axiom://<extension id>/…` URI to the extension it names.
 *
 * The extension is activated first when it is not running: `onUri` is an activation event
 * precisely because a deep link is often the first thing that happens after a browser round
 * trip, and an extension that is not yet started has no handler to receive it.
 */
export async function deliverExtensionUri(raw: string): Promise<boolean> {
  const parsed = parseExtensionUri(raw);
  if (parsed === null) return false;
  const host = requireBridge();
  if (!handlers.has(parsed.extensionId)) {
    try {
      await host.activateForUri(parsed.extensionId);
    } catch (error) {
      log.warn('Activating an extension for a URI failed', {
        extensionId: parsed.extensionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const delivered = host.deliverUri(parsed.extensionId, formatExtensionUri(parsed));
  if (!delivered) {
    log.warn('A URI arrived for an extension with no running handler', {
      extensionId: parsed.extensionId,
    });
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// The loopback callback
// ---------------------------------------------------------------------------
interface PendingCallback {
  extensionId: string;
  path: string;
  query: string;
  fragment: string;
  expiresAt: number;
}

const pending = new Map<string, PendingCallback>();
let server: http.Server | null = null;
let serverPort = 0;
let starting: Promise<number> | null = null;

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of [...pending]) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
  if (pending.size === 0) closeServer();
}

function closeServer(): void {
  const current = server;
  server = null;
  serverPort = 0;
  if (current === null) return;
  try {
    current.close();
  } catch {
    // Already closing.
  }
}

function onRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  let pathname = '/';
  let deliveredQuery = '';
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    pathname = url.pathname;
    deliveredQuery = url.search.replace(/^\?/, '').slice(0, MAX_CALLBACK_QUERY_CHARS);
  } catch {
    // Falls through to the 404 below.
  }
  const token = parseCallbackToken(pathname);
  const entry = token === null ? undefined : pending.get(token);
  if (token === null || entry === undefined || entry.expiresAt <= Date.now()) {
    response.statusCode = 404;
    response.end();
    prune();
    return;
  }
  // Single use: redeemed before the handler runs, so a replayed redirect finds nothing.
  pending.delete(token);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(DELIVERED_HTML);
  const uri = formatExtensionUri({
    extensionId: entry.extensionId,
    path: entry.path,
    query: mergeCallbackQuery(entry.query, deliveredQuery),
    fragment: entry.fragment,
  });
  void deliverExtensionUri(uri);
  prune();
}

/** Bind an ephemeral loopback port, once, and reuse it while callbacks are outstanding. */
function ensureServer(): Promise<number> {
  if (server !== null && serverPort > 0) return Promise.resolve(serverPort);
  if (starting !== null) return starting;
  starting = new Promise<number>((resolvePort, rejectPort) => {
    const created = http.createServer(onRequest);
    created.on('error', (error) => {
      closeServer();
      starting = null;
      rejectPort(error);
    });
    created.listen(0, '127.0.0.1', () => {
      const address = created.address();
      if (address === null || typeof address === 'string') {
        closeServer();
        starting = null;
        rejectPort(new Error('The callback server could not report its port.'));
        return;
      }
      server = created;
      serverPort = address.port;
      starting = null;
      resolvePort(address.port);
    });
  });
  return starting;
}

/**
 * `env.asExternalUri`.
 *
 * Three cases, and only one of them does anything interesting:
 *
 *   - An `http`/`https` URI is returned unchanged. On the desktop there is nothing to tunnel,
 *     and rewriting a URL an extension is about to open in a browser would break it.
 *   - An `axiom://<own extension id>/…` URI becomes a single-use loopback callback. This is the
 *     OAuth redirect case, and the recorded query is merged with whatever the provider delivers.
 *   - Anything else is returned unchanged, which is also upstream's behaviour: an unknown scheme
 *     is the extension's business, not AXIOM's.
 *
 * An extension may only mint a callback addressed to itself. Allowing otherwise would let one
 * extension hand out a URL that delivers a provider's `code` into another extension's handler.
 */
export async function mintExternalUri(extensionId: string, raw: string): Promise<string> {
  const owner = extensionId.toLowerCase();
  const scheme = raw.slice(0, Math.max(0, raw.indexOf(':'))).toLowerCase();
  if (scheme !== HANDLER_URI_SCHEME) return raw;
  const parsed = parseExtensionUri(raw);
  if (parsed === null) return raw;
  if (parsed.extensionId !== owner) {
    throw new Error('An extension can only ask for a callback addressed to itself.');
  }
  prune();
  if (pending.size >= MAX_PENDING_CALLBACKS) {
    throw new Error('Too many sign-in callbacks are already waiting.');
  }
  const port = await ensureServer();
  const token = randomBytes(32).toString('base64url');
  pending.set(token, {
    extensionId: owner,
    path: parsed.path,
    query: parsed.query,
    fragment: parsed.fragment,
    expiresAt: Date.now() + CALLBACK_TTL_MS,
  });
  log.info('Minted a sign-in callback for an extension', { extensionId: owner });
  return loopbackCallbackUrl(port, token);
}

/** How many callbacks are outstanding, for diagnostics and tests. */
export function pendingCallbackCount(): number {
  prune();
  return pending.size;
}

/** Drop every handler and callback, and release the port. Called when all hosts stop. */
export function resetExtensionUriState(): void {
  handlers.clear();
  pending.clear();
  closeServer();
}
