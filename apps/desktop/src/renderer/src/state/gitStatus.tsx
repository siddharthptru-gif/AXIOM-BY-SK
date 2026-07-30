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
import type { GitChangeType } from '../../../common/ipc';
import { useWorkspace } from './workspace';
import { useWorkspaceTrust } from './workspaceTrust';
import { onGitChanged } from './gitBus';

/**
 * Git decorations (PRD Epoch D). Fetches the working-tree status for the open
 * folder and exposes it as fast lookups the Explorer uses to color files and
 * badge folders. Refreshes on the workspace refresh signal (filesystem changes)
 * and on the git-change bus (SCM mutations that only touch `.git`).
 */
interface GitDecorations {
  /** Working-tree change type for a file, keyed by root-relative path (forward slashes). */
  fileType: (rel: string) => GitChangeType | undefined;
  /** True when a directory (root-relative, forward slashes) contains any change. */
  dirHasChanges: (rel: string) => boolean;
}

const EMPTY: GitDecorations = { fileType: () => undefined, dirHasChanges: () => false };

const GitDecorationsContext = createContext<GitDecorations>(EMPTY);

export function useGitDecorations(): GitDecorations {
  return useContext(GitDecorationsContext);
}

export function GitDecorationsProvider({ children }: { children: ReactNode }) {
  const { rootPath, refreshNonce } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const gitCapability = rootPath && workspaceTrust.trusted ? rootPath : null;
  const capabilityRef = useRef<string | null>(gitCapability);
  capabilityRef.current = gitCapability;
  const [files, setFiles] = useState<Map<string, GitChangeType>>(new Map());
  const [dirs, setDirs] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    const root = gitCapability;
    if (!root || capabilityRef.current !== root) {
      setFiles(new Map());
      setDirs(new Set());
      return;
    }
    void window.axiom.git
      .status(root)
      .then((status) => {
        if (capabilityRef.current !== root) return;
        const fileMap = new Map<string, GitChangeType>();
        const dirSet = new Set<string>();
        if (status.isRepo) {
          // Working-tree (unstaged) state wins visually; staged fills the rest.
          for (const c of status.staged) fileMap.set(c.path, c.type);
          for (const c of status.unstaged) fileMap.set(c.path, c.type);
          for (const rel of fileMap.keys()) {
            const parts = rel.split('/');
            let prefix = '';
            for (let i = 0; i < parts.length - 1; i++) {
              const seg = parts[i];
              if (seg === undefined) continue;
              prefix = prefix ? `${prefix}/${seg}` : seg;
              dirSet.add(prefix);
            }
          }
        }
        setFiles(fileMap);
        setDirs(dirSet);
      })
      .catch(() => {
        if (capabilityRef.current !== root) return;
        setFiles(new Map());
        setDirs(new Set());
      });
  }, [gitCapability]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshNonce]);

  useEffect(() => onGitChanged(refresh), [refresh]);

  const value = useMemo<GitDecorations>(
    () => ({
      fileType: (rel) => files.get(rel),
      dirHasChanges: (rel) => dirs.has(rel),
    }),
    [files, dirs],
  );

  return <GitDecorationsContext.Provider value={value}>{children}</GitDecorationsContext.Provider>;
}
