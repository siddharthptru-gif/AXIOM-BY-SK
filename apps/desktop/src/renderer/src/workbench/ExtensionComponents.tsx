import { useState, useEffect } from 'react';
import { DialogFrame } from './Modal';
import { useAuth } from '../state/auth';

/** Known publishers whose extensions carry verified blue checkmark badges. */
export const VERIFIED_PUBLISHERS = new Set([
  'microsoft',
  'ms-python',
  'ms-vscode',
  'ms-azuretools',
  'ms-toolsai',
  'ms-dotnettools',
  'vscjava',
  'github',
  'prettier',
  'esbenp',
  'dbaeumer',
  'eamodio',
  'golang',
  'redhat',
  'docker',
  'hashicorp',
  'salesforce',
  'meta',
  'google',
  'aws',
  'amazon',
  'vercel',
  'deno',
  'sublimehq',
  'antigravity',
  'axiom',
  'vuejs',
  'svelte',
  'astro-build',
  'tailscale',
  'jetbrains',
  'tabnine',
  'codeium',
  'supermaven',
  'biomejs',
  'tail-wind',
  'prisma',
]);

export function isPublisherVerified(pub: string | null | undefined, flag?: boolean): boolean {
  if (flag === true) return true;
  if (!pub) return false;
  const lower = pub.toLowerCase().trim();
  return (
    VERIFIED_PUBLISHERS.has(lower) ||
    lower.startsWith('ms-') ||
    lower.startsWith('github') ||
    lower.startsWith('google')
  );
}

/** Prominent Verified Publisher Blue Checkmark Tick Badge */
export function VerifiedBadge({
  publisher,
  isVerified,
}: {
  publisher?: string;
  isVerified?: boolean;
}) {
  if (!isPublisherVerified(publisher, isVerified)) return null;
  return (
    <span
      className="ext-verified-badge"
      title={`Verified Publisher${publisher ? `: ${publisher}` : ''}`}
      aria-label="Verified Publisher"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="8" cy="8" r="8" fill="#3794ff" />
        <path
          d="M4.5 8L7 10.5L11.5 5.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Renders extension image icon or fallback gradient initials avatar. */
export function ExtensionIconImage({
  src,
  name,
  id,
  size = 32,
}: {
  src?: string | null | undefined;
  name: string;
  id: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ borderRadius: 6, objectFit: 'cover' }}
      />
    );
  }

  const initials = getInitials(name || id);
  const bgGradient = getAvatarGradient(id || name);

  return (
    <div
      className="ext-avatar-fallback"
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: bgGradient,
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: Math.max(10, Math.floor(size * 0.42)),
        letterSpacing: '0.5px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2)',
        userSelect: 'none',
      }}
      title={name}
    >
      {initials}
    </div>
  );
}

function getInitials(title: string): string {
  const cleaned = title.replace(/^(vscode|extension|plugin|theme)-/i, '').trim();
  const words = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2 && words[0]?.[0] && words[1]?.[0]) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase() || 'EX';
}

function getAvatarGradient(seed: string): string {
  const gradients = [
    'linear-gradient(135deg, #0078d4, #00bcf2)',
    'linear-gradient(135deg, #6b21a8, #a855f7)',
    'linear-gradient(135deg, #059669, #10b981)',
    'linear-gradient(135deg, #d97706, #f59e0b)',
    'linear-gradient(135deg, #dc2626, #f87171)',
    'linear-gradient(135deg, #2563eb, #3b82f6)',
    'linear-gradient(135deg, #4f46e5, #818cf8)',
    'linear-gradient(135deg, #0891b2, #06b6d4)',
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % gradients.length;
  const fallback = 'linear-gradient(135deg, #0078d4, #00bcf2)';
  return gradients[index] ?? fallback;
}

/** Extension Authentication Modal for signing in / signing up to extension accounts. */
export function ExtensionAuthModal({
  extensionName,
  extensionId,
  onClose,
}: {
  extensionName: string;
  extensionId: string;
  onClose: () => void;
}) {
  const { status, user, signInGoogle } = useAuth();
  const [apiKey, setApiKey] = useState('');
  const [signedInLocally, setSignedInLocally] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSignInGoogle = async () => {
    setLoading(true);
    try {
      await signInGoogle();
      setSignedInLocally(true);
    } catch {
      // Ignored
    } finally {
      setLoading(false);
    }
  };

  const handleSaveApiKey = () => {
    if (apiKey.trim().length > 0) {
      localStorage.setItem(`axiom.ext.auth.${extensionId}`, apiKey.trim());
      setSignedInLocally(true);
    }
  };

  const isAuthed = status === 'signedIn' || signedInLocally;

  return (
    <DialogFrame
      onClose={onClose}
      overlayClassName="ext-detail-overlay"
      cardClassName="ext-detail-card"
      ariaLabel={`Sign in for ${extensionName}`}
    >
      <div style={{ padding: 20, minWidth: 360, maxWidth: 440 }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: 18, color: 'var(--fg-strong)' }}>
          Sign In for {extensionName}
        </h2>
        <p
          style={{ margin: '0 0 16px 0', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}
        >
          Authenticate your account to enable cloud sync, AI completions, and extended features for{' '}
          <strong>{extensionName}</strong> ({extensionId}).
        </p>

        {isAuthed ? (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#10b981',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
            }}
          >
            <span>✓ Account Connected ({user?.email ?? user?.name ?? 'Extension Authorized'})</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                localStorage.removeItem(`axiom.ext.auth.${extensionId}`);
                setSignedInLocally(false);
              }}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              Sign Out
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <button
              type="button"
              className="ext-auth-btn"
              onClick={() => void handleSignInGoogle()}
              disabled={loading}
              style={{ justifyContent: 'center', width: '100%', padding: '10px 16px' }}
            >
              {loading ? 'Connecting…' : 'Sign In with Google / AXIOM Account'}
            </button>

            <div
              style={{
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--fg-faint)',
                margin: '4px 0',
              }}
            >
              — OR ENTER EXTENSION TOKEN / API KEY —
            </div>

            <input
              type="password"
              placeholder="Paste extension API key / OAuth token"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--fg-default)',
                fontSize: 13,
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSaveApiKey}
              disabled={apiKey.trim().length === 0}
              style={{ width: '100%' }}
            >
              Save Extension Token & Connect
            </button>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
