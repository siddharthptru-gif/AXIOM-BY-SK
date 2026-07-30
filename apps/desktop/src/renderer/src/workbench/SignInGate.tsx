import { useAuth } from '../state/auth';
import { Logo } from './icons';

/**
 * The sign-in gate.
 *
 * AXIOM keeps every account's work in its own local store — projects, conversations,
 * Build history, trusted folders. That separation is only meaningful if AXIOM knows
 * WHICH account is using it, so the workbench is not composed at all until someone is
 * signed in. Previously the app remained fully usable after signing out, which meant
 * the next person to sit down inherited the previous account's projects and chats.
 *
 * Deliberately not a dismissable dialog: there is no "skip" here, because skipping
 * would put the user back in the state this exists to prevent.
 */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

export function SignInGate() {
  const { status, error, signInGoogle } = useAuth();
  const busy = status === 'signingIn';

  return (
    <div className="signin-gate" role="main" aria-label="Sign in to AXIOM">
      <div className="signin-panel">
        <div className="signin-brand">
          <span className="signin-logo" aria-hidden="true">
            <Logo size={30} />
          </span>
          <div>
            <strong className="signin-title">AXIOM</strong>
            <span className="signin-tagline">Think. Build. Ship.</span>
          </div>
        </div>

        <h1 className="signin-heading">Sign in to continue</h1>
        <p className="signin-copy">
          Your projects, conversations and Build history are stored separately for each account on
          this computer. AXIOM needs to know who you are before it opens any of them.
        </p>

        <button
          type="button"
          className="signin-google"
          disabled={busy}
          autoFocus
          onClick={signInGoogle}
        >
          {busy ? <span className="spinner spinner-dark" aria-hidden="true" /> : <GoogleMark />}
          <span>
            {busy
              ? 'Waiting for Google…'
              : status === 'error'
                ? 'Try Google sign-in again'
                : 'Continue with Google'}
          </span>
        </button>

        {busy ? (
          <p className="signin-hint" role="status">
            Finish signing in in your browser, then come back to AXIOM.
          </p>
        ) : null}

        {status === 'error' && error ? (
          <div className="signin-error" role="alert">
            <p>{error}</p>
          </div>
        ) : null}

        <ul className="signin-facts">
          <li>Switching accounts never mixes one account&apos;s work into another.</li>
          <li>Sign back in with the same account and everything is exactly where you left it.</li>
          <li>Your code stays on this computer. Sign-in identifies you; it does not upload work.</li>
        </ul>

        <p className="signin-legal">Google Sign-In · OAuth PKCE</p>
      </div>
    </div>
  );
}

/** Shown while Main is still resolving the persisted session. */
export function SignInLoading() {
  return (
    <div className="signin-gate" role="status" aria-label="Checking your account">
      <div className="signin-panel signin-panel-quiet">
        <span className="signin-logo" aria-hidden="true">
          <Logo size={30} />
        </span>
        <span className="spinner" aria-hidden="true" />
        <p className="signin-copy">Checking your account…</p>
      </div>
    </div>
  );
}
