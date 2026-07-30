import { createHash, randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { GitStatusResult } from '../../common/ipc';
import type {
  GithubIssue,
  GithubIssueRef,
  IssueWorkPlan,
  PullRequestInput,
  PullRequestResult,
} from '../../common/godMode';
import { boundedText, issueBranchName, pullRequestBody } from '../../common/godMode';
import { getStatus } from './git';
import { githubApiRequest } from './githubApi';
import { createBranch, getRepositoryInfo, pushRepository, commitAndPush } from './systemGit';
import { commit as commitStaged } from './git';
import { requireVerifiedPlan } from './verification';
import { validateBranchRef } from './githubScmPure';

const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_ISSUE_BODY = 100_000;
const MAX_PR_BODY = 120_000;

interface GithubWorkspaceOperation {
  ownerId: number;
  root: string;
  controller: AbortController;
}

const activeOperations = new Map<string, GithubWorkspaceOperation>();

export interface GithubWorkspaceLease {
  signal: AbortSignal;
  release: () => void;
}

export function beginGithubWorkspaceOperation(ownerId: number, root: string): GithubWorkspaceLease {
  const id = randomUUID();
  const operation: GithubWorkspaceOperation = { ownerId, root, controller: new AbortController() };
  activeOperations.set(id, operation);
  return {
    signal: operation.controller.signal,
    release: () => {
      if (activeOperations.get(id) === operation) activeOperations.delete(id);
    },
  };
}

function cancelGithubWorkspaceOperations(
  predicate: (operation: GithubWorkspaceOperation) => boolean,
): void {
  for (const [id, operation] of activeOperations) {
    if (!predicate(operation)) continue;
    activeOperations.delete(id);
    operation.controller.abort();
  }
}

export function cancelGithubWorkspaceOperationsForOwner(ownerId: number): void {
  cancelGithubWorkspaceOperations((operation) => operation.ownerId === ownerId);
}

export function cancelGithubWorkspaceOperationsForRoot(root: string): void {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  cancelGithubWorkspaceOperations(
    (operation) =>
      (process.platform === 'win32' ? operation.root.toLowerCase() : operation.root) === key,
  );
}

function refOf(value: unknown): GithubIssueRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('GitHub issue reference is required.');
  }
  const record = value as Record<string, unknown>;
  const owner = typeof record.owner === 'string' ? record.owner.trim() : '';
  const repo = typeof record.repo === 'string' ? record.repo.trim() : '';
  const number =
    typeof record.number === 'number' && Number.isSafeInteger(record.number)
      ? record.number
      : Number.NaN;
  if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) {
    throw new Error('GitHub owner and repository names are invalid.');
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new Error('GitHub issue number is invalid.');
  }
  return { owner, repo, number };
}

function remoteRepository(raw: string): { owner: string; repo: string } | null {
  const value = raw.trim();
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    value,
  );
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh =
    /^(?:ssh:\/\/git@)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return ssh ? { owner: ssh[1]!, repo: ssh[2]! } : null;
}

async function assertRootRepository(root: string, ref: GithubIssueRef): Promise<void> {
  const repository = await getRepositoryInfo(root);
  const matches = repository.remotes.some((remote) => {
    if (!remote.github) return false;
    const parsedFetch = remoteRepository(remote.fetchUrl);
    const parsedPush = remoteRepository(remote.pushUrl);
    return [parsedFetch, parsedPush].every(
      (parsed) =>
        parsed?.owner.toLowerCase() === ref.owner.toLowerCase() &&
        parsed.repo.toLowerCase() === ref.repo.toLowerCase(),
    );
  });
  if (!matches) {
    throw new Error(`The trusted workspace has no GitHub remote for ${ref.owner}/${ref.repo}.`);
  }
}

function assertIssuePushDestination(status: GitStatusResult, ref: GithubIssueRef): string {
  const separator = status.upstream?.indexOf('/') ?? -1;
  const remoteName = separator > 0 ? status.upstream!.slice(0, separator) : 'origin';
  const remote = status.remotes.find((candidate) => candidate.name === remoteName);
  const parsed = remote ? remoteRepository(remote.pushUrl) : null;
  if (
    !remote?.github ||
    parsed?.owner.toLowerCase() !== ref.owner.toLowerCase() ||
    parsed.repo.toLowerCase() !== ref.repo.toLowerCase()
  ) {
    throw new Error('The current branch push destination does not match the issue repository.');
  }
  return `https://github.com/${ref.owner}/${ref.repo}`;
}

function str(record: Record<string, unknown>, key: string, max: number): string {
  return typeof record[key] === 'string' ? boundedText(record[key], max) : '';
}

function parseIssue(payload: unknown, expected: GithubIssueRef): GithubIssue {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub returned a malformed issue.');
  }
  const record = payload as Record<string, unknown>;
  if ('pull_request' in record)
    throw new Error('The selected number is a pull request, not an issue.');
  if (record.number !== expected.number)
    throw new Error('GitHub returned an unexpected issue number.');
  const title = str(record, 'title', 500);
  const htmlUrl = str(record, 'html_url', 1_000);
  const expectedUrl = `https://github.com/${expected.owner}/${expected.repo}/issues/${expected.number}`;
  if (!title || htmlUrl.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error('GitHub returned unexpected issue metadata.');
  }
  const user = record.user as Record<string, unknown> | undefined;
  const labels = Array.isArray(record.labels)
    ? record.labels
        .map((item) =>
          item && typeof item === 'object' ? str(item as Record<string, unknown>, 'name', 100) : '',
        )
        .filter(Boolean)
        .slice(0, 100)
    : [];
  return {
    ...expected,
    title,
    body: typeof record.body === 'string' ? record.body.slice(0, MAX_ISSUE_BODY) : '',
    htmlUrl,
    state: record.state === 'closed' ? 'closed' : 'open',
    labels,
    author: user ? str(user, 'login', 100) : '',
    updatedAt: str(record, 'updated_at', 100),
  };
}

export async function loadGithubIssue(
  ownerId: number,
  root: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<GithubIssue> {
  signal?.throwIfAborted();
  const ref = refOf(value);
  await assertRootRepository(root, ref);
  const response = await githubApiRequest(
    ownerId,
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
    'GET',
    undefined,
    signal,
  );
  signal?.throwIfAborted();
  if (response.status === 404) throw new Error('GitHub issue was not found or is not accessible.');
  if (!response.ok) throw new Error(`GitHub could not load the issue (HTTP ${response.status}).`);
  return parseIssue(response.payload, ref);
}

function acceptanceCriteria(issue: GithubIssue): string[] {
  const checklist = [...issue.body.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)]
    .map((match) => boundedText(match[1], 500))
    .filter(Boolean)
    .slice(0, 20);
  if (checklist.length > 0) return checklist;
  return [
    'Implement the requested behavior without unrelated changes.',
    'Add or update focused tests where the repository supports them.',
    'Run the generated verification plan and preserve its evidence.',
  ];
}

export async function planGithubIssue(
  ownerId: number,
  root: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<IssueWorkPlan> {
  const issue = await loadGithubIssue(ownerId, root, value, signal);
  signal?.throwIfAborted();
  return {
    issue,
    branch: issueBranchName(issue),
    goal: `${issue.title}\n\n${issue.body}`.trim().slice(0, 20_000),
    acceptanceCriteria: acceptanceCriteria(issue),
    createdAt: Date.now(),
  };
}

export async function startGithubIssue(
  ownerId: number,
  root: string,
  value: unknown,
  confirmation: unknown,
  signal?: AbortSignal,
  expectedBranch?: string,
): Promise<IssueWorkPlan> {
  signal?.throwIfAborted();
  if (confirmation !== true)
    throw new Error('Creating and checking out an issue branch requires explicit confirmation.');
  const plan = await planGithubIssue(ownerId, root, value, signal);
  signal?.throwIfAborted();
  if (expectedBranch !== undefined && plan.branch !== expectedBranch) {
    throw new Error('The GitHub issue branch changed after approval.');
  }
  if (plan.issue.state !== 'open') throw new Error('Only open GitHub issues can start new work.');
  await createBranch(root, plan.branch);
  return plan;
}

function parsePullResult(payload: unknown, input: PullRequestInput): PullRequestResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GitHub returned a malformed pull request.');
  }
  const record = payload as Record<string, unknown>;
  const number = record.number;
  const htmlUrl = str(record, 'html_url', 1_000);
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    throw new Error('GitHub returned an invalid pull-request number.');
  }
  const expectedUrl = `https://github.com/${input.issue.owner}/${input.issue.repo}/pull/${number as number}`;
  if (htmlUrl.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new Error('GitHub returned an unexpected pull-request URL.');
  }
  return {
    number: number as number,
    htmlUrl,
    state: 'open',
    draft: record.draft === true,
    head: input.head,
    base: input.base,
  };
}

export interface PullRequestApprovalDescriptor {
  digest: string;
  detail: string;
}

interface PreparedPullRequest {
  descriptor: PullRequestApprovalDescriptor;
  issue: GithubIssueRef;
  title: string;
  summary: string;
  head: string;
  base: string;
  draft: boolean;
  verificationPlanId: string;
  commitMessage: string;
  body: string;
}

async function preparePullRequest(
  ownerId: number,
  root: string,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<PreparedPullRequest> {
  signal?.throwIfAborted();
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new TypeError('Pull-request input is required.');
  }
  const value = rawInput as Record<string, unknown>;
  if (value.confirmation !== true) {
    throw new Error(
      'Committing, pushing, and creating a pull request requires explicit confirmation.',
    );
  }
  const issue = refOf(value.issue);
  await assertRootRepository(root, issue);
  signal?.throwIfAborted();
  const title = boundedText(value.title, 500);
  const summary = boundedText(value.summary, 20_000);
  const head = validateBranchRef(boundedText(value.head, 96));
  const base = validateBranchRef(boundedText(value.base, 96) || 'main');
  const verificationPlanId = boundedText(value.verificationPlanId, 200);
  const commitMessage = boundedText(value.commitMessage, 10_000);
  if (!title || !head || !verificationPlanId) {
    throw new Error('Title, head branch, and verification plan are required.');
  }
  const verification = await requireVerifiedPlan(ownerId, verificationPlanId, root);
  signal?.throwIfAborted();
  const body = pullRequestBody(issue, verification, summary).slice(0, MAX_PR_BODY);
  const identity = {
    root,
    issue,
    title,
    summary,
    body,
    head,
    base,
    draft: value.draft === true,
    commitMessage: commitMessage || null,
    verification: {
      planId: verification.planId,
      startedAt: verification.startedAt,
      endedAt: verification.endedAt,
      passed: verification.passed,
      level: verification.level,
      results: verification.results.map((result) => ({
        checkId: result.checkId,
        passed: result.passed,
        exitCode: result.exitCode,
        summary: result.summary,
      })),
    },
  };
  const detail = JSON.stringify(identity, null, 2);
  if (detail.length > 10_000 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(detail)) {
    throw new Error(
      'The exact pull-request effect is too large to display safely. Shorten its text.',
    );
  }
  return {
    descriptor: {
      digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      detail,
    },
    issue,
    title,
    summary,
    head,
    base,
    draft: value.draft === true,
    verificationPlanId,
    commitMessage,
    body,
  };
}

export async function preparePullRequestApproval(
  ownerId: number,
  root: string,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<PullRequestApprovalDescriptor> {
  return (await preparePullRequest(ownerId, root, rawInput, signal)).descriptor;
}

export async function createVerifiedPullRequest(
  owner: WebContents,
  root: string,
  rawInput: unknown,
  approved: PullRequestApprovalDescriptor,
  signal?: AbortSignal,
): Promise<PullRequestResult> {
  signal?.throwIfAborted();
  const prepared = await preparePullRequest(owner.id, root, rawInput, signal);
  if (approved.digest !== prepared.descriptor.digest) {
    throw new Error('Pull-request input or verification evidence changed after approval.');
  }
  const { issue, title, summary, head, base, draft, verificationPlanId, commitMessage, body } =
    prepared;
  const status = await getStatus(root);
  signal?.throwIfAborted();
  if (status.branch !== head)
    throw new Error(`Check out the verified head branch "${head}" first.`);
  if (status.conflicts.length > 0)
    throw new Error('Resolve Git conflicts before creating a pull request.');
  if (status.unstaged.length > 0)
    throw new Error('Stage or discard unstaged changes before creating a pull request.');
  const expectedGithubRepository = assertIssuePushDestination(status, issue);

  if (status.staged.length > 0) {
    if (!commitMessage) throw new Error('Enter a commit message for the staged changes.');
    const pushed = await commitAndPush(
      root,
      commitMessage,
      () => commitStaged(root, commitMessage),
      undefined,
      expectedGithubRepository,
    );
    if (pushed.outcome !== 'success') throw new Error(pushed.message);
  } else {
    await pushRepository(root, undefined, expectedGithubRepository);
  }
  signal?.throwIfAborted();

  const input: PullRequestInput = {
    root,
    issue,
    title,
    summary,
    head,
    base,
    draft,
    verificationPlanId,
    ...(commitMessage ? { commitMessage } : {}),
    confirmation: true,
  };
  const response = await githubApiRequest(
    owner.id,
    `/repos/${issue.owner}/${issue.repo}/pulls`,
    'POST',
    {
      title,
      body,
      head,
      base,
      draft: input.draft,
    },
    signal,
  );
  signal?.throwIfAborted();
  if (response.status === 422) {
    throw new Error(
      'GitHub rejected the pull request. Confirm the branch differs from the base and no equivalent PR already exists.',
    );
  }
  if (!response.ok)
    throw new Error(`GitHub could not create the pull request (HTTP ${response.status}).`);
  return parsePullResult(response.payload, input);
}
