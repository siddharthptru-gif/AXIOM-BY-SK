import { useEffect, useState } from 'react';
import type { AccountProfileInfo } from '../../../common/ipc';
import { useAuth } from '../state/auth';
import { DialogFrame } from './Modal';
import { ShieldIcon } from './icons';

/**
 * Account profile panel.
 *
 * The account UI used to be a two-line context menu with the name and email greyed
 * out, which gave no way to see who was signed in at a glance and no explanation of
 * what signing out would do. This states the account plainly, explains that local data
 * is per-account, and makes signing out a deliberate action with a described outcome.
 *
 * The profile summary comes from Main and carries no path, email or user id — the
 * renderer is told THAT data is separated, never where it lives.
 */
function initials(name: string | null, email: string | null): string {
  const source = (name ?? email ?? 'A').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'A';
  }
  return source.slice(0, 2).toUpperCase() || 'A';
}

export function ProfileView({ onClose }: { onClose: () => void }) {
  const { user, status, signOut } = useAuth();
  const [profile, setProfile] = useState<AccountProfileInfo | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.axiom.accountProfile
      .get()
      .then((info) => {
        if (!cancelled) setProfile(info);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The gate takes over the whole window once the session is gone, so the dialog
  // closes itself rather than lingering over a screen it no longer belongs to.
  useEffect(() => {
    if (status === 'signedOut') onClose();
  }, [status, onClose]);

  const displayName = user?.name ?? user?.email ?? 'Signed in';

  return (
    <DialogFrame
      onClose={onClose}
      overlayClassName="profile-overlay"
      cardClassName="profile-card"
      ariaLabel="Your AXIOM account"
    >
      <header className="profile-head">
        <span className="profile-avatar" aria-hidden="true">
          {initials(user?.name ?? null, user?.email ?? null)}
        </span>
        <div className="profile-identity">
          <strong className="profile-name">{displayName}</strong>
          {user?.email ? <span className="profile-email">{user.email}</span> : null}
        </div>
        <button type="button" className="icon-btn profile-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <section className="profile-section" aria-label="Local data">
        <div className="profile-section-head">
          <ShieldIcon size={14} />
          <strong>This account&apos;s data</strong>
        </div>
        <p className="profile-copy">
          Projects, conversations, Build history and trusted folders are stored separately for each
          account on this computer. Signing in with a different Google account shows that
          account&apos;s work, never this one&apos;s.
        </p>
        {profile ? (
          <dl className="profile-facts">
            <div>
              <dt>Storage</dt>
              <dd>{profile.signedInProfile ? 'Private to this account' : 'Not signed in'}</dd>
            </div>
            <div>
              <dt>Stored items</dt>
              <dd>{profile.entries}</dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd>
                <code>{profile.reference}</code>
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="profile-section" aria-label="Sign out">
        <div className="profile-section-head">
          <strong>Sign out</strong>
        </div>
        <p className="profile-copy">
          AXIOM returns to the sign-in screen. Nothing is deleted — sign back in with this account
          and everything is where you left it. Signing in as someone else restarts AXIOM so it loads
          that account&apos;s data cleanly.
        </p>
        <button
          type="button"
          className="btn profile-signout"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            signOut();
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </section>
    </DialogFrame>
  );
}
