import type { ContextSource } from './ipc';

/**
 * Axiom God Mode contracts.
 *
 * This module is deliberately pure and is shared by Main, preload, renderer, and
 * focused validators. It describes capability state and evidence; authority over
 * roots, trust, processes, credentials, network access, approvals, and mutations
 * remains in Main.
 */
export const GOD_MODE_SCHEMA_VERSION = 1 as const;

export const GOD_MODE_CAPABILITIES = [
  'context-intelligence',
  'predictive-editing',
  'autonomous-verification',
  'secure-preview',
  'test-debug-ai',
  'issue-to-pr',
  'isolated-workspaces',
  'sandboxed-extensions',
  'collaboration-background',
  'preview-deployment',
] as const;

export type GodModeCapabilityId = (typeof GOD_MODE_CAPABILITIES)[number];
export type CapabilityReadiness = 'ready' | 'setup-required' | 'restricted' | 'unavailable';

export interface CapabilityDescriptor {
  id: GodModeCapabilityId;
  title: string;
  readiness: CapabilityReadiness;
  summary: string;
  safeguards: string[];
  actionLabel?: string;
}

export interface GodModeSnapshot {
  schemaVersion: typeof GOD_MODE_SCHEMA_VERSION;
  generatedAt: number;
  root: string | null;
  trusted: boolean;
  capabilities: CapabilityDescriptor[];
  activeJobs: number;
  queuedJobs: number;
}

export type EvidenceKind =
  | 'source'
  | 'command'
  | 'test'
  | 'build'
  | 'typecheck'
  | 'lint'
  | 'runtime'
  | 'debugger'
  | 'network'
  | 'deployment'
  | 'human-approval';

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  label: string;
  passed: boolean | null;
  summary: string;
  createdAt: number;
  path?: string;
  startLine?: number;
  endLine?: number;
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
}

export type VerificationLevel = 'unverified' | 'inspected' | 'executed' | 'verified';

export function verificationLevel(evidence: readonly EvidenceRecord[]): VerificationLevel {
  if (evidence.length === 0) return 'unverified';
  const executable = evidence.filter((item) => item.kind !== 'source');
  if (executable.length === 0) return 'inspected';
  if (executable.some((item) => item.passed !== true)) return 'executed';
  return 'verified';
}

// ---------------------------------------------------------------------------
// 1. Context intelligence + evaluations
// ---------------------------------------------------------------------------
export interface ContextIntelligenceInput {
  root: string;
  query: string;
  activePath?: string;
  expectedPaths?: string[];
  budgetTokens?: number;
  topK?: number;
}

export interface ContextCitation extends ContextSource {
  id: string;
  included: boolean;
}

export interface ContextQuality {
  citationCount: number;
  precision: number | null;
  recall: number | null;
  reciprocalRank: number | null;
  grounded: boolean;
}

export interface ContextIntelligenceReport {
  id: string;
  query: string;
  createdAt: number;
  durationMs: number;
  tokensEstimated: number;
  truncated: boolean;
  citations: ContextCitation[];
  quality: ContextQuality;
  contextText: string;
}

function normalizeRelPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function scoreContextQuality(
  sources: readonly ContextSource[],
  expectedPaths: readonly string[] = [],
): ContextQuality {
  const actual = sources.map((source) => normalizeRelPath(source.rel));
  const expected = [...new Set(expectedPaths.map(normalizeRelPath).filter(Boolean))];
  if (expected.length === 0) {
    return {
      citationCount: sources.length,
      precision: null,
      recall: null,
      reciprocalRank: null,
      grounded: sources.length > 0,
    };
  }
  const expectedSet = new Set(expected);
  const relevant = actual.filter((path) => expectedSet.has(path));
  const firstRank = actual.findIndex((path) => expectedSet.has(path));
  return {
    citationCount: sources.length,
    precision: actual.length === 0 ? 0 : round(relevant.length / actual.length, 4),
    recall: round(new Set(relevant).size / expected.length, 4),
    reciprocalRank: firstRank < 0 ? 0 : round(1 / (firstRank + 1), 4),
    grounded: sources.length > 0,
  };
}

export interface ContextEvalCase {
  id: string;
  query: string;
  expectedPaths: string[];
  activePath?: string;
}

export interface ContextEvalCaseResult {
  id: string;
  quality: ContextQuality;
  durationMs: number;
  tokensEstimated: number;
}

export interface ContextEvalSuiteResult {
  cases: ContextEvalCaseResult[];
  averagePrecision: number;
  averageRecall: number;
  meanReciprocalRank: number;
  groundedRate: number;
}

export function summarizeContextEvals(
  cases: readonly ContextEvalCaseResult[],
): ContextEvalSuiteResult {
  const denominator = Math.max(1, cases.length);
  return {
    cases: [...cases],
    averagePrecision: round(
      cases.reduce((sum, item) => sum + (item.quality.precision ?? 0), 0) / denominator,
      4,
    ),
    averageRecall: round(
      cases.reduce((sum, item) => sum + (item.quality.recall ?? 0), 0) / denominator,
      4,
    ),
    meanReciprocalRank: round(
      cases.reduce((sum, item) => sum + (item.quality.reciprocalRank ?? 0), 0) / denominator,
      4,
    ),
    groundedRate: round(
      cases.filter((item) => item.quality.grounded).length / denominator,
      4,
    ),
  };
}

// ---------------------------------------------------------------------------
// 2. Predictive editing
// ---------------------------------------------------------------------------
export type CompletionTrigger = 'typing' | 'explicit' | 'next-edit';

export interface PredictiveCompletionInput {
  requestId: string;
  documentUri: string;
  documentVersion: number;
  prefix: string;
  suffix: string;
  language: string;
  trigger: CompletionTrigger;
  maxLines?: number;
}

export interface PredictiveCompletionResult {
  requestId: string;
  documentVersion: number;
  text: string;
  elapsedMs: number;
  cached: boolean;
  stale: boolean;
}

export type PredictionFeedbackKind = 'accepted' | 'accepted-partial' | 'dismissed' | 'stale';

export interface PredictionFeedback {
  requestId: string;
  kind: PredictionFeedbackKind;
  acceptedCharacters: number;
  at: number;
}

export interface PredictionMetrics {
  requested: number;
  completed: number;
  cacheHits: number;
  stale: number;
  accepted: number;
  partial: number;
  dismissed: number;
  acceptanceRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
}

export function summarizePredictionMetrics(
  latencies: readonly number[],
  counters: Omit<
    PredictionMetrics,
    'averageLatencyMs' | 'p95LatencyMs' | 'acceptanceRate'
  >,
): PredictionMetrics {
  const clean = latencies.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const averageLatencyMs =
    clean.length === 0 ? 0 : Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length);
  const p95Index = clean.length === 0 ? -1 : Math.min(clean.length - 1, Math.ceil(clean.length * 0.95) - 1);
  const decided = counters.accepted + counters.partial + counters.dismissed;
  return {
    ...counters,
    acceptanceRate:
      decided === 0 ? 0 : round((counters.accepted + counters.partial) / decided, 4),
    averageLatencyMs,
    p95LatencyMs: p95Index < 0 ? 0 : Math.round(clean[p95Index] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// 3. Autonomous engineering loop + durable jobs
// ---------------------------------------------------------------------------
export type GodModeJobKind =
  | 'autonomous-run'
  | 'verification'
  | 'workspace-create'
  | 'issue-to-pr'
  | 'deployment';
export type GodModeJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type EngineeringPhase =
  | 'understand'
  | 'plan'
  | 'edit'
  | 'run'
  | 'observe'
  | 'fix'
  | 'verify'
  | 'summarize';

export interface GodModeJob {
  id: string;
  kind: GodModeJobKind;
  root: string;
  title: string;
  status: GodModeJobStatus;
  phase: EngineeringPhase;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  progress: number;
  iteration: number;
  maxIterations: number;
  ownerWindowId: number | null;
  /** Prior Agent run journal replayed by this successor; null for a fresh job. */
  resumeRunId: string | null;
  resumable: boolean;
  summary: string;
  error: string | null;
  evidence: EvidenceRecord[];
}

export interface CreateAutonomousJobInput {
  root: string;
  goal: string;
  maxIterations?: number;
}

export interface JobControlInput {
  id: string;
  action: 'pause' | 'resume' | 'cancel';
}

export function canTransitionJob(
  from: GodModeJobStatus,
  to: GodModeJobStatus,
): boolean {
  const allowed: Record<GodModeJobStatus, readonly GodModeJobStatus[]> = {
    queued: ['running', 'cancelled'],
    running: ['paused', 'awaiting-approval', 'completed', 'failed', 'cancelled'],
    paused: ['running', 'cancelled'],
    'awaiting-approval': ['running', 'paused', 'cancelled', 'failed'],
    completed: [],
    failed: ['queued'],
    cancelled: ['queued'],
  };
  return allowed[from].includes(to);
}

// ---------------------------------------------------------------------------
// 4. Secure preview + visual editing evidence
// ---------------------------------------------------------------------------
export interface PreviewOpenInput {
  root: string;
  url: string;
  launchCommand?: string;
  confirmation?: boolean;
}

export type PreviewPhase = 'closed' | 'launching' | 'loading' | 'ready' | 'error';

export interface PreviewConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source: string;
  line: number;
  at: number;
}

export interface PreviewRuntimeError {
  message: string;
  source: string;
  line: number;
  column: number;
  at: number;
}

export interface PreviewElementSelection {
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  ariaLabel: string | null;
  role: string | null;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  at: number;
}

export interface PreviewSnapshot {
  id: string;
  root: string;
  url: string;
  origin: string;
  phase: PreviewPhase;
  title: string;
  startedAt: number;
  updatedAt: number;
  launchCommand: string | null;
  launchPid: number | null;
  console: PreviewConsoleEntry[];
  runtimeErrors: PreviewRuntimeError[];
  selectedElement: PreviewElementSelection | null;
  screenshotDataUrl: string | null;
  error: string | null;
}

export function isSafePreviewUrl(value: string, allowRemoteHttps = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const secretParameter = /(?:^|[_-])(?:access[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|signature)(?:$|[_-])/i;
    if ([...url.searchParams.keys()].some((key) => secretParameter.test(key))) return false;
    if (/(?:^|[?&#])(?:access[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|signature)=/i.test(url.hash)) {
      return false;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const host = url.hostname.toLowerCase();
      const loopback =
        host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
      return loopback || (allowRemoteHttps && url.protocol === 'https:');
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5. Test/debug-aware workflows
// ---------------------------------------------------------------------------
export type CheckKind = 'test' | 'typecheck' | 'lint' | 'build' | 'custom';

export interface VerificationCheck {
  id: string;
  label: string;
  kind: CheckKind;
  command: string;
  affected: boolean;
  required: boolean;
  reason: string;
}

export interface VerificationPlan {
  id: string;
  root: string;
  createdAt: number;
  changedFiles: string[];
  checks: VerificationCheck[];
}

export interface VerificationCheckResult {
  checkId: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  failures: string[];
  flakySignal: boolean;
}

export interface VerificationRunResult {
  planId: string;
  startedAt: number;
  endedAt: number;
  passed: boolean;
  level: VerificationLevel;
  /** Aggregate SHA-256 of the immutable source snapshot that was executed. */
  snapshotSha256: string;
  snapshotFileCount: number;
  snapshotBytes: number;
  /** Full original-workspace identity retained for later freshness checks. */
  sourceFingerprint: string;
  /** Set only when the snapshot exactly represented a completely clean HEAD commit. */
  cleanCommitSha: string | null;
  results: VerificationCheckResult[];
}

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;


export interface DebugEvidenceVariable {
  name: string;
  value: string;
  type: string | null;
  hasChildren: boolean;
  redacted: boolean;
}

export interface DebugEvidenceScope {
  name: string;
  expensive: boolean;
  variables: DebugEvidenceVariable[];
  truncated: boolean;
}

export interface DebugEvidenceFrame {
  name: string;
  workspacePath: string | null;
  line: number;
  column: number;
  scopes: DebugEvidenceScope[];
}

/** Bounded, workspace-relative debugger state suitable for an AI evidence handoff. */
export interface DebugEvidenceSnapshot {
  id: string;
  capturedAt: number;
  threadId: number;
  frames: DebugEvidenceFrame[];
  frameCount: number;
  truncated: boolean;
  redactedValues: number;
  warnings: string[];
}

export function planAffectedChecks(
  root: string,
  changedFiles: readonly string[],
  scripts: Readonly<Record<string, string>>,
  now = Date.now(),
): VerificationPlan {
  const normalized = [...new Set(changedFiles.map((path) => path.replace(/\\/g, '/')).filter(Boolean))].slice(0, 500);
  const hasTests = normalized.some((path) => TEST_FILE.test(path));
  const checks: VerificationCheck[] = [];
  const candidates: Array<{ names: string[]; kind: CheckKind; label: string; required: boolean }> = [
    { names: ['test', 'test:unit'], kind: 'test', label: 'Tests', required: hasTests },
    { names: ['typecheck', 'type-check'], kind: 'typecheck', label: 'Typecheck', required: true },
    { names: ['lint'], kind: 'lint', label: 'Lint', required: false },
    { names: ['build'], kind: 'build', label: 'Build', required: true },
  ];
  for (const candidate of candidates) {
    const script = candidate.names.find((name) => typeof scripts[name] === 'string');
    if (!script) continue;
    checks.push({
      id: `${candidate.kind}:${script}`,
      label: candidate.label,
      kind: candidate.kind,
      command: `npm run ${script}`,
      affected: candidate.kind === 'test' ? hasTests || normalized.length > 0 : normalized.length > 0,
      required: candidate.required,
      reason:
        candidate.kind === 'test' && hasTests
          ? 'Changed files include tests.'
          : `${normalized.length} changed file(s) may affect this check.`,
    });
  }
  return {
    id: stableId('verify', `${root}\0${normalized.join('\0')}\0${now}`),
    root,
    createdAt: now,
    changedFiles: normalized,
    checks,
  };
}

export function hasFlakySignal(output: string): boolean {
  return /\b(flaky|timed?\s*out|timeout|race|intermittent|retry(?:ing| succeeded)|ECONNRESET|EADDRINUSE)\b/i.test(
    output,
  );
}

// ---------------------------------------------------------------------------
// 6. GitHub issue → verified PR
// ---------------------------------------------------------------------------
export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubIssue extends GithubIssueRef {
  title: string;
  body: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  updatedAt: string;
}

export interface IssueWorkPlan {
  issue: GithubIssue;
  branch: string;
  goal: string;
  acceptanceCriteria: string[];
  createdAt: number;
}

export interface PullRequestInput {
  root: string;
  issue: GithubIssueRef;
  title: string;
  summary: string;
  head: string;
  base: string;
  draft: boolean;
  verificationPlanId: string;
  commitMessage?: string;
  confirmation: boolean;
}

export interface PullRequestResult {
  number: number;
  htmlUrl: string;
  state: 'open';
  draft: boolean;
  head: string;
  base: string;
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function issueBranchName(issue: Pick<GithubIssue, 'number' | 'title'>): string {
  const suffix = slugPart(issue.title) || 'work';
  return `axiom/issue-${Math.max(1, Math.floor(issue.number))}-${suffix}`.slice(0, 96);
}

export function pullRequestBody(
  issue: GithubIssueRef,
  verification: VerificationRunResult,
  summary: string,
): string {
  const checks = verification.results
    .map((result) => `- ${result.passed ? '[x]' : '[ ]'} ${result.summary}`)
    .join('\n');
  return [
    summary.trim(),
    '',
    `Closes #${issue.number}`,
    '',
    '## Verification',
    checks || '- [ ] No automated verification was recorded.',
    '',
    `Verification level: **${verification.level}**`,
    '',
    '_Created by Axiom God Mode with human-approved Git operations._',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 7. Isolated/reproducible workspaces
// ---------------------------------------------------------------------------
export type WorkspaceBackend = 'local-clone' | 'wsl' | 'ssh' | 'dev-container';
export type IsolatedWorkspaceStatus = 'creating' | 'ready' | 'busy' | 'stopped' | 'error';

export interface IsolatedWorkspaceProfile {
  id: string;
  name: string;
  backend: WorkspaceBackend;
  sourceRoot: string;
  workspacePath: string;
  distro?: string;
  host?: string;
  user?: string;
  container?: string;
  createdAt: number;
  updatedAt: number;
  status: IsolatedWorkspaceStatus;
  reproducibilityFiles: string[];
  lastError: string | null;
}

export interface CreateIsolatedWorkspaceInput {
  root: string;
  name: string;
  backend: WorkspaceBackend;
  workspacePath?: string;
  distro?: string;
  host?: string;
  user?: string;
  container?: string;
  confirmation: boolean;
}

export interface WorkspaceProbeInput {
  root: string;
  backend: WorkspaceBackend;
  workspacePath?: string;
  distro?: string;
  host?: string;
  user?: string;
  container?: string;
}

export interface RemoteProbeResult {
  backend: WorkspaceBackend;
  available: boolean;
  version: string | null;
  message: string;
  targetPath?: string | null;
  durationMs?: number;
}

export interface WorkspaceCommandResult {
  profileId: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
  passed: boolean;
}

export function validateWorkspaceBackendInput(input: CreateIsolatedWorkspaceInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('Workspace name is required.');
  if (input.backend !== 'local-clone' && !input.workspacePath?.trim()) {
    errors.push('A remote workspace path is required.');
  }
  if (input.backend === 'wsl' && !input.distro?.trim()) errors.push('A WSL distro is required.');
  if (input.backend === 'ssh' && !input.host?.trim()) errors.push('An SSH host is required.');
  if (input.backend === 'dev-container' && !input.container?.trim()) {
    errors.push('A container name or id is required.');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 8. Sandboxed extensions
// ---------------------------------------------------------------------------
export type ExtensionRuntimeKind = 'declarative' | 'wasm';

export interface ExtensionSandboxStatus {
  extensionId: string;
  runtime: ExtensionRuntimeKind;
  enabled: boolean;
  integrityVerified: boolean;
  signatureVerified: boolean;
  permissions: string[];
  memoryLimitMb: number;
  executionTimeoutMs: number;
  lastError: string | null;
}

export interface WasmSandboxPolicy {
  maxModuleBytes: number;
  maxMemoryPages: number;
  executionTimeoutMs: number;
  allowImports: string[];
}

export const DEFAULT_WASM_SANDBOX_POLICY: Readonly<WasmSandboxPolicy> = Object.freeze({
  maxModuleBytes: 4 * 1024 * 1024,
  maxMemoryPages: 256,
  executionTimeoutMs: 1_500,
  allowImports: [],
});

export function validateWasmModuleShape(
  byteLength: number,
  imports: readonly string[],
  policy: WasmSandboxPolicy = DEFAULT_WASM_SANDBOX_POLICY,
): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) errors.push('WASM module is empty.');
  if (byteLength > policy.maxModuleBytes) errors.push('WASM module exceeds the size limit.');
  const allowed = new Set(policy.allowImports);
  for (const entry of imports) {
    if (!allowed.has(entry)) errors.push(`WASM import is not allowed: ${entry}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 9. Collaboration + durable background work
// ---------------------------------------------------------------------------
export type CollaborationRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export interface CollaborationMember {
  id: string;
  displayName: string;
  role: CollaborationRole;
  lastSeenAt: number;
}

export interface CollaborationEvent {
  id: string;
  sessionId: string;
  actorId: string;
  kind: 'note' | 'decision' | 'checkpoint' | 'verification' | 'handoff';
  text: string;
  createdAt: number;
  evidenceIds: string[];
}

export interface CollaborationSession {
  id: string;
  rootFingerprint: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  members: CollaborationMember[];
  events: CollaborationEvent[];
  shared: boolean;
  cloudState: 'local-only' | 'syncing' | 'synced' | 'error';
}

export interface CreateCollaborationSessionInput {
  root: string;
  title: string;
}

export interface CollaborationExport {
  schemaVersion: typeof GOD_MODE_SCHEMA_VERSION;
  exportedAt: number;
  session: CollaborationSession;
  jobs: GodModeJob[];
  evidence: EvidenceRecord[];
}

// ---------------------------------------------------------------------------
// 10. Guarded preview deployment
// ---------------------------------------------------------------------------
export type DeploymentProvider = 'local-static' | 'github-actions' | 'deploy-hook';
export type DeploymentStatus =
  | 'planned'
  | 'uploading'
  | 'queued'
  | 'deploying'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface DeploymentTarget {
  id: string;
  name: string;
  provider: DeploymentProvider;
  /** Main-owned secret-store key; never a secret value. */
  secretRef?: string;
  workflow?: string;
  repository?: string;
  ref?: string;
  hookOrigin?: string;
  /** Opaque Main-issued secret revision retained by a one-shot plan. */
  hookRevision?: string;
  /** SHA-256 of the complete normalized secret URL; never the URL itself. */
  hookUrlSha256?: string;
  outputDirectory?: string;
}

export interface DeploymentPlanInput {
  root: string;
  target: DeploymentTarget;
  commitSha?: string;
}

export interface DeploymentPlan {
  id: string;
  root: string;
  target: DeploymentTarget;
  /** Exact Git HEAD approved by this one-shot plan. */
  commitSha: string;
  /** Exact bounded local artifact identity captured when the plan was approved. */
  artifactSha256?: string;
  artifactFileCount?: number;
  artifactBytes?: number;
  createdAt: number;
  checks: string[];
  warnings: string[];
  requiresConfirmation: true;
}

export interface ExecuteDeploymentInput {
  planId: string;
  verificationPlanId: string;
  confirmation: boolean;
}

export interface DeploymentRun {
  id: string;
  planId: string;
  provider: DeploymentProvider;
  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
  previewUrl: string | null;
  providerUrl: string | null;
  commitSha: string | null;
  summary: string;
  evidence: EvidenceRecord[];
}

export function validateDeploymentTarget(target: DeploymentTarget): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(target.id.trim())) {
    errors.push('Target id must use 1-100 letters, numbers, dots, dashes, or underscores.');
  }
  if (!target.name.trim()) errors.push('Target name is required.');
  if (target.provider === 'github-actions') {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(target.workflow ?? '')) {
      errors.push('A workflow file or numeric id is required for GitHub Actions deployment.');
    }
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(target.repository ?? '')) {
      errors.push('An owner/repository is required for GitHub Actions deployment.');
    }
    const ref = target.ref ?? '';
    if (
      !/^[A-Za-z0-9._/-]{1,200}$/.test(ref) ||
      ref.startsWith('/') ||
      ref.endsWith('/') ||
      ref.includes('..') ||
      ref.includes('@{')
    ) {
      errors.push('A safe Git branch or tag ref is required for GitHub Actions deployment.');
    }
  }
  if (target.provider === 'deploy-hook') {
    if (!/^deployment\.hook\.[A-Za-z0-9_.-]{1,220}$/.test(target.secretRef ?? '')) {
      errors.push('A Main-owned deploy-hook secret reference is required.');
    }
    if (!/^[0-9a-f]{32}$/.test(target.hookRevision ?? '')) {
      errors.push('An exact deploy-hook secret revision is required.');
    }
    if (!/^[0-9a-f]{64}$/.test(target.hookUrlSha256 ?? '')) {
      errors.push('An exact deploy-hook URL digest is required.');
    }
    if (!target.hookOrigin?.trim()) errors.push('An exact HTTPS hook origin is required.');
    else {
      try {
        const url = new URL(target.hookOrigin);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        ) {
          errors.push('Hook origin must be an exact credential-free HTTPS origin.');
        }
      } catch {
        errors.push('Hook origin is invalid.');
      }
    }
  }
  if (target.provider === 'local-static') {
    const output = target.outputDirectory?.trim().replace(/\\/g, '/') ?? '';
    if (
      !output ||
      output.startsWith('/') ||
      /^[A-Za-z]:\//.test(output) ||
      output.split('/').some(
        (segment) => segment === '..' || segment === '.' || segment.length === 0,
      )
    ) {
      errors.push('A safe workspace-relative output directory is required for local preview.');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Shared bounded helpers
// ---------------------------------------------------------------------------
export function boundedText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
