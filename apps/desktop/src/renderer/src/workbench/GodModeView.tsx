import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DebugEvent } from '../../../common/ipc';
import type {
  CapabilityDescriptor,
  CollaborationEvent,
  CollaborationRole,
  CollaborationSession,
  ContextEvalSuiteResult,
  ContextIntelligenceReport,
  DebugEvidenceSnapshot,
  DeploymentPlan,
  DeploymentProvider,
  DeploymentRun,
  DeploymentTarget,
  ExtensionSandboxStatus,
  GithubIssue,
  GodModeCapabilityId,
  GodModeJob,
  GodModeSnapshot,
  IsolatedWorkspaceProfile,
  IssueWorkPlan,
  PredictionMetrics,
  PreviewSnapshot,
  PullRequestResult,
  RemoteProbeResult,
  VerificationPlan,
  VerificationRunResult,
  WorkspaceBackend,
  WorkspaceCommandResult,
} from '../../../common/godMode';
import { GOD_MODE_CAPABILITIES } from '../../../common/godMode';
import { requestAiDockCommand } from '../commands/commandBuses';
import { notifyError, notifyInfo } from '../notifications/bus';
import { useLayout } from '../state/layout';
import { useWorkspace } from '../state/workspace';
import { useWorkspaceTrust } from '../state/workspaceTrust';
import {
  CheckIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  SparkIcon,
  StopIcon,
  WarningIcon,
} from './icons';

type Section = 'overview' | GodModeCapabilityId;

const CAPABILITY_ORDER: readonly GodModeCapabilityId[] = GOD_MODE_CAPABILITIES;
const TAB_ORDER: readonly Section[] = ['overview', ...CAPABILITY_ORDER];
const STATUS_LABEL: Record<CapabilityDescriptor['readiness'], string> = {
  ready: 'Ready',
  'setup-required': 'Setup required',
  restricted: 'Restricted',
  unavailable: 'Unavailable',
};

function detailOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The operation could not be completed.';
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function SectionIntro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <header className="godmode-section-intro">
      <span className="godmode-kicker">Axiom control plane</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </header>
  );
}

function ConfirmBox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="godmode-confirm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function ResultBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="godmode-result" role="status" aria-live="polite" aria-atomic="true">
      {children}
    </div>
  );
}

function GuardNotice({ trusted }: { trusted: boolean }) {
  if (trusted) return null;
  return (
    <div className="godmode-guard" role="status">
      <ShieldIcon size={15} />
      <span>Trust the open workspace to enable root-bound tools and mutations.</span>
    </div>
  );
}

export function GodModeView() {
  const { rootPath } = useWorkspace();
  const trust = useWorkspaceTrust();
  const layout = useLayout();
  const trusted = Boolean(rootPath && trust.trusted);
  const [section, setSection] = useState<Section>('overview');
  const tabRefs = useRef(new Map<Section, HTMLButtonElement>());
  const [snapshot, setSnapshot] = useState<GodModeSnapshot | null>(null);
  const [jobs, setJobs] = useState<GodModeJob[]>([]);
  const [metrics, setMetrics] = useState<PredictionMetrics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const workspaceIdentity = `${rootPath ?? '<none>'}\u0000${trusted ? 'trusted' : 'restricted'}`;
  const workspaceGenerationRef = useRef({ identity: workspaceIdentity, generation: 0 });
  if (workspaceGenerationRef.current.identity !== workspaceIdentity) {
    workspaceGenerationRef.current = {
      identity: workspaceIdentity,
      generation: workspaceGenerationRef.current.generation + 1,
    };
    // A prior-root action no longer owns admission or UI reconciliation.
    inFlightRef.current = false;
  }
  const [error, setError] = useState<string | null>(null);

  const [contextQuery, setContextQuery] = useState('');
  const [expectedPaths, setExpectedPaths] = useState('');
  const [contextReport, setContextReport] = useState<ContextIntelligenceReport | null>(null);
  const [contextEval, setContextEval] = useState<ContextEvalSuiteResult | null>(null);

  const [jobGoal, setJobGoal] = useState('');
  const [maxIterations, setMaxIterations] = useState(5);

  const [previewUrl, setPreviewUrl] = useState('http://localhost:3000');
  const [previewCommand, setPreviewCommand] = useState('');
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);

  const [verificationPlan, setVerificationPlan] = useState<VerificationPlan | null>(null);
  const [selectedChecks, setSelectedChecks] = useState<string[]>([]);
  const [verificationApproval, setVerificationApproval] = useState<string | null>(null);
  const [verificationResult, setVerificationResult] = useState<VerificationRunResult | null>(null);
  const [activeVerificationPlanId, setActiveVerificationPlanId] = useState<string | null>(null);
  const [debugThreadId, setDebugThreadId] = useState<number | null>(null);
  const [debugEvidence, setDebugEvidence] = useState<DebugEvidenceSnapshot | null>(null);

  const [issueOwner, setIssueOwner] = useState('');
  const [issueRepo, setIssueRepo] = useState('');
  const [issueNumber, setIssueNumber] = useState(1);
  const [issueConfirmed, setIssueConfirmed] = useState(false);
  const [prApproval, setPrApproval] = useState<string | null>(null);
  const [issue, setIssue] = useState<GithubIssue | null>(null);
  const [issuePlan, setIssuePlan] = useState<IssueWorkPlan | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [prSummary, setPrSummary] = useState('');
  const [prCommitMessage, setPrCommitMessage] = useState('');
  const [prHead, setPrHead] = useState('');
  const [prBase, setPrBase] = useState('main');
  const [prDraft, setPrDraft] = useState(false);
  const [prResult, setPrResult] = useState<PullRequestResult | null>(null);

  const [workspaceProfiles, setWorkspaceProfiles] = useState<IsolatedWorkspaceProfile[]>([]);
  const [workspaceName, setWorkspaceName] = useState('Axiom isolated workspace');
  const [workspaceBackend, setWorkspaceBackend] = useState<WorkspaceBackend>('local-clone');
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceDistro, setWorkspaceDistro] = useState('');
  const [workspaceHost, setWorkspaceHost] = useState('');
  const [workspaceUser, setWorkspaceUser] = useState('');
  const [workspaceContainer, setWorkspaceContainer] = useState('');
  const [workspaceApproval, setWorkspaceApproval] = useState<string | null>(null);
  const [workspaceCommandApproval, setWorkspaceCommandApproval] = useState<string | null>(null);
  const [workspaceRemovalId, setWorkspaceRemovalId] = useState<string | null>(null);
  const [workspaceCommand, setWorkspaceCommand] = useState('');
  const [workspaceResult, setWorkspaceResult] = useState<WorkspaceCommandResult | null>(null);
  const [probeResult, setProbeResult] = useState<RemoteProbeResult | null>(null);

  const [extensions, setExtensions] = useState<ExtensionSandboxStatus[]>([]);
  const [extensionApprovalId, setExtensionApprovalId] = useState<string | null>(null);
  const [unsignedApprovalId, setUnsignedApprovalId] = useState<string | null>(null);

  const [sessions, setSessions] = useState<CollaborationSession[]>([]);
  const [sessionTitle, setSessionTitle] = useState('Engineering handoff');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [collaborationKind, setCollaborationKind] = useState<CollaborationEvent['kind']>('note');
  const [collaborationText, setCollaborationText] = useState('');
  const [collaborationLinks, setCollaborationLinks] = useState<string[]>([]);
  const [collaborationShareApprovalId, setCollaborationShareApprovalId] = useState<string | null>(null);
  const [collaborationMemberApproval, setCollaborationMemberApproval] = useState<string | null>(null);
  const [memberId, setMemberId] = useState('');
  const [memberRole, setMemberRole] = useState<CollaborationRole>('viewer');
  const [exportSummary, setExportSummary] = useState('');

  const [deploymentProvider, setDeploymentProvider] = useState<DeploymentProvider>('local-static');
  const [targetId, setTargetId] = useState('preview');
  const [targetName, setTargetName] = useState('Preview');
  const [outputDirectory, setOutputDirectory] = useState('dist');
  const [repository, setRepository] = useState('');
  const [workflow, setWorkflow] = useState('preview.yml');
  const [deploymentRef, setDeploymentRef] = useState('main');
  const [hookUrl, setHookUrl] = useState('');
  const [hookStorageConfirmed, setHookStorageConfirmed] = useState(false);
  const [hookBinding, setHookBinding] = useState<{
    secretRef: string;
    hookOrigin: string;
    hookRevision: string;
    hookUrlSha256: string;
  } | null>(null);
  const [deploymentPlan, setDeploymentPlan] = useState<DeploymentPlan | null>(null);
  const [deploymentRuns, setDeploymentRuns] = useState<DeploymentRun[]>([]);
  const [deploymentApprovalId, setDeploymentApprovalId] = useState<string | null>(null);

  const runAction = useCallback(
    async <T,>(
      key: string,
      operation: () => Promise<T>,
      apply?: (value: T) => void | Promise<void>,
    ): Promise<T | null> => {
      if (inFlightRef.current) return null;
      const generation = workspaceGenerationRef.current.generation;
      const identity = workspaceGenerationRef.current.identity;
      const isCurrent = (): boolean =>
        workspaceGenerationRef.current.generation === generation &&
        workspaceGenerationRef.current.identity === identity;
      inFlightRef.current = true;
      setBusy(key);
      setError(null);
      try {
        const value = await operation();
        if (!isCurrent()) return null;
        await apply?.(value);
        return isCurrent() ? value : null;
      } catch (caught) {
        if (!isCurrent()) return null;
        const message = detailOf(caught);
        setError(message);
        notifyError('God Mode operation failed', { source: 'God Mode', detail: message });
        return null;
      } finally {
        if (isCurrent()) {
          inFlightRef.current = false;
          setBusy((current) => (current === key ? null : current));
        }
      }
    },
    [],
  );

  const refreshOverview = useCallback(async (): Promise<void> => {
    const generation = workspaceGenerationRef.current.generation;
    const identity = workspaceGenerationRef.current.identity;
    const results = await Promise.allSettled([
      window.axiom.godMode.snapshot(rootPath),
      window.axiom.ai.completionMetrics(),
      trusted && rootPath ? window.axiom.godMode.jobs.list(rootPath) : Promise.resolve([]),
    ]);
    if (
      workspaceGenerationRef.current.generation !== generation ||
      workspaceGenerationRef.current.identity !== identity
    ) {
      return;
    }
    if (results[0].status === 'fulfilled') setSnapshot(results[0].value);
    if (results[1].status === 'fulfilled') setMetrics(results[1].value);
    if (results[2].status === 'fulfilled') setJobs(results[2].value);
  }, [rootPath, trusted]);

  useEffect(() => {
    const generation = workspaceGenerationRef.current.generation;
    const identity = workspaceGenerationRef.current.identity;
    const isCurrent = (): boolean =>
      workspaceGenerationRef.current.generation === generation &&
      workspaceGenerationRef.current.identity === identity;

    // Clear synchronously in the committed root/trust transition before any hydration can land.
    setBusy(null);
    setError(null);
    setSnapshot(null);
    setJobs([]);
    setMetrics(null);
    setContextReport(null);
    setContextEval(null);
    setPreview(null);
    setPreviewConfirmed(false);
    setVerificationPlan(null);
    setSelectedChecks([]);
    setVerificationApproval(null);
    setVerificationResult(null);
    setActiveVerificationPlanId(null);
    setDebugThreadId(null);
    setDebugEvidence(null);
    setIssue(null);
    setIssuePlan(null);
    setIssueConfirmed(false);
    setPrApproval(null);
    setPrResult(null);
    setPrTitle('');
    setPrSummary('');
    setPrCommitMessage('');
    setPrHead('');
    setWorkspaceProfiles([]);
    setWorkspaceApproval(null);
    setWorkspaceCommandApproval(null);
    setWorkspaceRemovalId(null);
    setWorkspaceResult(null);
    setProbeResult(null);
    setExtensions([]);
    setExtensionApprovalId(null);
    setUnsignedApprovalId(null);
    setSessions([]);
    setSelectedSessionId('');
    setCollaborationShareApprovalId(null);
    setCollaborationMemberApproval(null);
    setCollaborationLinks([]);
    setExportSummary('');
    setMemberId('');
    setDeploymentPlan(null);
    setDeploymentRuns([]);
    setDeploymentApprovalId(null);
    setHookBinding(null);

    void refreshOverview();
    if (trusted && rootPath) {
      void window.axiom.godMode.preview
        .get(rootPath)
        .then((value) => {
          if (isCurrent()) setPreview(value);
        })
        .catch(() => undefined);
      void window.axiom.godMode.deployment
        .list(rootPath)
        .then((value) => {
          if (isCurrent()) setDeploymentRuns(value);
        })
        .catch(() => undefined);
      void window.axiom.godMode.workspaces
        .list(rootPath)
        .then((value) => {
          if (isCurrent()) setWorkspaceProfiles(value);
        })
        .catch(() => undefined);
      void window.axiom.godMode.extensions
        .list(rootPath)
        .then((value) => {
          if (isCurrent()) setExtensions(value);
        })
        .catch(() => undefined);
      void window.axiom.godMode.collaboration
        .list(rootPath)
        .then((value) => {
          if (isCurrent()) setSessions(value);
        })
        .catch(() => undefined);
    }
  }, [refreshOverview, rootPath, trusted]);

  useEffect(() => {
    const generation = workspaceGenerationRef.current.generation;
    const identity = workspaceGenerationRef.current.identity;
    const unsubscribe = window.axiom.debug.onEvent((event: DebugEvent) => {
      if (
        workspaceGenerationRef.current.generation !== generation ||
        workspaceGenerationRef.current.identity !== identity ||
        event.kind !== 'state'
      ) {
        return;
      }
      if (event.state === 'stopped' && event.threadId !== null) setDebugThreadId(event.threadId);
      if (event.state === 'inactive' || event.state === 'terminated') {
        setDebugThreadId(null);
        setDebugEvidence(null);
      }
    });
    return unsubscribe;
  }, [workspaceIdentity]);

  const capabilityById = useMemo(
    () => new Map(snapshot?.capabilities.map((item) => [item.id, item]) ?? []),
    [snapshot],
  );

  const dispatchJob = useCallback(
    async (job: GodModeJob): Promise<void> => {
      if (!rootPath) throw new Error('Open and trust the job workspace before launching it.');
      const started = await window.axiom.godMode.jobs.claim(rootPath, job.id);
      layout.showAiPanel();
      const acknowledgement = await requestAiDockCommand('start-god-mode', {
        jobId: started.id,
        root: rootPath,
        task: started.summary,
        maxIterations: started.maxIterations,
        ...(started.resumeRunId ? { resumeRunId: started.resumeRunId } : {}),
      });
      if (!acknowledgement.accepted) {
        await window.axiom.godMode.jobs
          .control(rootPath, { id: started.id, action: 'pause' })
          .catch(() => undefined);
        throw new Error(acknowledgement.reason ?? 'Build did not accept the durable job.');
      }
      setJobs(await window.axiom.godMode.jobs.list(rootPath));
    },
    [layout, rootPath],
  );

  const createAndLaunchJob = useCallback(
    async (goal: string, iterations = maxIterations): Promise<void> => {
      if (!rootPath || !trusted || !goal.trim()) return;
      await runAction('job-launch', async () => {
        const created = await window.axiom.godMode.jobs.create({
          root: rootPath,
          goal: goal.trim(),
          maxIterations: iterations,
        });
        await dispatchJob(created);
        setJobGoal('');
        return created;
      });
    },
    [dispatchJob, maxIterations, rootPath, runAction, trusted],
  );

  const controlJob = async (job: GodModeJob, action: 'pause' | 'resume' | 'cancel'): Promise<void> => {
    if (!rootPath) return;
    await runAction(`job-${action}-${job.id}`, async () => {
      const result = await window.axiom.godMode.jobs.control(rootPath, { id: job.id, action });
      if (action === 'resume') await dispatchJob(result);
      setJobs(await window.axiom.godMode.jobs.list(rootPath));
      return result;
    });
  };

  const cancelActiveVerification = async (): Promise<void> => {
    const planId = activeVerificationPlanId;
    if (!planId) return;
    try {
      await window.axiom.godMode.verification.cancel(planId);
      setActiveVerificationPlanId((current) => (current === planId ? null : current));
    } catch (caught) {
      const message = detailOf(caught);
      setError(message);
      notifyError('Unable to stop verification', { source: 'God Mode', detail: message });
    }
  };

  const issueRef = { owner: issueOwner.trim(), repo: issueRepo.trim(), number: issueNumber };
  const prTarget = JSON.stringify({
    issue: issueRef,
    title: prTitle.trim(),
    summary: prSummary,
    commitMessage: prCommitMessage.trim(),
    head: prHead.trim(),
    base: prBase.trim(),
    draft: prDraft,
    verificationPlanId: verificationPlan?.id ?? '',
    verificationEndedAt: verificationResult?.endedAt ?? 0,
  });
  const selectedSession = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0] ?? null;
  const collaborationMemberTarget = selectedSession
    ? `${selectedSession.id}:${memberId.trim().toLowerCase()}:${memberRole}`
    : null;
  const verificationTarget = verificationPlan
    ? `${verificationPlan.id}:${[...selectedChecks].sort().join(',')}`
    : null;
  const workspaceTarget = JSON.stringify({
    name: workspaceName.trim(),
    backend: workspaceBackend,
    path: workspacePath.trim(),
    distro: workspaceDistro.trim(),
    host: workspaceHost.trim(),
    user: workspaceUser.trim(),
    container: workspaceContainer.trim(),
  });
  const workspaceCommandTarget = (profileId: string): string =>
    `${profileId}:${workspaceCommand.trim()}`;

  const handleTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: Section): void => {
    const index = TAB_ORDER.indexOf(current);
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TAB_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = TAB_ORDER[nextIndex]!;
    setSection(next);
    tabRefs.current.get(next)?.focus();
  };

  const invalidateDeploymentPlan = (): void => {
    setDeploymentPlan(null);
    setDeploymentApprovalId(null);
  };

  const deploymentTarget = (): DeploymentTarget => ({
    id: targetId.trim(),
    name: targetName.trim(),
    provider: deploymentProvider,
    ...(deploymentProvider === 'local-static' ? { outputDirectory: outputDirectory.trim() } : {}),
    ...(deploymentProvider === 'github-actions'
      ? {
          repository: repository.trim(),
          workflow: workflow.trim(),
          ref: deploymentRef.trim(),
        }
      : {}),
    ...(deploymentProvider === 'deploy-hook' && hookBinding ? { ...hookBinding } : {}),
  });

  const renderOverview = () => (
    <>
      <SectionIntro title="God Mode">
        Ten guarded engineering capabilities, one Main-authoritative control plane. Readiness reflects
        the active workspace and local setup—not hypothetical cloud infrastructure.
      </SectionIntro>
      <div className="godmode-overview-summary" aria-label="God Mode status summary">
        <div><strong>{snapshot?.activeJobs ?? 0}</strong><span>Active</span></div>
        <div><strong>{snapshot?.queuedJobs ?? 0}</strong><span>Queued</span></div>
        <div><strong>{snapshot?.trusted ? 'Yes' : 'No'}</strong><span>Trusted</span></div>
      </div>
      <GuardNotice trusted={trusted} />
      <div className="godmode-capability-grid">
        {CAPABILITY_ORDER.map((id) => {
          const capability = capabilityById.get(id);
          return (
            <button
              key={id}
              type="button"
              className="godmode-capability-card"
              onClick={() => {
                setSection(id);
                window.requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
              }}
              aria-label={`${capability?.title ?? id}. ${STATUS_LABEL[capability?.readiness ?? 'unavailable']}. ${capability?.summary ?? 'Readiness is being evaluated.'}`}
            >
              <span className={`godmode-readiness is-${capability?.readiness ?? 'unavailable'}`}>
                {STATUS_LABEL[capability?.readiness ?? 'unavailable']}
              </span>
              <strong>{capability?.title ?? id}</strong>
              <span>{capability?.summary ?? 'Readiness is being evaluated.'}</span>
              <small>{capability?.safeguards[0] ?? 'Main authority enforced.'}</small>
            </button>
          );
        })}
      </div>
      <button className="btn godmode-full-button" type="button" onClick={() => void refreshOverview()}>
        <RefreshIcon size={14} /> Refresh readiness
      </button>
    </>
  );

  const renderContext = () => (
    <>
      <SectionIntro title="Context intelligence">
        Inspect cited workspace context and score expected-file retrieval with precision, recall, and MRR.
      </SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field"><span>Question or task</span><textarea value={contextQuery} onChange={(e) => setContextQuery(e.target.value)} rows={4} placeholder="Where is authentication state reconciled?" /></label>
      <label className="godmode-field"><span>Expected paths for evaluation</span><textarea value={expectedPaths} onChange={(e) => setExpectedPaths(e.target.value)} rows={3} placeholder="src/auth/store.ts" /></label>
      <div className="godmode-actions">
        <button className="btn btn-primary" disabled={!trusted || !contextQuery.trim() || busy !== null} type="button" onClick={() => void runAction('context-inspect', () => window.axiom.godMode.context.inspect({ root: rootPath!, query: contextQuery, expectedPaths: splitLines(expectedPaths) }), setContextReport)}>Inspect</button>
        <button className="btn" disabled={!trusted || !contextQuery.trim() || splitLines(expectedPaths).length === 0 || busy !== null} type="button" onClick={() => void runAction('context-eval', () => window.axiom.godMode.context.evaluate(rootPath!, [{ id: crypto.randomUUID(), query: contextQuery, expectedPaths: splitLines(expectedPaths) }]), setContextEval)}>Evaluate</button>
      </div>
      {contextReport ? <ResultBlock><strong>{contextReport.quality.citationCount} cited source(s)</strong><span>{contextReport.durationMs} ms · ~{contextReport.tokensEstimated} tokens{contextReport.truncated ? ' · truncated' : ''}</span><div className="godmode-metrics"><span>Precision {contextReport.quality.precision ?? '—'}</span><span>Recall {contextReport.quality.recall ?? '—'}</span><span>MRR {contextReport.quality.reciprocalRank ?? '—'}</span></div><ul>{contextReport.citations.slice(0, 12).map((citation) => <li key={citation.id}><code>{citation.rel}</code><span>{citation.startLine}–{citation.endLine}</span></li>)}</ul></ResultBlock> : null}
      {contextEval ? <ResultBlock><strong>Evaluation suite</strong><div className="godmode-metrics"><span>Precision {contextEval.averagePrecision}</span><span>Recall {contextEval.averageRecall}</span><span>MRR {contextEval.meanReciprocalRank}</span><span>Grounded {Math.round(contextEval.groundedRate * 100)}%</span></div></ResultBlock> : null}
    </>
  );

  const renderPredictive = () => (
    <>
      <SectionIntro title="Predictive editing">Document-versioned completion with Main cancellation, stale suppression, isolated cache scope, and explicit feedback.</SectionIntro>
      <div className="godmode-stat-grid">
        <div><strong>{metrics?.requested ?? 0}</strong><span>Requests</span></div>
        <div><strong>{metrics?.averageLatencyMs ?? 0} ms</strong><span>Average</span></div>
        <div><strong>{metrics?.p95LatencyMs ?? 0} ms</strong><span>P95</span></div>
        <div><strong>{Math.round((metrics?.acceptanceRate ?? 0) * 100)}%</strong><span>Accepted</span></div>
        <div><strong>{metrics?.cacheHits ?? 0}</strong><span>Cache hits</span></div>
        <div><strong>{metrics?.stale ?? 0}</strong><span>Stale blocked</span></div>
      </div>
      <ResultBlock><strong>Editor-native workflow</strong><span>Type normally to request debounced inline completions. Tab accepts; partial acceptance and dismissal are recorded without sending document contents to metrics.</span></ResultBlock>
      <button className="btn godmode-full-button" type="button" onClick={() => void runAction('metrics', () => window.axiom.ai.completionMetrics(), setMetrics)}><RefreshIcon size={14} /> Refresh metrics</button>
    </>
  );

  const renderJobs = () => (
    <>
      <SectionIntro title="Autonomous verification loop">Durable plan–edit–run–observe–fix–verify jobs reuse the hardened Build Agent and pause safely across restarts.</SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field"><span>Engineering outcome</span><textarea value={jobGoal} onChange={(e) => setJobGoal(e.target.value)} rows={5} placeholder="Implement the change, run affected checks, repair failures, and summarize evidence." /></label>
      <label className="godmode-field godmode-inline-field"><span>Maximum passes</span><input type="number" min={1} max={10} value={maxIterations} onChange={(e) => setMaxIterations(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} /></label>
      <button className="btn btn-primary godmode-full-button" disabled={!trusted || !jobGoal.trim() || busy !== null} type="button" onClick={() => void createAndLaunchJob(jobGoal)}><SparkIcon size={14} /> Create and run</button>
      <div className="godmode-list" aria-label="Durable jobs">
        {jobs.length === 0 ? <span className="godmode-muted">No durable jobs in this workspace.</span> : jobs.map((job) => <article className="godmode-job" key={job.id}><header><strong>{job.title}</strong><span className={`godmode-job-status is-${job.status}`}>{job.status}</span></header><div className="godmode-progress" role="progressbar" aria-label={`${job.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, job.progress))}><span style={{ width: `${job.progress}%` }} /></div><small>{job.phase} · pass {job.iteration}/{job.maxIterations} · {shortId(job.id)}</small>{job.error ? <p className="godmode-item-error">{job.error}</p> : null}<div className="godmode-actions">{job.status === 'queued' ? <button className="btn" type="button" onClick={() => void runAction(`job-start-${job.id}`, () => dispatchJob(job))}><PlayIcon size={13} /> Start</button> : null}{job.status === 'running' || job.status === 'awaiting-approval' ? <button className="btn" type="button" onClick={() => void controlJob(job, 'pause')}>Pause</button> : null}{job.resumable && ['paused', 'failed', 'cancelled'].includes(job.status) ? <button className="btn" type="button" onClick={() => void controlJob(job, 'resume')}>Resume safely</button> : null}{!['completed', 'cancelled'].includes(job.status) ? <button className="btn btn-danger" type="button" onClick={() => void controlJob(job, 'cancel')}><StopIcon size={13} /> Cancel</button> : null}</div></article>)}
      </div>
    </>
  );

  const renderPreview = () => (
    <>
      <SectionIntro title="Secure application preview">Open only loopback HTTP(S) in an isolated, nonpersistent, sandboxed Electron session with same-origin navigation.</SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field"><span>Loopback URL</span><input value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} spellCheck={false} /></label>
      <label className="godmode-field"><span>Optional launch command</span><input value={previewCommand} onChange={(e) => { setPreviewCommand(e.target.value); setPreviewConfirmed(false); }} placeholder="npm run preview" spellCheck={false} /></label>
      {previewCommand.trim() ? <ConfirmBox checked={previewConfirmed} onChange={setPreviewConfirmed}>I approve launching this workspace command. Main will terminate its process tree when preview closes.</ConfirmBox> : null}
      <div className="godmode-actions">
        <button
          className="btn btn-primary"
          disabled={
            !trusted || (Boolean(previewCommand.trim()) && !previewConfirmed) || busy !== null
          }
          type="button"
          onClick={() =>
            void runAction(
              'preview-open',
              () => {
                const confirmation = previewConfirmed;
                setPreviewConfirmed(false);
                return window.axiom.godMode.preview.open({
                  root: rootPath!,
                  url: previewUrl,
                  ...(previewCommand.trim()
                    ? { launchCommand: previewCommand, confirmation }
                    : {}),
                });
              },
              (value) => {
                setPreview(value);
              },
            )
          }
        >
          Open preview
        </button>
        <button
          className="btn"
          disabled={!preview || busy !== null}
          type="button"
          onClick={() =>
            void runAction(
              'preview-refresh',
              () => window.axiom.godMode.preview.refresh(rootPath!),
              setPreview,
            )
          }
        >
          <RefreshIcon size={13} /> Refresh
        </button>
        <button
          className="btn"
          disabled={!preview || busy !== null}
          type="button"
          onClick={() =>
            void runAction(
              'preview-capture',
              () => window.axiom.godMode.preview.capture(rootPath!),
              setPreview,
            )
          }
        >
          Capture
        </button>
        <button
          className="btn"
          disabled={preview?.phase !== 'ready' || busy !== null}
          type="button"
          onClick={() =>
            void runAction(
              'preview-select',
              () => window.axiom.godMode.preview.selectElement(rootPath!),
              setPreview,
            )
          }
        >
          Select element
        </button>
      </div>
      {preview ? <ResultBlock><strong>{preview.title}</strong><span>{preview.phase} · {preview.origin}</span><span>{preview.runtimeErrors.length} runtime error(s) · {preview.console.length} console event(s){preview.screenshotDataUrl ? ' · screenshot captured' : ''}</span>{preview.screenshotDataUrl ? <img className="godmode-preview-screenshot" src={preview.screenshotDataUrl} alt="Captured application preview" /> : null}{preview.selectedElement ? <code>{preview.selectedElement.selector}</code> : null}{preview.error ? <p className="godmode-item-error">{preview.error}</p> : null}<div className="godmode-actions"><button className="btn" type="button" disabled={!trusted || busy !== null} onClick={() => void createAndLaunchJob(`Use this application-preview evidence to diagnose and fix the workspace.\n\n${JSON.stringify({ url: preview.url, runtimeErrors: preview.runtimeErrors.slice(-10), console: preview.console.slice(-20), selectedElement: preview.selectedElement }, null, 2).slice(0, 12000)}`)}>Send evidence to Build</button><button className="btn btn-danger" type="button" disabled={busy !== null} onClick={() => void runAction('preview-close', async () => { await window.axiom.godMode.preview.close(rootPath!); return null; }, () => setPreview(null))}>Close</button></div></ResultBlock> : null}
    </>
  );

  const renderVerification = () => (
    <>
      <SectionIntro title="Test and debugger evidence">Generate checks from package scripts in Main, execute only approved plan IDs, and hand off redacted stopped-debugger state.</SectionIntro>
      <GuardNotice trusted={trusted} />
      <button className="btn btn-primary godmode-full-button" disabled={!trusted || busy !== null} type="button" onClick={() => void runAction('verification-plan', () => window.axiom.godMode.verification.plan(rootPath!), (plan) => { setVerificationPlan(plan); setSelectedChecks(plan.checks.filter((check) => check.required || check.affected).map((check) => check.id)); setVerificationResult(null); setVerificationApproval(null); })}>Plan affected checks</button>
      {verificationPlan ? (
        <ResultBlock>
          <strong>{verificationPlan.checks.length} Main-generated check(s)</strong>
          {verificationPlan.checks.map((check) => (
            <label className="godmode-check" key={check.id}>
              <input
                type="checkbox"
                disabled={check.required || activeVerificationPlanId !== null}
                checked={check.required || selectedChecks.includes(check.id)}
                onChange={(event) =>
                  setSelectedChecks((current) =>
                    event.target.checked
                      ? [...current, check.id]
                      : current.filter((id) => id !== check.id),
                  )
                }
              />
              <span>
                <b>{check.label}</b>
                <small>{check.command} · {check.reason}</small>
              </span>
            </label>
          ))}
          <ConfirmBox
            checked={verificationApproval === verificationTarget && Boolean(selectedChecks.length)}
            onChange={(checked) =>
              setVerificationApproval(checked && verificationTarget ? verificationTarget : null)
            }
          >
            I approve running this exact set of package scripts in this workspace.
          </ConfirmBox>
          <div className="godmode-actions">
            <button
              className="btn btn-primary"
              disabled={
                verificationApproval !== verificationTarget ||
                selectedChecks.length === 0 ||
                busy !== null
              }
              type="button"
              onClick={() =>
                void runAction(
                  'verification-run',
                  () => {
                    const planId = verificationPlan.id;
                    setVerificationApproval(null);
                    setActiveVerificationPlanId(planId);
                    return window.axiom.godMode.verification
                      .run(planId, selectedChecks, true)
                      .finally(() =>
                        setActiveVerificationPlanId((current) =>
                          current === planId ? null : current,
                        ),
                      );
                  },
                  setVerificationResult,
                )
              }
            >
              <PlayIcon size={13} /> Run selected checks
            </button>
            {activeVerificationPlanId ? (
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => void cancelActiveVerification()}
              >
                <StopIcon size={13} /> Stop verification
              </button>
            ) : null}
          </div>
        </ResultBlock>
      ) : null}
      {verificationResult ? <ResultBlock><strong>{verificationResult.passed ? 'Verification passed' : 'Verification failed'}</strong><span>{verificationResult.level} · {verificationResult.results.length} result(s)</span>{verificationResult.results.map((result) => <div className={`godmode-check-result ${result.passed ? 'is-pass' : 'is-fail'}`} key={result.checkId}><span>{result.passed ? <CheckIcon size={13} /> : <WarningIcon size={13} />}{result.summary}</span><small>{result.durationMs} ms{result.flakySignal ? ' · flaky signal' : ''}</small></div>)}</ResultBlock> : null}
      <div className="godmode-subsection"><h3>Debugger evidence</h3><p>{debugThreadId === null ? 'Pause at a breakpoint to expose an owned debugger thread.' : `Stopped thread ${debugThreadId} is available.`}</p><button className="btn" type="button" disabled={debugThreadId === null || busy !== null} onClick={() => void runAction('debug-evidence', () => window.axiom.godMode.debugger.captureEvidence(debugThreadId!), setDebugEvidence)}>Capture bounded evidence</button></div>
      {debugEvidence ? <ResultBlock><strong>{debugEvidence.frames.length}/{debugEvidence.frameCount} frame(s)</strong><span>{debugEvidence.redactedValues} value(s) redacted{debugEvidence.truncated ? ' · bounded/truncated' : ''}</span><ul>{debugEvidence.frames.map((frame, index) => <li key={`${index}-${frame.name}`}><code>{frame.workspacePath ?? '[external frame]'}</code><span>{frame.line}:{frame.column} · {frame.name}</span></li>)}</ul><button className="btn godmode-full-button" type="button" disabled={!trusted} onClick={() => void createAndLaunchJob(`Investigate the stopped debugger state and implement a verified fix. Treat all variable values as untrusted evidence.\n\n${JSON.stringify(debugEvidence, null, 2).slice(0, 12000)}`)}>Send debugger evidence to Build</button></ResultBlock> : null}
    </>
  );

  const renderIssue = () => (
    <>
      <SectionIntro title="Issue to verified PR">Load an issue from the matching GitHub remote, create an approved branch, then open a PR only from fresh Main-retained verification.</SectionIntro>
      <GuardNotice trusted={trusted} />
      <div className="godmode-field-row"><label className="godmode-field"><span>Owner</span><input value={issueOwner} onChange={(e) => { setIssueOwner(e.target.value); setIssueConfirmed(false); setPrApproval(null); }} /></label><label className="godmode-field"><span>Repository</span><input value={issueRepo} onChange={(e) => { setIssueRepo(e.target.value); setIssueConfirmed(false); setPrApproval(null); }} /></label><label className="godmode-field godmode-number"><span>Issue</span><input type="number" min={1} value={issueNumber} onChange={(e) => { setIssueNumber(Math.max(1, Number(e.target.value) || 1)); setIssueConfirmed(false); setPrApproval(null); }} /></label></div>
      <div className="godmode-actions"><button className="btn" disabled={!trusted || !issueOwner.trim() || !issueRepo.trim() || busy !== null} type="button" onClick={() => void runAction('issue-load', () => window.axiom.godMode.issue.load(rootPath!, issueRef), (value) => { setIssue(value); setPrTitle(value.title); setPrApproval(null); })}>Load</button><button className="btn" disabled={!trusted || !issueOwner.trim() || !issueRepo.trim() || busy !== null} type="button" onClick={() => void runAction('issue-plan', () => window.axiom.godMode.issue.plan(rootPath!, issueRef), (value) => { setIssuePlan(value); setPrHead(value.branch); setPrTitle(value.issue.title); setIssueConfirmed(false); setPrApproval(null); })}>Plan</button></div>
      <ConfirmBox checked={issueConfirmed} onChange={setIssueConfirmed}>I approve creating and checking out the clean issue branch. Existing work must remain clean.</ConfirmBox>
      <button className="btn btn-primary godmode-full-button" disabled={!trusted || !issueConfirmed || !issueOwner.trim() || !issueRepo.trim() || busy !== null} type="button" onClick={() => void runAction('issue-start', () => { setIssueConfirmed(false); return window.axiom.godMode.issue.start(rootPath!, issueRef, true); }, (value) => { setIssuePlan(value); setPrHead(value.branch); setPrTitle(value.issue.title); setPrApproval(null); })}>Start issue branch</button>
      {issue ? <ResultBlock><strong>#{issue.number} {issue.title}</strong><span>{issue.state} · {issue.author} · {issue.labels.join(', ') || 'no labels'}</span></ResultBlock> : null}
      {issuePlan ? <ResultBlock><strong>{issuePlan.branch}</strong><span>{issuePlan.acceptanceCriteria.length} acceptance criterion/criteria</span><ol>{issuePlan.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ol><button className="btn godmode-full-button" type="button" disabled={!trusted} onClick={() => void createAndLaunchJob(`${issuePlan.goal}\n\nAcceptance criteria:\n${issuePlan.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\nWork only on branch ${issuePlan.branch}. Run affected verification before finishing.`)}>Send issue plan to Build</button></ResultBlock> : null}
      <div className="godmode-subsection"><h3>Create verified pull request</h3><label className="godmode-field"><span>Title</span><input value={prTitle} onChange={(e) => { setPrTitle(e.target.value); setPrApproval(null); }} /></label><label className="godmode-field"><span>Summary</span><textarea rows={4} value={prSummary} onChange={(e) => { setPrSummary(e.target.value); setPrApproval(null); }} /></label><label className="godmode-field"><span>Commit message for staged changes</span><input value={prCommitMessage} onChange={(e) => { setPrCommitMessage(e.target.value); setPrApproval(null); }} placeholder="fix: resolve issue" /></label><div className="godmode-field-row"><label className="godmode-field"><span>Head</span><input value={prHead} onChange={(e) => { setPrHead(e.target.value); setPrApproval(null); }} /></label><label className="godmode-field"><span>Base</span><input value={prBase} onChange={(e) => { setPrBase(e.target.value); setPrApproval(null); }} /></label></div><ConfirmBox checked={prDraft} onChange={(value) => { setPrDraft(value); setPrApproval(null); }}>Open as a draft pull request.</ConfirmBox><ConfirmBox checked={prApproval === prTarget} onChange={(checked) => setPrApproval(checked ? prTarget : null)}>I approve commit, secure push, and GitHub PR creation using the retained verification result.</ConfirmBox><button className="btn btn-primary godmode-full-button" disabled={!verificationResult?.passed || !verificationPlan || prApproval !== prTarget || !prTitle.trim() || !prHead.trim() || busy !== null} type="button" onClick={() => void runAction('pr-create', () => { setPrApproval(null); return window.axiom.godMode.issue.createPr({ root: rootPath!, issue: issueRef, title: prTitle, summary: prSummary, head: prHead, base: prBase, draft: prDraft, verificationPlanId: verificationPlan!.id, ...(prCommitMessage.trim() ? { commitMessage: prCommitMessage.trim() } : {}), confirmation: true }); }, (value) => { setPrResult(value); })}>Create verified PR</button>{!verificationResult?.passed ? <span className="godmode-muted">Run and pass a verification plan in Test & Debug first.</span> : null}</div>
      {prResult ? <ResultBlock><strong>PR #{prResult.number} created</strong><span>{prResult.htmlUrl}</span></ResultBlock> : null}
    </>
  );

  const renderWorkspaces = () => (
    <>
      <SectionIntro title="Isolated workspaces">
        Create managed clean clones or run bounded approved commands in explicit WSL, SSH, and
        container targets.
      </SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field">
        <span>Name</span>
        <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
      </label>
      <label className="godmode-field">
        <span>Backend</span>
        <select
          value={workspaceBackend}
          onChange={(event) => setWorkspaceBackend(event.target.value as WorkspaceBackend)}
        >
          <option value="local-clone">Managed local clone</option>
          <option value="wsl">WSL</option>
          <option value="ssh">SSH</option>
          <option value="dev-container">Container</option>
        </select>
      </label>
      {workspaceBackend !== 'local-clone' ? (
        <label className="godmode-field">
          <span>Explicit workspace path</span>
          <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} />
        </label>
      ) : null}
      {workspaceBackend === 'wsl' ? (
        <label className="godmode-field">
          <span>Distribution</span>
          <input
            value={workspaceDistro}
            onChange={(event) => setWorkspaceDistro(event.target.value)}
          />
        </label>
      ) : null}
      {workspaceBackend === 'ssh' ? (
        <div className="godmode-field-row">
          <label className="godmode-field">
            <span>Host alias</span>
            <input value={workspaceHost} onChange={(event) => setWorkspaceHost(event.target.value)} />
          </label>
          <label className="godmode-field">
            <span>User</span>
            <input value={workspaceUser} onChange={(event) => setWorkspaceUser(event.target.value)} />
          </label>
        </div>
      ) : null}
      {workspaceBackend === 'dev-container' ? (
        <label className="godmode-field">
          <span>Container name or ID</span>
          <input
            value={workspaceContainer}
            onChange={(event) => setWorkspaceContainer(event.target.value)}
          />
        </label>
      ) : null}
      <ConfirmBox
        checked={workspaceApproval === workspaceTarget}
        onChange={(checked) => setWorkspaceApproval(checked ? workspaceTarget : null)}
      >
        I approve creating or registering this exact isolated workspace target.
      </ConfirmBox>
      <div className="godmode-actions">
        <button
          className="btn"
          disabled={!trusted || workspaceBackend === 'local-clone' || busy !== null}
          type="button"
          onClick={() =>
            void runAction(
              'workspace-probe',
              () =>
                window.axiom.godMode.workspaces.probe({
                  root: rootPath!,
                  backend: workspaceBackend,
                  ...(workspacePath.trim() ? { workspacePath: workspacePath.trim() } : {}),
                  ...(workspaceDistro.trim() ? { distro: workspaceDistro.trim() } : {}),
                  ...(workspaceHost.trim() ? { host: workspaceHost.trim() } : {}),
                  ...(workspaceUser.trim() ? { user: workspaceUser.trim() } : {}),
                  ...(workspaceContainer.trim()
                    ? { container: workspaceContainer.trim() }
                    : {}),
                }),
              setProbeResult,
            )
          }
        >
          Probe backend
        </button>
        <button
          className="btn btn-primary"
          disabled={
            !trusted ||
            workspaceApproval !== workspaceTarget ||
            !workspaceName.trim() ||
            busy !== null
          }
          type="button"
          onClick={() =>
            void runAction(
              'workspace-create',
              () => {
                setWorkspaceApproval(null);
                return window.axiom.godMode.workspaces.create({
                  root: rootPath!,
                  name: workspaceName,
                  backend: workspaceBackend,
                  ...(workspacePath.trim() ? { workspacePath } : {}),
                  ...(workspaceDistro.trim() ? { distro: workspaceDistro } : {}),
                  ...(workspaceHost.trim() ? { host: workspaceHost } : {}),
                  ...(workspaceUser.trim() ? { user: workspaceUser } : {}),
                  ...(workspaceContainer.trim() ? { container: workspaceContainer } : {}),
                  confirmation: true,
                });
              },
              async () => {
                setWorkspaceProfiles(await window.axiom.godMode.workspaces.list(rootPath!));
              },
            )
          }
        >
          Create
        </button>
      </div>
      {probeResult ? (
        <ResultBlock>
          <strong>{probeResult.available ? 'Backend available' : 'Backend unavailable'}</strong>
          <span>
            {probeResult.message}
            {probeResult.version ? ` · ${probeResult.version}` : ''}
            {probeResult.targetPath ? ` · target ${probeResult.targetPath}` : ''}
            {probeResult.durationMs !== undefined ? ` · ${probeResult.durationMs} ms` : ''}
          </span>
        </ResultBlock>
      ) : null}
      <label className="godmode-field">
        <span>Command for an isolated target</span>
        <input
          value={workspaceCommand}
          onChange={(event) => {
            setWorkspaceCommand(event.target.value);
            setWorkspaceCommandApproval(null);
          }}
          placeholder="npm test"
        />
      </label>
      <div className="godmode-list">
        {workspaceProfiles.map((profile) => {
          const commandTarget = workspaceCommandTarget(profile.id);
          return (
            <article className="godmode-job" key={profile.id}>
              <header>
                <strong>{profile.name}</strong>
                <span>{profile.backend}</span>
              </header>
              <small>
                {profile.status} ·{' '}
                {profile.reproducibilityFiles.join(', ') || 'no reproducibility files detected'}
              </small>
              <ConfirmBox
                checked={
                  Boolean(workspaceCommand.trim()) && workspaceCommandApproval === commandTarget
                }
                onChange={(checked) =>
                  setWorkspaceCommandApproval(checked ? commandTarget : null)
                }
              >
                I approve this exact command in {profile.name}.
              </ConfirmBox>
              <div className="godmode-actions">
                <button
                  className="btn"
                  disabled={
                    !workspaceCommand.trim() ||
                    workspaceCommandApproval !== commandTarget ||
                    busy !== null
                  }
                  type="button"
                  onClick={() =>
                    void runAction(
                      `workspace-run-${profile.id}`,
                      () => {
                        setWorkspaceCommandApproval(null);
                        return window.axiom.godMode.workspaces.run(
                          rootPath!,
                          profile.id,
                          workspaceCommand,
                          true,
                        );
                      },
                      (value) => {
                        setWorkspaceResult(value);
                      },
                    )
                  }
                >
                  <PlayIcon size={13} /> Run
                </button>
                <ConfirmBox
                  checked={workspaceRemovalId === profile.id}
                  onChange={(checked) => setWorkspaceRemovalId(checked ? profile.id : null)}
                >
                  I approve removing {profile.name}.
                </ConfirmBox>
                <button
                  className="btn btn-danger"
                  disabled={workspaceRemovalId !== profile.id || busy !== null}
                  type="button"
                  onClick={() =>
                    void runAction(
                      `workspace-remove-${profile.id}`,
                      () => {
                        setWorkspaceRemovalId(null);
                        return window.axiom.godMode.workspaces.remove(rootPath!, profile.id, true);
                      },
                      (value) => {
                        setWorkspaceProfiles(value);
                      },
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {workspaceResult ? (
        <ResultBlock>
          <strong>{workspaceResult.passed ? 'Command passed' : 'Command failed'}</strong>
          <span>
            {workspaceResult.durationMs} ms · exit {workspaceResult.exitCode ?? 'unknown'}
            {workspaceResult.truncated ? ' · truncated' : ''}
          </span>
          <pre>{workspaceResult.output}</pre>
        </ResultBlock>
      ) : null}
    </>
  );

  const renderExtensions = () => (
    <>
      <SectionIntro title="Sandboxed extensions">
        Declarative contributions stay capability-scoped. Optional WASM is hash-verified,
        import-free, quota-bound, and never runs as unrestricted JavaScript.
      </SectionIntro>
      <GuardNotice trusted={trusted} />
      <button
        className="btn godmode-full-button"
        type="button"
        disabled={!trusted || busy !== null}
        onClick={() =>
          void runAction(
            'extensions-refresh',
            () => window.axiom.godMode.extensions.list(rootPath!),
            (value) => {
              setExtensions(value);
              setExtensionApprovalId(null);
              setUnsignedApprovalId(null);
            },
          )
        }
      >
        <RefreshIcon size={13} /> Refresh extensions
      </button>
      <div className="godmode-list">
        {extensions.length === 0 ? (
          <span className="godmode-muted">
            No compatible declarative or WASM extensions were found.
          </span>
        ) : (
          extensions.map((extension) => {
            const unsigned = !extension.signatureVerified;
            const integrityApproved = extensionApprovalId === extension.extensionId;
            const publisherApproved = unsignedApprovalId === extension.extensionId;
            return (
              <article className="godmode-job" key={extension.extensionId}>
                <header>
                  <strong>{extension.extensionId}</strong>
                  <span>{extension.runtime}</span>
                </header>
                <small>
                  {extension.integrityVerified ? 'hash verified' : 'not verified'} ·{' '}
                  {extension.signatureVerified
                    ? 'signature valid (publisher identity untrusted)'
                    : 'unsigned'}{' '}
                  · {extension.memoryLimitMb} MiB · {extension.executionTimeoutMs} ms
                </small>
                {extension.permissions.length > 0 ? (
                  <small>Declared: {extension.permissions.join(' · ')}</small>
                ) : (
                  <small>No runtime capabilities are exposed.</small>
                )}
                {extension.lastError ? (
                  <p className="godmode-item-error">{extension.lastError}</p>
                ) : null}
                {extension.enabled ? (
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(
                        `extension-disable-${extension.extensionId}`,
                        () =>
                          window.axiom.godMode.extensions.disable(
                            rootPath!,
                            extension.extensionId,
                          ),
                        setExtensions,
                      )
                    }
                  >
                    Disable
                  </button>
                ) : (
                  <>
                    <ConfirmBox
                      checked={integrityApproved}
                      onChange={(checked) => {
                        setExtensionApprovalId(checked ? extension.extensionId : null);
                        if (!checked) setUnsignedApprovalId(null);
                      }}
                    >
                      I approve enabling this exact package after Main integrity and quota review.
                    </ConfirmBox>
                    <ConfirmBox
                      checked={unsignedApprovalId === extension.extensionId}
                      onChange={(checked) =>
                        setUnsignedApprovalId(checked ? extension.extensionId : null)
                      }
                    >
                      {unsigned
                        ? 'I explicitly accept this unsigned package.'
                        : 'I explicitly accept that this valid signature uses a self-declared, untrusted publisher key.'}{' '}
                      Hash and sandbox limits still apply.
                    </ConfirmBox>
                    <button
                      className="btn btn-primary"
                      disabled={!integrityApproved || !publisherApproved || busy !== null}
                      type="button"
                      onClick={() =>
                        void runAction(
                          `extension-enable-${extension.extensionId}`,
                          () => {
                            setExtensionApprovalId(null);
                            setUnsignedApprovalId(null);
                            return window.axiom.godMode.extensions.enable(
                              rootPath!,
                              extension.extensionId,
                              true,
                              publisherApproved,
                            );
                          },
                          (value) => {
                            setExtensions(value);
                          },
                        )
                      }
                    >
                      Review and enable
                    </button>
                  </>
                )}
              </article>
            );
          })
        )}
      </div>
    </>
  );

  const renderCollaboration = () => (
    <>
      <SectionIntro title="Collaboration and background work">
        Keep local durable decisions, checkpoints, verification, and handoffs. Optional cloud
        sharing is explicit, schema/RLS-attested, and reports its real sync state.
      </SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field">
        <span>Session title</span>
        <input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} />
      </label>
      <button
        className="btn btn-primary godmode-full-button"
        disabled={!trusted || !sessionTitle.trim() || busy !== null}
        type="button"
        onClick={() =>
          void runAction(
            'collaboration-create',
            () => window.axiom.godMode.collaboration.create(rootPath!, sessionTitle),
            async (created) => {
              const next = await window.axiom.godMode.collaboration.list(rootPath!);
              setSessions(next);
              setSelectedSessionId(created.id);
              setCollaborationLinks([]);
            },
          )
        }
      >
        Create local session
      </button>
      {sessions.length > 0 ? (
        <label className="godmode-field">
          <span>Session</span>
          <select
            value={selectedSession?.id ?? ''}
            onChange={(event) => {
              setSelectedSessionId(event.target.value);
              setCollaborationShareApprovalId(null);
              setCollaborationMemberApproval(null);
              setCollaborationLinks([]);
              setExportSummary('');
            }}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {session.cloudState}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selectedSession ? (
        <>
          <div className="godmode-subsection">
            <h3>Members</h3>
            <ul>
              {selectedSession.members.map((member) => (
                <li key={member.id}>
                  <strong>{member.displayName}</strong>{' '}
                  <span>{member.role} · {shortId(member.id)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="godmode-subsection">
            <h3>Recent events</h3>
            {selectedSession.events.length === 0 ? (
              <span className="godmode-muted">No durable events yet.</span>
            ) : (
              <ul>
                {selectedSession.events
                  .slice(-12)
                  .reverse()
                  .map((event) => (
                    <li key={event.id}>
                      <strong>{event.kind}</strong>{' '}
                      <span>{event.text}</span>
                      <small>
                        {new Date(event.createdAt).toLocaleString()} · {event.evidenceIds.length}{' '}
                        linked item(s)
                      </small>
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <label className="godmode-field">
            <span>Event type</span>
            <select
              value={collaborationKind}
              onChange={(event) =>
                setCollaborationKind(event.target.value as CollaborationEvent['kind'])
              }
            >
              <option value="note">Note</option>
              <option value="decision">Decision</option>
              <option value="checkpoint">Checkpoint</option>
              <option value="verification">Verification</option>
              <option value="handoff">Handoff</option>
            </select>
          </label>
          <label className="godmode-field">
            <span>Evidence-rich update</span>
            <textarea
              rows={4}
              value={collaborationText}
              onChange={(event) => setCollaborationText(event.target.value)}
            />
          </label>
          <fieldset className="godmode-subsection">
            <legend>Link reviewed jobs and evidence</legend>
            <p>Only checked IDs can be included in this session's redacted export.</p>
            {jobs.length === 0 ? (
              <span className="godmode-muted">No durable jobs are available to link.</span>
            ) : (
              jobs.slice(0, 20).map((job) => (
                <div key={job.id} className="godmode-check">
                  <label>
                    <input
                      type="checkbox"
                      checked={collaborationLinks.includes(job.id)}
                      onChange={(event) =>
                        setCollaborationLinks((current) =>
                          event.target.checked
                            ? [...new Set([...current, job.id])]
                            : current.filter((id) => id !== job.id),
                        )
                      }
                    />
                    <span>
                      <b>{job.title}</b>
                      <small>Job {shortId(job.id)} · {job.status}</small>
                    </span>
                  </label>
                  {job.evidence.slice(-10).map((evidence) => (
                    <label key={evidence.id}>
                      <input
                        type="checkbox"
                        checked={collaborationLinks.includes(evidence.id)}
                        onChange={(event) =>
                          setCollaborationLinks((current) =>
                            event.target.checked
                              ? [...new Set([...current, evidence.id])]
                              : current.filter((id) => id !== evidence.id),
                          )
                        }
                      />
                      <span>
                        {evidence.label}
                        <small>{evidence.kind} · {shortId(evidence.id)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ))
            )}
          </fieldset>
          <button
            className="btn godmode-full-button"
            disabled={!collaborationText.trim() || busy !== null}
            type="button"
            onClick={() =>
              void runAction(
                'collaboration-event',
                () =>
                  window.axiom.godMode.collaboration.addEvent(rootPath!, selectedSession.id, {
                    kind: collaborationKind,
                    text: collaborationText,
                    evidenceIds: collaborationLinks,
                  }),
                async () => {
                  setCollaborationText('');
                  setCollaborationLinks([]);
                  setSessions(await window.axiom.godMode.collaboration.list(rootPath!));
                },
              )
            }
          >
            Add durable event
          </button>
          <ConfirmBox
            checked={collaborationShareApprovalId === selectedSession.id}
            onChange={(checked) =>
              setCollaborationShareApprovalId(checked ? selectedSession.id : null)
            }
          >
            I approve authenticated cloud sharing for this exact session.
          </ConfirmBox>
          <div className="godmode-actions">
            <button
              className="btn"
              disabled={busy !== null}
              type="button"
              onClick={() =>
                void runAction(
                  'collaboration-export',
                  () => window.axiom.godMode.collaboration.export(rootPath!, selectedSession.id),
                  (value) =>
                    setExportSummary(
                      `${value.session.events.length} event(s), ${value.jobs.length} linked job(s), ${value.evidence.length} linked evidence record(s)`,
                    ),
                )
              }
            >
              Build redacted export
            </button>
            <button
              className="btn"
              disabled={
                collaborationShareApprovalId !== selectedSession.id || busy !== null
              }
              type="button"
              onClick={() =>
                void runAction(
                  'collaboration-share',
                  () => {
                    setCollaborationShareApprovalId(null);
                    return window.axiom.godMode.collaboration.share(
                      rootPath!,
                      selectedSession.id,
                      true,
                    );
                  },
                  async () => {
                    setSessions(await window.axiom.godMode.collaboration.list(rootPath!));
                  },
                )
              }
            >
              Share
            </button>
          </div>
          <div className="godmode-field-row">
            <label className="godmode-field">
              <span>Collaborator UUID</span>
              <input
                value={memberId}
                onChange={(event) => {
                  setMemberId(event.target.value);
                  setCollaborationMemberApproval(null);
                }}
              />
            </label>
            <label className="godmode-field">
              <span>Role</span>
              <select
                value={memberRole}
                onChange={(event) => {
                  setMemberRole(event.target.value as CollaborationRole);
                  setCollaborationMemberApproval(null);
                }}
              >
                <option value="editor">Editor</option>
                <option value="reviewer">Reviewer</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
          </div>
          <ConfirmBox
            checked={
              collaborationMemberApproval === collaborationMemberTarget && Boolean(memberId.trim())
            }
            onChange={(checked) =>
              setCollaborationMemberApproval(
                checked && collaborationMemberTarget ? collaborationMemberTarget : null,
              )
            }
          >
            I approve adding this exact collaborator UUID with the selected role.
          </ConfirmBox>
          <button
            className="btn godmode-full-button"
            disabled={
              !memberId.trim() ||
              collaborationMemberApproval !== collaborationMemberTarget ||
              busy !== null
            }
            type="button"
            onClick={() =>
              void runAction(
                'collaboration-member',
                () => {
                  setCollaborationMemberApproval(null);
                  return window.axiom.godMode.collaboration.addMember(
                    rootPath!,
                    selectedSession.id,
                    memberId,
                    memberRole,
                    true,
                  );
                },
                async () => {
                  setSessions(await window.axiom.godMode.collaboration.list(rootPath!));
                },
              )
            }
          >
            Add collaborator
          </button>
          {exportSummary ? (
            <ResultBlock>
              <strong>Export prepared in memory</strong>
              <span>
                {exportSummary}. Only session-linked IDs are included; absolute roots, external
                paths, renderer ownership, and secret-shaped values are redacted.
              </span>
            </ResultBlock>
          ) : null}
        </>
      ) : (
        <span className="godmode-muted">Create a local session to record handoffs.</span>
      )}
    </>
  );

  const renderDeployment = () => (
    <>
      <SectionIntro title="Guarded preview deployment">
        Plan against the current commit, require fresh verification, then serve locally or trigger
        an approved provider without uploading source code.
      </SectionIntro>
      <GuardNotice trusted={trusted} />
      <label className="godmode-field">
        <span>Provider</span>
        <select
          value={deploymentProvider}
          onChange={(event) => {
            setDeploymentProvider(event.target.value as DeploymentProvider);
            invalidateDeploymentPlan();
          }}
        >
          <option value="local-static">Local static preview</option>
          <option value="github-actions">GitHub Actions</option>
          <option value="deploy-hook">Encrypted deploy hook</option>
        </select>
      </label>
      <div className="godmode-field-row">
        <label className="godmode-field">
          <span>Target ID</span>
          <input
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setHookBinding(null);
              setHookStorageConfirmed(false);
              invalidateDeploymentPlan();
            }}
          />
        </label>
        <label className="godmode-field">
          <span>Name</span>
          <input
            value={targetName}
            onChange={(event) => {
              setTargetName(event.target.value);
              invalidateDeploymentPlan();
            }}
          />
        </label>
      </div>
      {deploymentProvider === 'local-static' ? (
        <label className="godmode-field">
          <span>Built output directory</span>
          <input
            value={outputDirectory}
            onChange={(event) => {
              setOutputDirectory(event.target.value);
              invalidateDeploymentPlan();
            }}
          />
        </label>
      ) : null}
      {deploymentProvider === 'github-actions' ? (
        <>
          <label className="godmode-field">
            <span>Owner/repository</span>
            <input
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
                invalidateDeploymentPlan();
              }}
            />
          </label>
          <div className="godmode-field-row">
            <label className="godmode-field">
              <span>Workflow file</span>
              <input
                value={workflow}
                onChange={(event) => {
                  setWorkflow(event.target.value);
                  invalidateDeploymentPlan();
                }}
              />
            </label>
            <label className="godmode-field">
              <span>Git ref</span>
              <input
                value={deploymentRef}
                onChange={(event) => {
                  setDeploymentRef(event.target.value);
                  invalidateDeploymentPlan();
                }}
              />
            </label>
          </div>
        </>
      ) : null}
      {deploymentProvider === 'deploy-hook' ? (
        <>
          <label className="godmode-field">
            <span>Secret deploy-hook URL</span>
            <input
              type="password"
              autoComplete="off"
              value={hookUrl}
              onChange={(event) => {
                setHookUrl(event.target.value);
                setHookBinding(null);
                setHookStorageConfirmed(false);
                invalidateDeploymentPlan();
              }}
            />
          </label>
          <ConfirmBox checked={hookStorageConfirmed} onChange={setHookStorageConfirmed}>
            I approve encrypting and storing this exact deployment-hook URL for this target.
          </ConfirmBox>
          <button
            className="btn godmode-full-button"
            disabled={
              !trusted ||
              !hookUrl.trim() ||
              !targetId.trim() ||
              !hookStorageConfirmed ||
              busy !== null
            }
            type="button"
            onClick={() =>
              void runAction(
                'deployment-hook',
                () => {
                  setHookStorageConfirmed(false);
                  return window.axiom.godMode.deployment.saveHook(
                    rootPath!,
                    targetId,
                    hookUrl,
                    true,
                  );
                },
                (binding) => {
                  setHookBinding(binding);
                  setHookUrl('');
                  invalidateDeploymentPlan();
                  notifyInfo('Deploy hook encrypted in Main. Its value will not be returned.', {
                    source: 'God Mode',
                  });
                },
              )
            }
          >
            Review and encrypt hook in Main
          </button>
          {hookBinding ? (
            <span className="godmode-muted">
              Hook stored for {hookBinding.hookOrigin}; renderer cannot read it back.
            </span>
          ) : null}
        </>
      ) : null}
      <button
        className="btn btn-primary godmode-full-button"
        disabled={
          !trusted ||
          (deploymentProvider === 'deploy-hook' && !hookBinding) ||
          busy !== null
        }
        type="button"
        onClick={() =>
          void runAction(
            'deployment-plan',
            () => window.axiom.godMode.deployment.plan(rootPath!, deploymentTarget()),
            (plan) => {
              setDeploymentPlan(plan);
              setDeploymentApprovalId(null);
            },
          )
        }
      >
        Create commit-pinned plan
      </button>
      {deploymentPlan ? (
        <ResultBlock>
          <strong>{deploymentPlan.target.name}</strong>
          <span>
            {deploymentPlan.target.provider} · commit {shortId(deploymentPlan.commitSha)}
          </span>
          {deploymentPlan.artifactSha256 ? (
            <span>
              artifact SHA-256 {deploymentPlan.artifactSha256} · {deploymentPlan.artifactFileCount}{' '}
              file(s) · {deploymentPlan.artifactBytes} byte(s)
            </span>
          ) : null}
          <span>{deploymentPlan.checks.join(' · ') || 'No provider checks'}</span>
          {deploymentPlan.warnings.map((warning) => (
            <p key={warning}>
              <WarningIcon size={13} /> {warning}
            </p>
          ))}
          <ConfirmBox
            checked={deploymentApprovalId === deploymentPlan.id}
            onChange={(checked) => setDeploymentApprovalId(checked ? deploymentPlan.id : null)}
          >
            I approve this exact one-shot target, pinned commit, and any artifact digest shown above.
          </ConfirmBox>
          <button
            className="btn btn-primary godmode-full-button"
            disabled={
              deploymentApprovalId !== deploymentPlan.id ||
              !verificationResult?.passed ||
              !verificationPlan ||
              busy !== null
            }
            type="button"
            onClick={() =>
              void runAction(
                'deployment-execute',
                () => {
                  const planId = deploymentPlan.id;
                  setDeploymentApprovalId(null);
                  setDeploymentPlan(null);
                  return window.axiom.godMode.deployment.execute(rootPath!, {
                    planId,
                    verificationPlanId: verificationPlan!.id,
                    confirmation: true,
                  });
                },
                async () => {
                  setDeploymentRuns(await window.axiom.godMode.deployment.list(rootPath!));
                },
              )
            }
          >
            <PlayIcon size={13} /> Deploy verified preview
          </button>
          {!verificationResult?.passed ? (
            <span className="godmode-muted">
              A fresh successful Test & Debug plan is required.
            </span>
          ) : null}
        </ResultBlock>
      ) : null}
      <div className="godmode-list">
        {deploymentRuns.map((run) => {
          const canCancel = run.status === 'deploying';
          const canStopLocal = run.provider === 'local-static' && run.status === 'ready';
          return (
            <article className="godmode-job" key={run.id}>
              <header>
                <strong>{run.provider}</strong>
                <span className={`godmode-job-status is-${run.status}`}>{run.status}</span>
              </header>
              <small>
                {run.commitSha ? shortId(run.commitSha) : 'commit pending'} ·{' '}
                {formatTime(run.updatedAt)}
              </small>
              <p>{run.summary}</p>
              {run.status === 'queued' && run.provider !== 'local-static' ? (
                <p className="godmode-muted">
                  The external trigger was accepted; this is not proof that provider deployment
                  completed successfully.
                </p>
              ) : null}
              {run.previewUrl ? (
                <div className="godmode-actions">
                  <code>{run.previewUrl}</code>
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void window.axiom.system.copyText(run.previewUrl!).then(() =>
                        notifyInfo('Preview URL copied', { source: 'God Mode' }),
                      )
                    }
                  >
                    Copy preview URL
                  </button>
                </div>
              ) : null}
              {run.providerUrl && run.providerUrl !== run.previewUrl ? (
                <div className="godmode-actions">
                  <code>{run.providerUrl}</code>
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      void window.axiom.system.copyText(run.providerUrl!).then(() =>
                        notifyInfo('Provider URL copied', { source: 'God Mode' }),
                      )
                    }
                  >
                    Copy provider URL
                  </button>
                </div>
              ) : null}
              {run.evidence.length > 0 ? (
                <ul>
                  {run.evidence.slice(-6).map((item) => (
                    <li key={item.id}>
                      <strong>{item.label}</strong>
                      <span>{item.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canCancel || canStopLocal ? (
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction(
                      `deployment-cancel-${run.id}`,
                      async () => {
                        await window.axiom.godMode.deployment.cancel(run.id);
                        return window.axiom.godMode.deployment.list(rootPath!);
                      },
                      setDeploymentRuns,
                    )
                  }
                >
                  {canStopLocal ? 'Stop local preview' : 'Cancel'}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );

  const renderSection = () => {
    switch (section) {
      case 'context-intelligence': return renderContext();
      case 'predictive-editing': return renderPredictive();
      case 'autonomous-verification': return renderJobs();
      case 'secure-preview': return renderPreview();
      case 'test-debug-ai': return renderVerification();
      case 'issue-to-pr': return renderIssue();
      case 'isolated-workspaces': return renderWorkspaces();
      case 'sandboxed-extensions': return renderExtensions();
      case 'collaboration-background': return renderCollaboration();
      case 'preview-deployment': return renderDeployment();
      default: return renderOverview();
    }
  };

  return (
    <div className="godmode-view">
      <div className="godmode-tabs" role="tablist" aria-label="God Mode capabilities">
        {TAB_ORDER.map((id) => {
          const label = id === 'overview' ? 'Overview' : capabilityById.get(id)?.title ?? id;
          const active = section === id;
          return (
            <button
              key={id}
              ref={(node) => {
                if (node) tabRefs.current.set(id, node);
                else tabRefs.current.delete(id);
              }}
              id={`godmode-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls="godmode-capability-panel"
              tabIndex={active ? 0 : -1}
              className={active ? 'active' : ''}
              title={label}
              onClick={() => setSection(id)}
              onKeyDown={(event) => handleTabKey(event, id)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {busy ? (
        <div className="godmode-busy" role="status" aria-live="polite">
          <span className="godmode-spinner" /> Working securely…
        </div>
      ) : null}
      {error ? (
        <div className="godmode-error" role="alert">
          <WarningIcon size={14} />
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      ) : null}
      <div
        id="godmode-capability-panel"
        className="godmode-content"
        role="tabpanel"
        aria-labelledby={`godmode-tab-${section}`}
        tabIndex={0}
      >
        {renderSection()}
      </div>
    </div>
  );
}
