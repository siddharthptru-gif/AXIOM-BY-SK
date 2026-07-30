import { runGoogleOAuth } from './googleOAuth';
import {
  getState,
  initSessionManager,
  registerAuthWebContents,
  signOut as endSession,
} from './sessionManager';

/**
 * Authentication service (Main process, PRD Epoch E). A thin orchestration layer
 * over the focused modules — the Google OAuth handler and the session manager —
 * so authentication logic stays modular and is never hardcoded across the app.
 * Google OAuth is the ONLY supported method (no email/password, OTP, magic link,
 * or phone). Tokens never leave Main (INV-3).
 */

/** Re-exported so IPC/renderer wiring depends only on the auth service facade. */
export { getState, registerAuthWebContents };

/** Wire up the session lifecycle at startup (restore, validate, auto-refresh). */
export function initAuth(): void {
  initSessionManager();
}

/** Sign in with Google via the system browser. */
export async function signInWithGoogle(): Promise<void> {
  await runGoogleOAuth();
}

/** Sign out and clear the persisted session. */
export async function signOut(): Promise<void> {
  await endSession();
}
