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
import type { SettingsData } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { onFileSaved } from '../state/fileEvents';
import { notifyError } from '../notifications/bus';
import { DEFAULTS } from './schema';

/**
 * Settings store (PRD Part IV §55 / Part VII §120). Merges compiled defaults with
 * user overrides and (when a folder is open) workspace overrides, with precedence
 * default < user < workspace. Each change persists atomically to its scope. Also
 * owns the Settings UI open-state.
 */
export type SettingsScope = 'user' | 'workspace';

interface SettingsValue {
  /** Effective values: defaults < user < workspace. Consumed by the app. */
  values: Record<string, unknown>;
  /** True once user settings have hydrated. */
  loaded: boolean;
  workspaceAvailable: boolean;
  /** True when the current workspace's overrides—not a prior root—have hydrated. */
  workspaceLoaded: boolean;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  /** Snapshot of all overrides currently stored in a scope. */
  getScopeValues: (scope: SettingsScope) => SettingsData;
  /** Adopt an already-committed complete scope snapshot without writing it again. */
  adoptScopeValues: (values: SettingsData, scope: SettingsScope) => void;
  /** The override stored in a scope (undefined if not set there). */
  getScopeValue: (key: string, scope: SettingsScope) => unknown;
  /** Value displayed while editing a scope, including its inheritance chain. */
  getResolvedValue: (key: string, scope: SettingsScope) => unknown;
  isModified: (key: string, scope: SettingsScope) => boolean;
  set: (key: string, value: unknown, scope: SettingsScope) => void;
  /** Apply multiple keys as one in-memory and persisted scope update. */
  setMany: (values: SettingsData, scope: SettingsScope) => void;
  reset: (key: string, scope: SettingsScope) => void;
}

interface WorkspaceOverridesState {
  root: string | null;
  overrides: SettingsData;
  loaded: boolean;
}

type SettingsTransform = (current: SettingsData) => SettingsData;

const SettingsContext = createContext<SettingsValue | null>(null);

function has(obj: SettingsData, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function sameSettings(a: SettingsData, b: SettingsData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function reportWriteFailure(scope: SettingsScope, error: unknown): void {
  notifyError(`Could not save ${scope} settings.`, {
    source: 'Settings',
    detail: error instanceof Error ? error.message : String(error),
  });
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { rootPath } = useWorkspace();
  const [userOverrides, setUserOverrides] = useState<SettingsData>({});
  const [workspaceState, setWorkspaceState] = useState<WorkspaceOverridesState>({
    root: null,
    overrides: {},
    loaded: true,
  });
  const [loaded, setLoaded] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const currentWorkspaceOverrides =
    workspaceState.root === rootPath ? workspaceState.overrides : {};
  const workspaceLoaded =
    rootPath === null || (workspaceState.root === rootPath && workspaceState.loaded);

  const userRef = useRef<SettingsData>(userOverrides);
  userRef.current = userOverrides;
  const workspaceRef = useRef<{ root: string | null; overrides: SettingsData }>({
    root: null,
    overrides: {},
  });
  workspaceRef.current = { root: rootPath, overrides: currentWorkspaceOverrides };
  const rootRef = useRef<string | null>(rootPath);
  rootRef.current = rootPath;
  const userRevisionRef = useRef(0);
  const userHydratedRef = useRef(false);
  const pendingUserTransformsRef = useRef<SettingsTransform[]>([]);
  const workspaceRevisionRef = useRef<{ root: string | null; revision: number }>({
    root: null,
    revision: 0,
  });
  const workspaceHydrationRef = useRef<{ root: string | null; hydrated: boolean }>({
    root: null,
    hydrated: true,
  });
  const pendingWorkspaceTransformsRef = useRef<Map<string, SettingsTransform[]>>(new Map());
  const workspaceReadGenerationRef = useRef<Map<string, number>>(new Map());
  if (workspaceRevisionRef.current.root !== rootPath) {
    workspaceRevisionRef.current = { root: rootPath, revision: 0 };
  }
  if (workspaceHydrationRef.current.root !== rootPath) {
    workspaceHydrationRef.current = { root: rootPath, hydrated: rootPath === null };
  }

  // Load user overrides once. Mutations made while this read is in flight are
  // replayed over the disk snapshot and then persisted as one merged object.
  useEffect(() => {
    let cancelled = false;
    void window.axiom.settings
      .read()
      .then((data) => {
        if (cancelled) return;
        const pending = pendingUserTransformsRef.current;
        let next = data;
        for (const transform of pending) next = transform(next);
        pendingUserTransformsRef.current = [];
        userHydratedRef.current = true;
        userRef.current = next;
        setUserOverrides(next);
        if (pending.length > 0) {
          void window.axiom.settings.write(next).catch((error: unknown) => {
            reportWriteFailure('user', error);
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          notifyError('Could not load user settings; defaults are active.', {
            source: 'Settings',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bind workspace overrides to the root they came from. Mutations made while
  // a workspace read is in flight are replayed over its disk snapshot and then
  // persisted, so an optimistic patch can never replace unrelated overrides.
  useEffect(() => {
    if (!rootPath) {
      workspaceHydrationRef.current = { root: null, hydrated: true };
      workspaceRef.current = { root: null, overrides: {} };
      setWorkspaceState({ root: null, overrides: {}, loaded: true });
      return;
    }

    const root = rootPath;
    const generation = (workspaceReadGenerationRef.current.get(root) ?? 0) + 1;
    workspaceReadGenerationRef.current.set(root, generation);
    let cancelled = false;
    workspaceHydrationRef.current = { root, hydrated: false };
    workspaceRef.current = { root, overrides: {} };
    setWorkspaceState({ root, overrides: {}, loaded: false });
    void window.axiom.settings
      .readWorkspace(root)
      .then((data) => {
        if (workspaceReadGenerationRef.current.get(root) !== generation) return;
        const pending = pendingWorkspaceTransformsRef.current.get(root) ?? [];
        let next = data;
        for (const transform of pending) next = transform(next);
        pendingWorkspaceTransformsRef.current.delete(root);

        if (!cancelled && rootRef.current === root) {
          workspaceHydrationRef.current = { root, hydrated: true };
          workspaceRef.current = { root, overrides: next };
          setWorkspaceState({ root, overrides: next, loaded: true });
        }
        if (pending.length > 0) {
          void window.axiom.settings.writeWorkspace(root, next).catch((error: unknown) => {
            reportWriteFailure('workspace', error);
          });
        }
      })
      .catch((error: unknown) => {
        if (
          workspaceReadGenerationRef.current.get(root) !== generation ||
          cancelled ||
          rootRef.current !== root
        ) {
          return;
        }
        setWorkspaceState({ root, overrides: workspaceRef.current.overrides, loaded: true });
        notifyError('Could not load workspace settings.', {
          source: 'Settings',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Live-apply direct settings.json edits. Revision checks prevent an older read
  // from replacing a newer optimistic UI update.
  useEffect(() => {
    return onFileSaved(() => {
      // Ignore live-reload reads until startup hydration has established the
      // authoritative baseline. Otherwise a read queued before replay/write can
      // return afterward and replace the merged in-memory object with stale data.
      if (userHydratedRef.current) {
        const userRevision = userRevisionRef.current;
        void window.axiom.settings
          .read()
          .then((data) => {
            if (userRevision !== userRevisionRef.current || sameSettings(data, userRef.current)) {
              return;
            }
            userRef.current = data;
            setUserOverrides(data);
          })
          .catch(() => undefined);
      }

      const current = workspaceRef.current;
      const root = current.root;
      if (
        !root ||
        workspaceHydrationRef.current.root !== root ||
        !workspaceHydrationRef.current.hydrated
      ) {
        return;
      }
      const revision = workspaceRevisionRef.current.revision;
      const generation = workspaceReadGenerationRef.current.get(root);
      void window.axiom.settings
        .readWorkspace(root)
        .then((data) => {
          if (
            rootRef.current !== root ||
            workspaceReadGenerationRef.current.get(root) !== generation ||
            workspaceRevisionRef.current.root !== root ||
            workspaceRevisionRef.current.revision !== revision ||
            sameSettings(data, workspaceRef.current.overrides)
          ) {
            return;
          }
          workspaceRef.current = { root, overrides: data };
          setWorkspaceState({ root, overrides: data, loaded: true });
        })
        .catch(() => undefined);
    });
  }, []);

  const persistUser = useCallback((transform: SettingsTransform) => {
    const current = userRef.current;
    const next = transform(current);
    const changed = !sameSettings(current, next);
    // Before hydration even an apparent no-op (notably reset) may target a key
    // that exists on disk, so retain the transform for replay.
    if (!userHydratedRef.current) {
      pendingUserTransformsRef.current.push(transform);
    } else if (!changed) {
      return;
    }
    userRevisionRef.current += 1;
    if (changed) {
      userRef.current = next;
      setUserOverrides(next);
    }
    if (userHydratedRef.current) {
      void window.axiom.settings.write(next).catch((error: unknown) => {
        reportWriteFailure('user', error);
      });
    }
  }, []);

  const persistWorkspace = useCallback((transform: SettingsTransform) => {
    const root = rootRef.current;
    if (!root || workspaceRef.current.root !== root) return;
    if (workspaceRevisionRef.current.root !== root) {
      workspaceRevisionRef.current = { root, revision: 0 };
    }
    const current = workspaceRef.current.overrides;
    const next = transform(current);
    const changed = !sameSettings(current, next);
    const hydrated =
      workspaceHydrationRef.current.root === root && workspaceHydrationRef.current.hydrated;

    // Like user settings, retain apparent no-ops before hydration because a reset
    // may target a key that exists only in the pending disk snapshot.
    if (!hydrated) {
      const pending = pendingWorkspaceTransformsRef.current.get(root) ?? [];
      pendingWorkspaceTransformsRef.current.set(root, [...pending, transform]);
    } else if (!changed) {
      return;
    }

    workspaceRevisionRef.current.revision += 1;
    if (changed) {
      workspaceRef.current = { root, overrides: next };
      setWorkspaceState((state) => ({
        root,
        overrides: next,
        loaded: state.root === root ? state.loaded : false,
      }));
    }
    if (hydrated) {
      void window.axiom.settings.writeWorkspace(root, next).catch((error: unknown) => {
        reportWriteFailure('workspace', error);
      });
    }
  }, []);

  const setMany = useCallback(
    (patch: SettingsData, scope: SettingsScope) => {
      if (scope === 'workspace') {
        persistWorkspace((current) => ({ ...current, ...patch }));
      } else {
        persistUser((current) => ({ ...current, ...patch }));
      }
    },
    [persistUser, persistWorkspace],
  );

  const set = useCallback(
    (key: string, value: unknown, scope: SettingsScope) => {
      setMany({ [key]: value }, scope);
    },
    [setMany],
  );

  const reset = useCallback(
    (key: string, scope: SettingsScope) => {
      if (scope === 'workspace') {
        const root = rootRef.current;
        const hydrated =
          root !== null &&
          workspaceHydrationRef.current.root === root &&
          workspaceHydrationRef.current.hydrated;
        if (hydrated && !has(workspaceRef.current.overrides, key)) return;
        persistWorkspace((current) => {
          if (!has(current, key)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }
      if (userHydratedRef.current && !has(userRef.current, key)) return;
      persistUser((current) => {
        if (!has(current, key)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    },
    [persistUser, persistWorkspace],
  );

  const getScopeValues = useCallback((scope: SettingsScope): SettingsData => {
    const source = scope === 'workspace' ? workspaceRef.current.overrides : userRef.current;
    return { ...source };
  }, []);

  const adoptScopeValues = useCallback((nextValues: SettingsData, scope: SettingsScope): void => {
    const next = { ...nextValues };
    if (scope === 'workspace') {
      const root = rootRef.current;
      if (!root) return;
      pendingWorkspaceTransformsRef.current.delete(root);
      workspaceHydrationRef.current = { root, hydrated: true };
      if (workspaceRevisionRef.current.root !== root) {
        workspaceRevisionRef.current = { root, revision: 0 };
      }
      workspaceRevisionRef.current.revision += 1;
      workspaceRef.current = { root, overrides: next };
      setWorkspaceState({ root, overrides: next, loaded: true });
      return;
    }
    pendingUserTransformsRef.current = [];
    userHydratedRef.current = true;
    userRevisionRef.current += 1;
    userRef.current = next;
    setUserOverrides(next);
    setLoaded(true);
  }, []);

  const getScopeValue = useCallback(
    (key: string, scope: SettingsScope): unknown => {
      const src = scope === 'workspace' ? currentWorkspaceOverrides : userOverrides;
      return has(src, key) ? src[key] : undefined;
    },
    [userOverrides, currentWorkspaceOverrides],
  );

  const getResolvedValue = useCallback(
    (key: string, scope: SettingsScope): unknown => {
      if (scope === 'workspace' && has(currentWorkspaceOverrides, key)) {
        return currentWorkspaceOverrides[key];
      }
      if (has(userOverrides, key)) return userOverrides[key];
      return DEFAULTS[key];
    },
    [currentWorkspaceOverrides, userOverrides],
  );

  const isModified = useCallback(
    (key: string, scope: SettingsScope): boolean => {
      const src = scope === 'workspace' ? currentWorkspaceOverrides : userOverrides;
      return has(src, key);
    },
    [userOverrides, currentWorkspaceOverrides],
  );

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const values = useMemo(
    () => ({ ...DEFAULTS, ...userOverrides, ...currentWorkspaceOverrides }),
    [userOverrides, currentWorkspaceOverrides],
  );

  const value = useMemo<SettingsValue>(
    () => ({
      values,
      loaded,
      workspaceAvailable: rootPath !== null,
      workspaceLoaded,
      isOpen,
      open,
      close,
      getScopeValues,
      adoptScopeValues,
      getScopeValue,
      getResolvedValue,
      isModified,
      set,
      setMany,
      reset,
    }),
    [
      values,
      loaded,
      rootPath,
      workspaceLoaded,
      isOpen,
      open,
      close,
      getScopeValues,
      adoptScopeValues,
      getScopeValue,
      getResolvedValue,
      isModified,
      set,
      setMany,
      reset,
    ],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
