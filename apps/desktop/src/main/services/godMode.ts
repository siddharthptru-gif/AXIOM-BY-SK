import type { CapabilityDescriptor, GodModeCapabilityId, GodModeSnapshot } from '../../common/godMode';
import { GOD_MODE_SCHEMA_VERSION } from '../../common/godMode';
import { getGithubState } from './githubScm';
import { listGodModeJobs } from './godModeJobs';
import { readSettings } from './settings';
import { hasUsableAiCredential } from './secrets';
import { currentCommit, getRepositoryInfo } from './systemGit';
import { DEFAULT_COMPLETION_MODELS } from './completion';

const DEFINITIONS: ReadonlyArray<
  Omit<CapabilityDescriptor, 'readiness' | 'summary' | 'actionLabel'> & {
    readySummary: string;
    setupSummary?: string;
  }
> = [
  {
    id: 'context-intelligence',
    title: 'Context intelligence',
    readySummary: 'Semantic retrieval, project graph, citations, budgets, and measurable eval suites are available.',
    safeguards: ['Bounded context budgets', 'Source citations', 'Prompt-injection envelopes'],
  },
  {
    id: 'predictive-editing',
    title: 'Predictive editing',
    readySummary: 'Cancellable, cached, stale-safe inline completion and next-edit controls are available; configured provider health determines whether suggestions are returned.',
    safeguards: ['Document-version binding', 'Main cancellation', 'No automatic writes'],
  },
  {
    id: 'autonomous-verification',
    title: 'Autonomous verification',
    readySummary: 'Durable bounded plan/edit/run/observe/fix/verify jobs can be resumed and audited.',
    safeguards: ['Approval policy', 'Iteration cap', 'Checkpoints and evidence'],
  },
  {
    id: 'secure-preview',
    title: 'Secure application preview',
    readySummary: 'Loopback application previews provide console, runtime, screenshot, and element evidence.',
    safeguards: ['Sandboxed renderer', 'Loopback-only navigation', 'Downloads and permissions denied'],
  },
  {
    id: 'test-debug-ai',
    title: 'Test and debugger AI',
    readySummary: 'Affected checks, bounded execution, flaky signals, DAP stack/scopes, and repair handoff are available.',
    safeguards: ['Generated command allowlist', 'Explicit execution approval', 'Timeout and process-tree cleanup'],
  },
  {
    id: 'issue-to-pr',
    title: 'GitHub issue to verified PR',
    readySummary: 'Issues can drive clean branches and verification-bound pull requests.',
    setupSummary: 'Connect GitHub and configure a matching repository remote.',
    safeguards: ['Main-only OAuth', 'Exact repository binding', 'Fresh verification required'],
  },
  {
    id: 'isolated-workspaces',
    title: 'Isolated workspaces',
    readySummary: 'Managed local clones and capability-gated WSL, SSH, and container execution profiles are available.',
    safeguards: ['Explicit creation and execution approval', 'Managed deletion boundary', 'Bounded process output'],
  },
  {
    id: 'sandboxed-extensions',
    title: 'Sandboxed extensions',
    readySummary: 'Declarative extensions and integrity-checked, import-free WASM workers are supported.',
    safeguards: ['Legacy JavaScript fail-closed', 'Memory/time quotas', 'Signature and integrity review'],
  },
  {
    id: 'collaboration-background',
    title: 'Collaboration and background agents',
    readySummary: 'Durable jobs, evidence handoffs, and local sessions are available. Optional team sync requires authenticated, migrated Supabase infrastructure and is not assumed live.',
    safeguards: ['Cloud paths and secrets redacted', 'RLS policies required for sharing', 'Owner leases and resumability'],
  },
  {
    id: 'preview-deployment',
    title: 'Preview deployment',
    readySummary: 'Commit-pinned local static preview is available. GitHub Actions and encrypted hooks remain optional provider-dependent triggers whose external completion Axiom does not assume.',
    safeguards: ['Current verification required', 'Commit pinning', 'No direct source upload'],
  },
];

function restricted(definition: (typeof DEFINITIONS)[number]): CapabilityDescriptor {
  return {
    id: definition.id,
    title: definition.title,
    readiness: 'restricted',
    summary: 'Trust a workspace to enable this capability.',
    safeguards: [...definition.safeguards],
    actionLabel: 'Trust workspace',
  };
}

function setupRequired(
  definition: (typeof DEFINITIONS)[number],
  summary: string,
  actionLabel: string,
): CapabilityDescriptor {
  return {
    id: definition.id,
    title: definition.title,
    readiness: 'setup-required',
    summary,
    safeguards: [...definition.safeguards],
    actionLabel,
  };
}

function githubSlug(value: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
    value.trim(),
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export async function getGodModeSnapshot(
  _ownerId: number,
  root: string | null,
  trusted: boolean,
): Promise<GodModeSnapshot> {
  if (!root || !trusted) {
    return {
      schemaVersion: GOD_MODE_SCHEMA_VERSION,
      generatedAt: Date.now(),
      root,
      trusted,
      capabilities: DEFINITIONS.map(restricted),
      activeJobs: 0,
      queuedJobs: 0,
    };
  }

  const [jobsResult, settingsResult, githubResult, repositoryResult, commitResult] =
    await Promise.allSettled([
      listGodModeJobs(root),
      readSettings(),
      getGithubState(),
      getRepositoryInfo(root),
      currentCommit(root),
    ]);
  const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : [];
  const settings =
    settingsResult.status === 'fulfilled'
      ? (settingsResult.value as Record<string, unknown>)
      : {};
  const provider =
    typeof settings['ai.provider'] === 'string' ? settings['ai.provider'] : 'anthropic';
  const configuredBaseUrl =
    provider === 'custom'
      ? typeof settings['ai.custom.baseUrl'] === 'string'
        ? settings['ai.custom.baseUrl']
        : ''
      : typeof settings['ai.baseUrl'] === 'string'
        ? settings['ai.baseUrl']
        : '';
  const configuredModel =
    provider === 'custom'
      ? typeof settings['ai.custom.model'] === 'string'
        ? settings['ai.custom.model'].trim()
        : ''
      : typeof settings['ai.model'] === 'string' && settings['ai.model'].trim()
        ? settings['ai.model'].trim()
        : (DEFAULT_COMPLETION_MODELS[provider] ?? '');
  const aiModelAvailable =
    configuredModel.length > 0 &&
    configuredModel.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(configuredModel);
  const aiCredentialAvailable =
    aiModelAvailable && (await hasUsableAiCredential(provider, configuredBaseUrl));
  const completionEnabled = settings['ai.completion.enabled'] !== false;
  const githubConnected =
    githubResult.status === 'fulfilled' && githubResult.value.status === 'connected';
  const githubRemoteReady =
    repositoryResult.status === 'fulfilled' &&
    repositoryResult.value.remotes.some((remote) => {
      const fetch = githubSlug(remote.fetchUrl);
      return fetch !== null && fetch === githubSlug(remote.pushUrl);
    });
  const commitReady =
    commitResult.status === 'fulfilled' && /^[0-9a-f]{40}$/i.test(commitResult.value);

  const capabilities = DEFINITIONS.map((definition): CapabilityDescriptor => {
    if (definition.id === ('predictive-editing' satisfies GodModeCapabilityId)) {
      if (!completionEnabled) {
        return setupRequired(
          definition,
          'Predictive completion is disabled in Settings.',
          'Enable completion',
        );
      }
      if (!aiCredentialAvailable) {
        return setupRequired(
          definition,
          'Configure the selected AI provider credential before requesting predictions.',
          'Configure AI',
        );
      }
    }
    if (
      definition.id === ('autonomous-verification' satisfies GodModeCapabilityId) &&
      !aiCredentialAvailable
    ) {
      return setupRequired(
        definition,
        'Configure the selected AI provider before launching autonomous Build jobs.',
        'Configure AI',
      );
    }
    if (definition.id === ('issue-to-pr' satisfies GodModeCapabilityId)) {
      if (!githubConnected) {
        return setupRequired(
          definition,
          definition.setupSummary ?? 'Connect GitHub.',
          'Connect GitHub',
        );
      }
      if (!githubRemoteReady) {
        return setupRequired(
          definition,
          'Configure a GitHub remote whose fetch and push destinations match.',
          'Configure remote',
        );
      }
    }
    if (definition.id === ('preview-deployment' satisfies GodModeCapabilityId) && !commitReady) {
      return setupRequired(
        definition,
        'A trusted Git workspace with a valid current commit is required for deployment plans.',
        'Create Git commit',
      );
    }
    return {
      id: definition.id,
      title: definition.title,
      readiness: 'ready',
      summary: definition.readySummary,
      safeguards: [...definition.safeguards],
    };
  });
  return {
    schemaVersion: GOD_MODE_SCHEMA_VERSION,
    generatedAt: Date.now(),
    root,
    trusted,
    capabilities,
    activeJobs: jobs.filter((job) => ['running', 'awaiting-approval'].includes(job.status)).length,
    queuedJobs: jobs.filter((job) => ['queued', 'paused'].includes(job.status)).length,
  };
}
