import { app, type WebContents } from 'electron';
import { rootLogger } from '@axiom/shared';
import type { AuthError, Session, User } from '@supabase/supabase-js';
import { getSupabase } from './supabase';
import { reconcileActiveAccount } from './accountProfile';
import { IPC, type AuthState, type AuthUser } from '../../common/ipc';

/**
 * Session manager (Main process, PRD Epoch E). Owns the session lifecycle —
 * restore, server-side validation, auto-refresh, sign-out — and broadcasts a
 * *sanitized* auth state (never tokens) to subscribed renderers. Tolerant of
 * offline startup: a cached session is kept when the network is unavailable and
 * only cleared when the server actually rejects it.
 */
const log = rootLogger.child('auth:session');

const subscribers = new Set<WebContents>();

function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    typeof meta.full_name === 'string'
      ? meta.full_name
      : typeof meta.name === 'string'
        ? meta.name
        : null;
  const avatarUrl =
    typeof meta.avatar_url === 'string'
      ? meta.avatar_url
      : typeof meta.picture === 'string'
        ? meta.picture
        : null;
  return { id: user.id, email: user.email ?? null, name, avatarUrl };
}

export function sessionToState(session: Session | null): AuthState {
  return session?.user
    ? { status: 'signedIn', user: toAuthUser(session.user) }
    : { status: 'signedOut', user: null };
}

function broadcast(state: AuthState): void {
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send(IPC.authStateChanged, state);
  }
}

/** True once a relaunch is committed, so concurrent broadcasts cannot queue a second. */
let relaunching = false;

/**
 * Publish an auth state, first making sure local data belongs to whoever is signed in.
 *
 * Every store for the previous account is already open by the time a different user
 * signs in, so the only way to guarantee they never see each other's projects and
 * conversations is to rebind userData — which Electron only permits before startup.
 * AXIOM therefore records the new owner and restarts into it.
 *
 * `app.quit()` rather than `exit()`: unsaved editors still get their close prompts,
 * and a user who cancels keeps the session they already had.
 */
function publish(state: AuthState): void {
  if (relaunching) return;
  let decision: ReturnType<typeof reconcileActiveAccount> = 'unchanged';
  try {
    decision = reconcileActiveAccount(state.user?.id ?? null);
  } catch (error) {
    log.warn('Could not reconcile the active account profile', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (decision === 'relaunch') {
    relaunching = true;
    log.info('Signed in as a different account; restarting to load that account data');
    broadcast(state);
    app.relaunch();
    app.quit();
    return;
  }
  broadcast(state);
}

/** Register a renderer to receive auth state changes; auto-cleans on destroy. */
export function registerAuthWebContents(wc: WebContents): void {
  if (subscribers.has(wc)) return;
  subscribers.add(wc);
  wc.once('destroyed', () => subscribers.delete(wc));
}

/** Current auth state from the persisted session (no network round-trip). */
export async function getState(): Promise<AuthState> {
  const { data } = await getSupabase().auth.getSession();
  return sessionToState(data.session);
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

/** A network/transient failure (offline) vs. a definitive auth rejection. */
function isDefinitiveAuthError(error: AuthError): boolean {
  const status = error.status ?? 0;
  return status === 401 || status === 403 || status === 400;
}

/**
 * Restore the persisted session, reflect it immediately for a fast startup,
 * then validate it against the server: a definitive rejection (expired/revoked
 * and un-refreshable) signs the user out; a network error keeps the cached
 * session so the app works offline.
 */
async function restoreAndValidate(): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) {
    publish({ status: 'signedOut', user: null });
    return;
  }
  // Optimistic: show the restored session right away. This is also where a first
  // start after upgrading binds the signed-in account's profile and adopts the
  // pre-isolation data into it.
  publish(sessionToState(session));
  // Validate against the server (also forces a refresh if near expiry).
  const { data: userData, error } = await supabase.auth.getUser();
  if (error) {
    if (isDefinitiveAuthError(error)) {
      log.info('Restored session rejected by server; signing out');
      await supabase.auth.signOut().catch(() => undefined);
      publish({ status: 'signedOut', user: null });
    } else {
      log.warn('Session validation offline; keeping cached session');
    }
    return;
  }
  if (userData.user) publish({ status: 'signedIn', user: toAuthUser(userData.user) });
}

/**
 * Initialize the session manager once at startup: subscribe to session changes
 * (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT), restore + validate the persisted
 * session, and start the background auto-refresh loop (required off-browser).
 */
export function initSessionManager(): void {
  const supabase = getSupabase();
  // Log the event name only — never the session/tokens (INV-3).
  supabase.auth.onAuthStateChange((event, session) => {
    log.debug('auth state change', { event });
    publish(sessionToState(session));
  });
  void restoreAndValidate().catch(() => publish({ status: 'signedOut', user: null }));
  void supabase.auth.startAutoRefresh();
}
