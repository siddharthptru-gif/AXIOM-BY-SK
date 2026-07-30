import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthState, AuthStatus, AuthUser } from '../../../common/ipc';

/**
 * Authentication state management (PRD Epoch E). Subscribes to Main's auth
 * broadcasts, exposes the current status/user, and provides sign-in/out actions.
 * The renderer only ever sees a sanitized user — tokens live in Main.
 */
interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  signInGoogle: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_STATUSES: readonly AuthStatus[] = [
  'loading',
  'signedOut',
  'signingIn',
  'signedIn',
  'error',
];

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isAuthUser(value: unknown): value is AuthUser {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === 'string' &&
    isNullableString(user.email) &&
    isNullableString(user.name) &&
    isNullableString(user.avatarUrl)
  );
}

function isAuthState(value: unknown): value is AuthState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!AUTH_STATUSES.includes(state.status as AuthStatus)) return false;
  if (state.user !== null && !isAuthUser(state.user)) return false;
  if (state.error !== undefined && typeof state.error !== 'string') return false;
  return state.status !== 'signedIn' || state.user !== null;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const fail = useCallback((message: string): void => {
    setStatus('error');
    setUser(null);
    setError(message);
  }, []);

  const apply = useCallback(
    (value: unknown): void => {
      if (!isAuthState(value)) {
        fail('Axiom received an invalid authentication response. Please try again.');
        return;
      }
      setStatus(value.status);
      setUser(value.user);
      setError(value.status === 'error' ? (value.error ?? 'Authentication error') : null);
    },
    [fail],
  );

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const initialGeneration = generationRef.current;
    const unsubscribe = window.axiom.auth.onStateChanged((state) => {
      if (cancelled) return;
      generationRef.current += 1;
      apply(state);
    });

    void window.axiom.auth
      .getState()
      .then((state) => {
        if (!cancelled && generationRef.current === initialGeneration) apply(state);
      })
      .catch((cause: unknown) => {
        if (!cancelled && generationRef.current === initialGeneration) {
          fail(errorMessage(cause, 'Unable to load authentication state.'));
        }
      });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
    };
  }, [apply, fail]);

  const signInGoogle = useCallback(() => {
    const operationGeneration = ++generationRef.current;
    setError(null);
    setUser(null);
    setStatus('signingIn');

    void (async () => {
      try {
        await window.axiom.auth.signInGoogle();
        if (!mountedRef.current || generationRef.current !== operationGeneration) return;

        // A broadcast normally supplies the final state. If no newer state was
        // observed, reconcile every valid Main response instead of leaving the
        // renderer indefinitely in signingIn.
        const state = await window.axiom.auth.getState();
        if (mountedRef.current && generationRef.current === operationGeneration) apply(state);
      } catch (cause: unknown) {
        if (mountedRef.current && generationRef.current === operationGeneration) {
          fail(errorMessage(cause, 'Google sign-in failed. Please try again.'));
        }
      }
    })();
  }, [apply, fail]);

  const signOut = useCallback(() => {
    const operationGeneration = ++generationRef.current;
    setError(null);

    void window.axiom.auth
      .signOut()
      .then(() => {
        if (mountedRef.current && generationRef.current === operationGeneration) {
          apply({ status: 'signedOut', user: null });
        }
      })
      .catch((cause: unknown) => {
        if (mountedRef.current && generationRef.current === operationGeneration) {
          setError(errorMessage(cause, 'Sign-out failed. Please try again.'));
        }
      });
  }, [apply]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, signInGoogle, signOut }),
    [status, user, error, signInGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
