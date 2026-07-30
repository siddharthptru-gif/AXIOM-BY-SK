import { rootLogger } from '@axiom/shared';

/**
 * What this workspace can already do, summarized for the model.
 *
 * The problem this solves is concrete and expensive: asked to format a file, a model with
 * no knowledge of the environment writes a formatter. Asked to add type checking, it
 * hand-rolls one. Both are wasted work when a language server is already running and a
 * formatter is already installed. So before it reasons about code, the model is told what
 * is actually available — installed extensions, running language servers, which of them
 * provide formatting, and which toolchains exist on the machine.
 *
 * Two rules shape this block:
 *
 *   1. **It states availability, never capability it cannot back up.** An extension that
 *      ships code is reported as installed *and* as unable to run, because AXIOM does not
 *      execute extension code. Telling the model that Prettier is "available" when its
 *      command cannot be invoked would produce plans that fail at the last step.
 *   2. **It is small and bounded.** This competes for the same token budget as the user's
 *      actual code. A capability inventory that crowds out the file being edited is a net
 *      loss, so every list is capped and the whole block is truncated to a ceiling.
 *   3. **Every source is loaded on demand, never at import time.** This module aggregates
 *      the heaviest services in Main — extension installation, the contribution engine,
 *      the language-server host — all of which bind Electron the moment they load. A
 *      *summary* of what those services can do must not become a load-time dependency of
 *      everything that wants one, so each source is pulled in inside its own guarded
 *      block. A source that cannot even be loaded then costs one line of context instead
 *      of the whole request, which is exactly the failure mode this block should have.
 *
 * The facts are Main-derived, not workspace-derived, but they are still delivered inside
 * the untrusted envelope like every other context block — an extension's display name is
 * publisher-controlled text, and it does not become instructions by being summarized.
 */
const log = rootLogger.child('capabilities');

/** Ceiling for the whole block. Roughly 250 tokens — informative, never dominant. */
const MAX_BLOCK_CHARS = 1_400;
const MAX_LISTED_EXTENSIONS = 12;
const MAX_LISTED_SERVERS = 10;
const MAX_LISTED_TOOLCHAINS = 14;
const MAX_LISTED_COMMANDS = 8;

export interface WorkspaceCapabilities {
  /** Enabled marketplace extensions, with whether their code can run. */
  extensions: Array<{ id: string; displayName: string; works: string[]; canRunCode: boolean }>;
  /** Language servers currently running for this workspace. */
  languageServers: Array<{ id: string; displayName: string; languageIds: string[] }>;
  /** Running servers that advertise document formatting. */
  formatters: Array<{ id: string; displayName: string; languageIds: string[] }>;
  /** Toolchains detected on the machine, with version when known. */
  toolchains: Array<{ id: string; displayName: string; version: string | null }>;
  /** Commands contributed by extensions, whether or not their host is running. */
  contributedCommands: string[];
  /** Commands an extension host is running right now and will actually execute. */
  invocableCommands: string[];
  /** True when at least one installed extension ships code that is not currently running. */
  hasInertExtensions: boolean;
}

/**
 * Gather the capability inventory.
 *
 * Every source is independently guarded: a failing language-server query must not cost the
 * model its toolchain list. A completely failed gather returns empty lists rather than
 * throwing, because losing this block should degrade an answer, never block a request.
 */
export async function collectWorkspaceCapabilities(
  root: string | null,
): Promise<WorkspaceCapabilities> {
  const capabilities: WorkspaceCapabilities = {
    extensions: [],
    languageServers: [],
    formatters: [],
    toolchains: [],
    contributedCommands: [],
    invocableCommands: [],
    hasInertExtensions: false,
  };

  // Which extensions actually have a running host. An extension that ships code but has not
  // been granted consent, or has been stopped after crashing, contributes its declarative
  // data and nothing else — and the model has to be told which of the two it is looking at,
  // because "the extension is installed" and "its commands can be invoked" are different
  // facts and planning against the wrong one wastes a whole turn.
  const liveHosts = new Map<string, boolean>();
  const liveCommands: string[] = [];
  try {
    const host = await import('./marketplaceHost');
    for (const status of await host.listExtensionHosts(root)) {
      liveHosts.set(status.extensionId, status.state === 'active');
    }
    for (const entry of host.liveHostCommands()) liveCommands.push(entry.command);
  } catch (error) {
    log.debug('extension hosts unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { listInstalledExtensions } = await import('./marketplaceExtensions');
    const installed = await listInstalledExtensions(root);
    for (const extension of installed) {
      if (!extension.enabled) continue;
      const works = extension.capabilities.supported.map((point) => point.point);
      // An extension shipping an entry point can only act through a running host. Reporting
      // it as able to run code when its host is not up would be the same mistake in the other
      // direction.
      const needsHost = extension.capabilities.activation === 'requires-host';
      const canRunCode = !needsHost || liveHosts.get(extension.id) === true;
      if (needsHost && !canRunCode) capabilities.hasInertExtensions = true;
      capabilities.extensions.push({
        id: extension.id,
        displayName: extension.displayName,
        works,
        canRunCode,
      });
    }
    capabilities.invocableCommands = liveCommands;
  } catch (error) {
    log.debug('installed extensions unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  // AXIOM's own native extensions are a separate model; only enabled ones count.
  try {
    const { listExtensions } = await import('./extensions');
    for (const native of await listExtensions(root)) {
      if (native.enabled !== true) continue;
      capabilities.extensions.push({
        id: native.id,
        displayName: native.name,
        works: ['axiom-native'],
        canRunCode: false,
      });
    }
  } catch (error) {
    log.debug('native extensions unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const lsp = await import('./lsp');
    for (const server of lsp.lspServerStatuses(root)) {
      if (server.state !== 'running') continue;
      capabilities.languageServers.push({
        id: server.id,
        displayName: server.displayName,
        languageIds: server.languageIds,
      });
    }
    capabilities.formatters = lsp.lspFormattingProviders(root);
  } catch (error) {
    log.debug('language servers unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // Cached: this must not trigger a machine scan on every message.
    const { detectRuntimes } = await import('./runtimes');
    for (const runtime of await detectRuntimes()) {
      if (runtime.path === null) continue;
      capabilities.toolchains.push({
        id: runtime.id,
        displayName: runtime.displayName,
        version: runtime.version,
      });
    }
  } catch (error) {
    log.debug('toolchains unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { buildContributionCatalog } = await import('./extensionContributions');
    const catalog = await buildContributionCatalog(root);
    capabilities.contributedCommands = catalog.commands.map((command) => command.command);
  } catch (error) {
    log.debug('contributed commands unavailable for capability context', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return capabilities;
}

function bulletList(label: string, entries: readonly string[], limit: number): string[] {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, limit);
  const omitted = entries.length - shown.length;
  return [`${label}: ${shown.join(', ')}${omitted > 0 ? `, +${omitted} more` : ''}`];
}

/**
 * Render the inventory as the text block the model reads.
 *
 * Written as flat statements rather than a schema: the model has to act on this in the
 * same breath as reading code, and prose it can skim beats a structure it has to parse.
 * Returns an empty string when nothing was detected, so an empty block is never
 * attached — "no capabilities found" is noise, not grounding.
 */
export function renderCapabilities(capabilities: WorkspaceCapabilities): string {
  const lines: string[] = [];

  const runnable = capabilities.languageServers.map(
    (server) => `${server.displayName} (${server.languageIds.slice(0, 4).join('/')})`,
  );
  lines.push(...bulletList('Language servers running', runnable, MAX_LISTED_SERVERS));

  const formatters = capabilities.formatters.map((server) => server.displayName);
  if (formatters.length > 0) {
    lines.push(
      ...bulletList(
        'Formatting already available through these servers (use them; do not write a formatter)',
        formatters,
        MAX_LISTED_SERVERS,
      ),
    );
  }

  const toolchains = capabilities.toolchains.map((runtime) =>
    runtime.version ? `${runtime.displayName} ${runtime.version}` : runtime.displayName,
  );
  lines.push(...bulletList('Toolchains installed', toolchains, MAX_LISTED_TOOLCHAINS));

  const working = capabilities.extensions.filter((extension) => extension.works.length > 0);
  if (working.length > 0) {
    lines.push(
      ...bulletList(
        'Extensions installed and contributing',
        working.map((extension) => `${extension.displayName} [${extension.works.join('+')}]`),
        MAX_LISTED_EXTENSIONS,
      ),
    );
  }

  if (capabilities.invocableCommands.length > 0) {
    lines.push(
      ...bulletList(
        'Extension commands running now and safe to plan around',
        capabilities.invocableCommands,
        MAX_LISTED_COMMANDS,
      ),
    );
  }

  const declaredOnly = capabilities.contributedCommands.filter(
    (command) => !capabilities.invocableCommands.includes(command),
  );
  if (declaredOnly.length > 0) {
    lines.push(
      ...bulletList(
        'Commands declared by extensions whose host is not running (do not plan a step that invokes one)',
        declaredOnly,
        MAX_LISTED_COMMANDS,
      ),
    );
  }

  if (capabilities.hasInertExtensions) {
    lines.push(
      'Some installed extensions ship executable code that is not running — either the user has not permitted it or it was stopped. Their themes, snippets and language data still apply; their commands do not until a host is running.',
    );
  }

  if (lines.length === 0) return '';
  const body = ['Environment capabilities detected by AXIOM:', ...lines].join('\n');
  return body.length <= MAX_BLOCK_CHARS
    ? body
    : `${body.slice(0, MAX_BLOCK_CHARS)}\n… capability list truncated`;
}

/**
 * The capability block for a workspace, or an empty string when there is nothing to say.
 *
 * One call for both consumers — the chat context builder and the agent loop — so the two
 * can never describe the same environment differently.
 */
export async function buildCapabilityBlock(root: string | null): Promise<string> {
  try {
    return renderCapabilities(await collectWorkspaceCapabilities(root));
  } catch (error) {
    log.debug('capability context unavailable', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
