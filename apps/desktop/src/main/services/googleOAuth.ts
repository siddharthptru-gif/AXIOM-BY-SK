import http from 'node:http';
import { shell } from 'electron';
import { rootLogger } from '@axiom/shared';
import { getSupabase } from './supabase';
import { OAUTH_LOOPBACK_PORT, OAUTH_REDIRECT_URL, SUPABASE_URL } from '../config';

/**
 * Google OAuth handler (Main process, PRD Epoch E). Owns the desktop OAuth
 * mechanics ONLY — Google is the sole provider. Uses the user's default system
 * browser (never an embedded webview), PKCE, and a short-lived loopback server
 * to capture the redirect `code`, which is exchanged for a session by the
 * Supabase client. Tokens never touch the renderer or the logs (INV-3).
 */
const log = rootLogger.child('auth:oauth');

/** Shown in the browser tab after the redirect, then the user returns to Axiom. */
const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Axiom</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0e0e11;color:#e7e7ef;
font-family:system-ui,Segoe UI,sans-serif}.card{text-align:center}.card h1{font-size:20px;margin:0 0 8px}
.card p{color:#a2a2b0;margin:0}</style></head><body><div class="card">
<h1>You're signed in to Axiom</h1><p>You can close this tab and return to the app.</p>
</div></body></html>`;

/**
 * Runs a temporary loopback HTTP server, invokes `start` (which opens the system
 * browser), and resolves with the OAuth `code` when Supabase redirects back.
 * Rejects on a provider error or a 5-minute timeout. Always tears the server down.
 */
function captureOAuthCode(start: () => Promise<void>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let server: http.Server | undefined;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server?.close();
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URL);
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (!code && !err) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SUCCESS_HTML);
      cleanup();
      if (err) reject(new Error(err));
      else if (code) resolve(code);
    });

    server.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });

    timer = setTimeout(
      () => {
        cleanup();
        reject(new Error('Sign-in timed out. Please try again.'));
      },
      5 * 60 * 1000,
    );

    server.listen(OAUTH_LOOPBACK_PORT, '127.0.0.1', () => {
      void start().catch((e: unknown) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  });
}

/**
 * Full Google sign-in: open the system browser at Google's consent page (via
 * Supabase OAuth, PKCE), capture the redirect code on the loopback, and exchange
 * it for a persisted session. Throws a user-facing Error on any failure.
 */
export async function runGoogleOAuth(): Promise<void> {
  const supabase = getSupabase();
  log.info('Starting Google sign-in');
  const code = await captureOAuthCode(async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
        skipBrowserRedirect: true,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    if (error) throw new Error(error.message);
    if (!data.url) throw new Error('Could not start Google sign-in.');
    const authorizationUrl = new URL(data.url);
    const expectedOrigin = new URL(SUPABASE_URL).origin;
    if (
      authorizationUrl.protocol !== 'https:' ||
      authorizationUrl.origin !== expectedOrigin ||
      authorizationUrl.username ||
      authorizationUrl.password
    ) {
      throw new Error('The authentication service returned an unexpected authorization URL.');
    }
    await shell.openExternal(authorizationUrl.toString());
  });
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw new Error(error.message);
  log.info('Google sign-in complete');
}
