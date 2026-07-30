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
import type { WorkspaceTrustState } from '../../../common/ipc';
import { useWorkspace } from './workspace';

export type WorkspaceTrustStatus = 'idle' | 'checking' | 'trusted' | 'restricted' | 'error';

interface WorkspaceTrustValue {
  status: WorkspaceTrustStatus;
  trusted: boolean;
  restricted: boolean;
  error: string | null;
  trust: () => Promise<void>;
  revoke: () => Promise<void>;
}

interface TrustSnapshot {
  root: string | null;
  status: WorkspaceTrustStatus;
  error: string | null;
}

const WorkspaceTrustContext = createContext<WorkspaceTrustValue | null>(null);

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceTrustProvider({ children }: { children: ReactNode }) {
  const { rootPath } = useWorkspace();
  const requestRef = useRef(0);
  const rootRef = useRef(rootPath);
  rootRef.current = rootPath;
  const [snapshot, setSnapshot] = useState<TrustSnapshot>({
    root: null,
    status: 'idle',
    error: null,
  });

  useEffect(() => {
    const request = ++requestRef.current;
    if (!rootPath) {
      setSnapshot({ root: null, status: 'idle', error: null });
      return;
    }

    setSnapshot({ root: rootPath, status: 'checking', error: null });
    void window.axiom.workspaceTrust
      .get(rootPath)
      .then((state: WorkspaceTrustState) => {
        if (request !== requestRef.current || rootRef.current !== rootPath) return;
        setSnapshot({
          root: rootPath,
          status: state.trusted ? 'trusted' : 'restricted',
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (request !== requestRef.current || rootRef.current !== rootPath) return;
        setSnapshot({ root: rootPath, status: 'error', error: detailOf(error) });
      });
  }, [rootPath]);

  const trust = useCallback(async (): Promise<void> => {
    const root = rootRef.current;
    if (!root) return;
    const request = ++requestRef.current;
    setSnapshot({ root, status: 'checking', error: null });
    try {
      const state = await window.axiom.workspaceTrust.set(root, true);
      if (request !== requestRef.current || rootRef.current !== root) return;
      setSnapshot({
        root,
        status: state.trusted ? 'trusted' : 'restricted',
        error: null,
      });
    } catch (error) {
      if (request !== requestRef.current || rootRef.current !== root) return;
      setSnapshot({ root, status: 'error', error: detailOf(error) });
    }
  }, []);

  const revoke = useCallback(async (): Promise<void> => {
    const root = rootRef.current;
    if (!root) return;
    const request = ++requestRef.current;
    setSnapshot({ root, status: 'checking', error: null });
    try {
      const state = await window.axiom.workspaceTrust.set(root, false);
      if (request !== requestRef.current || rootRef.current !== root) return;
      setSnapshot({
        root,
        status: state.trusted ? 'trusted' : 'restricted',
        error: null,
      });
    } catch (error) {
      if (request !== requestRef.current || rootRef.current !== root) return;
      setSnapshot({ root, status: 'error', error: detailOf(error) });
    }
  }, []);

  // A root switch is restricted immediately during render, before the effect that
  // checks the new root runs. This prevents one frame of stale trust capability.
  const currentStatus: WorkspaceTrustStatus = !rootPath
    ? 'idle'
    : snapshot.root === rootPath
      ? snapshot.status
      : 'checking';
  const trusted = currentStatus === 'trusted';
  const restricted = rootPath !== null && !trusted;
  const error = snapshot.root === rootPath ? snapshot.error : null;

  const value = useMemo<WorkspaceTrustValue>(
    () => ({ status: currentStatus, trusted, restricted, error, trust, revoke }),
    [currentStatus, trusted, restricted, error, trust, revoke],
  );

  return <WorkspaceTrustContext.Provider value={value}>{children}</WorkspaceTrustContext.Provider>;
}

export function useWorkspaceTrust(): WorkspaceTrustValue {
  const value = useContext(WorkspaceTrustContext);
  if (!value) throw new Error('useWorkspaceTrust must be used within WorkspaceTrustProvider');
  return value;
}
