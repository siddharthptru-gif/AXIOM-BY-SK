import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentCommandResult,
  AgentDiffLine,
  AgentFileDiff,
  AgentProgress,
  AgentStepEvent,
  AgentTerminalSummary,
  WorkspaceAgentFile,
  WriteConsentState,
} from '../../../common/ipc';
import { AGENT_PRESETS, DEFAULT_PRESET_ID, type AgentPreset } from '../../../common/agentPresets';
import type { AutonomyLevel } from '../../../common/approval';
import { evaluateBudget, type BudgetEnforcement } from '../../../common/budgetGate';
import { buildRunEvidence, summarizeRunEvidence } from '../../../common/runEvidence';
import { isValidAgentEventMetadata } from '../../../common/agentEventValidation';
import { FollowTailController } from '../../../common/followTail';
import {
  agentActivityRequest,
  agentActivityResult,
  agentToolLabel,
} from '../../../common/agentActivity';
import type { AiDockCommandRequest, GodModeAgentLaunch } from '../commands/commandBuses';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import { useSettings } from '../settings/store';
import { notifyError, notifyInfo } from '../notifications/bus';
import { buildAiFileReview } from '../../../common/aiEditReview';
import { clearAiReview, clearAllAiReviews, publishAiReview } from '../editor/aiEditReviewBus';
import { requestAgentTyping } from '../editor/agentTypingBus';
import { commandFailed, commandStatusLabel } from '../../../common/agentCommand';
import { renderMarkdown } from './ChatMarkdown';
import { presentAssistantText } from '../../../common/modelText';
import {
  commandProgram,
  offerableScopes,
  type CommandConsentScope,
} from '../../../common/commandConsent';
import {
  activeMentionFor,
  formatFileReferenceBlock,
  matchMentionFiles,
  parseFileReferences,
  replaceActiveMention,
} from '../../../common/mentions';
import type { WorkspaceFile } from '../../../common/ipc';
import { isHighRiskCommand } from '../../../common/approval';
import type { ExecutionConsentState } from '../../../common/executionConsentTypes';
import {
  BrainIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  MoveIcon,
  PlusIcon,
  SearchIcon,
  PaperclipIcon,
  SendIcon,
  ShieldIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  ToolIcon,
  TrashIcon,
  WarningIcon,
} from './icons';

/** Copy a Build message to the clipboard through the Main-owned bridge. */
function AgentCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const value = text.trim();
  if (value.length === 0) return null;
  return (
    <button
      type="button"
      className={`chat-copy-btn${copied ? ' is-copied' : ''}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      aria-label={copied ? 'Copied to clipboard' : `Copy ${label}`}
      onClick={() => {
        void window.axiom.system
          .copyText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_400);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  );
}

/**
 * Map an allow-listed agent tool to a themed, currentColor activity glyph so the
 * transcript shows WHAT each step is doing (inspect, search, edit, run, …) — the
 * same at-a-glance lifecycle cue used by modern AI IDEs, in AXIOM's own palette
 * (never a colored emoji). Unknown/provider tools fall back to the neutral tool mark.
 */
function AgentToolGlyph({ tool, size = 13 }: { tool: string | undefined; size?: number }) {
  switch (tool) {
    case 'read_file':
      return <EyeIcon size={size} />;
    case 'list_dir':
    case 'create_directory':
      return <FolderIcon size={size} />;
    case 'search_text':
      return <SearchIcon size={size} />;
    case 'project_profile':
    case 'graph_impact':
      return <BrainIcon size={size} />;
    case 'write_file':
    case 'replace_in_file':
      return <EditIcon size={size} />;
    case 'delete_file':
      return <TrashIcon size={size} />;
    case 'move_path':
      return <MoveIcon size={size} />;
    case 'run_command':
      return <TerminalIcon size={size} />;
    case 'spawn_subagent':
      return <SparkIcon size={size} />;
    default:
      return <ToolIcon size={size} />;
  }
}

type RunOutcome = 'idle' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';

type AppliedStep = AgentStepEvent & { diff: AgentFileDiff; applied: true };
type CommandStep = AgentStepEvent & { command: AgentCommandResult };

interface PastTurn {
  id: string;
  root: string;
  task: string;
  steps: AgentStepEvent[];
  agentName: string;
  model: string;
  outcome: RunOutcome;
}

type ApprovalAcknowledgement = 'pending' | 'acknowledged' | 'failed';
interface ApprovalAcknowledgementState {
  status: ApprovalAcknowledgement;
  attempts: number;
}

const APPROVAL_ACK_RETRY_MS = 750;
const MAX_APPROVAL_ACK_ATTEMPTS = 3;

const PERMISSION_LABELS: Record<AutonomyLevel, string> = {
  guided: 'Ask before changes',
  autopilot: 'Autopilot planning (approve effects)',
  manual: 'Strict approval',
};

const FOLLOW_TAIL_THRESHOLD_PX = 96;
const ACTIVITY_SUMMARY_CAP = 240;
const PRIOR_TURN_SUMMARY_CAP = 3500;

function presetCanMutate(preset: AgentPreset | undefined): boolean {
  if (!preset || preset.toolScope === 'all') return true;
  return preset.toolScope.some((tool) =>
    ['write_file', 'replace_in_file', 'delete_file', 'run_command'].includes(tool),
  );
}

function appliedChanges(steps: readonly AgentStepEvent[]): AppliedStep[] {
  return steps.filter(
    (step): step is AppliedStep =>
      step.kind === 'tool' && step.applied === true && step.diff !== undefined,
  );
}

/** Tool steps that reached process execution and carry a Main-authored command record. */
function commandStepsOf(steps: readonly AgentStepEvent[]): CommandStep[] {
  return steps.filter(
    (step): step is CommandStep => step.kind === 'tool' && step.command !== undefined,
  );
}

function runFailed(step: AgentStepEvent): boolean {
  return !['succeeded', 'replayed'].includes(step.activity?.status ?? 'failed');
}

function boundedLine(value: unknown, cap = ACTIVITY_SUMMARY_CAP): string {
  const line = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

/** Never render raw tool JSON, file content, command output, or provider payloads. */
function summarizeToolRequest(step: AgentStepEvent): string {
  return agentActivityRequest(step.tool);
}

function summarizeToolObservation(step: AgentStepEvent): string {
  return agentActivityResult(step.tool, step.activity?.status);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function progressLabel(progress: AgentProgress): string {
  return progress.phase
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function terminalSummaryOf(steps: readonly AgentStepEvent[]): AgentTerminalSummary | null {
  return (
    [...steps].reverse().find((step) => step.kind === 'final' || step.kind === 'error')?.summary ??
    null
  );
}

function summarizePriorTurns(turns: readonly PastTurn[], root: string): string | undefined {
  const rootedTurns = turns.filter((turn) => turn.root === root);
  if (rootedTurns.length === 0) return undefined;
  const summary = rootedTurns
    .slice(-6)
    .map((turn, index) => {
      const terminal = [...turn.steps]
        .reverse()
        .find((step) => step.kind === 'final' || step.kind === 'error');
      const paths = [...new Set(appliedChanges(turn.steps).map((step) => step.diff.path))].slice(
        0,
        8,
      );
      return [
        `Turn ${index + 1} (${turn.model}, ${turn.outcome})`,
        `Task: ${boundedLine(turn.task, 240)}`,
        terminal?.text ? `Result: ${boundedLine(terminal.text, 360)}` : 'Result: no terminal text',
        paths.length > 0
          ? `Changed: ${paths.map((path) => boundedLine(path, 100)).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  return summary.slice(0, PRIOR_TURN_SUMMARY_CAP);
}

/**
 * Build mode. All workspace access remains Main-owned: this component only starts
 * a root-bound Agent run, renders events, and resolves opaque approval tokens.
 */
export function AgentPanel({
  provider,
  model,
  modelOptions,
  baseUrl,
  headers,
  approvalMode,
  onModelChange,
  onApprovalModeChange,
  onActivityChange,
  commandRequest,
  active,
  dailyBudgetUsd,
  budgetEnforcement,
}: {
  provider: string;
  model: string;
  modelOptions: readonly string[];
  baseUrl: string;
  headers: Record<string, string>;
  approvalMode: AutonomyLevel;
  onModelChange: (model: string) => void;
  onApprovalModeChange: (mode: AutonomyLevel) => void;
  onActivityChange: (active: boolean) => void;
  commandRequest: AiDockCommandRequest | null;
  active: boolean;
  dailyBudgetUsd: number;
  budgetEnforcement: BudgetEnforcement;
}) {
  const { rootPath, rootName, dirtyPaths, openFileAt } = useWorkspace();
  const { values: settingValues, set: setSetting } = useSettings();
  const workspaceTrust = useWorkspaceTrust();
  const agentCapability = rootPath && workspaceTrust.trusted ? rootPath : null;
  const [task, setTask] = useState('');
  const [runTask, setRunTask] = useState('');
  const [runRoot, setRunRoot] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET_ID);
  const [custom, setCustom] = useState<AgentPreset[]>([]);
  const [running, setRunning] = useState(false);
  const [runAgentName, setRunAgentName] = useState<string | null>(null);
  const [runModel, setRunModel] = useState<string | null>(null);
  const [runOutcome, setRunOutcome] = useState<RunOutcome>('idle');
  /** When the live run began, so the indicator can show real elapsed time. */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  /**
   * Live spend, so the budget gate can be evaluated synchronously at launch and
   * re-checked on every push while a run is in flight. An agent run is many turns;
   * without this, a hard budget stop only ever applied to single Ask messages.
   */
  const [todayUsd, setTodayUsd] = useState(0);
  const todayUsdRef = useRef(0);
  todayUsdRef.current = todayUsd;
  /** Agent definitions this repository declares in `.axiom/agents` (T3.13). */
  const [repoAgents, setRepoAgents] = useState<WorkspaceAgentFile[]>([]);
  const [sharing, setSharing] = useState(false);
  const [steps, setSteps] = useState<AgentStepEvent[]>([]);
  const [pastTurns, setPastTurns] = useState<PastTurn[]>([]);
  const [decided, setDecided] = useState<Record<number, boolean>>({});
  const [approvalPending, setApprovalPending] = useState<Record<number, boolean>>({});
  const [approvalErrors, setApprovalErrors] = useState<Record<number, string>>({});
  const [approvalAcknowledgements, setApprovalAcknowledgements] = useState<
    Record<string, ApprovalAcknowledgementState>
  >({});
  const [plan, setPlan] = useState<string[]>([]);
  const idRef = useRef<string | null>(null);
  const runRootRef = useRef<string | null>(null);
  const liveCapabilityRef = useRef<string | null>(agentCapability);
  liveCapabilityRef.current = agentCapability;
  const conversationRootRef = useRef<string | null>(agentCapability);
  const runCanMutateRef = useRef(false);
  const eventUnsubscribeRef = useRef<(() => void) | null>(null);
  const cancellationRequestedRef = useRef(false);
  const runInFlightRef = useRef(false);
  /** Approval tokens that already carry a decision, so none can be submitted twice. */
  const settledApprovalsRef = useRef<Set<string>>(new Set());
  /**
   * The install-time permission that lets an in-app approval settle an action on its
   * own. Shown here because this is where its effect is felt, and because a
   * permission the user cannot see or withdraw is not really a permission.
   */
  const [executionConsent, setExecutionConsentState] = useState<ExecutionConsentState | null>(null);
  const [consentPendingChange, setConsentPendingChange] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * `#file` reference picker. Loaded lazily the first time the user reaches for it,
   * so opening Build never costs a workspace walk.
   */
  const [refFiles, setRefFiles] = useState<WorkspaceFile[]>([]);
  const [refFilesLoaded, setRefFilesLoaded] = useState(false);
  const [refQuery, setRefQuery] = useState<{ query: string; start: number; end: number } | null>(
    null,
  );
  const [refIndex, setRefIndex] = useState(0);
  // Files and images attached from a native dialog. Separate from the `#` picker on
  // purpose: `#` points the agent at a workspace path it can read itself, while an
  // attachment can come from anywhere on disk and therefore has to travel with the
  // message.
  const [attached, setAttached] = useState<ComposerAttachment[]>([]);
  const followTailRef = useRef(new FollowTailController());
  const followTailTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const pointerStartYRef = useRef<number | null>(null);
  const handledCommandRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => {
    onActivityChange(running);
    return () => onActivityChange(false);
  }, [running, onActivityChange]);

  // This effect runs only after React commits a visible approval preview. Main
  // accepts decisions only after acknowledgement for the exact live run/root/token.
  useEffect(() => {
    if (!active || !agentCapability || runRootRef.current !== agentCapability) return;
    const retryTimers: number[] = [];
    steps.forEach((step, index) => {
      const token = step.kind === 'approval' ? step.approvalToken : undefined;
      if (!token) return;
      const acknowledgement = approvalAcknowledgements[token];
      if (
        acknowledgement?.status === 'acknowledged' ||
        acknowledgement?.status === 'pending' ||
        (acknowledgement?.attempts ?? 0) >= MAX_APPROVAL_ACK_ATTEMPTS
      ) {
        return;
      }
      const acknowledge = (): void => {
        const exactPreviewStillVisible =
          active &&
          idRef.current === step.id &&
          runRootRef.current === step.root &&
          liveCapabilityRef.current === step.root &&
          steps.some((candidate) => candidate.id === step.id && candidate.approvalToken === token);
        if (!exactPreviewStillVisible) return;
        const attempts = (acknowledgement?.attempts ?? 0) + 1;
        setApprovalAcknowledgements((current) => ({
          ...current,
          [token]: { status: 'pending', attempts },
        }));
        void window.axiom.agent.acknowledgeApproval(step.id, token).then(
          () => {
            if (
              idRef.current !== step.id ||
              runRootRef.current !== step.root ||
              liveCapabilityRef.current !== step.root
            ) {
              return;
            }
            setApprovalAcknowledgements((current) => ({
              ...current,
              [token]: { status: 'acknowledged', attempts },
            }));
            setApprovalErrors((errors) => {
              if (!(index in errors)) return errors;
              const next = { ...errors };
              delete next[index];
              return next;
            });
          },
          () => {
            if (
              idRef.current !== step.id ||
              runRootRef.current !== step.root ||
              liveCapabilityRef.current !== step.root
            ) {
              return;
            }
            setApprovalAcknowledgements((current) => ({
              ...current,
              [token]: { status: 'failed', attempts },
            }));
            setApprovalErrors((errors) => ({
              ...errors,
              [index]:
                attempts < MAX_APPROVAL_ACK_ATTEMPTS
                  ? 'Preview acknowledgement failed; retrying.'
                  : 'Preview acknowledgement failed. This action remains blocked.',
            }));
          },
        );
      };
      if (acknowledgement?.status === 'failed') {
        retryTimers.push(window.setTimeout(acknowledge, APPROVAL_ACK_RETRY_MS));
      } else {
        acknowledge();
      }
    });
    return () => retryTimers.forEach((timer) => window.clearTimeout(timer));
  }, [active, agentCapability, approvalAcknowledgements, steps]);

  useEffect(
    () => () => {
      eventUnsubscribeRef.current?.();
      eventUnsubscribeRef.current = null;
      if (followTailTimerRef.current !== null) {
        window.clearTimeout(followTailTimerRef.current);
        followTailTimerRef.current = null;
      }
      const id = idRef.current;
      idRef.current = null;
      runRootRef.current = null;
      if (id) void window.axiom.agent.cancel(id).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    void window.axiom.customAgents
      .list()
      .then(setCustom)
      .catch(() => undefined);
  }, []);

  // Agents this repository ships (.axiom/agents). Listing is read-only — nothing
  // becomes usable until the user enables it for this exact content digest.
  useEffect(() => {
    const root = agentCapability;
    if (!root) {
      setRepoAgents([]);
      return;
    }
    let alive = true;
    void window.axiom.workspaceAgents
      .list(root)
      .then((files) => {
        if (alive) setRepoAgents(files);
      })
      .catch(() => {
        if (alive) setRepoAgents([]);
      });
    return () => {
      alive = false;
    };
  }, [agentCapability]);

  /** Persisted map of repo-agent id → the exact content digest the user approved. */
  const approvedDigests = useMemo<Record<string, string>>(() => {
    const raw = settingValues['agents.repoApproved'];
    if (typeof raw !== 'string' || raw.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }, [settingValues]);

  /** Approve or revoke a repo agent, binding approval to the content shown. */
  const toggleRepoAgent = useCallback(
    (file: WorkspaceAgentFile): void => {
      if (!file.valid || !file.agent || !file.digest) return;
      const id = file.agent.id;
      const next = { ...approvedDigests };
      if (next[id] === file.digest) delete next[id];
      else next[id] = file.digest;
      setSetting('agents.repoApproved', JSON.stringify(next), 'user');
    },
    [approvedDigests, setSetting],
  );

  /** Write the selected custom agent into the repo so the team can use it. */
  const shareActiveAgent = useCallback((): void => {
    const root = agentCapability;
    if (!root || sharing) return;
    const target = custom.find((candidate) => candidate.id === preset);
    if (!target) return;
    setSharing(true);
    void window.axiom.workspaceAgents
      .share(root, target.id)
      .then((rel) => {
        notifyInfo(`Saved ${target.name} to ${rel}. Commit it to share this agent.`, {
          source: 'Build',
        });
        return window.axiom.workspaceAgents.list(root).then(setRepoAgents);
      })
      .catch((cause: unknown) =>
        notifyError('Could not share this agent', {
          source: 'Build',
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setSharing(false));
  }, [agentCapability, custom, preset, sharing]);

  /**
   * Repo agents the user has approved AT THEIR CURRENT CONTENT. A pulled commit that
   * edits a persona changes the digest, so the agent silently drops out of the
   * library and must be reviewed again rather than running with new instructions.
   */
  const approvedRepoAgents = useMemo<AgentPreset[]>(() => {
    const out: AgentPreset[] = [];
    for (const file of repoAgents) {
      if (!file.valid || !file.agent || !file.digest) continue;
      if (approvedDigests[file.agent.id] !== file.digest) continue;
      out.push({
        id: file.agent.id,
        name: file.agent.name,
        description: file.agent.description,
        persona: file.agent.persona,
        toolScope: file.agent.toolScope,
        plan: file.agent.plan,
      });
    }
    return out;
  }, [repoAgents, approvedDigests]);

  const availablePresets = useMemo(
    () => [...AGENT_PRESETS, ...custom, ...approvedRepoAgents],
    [custom, approvedRepoAgents],
  );
  const selectableModels = useMemo(
    () => (modelOptions.includes(model) ? [...modelOptions] : [model, ...modelOptions]),
    [model, modelOptions],
  );
  const activePreset = availablePresets.find((candidate) => candidate.id === preset);
  const activeName = activePreset?.name ?? 'Coder';
  const mutationCapable = presetCanMutate(activePreset);
  const dirtyBlocked = mutationCapable && dirtyPaths.size > 0;

  // Session-scoped batch consent: let Build edit files in this trusted folder
  // without a prompt per edit. Main holds the grant in memory only and still gates
  // commands, Git/network writes, MCP tools, and every high-risk action.
  const [writeConsent, setWriteConsent] = useState<WriteConsentState | null>(null);
  const [consentPending, setConsentPending] = useState(false);
  useEffect(() => {
    const root = agentCapability;
    if (!root) {
      setWriteConsent(null);
      return;
    }
    let active = true;
    void window.axiom.agent.writeConsent
      .get(root)
      .then((state) => {
        if (active) setWriteConsent(state);
      })
      .catch(() => {
        if (active) setWriteConsent(null);
      });
    return () => {
      active = false;
    };
  }, [agentCapability]);

  /**
   * Grant or revoke batch edit permission. `remember` asks Main to keep the grant
   * for this exact folder across restarts, which it confirms with its own native
   * dialog — so a persisted permission is never a side effect of a checkbox.
   */
  const setWriteConsentGrant = useCallback(
    (next: boolean, remember = false): void => {
      const root = agentCapability;
      if (!root || consentPending) return;
      setConsentPending(true);
      const request = next
        ? window.axiom.agent.writeConsent.grant(root, true, undefined, remember)
        : window.axiom.agent.writeConsent.revoke(root);
      void request
        .then((state) => {
          setWriteConsent(state);
          if (!state.granted) return;
          notifyInfo(
            state.persisted
              ? 'Build can edit files in this folder without asking, now and after a restart. Commands and risky actions still ask, and every change stays revertible from Checkpoints.'
              : 'Build can now edit files in this folder without asking each time. Commands and risky actions still ask, and every change stays revertible from Checkpoints.',
            { source: 'Build' },
          );
          if (remember && !state.persisted) {
            notifyError('The permission applies to this session only', {
              source: 'Build',
              detail: 'It could not be saved for future sessions, so it will lapse on restart.',
            });
          }
        })
        .catch((error: unknown) =>
          notifyError('Could not update file-edit permission', {
            source: 'Build',
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => setConsentPending(false));
    },
    [agentCapability, consentPending],
  );
  const toggleWriteConsent = useCallback(
    (next: boolean): void => setWriteConsentGrant(next, false),
    [setWriteConsentGrant],
  );
  const latestProgress = [...steps].reverse().find((step) => step.progress)?.progress ?? null;
  const latestSummary = terminalSummaryOf(steps);
  const lastStep = steps.at(-1);
  const statusAgentName = runAgentName ?? activeName;
  const runStatus =
    runOutcome === 'cancelling'
      ? `Stopping ${statusAgentName}.`
      : running
        ? `${statusAgentName} is working.`
        : runOutcome === 'cancelled'
          ? `${statusAgentName} stopped.`
          : runOutcome === 'failed'
            ? `${statusAgentName} stopped with an error.`
            : runOutcome === 'completed'
              ? `${statusAgentName} completed the task.`
              : 'Build is ready.';
  const latestApprovalError = Object.values(approvalErrors).at(-1);
  const terminalFailureAnnouncement =
    lastStep?.kind === 'error' && lastStep.outcome === 'failed'
      ? `Build failed: ${boundedLine(lastStep.text ?? runError ?? 'Unknown error.', 240)}`
      : null;
  const cancellationAnnouncement =
    runOutcome === 'cancelled'
      ? `Build stopped: ${boundedLine(cancelReason ?? lastStep?.text ?? 'Cancelled.', 240)}`
      : null;
  const contextClearedAnnouncement =
    cancelReason && runOutcome === 'idle'
      ? `Build context cleared: ${boundedLine(cancelReason, 240)}`
      : null;
  const runErrorAnnouncement = runError ? `Build issue: ${boundedLine(runError, 240)}` : null;
  const liveStatus = terminalFailureAnnouncement
    ? terminalFailureAnnouncement
    : cancellationAnnouncement
      ? cancellationAnnouncement
      : contextClearedAnnouncement
        ? contextClearedAnnouncement
        : runErrorAnnouncement
          ? runErrorAnnouncement
          : latestApprovalError
            ? 'Approval preview could not be acknowledged. The action remains blocked.'
            : lastStep?.kind === 'approval'
              ? `Approval required for ${agentToolLabel(lastStep.tool)}.`
              : lastStep?.kind === 'progress' && lastStep.progress
                ? `${progressLabel(lastStep.progress)}. Elapsed ${formatDuration(lastStep.progress.elapsedMs)}.`
                : lastStep?.kind === 'final' && lastStep.outcome === 'completed'
                  ? `${statusAgentName} completed the task.`
                  : lastStep?.kind === 'tool'
                    ? `${agentToolLabel(lastStep.tool)} ${
                        runFailed(lastStep) ? 'did not complete.' : 'completed.'
                      }`
                    : runStatus;
  const agentRestriction = !rootPath
    ? 'Open a folder to let Build work in a workspace.'
    : workspaceTrust.status === 'checking'
      ? 'Checking workspace trust before enabling tools.'
      : workspaceTrust.status === 'error'
        ? 'Workspace trust could not be verified. Build remains disabled.'
        : 'Trust this workspace to enable root-bound Agent tools.';

  const isNearTranscriptBottom = (element: HTMLDivElement): boolean =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_TAIL_THRESHOLD_PX;

  const disengageFollowTail = (): void => {
    if (followTailTimerRef.current !== null) {
      window.clearTimeout(followTailTimerRef.current);
      followTailTimerRef.current = null;
    }
    const transcript = transcriptRef.current;
    if (transcript) {
      transcript.scrollTo({ top: transcript.scrollTop, behavior: 'auto' });
    }
    const snapshot = followTailRef.current.userScrollAway();
    setShowJumpToLatest(snapshot.showJump);
  };

  const jumpToLatest = (): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    followTailRef.current.jumpToLatest();
    setShowJumpToLatest(false);
    transcript.scrollTop = transcript.scrollHeight;
  };

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const controller = followTailRef.current;
    if (!controller.beginAppend(isNearTranscriptBottom(transcript))) {
      setShowJumpToLatest(true);
      return;
    }
    setShowJumpToLatest(false);
    const reducedMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.classList.contains('reduce-motion') ||
      document.body.classList.contains('reduce-motion');
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    if (followTailTimerRef.current !== null) {
      window.clearTimeout(followTailTimerRef.current);
    }
    followTailTimerRef.current = window.setTimeout(
      () => {
        followTailTimerRef.current = null;
        const current = transcriptRef.current;
        if (!current) return;
        const snapshot = controller.finishProgrammaticScroll(isNearTranscriptBottom(current));
        setShowJumpToLatest(snapshot.showJump);
      },
      reducedMotion ? 0 : 1_200,
    );
  }, [pastTurns.length, steps.length, runOutcome]);

  const finishRun = (id: string, outcome: 'cancelled' | 'completed' | 'failed'): void => {
    if (idRef.current !== id) return;
    setRunOutcome(outcome);
    runInFlightRef.current = false;
    setRunning(false);
    eventUnsubscribeRef.current?.();
    eventUnsubscribeRef.current = null;
    idRef.current = null;
    runRootRef.current = null;
    runCanMutateRef.current = false;
    cancellationRequestedRef.current = false;
  };

  const cancel = (reason?: string): void => {
    const id = idRef.current;
    if (!id || cancellationRequestedRef.current) return;
    cancellationRequestedRef.current = true;
    if (reason) setCancelReason(reason);
    setRunOutcome('cancelling');
    void window.axiom.agent.cancel(id).catch(() => {
      if (idRef.current !== id) return;
      setRunError('Stop could not be requested. Build is still running; try again.');
      cancellationRequestedRef.current = false;
      setRunOutcome('running');
    });
  };

  // A root/trust transition immediately invalidates the live callback through
  // liveCapabilityRef (updated during render), then clears all root-bound history.
  useEffect(() => {
    if (conversationRootRef.current === agentCapability) return;
    conversationRootRef.current = agentCapability;
    const id = idRef.current;
    eventUnsubscribeRef.current?.();
    eventUnsubscribeRef.current = null;
    idRef.current = null;
    runRootRef.current = null;
    runCanMutateRef.current = false;
    cancellationRequestedRef.current = Boolean(id);
    if (id) void window.axiom.agent.cancel(id).catch(() => undefined);
    runInFlightRef.current = false;
    setRunning(false);
    setRunOutcome('idle');
    setRunTask('');
    setTask('');
    setRunRoot(null);
    setRunModel(null);
    setSteps([]);
    setPastTurns([]);
    setPlan([]);
    setDecided({});
    setApprovalPending({});
    setApprovalErrors({});
    setApprovalAcknowledgements({});
    setRunError(null);
    setCancelReason(id ? 'Build stopped because the active workspace or its trust changed.' : null);
    // Pending inline reviews belong to the previous root; never carry them over.
    clearAllAiReviews();
    followTailRef.current.reset();
    setShowJumpToLatest(false);
  }, [agentCapability]);

  /**
   * Reconcile the panel against Main's own task registry while a run is live.
   *
   * Every other path to "the run ended" depends on an event arriving: the terminal
   * event can be dropped by the ownership guard above, and the run call settling can
   * be delayed by anything Main is still awaiting. When that happened the panel sat
   * on "working" forever and the composer stayed disabled, so Build could not be used
   * again without restarting the app.
   *
   * Main's task status is the authority on whether a run is over, so it is asked
   * directly. This cannot invent a result: it only ever reads the status Main already
   * recorded for this exact run id.
   */
  useEffect(() => {
    if (!running) return;
    const root = runRootRef.current ?? agentCapability;
    if (!root) return;
    const reconcile = (): void => {
      const id = idRef.current;
      if (!id) return;
      void window.axiom.agent
        .tasks(root)
        .then((tasks) => {
          if (idRef.current !== id || !runInFlightRef.current) return;
          const task = tasks.find((entry) => entry.id === id);
          // An unknown id means Main has not registered it yet (or pruned it); the
          // run-call watchdog covers that case rather than guessing here.
          if (!task) return;
          if (task.status === 'completed' || task.status === 'failed') {
            if (task.status === 'failed' && task.lastText) setRunError(task.lastText);
            finishRun(id, task.status);
            return;
          }
          if (task.status === 'cancelled') finishRun(id, 'cancelled');
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(reconcile, 2_500);
    return () => window.clearInterval(timer);
  }, [running, agentCapability]);

  // Unsaved editor buffers are not on disk and could be overwritten externally.
  // Block at start and stop mutation-capable runs if a buffer becomes dirty later.
  useEffect(() => {
    if (!running || !runCanMutateRef.current || dirtyPaths.size === 0) return;
    cancel(
      'Build stopped because an editor has unsaved changes. Save or discard them, then retry.',
    );
  }, [dirtyPaths, running]);

  // Track spend so the budget gate has a current figure without an await.
  useEffect(() => {
    let cancelled = false;
    void window.axiom.ai.spend
      .summary()
      .then((summary) => {
        if (!cancelled) setTodayUsd(summary.todayUsd);
      })
      .catch(() => undefined);
    const unsubscribe = window.axiom.ai.spend.onChanged((summary) => setTodayUsd(summary.todayUsd));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Hard budget stop, mid-run. A multi-turn agent can burn budget after it starts,
  // so the gate is re-evaluated on every spend push and stops the run in 'block'
  // mode. 'warn' and 'off' never interrupt work.
  useEffect(() => {
    if (!running) return;
    const gate = evaluateBudget({
      todayUsd,
      budgetUsd: dailyBudgetUsd,
      enforcement: budgetEnforcement,
    });
    if (gate.decision !== 'block') return;
    cancel(`Build stopped by your daily AI budget. ${gate.reason}`);
  }, [running, todayUsd, dailyBudgetUsd, budgetEnforcement]);

  const run = (launch?: GodModeAgentLaunch): { accepted: boolean; reason?: string } => {
    const nextTask = (launch?.task ?? task).trim();
    if (launch && launch.root !== agentCapability) {
      const reason = 'This durable job belongs to a different or untrusted workspace.';
      setTask(nextTask);
      setRunError(reason);
      return { accepted: false, reason };
    }
    if (
      !nextTask ||
      runInFlightRef.current ||
      running ||
      !active ||
      !agentCapability ||
      dirtyBlocked
    ) {
      const reason = dirtyBlocked
        ? 'Save or discard editor changes before starting this durable job.'
        : running || runInFlightRef.current
          ? 'Stop the active Build before starting another durable job.'
          : 'Finish AI setup and trust the workspace before starting this durable job.';
      if (launch) {
        setTask(nextTask);
        setRunError(reason);
      }
      return { accepted: false, reason };
    }

    // Hard budget stop at launch. Evaluated against the live figure kept above, so
    // a run cannot start already over budget when enforcement is 'block'.
    const launchGate = evaluateBudget({
      todayUsd: todayUsdRef.current,
      budgetUsd: dailyBudgetUsd,
      enforcement: budgetEnforcement,
    });
    if (launchGate.decision === 'block') {
      const reason = `${launchGate.reason} Raise the daily budget or set enforcement to warn to continue.`;
      setTask(nextTask);
      setRunError(reason);
      return { accepted: false, reason };
    }

    runInFlightRef.current = true;

    const previousTurn: PastTurn | null =
      !launch && runTask && steps.length > 0 && runRoot === agentCapability
        ? {
            id: steps[0]?.id ?? crypto.randomUUID(),
            root: runRoot,
            task: runTask,
            steps,
            agentName: runAgentName ?? activeName,
            model: runModel ?? model,
            outcome: runOutcome,
          }
        : null;
    const rootedPastTurns = pastTurns.filter((turn) => turn.root === agentCapability);
    const contextTurns = previousTurn ? [...rootedPastTurns, previousTurn] : rootedPastTurns;
    const priorTurnSummary = summarizePriorTurns(contextTurns, agentCapability);
    if (previousTurn) setPastTurns(contextTurns.slice(-12));

    const id = launch?.jobId ?? crypto.randomUUID();
    const runRootAtStart = agentCapability;
    eventUnsubscribeRef.current?.();
    eventUnsubscribeRef.current = null;
    cancellationRequestedRef.current = false;
    idRef.current = id;
    runRootRef.current = runRootAtStart;
    runCanMutateRef.current = mutationCapable;
    setRunTask(nextTask);
    setRunRoot(runRootAtStart);
    setTask('');
    // The attachments have already been folded into the task above, so the composer
    // starts clean instead of silently resending them on the next turn.
    setAttached([]);
    setSteps([]);
    setRunError(null);
    setCancelReason(null);
    setDecided({});
    setApprovalPending({});
    setApprovalErrors({});
    setApprovalAcknowledgements({});
    settledApprovalsRef.current = new Set();
    setPlan([]);
    setRunAgentName(activeName);
    setRunModel(model);
    setRunOutcome('running');
    setRunning(true);
    setRunStartedAt(Date.now());
    followTailRef.current.reset();
    setShowJumpToLatest(false);

    if (inputRef.current) inputRef.current.style.height = '';

    // Subscribe before invoking Main so even the first plan/status event is owned.
    eventUnsubscribeRef.current = window.axiom.agent.onEvent((event) => {
      if (
        event.id !== id ||
        idRef.current !== id ||
        event.root !== runRootAtStart ||
        runRootRef.current !== runRootAtStart ||
        liveCapabilityRef.current !== runRootAtStart ||
        !isValidAgentEventMetadata({
          root: event.root,
          at: event.at,
          kind: event.kind,
          ...(event.progress ? { progress: event.progress } : {}),
          ...(event.outcome ? { outcome: event.outcome } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
        })
      ) {
        return;
      }
      const terminal = event.kind === 'final' || event.kind === 'error';
      setSteps((current) => [...current, event]);
      if (event.kind === 'plan') setPlan(event.plan ?? []);

      // Inline review: surface every APPLIED file change in the editor itself so
      // the user can accept or revert it per hunk, in place.
      if (event.kind === 'tool' && event.applied === true && event.diff) {
        const absolute = `${runRootAtStart}/${event.diff.path}`.replace(/\/{2,}/g, '/');
        const review = buildAiFileReview(event.diff, absolute, event.at);
        publishAiReview(review);
        // Bring the changed file to the front and let the editor type it in, so the
        // work is visible where the code lives instead of only as a chat card.
        const name = event.diff.path.split(/[\\/]/).pop() ?? event.diff.path;
        const firstLine = review.hunks[0]?.startLine ?? 1;
        openFileAt(absolute, name, Math.max(1, firstLine), 1);
        requestAgentTyping({ path: absolute, review, at: Date.now() });
      }

      if (terminal && event.outcome) {
        if (event.outcome === 'failed') {
          setRunError(event.text ?? 'Build stopped with an error.');
        }
        finishRun(id, event.outcome);
      }
    });

    void window.axiom.agent
      .run({
        id,
        provider,
        model,
        baseUrl,
        headers,
        root: runRootAtStart,
        task: taskWithAttachments(taskWithFileFocus(nextTask), attached),
        preset,
        ...(priorTurnSummary ? { priorTurnSummary } : {}),
        ...(launch ? { maxIterations: launch.maxIterations } : {}),
        ...(launch?.resumeRunId ? { resumeRunId: launch.resumeRunId } : {}),
      })
      .catch(() => {
        if (idRef.current !== id) return;
        setRunError('Build communication failed; waiting for Main task reconciliation.');
      })
      // Main's handler owns the run's lifetime, so this call settling IS the run
      // ending. A terminal event normally arrives first and this does nothing; the
      // short grace period is only there to let one that is already in flight win.
      // Without this, any dropped terminal event left the panel saying "working"
      // forever even though the agent had finished.
      .finally(() => {
        window.setTimeout(() => {
          if (idRef.current !== id || !runInFlightRef.current) return;
          finishRun(id, 'completed');
        }, 1_500);
      });
    return { accepted: true };
  };

  /** Load the workspace file list once, for the `#` picker and the attach button. */
  const ensureRefFiles = useCallback(async (): Promise<void> => {
    const root = agentCapability;
    if (!root || refFilesLoaded) return;
    setRefFilesLoaded(true);
    try {
      const listing = await window.axiom.fs.listFiles(root);
      setRefFiles(listing.files);
    } catch {
      // An unreadable workspace simply means no suggestions; typing still works.
      setRefFiles([]);
    }
  }, [agentCapability, refFilesLoaded]);

  /** Re-evaluate whether the caret sits inside a `#token`, and show the menu if so. */
  const syncRefQuery = useCallback(
    (value: string, caret: number): void => {
      const active = activeMentionFor(value, caret, '#');
      setRefQuery(active);
      setRefIndex(0);
      if (active) void ensureRefFiles();
    },
    [ensureRefFiles],
  );

  const refMatches = useMemo(
    () => (refQuery ? matchMentionFiles(refQuery.query, refFiles, 8) : []),
    [refQuery, refFiles],
  );

  /** Insert `#rel` for the chosen file and close the menu. */
  const pickRefFile = useCallback(
    (file: WorkspaceFile): void => {
      const active = refQuery;
      if (!active) return;
      const next = replaceActiveMention(task, active, `#${file.rel} `);
      setTask(next);
      setRefQuery(null);
      const caret = active.start + file.rel.length + 2;
      window.requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
      });
    },
    [refQuery, task],
  );

  /**
   * Attach button: opens the same `#` picker rather than a native file dialog.
   *
   * Build can only act inside the trusted workspace — every agent path goes through
   * root containment — so offering files from anywhere on disk would show choices the
   * agent could not honour. Pointing at workspace files is the operation that
   * actually works, and it produces the same `#` reference the user could type.
   */
  const openAttachPicker = useCallback((): void => {
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    const caret = node.selectionStart ?? task.length;
    const needsSpace = caret > 0 && !/\s$/.test(task.slice(0, caret));
    const next = `${task.slice(0, caret)}${needsSpace ? ' ' : ''}#${task.slice(caret)}`;
    const at = caret + (needsSpace ? 2 : 1);
    setTask(next);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.setSelectionRange(at, at);
      syncRefQuery(next, at);
    });
  }, [task, syncRefQuery]);

  /**
   * Attach real files or images through the OS file dialog.
   *
   * Content is read NOW rather than at send time, so the chip can immediately show
   * whether a file was readable and whether it had to be trimmed. A silent failure at
   * send time — after the user has already typed their instruction — is the worst
   * moment to discover a file could not be opened.
   */
  const attachFiles = useCallback((): void => {
    void window.axiom.dialog
      .openFiles()
      .then(async (selected) => {
        if (selected.length === 0) return;
        const additions: ComposerAttachment[] = [];
        let budget = MAX_ATTACHMENT_TOTAL_CHARS;
        for (const file of selected.slice(0, MAX_COMPOSER_ATTACHMENTS)) {
          const kind = attachmentKindFor(file.name);
          if (kind !== 'text') {
            additions.push({
              path: file.path,
              name: file.name,
              kind,
              text: null,
              truncated: false,
              error: null,
            });
            continue;
          }
          try {
            const content = await window.axiom.fs.readFile(file.path);
            const allowance = Math.min(MAX_ATTACHMENT_CHARS, Math.max(0, budget));
            const truncated = content.content.length > allowance;
            const text = truncated ? content.content.slice(0, allowance) : content.content;
            budget -= text.length;
            additions.push({
              path: file.path,
              name: file.name,
              kind,
              text,
              truncated,
              error: null,
            });
          } catch (cause) {
            additions.push({
              path: file.path,
              name: file.name,
              kind,
              text: null,
              truncated: false,
              error: cause instanceof Error ? cause.message : 'the file could not be opened',
            });
          }
        }
        setAttached((current) => {
          const seen = new Set(current.map((entry) => entry.path));
          const merged = [...current];
          for (const addition of additions) {
            if (seen.has(addition.path) || merged.length >= MAX_COMPOSER_ATTACHMENTS) continue;
            seen.add(addition.path);
            merged.push(addition);
          }
          return merged;
        });
      })
      .catch(() => {
        setRunError('Those files could not be attached.');
      });
  }, []);

  const removeAttachment = useCallback((path: string): void => {
    setAttached((current) => current.filter((entry) => entry.path !== path));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.axiom.executionConsent
      .get()
      .then((state) => {
        if (!cancelled) setExecutionConsentState(state);
      })
      .catch(() => {
        if (!cancelled) setExecutionConsentState(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleExecutionConsent = useCallback((): void => {
    const current = executionConsent;
    if (!current || consentPendingChange) return;
    setConsentPendingChange(true);
    void window.axiom.executionConsent
      .set(!current.granted)
      .then((state) => setExecutionConsentState(state))
      .catch(() => undefined)
      .finally(() => setConsentPendingChange(false));
  }, [executionConsent, consentPendingChange]);

  const decide = async (
    index: number,
    approved: boolean,
    remember: CommandConsentScope = 'once',
  ): Promise<void> => {
    const id = idRef.current;
    const approvalStep = steps[index];
    const approvalToken = approvalStep?.approvalToken;
    if (
      !id ||
      approvalStep?.id !== id ||
      !approvalToken ||
      approvalAcknowledgements[approvalToken]?.status !== 'acknowledged' ||
      !active ||
      !agentCapability ||
      approvalStep.root !== agentCapability ||
      runRootRef.current !== agentCapability ||
      liveCapabilityRef.current !== agentCapability ||
      runOutcome !== 'running' ||
      approvalPending[index] ||
      // One token, one decision. Recorded in a ref rather than state because two
      // clicks can land in the same React batch, and a user who saw nothing happen
      // clicks again — which is how the same approval got submitted repeatedly.
      settledApprovalsRef.current.has(approvalToken)
    ) {
      return;
    }
    settledApprovalsRef.current.add(approvalToken);

    setApprovalPending((pending) => ({ ...pending, [index]: true }));
    setApprovalErrors((errors) => {
      const next = { ...errors };
      delete next[index];
      return next;
    });
    try {
      await window.axiom.agent.approve(id, approvalToken, approved, remember);
      if (idRef.current === id) setDecided((current) => ({ ...current, [index]: approved }));
    } catch (cause) {
      if (idRef.current === id) {
        // Every failure path in Main's approve handler rejects the token before it
        // reports the error, so this action is finished either way. Showing it as
        // still-decidable was the bug: the buttons came back, and every further click
        // failed with "no longer active" while the user kept trying.
        setDecided((current) => ({ ...current, [index]: false }));
        setApprovalErrors((errors) => ({
          ...errors,
          [index]:
            cause instanceof Error && cause.message.length > 0
              ? `${cause.message} This action was not run.`
              : 'Main did not accept this approval decision. This action was not run.',
        }));
      }
    } finally {
      if (idRef.current === id) {
        setApprovalPending((pending) => {
          const next = { ...pending };
          delete next[index];
          return next;
        });
      }
    }
  };

  const newConversation = (): void => {
    if (running || runInFlightRef.current) return;
    setPastTurns([]);
    setRunTask('');
    setRunRoot(null);
    setRunModel(null);
    setSteps([]);
    setPlan([]);
    setApprovalAcknowledgements({});
    setRunOutcome('idle');
    setRunError(null);
    setCancelReason(null);
    setTask('');
    setAttached([]);
    followTailRef.current.reset();
    setShowJumpToLatest(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  useEffect(() => {
    if (!commandRequest || handledCommandRef.current >= commandRequest.sequence || !active) return;
    handledCommandRef.current = commandRequest.sequence;
    if (commandRequest.command === 'stop-build') {
      cancel();
      commandRequest.acknowledge({ accepted: true });
      return;
    }
    if (commandRequest.command === 'start-god-mode') {
      const admission = commandRequest.launch
        ? run(commandRequest.launch)
        : { accepted: false, reason: 'The God Mode launch payload is missing.' };
      commandRequest.acknowledge(admission);
      return;
    }
    if (commandRequest.command === 'new-build') {
      if (running || runInFlightRef.current) {
        commandRequest.acknowledge({
          accepted: false,
          reason: 'Stop the active Build before starting a new conversation.',
        });
        return;
      }
      newConversation();
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
    commandRequest.acknowledge({ accepted: true });
  }, [active, commandRequest, running]);

  const toolSteps = steps.filter((step) => step.kind === 'tool');
  /**
   * The phase Main last reported. Read from the events rather than inferred locally,
   * so the indicator never claims progress the run did not report.
   */
  const livePhase = useMemo(() => {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const phase = steps[index]?.progress?.phase;
      if (phase) return phase;
    }
    return null;
  }, [steps]);
  const commandSteps = commandStepsOf(steps);
  const terminalSteps = steps.filter((step) => step.kind === 'final' || step.kind === 'error');
  // Auditable account of the run, derived from its own events (T3.11).
  const runEvidence = buildRunEvidence(steps);
  const runEvidenceSummary = summarizeRunEvidence(runEvidence);
  /** Open a file named in the run evidence, resolved against that run's root. */
  const openRunFile = (relative: string): void => {
    const root = runRoot ?? agentCapability;
    if (!root) return;
    const absolute = `${root}/${relative}`.replace(/\/{2,}/g, '/');
    const name = relative.split(/[\\/]/).pop() ?? relative;
    openFileAt(absolute, name, 1, 1);
  };
  const approvalSteps = steps
    .map((step, index) => ({ step, index }))
    .filter((entry) => entry.step.kind === 'approval');

  return (
    <div className="agent-panel" aria-labelledby="agent-panel-title">
      <div
        ref={transcriptRef}
        className="agent-conversation"
        tabIndex={-1}
        onScroll={(event) => {
          const snapshot = followTailRef.current.observeScroll(
            isNearTranscriptBottom(event.currentTarget),
          );
          setShowJumpToLatest(snapshot.showJump);
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) disengageFollowTail();
        }}
        onTouchStart={(event) => {
          touchStartYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const currentY = event.touches[0]?.clientY ?? null;
          const previousY = touchStartYRef.current;
          if (currentY !== null && previousY !== null && currentY > previousY + 4) {
            disengageFollowTail();
          }
          touchStartYRef.current = currentY;
        }}
        onTouchEnd={() => {
          touchStartYRef.current = null;
        }}
        onPointerDown={(event) => {
          pointerStartYRef.current = event.clientY;
          const scrollbarWidth = event.currentTarget.offsetWidth - event.currentTarget.clientWidth;
          const right = event.currentTarget.getBoundingClientRect().right;
          if (scrollbarWidth > 0 && event.clientX >= right - scrollbarWidth) {
            disengageFollowTail();
          }
        }}
        onPointerMove={(event) => {
          const previousY = pointerStartYRef.current;
          if (event.buttons === 1 && previousY !== null && event.clientY < previousY - 4) {
            disengageFollowTail();
          }
          pointerStartYRef.current = event.clientY;
        }}
        onPointerUp={() => {
          pointerStartYRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) disengageFollowTail();
          if (event.key === 'End') jumpToLatest();
        }}
      >
        <div className="agent-conversation-inner">
          <div className="agent-conversation-toolbar">
            <div>
              <h2 id="agent-panel-title">Build</h2>
              <span>{rootName ?? 'No workspace open'}</span>
            </div>
            <button
              type="button"
              className="icon-btn agent-new-conversation"
              title="New Build conversation"
              aria-label="New Build conversation"
              disabled={running}
              onClick={newConversation}
            >
              <PlusIcon size={16} />
            </button>
          </div>

          {pastTurns.map((turn) => (
            <ReadOnlyTurn key={turn.id} turn={turn} />
          ))}

          {!runTask && pastTurns.length === 0 ? (
            <section className="agent-empty" aria-label="Build workspace tasks">
              <span className="agent-empty-mark" aria-hidden="true">
                <SparkIcon size={22} />
              </span>
              <h3>Build in your workspace</h3>
              <p>
                Describe an outcome. Axiom can inspect the project, create and edit files, delete
                regular files, and run focused verification inside the trusted folder.
              </p>
              <div className="agent-empty-safety">
                <ShieldIcon size={14} />
                <span>
                  {approvalMode === 'autopilot'
                    ? 'Autopilot planning is on. Every effect requires exact native approval.'
                    : 'Changes remain blocked until you approve them.'}
                </span>
              </div>
            </section>
          ) : null}

          {runTask ? (
            <article className="agent-turn agent-current-turn">
              <div className="agent-user-row">
                <div className="agent-user-bubble">
                  <span className="agent-message-label">
                    You
                    <AgentCopyButton text={runTask} label="your message" />
                  </span>
                  <p>{runTask}</p>
                </div>
              </div>

              {latestProgress && !latestSummary ? (
                <AgentProgressCard progress={latestProgress} />
              ) : null}

              {plan.length > 0 ? (
                <section className="agent-artifact-card agent-plan" aria-label="Execution plan">
                  <header className="agent-plan-head agent-event-head">
                    <span>
                      <SparkIcon size={14} />
                      Main-received plan
                    </span>
                  </header>
                  <ol className="agent-plan-list">
                    {plan.map((item, index) => (
                      <li key={`${index}-${item}`} className="agent-plan-step">
                        <span className="agent-plan-mark" aria-hidden="true">
                          <span>·</span>
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {toolSteps.length > 0 ? <ToolActivity steps={toolSteps} running={running} /> : null}

              {commandSteps.map((step, index) => (
                <CommandCard key={`${step.id}-cmd-${step.step}-${index}`} result={step.command} />
              ))}

              {approvalSteps.map(({ step, index }) => {
                const titleId = `agent-approval-${index}-title`;
                const pending = approvalPending[index] === true;
                const resolved = index in decided;
                const approvalToken = step.approvalToken;
                const acknowledgement = approvalToken
                  ? approvalAcknowledgements[approvalToken]
                  : undefined;
                const acknowledged = acknowledgement?.status === 'acknowledged';
                const safeToolLabel = agentToolLabel(step.tool);
                return (
                  <section
                    key={`${step.id}-${index}`}
                    className="agent-artifact-card agent-approval"
                    role="group"
                    aria-labelledby={titleId}
                  >
                    <header className="agent-approval-head agent-event-head">
                      <span id={titleId}>
                        <WarningIcon size={14} />
                        Approval required · {safeToolLabel}
                      </span>
                      <span className="agent-approval-state">
                        {resolved
                          ? decided[index]
                            ? 'Approved'
                            : 'Rejected'
                          : pending
                            ? 'Submitting…'
                            : runOutcome === 'running'
                              ? acknowledged
                                ? 'Awaiting decision'
                                : acknowledgement?.status === 'failed'
                                  ? 'Acknowledgement failed'
                                  : 'Displaying preview…'
                              : 'Run ended'}
                      </span>
                    </header>
                    <p className="agent-approval-copy">
                      This workspace mutation is paused. Review the exact action before deciding.
                    </p>
                    <div className="agent-approval-preview">
                      <span className="agent-event-label">Requested action</span>
                      <span>{step.text}</span>
                    </div>
                    {step.diff ? <AgentDiffView diff={step.diff} state="proposed" /> : null}
                    {approvalErrors[index] ? (
                      <div className="agent-error">
                        <WarningIcon size={14} /> Could not submit this decision:{' '}
                        {approvalErrors[index]}
                      </div>
                    ) : null}
                    {resolved ? (
                      <div className={`agent-approval-done ${decided[index] ? 'ok' : 'no'}`}>
                        {decided[index] ? <CheckIcon size={14} /> : <StopIcon size={14} />}
                        {decided[index] ? 'Approved and released to Main.' : 'Rejected; not run.'}
                      </div>
                    ) : runOutcome === 'running' ? (
                      <ApprovalActions
                        toolLabel={safeToolLabel}
                        command={approvalCommandOf(step)}
                        disabled={!active || !agentCapability || !acknowledged || pending}
                        onDecide={(approved, remember) => void decide(index, approved, remember)}
                      />
                    ) : (
                      <div className="agent-approval-done no">
                        <StopIcon size={14} /> The run ended before this action was approved.
                      </div>
                    )}
                  </section>
                );
              })}

              {appliedChanges(steps).length > 0 ? (
                <ChangedFilesCard steps={steps} root={runRoot} />
              ) : null}

              {runError && lastStep?.kind !== 'error' ? (
                <div className="agent-assistant-message agent-error">
                  <WarningIcon size={14} />
                  <div>{boundedLine(runError, 500)}</div>
                </div>
              ) : null}

              {terminalSteps.map((step, index) =>
                step.kind === 'error' ? (
                  <div
                    key={`${step.id}-terminal-${index}`}
                    className="agent-assistant-message agent-error"
                  >
                    <WarningIcon size={14} />
                    <div>{boundedLine(step.text, 500)}</div>
                  </div>
                ) : (
                  <div key={`${step.id}-terminal-${index}`} className="agent-assistant-message">
                    <span className="agent-message-label">
                      Axiom
                      <AgentCopyButton text={step.text ?? ''} label="this response" />
                    </span>
                    <AssistantBody text={step.text ?? ''} />
                  </div>
                ),
              )}

              {latestSummary ? <TerminalSummaryCard summary={latestSummary} /> : null}

              {runEvidenceSummary ? (
                <details className="agent-evidence">
                  <summary className="agent-evidence-summary">
                    {'What this run actually did \u00B7 '}
                    {runEvidenceSummary}
                  </summary>
                  <div className="agent-evidence-body">
                    {runEvidence.changed.length > 0 ? (
                      <div className="agent-evidence-group">
                        <span className="agent-evidence-label">Changes applied</span>
                        {runEvidence.changed.map((entry) => (
                          <button
                            key={`changed-${entry.path}`}
                            type="button"
                            className="agent-evidence-file"
                            title={`Open ${entry.path}`}
                            onClick={() => openRunFile(entry.path)}
                          >
                            {`${entry.path} \u00B7 ${entry.changeKind} +${entry.added}/-${entry.removed}`}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="agent-evidence-group">
                        <span className="agent-evidence-label">Changes applied</span>
                        <span className="agent-evidence-none">
                          None. No file write was confirmed in this run.
                        </span>
                      </div>
                    )}
                    {runEvidence.read.length > 0 ? (
                      <div className="agent-evidence-group">
                        <span className="agent-evidence-label">Files read</span>
                        {runEvidence.read.map((path) => (
                          <button
                            key={`read-${path}`}
                            type="button"
                            className="agent-evidence-file"
                            title={`Open ${path}`}
                            onClick={() => openRunFile(path)}
                          >
                            {path}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {runEvidence.failures.length > 0 ? (
                      <div className="agent-evidence-group">
                        <span className="agent-evidence-label">Actions that failed</span>
                        {runEvidence.failures.map((failure, index) => (
                          <span key={`fail-${index}`} className="agent-evidence-fail">
                            {`${failure.tool}: ${failure.message}`}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <p className="agent-evidence-note">
                      Derived from this run&apos;s own events. A file is listed as changed only when
                      the write was confirmed — a proposed edit that was never applied is not
                      counted.
                    </p>
                  </div>
                </details>
              ) : null}

              {cancelReason && runOutcome === 'cancelled' ? (
                <div className="agent-assistant-message agent-cancel-note">
                  <StopIcon size={14} />
                  <span>{cancelReason}</span>
                </div>
              ) : null}

              {running ? (
                <AgentWorkingIndicator
                  agentName={statusAgentName}
                  phase={livePhase}
                  startedAt={runStartedAt}
                  actions={toolSteps.length}
                  stopping={runOutcome === 'cancelling'}
                  onStop={() => cancel()}
                />
              ) : null}
            </article>
          ) : null}
        </div>
      </div>

      {showJumpToLatest ? (
        <button type="button" className="agent-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}

      <footer className="agent-composer-shell">
        <div className="agent-composer-inner">
          {!agentCapability ? (
            <div id="agent-workspace-hint" className="agent-composer-warning">
              <ShieldIcon size={14} />
              <span>{agentRestriction}</span>
            </div>
          ) : dirtyBlocked ? (
            <div id="agent-workspace-hint" className="agent-composer-warning">
              <WarningIcon size={14} />
              <span>
                Save or discard {dirtyPaths.size} unsaved{' '}
                {dirtyPaths.size === 1 ? 'editor' : 'editors'} before Build changes files.
              </span>
            </div>
          ) : null}

          {agentCapability && repoAgents.length > 0 ? (
            <details className="agent-repo-agents">
              <summary className="agent-repo-agents-summary">
                {`Agents from this repo \u00B7 ${approvedRepoAgents.length}/${
                  repoAgents.filter((file) => file.valid).length
                } enabled`}
              </summary>
              <div className="agent-repo-agents-body">
                <p className="agent-repo-agents-note">
                  These come from files in the repository. An agent&apos;s instructions act as
                  system-level guidance, so nothing here runs until you enable it — and enabling is
                  bound to the exact text below. If a later commit changes it, approval is dropped
                  and you review again.
                </p>
                {repoAgents.map((file) => {
                  if (!file.valid || !file.agent || !file.digest) {
                    return (
                      <div key={file.rel} className="agent-repo-agent is-invalid">
                        <span className="agent-repo-agent-name">{file.rel}</span>
                        <span className="agent-repo-agent-detail">
                          {file.reason ?? 'This agent file could not be used.'}
                        </span>
                      </div>
                    );
                  }
                  const enabled = approvedDigests[file.agent.id] === file.digest;
                  const stale =
                    !enabled &&
                    Object.prototype.hasOwnProperty.call(approvedDigests, file.agent.id);
                  const scope =
                    file.agent.toolScope === 'all'
                      ? 'every built-in tool'
                      : `${file.agent.toolScope.length} tool(s)`;
                  return (
                    <div
                      key={file.rel}
                      className={`agent-repo-agent${enabled ? ' is-enabled' : ''}`}
                    >
                      <label className="agent-repo-agent-head">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => toggleRepoAgent(file)}
                        />
                        <span className="agent-repo-agent-name">{file.agent.name}</span>
                        <span className="agent-repo-agent-scope">{scope}</span>
                      </label>
                      <span className="agent-repo-agent-detail">{file.agent.description}</span>
                      {stale ? (
                        <span className="agent-repo-agent-stale">
                          This file changed since you approved it. Review the instructions before
                          enabling it again.
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="agent-repo-agent-open"
                        title={`Open ${file.rel}`}
                        onClick={() => openRunFile(file.rel)}
                      >
                        {file.rel}
                      </button>
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}

          {executionConsent ? (
            <div
              className={`agent-consent-row ${executionConsent.granted ? 'is-granted' : 'is-withheld'}`}
            >
              <span className="agent-consent-icon" aria-hidden="true">
                <ShieldIcon size={12} />
              </span>
              <span className="agent-consent-text">
                {executionConsent.granted
                  ? 'One approval per action. Your decision in this panel is final — nothing asks twice.'
                  : 'Build execution permission is withheld, so every action asks for a second confirmation.'}
              </span>
              <button
                type="button"
                className="agent-consent-toggle"
                disabled={consentPendingChange}
                title={
                  executionConsent.granted
                    ? 'Withdraw the permission. Every action will ask for a second confirmation again.'
                    : 'Grant the permission so your approval in this panel settles the action.'
                }
                onClick={toggleExecutionConsent}
              >
                {consentPendingChange ? 'Saving…' : executionConsent.granted ? 'Withdraw' : 'Grant'}
              </button>
            </div>
          ) : null}

          {attached.length > 0 ? (
            <div className="agent-attachments" aria-label="Attached files">
              {attached.map((attachment) => (
                <span
                  key={attachment.path}
                  className={`agent-attachment${attachment.error ? ' is-error' : ''}`}
                  title={
                    attachment.error ? `${attachment.path} — ${attachment.error}` : attachment.path
                  }
                >
                  <span className="agent-attachment-icon" aria-hidden="true">
                    <FileIcon size={12} />
                  </span>
                  <span className="agent-attachment-name">{attachment.name}</span>
                  {attachment.kind === 'image' ? (
                    <span className="agent-attachment-note">image</span>
                  ) : attachment.kind === 'opaque' ? (
                    <span className="agent-attachment-note">binary</span>
                  ) : attachment.truncated ? (
                    <span className="agent-attachment-note">trimmed</span>
                  ) : null}
                  <button
                    type="button"
                    className="agent-attachment-remove"
                    title="Remove this attachment"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => removeAttachment(attachment.path)}
                  >
                    <CloseIcon size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="agent-composer-box">
            <label className="sr-only" htmlFor="agent-task-input">
              Describe a workspace task
            </label>
            <textarea
              ref={inputRef}
              id="agent-task-input"
              className="agent-input"
              rows={2}
              spellCheck={false}
              aria-describedby={
                !agentCapability || dirtyBlocked ? 'agent-workspace-hint' : undefined
              }
              placeholder="Ask about the workspace or describe a task…"
              value={task}
              disabled={running || !agentCapability || dirtyBlocked}
              onChange={(event) => {
                const value = event.target.value;
                setTask(value);
                syncRefQuery(value, event.target.selectionStart ?? value.length);
                event.currentTarget.style.height = 'auto';
                event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`;
              }}
              onClick={(event) =>
                syncRefQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
              }
              onBlur={() => setRefQuery(null)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                // While the `#` menu is open it owns Up/Down/Enter/Escape, so a
                // reference can be chosen without the message being sent.
                if (refQuery && refMatches.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setRefIndex((current) => (current + 1) % refMatches.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setRefIndex((current) => (current - 1 + refMatches.length) % refMatches.length);
                    return;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    const chosen = refMatches[refIndex];
                    if (chosen) {
                      event.preventDefault();
                      pickRefFile(chosen);
                      return;
                    }
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRefQuery(null);
                    return;
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  run();
                }
              }}
            />
            {refQuery ? (
              <div className="agent-ref-menu" role="listbox" aria-label="Workspace files">
                {refMatches.length === 0 ? (
                  <div className="agent-ref-empty">
                    {refFilesLoaded ? 'No matching files.' : 'Reading the workspace…'}
                  </div>
                ) : (
                  refMatches.map((file, index) => (
                    <button
                      key={file.path}
                      type="button"
                      role="option"
                      aria-selected={index === refIndex}
                      className={`agent-ref-item ${index === refIndex ? 'active' : ''}`}
                      // The textarea's blur would close the menu before a click lands.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickRefFile(file)}
                    >
                      <span className="agent-ref-name">{file.name}</span>
                      <span className="agent-ref-path">{file.rel}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            <div className="agent-composer-controls">
              {/* Two distinct operations, so two controls: attach carries a file's
                  contents in from anywhere on disk, while `#` points the agent at a
                  workspace path it reads itself. */}
              <button
                type="button"
                className="agent-attach-button"
                aria-label="Attach a file or image"
                title="Attach a file or image from your computer"
                disabled={running || !agentCapability}
                onClick={attachFiles}
              >
                <PaperclipIcon size={14} />
              </button>
              <button
                type="button"
                className="agent-attach-button agent-ref-button"
                aria-label="Reference a workspace file"
                title="Reference a workspace file (or type # in the message)"
                disabled={running || !agentCapability}
                onClick={openAttachPicker}
              >
                <span aria-hidden="true">#</span>
              </button>
              <select
                className="agent-control-select agent-permission-select"
                aria-label="Build permission"
                title="Controls read-only planning cadence. Every execution or mutation still requires native approval."
                value={approvalMode}
                disabled={running}
                onChange={(event) => onApprovalModeChange(event.target.value as AutonomyLevel)}
              >
                {(['guided', 'autopilot', 'manual'] as const).map((level) => (
                  <option key={level} value={level}>
                    {PERMISSION_LABELS[level]}
                  </option>
                ))}
              </select>
              <select
                className="agent-control-select agent-preset"
                aria-label="Agent preset"
                title={activePreset?.description ?? 'Agent preset'}
                value={preset}
                disabled={running}
                onChange={(event) => setPreset(event.target.value)}
              >
                <optgroup label="Built-in agents">
                  {AGENT_PRESETS.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </optgroup>
                {custom.length > 0 ? (
                  <optgroup label="Custom agents">
                    {custom.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {approvedRepoAgents.length > 0 ? (
                  <optgroup label="From this repo">
                    {approvedRepoAgents.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              {/* Sharing writes the agent into .axiom/agents so it can be committed. */}
              {agentCapability && custom.some((candidate) => candidate.id === preset) ? (
                <button
                  type="button"
                  className="agent-share-agent"
                  disabled={running || sharing}
                  title="Save this agent into .axiom/agents so your team can use it"
                  onClick={shareActiveAgent}
                >
                  {sharing ? 'Sharing…' : 'Share to repo'}
                </button>
              ) : null}
              <select
                className="agent-control-select agent-model-select"
                aria-label="Build model"
                title={`Build model · ${provider}`}
                value={model}
                disabled={running}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {selectableModels.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
              {running ? (
                <button
                  type="button"
                  className="agent-send-button is-stop"
                  aria-label={runOutcome === 'cancelling' ? 'Build is stopping' : 'Stop Build'}
                  disabled={runOutcome === 'cancelling'}
                  onClick={() => cancel()}
                >
                  <StopIcon size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="agent-send-button"
                  aria-label="Run Build task"
                  disabled={!task.trim() || !agentCapability || dirtyBlocked}
                  onClick={() => run()}
                >
                  <SendIcon size={15} />
                </button>
              )}
            </div>
          </div>
          {agentCapability && mutationCapable ? (
            <div className="agent-consent-group">
              <label
                className={`agent-consent-row${writeConsent?.granted ? ' is-granted' : ''}`}
                title="Applies only to ordinary file edits in this trusted folder. Commands, Git pushes, and risky actions always ask."
              >
                <input
                  type="checkbox"
                  checked={writeConsent?.granted === true}
                  disabled={consentPending}
                  onChange={(event) => toggleWriteConsent(event.target.checked)}
                />
                <span>
                  {writeConsent?.granted
                    ? `Editing files without asking${
                        writeConsent.persisted
                          ? ' \u00B7 remembered for this folder'
                          : writeConsent.remainingMs > 0
                            ? ` \u00B7 ${Math.max(1, Math.round(writeConsent.remainingMs / 60000))} min left`
                            : ''
                      } \u00B7 revertible in Checkpoints`
                    : 'Let Build edit files in this folder without asking each time (this session)'}
                </span>
              </label>
              {writeConsent?.persisted !== true ? (
                <button
                  type="button"
                  className="btn btn-ghost agent-consent-always"
                  disabled={consentPending}
                  title="Remember this permission for this folder, including after a restart. Commands and risky actions still ask every time."
                  onClick={() => setWriteConsentGrant(true, true)}
                >
                  Always allow in this folder
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="agent-composer-footnote">
            {approvalMode === 'autopilot'
              ? 'Autopilot can plan continuously; commands and risky effects always require exact approval.'
              : 'Enter sends · Shift+Enter adds a line · workspace writes use Safe Edit checkpoints.'}
          </p>
        </div>
      </footer>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </div>
    </div>
  );
}

function ReadOnlyTurn({ turn }: { turn: PastTurn }) {
  const final = [...turn.steps]
    .reverse()
    .find((step) => step.kind === 'final' || step.kind === 'error');
  const tools = turn.steps.filter((step) => step.kind === 'tool');
  const summary = terminalSummaryOf(turn.steps);
  return (
    <article className="agent-turn agent-past-turn">
      <div className="agent-user-row">
        <div className="agent-user-bubble">
          <span className="agent-message-label">You</span>
          <p>{turn.task}</p>
        </div>
      </div>
      {tools.length > 0 ? <ToolActivity steps={tools} running={false} /> : null}
      {commandStepsOf(turn.steps).map((step, index) => (
        <CommandCard key={`${step.id}-cmd-${step.step}-${index}`} result={step.command} />
      ))}
      {appliedChanges(turn.steps).length > 0 ? (
        <ChangedFilesCard steps={turn.steps} root={turn.root} />
      ) : null}
      {final?.kind === 'final' ? (
        <div className="agent-assistant-message">
          <span className="agent-message-label">
            {boundedLine(turn.agentName, 80)} · {boundedLine(turn.model, 80)}
          </span>
          <AssistantBody text={final.text ?? ''} />
        </div>
      ) : final ? (
        <div className="agent-assistant-message agent-error">
          <WarningIcon size={14} />
          <div>{final.text}</div>
        </div>
      ) : (
        <div className="agent-assistant-message agent-cancel-note">
          <StopIcon size={14} />
          <span>{turn.outcome === 'cancelled' ? 'This run was stopped.' : 'This run ended.'}</span>
        </div>
      )}
      {summary ? <TerminalSummaryCard summary={summary} /> : null}
    </article>
  );
}

/** Extensions AXIOM treats as pictures rather than text. */
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'svg',
]);

/** Extensions whose bytes are meaningless as text, so they are never inlined. */
const OPAQUE_ATTACHMENT_EXTENSIONS = new Set([
  'pdf',
  'zip',
  '7z',
  'rar',
  'tar',
  'gz',
  'tgz',
  'exe',
  'dll',
  'so',
  'dylib',
  'class',
  'jar',
  'bin',
  'iso',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'psd',
  'ai',
  'db',
  'sqlite',
]);

/** Per-file and total character budgets for inlined attachment text. */
const MAX_ATTACHMENT_CHARS = 24_000;
const MAX_ATTACHMENT_TOTAL_CHARS = 64_000;
const MAX_COMPOSER_ATTACHMENTS = 10;

type ComposerAttachmentKind = 'text' | 'image' | 'opaque';

interface ComposerAttachment {
  /** Absolute path, authorized by the native dialog Main opened. */
  path: string;
  name: string;
  kind: ComposerAttachmentKind;
  /** Bounded file text; present only for readable text files. */
  text: string | null;
  truncated: boolean;
  /** Set when the file could not be read, so the model is told rather than misled. */
  error: string | null;
}

function attachmentKindFor(name: string): ComposerAttachmentKind {
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  if (IMAGE_ATTACHMENT_EXTENSIONS.has(extension)) return 'image';
  if (OPAQUE_ATTACHMENT_EXTENSIONS.has(extension)) return 'opaque';
  return 'text';
}

/**
 * Append attached files to the task text.
 *
 * Text is inlined because an attachment may live OUTSIDE the workspace, where the
 * agent's own `read_file` cannot reach — that is precisely why an attach button is
 * not the same thing as a `#` reference. Images and binaries are NAMED rather than
 * smuggled in as decoded bytes: Build reasons over text, and saying "there is a
 * screenshot at this path" is honest, whereas pasting its bytes would waste the
 * context window and invite the model to invent what it contains.
 */
function taskWithAttachments(task: string, attachments: readonly ComposerAttachment[]): string {
  if (attachments.length === 0) return task;
  const sections: string[] = [];
  for (const attachment of attachments) {
    if (attachment.error) {
      sections.push(`- Attached file "${attachment.name}" could not be read: ${attachment.error}`);
      continue;
    }
    if (attachment.kind === 'text' && attachment.text !== null) {
      sections.push(
        [
          `--- Attached file: ${attachment.name}`,
          `--- Source: ${attachment.path}${attachment.truncated ? ' (truncated to fit)' : ''}`,
          attachment.text,
          '--- End of attached file',
        ].join('\n'),
      );
      continue;
    }
    const noun = attachment.kind === 'image' ? 'image' : 'binary file';
    sections.push(
      `- Attached ${noun}: ${attachment.name} (${attachment.path}). Build works on text, so its contents are not included here.`,
    );
  }
  return [task, '', 'The user attached the following:', ...sections].join('\n');
}

/**
 * Expand `#path` references into an explicit instruction naming those files.
 *
 * The paths are named rather than their contents pasted in: the agent already has a
 * `read_file` tool, so pointing it at the right files keeps the prompt small and
 * makes it read the CURRENT bytes instead of a snapshot that may be stale by the
 * time it acts. The user's own text is left exactly as typed.
 */
function taskWithFileFocus(task: string): string {
  const block = formatFileReferenceBlock(parseFileReferences(task));
  return block.length > 0 ? `${task}\n\n${block}` : task;
}

/**
 * The command an approval step covers, taken from the args Main echoed back.
 *
 * Used only to LABEL the remember buttons. The command Main actually stores comes
 * from its own pending-approval record, so a malformed value here can mislabel a
 * button but can never widen what gets remembered.
 */
function approvalCommandOf(step: AgentStepEvent): string | null {
  if (step.tool !== 'run_command' || typeof step.args !== 'string') return null;
  let args: unknown;
  try {
    args = JSON.parse(step.args);
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const command = typeof record.command === 'string' ? record.command : record.cmd;
  return typeof command === 'string' && command.trim().length > 0 ? command.trim() : null;
}

/**
 * The approval decision buttons.
 *
 * A single Approve/Reject pair meant the user answered the same question every time
 * the agent ran `npm test`, and answering the same prompt repeatedly is how approval
 * turns into reflex clicking. So a COMMAND approval also offers to remember the
 * decision, at two narrow scopes:
 *
 *   • this exact command line, in this folder
 *   • this program, in this folder
 *
 * There is deliberately no "allow everything in this folder" for commands: that is a
 * blanket execution bypass, and Main would refuse it anyway. Main also re-derives
 * which scopes are offerable and ignores any scope it did not offer, so these
 * buttons cannot widen an approval on their own. High-risk commands (`rm -rf`,
 * `git push --force`, `sudo`, …) are never remembered at any scope.
 */
function ApprovalActions({
  toolLabel,
  command,
  disabled,
  onDecide,
}: {
  toolLabel: string;
  command: string | null;
  disabled: boolean;
  onDecide: (approved: boolean, remember: CommandConsentScope) => void;
}) {
  const scopes = command ? offerableScopes(command) : ['once'];
  const program = command ? commandProgram(command) : null;
  const highRisk = command !== null && isHighRiskCommand(command);
  const canRemember = command !== null && !highRisk;

  return (
    <div className="agent-approval-actions">
      <button
        type="button"
        className="btn btn-ghost agent-approval-deny"
        disabled={disabled}
        aria-label={`Do not allow this ${toolLabel} action`}
        onClick={() => onDecide(false, 'once')}
      >
        <StopIcon size={14} />
        Don&apos;t allow
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={disabled}
        aria-label={`Allow this ${toolLabel} action once`}
        onClick={() => onDecide(true, 'once')}
      >
        <CheckIcon size={14} />
        Allow this time
      </button>
      {canRemember && scopes.includes('command') ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          title={`Always allow "${boundedLine(command, 120)}" in this folder`}
          onClick={() => onDecide(true, 'command')}
        >
          Always allow this command
        </button>
      ) : null}
      {canRemember && scopes.includes('program') && program ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          title={`Always allow the ${program} program in this folder`}
          onClick={() => onDecide(true, 'program')}
        >
          {`Always allow ${boundedLine(program, 40)}`}
        </button>
      ) : null}
      {highRisk ? (
        <span className="agent-approval-highrisk">
          <WarningIcon size={13} /> High-risk — this one always asks.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Render an assistant reply as prose only.
 *
 * Main already strips reasoning and protocol JSON before emitting, but this is the
 * last line of defence: a model can also embed `<think>` inside a `final` string,
 * and a custom or repo agent could route text here another way. The reasoning is
 * kept behind a collapsed disclosure — useful for diagnosing a bad run, invisible
 * the rest of the time — instead of being dumped into the transcript.
 */
function AssistantBody({ text }: { text: string }) {
  const presented = presentAssistantText(text);
  const body =
    presented.text.length > 0
      ? presented.text
      : presented.hadAction
        ? '_Ran a workspace action — see the activity above._'
        : '';
  return (
    <>
      {presented.reasoning.length > 0 ? (
        <details className="agent-reasoning">
          <summary className="agent-reasoning-summary">Model reasoning</summary>
          <pre className="agent-reasoning-body">{presented.reasoning}</pre>
        </details>
      ) : null}
      {body.length > 0 ? <div className="agent-final-content">{renderMarkdown(body)}</div> : null}
    </>
  );
}

function AgentProgressCard({ progress }: { progress: AgentProgress }) {
  const hasCount = progress.completed !== undefined && progress.total !== undefined;
  return (
    <section className="agent-progress-card" aria-label="Build progress">
      <div className="agent-progress-head">
        <span>
          <SparkIcon size={13} /> {progressLabel(progress)}
        </span>
        <span>
          Elapsed {formatDuration(progress.elapsedMs)}
          {progress.etaMs !== null ? ` · approximately ${formatDuration(progress.etaMs)} left` : ''}
        </span>
      </div>
      {hasCount ? (
        <>
          <progress
            value={progress.completed}
            max={progress.total || 1}
            aria-label={`${progress.completed} of ${progress.total} Build steps complete`}
          />
          <span className="agent-progress-count">
            {progress.completed}/{progress.total} complete
          </span>
        </>
      ) : null}
    </section>
  );
}

function TerminalSummaryCard({ summary }: { summary: AgentTerminalSummary }) {
  const verificationLabel =
    summary.verification === 'not-run'
      ? 'Not run'
      : summary.verification === 'passed'
        ? 'Passed'
        : 'Failed';
  return (
    <section className="agent-summary-card" aria-label="Build final summary">
      <header>
        <CheckIcon size={14} /> Final summary
      </header>
      <dl>
        <div>
          <dt>Outcome</dt>
          <dd>{summary.outcome.charAt(0).toUpperCase() + summary.outcome.slice(1)}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{formatDuration(summary.elapsedMs)}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{summary.toolCalls}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{summary.filesChanged}</dd>
        </div>
        <div>
          <dt>Checkpoints</dt>
          <dd>{summary.checkpointsCreated}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>{verificationLabel}</dd>
        </div>
      </dl>
      <div className="agent-summary-models">
        Model trail:{' '}
        {summary.modelTrail
          .slice(-6)
          .map((item) => boundedLine(item, 80))
          .join(' → ')}
      </div>
    </section>
  );
}

/** Plain-language name for a Main-reported phase; unknown phases read as "working". */
function workingPhaseLabel(phase: string | null): string {
  switch (phase) {
    case 'grounding':
      return 'reading the workspace';
    case 'acting':
      return 'making changes';
    case 'verifying':
      return 'verifying';
    case 'finalizing':
      return 'wrapping up';
    case 'awaiting-approval':
      return 'waiting for your approval';
    default:
      return 'working';
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The live run indicator.
 *
 * The previous version was a bare box that said only "… is working", which conveyed
 * nothing and — worse — looked identical whether the agent was mid-edit or stuck
 * waiting on something. This states what phase Main reports, how long the run has
 * been going, how many actions it has taken, and offers Stop in the same place, so a
 * run that stalls is visibly a stalled run rather than an ambiguous spinner.
 *
 * Deliberately NOT a live region. The panel already has one polite announcer for run
 * status, and a second one here would make every screen reader repeat itself once a
 * second as the elapsed timer ticks. The text stays readable on navigation; only the
 * decoration is hidden.
 */
function AgentWorkingIndicator({
  agentName,
  phase,
  startedAt,
  actions,
  stopping,
  onStop,
}: {
  agentName: string;
  phase: string | null;
  startedAt: number | null;
  actions: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = startedAt === null ? null : formatElapsed(now - startedAt);
  return (
    <section className={`agent-working${stopping ? ' is-stopping' : ''}`}>
      <span className="agent-working-orb" aria-hidden="true">
        <span className="agent-working-orb-core" />
        <span className="agent-working-orb-ring" />
      </span>
      <div className="agent-working-body">
        <div className="agent-working-headline">
          <strong className="agent-working-name">{agentName}</strong>
          <span className="agent-working-phase">
            {stopping ? 'stopping' : workingPhaseLabel(phase)}
          </span>
        </div>
        <div className="agent-working-meta">
          {elapsed ? <span>{elapsed}</span> : null}
          {elapsed && actions > 0 ? (
            <span className="agent-working-dot" aria-hidden="true" />
          ) : null}
          {actions > 0 ? (
            <span>
              {actions} {actions === 1 ? 'action' : 'actions'}
            </span>
          ) : null}
        </div>
        <span className="agent-working-track" aria-hidden="true">
          <span className="agent-working-beam" />
        </span>
      </div>
      <button
        type="button"
        className="agent-working-stop"
        onClick={onStop}
        disabled={stopping}
        title="Stop this run"
        aria-label="Stop this run"
      >
        <StopIcon size={12} />
        <span>{stopping ? 'Stopping…' : 'Stop'}</span>
      </button>
    </section>
  );
}

function ToolActivity({ steps, running }: { steps: AgentStepEvent[]; running: boolean }) {
  const failures = steps.filter(runFailed).length;
  return (
    <details className="agent-activity-card" open={running || undefined}>
      <summary>
        <span>
          <ToolIcon size={14} />
          Tool activity
        </span>
        <span>
          {steps.length} {steps.length === 1 ? 'action' : 'actions'}
          {failures > 0 ? ` · ${failures} failed` : ''}
        </span>
      </summary>
      <div className="agent-activity-list">
        {steps.map((step, index) => (
          <div key={`${step.id}-${step.step}-${index}`} className="agent-activity-item">
            <div className="agent-activity-head">
              <span className={runFailed(step) ? 'is-error' : ''}>
                <span className="agent-activity-glyph" aria-hidden="true">
                  <AgentToolGlyph tool={step.tool} />
                </span>
                {runFailed(step) ? <WarningIcon size={13} /> : <CheckIcon size={13} />}
                {agentToolLabel(step.tool)}
              </span>
              {step.applied === true ? <span className="agent-applied-badge">Applied</span> : null}
            </div>
            <div className="agent-activity-summary">
              <span className="agent-event-label">Request</span>
              <span>{summarizeToolRequest(step)}</span>
            </div>
            <div className="agent-activity-summary">
              <span className="agent-event-label">Result</span>
              <span>{summarizeToolObservation(step)}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One approved shell command, rendered as a real terminal block: the command, the
 * exit status, and the bounded output Main captured.
 *
 * The payload is the Main-authored `AgentCommandResult`, never the raw tool
 * observation — the observation is untrusted model-facing text and stays hidden.
 * Failed commands open by default, because that is the case where the user needs
 * the output immediately.
 */
function CommandCard({ result }: { result: AgentCommandResult }) {
  const failed = commandFailed(result);
  const outputLabel = failed ? 'Full error output' : 'Output';
  const hasOutput = result.output.length > 0;
  return (
    <details
      className={`agent-command-card${failed ? ' is-error' : ''}`}
      open={failed || undefined}
    >
      <summary>
        <span className="agent-command-title">
          <TerminalIcon size={14} />
          <code className="agent-command-line">{result.command}</code>
        </span>
        <span className={`agent-command-exit${failed ? ' is-error' : ''}`}>
          {commandStatusLabel(result)}
        </span>
      </summary>
      <div className="agent-command-body">
        <div className="agent-command-outhead">
          <span className="agent-event-label">{outputLabel}</span>
          <span className="agent-command-actions">
            <AgentCopyButton text={result.command} label="this command" />
            {hasOutput ? <AgentCopyButton text={result.output} label="this output" /> : null}
          </span>
        </div>
        <pre
          className="agent-command-output"
          tabIndex={0}
          role="group"
          aria-label={`${outputLabel} for the command ${result.command}`}
        >
          {hasOutput ? result.output : '(no output)'}
        </pre>
        {result.truncated ? (
          <div className="agent-command-trunc">
            Output truncated for display. Credentials are removed before output is shown.
          </div>
        ) : null}
      </div>
    </details>
  );
}

type ReviewDecision = 'idle' | 'arming' | 'working' | 'accepted' | 'rejected' | 'failed';

/**
 * Post-turn review bar: what changed, and the three decisions a user actually
 * wants afterwards — read it, keep it, or undo it.
 *
 * Accept is renderer-local by design: the edits are already committed on disk, so
 * accepting only dismisses the pending inline review markers. Reject is the
 * opposite — it mutates files, so it goes through Main's existing audited,
 * path-authorized checkpoint restore, and is deliberately two-step. A turn whose
 * changes predate this build carries no checkpoint id, and Reject stays disabled
 * rather than silently doing nothing.
 */
function ChangedFilesCard({
  steps,
  root,
}: {
  steps: readonly AgentStepEvent[];
  root: string | null;
}) {
  const { openFileAt } = useWorkspace();
  const [decision, setDecision] = useState<ReviewDecision>('idle');
  const [note, setNote] = useState<string | null>(null);
  const changes = appliedChanges(steps);
  const uniquePaths = [...new Set(changes.map((change) => change.diff.path))];
  const added = changes.reduce((sum, change) => sum + change.diff.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.diff.removed, 0);
  // Newest checkpoint first, so restoring walks the turn backwards.
  const checkpointIds = [
    ...new Set(
      changes
        .filter((change) => typeof change.checkpointId === 'string')
        .map((change) => change.checkpointId as string),
    ),
  ].reverse();
  const canRevert = checkpointIds.length > 0;
  const busy = decision === 'working';
  const settled = decision === 'accepted' || decision === 'rejected';

  const absolute = (rel: string): string | null =>
    root ? `${root}/${rel}`.replace(/\/{2,}/g, '/') : null;

  const acceptAll = (): void => {
    for (const rel of uniquePaths) {
      const path = absolute(rel);
      if (path) clearAiReview(path);
    }
    setDecision('accepted');
    setNote(`Kept ${uniquePaths.length} changed ${uniquePaths.length === 1 ? 'file' : 'files'}.`);
    notifyInfo('Accepted all Build changes', { source: 'Axiom AI' });
  };

  const rejectAll = (): void => {
    setDecision('working');
    setNote(null);
    void (async () => {
      let restored = 0;
      let failures = 0;
      for (const id of checkpointIds) {
        try {
          const outcome = await window.axiom.snapshots.restore(id);
          restored += outcome.restored;
        } catch {
          failures += 1;
        }
      }
      for (const rel of uniquePaths) {
        const path = absolute(rel);
        if (path) clearAiReview(path);
      }
      if (failures > 0 && restored === 0) {
        setDecision('failed');
        setNote('Nothing could be restored. Open Timeline to restore a checkpoint manually.');
        notifyError('Could not undo Build changes', { source: 'Axiom AI' });
        return;
      }
      setDecision('rejected');
      setNote(
        failures > 0
          ? `Restored ${restored} file(s); ${failures} checkpoint(s) could not be restored.`
          : `Restored ${restored} file(s) to their pre-Build state.`,
      );
      notifyInfo(`Reverted ${restored} file(s)`, { source: 'Axiom AI' });
    })();
  };

  return (
    <details className="agent-changes-card" open={!settled || undefined}>
      <summary>
        <span>
          <CheckIcon size={14} />
          {uniquePaths.length} {uniquePaths.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="agent-change-stats">
          <span className="add">+{added}</span>
          <span className="del">−{removed}</span>
          <span>Review</span>
        </span>
      </summary>
      <div className="agent-review-bar">
        <span className="agent-review-hint">
          {settled
            ? (note ?? 'Reviewed.')
            : 'Changes are already saved. Open them for inline review, keep them, or undo the whole turn.'}
        </span>
        <span className="agent-review-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !root}
            onClick={() => {
              // Bounded: opening every file of a large turn would flood the editor.
              for (const rel of uniquePaths.slice(0, 8)) {
                const path = absolute(rel);
                if (path) openFileAt(path, rel.split(/[\\/]/).pop() ?? rel, 1, 1);
              }
            }}
          >
            Review edits
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || settled}
            onClick={acceptAll}
          >
            Accept all files
          </button>
          {decision === 'arming' ? (
            <>
              <button type="button" className="btn btn-danger" onClick={rejectAll}>
                {`Undo ${uniquePaths.length} file(s)`}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setDecision('idle');
                  setNote(null);
                }}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ghost agent-review-reject"
              disabled={busy || settled || !canRevert}
              title={
                canRevert
                  ? 'Restore every file this turn changed'
                  : 'This turn has no restorable checkpoint'
              }
              onClick={() => {
                setDecision('arming');
                setNote(null);
              }}
            >
              {busy ? 'Undoing\u2026' : 'Reject edits'}
            </button>
          )}
        </span>
      </div>
      {decision === 'arming' ? (
        <p className="agent-review-warning">
          <WarningIcon size={13} /> This rewrites {uniquePaths.length} file(s) on disk from the
          pre-Build checkpoint. A file you edited yourself since then is left untouched rather than
          overwritten.
        </p>
      ) : null}
      {note && !settled ? <p className="agent-review-note">{note}</p> : null}
      <div className="agent-change-list">
        {changes.map((change, index) => (
          <AgentDiffView
            key={`${change.diff.path}-${change.step}-${index}`}
            diff={change.diff}
            state="applied"
          />
        ))}
      </div>
    </details>
  );
}

function diffSign(kind: AgentDiffLine['kind']): string {
  if (kind === 'add') return '+';
  if (kind === 'del') return '−';
  if (kind === 'hunk') return '';
  return ' ';
}

function lineKind(kind: AgentDiffLine['kind']): string {
  if (kind === 'add') return 'Added line';
  if (kind === 'del') return 'Deleted line';
  if (kind === 'hunk') return 'Diff hunk';
  return 'Context line';
}

/** Renders source-bound proposed/applied changes without relying on color alone. */
function AgentDiffView({ diff, state }: { diff: AgentFileDiff; state: 'proposed' | 'applied' }) {
  const kindLabel =
    diff.changeKind === 'create'
      ? 'New file'
      : diff.changeKind === 'delete'
        ? 'Deleted'
        : 'Modified';
  return (
    <section className="agent-diff" aria-label={`${state} ${kindLabel.toLowerCase()} ${diff.path}`}>
      <header className="agent-diff-head">
        <span className="agent-diff-path">{diff.path}</span>
        <span className={`agent-diff-badge is-${diff.changeKind}`}>{kindLabel}</span>
        <span className="agent-diff-stat add" aria-label={`${diff.added} lines added`}>
          +{diff.added}
        </span>
        <span className="agent-diff-stat del" aria-label={`${diff.removed} lines removed`}>
          −{diff.removed}
        </span>
      </header>
      {diff.lines.length === 0 ? (
        <div className="agent-diff-empty">No textual changes.</div>
      ) : (
        <div className="agent-diff-body" role="table" aria-label="Unified file diff">
          {diff.lines.map((line, index) => (
            <div
              key={index}
              className={`agent-diff-line ${line.kind}`}
              role="row"
              aria-label={`${lineKind(line.kind)}: ${line.text || 'blank'}`}
            >
              <span className="agent-diff-num" role="cell" aria-label="Old line number">
                {line.oldLine ?? ''}
              </span>
              <span className="agent-diff-num" role="cell" aria-label="New line number">
                {line.newLine ?? ''}
              </span>
              <span className="agent-diff-sign" role="cell" aria-hidden="true">
                {diffSign(line.kind)}
              </span>
              <span className="agent-diff-code" role="cell">
                {line.text || ' '}
              </span>
            </div>
          ))}
        </div>
      )}
      {diff.truncated ? <div className="agent-diff-trunc">Diff truncated for display.</div> : null}
    </section>
  );
}
