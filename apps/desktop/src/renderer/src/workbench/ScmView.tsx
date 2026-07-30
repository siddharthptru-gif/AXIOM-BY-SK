import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  GitChange,
  GitChangeType,
  GitDiffMode,
  GitLogEntry,
  GitOperationProgress,
  GitOperationResult,
  GitStatusResult,
  GithubAuthState,
  GithubCreateRepositoryInput,
  GithubDeviceFlow,
} from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { notifyError, notifyInfo } from '../notifications/bus';
import { FileIcon } from './treeIcons';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  SourceControlIcon,
  SparkIcon,
  ShieldIcon,
  UndoIcon,
} from './icons';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { ConfirmModal, PromptModal } from './Modal';
import { openDiff } from '../editor/diffBus';
import { bumpGitChanged } from '../state/gitBus';
import { buildDiffText } from '../../../common/gitAi';
import { setScmCommandHandler, type ScmCommand } from '../commands/commandBuses';
import { announce } from '../a11y/announcer';
import { ScmRequestGate, type ScmCapabilitySnapshot } from './scmRequestGate';

/**
 * Source Control view (PRD Epoch D). Shows the current branch, a commit box, and
 * the staged / unstaged working-tree changes, backed by the Main git service
 * (isomorphic-git). Files stage/unstage individually or per-section, and clicking
 * a change opens the file.
 */
const TYPE_BADGE: Record<GitChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  untracked: 'U',
};

function baseName(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? rel;
}

function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Compact "3m ago" / "2d ago" label from a Unix-seconds author timestamp. */
function relativeTime(tsSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

interface ScmRecovery {
  stage: 'commit-created' | 'repository-created' | 'remote-added';
  title: string;
  message: string;
  repositoryUrl: string | null;
  retryCloneUrl?: string;
  action: 'retry-push' | 'configure-origin';
}

type ScmQueuedRecovery = NonNullable<GitOperationResult['recovery']> & {
  retryCloneUrl?: string;
};

interface ScmQueuedResult {
  message: string;
  outcome?: 'success' | 'partial';
  recovery?: ScmQueuedRecovery | null;
}

export function ScmView() {
  const { rootPath, refreshNonce } = useWorkspace();
  const workspaceTrust = useWorkspaceTrust();
  const gitCapability = rootPath && workspaceTrust.trusted ? rootPath : null;
  const requestGateRef = useRef<ScmRequestGate | null>(null);
  if (requestGateRef.current === null) requestGateRef.current = new ScmRequestGate();
  const capabilitySnapshot = requestGateRef.current.setCapability(gitCapability);
  const capabilityRef = useRef<string | null>(gitCapability);
  const capabilityGenerationRef = useRef(capabilitySnapshot.generation);
  const lastResetCapabilityRef = useRef<string | null>(gitCapability);
  capabilityRef.current = gitCapability;
  capabilityGenerationRef.current = capabilitySnapshot.generation;
  const commitMessageId = useId();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number } | null>(null);
  const [branchList, setBranchList] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
  const [history, setHistory] = useState<GitLogEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [githubState, setGithubState] = useState<GithubAuthState>({
    status: 'disconnected',
    account: null,
  });
  const [githubBusy, setGithubBusy] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<GithubDeviceFlow | null>(null);
  const deviceFlowRef = useRef<GithubDeviceFlow | null>(null);
  deviceFlowRef.current = deviceFlow;
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationProgress, setOperationProgress] = useState<GitOperationProgress | null>(null);
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeOperationCapabilityRef = useRef<ScmCapabilitySnapshot | null>(null);
  const commandHandlerRef = useRef<(command: ScmCommand) => Promise<void>>(async () => undefined);
  const [showPublish, setShowPublish] = useState(false);
  const [publishName, setPublishName] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [publishVisibility, setPublishVisibility] = useState<'public' | 'private'>('private');
  const [branchPrompt, setBranchPrompt] = useState<'delete' | 'merge' | 'rebase' | null>(null);
  const [recovery, setRecovery] = useState<ScmRecovery | null>(null);

  useEffect(() => {
    requestGateRef.current?.activate();
    const snapshot = requestGateRef.current?.setCapability(gitCapability);
    capabilityRef.current = gitCapability;
    if (snapshot) capabilityGenerationRef.current = snapshot.generation;
    return () => {
      capabilityRef.current = null;
      requestGateRef.current?.deactivate();
      const activeFlow = deviceFlowRef.current;
      if (activeFlow) void window.axiom.github.cancel(activeFlow.flowId).catch(() => undefined);
    };
    // Mount ownership only; normal capability updates happen during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Root-scoped actions must not survive a trust or workspace transition. In
  // particular, discard confirmations retain mutation closures for their root.
  useEffect(() => {
    const previous = lastResetCapabilityRef.current;
    lastResetCapabilityRef.current = gitCapability;
    if (previous === gitCapability) return;
    const activeFlow = deviceFlowRef.current;
    if (activeFlow) void window.axiom.github.cancel(activeFlow.flowId).catch(() => undefined);
    setDeviceFlow(null);
    setGithubBusy(false);
    setOperationBusy(false);
    activeOperationCapabilityRef.current = null;
    setOperationProgress(null);
    setShowPublish(false);
    setBranchPrompt(null);
    setStatus(null);
    setHistory(null);
    setMessage('');
    setBusy(false);
    setBranchMenu(null);
    setBranchList([]);
    setCreating(false);
    setConfirm(null);
    setRecovery(null);
  }, [gitCapability]);

  const reload = useCallback(() => {
    const gate = requestGateRef.current;
    const request = gate?.begin('status');
    const root = request?.root ?? null;
    if (!gate || !request || !root || !gate.isCurrent(request)) {
      setStatus(null);
      return;
    }
    void window.axiom.git
      .status(root)
      .then((nextStatus) => {
        if (gate.accepts(request)) setStatus(nextStatus);
      })
      .catch(() => {
        if (gate.accepts(request)) setStatus(null);
      });
    // Poke the Explorer's git decorations to re-read (post-mutation sync).
    bumpGitChanged();
  }, []);

  const reloadHistory = useCallback(() => {
    const gate = requestGateRef.current;
    const request = gate?.begin('history');
    const root = request?.root ?? null;
    if (!gate || !request || !root || !gate.isCurrent(request)) {
      setHistory(null);
      return;
    }
    void window.axiom.git
      .log(root, 50)
      .then((nextHistory) => {
        if (gate.accepts(request)) setHistory(nextHistory);
      })
      .catch(() => {
        if (gate.accepts(request)) setHistory([]);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload, refreshNonce, gitCapability]);

  useEffect(() => {
    if (showHistory) reloadHistory();
  }, [showHistory, reloadHistory, refreshNonce, gitCapability]);

  useEffect(() => {
    let disposed = false;
    setGithubBusy(true);
    void window.axiom.github
      .state()
      .then((next) => {
        if (!disposed) setGithubState(next);
      })
      .catch((error) => {
        if (!disposed) {
          notifyError('Could not verify GitHub connection', {
            source: 'GitHub',
            detail: detailOf(error),
          });
        }
      })
      .finally(() => {
        if (!disposed) setGithubBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () =>
      window.axiom.git.onProgress((next) => {
        const active = activeOperationCapabilityRef.current;
        const gate = requestGateRef.current;
        if (!active || !gate?.isCurrent(active) || active.root !== next.root) return;
        setOperationProgress(next);
        if (next.phase === 'complete' || next.phase === 'error') {
          announce(next.message, next.phase === 'error' ? 'assertive' : 'polite');
        }
      }),
    [],
  );

  useEffect(() => {
    const flowId = deviceFlow?.flowId;
    if (!flowId) return;
    let disposed = false;
    const poll = async (): Promise<void> => {
      while (!disposed && deviceFlowRef.current?.flowId === flowId) {
        try {
          const result = await window.axiom.github.poll(flowId);
          if (disposed || deviceFlowRef.current?.flowId !== flowId) return;
          if (result.status === 'pending' || result.status === 'slow_down') {
            setDeviceFlow(result.flow);
            continue;
          }
          setDeviceFlow(null);
          setGithubBusy(false);
          if (result.status === 'connected') {
            setGithubState({ status: 'connected', account: result.account });
            notifyInfo(result.message, { source: 'GitHub' });
          } else if (result.status !== 'cancelled') {
            notifyError('GitHub connection did not complete', {
              source: 'GitHub',
              detail: result.message,
            });
          }
          return;
        } catch (error) {
          if (!disposed && deviceFlowRef.current?.flowId === flowId) {
            setDeviceFlow(null);
            setGithubBusy(false);
            notifyError('GitHub connection failed', {
              source: 'GitHub',
              detail: detailOf(error),
            });
          }
          return;
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
    };
  }, [deviceFlow?.flowId]);

  const enqueueGitOperation = (
    title: string,
    action: (root: string) => Promise<ScmQueuedResult>,
    options: { afterFullSuccess?: () => void; clearRecoveryOnSuccess?: boolean } = {},
  ): Promise<void> => {
    const gate = requestGateRef.current;
    const captured = gate?.snapshot() ?? { root: null, generation: -1 };
    const root = captured.root;
    if (!gate || !root || !gate.isCurrent(captured)) {
      notifyError(`${title} unavailable`, {
        source: 'Git',
        detail: rootPath
          ? 'Trust this workspace before running Git operations.'
          : 'Open a folder first.',
      });
      return Promise.resolve();
    }

    const queued = operationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!gate.isCurrent(captured)) return;
        activeOperationCapabilityRef.current = captured;
        setOperationBusy(true);
        let attempted = false;
        try {
          attempted = true;
          const result = await action(root);
          if (!gate.isCurrent(captured)) return;
          if (result.outcome === 'partial' && result.recovery) {
            setRecovery({
              stage: result.recovery.stage,
              title:
                result.recovery.stage === 'commit-created'
                  ? 'Commit created; push needs recovery'
                  : result.recovery.stage === 'remote-added'
                    ? 'Repository created; push needs recovery'
                    : 'Repository created; origin needs recovery',
              message: result.message,
              repositoryUrl: result.recovery.repositoryUrl,
              ...(result.recovery.retryCloneUrl
                ? { retryCloneUrl: result.recovery.retryCloneUrl }
                : {}),
              action: result.recovery.action,
            });
            notifyError(`${title} needs recovery`, { source: 'Git', detail: result.message });
          } else {
            if (options.clearRecoveryOnSuccess) setRecovery(null);
            notifyInfo(result.message, { source: 'Git' });
            options.afterFullSuccess?.();
          }
        } catch (error) {
          if (gate.isCurrent(captured)) {
            notifyError(`${title} failed`, { source: 'Git', detail: detailOf(error) });
          }
        } finally {
          if (gate.isCurrent(captured)) {
            if (attempted) {
              reload();
              reloadHistory();
            }
            setOperationBusy(false);
            if (activeOperationCapabilityRef.current === captured) {
              activeOperationCapabilityRef.current = null;
            }
          }
        }
      });
    operationQueueRef.current = queued.catch(() => undefined);
    return queued;
  };

  const runSync = (kind: 'fetch' | 'pull' | 'push'): Promise<void> => {
    if (!status?.isRepo) {
      notifyError(`${kind[0]?.toUpperCase()}${kind.slice(1)} unavailable`, {
        source: 'Git',
        detail: 'Initialize a repository first.',
      });
      return Promise.resolve();
    }
    if (!status.systemGit.available) {
      notifyError('System Git unavailable', {
        source: 'Git',
        detail: status.systemGit.message ?? 'Install Git to use remote operations.',
      });
      return Promise.resolve();
    }
    return enqueueGitOperation(
      kind[0]?.toUpperCase() + kind.slice(1),
      (root) =>
        kind === 'fetch'
          ? window.axiom.git.fetch(root)
          : kind === 'pull'
            ? window.axiom.git.pull(root)
            : window.axiom.git.push(root),
      {
        clearRecoveryOnSuccess: kind === 'push',
        ...(kind === 'push' && recovery?.stage === 'commit-created'
          ? { afterFullSuccess: () => setMessage('') }
          : {}),
      },
    );
  };

  const retryPush = (): Promise<void> => {
    const currentRecovery = recovery;
    if (currentRecovery?.stage === 'remote-added' && currentRecovery.retryCloneUrl) {
      return enqueueGitOperation(
        'Retry Push',
        (root) =>
          window.axiom.github.retryPublish(root, currentRecovery.retryCloneUrl as string, true),
        { clearRecoveryOnSuccess: true },
      );
    }
    return runSync('push');
  };

  const startGithubConnection = async (): Promise<void> => {
    if (deviceFlowRef.current) return;
    const generation = capabilityGenerationRef.current;
    setGithubBusy(true);
    try {
      const next = await window.axiom.github.start();
      if (capabilityGenerationRef.current !== generation) {
        await window.axiom.github.cancel(next.flowId).catch(() => undefined);
        setGithubBusy(false);
        return;
      }
      setDeviceFlow(next);
      notifyInfo('Enter the device code on GitHub to connect.', { source: 'GitHub' });
    } catch (error) {
      notifyError('Could not start GitHub connection', {
        source: 'GitHub',
        detail: detailOf(error),
      });
      setGithubBusy(false);
    }
  };

  const cancelGithubConnection = async (): Promise<void> => {
    const active = deviceFlowRef.current;
    if (!active) return;
    setDeviceFlow(null);
    setGithubBusy(false);
    await window.axiom.github.cancel(active.flowId).catch(() => undefined);
    notifyInfo('GitHub connection cancelled.', { source: 'GitHub' });
  };

  const disconnectGithubAccount = async (): Promise<void> => {
    setGithubBusy(true);
    try {
      await window.axiom.github.disconnect();
      setDeviceFlow(null);
      setGithubState({ status: 'disconnected', account: null });
      notifyInfo('Disconnected GitHub account.', { source: 'GitHub' });
    } catch (error) {
      notifyError('Could not disconnect GitHub', {
        source: 'GitHub',
        detail: detailOf(error),
      });
    } finally {
      setGithubBusy(false);
    }
  };

  const runCommitAndPush = (): Promise<void> => {
    if (recovery?.action === 'retry-push') return retryPush();
    const commitMessage = message.trim();
    if (!commitMessage || (status?.staged.length ?? 0) === 0) {
      notifyError('Commit and Push unavailable', {
        source: 'Git',
        detail: 'Stage changes and enter a commit message first.',
      });
      return Promise.resolve();
    }
    return enqueueGitOperation(
      'Commit and Push',
      (root) => window.axiom.git.commitAndPush(root, commitMessage),
      {
        clearRecoveryOnSuccess: true,
        afterFullSuccess: () => setMessage(''),
      },
    );
  };

  const publishRepository = async (): Promise<void> => {
    const name = publishName.trim();
    if (!name) {
      notifyError('Repository name required', { source: 'GitHub' });
      return;
    }
    if (githubState.status !== 'connected') {
      notifyError('Connect GitHub before publishing.', { source: 'GitHub' });
      return;
    }
    if ((status?.staged.length ?? 0) > 0 || (status?.unstaged.length ?? 0) > 0) {
      notifyError('Create and Publish requires a clean worktree', {
        source: 'Git',
        detail: 'Commit or discard all changes before publishing.',
      });
      return;
    }
    const input: GithubCreateRepositoryInput = {
      name,
      visibility: publishVisibility,
      ...(publishDescription.trim() ? { description: publishDescription.trim() } : {}),
    };
    await enqueueGitOperation(
      'Create and Publish',
      async (root) => {
        const result = await window.axiom.github.publishRepository(root, input, true);
        if (!result.ok) {
          return {
            outcome: 'partial' as const,
            message: `${result.message} ${result.recovery ?? ''}`.trim(),
            recovery: {
              stage: result.stage === 'remote-added' ? 'remote-added' : 'repository-created',
              action:
                result.stage === 'remote-added'
                  ? ('retry-push' as const)
                  : ('configure-origin' as const),
              repositoryUrl: result.repository.htmlUrl,
              ...(result.stage === 'remote-added'
                ? { retryCloneUrl: result.repository.cloneUrl }
                : {}),
            },
          };
        }
        return {
          outcome: 'success' as const,
          message: `${result.message} ${result.repository.htmlUrl}`,
        };
      },
      {
        clearRecoveryOnSuccess: true,
        afterFullSuccess: () => {
          setShowPublish(false);
          setPublishName('');
          setPublishDescription('');
        },
      },
    );
  };

  commandHandlerRef.current = async (command: ScmCommand): Promise<void> => {
    switch (command) {
      case 'view':
      case 'refresh':
        reload();
        return;
      case 'fetch':
      case 'pull':
      case 'push':
        await runSync(command);
        return;
      case 'commit-and-push':
        await runCommitAndPush();
        return;
      case 'connect':
        await startGithubConnection();
        return;
      case 'disconnect':
        await disconnectGithubAccount();
        return;
    }
  };

  useEffect(() => {
    let active = true;
    const dispose = setScmCommandHandler((command) => {
      if (!active) return;
      return commandHandlerRef.current(command);
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  const githubCard = (
    <section className="scm-github" aria-label="GitHub account">
      <div className="scm-github-head">
        <div>
          <strong>GitHub</strong>
          {githubState.status === 'connected' ? (
            <span className="scm-github-account">@{githubState.account.login}</span>
          ) : (
            <span className="scm-github-account">Not connected</span>
          )}
        </div>
        {githubState.status === 'connected' ? (
          <button
            type="button"
            className="btn btn-ghost scm-compact-btn"
            disabled={githubBusy}
            onClick={() => void disconnectGithubAccount()}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary scm-compact-btn"
            disabled={githubBusy || deviceFlow !== null}
            onClick={() => void startGithubConnection()}
          >
            Connect
          </button>
        )}
      </div>
      {githubState.status === 'connected' && githubState.account.warning ? (
        <p className="scm-github-warning">{githubState.account.warning}</p>
      ) : null}
      {deviceFlow ? (
        <div className="scm-device-card" aria-label="GitHub device authorization">
          <span className="scm-device-label">Enter this code on GitHub</span>
          <code className="scm-device-code">{deviceFlow.userCode}</code>
          <div className="scm-device-actions">
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="Copy GitHub device code"
              onClick={() => {
                void window.axiom.system.copyText(deviceFlow.userCode);
                notifyInfo('Copied GitHub device code.', { source: 'GitHub' });
              }}
            >
              <CopyIcon size={14} /> Copy
            </button>
            <button
              type="button"
              className="btn btn-primary"
              aria-label="Open GitHub device verification"
              onClick={() => {
                void window.axiom.github.openVerification(deviceFlow.flowId).catch((error) =>
                  notifyError('Could not open GitHub', {
                    source: 'GitHub',
                    detail: detailOf(error),
                  }),
                );
              }}
            >
              Open GitHub
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void cancelGithubConnection()}
            >
              Cancel
            </button>
          </div>
          <span className="scm-device-expiry">
            This code expires at {new Date(deviceFlow.expiresAt).toLocaleTimeString()}.
          </span>
        </div>
      ) : null}
    </section>
  );

  if (!rootPath) {
    return (
      <div className="scm-view">
        {githubCard}
        <div className="empty-state">
          <p>Open a folder to use source control.</p>
        </div>
      </div>
    );
  }

  if (!workspaceTrust.trusted) {
    const detail =
      workspaceTrust.status === 'checking'
        ? 'Checking workspace trust. Git remains disabled until the check finishes.'
        : workspaceTrust.status === 'error'
          ? 'Workspace trust could not be verified. Git remains disabled in Restricted Mode.'
          : 'Restricted Mode blocks Git status, history, branches, staging, commits, and discard actions. Trust this workspace to use source control.';
    return (
      <div className="scm-view">
        {githubCard}
        <div className="capability-disabled capability-disabled-view">
          <span className="capability-disabled-icon" aria-hidden="true">
            <ShieldIcon size={16} />
          </span>
          <div>
            <strong>Source control unavailable</strong>
            <p>{detail}</p>
          </div>
        </div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="scm-view">
        {githubCard}
        <div className="scm-repository-state">
          <span>
            System Git:{' '}
            {status.systemGit.available
              ? `available (${status.systemGit.version ?? 'unknown version'})`
              : 'unavailable'}
          </span>
          {status.systemGit.message ? <small>{status.systemGit.message}</small> : null}
        </div>
        <div className="empty-state">
          <p>No Git repository was found in this folder.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const root = rootPath;
              if (!requestGateRef.current?.isCurrent(capabilitySnapshot)) return;
              void window.axiom.git
                .init(root)
                .then(() => {
                  if (!requestGateRef.current?.isCurrent(capabilitySnapshot)) return;
                  notifyInfo('Initialized empty Git repository', { source: 'Git' });
                })
                .catch((e) => {
                  if (!requestGateRef.current?.isCurrent(capabilitySnapshot)) return;
                  notifyError('Could not initialize repository', {
                    source: 'Git',
                    detail: detailOf(e),
                  });
                })
                .finally(() => {
                  if (requestGateRef.current?.isCurrent(capabilitySnapshot)) {
                    reload();
                    reloadHistory();
                  }
                });
            }}
          >
            Initialize Repository
          </button>
        </div>
      </div>
    );
  }

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const canCommit =
    message.trim().length > 0 &&
    staged.length > 0 &&
    !busy &&
    !operationBusy &&
    recovery?.stage !== 'commit-created';

  const openChange = (rel: string, mode: GitDiffMode): void => {
    openDiff({ root: rootPath, rel, name: baseName(rel), mode });
  };

  const hasCurrentCapability = (snapshot: ScmCapabilitySnapshot = capabilitySnapshot): boolean =>
    requestGateRef.current?.isCurrent(snapshot) === true && snapshot.root === rootPath;

  const runStage = async (rel: string): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      await window.axiom.git.stage(rootPath, rel);
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not stage file', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const runUnstage = async (rel: string): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      await window.axiom.git.unstage(rootPath, rel);
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not unstage file', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const runDiscard = async (rel: string): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      await window.axiom.git.discard(rootPath, rel, true);
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not discard changes', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const discardAll = async (): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      for (const c of unstaged) {
        if (!hasCurrentCapability()) return;
        await window.axiom.git.discard(rootPath, c.path, true);
      }
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not discard all changes', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const confirmDiscard = (rel: string): void => {
    if (!hasCurrentCapability()) return;
    setConfirm({
      title: 'Discard Changes',
      message: `Are you sure you want to discard changes in ${baseName(rel)}? This cannot be undone.`,
      confirmLabel: 'Discard Changes',
      run: () => void runDiscard(rel),
    });
  };

  const confirmDiscardAll = (): void => {
    if (!hasCurrentCapability()) return;
    setConfirm({
      title: 'Discard All Changes',
      message: `Are you sure you want to discard all ${unstaged.length} change(s)? This cannot be undone.`,
      confirmLabel: 'Discard All',
      run: () => void discardAll(),
    });
  };

  const stageAll = async (): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      for (const c of unstaged) {
        if (!hasCurrentCapability()) return;
        await window.axiom.git.stage(rootPath, c.path);
      }
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not stage all changes', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const unstageAll = async (): Promise<void> => {
    if (!hasCurrentCapability()) return;
    try {
      for (const c of staged) {
        if (!hasCurrentCapability()) return;
        await window.axiom.git.unstage(rootPath, c.path);
      }
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not unstage all changes', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
      }
    }
  };

  const doCommit = async (): Promise<void> => {
    const msg = message.trim();
    if (!msg || staged.length === 0 || !hasCurrentCapability()) return;
    setBusy(true);
    try {
      const sha = await window.axiom.git.commit(rootPath, msg);
      if (!hasCurrentCapability()) return;
      setMessage('');
      notifyInfo(`Committed ${sha.slice(0, 7)}`, { source: 'Git' });
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Commit failed', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) {
        reload();
        reloadHistory();
        setBusy(false);
      }
    }
  };

  const generateMessage = async (): Promise<void> => {
    if (staged.length === 0) {
      notifyInfo('Stage changes first to generate a message.', { source: 'Git' });
      return;
    }
    if (!hasCurrentCapability()) return;
    setBusy(true);
    try {
      const files = await Promise.all(
        staged.map(async (c) => {
          try {
            const d = await window.axiom.git.diff(rootPath, c.path, 'staged');
            return { path: c.path, original: d.original, modified: d.modified };
          } catch {
            return { path: c.path, original: '', modified: '' };
          }
        }),
      );
      if (!hasCurrentCapability()) return;
      const diff = buildDiffText(files);
      const res = await window.axiom.ai.commitMessage({ diff });
      if (!hasCurrentCapability()) return;
      if (res.error) {
        notifyError('Could not generate message', { source: 'Git', detail: res.error });
      } else if (res.text) {
        setMessage(res.text);
        notifyInfo('Commit message generated — review before committing.', { source: 'Git' });
      }
    } catch (e) {
      if (hasCurrentCapability()) {
        notifyError('Could not generate message', { source: 'Git', detail: detailOf(e) });
      }
    } finally {
      if (hasCurrentCapability()) setBusy(false);
    }
  };

  const openBranchMenu = (x: number, y: number): void => {
    if (!hasCurrentCapability()) return;
    void window.axiom.git
      .branches(rootPath)
      .then((res) => {
        if (!hasCurrentCapability()) return;
        setBranchList(res.branches);
        setBranchMenu({ x, y });
      })
      .catch((e) => {
        if (hasCurrentCapability()) {
          notifyError('Could not list branches', { source: 'Git', detail: detailOf(e) });
        }
      });
  };

  const switchBranch = (ref: string): void => {
    if (ref === status?.branch || !hasCurrentCapability()) return;
    void enqueueGitOperation('Switch branch', (root) => window.axiom.git.checkout(root, ref));
  };

  const confirmBranchAction = (kind: 'delete' | 'merge' | 'rebase', ref: string): void => {
    if (!hasCurrentCapability()) return;
    const verb = kind === 'delete' ? 'Delete' : kind === 'merge' ? 'Merge' : 'Rebase';
    const explanation =
      kind === 'delete'
        ? `Delete local branch ${ref}? Unmerged branches will not be force-deleted.`
        : kind === 'merge'
          ? `Merge ${ref} into ${status?.branch ?? 'the current branch'}? The worktree must be clean.`
          : `Rebase ${status?.branch ?? 'the current branch'} onto ${ref}? The worktree must be clean.`;
    setConfirm({
      title: `${verb} Branch`,
      message: explanation,
      confirmLabel: verb,
      run: () => {
        void enqueueGitOperation(`${verb} branch`, (root) =>
          kind === 'delete'
            ? window.axiom.git.deleteBranch(root, ref, true)
            : kind === 'merge'
              ? window.axiom.git.merge(root, ref, true)
              : window.axiom.git.rebase(root, ref, true),
        );
      },
    });
  };

  const branchEntries: MenuEntry[] = [
    ...branchList.map((b) => ({
      label: b === status?.branch ? `\u25CF ${b}` : b,
      onSelect: () => switchBranch(b),
    })),
    { separator: true },
    { label: 'Create Branch\u2026', onSelect: () => setCreating(true) },
    { label: 'Delete Branch\u2026', onSelect: () => setBranchPrompt('delete') },
    { label: 'Merge Branch\u2026', onSelect: () => setBranchPrompt('merge') },
    { label: 'Rebase Branch\u2026', onSelect: () => setBranchPrompt('rebase') },
  ];

  const renderRow = (c: GitChange, mode: GitDiffMode) => (
    <div key={(mode === 'staged' ? 's:' : 'u:') + c.path} className="scm-row" title={c.path}>
      <button
        type="button"
        className="scm-row-open"
        aria-label={`Open ${mode} diff for ${c.path}`}
        onClick={() => openChange(c.path, mode)}
      >
        <span className="scm-icon" aria-hidden="true">
          <FileIcon name={baseName(c.path)} />
        </span>
        <span className="scm-name">{baseName(c.path)}</span>
        <span className="scm-dir">{c.path.split('/').slice(0, -1).join('/')}</span>
      </button>
      {mode === 'unstaged' ? (
        <button
          type="button"
          className="scm-action scm-action-discard"
          title="Discard Changes"
          aria-label={`Discard changes in ${c.path}`}
          onClick={() => confirmDiscard(c.path)}
        >
          <UndoIcon />
        </button>
      ) : null}
      <button
        type="button"
        className="scm-action"
        title={mode === 'staged' ? 'Unstage Changes' : 'Stage Changes'}
        aria-label={mode === 'staged' ? `Unstage ${c.path}` : `Stage ${c.path}`}
        onClick={() => void (mode === 'staged' ? runUnstage(c.path) : runStage(c.path))}
      >
        {mode === 'staged' ? <MinusIcon /> : <PlusIcon />}
      </button>
      <span className={`scm-badge scm-badge-${c.type}`} title={c.type} aria-hidden="true">
        {TYPE_BADGE[c.type]}
      </span>
    </div>
  );

  return (
    <div className="scm-view">
      {githubCard}
      <div className="scm-header">
        <button
          type="button"
          className="scm-branch"
          title="Switch branch"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            openBranchMenu(rect.left, rect.bottom);
          }}
        >
          <SourceControlIcon size={15} />
          {status?.branch ?? '—'}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Refresh"
          aria-label="Refresh"
          onClick={reload}
        >
          <RefreshIcon />
        </button>
      </div>

      {status ? (
        <div className="scm-repository-state" aria-label="Repository status">
          <div className="scm-repository-line">
            <span className={status.systemGit.available ? 'scm-ok' : 'scm-warning'}>
              Git {status.systemGit.available ? status.systemGit.version : 'unavailable'}
            </span>
            {status.detached ? <span className="scm-warning">Detached HEAD</span> : null}
            {status.upstream ? (
              <span title={status.upstream}>Upstream: {status.upstream}</span>
            ) : null}
          </div>
          <div className="scm-repository-line">
            <span>
              {status.remotes.length > 0
                ? `Remotes: ${status.remotes.map((remote) => remote.name).join(', ')}`
                : 'No remotes'}
            </span>
            <span>
              ↑ {status.ahead} &nbsp; ↓ {status.behind}
            </span>
          </div>
          {status.conflicts.length > 0 ? (
            <span className="scm-warning">
              {status.conflicts.length} unresolved conflict(s). Resolve them before continuing.
            </span>
          ) : status.systemGit.message ? (
            <small>{status.systemGit.message}</small>
          ) : null}
        </div>
      ) : null}

      <div className="scm-sync-toolbar" aria-label="Remote repository actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={operationBusy || !status?.systemGit.available}
          onClick={() => void runSync('fetch')}
        >
          Fetch
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Fast-forward only"
          disabled={operationBusy || !status?.systemGit.available || !status.upstream}
          onClick={() => void runSync('pull')}
        >
          Pull
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={operationBusy || !status?.systemGit.available}
          onClick={() => void runSync('push')}
        >
          Push
        </button>
      </div>

      {operationProgress ? (
        <div className={`scm-progress scm-progress-${operationProgress.phase}`}>
          <span>{operationProgress.message}</span>
          {operationProgress.percent !== null ? (
            <div
              className="scm-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={operationProgress.percent}
              aria-label={`${operationProgress.operation} progress`}
            >
              <span style={{ width: `${operationProgress.percent}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      {recovery ? (
        <section
          className={`scm-recovery scm-recovery-${recovery.stage}`}
          aria-label="Git recovery"
        >
          <strong>{recovery.title}</strong>
          <p>{recovery.message}</p>
          {recovery.repositoryUrl ? <code>{recovery.repositoryUrl}</code> : null}
          {recovery.action === 'retry-push' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={operationBusy || !status?.systemGit.available}
              onClick={() => void retryPush()}
            >
              Retry Push
            </button>
          ) : (
            <p>Resolve the origin configuration, then retry from Source Control.</p>
          )}
        </section>
      ) : null}

      {githubState.status === 'connected' ? (
        <section className="scm-publish" aria-label="Publish repository">
          <button
            type="button"
            className="scm-publish-toggle"
            aria-expanded={showPublish}
            onClick={() => setShowPublish((value) => !value)}
          >
            <span>Create &amp; Publish Repository</span>
            {showPublish ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
          {showPublish ? (
            <div className="scm-publish-form">
              <label>
                <span>Repository name</span>
                <input
                  value={publishName}
                  maxLength={100}
                  autoComplete="off"
                  onChange={(event) => setPublishName(event.target.value)}
                />
              </label>
              <label>
                <span>Description (optional)</span>
                <textarea
                  value={publishDescription}
                  maxLength={350}
                  rows={2}
                  onChange={(event) => setPublishDescription(event.target.value)}
                />
              </label>
              <label>
                <span>Visibility</span>
                <select
                  value={publishVisibility}
                  onChange={(event) =>
                    setPublishVisibility(event.target.value === 'public' ? 'public' : 'private')
                  }
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={operationBusy || publishName.trim().length === 0}
                onClick={() => void publishRepository()}
              >
                Create &amp; Publish
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="scm-commit">
        <label className="sr-only" htmlFor={commitMessageId}>
          Commit message
        </label>
        <textarea
          id={commitMessageId}
          className="scm-message"
          placeholder="Message (commit staged changes)"
          value={message}
          spellCheck={false}
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary scm-commit-btn"
          disabled={!canCommit}
          onClick={() => void doCommit()}
        >
          Commit
        </button>
        <button
          type="button"
          className="btn btn-ghost scm-commit-push-btn"
          disabled={!canCommit || !status?.systemGit.available}
          onClick={() => void runCommitAndPush()}
        >
          Commit &amp; Push
        </button>
        <button
          type="button"
          className="btn btn-ghost scm-genmsg-btn"
          disabled={staged.length === 0 || busy}
          title="Generate a commit message from the staged diff (AI)"
          onClick={() => void generateMessage()}
        >
          <SparkIcon size={14} />
          Generate
        </button>
      </div>

      {staged.length > 0 ? (
        <div className="scm-section">
          <div className="scm-section-head">
            <span className="scm-section-title">Staged Changes</span>
            <span className="scm-count">{staged.length}</span>
            <button
              type="button"
              className="scm-section-action"
              title="Unstage All"
              aria-label="Unstage All"
              onClick={() => void unstageAll()}
            >
              <MinusIcon />
            </button>
          </div>
          {staged.map((c) => renderRow(c, 'staged'))}
        </div>
      ) : null}

      <div className="scm-section">
        <div className="scm-section-head">
          <span className="scm-section-title">Changes</span>
          <span className="scm-count">{unstaged.length}</span>
          {unstaged.length > 0 ? (
            <>
              <button
                type="button"
                className="scm-section-action scm-action-discard"
                title="Discard All Changes"
                aria-label="Discard All Changes"
                onClick={confirmDiscardAll}
              >
                <UndoIcon />
              </button>
              <button
                type="button"
                className="scm-section-action"
                title="Stage All"
                aria-label="Stage All"
                onClick={() => void stageAll()}
              >
                <PlusIcon />
              </button>
            </>
          ) : null}
        </div>
        {staged.length === 0 && unstaged.length === 0 ? (
          <div className="scm-empty">No changes.</div>
        ) : (
          unstaged.map((c) => renderRow(c, 'unstaged'))
        )}
      </div>

      <div className="scm-section">
        <button
          type="button"
          className="scm-section-head scm-section-toggle"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <span className="scm-twisty">
            {showHistory ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </span>
          <span className="scm-section-title">Commit History</span>
        </button>
        {showHistory ? (
          history === null ? (
            <div className="scm-empty">{'Loading\u2026'}</div>
          ) : history.length === 0 ? (
            <div className="scm-empty">No commits yet.</div>
          ) : (
            history.map((h) => (
              <div
                key={h.oid}
                className="scm-commit-row"
                title={`${h.oid}\n${h.author} <${h.email}>\n\n${h.message}`}
              >
                <span className="scm-commit-sha">{h.oid.slice(0, 7)}</span>
                <span className="scm-commit-msg">{h.message.split('\n')[0] ?? ''}</span>
                <span className="scm-commit-meta">{relativeTime(h.timestamp)}</span>
              </div>
            ))
          )
        ) : null}
      </div>

      {branchMenu ? (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          entries={branchEntries}
          onClose={() => setBranchMenu(null)}
        />
      ) : null}
      {creating ? (
        <PromptModal
          title="Create Branch"
          label="New branch name"
          confirmLabel="Create"
          onSubmit={async (name) => {
            setCreating(false);
            await enqueueGitOperation('Create branch', (root) =>
              window.axiom.git.createBranch(root, name),
            );
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {branchPrompt ? (
        <PromptModal
          title={
            branchPrompt === 'delete'
              ? 'Delete Branch'
              : branchPrompt === 'merge'
                ? 'Merge Branch'
                : 'Rebase Branch'
          }
          label={branchPrompt === 'rebase' ? 'Branch to rebase onto' : 'Branch name'}
          confirmLabel="Continue"
          onSubmit={async (ref) => {
            const kind = branchPrompt;
            setBranchPrompt(null);
            confirmBranchAction(kind, ref);
          }}
          onClose={() => setBranchPrompt(null)}
        />
      ) : null}
      {confirm ? (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
