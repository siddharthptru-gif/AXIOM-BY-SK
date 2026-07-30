import { useState } from 'react';
import type { AuthUser } from '../../../common/ipc';
import { useAuth } from '../state/auth';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { LoginView } from './LoginView';
import { ProfileView } from './ProfileView';

/**
 * Account item for the activity bar (PRD Epoch E). Authentication is optional:
 * signed-out users keep the complete local workbench and can explicitly open the
 * Google sign-in dialog for cloud features. Initials avoid external avatar loads.
 */
function initials(user: AuthUser | null): string {
  const src = (user?.name ?? user?.email ?? 'A').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'A';
  }
  return src.slice(0, 2).toUpperCase() || 'A';
}

export function AccountButton() {
  const { status, user, signOut } = useAuth();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const statusLabel =
    status === 'loading'
      ? 'Checking account…'
      : status === 'signingIn'
        ? 'Google sign-in in progress…'
        : status === 'error'
          ? 'Sign-in needs attention'
          : 'Not signed in';
  const label = user?.name ?? user?.email ?? statusLabel;

  const entries: MenuEntry[] = [];
  if (user?.name) entries.push({ label: user.name, onSelect: () => undefined, disabled: true });
  if (user?.email) entries.push({ label: user.email, onSelect: () => undefined, disabled: true });
  if (entries.length > 0) entries.push({ separator: true });

  if (status === 'signedIn') {
    // Profile first: it explains what signing out actually does, which the bare
    // menu item never did.
    entries.push({ label: 'Your Profile…', onSelect: () => setProfileOpen(true) });
    entries.push({ separator: true });
    entries.push({ label: 'Sign Out', onSelect: signOut });
  } else {
    entries.push({ label: statusLabel, onSelect: () => undefined, disabled: true });
    if (status !== 'loading') {
      entries.push({ separator: true });
      entries.push({
        label: status === 'signingIn' ? 'View Sign-In Status…' : 'Sign In with Google…',
        onSelect: () => setLoginOpen(true),
      });
    }
  }

  return (
    <>
      <button
        type="button"
        className="activity-item account-item"
        title={`Account: ${label}`}
        aria-label={`Account: ${label}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right + 4, y: r.top });
        }}
      >
        <span className="account-initials">{initials(user)}</span>
      </button>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => setMenu(null)} />
      ) : null}
      {loginOpen ? <LoginView onClose={() => setLoginOpen(false)} /> : null}
      {profileOpen ? <ProfileView onClose={() => setProfileOpen(false)} /> : null}
    </>
  );
}
