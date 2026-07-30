import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT_NAME, PRODUCT_TAGLINE, rootLogger } from '@axiom/shared';
import {
  IPC,
  type AiCredentialBinding,
  type AiCredentialStatus,
  type AiDiagnosticsInput,
  type AppInfo,
  type TitleBarOverlayAppearance,
  type AiConnectionScopeInput,
  type AiConversation,
  type AiConversationMutation,
  type AttachmentTextInput,
  type BuildContextInput,
  type ChatChunk,
  type ChatMessage,
  type ChatSendResult,
  type ChatUsage,
  type DebugControlAction,
  type DebugLaunchConfig,
  type DebugBreakpoint,
  type EditorSessionState,
  type ExtensionDocumentInput,
  type ExtensionProvideInput,
  type ExtensionProviderEditInput,
  type ExtensionTerminalEvent,
  type FsChangeEvent,
  type LayoutState,
  type LspApplyEditRequest,
  type LspCompletionContext,
  type LspContentChange,
  type LspDiagnostic,
  type LspDidChangeInput,
  type LspLogEvent,
  type LspRange,
  type LspServerStatus,
  type LspWorkspaceEdit,
  type SearchOptions,
  type SettingsData,
} from '../common/ipc';
import {
  createDirectory,
  createFile,
  deletePath,
  listFiles,
  movePath,
  readDirectory,
  readFile,
  renamePath,
  writeFile,
} from './services/filesystem';
import { startWatching } from './services/watcher';
import { assertWorkspaceClean, reconcileWindowDirty, setWindowDirty } from './services/dirtyWindow';
import { searchInFiles } from './services/search';
import { addRecent, clearRecents, getRecents, removeRecent } from './services/recents';
import { readClipboard, revealInOS, writeClipboard } from './services/system';
import { readKeybindings, writeKeybindings } from './services/keybindings';
import { applyProfilePreferences } from './services/profilePreferences';
import { readEditorState, writeEditorState } from './services/editorState';
import { readLayout, writeLayout } from './services/layout';
import {
  ensureSettingsFile,
  readSettings,
  readWorkspaceSettings,
  writeSettings,
  writeWorkspaceSettings,
} from './services/settings';
import { sanitizeAiHeaders } from '../common/headerSafety';
import {
  authorizeDroppedPath,
  openExtensionPackage,
  openFiles,
  openFolder,
  saveFile,
  validateFolder,
} from './services/dialog';
import {
  addDroppedAttachment,
  addTextAttachment,
  addWorkspaceAttachments,
  clearAttachmentsForOwner,
  materializeAttachments,
  pickAttachmentFiles,
  pickAttachmentFolder,
  releaseAttachments,
} from './services/attachments';
import { buildAgentUntrustedMessage } from '../common/agentPrompt';
import * as gitService from './services/git';
import * as systemGitService from './services/systemGit';
import * as githubScmService from './services/githubScm';
import * as secretsService from './services/secrets';
import * as aiService from './services/ai';
import {
  getAiDiagnostics,
  recordAiConnectionTest,
  safeAiError,
  updateAiDiagnostics,
} from './services/aiDiagnostics';
import type { ChatParams } from './services/ai';
import { parseFailoverList, providerInfo } from '../common/providers';
import { deriveRouteMeta, orderCandidates, parseRoutingPolicy } from '../common/routing';
import { parseReasoningEffort, type ReasoningConfig } from '../common/reasoning';
import { estimateCostUsd } from './services/aiPricing';
import { buildContext } from './services/contextBuilder';
import { recordSpend, getSpendSummary, clearSpend } from './services/aiSpend';
import {
  evaluateBudget,
  parseBudgetEnforcement,
  type BudgetEnforcement,
} from '../common/budgetGate';
import {
  setDebugEventSink,
  debugStart,
  debugControl,
  debugSetBreakpoints,
  debugStackTrace,
  debugScopes,
  debugVariables,
  debugEvaluate,
  debugStop,
} from './services/dap';
import { discoverDebugConfigs } from './services/debugDiscovery';
import { detectLocalModels } from './services/localModels';
import {
  MAX_WRITE_CONSENT_MS,
  ensureWriteConsentLoaded,
  getWriteConsent,
  grantWriteConsent,
  revokeWriteConsent,
  revokeWriteConsentForWorkspace,
} from './services/writeConsent';
import {
  runAgent,
  beginAgentPreflight,
  cancelAgent,
  cancelAgentForOwner,
  cancelAgentsForOwnerWorkspace,
  cancelAgentsForWorkspace,
  stageAgentApprovalScope,
  approveAgent,
  acknowledgeAgentApproval,
  getAgentNativeApprovalDescriptor,
  agentRunOwner,
  listAgentTasks,
  onAgentTaskUpdate,
  type AgentProviderAttempt,
} from './services/agent';
import { parseCommandConsentScope } from '../common/commandConsent';
import { detectRuntimes } from './services/runtimes';
import {
  hasExecutionConsent,
  loadExecutionConsent,
  setExecutionConsent,
} from './services/executionConsent';
import { activeProfileInfo } from './services/accountProfile';
import {
  buildLanguagesCatalog,
  cancelLanguageInstall,
  planLanguageInstall,
  refreshDetectionEnvironment,
  setLanguageInstallEventSink,
  startLanguageInstall,
} from './services/languageInstall';
import {
  listRuns as listAgentRuns,
  clearRuns as clearAgentRuns,
  listResumableRuns as listResumableAgentRuns,
  buildRunBranch as branchAgentRun,
  buildRunReinvoke as reinvokeAgentRun,
} from './services/agentRuns';
import { checkForUpdates } from './services/autoUpdate';
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  getUpdateSnapshot,
  onUpdateEvent,
} from './services/updateService';
import { appendAudit, readAudit, verifyAudit } from './services/audit';
import {
  listMemories,
  addMemory,
  updateMemory,
  deleteMemory,
  clearMemories,
  selectRelevant,
} from './services/memory';
import {
  getConsent,
  recordEvent,
  readBuffer as readTelemetry,
  clearBuffer as clearTelemetry,
} from './services/telemetry';
import { getAllFlags } from './services/featureFlags';
import { buildExport, saveExport } from './services/dataExport';
import { reviewCode } from './services/review';
import { composeEdits } from './services/composer';
import { completeCode, DEFAULT_COMPLETION_MODELS } from './services/completion';
import { editSelection } from './services/inlineEdit';
import { askInline } from './services/inlineChat';
import { generateCommitMessage } from './services/gitAi';
import {
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  setWorkflowEnabled,
} from './services/workflows';
import {
  listServers as mcpListServers,
  saveServer as mcpSaveServer,
  deleteServer as mcpDeleteServer,
  setServerEnabled as mcpSetServerEnabled,
  connectServer as mcpConnectServer,
  prepareMcpConnectionApproval,
  disconnectServerForWorkspace as mcpDisconnectServerForWorkspace,
  disconnectForWorkspace as mcpDisconnectForWorkspace,
  disconnectForOwner as mcpDisconnectForOwner,
  disconnectForOwnerWorkspace as mcpDisconnectForOwnerWorkspace,
  listConnections as mcpListConnections,
  callTool as mcpCallTool,
} from './services/mcp';
import { listRules, saveGlobalRule, deleteGlobalRule, proposeConventions } from './services/rules';
import { listPrompts, savePrompt, deletePrompt, recordPromptUse } from './services/promptLibrary';
import {
  listExtensions,
  setExtensionEnabled,
  getExtensionRegistry,
  getActiveExtensionHosts,
  stopExtensionsForWorkspace,
  getRegistryIndex,
  installExtension,
} from './services/extensions';
// The marketplace service exports an `installExtension` of its own for VS Code-compatible
// packages, so it is aliased rather than shadowing the native one above.
import {
  checkForUpdates as marketCheckForUpdates,
  installExtension as marketInstallExtension,
  installExtensionFromFile,
  installedExtensionDetail,
  listInstalledExtensions,
  setAutoUpdateAll,
  setExtensionAutoUpdate,
  setExtensionEnablement,
  uninstallExtension,
  updateAllExtensions,
} from './services/marketplaceExtensions';
import {
  buildContributionCatalog,
  loadContributedTheme,
  loadGrammar,
  loadIconTheme,
  loadSnippets,
} from './services/extensionContributions';
import {
  activateForTrigger,
  listExtensionHosts,
  listHostDiagnostics,
  listHostStatusBarItems,
  readHostOutput,
  reportActiveEditor,
  resolveHostPrompt,
  restartExtensionHost,
  runExtensionCommand,
  setExtensionHostConsent,
  stopExtensionHost,
  syncLanguageContributions,
  syncWorkbenchViews,
} from './services/marketplaceHost';
import {
  applyProviderWorkspaceEdit,
  cancelLanguageRequest,
  ensureLanguageContributions,
  languageRegistrySnapshot,
  provideLanguageFeature,
  reportDocumentEvent,
} from './services/extensionLanguages';
import {
  extensionTerminalList,
  extensionTerminalSpawnSpec,
  reportActiveTerminal,
  reportTerminalClosed,
  reportTerminalDimensions,
  reportTerminalInput,
  reportTerminalInteracted,
  reportTerminalOpened,
  reportTerminalShellIntegration,
} from './services/extensionTerminals';
import { extensionTaskList } from './services/extensionTasks';
import { extensionDebugConsoleLines, extensionDebugSessionList } from './services/extensionDebug';
import { notifyFileOperation } from './services/extensionFileEvents';
import {
  closeWebview,
  ensureWebviewView,
  listWebviewSnapshots,
  receiveFrameMessage,
  restorePersistedWebviews,
  revealRestoredPanel,
  setWebviewTheme,
  setWebviewVisibility,
} from './services/extensionWebview';
import {
  activateRow,
  collapseAll,
  collapseRow,
  applyWorkbenchContext,
  ensureViewRegistry,
  expandRow,
  handleTreeKey,
  resolveMenuFor,
  resolveTreeItemMenu,
  resolveTreeRow,
  resolveViewTitleMenu,
  runMenuCommand,
  selectRows,
  setActiveContainer,
  setViewCollapsed,
  setViewScroll,
  setViewSize,
  setViewVisible,
  toggleCheckbox,
  treeSnapshot,
  workbenchSnapshot,
} from './services/extensionViews';
import {
  extensionDetail as registryExtensionDetail,
  extensionDocument,
  extensionReviews,
  publisherDetail,
  registryReachable,
  searchExtensions,
  versionHistory,
} from './services/openVsxRegistry';
import { getRecoveryNotice } from './services/crashJournal';
import { getStartupReport, markDomReady } from './services/startupTiming';
import { getCompatReport } from './services/compat';
import {
  healthyChain,
  noteChainResult,
  noteChainFailure,
  getProviderHealth,
} from './services/providerHealth';
import { getStatus as getSyncStatus, snapshotSettings, flushQueue } from './services/sync';
import {
  captureFiles,
  listCheckpoints,
  restoreCheckpoint,
  restoreEntry,
  readEntryContent,
  clearSnapshots,
} from './services/snapshots';
import { serializeFileMutation } from './services/fileMutation';
import {
  assertAuthorizedPath,
  assertAuthorizedMutationPath,
  assertAuthorizedWorkspaceRoot,
  authorizedWorkspaceRootForPath,
  authorizeFilePath,
  canonicalPathIdentity,
  resolveWorkspaceRootIdentity,
} from './services/pathAuthorization';
import { stageEdits, applyEdits } from './services/safeEdit';
import type { EditKind, StagedEdit } from '../common/safeEdit';
import { parseAutonomy, type ApprovalPolicy } from '../common/approval';
import { contrastRatio } from '../common/theme';
import {
  listCustomAgents,
  saveCustomAgent,
  deleteCustomAgent,
  getCustomAgent,
} from './services/customAgents';
import { listWorkspaceAgents, shareWorkspaceAgent } from './services/workspaceAgents';
import * as aiConversationsService from './services/aiConversations';
import * as authService from './services/auth';
import * as terminalService from './services/terminal';
import {
  coreCatalogQuery,
  coreCatalogRebuild,
  coreCatalogStats,
  coreChunk,
  coreDrainForWorkspace,
  coreEmbed,
  coreGraphBuild,
  coreGraphCycles,
  coreGraphDependencies,
  coreGraphDependents,
  coreGraphImpact,
  coreProjectUnderstand,
  coreRetrieve,
  coreSearch,
  coreSymbols,
  coreUnwatch,
  coreWalk,
  coreWatch,
  onCoreNotification,
} from './services/core';
import { buildWorkspaceGraph } from './services/graphEdges';
import {
  lspCancel,
  lspCodeAction,
  lspCompletion,
  lspDeclaration,
  lspDefinition,
  lspDidChange,
  lspDidClose,
  lspDidOpen,
  lspDidSave,
  lspDocumentHighlight,
  lspDocumentLink,
  lspDocumentSymbol,
  lspExecuteCodeAction,
  lspExecuteCompletionCommand,
  lspFoldingRange,
  lspFormatting,
  lspHover,
  lspImplementation,
  lspInlayHint,
  lspOnTypeFormatting,
  lspPrepareRename,
  lspPullDiagnostics,
  lspRangeFormatting,
  lspReferences,
  lspRename,
  lspResolveCodeAction,
  lspResolveCompletion,
  lspRestartServer,
  lspResync,
  lspSelectionRange,
  lspSemanticTokens,
  lspSemanticTokensLegend,
  lspServerStatuses,
  lspSignatureHelp,
  lspTypeDefinition,
  lspWorkspaceSymbol,
  onLspApplyEdit,
  onLspDiagnostics,
  onLspLog,
  onLspServerStatus,
  disposeLspForWorkspace,
} from './services/lsp';
import {
  assertPathInTrustedWorkspace,
  assertWorkspaceTrusted,
  getWorkspaceTrust,
  markWorkspaceTrustRevoked,
  setWorkspaceTrust,
} from './services/workspaceTrust';
import type {
  ContextIntelligenceInput,
  CreateAutonomousJobInput,
  ExecuteDeploymentInput,
  JobControlInput,
  PredictionFeedback,
  PredictiveCompletionInput,
  PreviewOpenInput,
} from '../common/godMode';
import * as godModeService from './services/godMode';
import * as godModeContextService from './services/godModeContext';
import * as godModeJobsService from './services/godModeJobs';
import * as previewService from './services/preview';
import * as verificationService from './services/verification';
import * as debugEvidenceService from './services/debugEvidence';
import * as githubIssuePrService from './services/githubIssuePr';
import * as isolatedWorkspaceService from './services/isolatedWorkspaces';
import * as extensionSandboxService from './services/extensionSandbox';
import * as collaborationService from './services/collaboration';
import * as deploymentService from './services/deployment';
import {
  cancelPredictionsForOwner,
  cancelPredictionsForWorkspace,
  cancelPredictiveCompletion,
  predictionMetrics,
  recordPredictionFeedback,
  runPredictiveCompletion,
} from './services/predictiveCompletion';

const log = rootLogger.child('ipc');

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected "${name}" to be a string`);
  }
  return value;
}

/**
 * The ephemeral keys one contributed menu is resolved against.
 *
 * `view`, `viewItem`, `resourceLangId` and friends exist only for the duration of a menu, so they
 * are passed alongside the store rather than written into it. Only primitives and short string
 * arrays survive, and the prototype-pollution key names are dropped: a menu clause is evaluated
 * against a plain record, never against an object the renderer shaped.
 */
const MENU_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.:\-]{0,63}$/;
const FORBIDDEN_OVERLAY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function menuOverlay(raw: unknown): {
  viewId?: string;
  handle?: string;
  keys: Record<string, unknown>;
  args: unknown[];
} {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const keys: Record<string, unknown> = {};
  const context =
    source.keys !== null && typeof source.keys === 'object'
      ? (source.keys as Record<string, unknown>)
      : {};
  let count = 0;
  for (const [key, value] of Object.entries(context)) {
    if (count >= 24) break;
    if (!MENU_KEY_RE.test(key) || FORBIDDEN_OVERLAY_KEYS.has(key)) continue;
    if (typeof value === 'string') keys[key] = value.slice(0, 1024);
    else if (typeof value === 'number' || typeof value === 'boolean') keys[key] = value;
    else if (Array.isArray(value)) {
      keys[key] = value
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 50)
        .map((entry) => entry.slice(0, 256));
    } else continue;
    count += 1;
  }
  const args = Array.isArray(source.args)
    ? source.args
        .slice(0, 8)
        .filter(
          (entry) =>
            entry === null ||
            typeof entry === 'string' ||
            typeof entry === 'number' ||
            typeof entry === 'boolean',
        )
    : [];
  return {
    ...(typeof source.viewId === 'string' ? { viewId: source.viewId } : {}),
    ...(typeof source.handle === 'string' ? { handle: source.handle } : {}),
    keys,
    args,
  };
}

/** The workbench's own context keys, as the renderer reports them. */
function workbenchContextValues(raw: unknown): Record<string, unknown> {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (count >= 128) break;
    if (!MENU_KEY_RE.test(key) || FORBIDDEN_OVERLAY_KEYS.has(key)) continue;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      Array.isArray(value)
    ) {
      out[key] = value;
      count += 1;
    }
  }
  return out;
}

/**
 * Accept a plain object argument, rejecting arrays and primitives.
 *
 * Only the shape is asserted here; the receiving service validates and clamps every
 * field, so a renderer cannot widen a query by adding properties.
 */
function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected "${name}" to be an object`);
  }
  return value as Record<string, unknown>;
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Expected "${name}" to be a positive integer`);
  }
  return value;
}

/**
 * Shape one language-provider request from the renderer.
 *
 * Only the envelope is checked here — the feature name, the operation and every field inside `payload`
 * are validated again by the language service against the providers that actually exist, so a renderer
 * asking for a feature nobody registered gets an empty answer rather than a reachable code path.
 */
function languageProvideInput(raw: unknown): ExtensionProvideInput {
  const source = assertRecord(raw, 'request');
  return {
    requestId: assertPositiveInteger(source.requestId, 'requestId'),
    feature: assertString(source.feature, 'feature'),
    op: assertString(source.op, 'op'),
    ...(typeof source.uri === 'string' ? { uri: source.uri.slice(0, 4096) } : {}),
    ...(typeof source.handle === 'number' && Number.isInteger(source.handle)
      ? { handle: source.handle }
      : {}),
    ...(source.payload !== null &&
    typeof source.payload === 'object' &&
    !Array.isArray(source.payload)
      ? { payload: source.payload as Record<string, unknown> }
      : {}),
  };
}

/**
 * Shape one document lifecycle event from the renderer.
 *
 * The document store is the only thing standing between a provider and stale text, so versions and
 * ranges are taken as given but nothing else is: an unknown `type` is rejected outright, and the
 * incremental changes are filtered to entries that actually carry replacement text.
 */
function languageDocumentInput(raw: unknown): ExtensionDocumentInput {
  const source = assertRecord(raw, 'event');
  const type = assertString(source.type, 'type');
  if (
    type !== 'open' &&
    type !== 'change' &&
    type !== 'save' &&
    type !== 'close' &&
    type !== 'language'
  ) {
    throw new TypeError(`Unknown document event "${type}"`);
  }
  const changes = Array.isArray(source.changes)
    ? source.changes
        .slice(0, 2000)
        .filter(
          (entry): entry is { range?: LspRange; text: string } =>
            entry !== null && typeof entry === 'object' && typeof entry.text === 'string',
        )
        .map((entry) => ({
          ...(entry.range !== undefined ? { range: entry.range } : {}),
          text: entry.text,
        }))
    : undefined;
  return {
    type,
    uri: assertString(source.uri, 'uri').slice(0, 4096),
    ...(typeof source.languageId === 'string' ? { languageId: source.languageId } : {}),
    ...(typeof source.version === 'number' && Number.isInteger(source.version)
      ? { version: source.version }
      : {}),
    ...(typeof source.text === 'string' ? { text: source.text } : {}),
    ...(typeof source.isDirty === 'boolean' ? { isDirty: source.isDirty } : {}),
    ...(changes !== undefined ? { changes } : {}),
  };
}

/**
 * Shape the residue of a provider `WorkspaceEdit` the renderer handed back.
 *
 * `validateWorkspaceEdit` decides policy — which paths may be written, whether edits overlap — but it
 * trusts the *shape* of what it is given, so the shape is established here: an entry whose `kind` is
 * not one of the four operations is dropped, and a text edit without a real range and real
 * replacement text is dropped rather than written.
 */
function providerEditInput(raw: unknown): ExtensionProviderEditInput {
  const source = assertRecord(raw, 'edit');
  const raws = Array.isArray(source.entries) ? source.entries.slice(0, 512) : [];
  const entries: ExtensionProviderEditInput['entries'] = [];
  for (const value of raws) {
    if (value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.uri !== 'string' || entry.uri.length === 0) continue;
    const uri = entry.uri.slice(0, 4096);
    if (entry.kind === 'text') {
      const edits = (Array.isArray(entry.edits) ? entry.edits.slice(0, 2000) : [])
        .filter(
          (edit): edit is { range: LspRange; newText: string; insertAsSnippet?: boolean } =>
            edit !== null &&
            typeof edit === 'object' &&
            typeof edit.newText === 'string' &&
            isLspRange(edit.range),
        )
        .map((edit) => ({
          range: edit.range,
          newText: edit.newText,
          ...(edit.insertAsSnippet === true ? { insertAsSnippet: true } : {}),
        }));
      if (edits.length > 0) entries.push({ kind: 'text', uri, edits });
    } else if (entry.kind === 'create') {
      entries.push({
        kind: 'create',
        uri,
        ...(entry.overwrite === true ? { overwrite: true } : {}),
        ...(entry.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
        ...(typeof entry.contents === 'string' ? { contents: entry.contents } : {}),
      });
    } else if (entry.kind === 'rename') {
      if (typeof entry.newUri !== 'string' || entry.newUri.length === 0) continue;
      entries.push({
        kind: 'rename',
        uri,
        newUri: entry.newUri.slice(0, 4096),
        ...(entry.overwrite === true ? { overwrite: true } : {}),
        ...(entry.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
      });
    } else if (entry.kind === 'delete') {
      entries.push({
        kind: 'delete',
        uri,
        ...(entry.recursive === true ? { recursive: true } : {}),
        ...(entry.ignoreIfNotExists === true ? { ignoreIfNotExists: true } : {}),
      });
    }
  }
  return { entries };
}

const TERMINAL_EVENT_KINDS: ReadonlySet<string> = new Set<ExtensionTerminalEvent['kind']>([
  'opened',
  'closed',
  'input',
  'dimensions',
  'active',
  'interacted',
  'shell',
]);

/**
 * Shape one terminal event the renderer is reporting for a pane it adopted (PRD Phase 7 §1).
 *
 * The renderer is the only thing that knows a pane opened, was typed into or was closed, so it is
 * the source of these — but it is also the untrusted side, so the handle, the kind and every
 * numeric field are re-checked here. A handle that names a terminal the reporting extension does
 * not own is rejected downstream by the terminal registry, not here: main holds the ownership map.
 */
function terminalEventInput(raw: unknown): ExtensionTerminalEvent {
  const source = assertRecord(raw, 'event');
  const kind = assertString(source.kind, 'kind');
  if (!TERMINAL_EVENT_KINDS.has(kind)) {
    throw new TypeError(`Expected "kind" to be a terminal event kind, got "${kind.slice(0, 32)}"`);
  }
  const dimension = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 5_000
      ? value
      : undefined;
  const columns = dimension(source.columns);
  const rows = dimension(source.rows);
  return {
    kind: kind as ExtensionTerminalEvent['kind'],
    // `active` reports a session id, not a handle: the pane that gained focus may belong to no
    // extension at all, which is exactly the case that has to reach the terminal that lost it.
    handle:
      typeof source.handle === 'number' && Number.isInteger(source.handle) && source.handle > 0
        ? source.handle
        : 0,
    ...(typeof source.sessionId === 'string' ? { sessionId: source.sessionId.slice(0, 128) } : {}),
    ...(typeof source.processId === 'number' && Number.isInteger(source.processId)
      ? { processId: source.processId }
      : {}),
    ...(typeof source.exitCode === 'number' && Number.isInteger(source.exitCode)
      ? { exitCode: source.exitCode }
      : {}),
    ...(typeof source.data === 'string' ? { data: source.data.slice(0, 64 * 1024) } : {}),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    ...(source.available === true ? { available: true } : {}),
  };
}

/** A position pair with integer, non-negative line and character, which is all a range may be. */
function isLspRange(value: unknown): value is LspRange {
  if (value === null || typeof value !== 'object') return false;
  const range = value as { start?: unknown; end?: unknown };
  return isLspPosition(range.start) && isLspPosition(range.end);
}

function isLspPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const position = value as { line?: unknown; character?: unknown };
  return (
    typeof position.line === 'number' &&
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    typeof position.character === 'number' &&
    Number.isInteger(position.character) &&
    position.character >= 0
  );
}

/**
 * Tell every open window that the installed extension set changed.
 *
 * Installing from one window has to update the manager in another, and it also has to
 * update whatever is showing contributed themes or icons. Broadcasting one change event
 * and letting each surface re-read is simpler and less prone to drift than trying to
 * deliver a diff.
 */
function notifyMarketplaceChanged(origin: WebContents): void {
  // What an extension contributes to the workbench changes with it: an install adds containers and
  // views, a disable takes them away. Rebuilding here means every path that already tells the
  // renderer "the marketplace changed" also refreshes the sidebar.
  void syncWorkbenchViews();
  // Same reason for languages: an install can add a language and its configuration, a disable takes
  // them away. Monaco has to be told before the next document of that language opens.
  void syncLanguageContributions();
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (!contents.isDestroyed()) contents.send(IPC.marketChanged);
  }
  if (!origin.isDestroyed() && BrowserWindow.fromWebContents(origin) === null) {
    // A sender without a window (a detached view) still needs the event.
    origin.send(IPC.marketChanged);
  }
}

async function authorizedWorkspaceRoot(value: unknown, name = 'root'): Promise<string> {
  return assertAuthorizedWorkspaceRoot(assertString(value, name));
}

async function trustedWorkspaceRoot(value: unknown, name = 'root'): Promise<string> {
  return assertWorkspaceTrusted(assertString(value, name));
}

function workspacePathKey(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function sameWorkspaceRoot(a: string, b: string): boolean {
  return workspacePathKey(a) === workspacePathKey(b);
}

function lspDocumentKey(uri: string): string {
  try {
    return workspacePathKey(fileURLToPath(uri));
  } catch {
    return process.platform === 'win32' ? uri.toLowerCase() : uri;
  }
}

async function authorizedPath(
  value: unknown,
  name = 'path',
  options: { allowMissing?: boolean; directory?: boolean } = {},
): Promise<string> {
  return assertAuthorizedPath(assertString(value, name), options);
}

async function authorizedDocumentUri(value: unknown): Promise<string> {
  const uri = assertString(value, 'uri');
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    throw new Error('Only authorized file:// document URIs are supported.');
  }
  const canonical = await assertAuthorizedPath(filePath, { allowMissing: true });
  return pathToFileURL(canonical).toString();
}

async function trustedDocumentUri(root: string, value: unknown): Promise<string> {
  const uri = assertString(value, 'uri');
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    throw new Error('Only trusted file:// document URIs are supported.');
  }
  const canonical = await assertPathInTrustedWorkspace(root, filePath, { allowMissing: true });
  return pathToFileURL(canonical).toString();
}

async function authorizedOptionalWorkspaceRoot(value: unknown): Promise<string | null> {
  return typeof value === 'string' ? authorizedWorkspaceRoot(value) : null;
}

async function authorizedWorkspaceTarget(
  rootValue: unknown,
  pathValue: unknown,
  options: { allowMissing?: boolean } = {},
): Promise<{ root: string; path: string; relativePath: string }> {
  const root = await authorizedWorkspaceRoot(rootValue);
  const requested = assertString(pathValue, 'path');
  const path = await assertAuthorizedPath(resolve(root, requested), options);
  const relativePath = relative(root, path).replace(/\\/g, '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Expected a path inside the authorized workspace: ${requested}`);
  }
  return { root, path, relativePath };
}

async function trustedGitTarget(
  rootValue: unknown,
  pathValue: unknown,
  options: { allowMissing?: boolean } = {},
): Promise<{ root: string; path: string; relativePath: string }> {
  const root = await trustedWorkspaceRoot(rootValue);
  const requested = assertString(pathValue, 'path');
  const path = await assertAuthorizedMutationPath(resolve(root, requested), options);
  const relativePath = relative(root, path).replace(/\\/g, '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Expected a Git path inside the trusted workspace: ${requested}`);
  }
  return { root, path, relativePath };
}

async function authorizeStagedEdits(root: string, edits: StagedEdit[]): Promise<StagedEdit[]> {
  return Promise.all(
    edits.map(async (edit): Promise<StagedEdit> => ({
      ...edit,
      path: await assertPathInTrustedWorkspace(root, edit.path, {
        allowMissing: edit.kind === 'create',
      }),
    })),
  );
}

async function revalidateStagedEdits(root: string, edits: StagedEdit[]): Promise<void> {
  await assertWorkspaceTrusted(root);
  for (const edit of edits) {
    const currentPath = await assertPathInTrustedWorkspace(root, edit.path, {
      allowMissing: edit.kind === 'create',
    });
    if (workspacePathKey(currentPath) !== workspacePathKey(edit.path)) {
      throw new Error('A Safe Edit target changed through a link after validation.');
    }
  }
}

function toAiCredentialBinding(value: unknown): AiCredentialBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected "binding" to be an AI credential binding');
  }
  const binding = value as Record<string, unknown>;
  return {
    provider: assertString(binding.provider, 'binding.provider'),
    baseUrl: assertString(binding.baseUrl, 'binding.baseUrl'),
  };
}

/** Coerces untrusted renderer input into a well-formed SearchOptions (booleans only). */
function toSearchOptions(value: unknown): SearchOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    caseSensitive: v.caseSensitive === true,
    wholeWord: v.wholeWord === true,
    regex: v.regex === true,
  };
}

/** Coerce untrusted renderer input into a well-formed LSP range (0-based). */
function toLspRange(value: unknown): LspRange {
  const o = (value ?? {}) as Record<string, unknown>;
  const s = (o.start ?? {}) as Record<string, unknown>;
  const e = (o.end ?? {}) as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
  return {
    start: { line: num(s.line), character: num(s.character) },
    end: { line: num(e.line), character: num(e.character) },
  };
}

/** Upper bounds on one incremental sync batch, so a renderer cannot flood Main. */
const MAX_CONTENT_CHANGES = 4_096;
const MAX_CONTENT_CHANGE_BYTES = 8 * 1024 * 1024;

/**
 * Coerce untrusted incremental content changes. A change is kept only when it is
 * structurally valid; anything malformed collapses the batch to empty so the
 * document is resynced rather than desynced.
 */
function toLspContentChanges(value: unknown): LspContentChange[] {
  if (!Array.isArray(value) || value.length > MAX_CONTENT_CHANGES) return [];
  const out: LspContentChange[] = [];
  let bytes = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const o = entry as Record<string, unknown>;
    if (typeof o.text !== 'string') return [];
    bytes += o.text.length;
    if (bytes > MAX_CONTENT_CHANGE_BYTES) return [];
    const change: LspContentChange = { text: o.text };
    if (o.range !== undefined) {
      change.range = toLspRange(o.range);
      if (typeof o.rangeLength === 'number' && o.rangeLength >= 0) {
        change.rangeLength = o.rangeLength;
      }
    }
    out.push(change);
  }
  return out;
}

/** Coerce an untrusted completion context (LSP CompletionTriggerKind 1–3). */
function toLspCompletionContext(value: unknown): LspCompletionContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const kind = typeof o.triggerKind === 'number' ? o.triggerKind : 1;
  const context: LspCompletionContext = { triggerKind: kind === 2 || kind === 3 ? kind : 1 };
  if (typeof o.triggerCharacter === 'string' && o.triggerCharacter.length === 1) {
    context.triggerCharacter = o.triggerCharacter;
  }
  return context;
}

/** Coerce an untrusted Main-side resolve handle. */
function toLspHandle(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

/**
 * Build the cancellation key for a request. Scoping it to the sender means one
 * renderer can never cancel another renderer's in-flight language requests.
 */
function lspCancelKey(sender: WebContents, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return `${sender.id}\u0000${value}`;
}

/** Restrict the code-action `only` filter to the kinds AXIOM advertises. */
const CODE_ACTION_KINDS = new Set([
  '',
  'quickfix',
  'refactor',
  'refactor.extract',
  'refactor.inline',
  'refactor.rewrite',
  'source',
  'source.organizeImports',
  'source.fixAll',
]);

function toCodeActionOnly(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  const kinds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !CODE_ACTION_KINDS.has(entry)) return undefined;
    kinds.push(entry);
  }
  return kinds;
}

/** Ensures persisted settings are a plain object (never an array/scalar). */
function toSettingsData(value: unknown): SettingsData {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as SettingsData;
  }
  return {};
}

function assertSettingsData(value: unknown, name: string): SettingsData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected "${name}" to be a settings object`);
  }
  return value as SettingsData;
}

/**
 * Main-authoritative hard budget stop.
 *
 * The daily budget and its enforcement mode live in user settings, and the spend
 * ledger lives in Main, so Main is the only place that can refuse consistently for
 * every surface that starts expensive work. Throws only when enforcement is
 * 'block' and the budget is already exceeded; 'warn' and 'off' are advisory.
 *
 * Fails OPEN on a settings/ledger read error: a bookkeeping problem must not make
 * the product unusable, and the renderer still shows the live figure.
 */
async function assertAiSpendWithinBudget(): Promise<void> {
  let todayUsd = 0;
  let budgetUsd = 0;
  let enforcement: BudgetEnforcement = 'warn';
  try {
    const [settings, spend] = await Promise.all([readSettings(), getSpendSummary()]);
    const record = settings as Record<string, unknown>;
    budgetUsd = typeof record['ai.dailyBudgetUsd'] === 'number' ? record['ai.dailyBudgetUsd'] : 0;
    enforcement = parseBudgetEnforcement(record['ai.budgetEnforcement']);
    todayUsd = spend.todayUsd;
  } catch {
    return;
  }
  const gate = evaluateBudget({ todayUsd, budgetUsd, enforcement });
  if (gate.decision === 'block') {
    throw new Error(
      `${gate.reason} Raise the daily budget or change enforcement in the spend panel to continue.`,
    );
  }
}

/** Coerces untrusted headers and rejects credential-bearing setting names. */
function toHeaderMap(value: unknown): Record<string, string> {
  const result = sanitizeAiHeaders(value);
  if (result.rejectedNames.length > 0) {
    throw new Error(
      `Credential-bearing custom headers are not allowed (${result.rejectedNames.join(', ')}). ` +
        'Use the provider API Key field instead.',
    );
  }
  return result.headers;
}

/** Coerces untrusted chat input into a well-formed message list. */
function toChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const role = o.role;
    const content = o.content;
    if (
      (role === 'system' || role === 'user' || role === 'assistant') &&
      typeof content === 'string'
    ) {
      out.push({ role, content });
    }
  }
  return out;
}

function toAttachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error('Chat attachment ids must be an array of at most 16 entries.');
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !/^[0-9a-f-]{36}$/i.test(item)) {
      throw new Error('A chat attachment id is invalid.');
    }
    return item;
  });
}

/** In-flight chat streams, keyed by request id and bound to one renderer owner. */
interface ActiveChatRequest {
  ownerId: number;
  controller: AbortController;
}

const chatAborts = new Map<string, ActiveChatRequest>();
const chatCancellationTombstones = new Map<number, Map<string, number>>();
const CANCELLATION_TTL_MS = 5 * 60_000;
const MAX_CANCELLATION_TOMBSTONES_PER_OWNER = 128;

function pruneChatCancellationTombstones(): void {
  const cutoff = Date.now() - CANCELLATION_TTL_MS;
  for (const [ownerId, tombstones] of chatCancellationTombstones) {
    for (const [id, createdAt] of tombstones) {
      if (createdAt < cutoff) tombstones.delete(id);
    }
    while (tombstones.size > MAX_CANCELLATION_TOMBSTONES_PER_OWNER) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      tombstones.delete(oldest);
    }
    if (tombstones.size === 0) chatCancellationTombstones.delete(ownerId);
  }
}

function rememberChatCancellation(ownerId: number, id: string): void {
  pruneChatCancellationTombstones();
  let tombstones = chatCancellationTombstones.get(ownerId);
  if (!tombstones) {
    tombstones = new Map();
    chatCancellationTombstones.set(ownerId, tombstones);
  }
  tombstones.delete(id);
  tombstones.set(id, Date.now());
  pruneChatCancellationTombstones();
}

function takeChatCancellation(ownerId: number, id: string): boolean {
  pruneChatCancellationTombstones();
  const tombstones = chatCancellationTombstones.get(ownerId);
  if (!tombstones?.delete(id)) return false;
  if (tombstones.size === 0) chatCancellationTombstones.delete(ownerId);
  return true;
}

function clearChatCancellation(ownerId: number, id: string): void {
  const tombstones = chatCancellationTombstones.get(ownerId);
  if (!tombstones) return;
  tombstones.delete(id);
  if (tombstones.size === 0) chatCancellationTombstones.delete(ownerId);
}

function normalizeScopeRoot(value: string | null): string {
  const normalized = (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Issue an opaque scope for conversation persistence. The hash binds a thread to
 * its workspace, effective authorized endpoint, ordinary headers, routing chain,
 * and opaque credential revisions without exposing key material to the renderer.
 */
async function resolveAiConnectionScope(raw: unknown): Promise<string> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const input: AiConnectionScopeInput = {
    provider: assertString(o.provider, 'provider'),
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
    headers: toHeaderMap(o.headers),
    workspaceRoot: typeof o.workspaceRoot === 'string' ? o.workspaceRoot : null,
  };
  const primary = await secretsService.resolveAiCredential(input.provider, input.baseUrl);
  const settings = (await readSettings()) as Record<string, unknown>;
  const fallbackProviders = parseFailoverList(settings['ai.fallbackProviders']).filter(
    (provider, index, all) => provider !== input.provider && all.indexOf(provider) === index,
  );
  const fallbacks: Array<{
    provider: string;
    baseUrl: string;
    headers: Array<readonly [string, string]>;
    credentialRevision: string;
  }> = [];
  for (const provider of fallbackProviders) {
    const info = providerInfo(provider);
    if (!info) continue;
    try {
      const requestedBaseUrl =
        provider === 'custom' && typeof settings['ai.custom.baseUrl'] === 'string'
          ? settings['ai.custom.baseUrl']
          : info.defaultBaseUrl;
      const headers =
        provider === 'custom'
          ? toHeaderMap(
              JSON.parse(
                typeof settings['ai.custom.headers'] === 'string' &&
                  settings['ai.custom.headers'].trim()
                  ? settings['ai.custom.headers']
                  : '{}',
              ),
            )
          : {};
      const credential = await secretsService.resolveAiCredential(provider, requestedBaseUrl);
      fallbacks.push({
        provider,
        baseUrl: credential.baseUrl,
        headers: Object.entries(headers)
          .map(([name, value]) => [name.toLowerCase(), value] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
        credentialRevision: credential.revision,
      });
    } catch {
      // Optional fallback credentials that are absent or endpoint-ineligible are omitted.
    }
  }
  const identity = {
    version: 2,
    workspace: normalizeScopeRoot(input.workspaceRoot),
    primary: {
      provider: input.provider,
      baseUrl: primary.baseUrl,
      headers: Object.entries(input.headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
      credentialRevision: primary.revision,
    },
    routingPolicy: parseRoutingPolicy(settings['ai.routingPolicy']),
    fallbacks,
  };
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `scope:v2:${digest}`;
}

/**
 * Resolve a Custom-provider probe. A key supplied by the renderer may be sent to
 * the explicitly entered valid endpoint; an empty key can use Main's stored key
 * only through the endpoint-binding resolver. No stored key remains keyless.
 */
async function toCustomProbeCreds(raw: unknown): Promise<{
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
}> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const requestedBaseUrl = assertString(o.baseUrl, 'baseUrl');
  const suppliedApiKey = typeof o.apiKey === 'string' ? o.apiKey : '';
  const headers = toHeaderMap(o.headers);
  // A model id is only ever echoed back to the same endpoint, so bound its shape
  // rather than trusting renderer input verbatim in a request body.
  const requestedModel = typeof o.model === 'string' ? o.model.trim() : '';
  if (requestedModel.length > 200 || /[\u0000-\u001f\u007f]/.test(requestedModel)) {
    throw new Error('The model id is invalid.');
  }
  if (suppliedApiKey.trim().length > 0) {
    return {
      baseUrl: secretsService.normalizeAiBaseUrl('custom', requestedBaseUrl),
      apiKey: suppliedApiKey,
      headers,
      model: requestedModel,
    };
  }
  const credential = await secretsService.resolveAiCredential('custom', requestedBaseUrl);
  return {
    baseUrl: credential.baseUrl,
    apiKey: credential.apiKey,
    headers,
    model: requestedModel,
  };
}

/**
 * Resolve the same optional failover providers Ask uses, for a Build/agent run.
 *
 * Build previously issued a single provider call, so a failing, rate-limited, or
 * circuit-open primary broke every agent while Ask recovered transparently. Each
 * attempt resolves its OWN endpoint + credential; a fallback never inherits the
 * primary's key, and an unusable fallback is skipped rather than masking a real
 * primary authorization error.
 */
async function resolveAgentFallbackAttempts(
  primaryProvider: string,
  primaryModel: string,
  settings: Record<string, unknown>,
): Promise<AgentProviderAttempt[]> {
  const attempts: AgentProviderAttempt[] = [];
  for (const id of parseFailoverList(settings['ai.fallbackProviders'])) {
    if (id === primaryProvider) continue;
    const info = providerInfo(id);
    if (!info) continue;
    try {
      const requestedBaseUrl =
        id === 'custom' && typeof settings['ai.custom.baseUrl'] === 'string'
          ? settings['ai.custom.baseUrl']
          : info.defaultBaseUrl;
      const headers =
        id === 'custom'
          ? toHeaderMap(
              JSON.parse(
                typeof settings['ai.custom.headers'] === 'string' &&
                  settings['ai.custom.headers'].trim()
                  ? settings['ai.custom.headers']
                  : '{}',
              ),
            )
          : {};
      const credential = await secretsService.resolveAiCredential(id, requestedBaseUrl);
      const customModel =
        id === 'custom' && typeof settings['ai.custom.model'] === 'string'
          ? settings['ai.custom.model'].trim()
          : '';
      attempts.push({
        provider: id,
        model: customModel || info.defaultModels[0] || primaryModel,
        baseUrl: credential.baseUrl,
        headers,
        apiKey: credential.apiKey,
        credentialRevision: credential.revision,
      });
    } catch {
      // Optional fallbacks that are absent or endpoint-ineligible are omitted.
    }
  }
  return attempts;
}

/**
 * Main-owned confirmation for a privileged action.
 *
 * `preauthorizable` marks the call sites whose question the user has ALREADY answered
 * inside AXIOM — the Build approval card shows the same exact diff or command, with
 * the same digest, and requires a click. For those, asking a second time in an
 * OS-drawn dialog added no information: it repeated the question, and cancelling it
 * left the action permanently rejected with no way to retry. When the user granted
 * Build execution consent (at install time, or in Settings), those call sites settle
 * on the in-app decision alone.
 *
 * Everything else still gets the dialog, and every payload — pre-authorized or not —
 * is still bounds-checked and digested for the audit trail.
 */
async function requireNativeGodModeApproval(
  sender: WebContents,
  requested: unknown,
  title: string,
  message: string,
  detail: string,
  options: { preauthorizable?: boolean } = {},
): Promise<void> {
  if (requested !== true) throw new Error(`${message} requires explicit confirmation.`);
  const ownerWindow = BrowserWindow.fromWebContents(sender);
  if (!ownerWindow || ownerWindow.isDestroyed() || sender.isDestroyed()) {
    throw new Error('Approval requires an active owner window.');
  }
  if (
    detail.length === 0 ||
    detail.length > 12_000 ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(detail)
  ) {
    throw new Error('The exact approval payload cannot be displayed safely.');
  }
  const approvalDigest = createHash('sha256').update(detail, 'utf-8').digest('hex');
  if (options.preauthorizable === true && (await hasExecutionConsent())) {
    log.info('Action settled by granted Build execution consent', {
      title,
      sha256: approvalDigest,
    });
    return;
  }
  const safeDetail = `${detail}\n\nExact approval SHA-256: ${approvalDigest}`;
  const result = await dialog.showMessageBox(ownerWindow, {
    type: 'warning',
    title,
    message,
    detail: safeDetail,
    buttons: ['Approve once', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0 || sender.isDestroyed()) {
    throw new Error(`${message} was not approved.`);
  }
}

/**
 * Registers allow-listed IPC handlers in the trusted Main process.
 * PRD Part II §14.3: every channel is explicit and input-validated; no secrets
 * are returned (INV-3).
 */
export function registerIpcHandlers(): void {
  type DebugBinding = { root: string; owner: WebContents };
  type LspBinding = { root: string; owner: WebContents; uri: string };
  type AgentBinding = { root: string | null; owner: WebContents };
  type ContextBinding = {
    ownerId: number;
    root: string | null;
    controller: AbortController;
  };

  let debugBinding: DebugBinding | null = null;
  const lspBindings = new Map<string, LspBinding>();
  const lspBoundOwners = new WeakSet<WebContents>();
  const mcpBoundOwners = new WeakSet<WebContents>();
  const agentBindings = new Map<string, AgentBinding>();
  const contextBindings = new Set<ContextBinding>();
  const attachmentBoundOwners = new WeakSet<WebContents>();
  const githubBoundOwners = new WeakSet<WebContents>();
  const completionBoundOwners = new WeakSet<WebContents>();
  const collaborationBoundOwners = new WeakSet<WebContents>();
  const isolatedBoundOwners = new WeakSet<WebContents>();
  const coreWatchOwners = new Map<string, { root: string; owners: Set<WebContents> }>();
  const coreWatchBoundOwners = new WeakSet<WebContents>();

  const removeCoreWatchOwner = (owner: WebContents): void => {
    for (const [key, binding] of coreWatchOwners) {
      binding.owners.delete(owner);
      if (binding.owners.size > 0) continue;
      coreWatchOwners.delete(key);
      void coreUnwatch(binding.root).catch(() => undefined);
    }
  };

  const bindCoreWatchOwner = (owner: WebContents): void => {
    if (coreWatchBoundOwners.has(owner)) return;
    coreWatchBoundOwners.add(owner);
    owner.once('destroyed', () => removeCoreWatchOwner(owner));
  };

  const closeCoreWatchesForWorkspace = async (root: string): Promise<void> => {
    const key = workspacePathKey(root);
    const binding = coreWatchOwners.get(key);
    if (!binding) return;
    coreWatchOwners.delete(key);
    await coreUnwatch(binding.root).catch(() => undefined);
  };

  const bindIsolatedOwner = (owner: WebContents): void => {
    if (isolatedBoundOwners.has(owner)) return;
    isolatedBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () =>
      isolatedWorkspaceService.cancelIsolatedOperationsForOwner(ownerId),
    );
  };

  const bindCollaborationOwner = (owner: WebContents): void => {
    if (collaborationBoundOwners.has(owner)) return;
    collaborationBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () => collaborationService.cancelCollaborationCloudForOwner(ownerId));
  };

  const bindCompletionOwner = (owner: WebContents): void => {
    if (completionBoundOwners.has(owner)) return;
    completionBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () => cancelPredictionsForOwner(ownerId));
  };

  const bindAttachmentOwner = (owner: WebContents): void => {
    if (attachmentBoundOwners.has(owner)) return;
    attachmentBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () => clearAttachmentsForOwner(ownerId));
  };

  const bindGithubOwner = (owner: WebContents): void => {
    if (githubBoundOwners.has(owner)) return;
    githubBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () => {
      githubScmService.cancelGithubFlowsForOwner(ownerId);
      githubIssuePrService.cancelGithubWorkspaceOperationsForOwner(ownerId);
    });
  };

  const gitProgressFor =
    (owner: WebContents): systemGitService.GitProgressSink =>
    (progress) => {
      if (!owner.isDestroyed()) owner.send(IPC.gitProgress, progress);
    };

  const bindMcpOwner = (owner: WebContents): void => {
    if (mcpBoundOwners.has(owner)) return;
    mcpBoundOwners.add(owner);
    const ownerId = owner.id;
    owner.once('destroyed', () => {
      void mcpDisconnectForOwner(ownerId).catch((error: unknown) => {
        log.warn('MCP owner cleanup failed', {
          ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  };

  const closeLspBinding = (key: string, binding: LspBinding): void => {
    if (lspBindings.get(key) !== binding) return;
    lspBindings.delete(key);
    lspDidClose(binding.uri);
    if (![...lspBindings.values()].some((item) => sameWorkspaceRoot(item.root, binding.root))) {
      void disposeLspForWorkspace(binding.root).catch((error: unknown) => {
        log.warn('Idle LSP workspace cleanup failed', {
          root: binding.root,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const closeLspBindingsForOwner = (owner: WebContents): void => {
    for (const [key, binding] of lspBindings) {
      if (binding.owner === owner) closeLspBinding(key, binding);
    }
  };

  const closeLspBindingsForWorkspace = (root: string): void => {
    for (const [key, binding] of lspBindings) {
      if (sameWorkspaceRoot(binding.root, root)) closeLspBinding(key, binding);
    }
  };

  const cancelContextBuildsForWorkspace = (root: string): void => {
    for (const binding of contextBindings) {
      if (binding.root && sameWorkspaceRoot(binding.root, root)) binding.controller.abort();
    }
  };

  const requireActiveDebug = async (owner: WebContents): Promise<DebugBinding> => {
    const binding = debugBinding;
    if (!binding) throw new Error('No debug session is active.');
    if (binding.owner !== owner) throw new Error('Debug session is owned by another renderer.');
    await assertWorkspaceTrusted(binding.root);
    if (debugBinding !== binding) throw new Error('No debug session is active.');
    return binding;
  };

  const requireActiveLspDocument = async (
    owner: WebContents,
    value: unknown,
  ): Promise<LspBinding> => {
    const uri = await authorizedDocumentUri(value);
    const key = lspDocumentKey(uri);
    const binding = lspBindings.get(key);
    if (!binding) throw new Error('The document is not open in a language server.');
    if (binding.owner !== owner) throw new Error('LSP document is owned by another renderer.');
    const trustedUri = await trustedDocumentUri(binding.root, binding.uri);
    if (lspDocumentKey(trustedUri) !== key || lspBindings.get(key) !== binding) {
      throw new Error('The LSP document binding is no longer valid.');
    }
    return binding;
  };

  ipcMain.handle(IPC.appGetInfo, (): AppInfo => {
    return {
      name: PRODUCT_NAME,
      tagline: PRODUCT_TAGLINE,
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
    };
  });

  ipcMain.handle(IPC.appSetDirty, async (event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Expected a dirty workspace state object.');
    }
    const value = input as { root?: unknown; dirty?: unknown };
    if (typeof value.dirty !== 'boolean') {
      throw new TypeError('Expected "dirty" to be a boolean');
    }
    if (value.root !== null && typeof value.root !== 'string') {
      throw new TypeError('Expected "root" to be a workspace path or null');
    }
    const requestedRoot = typeof value.root === 'string' ? value.root : null;
    // Record the same-renderer workspace identity before the first await so a
    // later approval IPC cannot interleave ahead of the dirty mutation guard.
    const provisional = setWindowDirty(event.sender.id, requestedRoot, value.dirty);
    if (provisional.becameDirty && requestedRoot) {
      cancelAgentsForOwnerWorkspace(event.sender.id, requestedRoot);
    }
    const canonicalRoot = requestedRoot ? await resolveWorkspaceRootIdentity(requestedRoot) : null;
    const transition = reconcileWindowDirty(event.sender.id, provisional.generation, canonicalRoot);
    if (transition?.becameDirty && canonicalRoot) {
      cancelAgentsForOwnerWorkspace(event.sender.id, canonicalRoot);
    }
  });

  ipcMain.handle(IPC.windowSetTitleBarOverlay, (event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Expected a titlebar appearance object.');
    }
    const raw = input as Partial<TitleBarOverlayAppearance>;
    const opaqueHex = /^#[0-9a-fA-F]{6}$/;
    if (
      typeof raw.color !== 'string' ||
      typeof raw.symbolColor !== 'string' ||
      !opaqueHex.test(raw.color) ||
      !opaqueHex.test(raw.symbolColor)
    ) {
      throw new TypeError('Titlebar colors must be opaque six-digit hex values.');
    }
    if (contrastRatio(raw.symbolColor, raw.color) < 4.5) {
      throw new Error('Titlebar symbol contrast must meet WCAG AA (4.5:1).');
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      throw new Error('Titlebar appearance requires an active owner window.');
    }
    if (process.platform === 'darwin') return;
    ownerWindow.setTitleBarOverlay({
      color: raw.color,
      symbolColor: raw.symbolColor,
      height: 40,
    });
  });

  ipcMain.handle(IPC.workspaceTrustGet, (_event, root: unknown) =>
    getWorkspaceTrust(assertString(root, 'root')),
  );

  ipcMain.handle(IPC.workspaceTrustSet, async (event, root: unknown, trusted: unknown) => {
    if (typeof trusted !== 'boolean') {
      throw new TypeError('Expected "trusted" to be a boolean');
    }
    const canonicalRoot = await assertAuthorizedWorkspaceRoot(assertString(root, 'root'));
    if (trusted) {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        throw new Error('Workspace trust requires an active Axiom window.');
      }
      const confirmation = await dialog.showMessageBox(ownerWindow, {
        type: 'warning',
        title: 'Trust Workspace',
        message: 'Do you trust the authors of the files in this folder?',
        detail: `${canonicalRoot}\n\nTrusted workspaces may run terminals, tasks, agents, debuggers, language servers, extensions, and MCP servers.`,
        buttons: ['Trust Workspace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0 || event.sender.isDestroyed()) {
        return getWorkspaceTrust(canonicalRoot);
      }
      return setWorkspaceTrust(canonicalRoot, true);
    }

    markWorkspaceTrustRevoked(canonicalRoot);
    let state: Awaited<ReturnType<typeof setWorkspaceTrust>> | undefined;
    let persistenceFailed = false;
    let persistenceError: unknown;
    try {
      state = await setWorkspaceTrust(canonicalRoot, false);
    } catch (error) {
      persistenceFailed = true;
      persistenceError = error;
    }

    // Revocation cleanup is intentionally trust-independent and all teardown
    // paths are attempted even if persistence or another cleanup operation fails.
    const cleanupResults = await Promise.allSettled([
      Promise.resolve().then(() => terminalService.killForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => closeLspBindingsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => disposeLspForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => cancelAgentsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => mcpDisconnectForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => stopExtensionsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => previewService.closePreviewsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() =>
        verificationService.cancelVerificationsForWorkspace(canonicalRoot),
      ),
      Promise.resolve().then(() =>
        isolatedWorkspaceService.cancelIsolatedCommandsForWorkspace(canonicalRoot),
      ),
      Promise.resolve().then(() =>
        isolatedWorkspaceService.cancelIsolatedOperationsForWorkspace(canonicalRoot),
      ),
      Promise.resolve().then(() =>
        extensionSandboxService.terminateExtensionSandboxesForWorkspace(canonicalRoot),
      ),
      Promise.resolve().then(() => deploymentService.stopDeploymentsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => cancelContextBuildsForWorkspace(canonicalRoot)),
      // Batch write consent can never outlive the trust that justified it.
      Promise.resolve().then(() => revokeWriteConsentForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => cancelPredictionsForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => closeCoreWatchesForWorkspace(canonicalRoot)),
      Promise.resolve().then(() => coreDrainForWorkspace(canonicalRoot)),
      Promise.resolve().then(() =>
        collaborationService.cancelCollaborationCloudForWorkspace(canonicalRoot),
      ),
      Promise.resolve().then(() =>
        githubIssuePrService.cancelGithubWorkspaceOperationsForRoot(canonicalRoot),
      ),
      Promise.resolve().then(async () => {
        if (!debugBinding || !sameWorkspaceRoot(debugBinding.root, canonicalRoot)) return;
        debugBinding = null;
        setDebugEventSink(() => undefined);
        await debugStop();
      }),
    ]);
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      log.warn('workspace revocation cleanup failed', {
        root: canonicalRoot,
        errors: cleanupErrors.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    if (persistenceFailed) throw persistenceError;
    if (cleanupErrors.length > 0) {
      const error = cleanupErrors[0];
      throw error instanceof Error ? error : new Error(String(error));
    }
    return state ?? { root: canonicalRoot, trusted: false };
  });

  ipcMain.handle(IPC.dialogOpenFolder, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    return openFolder(owner);
  });

  ipcMain.handle(IPC.dialogOpenFiles, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return [];
    return openFiles(owner);
  });

  ipcMain.handle(IPC.dialogAuthorizeDroppedPath, (_event, path: unknown) =>
    authorizeDroppedPath(assertString(path, 'path')),
  );

  ipcMain.handle(IPC.dialogSaveFile, (event, defaultName: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    return saveFile(typeof defaultName === 'string' ? defaultName : undefined, owner);
  });

  ipcMain.handle(IPC.attachmentPickFiles, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return [];
    bindAttachmentOwner(event.sender);
    return pickAttachmentFiles(owner, event.sender.id);
  });

  ipcMain.handle(IPC.attachmentPickFolder, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    bindAttachmentOwner(event.sender);
    return pickAttachmentFolder(owner, event.sender.id);
  });

  ipcMain.handle(IPC.attachmentAddWorkspaceFiles, (event, root: unknown, paths: unknown) => {
    bindAttachmentOwner(event.sender);
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
      throw new TypeError('Workspace attachment paths must be a string array.');
    }
    return addWorkspaceAttachments(event.sender.id, assertString(root, 'root'), paths as string[]);
  });

  ipcMain.handle(IPC.attachmentAddText, (event, input: unknown) => {
    bindAttachmentOwner(event.sender);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Text attachment input is required.');
    }
    const value = input as Record<string, unknown>;
    const request: AttachmentTextInput = {
      name: typeof value.name === 'string' ? value.name : 'Pasted text',
      text: assertString(value.text, 'text'),
    };
    return addTextAttachment(event.sender.id, request);
  });

  ipcMain.handle(IPC.attachmentAddDroppedPath, (event, path: unknown) => {
    bindAttachmentOwner(event.sender);
    return addDroppedAttachment(event.sender.id, assertString(path, 'path'));
  });

  ipcMain.handle(IPC.attachmentRelease, (event, ids: unknown) => {
    bindAttachmentOwner(event.sender);
    releaseAttachments(event.sender.id, toAttachmentIds(ids));
  });

  ipcMain.handle(IPC.dialogValidateFolder, (_event, path: unknown) =>
    validateFolder(assertString(path, 'path')),
  );

  ipcMain.handle(IPC.recentsGet, () => getRecents());

  ipcMain.handle(IPC.recentsAdd, (_event, path: unknown, name: unknown) =>
    addRecent(assertString(path, 'path'), assertString(name, 'name')),
  );

  ipcMain.handle(IPC.recentsRemove, (_event, path: unknown) =>
    removeRecent(assertString(path, 'path')),
  );

  ipcMain.handle(IPC.recentsClear, () => clearRecents());

  ipcMain.handle(IPC.fsReadDirectory, (_event, dirPath: unknown) =>
    readDirectory(assertString(dirPath, 'dirPath')),
  );

  ipcMain.handle(IPC.fsReadFile, (_event, filePath: unknown) =>
    readFile(assertString(filePath, 'filePath')),
  );

  ipcMain.handle(IPC.fsResolveIdentity, async (_event, filePath: unknown) => {
    const path = await authorizedPath(filePath, 'filePath', { allowMissing: true });
    return { path, identity: canonicalPathIdentity(path) };
  });

  ipcMain.handle(
    IPC.fsWriteFile,
    (
      _event,
      filePath: unknown,
      content: unknown,
      expectedEtag: unknown,
      expectedIdentity: unknown,
    ) => {
      if (expectedEtag !== undefined && expectedEtag !== null && typeof expectedEtag !== 'string') {
        throw new TypeError('Expected "expectedEtag" to be a string, null, or undefined');
      }
      if (expectedIdentity !== undefined && typeof expectedIdentity !== 'string') {
        throw new TypeError('Expected "expectedIdentity" to be a string or undefined');
      }
      return writeFile(
        assertString(filePath, 'filePath'),
        assertString(content, 'content'),
        expectedEtag as string | null | undefined,
        expectedIdentity as string | undefined,
      );
    },
  );

  // Workbench file gestures. Each one is also a `workspace.onDid*Files` event for the extension
  // hosts (PRD Phase 7 §5): upstream fires those for user gestures and `applyEdit`, and this is
  // where AXIOM's user gestures land. Notified after the operation succeeds, never before — an
  // extension that reacts by reading the new path must find it there.
  ipcMain.handle(IPC.fsCreateFile, async (_event, anchorPath: unknown, name: unknown) => {
    const result = await createFile(
      assertString(anchorPath, 'anchorPath'),
      assertString(name, 'name'),
    );
    notifyFileOperation('create', [{ oldPath: null, newPath: result.path }]);
    return result;
  });

  ipcMain.handle(IPC.fsCreateDirectory, async (_event, anchorPath: unknown, name: unknown) => {
    const result = await createDirectory(
      assertString(anchorPath, 'anchorPath'),
      assertString(name, 'name'),
    );
    notifyFileOperation('create', [{ oldPath: null, newPath: result.path }]);
    return result;
  });

  ipcMain.handle(IPC.fsRename, async (_event, targetPath: unknown, newName: unknown) => {
    const result = await renamePath(
      assertString(targetPath, 'targetPath'),
      assertString(newName, 'newName'),
    );
    notifyFileOperation('rename', [{ oldPath: result.oldPath, newPath: result.newPath }]);
    return result;
  });

  ipcMain.handle(IPC.fsMove, async (_event, source: unknown, destDir: unknown) => {
    const result = await movePath(assertString(source, 'source'), assertString(destDir, 'destDir'));
    // A move is a rename with a different parent, and upstream reports it as one.
    notifyFileOperation('rename', [{ oldPath: result.oldPath, newPath: result.newPath }]);
    return result;
  });

  ipcMain.handle(IPC.fsDelete, async (_event, targetPath: unknown) => {
    const result = await deletePath(assertString(targetPath, 'targetPath'));
    notifyFileOperation('delete', [{ oldPath: result.path, newPath: null }]);
    return result;
  });

  ipcMain.handle(IPC.shellReveal, async (_event, path: unknown) => {
    revealInOS(await authorizedPath(path));
  });

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    writeClipboard(assertString(text, 'text'));
  });

  ipcMain.handle(IPC.clipboardRead, () => readClipboard());

  ipcMain.handle(IPC.fsListFiles, (_event, rootPath: unknown) =>
    listFiles(assertString(rootPath, 'rootPath')),
  );

  ipcMain.handle(
    IPC.fsSearch,
    async (_event, rootPath: unknown, query: unknown, options: unknown) =>
      searchInFiles(
        await authorizedWorkspaceRoot(rootPath, 'rootPath'),
        assertString(query, 'query'),
        toSearchOptions(options),
      ),
  );

  ipcMain.handle(IPC.settingsRead, () => readSettings());

  ipcMain.handle(IPC.settingsWrite, async (_event, values: unknown) => {
    await writeSettings(toSettingsData(values));
  });

  ipcMain.handle(IPC.settingsReadWorkspace, async (_event, root: unknown) =>
    readWorkspaceSettings(await authorizedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.settingsWriteWorkspace, async (_event, root: unknown, values: unknown) =>
    writeWorkspaceSettings(await authorizedWorkspaceRoot(root), toSettingsData(values)),
  );

  ipcMain.handle(IPC.settingsResolve, async (_event, scope: unknown, root: unknown) => {
    const s = scope === 'workspace' ? 'workspace' : 'user';
    const workspaceRoot = s === 'workspace' ? await authorizedWorkspaceRoot(root) : null;
    const path = await ensureSettingsFile(s, workspaceRoot);
    // This dedicated Main API grants exactly the resolved JSON file so the
    // editor can open it; generic renderer paths still cannot create authority.
    return authorizeFilePath(path);
  });

  ipcMain.handle(IPC.keybindingsRead, () => readKeybindings());

  ipcMain.handle(IPC.keybindingsWrite, (_event, values: unknown) =>
    writeKeybindings(toSettingsData(values)),
  );

  ipcMain.handle(IPC.preferencesApplyProfile, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Expected profile preferences to be an object');
    }
    const value = input as Record<string, unknown>;
    const settings = assertSettingsData(value.settings, 'settings');
    const keybindings = assertSettingsData(value.keybindings, 'keybindings');
    for (const [command, chord] of Object.entries(keybindings)) {
      if (command.length === 0 || typeof chord !== 'string') {
        throw new TypeError('Profile keybindings must map command ids to string chords');
      }
    }
    return applyProfilePreferences(settings, keybindings);
  });

  ipcMain.handle(IPC.editorStateRead, async (_event, root: unknown) =>
    readEditorState(await authorizedWorkspaceRoot(root)),
  );

  // The service defensively re-sanitizes the session, so the cast is safe.
  ipcMain.handle(IPC.editorStateWrite, async (_event, root: unknown, state: unknown) =>
    writeEditorState(await authorizedWorkspaceRoot(root), state as EditorSessionState),
  );

  ipcMain.handle(IPC.layoutRead, () => readLayout());

  // The service defensively re-sanitizes the layout, so the cast is safe.
  ipcMain.handle(IPC.layoutWrite, (_event, state: unknown) => writeLayout(state as LayoutState));

  ipcMain.handle(IPC.gitStatus, async (_event, root: unknown) =>
    gitService.getStatus(await trustedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.gitStage, async (_event, root: unknown, filepath: unknown) => {
    const target = await trustedGitTarget(root, filepath, { allowMissing: true });
    return systemGitService.serializeGitMutation(target.root, () =>
      gitService.stage(target.root, target.relativePath),
    );
  });

  ipcMain.handle(IPC.gitUnstage, async (_event, root: unknown, filepath: unknown) => {
    const target = await trustedGitTarget(root, filepath, { allowMissing: true });
    return systemGitService.serializeGitMutation(target.root, () =>
      gitService.unstage(target.root, target.relativePath),
    );
  });

  ipcMain.handle(IPC.gitCommit, async (_event, root: unknown, message: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    const commitMessage = assertString(message, 'message').trim();
    if (!commitMessage || commitMessage.length > 10_000) {
      throw new Error('Commit message must be between 1 and 10,000 characters.');
    }
    return systemGitService.serializeGitMutation(canonicalRoot, () =>
      gitService.commit(canonicalRoot, commitMessage),
    );
  });

  ipcMain.handle(IPC.gitBranches, async (_event, root: unknown) =>
    systemGitService.getSystemBranches(await trustedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.gitCheckout, async (event, root: unknown, ref: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    return systemGitService.checkoutBranch(canonicalRoot, ref, gitProgressFor(event.sender));
  });

  ipcMain.handle(IPC.gitCreateBranch, async (event, root: unknown, name: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    return systemGitService.createBranch(canonicalRoot, name, gitProgressFor(event.sender));
  });

  ipcMain.handle(IPC.gitDiff, async (_event, root: unknown, filepath: unknown, mode: unknown) => {
    const target = await trustedGitTarget(root, filepath, { allowMissing: true });
    if (mode !== 'staged' && mode !== 'unstaged') {
      throw new TypeError('Expected "mode" to be "staged" or "unstaged"');
    }
    return gitService.diff(target.root, target.relativePath, mode);
  });

  ipcMain.handle(
    IPC.gitDiscard,
    async (_event, root: unknown, filepath: unknown, confirmed: unknown) => {
      if (confirmed !== true) throw new Error('Discarding changes requires explicit confirmation.');
      const target = await trustedGitTarget(root, filepath, { allowMissing: true });
      return systemGitService.serializeGitMutation(target.root, () =>
        gitService.discard(target.root, target.relativePath),
      );
    },
  );

  ipcMain.handle(IPC.gitInit, async (_event, root: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    return systemGitService.serializeGitMutation(canonicalRoot, () =>
      gitService.init(canonicalRoot),
    );
  });

  ipcMain.handle(IPC.gitLog, async (_event, root: unknown, depth: unknown) =>
    gitService.log(
      await trustedWorkspaceRoot(root),
      typeof depth === 'number' && Number.isFinite(depth) ? depth : undefined,
    ),
  );

  ipcMain.handle(IPC.gitRepository, async (_event, root: unknown) =>
    systemGitService.getRepositoryInfo(await trustedWorkspaceRoot(root)),
  );

  ipcMain.handle(
    IPC.gitRemotes,
    async (_event, root: unknown) =>
      (await systemGitService.getRepositoryInfo(await trustedWorkspaceRoot(root))).remotes,
  );

  ipcMain.handle(IPC.gitFetch, async (event, root: unknown, remote: unknown) =>
    systemGitService.fetchRepository(
      await trustedWorkspaceRoot(root),
      remote,
      gitProgressFor(event.sender),
    ),
  );

  ipcMain.handle(IPC.gitPull, async (event, root: unknown) =>
    systemGitService.pullRepository(await trustedWorkspaceRoot(root), gitProgressFor(event.sender)),
  );

  ipcMain.handle(IPC.gitPush, async (event, root: unknown) =>
    systemGitService.pushRepository(await trustedWorkspaceRoot(root), gitProgressFor(event.sender)),
  );

  ipcMain.handle(IPC.gitAddRemote, async (event, root: unknown, remote: unknown, url: unknown) =>
    systemGitService.addRemote(
      await trustedWorkspaceRoot(root),
      remote,
      url,
      gitProgressFor(event.sender),
    ),
  );

  ipcMain.handle(
    IPC.gitDeleteBranch,
    async (event, root: unknown, ref: unknown, confirmed: unknown) =>
      systemGitService.deleteBranch(
        await trustedWorkspaceRoot(root),
        ref,
        confirmed,
        gitProgressFor(event.sender),
      ),
  );

  ipcMain.handle(IPC.gitMerge, async (event, root: unknown, ref: unknown, confirmed: unknown) =>
    systemGitService.mergeBranch(
      await trustedWorkspaceRoot(root),
      ref,
      confirmed,
      gitProgressFor(event.sender),
    ),
  );

  ipcMain.handle(IPC.gitRebase, async (event, root: unknown, ref: unknown, confirmed: unknown) =>
    systemGitService.rebaseBranch(
      await trustedWorkspaceRoot(root),
      ref,
      confirmed,
      gitProgressFor(event.sender),
    ),
  );

  ipcMain.handle(IPC.gitCommitAndPush, async (event, root: unknown, message: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    const commitMessage = assertString(message, 'message').trim();
    if (!commitMessage || commitMessage.length > 10_000) {
      throw new Error('Commit message must be between 1 and 10,000 characters.');
    }
    return systemGitService.commitAndPush(
      canonicalRoot,
      commitMessage,
      () => gitService.commit(canonicalRoot, commitMessage),
      gitProgressFor(event.sender),
    );
  });

  ipcMain.handle(IPC.githubState, async (event) => {
    bindGithubOwner(event.sender);
    return githubScmService.getGithubState();
  });

  ipcMain.handle(IPC.githubStart, async (event) => {
    bindGithubOwner(event.sender);
    const ownerId = event.sender.id;
    const flow = await githubScmService.startGithubDeviceFlow(ownerId);
    if (event.sender.isDestroyed()) {
      githubScmService.cancelGithubDeviceFlow(ownerId, flow.flowId);
      throw new Error('The GitHub connection window was closed.');
    }
    return flow;
  });

  ipcMain.handle(IPC.githubPoll, async (event, flowId: unknown) => {
    bindGithubOwner(event.sender);
    return githubScmService.pollGithubDeviceFlow(event.sender.id, flowId);
  });

  ipcMain.handle(IPC.githubCancel, (event, flowId: unknown) => {
    bindGithubOwner(event.sender);
    githubScmService.cancelGithubDeviceFlow(event.sender.id, flowId);
  });

  ipcMain.handle(IPC.githubOpenVerification, async (event, flowId: unknown) => {
    bindGithubOwner(event.sender);
    return githubScmService.openGithubVerification(event.sender.id, flowId);
  });

  ipcMain.handle(IPC.githubDisconnect, async (event) => {
    bindGithubOwner(event.sender);
    return githubScmService.disconnectGithub(event.sender.id);
  });

  ipcMain.handle(
    IPC.githubPublishRepository,
    async (event, root: unknown, input: unknown, confirmed: unknown) => {
      if (confirmed !== true) {
        throw new Error('Publishing a GitHub repository requires explicit confirmation.');
      }
      const canonicalRoot = await trustedWorkspaceRoot(root);
      const repository = await githubScmService.createGithubRepository(input);
      try {
        const result = await systemGitService.publishCreatedRepository(
          canonicalRoot,
          repository.cloneUrl,
          gitProgressFor(event.sender),
        );
        return {
          ok: true,
          stage: 'published' as const,
          repository,
          message: result.message,
          recovery: null,
        };
      } catch (error) {
        const stage =
          error instanceof systemGitService.PartialPublishError
            ? error.stage
            : ('repository-created' as const);
        const detail = systemGitService.sanitizeGitError(error).message;
        const recovery =
          stage === 'remote-added'
            ? `Repository created at ${repository.htmlUrl}. Retry Push from Source Control.`
            : `Repository created at ${repository.htmlUrl}. Configure origin to exactly ${repository.cloneUrl}, then retry publication.`;
        return {
          ok: false,
          stage,
          repository,
          message: detail,
          recovery,
        };
      }
    },
  );

  ipcMain.handle(
    IPC.githubRetryPublishRepository,
    async (event, root: unknown, cloneUrl: unknown, confirmed: unknown) => {
      if (confirmed !== true) {
        throw new Error('Retrying a GitHub publication requires explicit confirmation.');
      }
      const canonicalRoot = await trustedWorkspaceRoot(root);
      return systemGitService.publishCreatedRepository(
        canonicalRoot,
        cloneUrl,
        gitProgressFor(event.sender),
      );
    },
  );

  // ---- God Mode: all roots, trust, processes, credentials, network and mutations stay in Main. ----
  ipcMain.handle(IPC.godModeSnapshot, async (event, rootValue: unknown) => {
    if (rootValue === null || rootValue === undefined || rootValue === '') {
      return godModeService.getGodModeSnapshot(event.sender.id, null, false);
    }
    const root = await authorizedWorkspaceRoot(rootValue);
    const trust = await getWorkspaceTrust(root);
    return godModeService.getGodModeSnapshot(event.sender.id, root, trust.trusted);
  });

  ipcMain.handle(IPC.godModeContextInspect, async (event, input: unknown) => {
    const controller = new AbortController();
    const binding: ContextBinding = { ownerId: event.sender.id, root: null, controller };
    contextBindings.add(binding);
    const onSenderDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    try {
      const value = (input ?? {}) as Record<string, unknown>;
      const root = await authorizedWorkspaceRoot(value.root);
      binding.root = root;
      await assertWorkspaceTrusted(root);
      controller.signal.throwIfAborted();
      const activePath =
        typeof value.activePath === 'string' && value.activePath
          ? await assertPathInTrustedWorkspace(root, value.activePath)
          : undefined;
      controller.signal.throwIfAborted();
      const request: Omit<ContextIntelligenceInput, 'root'> = {
        query: assertString(value.query, 'query'),
        ...(activePath ? { activePath } : {}),
        ...(Array.isArray(value.expectedPaths)
          ? { expectedPaths: value.expectedPaths as string[] }
          : {}),
        ...(typeof value.budgetTokens === 'number' ? { budgetTokens: value.budgetTokens } : {}),
        ...(typeof value.topK === 'number' ? { topK: value.topK } : {}),
      };
      return await godModeContextService.inspectContext(root, request, controller.signal);
    } finally {
      contextBindings.delete(binding);
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
  });

  ipcMain.handle(IPC.godModeContextEvaluate, async (event, rootValue: unknown, cases: unknown) => {
    const controller = new AbortController();
    const binding: ContextBinding = { ownerId: event.sender.id, root: null, controller };
    contextBindings.add(binding);
    const onSenderDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    try {
      const root = await authorizedWorkspaceRoot(rootValue);
      binding.root = root;
      await assertWorkspaceTrusted(root);
      controller.signal.throwIfAborted();
      return await godModeContextService.evaluateContextSuite(root, cases, controller.signal);
    } finally {
      contextBindings.delete(binding);
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
  });

  ipcMain.handle(IPC.godModeJobCreate, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    const request: Omit<CreateAutonomousJobInput, 'root'> = {
      goal: assertString(value.goal, 'goal'),
      ...(typeof value.maxIterations === 'number' ? { maxIterations: value.maxIterations } : {}),
    };
    return godModeJobsService.createAutonomousJob(event.sender.id, root, request);
  });
  ipcMain.handle(IPC.godModeJobList, async (_event, rootValue: unknown) =>
    godModeJobsService.listGodModeJobs(await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModeJobClaim, async (event, rootValue: unknown, id: unknown) =>
    godModeJobsService.claimAndStartJob(
      event.sender.id,
      await trustedWorkspaceRoot(rootValue),
      assertString(id, 'id'),
    ),
  );
  ipcMain.handle(IPC.godModeJobControl, async (event, rootValue: unknown, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const action = value.action;
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
      throw new Error('Unknown autonomous job control action.');
    }
    const request: JobControlInput = { id: assertString(value.id, 'id'), action };
    const root = await trustedWorkspaceRoot(rootValue);
    const job = await godModeJobsService.controlGodModeJob(event.sender.id, root, request);
    if (action === 'pause' || action === 'cancel') {
      cancelAgentForOwner(request.id, event.sender.id);
    }
    return job;
  });

  ipcMain.handle(IPC.godModePreviewOpen, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    const request: PreviewOpenInput = {
      root,
      url: assertString(value.url, 'url'),
      ...(typeof value.launchCommand === 'string' ? { launchCommand: value.launchCommand } : {}),
      ...(value.confirmation === true ? { confirmation: true } : {}),
    };
    if (request.launchCommand) {
      await requireNativeGodModeApproval(
        event.sender,
        value.confirmation,
        'Launch Preview Command',
        'Run this workspace command for the secure preview?',
        `Command: ${request.launchCommand}\nURL: ${request.url}`,
      );
    }
    return previewService.openPreview(
      event.sender,
      BrowserWindow.fromWebContents(event.sender),
      request,
    );
  });
  ipcMain.handle(IPC.godModePreviewGet, async (event, rootValue: unknown) =>
    previewService.getPreview(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModePreviewRefresh, async (event, rootValue: unknown) =>
    previewService.refreshPreview(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModePreviewCapture, async (event, rootValue: unknown) =>
    previewService.capturePreview(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModePreviewSelect, async (event, rootValue: unknown) =>
    previewService.selectPreviewElement(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModePreviewClose, async (event, rootValue: unknown) =>
    previewService.closePreview(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );

  ipcMain.handle(
    IPC.godModeVerificationPlan,
    async (event, rootValue: unknown, changedFilesValue: unknown) =>
      verificationService.createVerificationPlan(
        event.sender,
        await trustedWorkspaceRoot(rootValue),
        changedFilesValue,
      ),
  );
  ipcMain.handle(
    IPC.godModeVerificationRun,
    async (event, planId: unknown, checkIds: unknown, confirmation: unknown) => {
      const descriptor = await verificationService.prepareVerificationExecution(
        event.sender,
        planId,
        checkIds,
        confirmation,
      );
      try {
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Run Workspace Verification',
          'Run these exact package scripts against the immutable snapshot shown?',
          descriptor.detail,
        );
        await assertWorkspaceTrusted(descriptor.root);
        return verificationService.executePreparedVerification(event.sender, descriptor);
      } catch (error) {
        await verificationService.cancelVerification(event.sender.id, descriptor.planId);
        throw error;
      }
    },
  );
  ipcMain.handle(IPC.godModeVerificationCancel, (event, planId: unknown) =>
    verificationService.cancelVerification(event.sender.id, planId),
  );
  ipcMain.handle(IPC.godModeDebugEvidence, async (event, threadIdValue: unknown) => {
    const binding = await requireActiveDebug(event.sender);
    if (
      typeof threadIdValue !== 'number' ||
      !Number.isSafeInteger(threadIdValue) ||
      threadIdValue < 0
    ) {
      throw new Error('A valid debugger thread is required.');
    }
    return debugEvidenceService.captureDebugEvidence(binding.root, threadIdValue);
  });

  ipcMain.handle(IPC.godModeIssueLoad, async (event, rootValue: unknown, issue: unknown) => {
    bindGithubOwner(event.sender);
    const root = await trustedWorkspaceRoot(rootValue);
    const lease = githubIssuePrService.beginGithubWorkspaceOperation(event.sender.id, root);
    try {
      return await githubIssuePrService.loadGithubIssue(event.sender.id, root, issue, lease.signal);
    } finally {
      lease.release();
    }
  });
  ipcMain.handle(IPC.godModeIssuePlan, async (event, rootValue: unknown, issue: unknown) => {
    bindGithubOwner(event.sender);
    const root = await trustedWorkspaceRoot(rootValue);
    const lease = githubIssuePrService.beginGithubWorkspaceOperation(event.sender.id, root);
    try {
      return await githubIssuePrService.planGithubIssue(event.sender.id, root, issue, lease.signal);
    } finally {
      lease.release();
    }
  });
  ipcMain.handle(
    IPC.godModeIssueStart,
    async (event, rootValue: unknown, issue: unknown, confirmation: unknown) => {
      bindGithubOwner(event.sender);
      const root = await trustedWorkspaceRoot(rootValue);
      const lease = githubIssuePrService.beginGithubWorkspaceOperation(event.sender.id, root);
      try {
        if (confirmation !== true) {
          throw new Error('Creating an issue branch requires explicit confirmation.');
        }
        const plan = await githubIssuePrService.planGithubIssue(
          event.sender.id,
          root,
          issue,
          lease.signal,
        );
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Start GitHub Issue Branch',
          'Create and check out this exact clean issue branch?',
          JSON.stringify(
            {
              root,
              issue: {
                owner: plan.issue.owner,
                repo: plan.issue.repo,
                number: plan.issue.number,
                title: plan.issue.title,
                state: plan.issue.state,
                updatedAt: plan.issue.updatedAt,
              },
              branch: plan.branch,
            },
            null,
            2,
          ),
        );
        lease.signal.throwIfAborted();
        await assertWorkspaceTrusted(root);
        return githubIssuePrService.startGithubIssue(
          event.sender.id,
          root,
          issue,
          true,
          lease.signal,
          plan.branch,
        );
      } finally {
        lease.release();
      }
    },
  );
  ipcMain.handle(IPC.godModeIssueCreatePr, async (event, input: unknown) => {
    bindGithubOwner(event.sender);
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    const lease = githubIssuePrService.beginGithubWorkspaceOperation(event.sender.id, root);
    try {
      if (value.confirmation !== true) {
        throw new Error('Creating a verified pull request requires explicit confirmation.');
      }
      const exactInput = { ...value, root, confirmation: true };
      const approval = await githubIssuePrService.preparePullRequestApproval(
        event.sender.id,
        root,
        exactInput,
        lease.signal,
      );
      await requireNativeGodModeApproval(
        event.sender,
        true,
        'Create Verified Pull Request',
        'Commit, push, and create this exact pull request?',
        approval.detail,
      );
      lease.signal.throwIfAborted();
      await assertWorkspaceTrusted(root);
      return githubIssuePrService.createVerifiedPullRequest(
        event.sender,
        root,
        exactInput,
        approval,
        lease.signal,
      );
    } finally {
      lease.release();
    }
  });

  ipcMain.handle(IPC.godModeWorkspaceList, async (_event, rootValue: unknown) =>
    isolatedWorkspaceService.listIsolatedWorkspaces(await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModeWorkspaceProbe, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    bindIsolatedOwner(event.sender);
    const lease = isolatedWorkspaceService.beginIsolatedOperation(event.sender.id, root);
    try {
      return await isolatedWorkspaceService.probeWorkspaceTarget(
        root,
        { ...value, root },
        lease.signal,
      );
    } finally {
      lease.release();
    }
  });
  ipcMain.handle(IPC.godModeWorkspaceCreate, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    bindIsolatedOwner(event.sender);
    const lease = isolatedWorkspaceService.beginIsolatedOperation(event.sender.id, root);
    try {
      if (value.confirmation !== true) {
        throw new Error('Creating an isolated workspace requires explicit confirmation.');
      }
      const approval = isolatedWorkspaceService.prepareIsolatedWorkspaceCreationApproval(root, {
        ...value,
        root,
        confirmation: true,
      });
      await requireNativeGodModeApproval(
        event.sender,
        true,
        'Create Isolated Workspace',
        'Create or register this exact isolated workspace target?',
        approval.detail,
      );
      lease.signal.throwIfAborted();
      await assertWorkspaceTrusted(root);
      return isolatedWorkspaceService.createIsolatedWorkspace(
        root,
        { ...value, root, confirmation: true },
        approval,
        lease.signal,
      );
    } finally {
      lease.release();
    }
  });
  ipcMain.handle(
    IPC.godModeWorkspaceRun,
    async (
      event,
      rootValue: unknown,
      profileId: unknown,
      command: unknown,
      confirmation: unknown,
    ) => {
      const root = await trustedWorkspaceRoot(rootValue);
      const exactProfileId = assertString(profileId, 'profileId').trim();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(exactProfileId)) {
        throw new Error('Workspace profile id is invalid.');
      }
      const exactCommand = assertString(command, 'command').trim();
      if (
        !exactCommand ||
        exactCommand.length > 1_000 ||
        /[\u0000-\u001f\u007f]/.test(exactCommand)
      ) {
        throw new Error(
          'Workspace commands must be a single control-free line of at most 1,000 characters.',
        );
      }
      if (confirmation !== true) {
        throw new Error('Running an isolated workspace command requires explicit confirmation.');
      }
      const approval = await isolatedWorkspaceService.prepareIsolatedCommandApproval(
        root,
        exactProfileId,
        exactCommand,
      );
      await requireNativeGodModeApproval(
        event.sender,
        true,
        'Run Isolated Workspace Command',
        'Run this exact resolved command in the selected isolated target?',
        approval.detail,
      );
      await assertWorkspaceTrusted(root);
      return isolatedWorkspaceService.runIsolatedWorkspaceCommand(
        event.sender,
        root,
        exactProfileId,
        exactCommand,
        true,
        approval,
      );
    },
  );
  ipcMain.handle(IPC.godModeWorkspaceCancel, (event, profileId: unknown) =>
    isolatedWorkspaceService.cancelIsolatedCommand(event.sender.id, profileId),
  );
  ipcMain.handle(
    IPC.godModeWorkspaceRemove,
    async (event, rootValue: unknown, profileId: unknown, confirmation: unknown) => {
      const root = await trustedWorkspaceRoot(rootValue);
      await requireNativeGodModeApproval(
        event.sender,
        confirmation,
        'Remove Isolated Workspace',
        'Remove this isolated workspace profile and its managed clone?',
        `Profile: ${String(profileId)}`,
      );
      return isolatedWorkspaceService.removeIsolatedWorkspace(root, profileId, true);
    },
  );

  ipcMain.handle(IPC.godModeExtensionList, async (_event, rootValue: unknown) =>
    extensionSandboxService.listExtensionSandboxes(await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(
    IPC.godModeExtensionEnable,
    async (
      event,
      rootValue: unknown,
      id: unknown,
      confirmation: unknown,
      allowUnsigned: unknown,
    ) => {
      const root = await trustedWorkspaceRoot(rootValue);
      await requireNativeGodModeApproval(
        event.sender,
        confirmation,
        'Enable Sandboxed Extension',
        'Run this exact integrity-checked WASM package once and enable its contributions?',
        `Extension: ${String(id)}\nUnsigned/untrusted-key approval: ${allowUnsigned === true ? 'yes' : 'no'}`,
      );
      return extensionSandboxService.enableSandboxExtension(
        event.sender,
        root,
        id,
        true,
        allowUnsigned,
      );
    },
  );
  ipcMain.handle(IPC.godModeExtensionDisable, async (_event, rootValue: unknown, id: unknown) =>
    extensionSandboxService.disableSandboxExtension(await trustedWorkspaceRoot(rootValue), id),
  );

  ipcMain.handle(IPC.godModeCollaborationList, async (_event, rootValue: unknown) =>
    collaborationService.listCollaborationSessions(await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModeCollaborationCreate, async (_event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    return collaborationService.createCollaborationSession(root, {
      title: assertString(value.title, 'title'),
    });
  });
  ipcMain.handle(
    IPC.godModeCollaborationAddEvent,
    async (_event, rootValue: unknown, sessionId: unknown, input: unknown) =>
      collaborationService.addCollaborationEvent(
        await trustedWorkspaceRoot(rootValue),
        sessionId,
        input,
      ),
  );
  ipcMain.handle(
    IPC.godModeCollaborationExport,
    async (_event, rootValue: unknown, sessionId: unknown) =>
      collaborationService.exportCollaborationSession(
        await trustedWorkspaceRoot(rootValue),
        sessionId,
      ),
  );
  ipcMain.handle(
    IPC.godModeCollaborationShare,
    async (event, rootValue: unknown, sessionId: unknown, confirmation: unknown) => {
      const root = await trustedWorkspaceRoot(rootValue);
      bindCollaborationOwner(event.sender);
      const lease = collaborationService.beginCollaborationCloudOperation(event.sender.id, root);
      try {
        if (confirmation !== true) throw new Error('Cloud sharing requires explicit confirmation.');
        const approval = await collaborationService.prepareCollaborationShareApproval(
          root,
          sessionId,
        );
        lease.signal.throwIfAborted();
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Share Collaboration Session',
          'Upload this exact redacted handoff bundle?',
          approval.detail,
        );
        lease.signal.throwIfAborted();
        await assertWorkspaceTrusted(root);
        return collaborationService.shareCollaborationSession(
          root,
          sessionId,
          true,
          approval,
          lease.signal,
        );
      } finally {
        lease.release();
      }
    },
  );
  ipcMain.handle(
    IPC.godModeCollaborationAddMember,
    async (
      event,
      rootValue: unknown,
      sessionId: unknown,
      userId: unknown,
      role: unknown,
      confirmation: unknown,
    ) => {
      const root = await trustedWorkspaceRoot(rootValue);
      bindCollaborationOwner(event.sender);
      const lease = collaborationService.beginCollaborationCloudOperation(event.sender.id, root);
      try {
        if (confirmation !== true) {
          throw new Error('Adding a collaborator requires explicit confirmation.');
        }
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Add Collaboration Member',
          'Grant this exact cloud user the selected collaboration role?',
          JSON.stringify({ root, sessionId, userId, role }, null, 2),
        );
        lease.signal.throwIfAborted();
        await assertWorkspaceTrusted(root);
        return collaborationService.addCloudCollaborationMember(
          root,
          sessionId,
          userId,
          role,
          true,
          lease.signal,
        );
      } finally {
        lease.release();
      }
    },
  );

  ipcMain.handle(
    IPC.godModeDeploymentSaveHook,
    async (event, rootValue: unknown, id: unknown, hookUrl: unknown, confirmation: unknown) => {
      if (confirmation !== true)
        throw new Error('Storing a deploy hook requires explicit confirmation.');
      const root = await trustedWorkspaceRoot(rootValue);
      const descriptor = deploymentService.describeDeploymentHook(root, id, hookUrl);
      await requireNativeGodModeApproval(
        event.sender,
        true,
        'Store Deployment Hook',
        'Encrypt and store this exact root-bound deployment-hook URL?',
        JSON.stringify(
          {
            root,
            targetId: descriptor.targetId,
            secretRef: descriptor.secretRef,
            hookOrigin: descriptor.hookOrigin,
            normalizedUrlSha256: descriptor.hookUrlSha256,
          },
          null,
          2,
        ),
      );
      await assertWorkspaceTrusted(root);
      return deploymentService.saveDeploymentHook(root, id, hookUrl);
    },
  );
  ipcMain.handle(IPC.godModeDeploymentPlan, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    return deploymentService.createDeploymentPlan(event.sender, root, value.target);
  });
  ipcMain.handle(IPC.godModeDeploymentExecute, async (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(value.root);
    const request: ExecuteDeploymentInput = {
      planId: assertString(value.planId, 'planId'),
      verificationPlanId: assertString(value.verificationPlanId, 'verificationPlanId'),
      confirmation: value.confirmation === true,
    };
    if (!request.confirmation)
      throw new Error('Starting a deployment requires explicit confirmation.');
    const approval = await deploymentService.prepareDeploymentExecutionApproval(
      event.sender.id,
      root,
      request,
    );
    await requireNativeGodModeApproval(
      event.sender,
      true,
      'Deploy Verified Preview',
      'Trigger this exact one-shot deployment plan?',
      approval.detail,
    );
    await assertWorkspaceTrusted(root);
    request.confirmation = true;
    return deploymentService.executeDeployment(event.sender, root, request, approval);
  });
  ipcMain.handle(IPC.godModeDeploymentList, async (event, rootValue: unknown) =>
    deploymentService.listDeployments(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(IPC.godModeDeploymentCancel, (event, runId: unknown) =>
    deploymentService.cancelDeployment(event.sender.id, runId),
  );

  ipcMain.handle(IPC.secretsSet, async (_event, key: unknown, value: unknown, binding: unknown) => {
    const k = assertString(key, 'key');
    const v = assertString(value, 'value');
    await secretsService.setAiCredential(k, v, toAiCredentialBinding(binding));
    void appendAudit('secret.set', `Secret updated: ${k}`);
  });

  ipcMain.handle(IPC.secretsHas, (_event, key: unknown, binding: unknown) => {
    const k = assertString(key, 'key');
    return binding === undefined
      ? secretsService.hasSecret(k)
      : secretsService.hasAiCredential(k, toAiCredentialBinding(binding));
  });

  ipcMain.handle(IPC.secretsDelete, async (_event, key: unknown) => {
    const k = assertString(key, 'key');
    await secretsService.deleteSecret(k);
    void appendAudit('secret.delete', `Secret removed: ${k}`);
  });

  ipcMain.handle(IPC.aiTestConnection, async (_event, input: unknown) => {
    const creds = await toCustomProbeCreds(input);
    const diagnosticInput: AiDiagnosticsInput = {
      provider: 'custom',
      model: creds.model,
      baseUrl: creds.baseUrl,
    };
    const credentialStatus: AiCredentialStatus = creds.apiKey ? 'available' : 'keyless';
    updateAiDiagnostics(diagnosticInput, {
      credentialStatus,
      lastRequestPhase: 'testing',
      lastSafeError: null,
      failoverUsed: false,
      responseFormat: null,
    });
    const result = await aiService.testConnection(creds);
    recordAiConnectionTest(
      diagnosticInput,
      { ok: result.ok, message: result.ok ? result.message : result.detail || result.message },
      credentialStatus,
    );
    return result;
  });

  ipcMain.handle(IPC.aiFetchModels, async (_event, input: unknown) =>
    aiService.fetchModels(await toCustomProbeCreds(input)),
  );

  ipcMain.handle(IPC.aiDiagnosticsGet, async (_event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const provider = assertString(value.provider, 'provider');
    const model = typeof value.model === 'string' ? value.model : '';
    const requestedBaseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : '';
    let normalizedBaseUrl = requestedBaseUrl;
    let credentialStatus: AiCredentialStatus = 'missing';
    try {
      normalizedBaseUrl = secretsService.normalizeAiBaseUrl(provider, requestedBaseUrl);
      const credential = await secretsService.resolveAiCredential(provider, normalizedBaseUrl);
      credentialStatus = credential.apiKey ? 'available' : 'keyless';
    } catch (error) {
      credentialStatus =
        error instanceof Error && error.name === 'AiCredentialError' ? 'missing' : 'error';
    }
    const diagnosticInput: AiDiagnosticsInput = {
      provider,
      model,
      baseUrl: normalizedBaseUrl,
    };
    return updateAiDiagnostics(diagnosticInput, { credentialStatus });
  });

  ipcMain.handle(IPC.aiConnectionScope, (_event, input: unknown) =>
    resolveAiConnectionScope(input),
  );

  ipcMain.handle(IPC.aiChatSend, async (event, input: unknown): Promise<ChatSendResult> => {
    const o = (input ?? {}) as Record<string, unknown>;
    const id = assertString(o.id, 'id');
    const sender = event.sender;
    const ownerId = sender.id;
    // Stop can arrive while the renderer is still assembling context. Consume
    // only this renderer's durable tombstone before credential lookup or egress.
    if (takeChatCancellation(ownerId, id)) return { id, status: 'cancelled' };
    const existing = chatAborts.get(id);
    if (existing) {
      throw new Error(
        existing.ownerId === ownerId
          ? `Chat request ${id} is already active.`
          : 'This chat request id is owned by another renderer.',
      );
    }

    const controller = new AbortController();
    chatAborts.set(id, { ownerId, controller });
    const onSenderDestroyed = (): void => controller.abort();
    sender.once('destroyed', onSenderDestroyed);
    let diagnosticInput: AiDiagnosticsInput | null = null;
    try {
      const provider = assertString(o.provider, 'provider');
      const model = assertString(o.model, 'model');
      if (model.length === 0) throw new Error('No model is configured for this provider.');
      const requestedBaseUrl = typeof o.baseUrl === 'string' ? o.baseUrl : '';
      diagnosticInput = { provider, model, baseUrl: requestedBaseUrl };
      updateAiDiagnostics(diagnosticInput, {
        provider,
        model,
        lastRequestPhase: 'credential',
        lastSafeError: null,
        failoverUsed: false,
        responseFormat: null,
      });
      const headers = toHeaderMap(o.headers);
      let messages = toChatMessages(o.messages);
      bindAttachmentOwner(sender);
      const attachmentIds = toAttachmentIds(o.attachmentIds);
      const materialized =
        attachmentIds.length > 0
          ? await materializeAttachments(ownerId, attachmentIds, controller.signal)
          : { text: '', images: [] };
      controller.signal.throwIfAborted();
      if (materialized.text) {
        const attachmentMessage = buildAgentUntrustedMessage(
          'attached workspace files',
          materialized.text,
          randomUUID(),
        );
        const firstTurn = messages.findIndex((message) => message.role !== 'system');
        const insertAt = firstTurn < 0 ? messages.length : firstTurn;
        messages = [...messages.slice(0, insertAt), attachmentMessage, ...messages.slice(insertAt)];
      }
      const credential = await secretsService.resolveAiCredential(provider, requestedBaseUrl);
      diagnosticInput = { provider, model, baseUrl: credential.baseUrl };
      updateAiDiagnostics(diagnosticInput, {
        credentialStatus: credential.apiKey ? 'available' : 'keyless',
        lastRequestPhase: 'routing',
      });
      if (controller.signal.aborted) return { id, status: 'cancelled' };

      // Resolve primary and each optional fallback independently. An unusable
      // fallback is skipped, but a primary authorization error is never masked.
      const attempts: ChatParams[] = [
        {
          provider,
          model,
          baseUrl: credential.baseUrl,
          headers,
          apiKey: credential.apiKey,
          credentialRevision: credential.revision,
          messages,
          ...(materialized.images.length > 0 ? { images: materialized.images } : {}),
        },
      ];
      let s: Record<string, unknown> = {};
      try {
        s = (await readSettings()) as Record<string, unknown>;
      } catch {
        // Routing/failover settings are optional; the authorized primary remains usable.
      }
      const reasoning: ReasoningConfig = {
        enabled: s['ai.reasoning.enabled'] === true,
        effort: parseReasoningEffort(s['ai.reasoning.effort']),
        visibility: 'summary',
      };
      attempts[0]!.reasoning = reasoning;
      for (const fid of parseFailoverList(s['ai.fallbackProviders'])) {
        if (controller.signal.aborted) break;
        if (fid === provider) continue;
        const info = providerInfo(fid);
        if (!info) continue;
        try {
          const requestedFallbackBaseUrl =
            fid === 'custom' && typeof s['ai.custom.baseUrl'] === 'string'
              ? s['ai.custom.baseUrl']
              : info.defaultBaseUrl;
          const fallbackHeaders =
            fid === 'custom'
              ? toHeaderMap(
                  JSON.parse(
                    typeof s['ai.custom.headers'] === 'string' && s['ai.custom.headers'].trim()
                      ? s['ai.custom.headers']
                      : '{}',
                  ),
                )
              : {};
          const fallback = await secretsService.resolveAiCredential(fid, requestedFallbackBaseUrl);
          const customModel =
            fid === 'custom' && typeof s['ai.custom.model'] === 'string'
              ? s['ai.custom.model'].trim()
              : '';
          attempts.push({
            provider: fid,
            model: customModel || info.defaultModels[0] || model,
            baseUrl: fallback.baseUrl,
            headers: fallbackHeaders,
            apiKey: fallback.apiKey,
            credentialRevision: fallback.revision,
            messages,
            reasoning,
            ...(materialized.images.length > 0 ? { images: materialized.images } : {}),
          });
        } catch {
          // Failovers are optional and never inherit the primary credential/endpoint.
        }
      }
      const routingPolicy = parseRoutingPolicy(s['ai.routingPolicy']);
      if (routingPolicy !== 'manual' && attempts.length > 1) {
        const candidates = attempts.map((attempt, index) => ({
          provider: attempt.provider,
          model: attempt.model,
          usable: true,
          _i: index,
          ...deriveRouteMeta(attempt.provider, attempt.model, attempt.baseUrl),
        }));
        const ordered = orderCandidates(candidates, { policy: routingPolicy }) as Array<
          (typeof candidates)[number]
        >;
        if (ordered.length === attempts.length) {
          attempts.splice(
            0,
            attempts.length,
            ...ordered.map((candidate) => attempts[candidate._i]!),
          );
        }
      }
      if (controller.signal.aborted) return { id, status: 'cancelled' };

      const chain = healthyChain(attempts);
      let streamStarted = false;
      let completedUsage: ChatUsage | null = null;
      updateAiDiagnostics(diagnosticInput, { lastRequestPhase: 'connecting' });
      try {
        const outcome = await aiService.chatWithFailover(
          chain,
          (delta) => {
            if (!streamStarted) {
              streamStarted = true;
              updateAiDiagnostics(diagnosticInput!, { lastRequestPhase: 'streaming' });
            }
            if (!sender.isDestroyed() && !controller.signal.aborted) {
              sender.send(IPC.aiChatChunk, { id, delta } satisfies ChatChunk);
            }
          },
          (usage, attemptIndex) => {
            if (controller.signal.aborted) return;
            const usedAttempt = chain[attemptIndex] ?? chain[0];
            if (!usedAttempt) return;
            const usedProvider = usedAttempt.provider;
            const usedModel = usedAttempt.model;
            const costUsd = estimateCostUsd(usedModel, usage.inputTokens, usage.outputTokens);
            completedUsage = {
              id,
              provider: usedProvider,
              model: usedModel,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd,
            };
            void recordEvent('analytics', 'ai_action', {
              input: usage.inputTokens,
              output: usage.outputTokens,
            });
            if (!sender.isDestroyed()) {
              sender.send(IPC.aiChatUsage, completedUsage satisfies ChatUsage);
            }
            void recordSpend({
              provider: usedProvider,
              model: usedModel,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd,
            }).then((summary) => {
              if (!sender.isDestroyed()) sender.send(IPC.aiSpendChanged, summary);
            });
          },
          controller.signal,
        );
        if (controller.signal.aborted) return { id, status: 'cancelled' };
        noteChainResult(chain, outcome.attemptIndex);
        const winner = chain[outcome.attemptIndex] ?? chain[0];
        if (!winner) throw new Error('No provider completed the request.');
        const failoverUsed = outcome.attemptIndex > 0;
        const winnerDiagnostic = getAiDiagnostics({
          provider: winner.provider,
          model: winner.model,
          baseUrl: winner.baseUrl,
        });
        updateAiDiagnostics(diagnosticInput, {
          provider: winner.provider,
          model: winner.model,
          endpointHost: winnerDiagnostic.endpointHost,
          endpointPath: winnerDiagnostic.endpointPath,
          credentialStatus: winner.apiKey ? 'available' : 'keyless',
          lastRequestPhase: 'completed',
          lastSafeError: null,
          failoverUsed,
          responseFormat: outcome.responseFormat,
        });
        return {
          id,
          status: 'completed',
          provider: winner.provider,
          model: winner.model,
          failoverUsed,
          responseFormat: outcome.responseFormat,
          usage: completedUsage,
        };
      } catch (error) {
        if (!controller.signal.aborted) noteChainFailure(chain);
        throw error;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (diagnosticInput) {
          updateAiDiagnostics(diagnosticInput, {
            lastRequestPhase: 'cancelled',
            lastSafeError: null,
          });
        }
        return { id, status: 'cancelled' };
      }
      const safeError = safeAiError(error);
      if (diagnosticInput) {
        updateAiDiagnostics(diagnosticInput, {
          lastRequestPhase: 'failed',
          lastSafeError: safeError,
        });
      }
      throw new Error(safeError);
    } finally {
      sender.removeListener('destroyed', onSenderDestroyed);
      if (chatAborts.get(id)?.controller === controller) chatAborts.delete(id);
      clearChatCancellation(ownerId, id);
    }
  });

  ipcMain.handle(IPC.aiChatCancel, (event, id: unknown) => {
    const key = assertString(id, 'id');
    const ownerId = event.sender.id;
    const active = chatAborts.get(key);
    if (active && active.ownerId !== ownerId) {
      throw new Error('This chat request is owned by another renderer.');
    }
    rememberChatCancellation(ownerId, key);
    active?.controller.abort();
  });

  ipcMain.handle(IPC.aiBuildContext, async (event, input: unknown) => {
    const controller = new AbortController();
    const onSenderDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    try {
      const o = (input ?? {}) as Record<string, unknown>;
      const root = await authorizedWorkspaceRoot(o.root);
      controller.signal.throwIfAborted();
      const req: BuildContextInput = {
        root,
        query: assertString(o.query, 'query'),
      };
      if (typeof o.activePath === 'string' && o.activePath.length > 0) {
        req.activePath = await assertAuthorizedPath(resolve(root, o.activePath));
        controller.signal.throwIfAborted();
      }
      if (typeof o.budgetTokens === 'number') req.budgetTokens = o.budgetTokens;
      if (typeof o.topK === 'number') req.topK = o.topK;
      return await buildContext(req, controller.signal);
    } finally {
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
  });

  ipcMain.handle(IPC.aiSpendSummary, () => getSpendSummary());
  ipcMain.handle(IPC.aiSpendClear, () => clearSpend());
  ipcMain.handle(IPC.aiProviderHealth, () => getProviderHealth());

  // ---- Session-scoped batch write consent ----
  // Main verifies trust and explicit confirmation, binds the grant to this exact
  // renderer + canonical root, and keeps it in memory only (dies with the session).
  ipcMain.handle(IPC.agentWriteConsentGet, async (event, rootValue: unknown) =>
    getWriteConsent(event.sender.id, await trustedWorkspaceRoot(rootValue)),
  );
  ipcMain.handle(
    IPC.agentWriteConsentGrant,
    async (
      event,
      rootValue: unknown,
      confirmation: unknown,
      durationMs: unknown,
      persist: unknown,
    ) => {
      if (confirmation !== true) {
        throw new Error('Enabling automatic file edits requires explicit confirmation.');
      }
      // Remembering a folder is a strictly broader decision than a session grant,
      // so it takes its own explicit native confirmation naming the exact folder.
      const remember = persist === true;
      const root = await trustedWorkspaceRoot(rootValue);
      if (remember) {
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Always Allow File Edits',
          'Let Axiom edit files in this folder without asking, including after a restart?',
          `Folder: ${root}\n\nThis applies to ordinary file writes in this folder only.\n` +
            'Running commands, Git and network writes, MCP tools, and every high-risk action ' +
            'still require your approval each time.\n' +
            'Every edit is still snapshotted, so it can be reverted from Timeline or from ' +
            "Build's review bar.\n" +
            'Revoking trust for this folder also revokes this permission.',
        );
        await assertWorkspaceTrusted(root);
      }
      const requested =
        typeof durationMs === 'number' && Number.isFinite(durationMs)
          ? durationMs
          : MAX_WRITE_CONSENT_MS;
      const state = await grantWriteConsent(event.sender.id, root, requested, remember);
      void appendAudit(
        'agent.writeConsent.grant',
        state.persisted
          ? 'Folder file-edit consent remembered for this workspace'
          : `Session file-edit consent granted for ${Math.round((state.remainingMs || 0) / 60000)} minute(s)`,
      );
      return state;
    },
  );
  ipcMain.handle(IPC.agentWriteConsentRevoke, async (event, rootValue: unknown) => {
    const root = await assertAuthorizedWorkspaceRoot(assertString(rootValue, 'root'));
    const state = await revokeWriteConsent(event.sender.id, root);
    void appendAudit('agent.writeConsent.revoke', 'File-edit consent revoked');
    return state;
  });

  // Free local AI: probe fixed loopback endpoints only. No renderer URL is accepted.
  ipcMain.handle(IPC.aiDetectLocalModels, async (event) => {
    const controller = new AbortController();
    const onSenderDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    try {
      return await detectLocalModels(controller.signal);
    } finally {
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
  });

  // ---- Debugger (DAP, PRD Phases 96–101) ----
  const DEBUG_ACTIONS: readonly DebugControlAction[] = [
    'continue',
    'next',
    'stepIn',
    'stepOut',
    'pause',
  ];
  const toBreakpoints = (v: unknown): DebugBreakpoint[] => {
    if (!Array.isArray(v)) throw new Error('Debugger breakpoints must be an array.');
    return v.map((b) => {
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        throw new Error('Debugger breakpoint is invalid.');
      }
      const o = b as Record<string, unknown>;
      if (!Number.isSafeInteger(o.line) || Number(o.line) <= 0) {
        throw new Error('Debugger breakpoint lines must be positive integers.');
      }
      const bp: DebugBreakpoint = { line: Number(o.line) };
      if (o.condition !== undefined && o.condition !== '') {
        if (
          typeof o.condition !== 'string' ||
          o.condition.length > 1_000 ||
          /[\u0000-\u001f\u007f]/.test(o.condition)
        ) {
          throw new Error('Debugger breakpoint conditions exceed the approval limits.');
        }
        bp.condition = o.condition;
      }
      if (o.logMessage !== undefined && o.logMessage !== '') {
        if (
          typeof o.logMessage !== 'string' ||
          o.logMessage.length > 2_000 ||
          /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(o.logMessage)
        ) {
          throw new Error('Debugger breakpoint log messages exceed the approval limits.');
        }
        bp.logMessage = o.logMessage;
      }
      return bp;
    });
  };

  ipcMain.handle(IPC.debugDiscover, async (event, rootValue: unknown) => {
    const root = await trustedWorkspaceRoot(rootValue);
    const controller = new AbortController();
    const onSenderDestroyed = (): void => controller.abort();
    event.sender.once('destroyed', onSenderDestroyed);
    try {
      return await discoverDebugConfigs(root, controller.signal);
    } finally {
      event.sender.removeListener('destroyed', onSenderDestroyed);
    }
  });

  ipcMain.handle(IPC.debugStart, async (event, payload: unknown) => {
    const o = (payload ?? {}) as Record<string, unknown>;
    const c = (o.config ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(c.cwd, 'config.cwd');
    const rawLaunchArgs =
      c.launchArgs && typeof c.launchArgs === 'object' && !Array.isArray(c.launchArgs)
        ? (c.launchArgs as Record<string, unknown>)
        : {};
    const launchArgs: Record<string, unknown> = { ...rawLaunchArgs, cwd: root };
    if (typeof rawLaunchArgs.program === 'string' && rawLaunchArgs.program.trim()) {
      launchArgs.program = await assertPathInTrustedWorkspace(
        root,
        resolve(root, rawLaunchArgs.program),
      );
    }
    const adapterCommand = assertString(c.adapterCommand, 'adapterCommand').trim();
    const adapterArgs = Array.isArray(c.adapterArgs)
      ? c.adapterArgs.filter((argument): argument is string => typeof argument === 'string')
      : [];
    if (
      !adapterCommand ||
      adapterCommand.length > 1_000 ||
      /[\u0000-\u001f\u007f]/.test(adapterCommand) ||
      adapterArgs.length > 32 ||
      adapterArgs.some(
        (argument) => argument.length > 256 || /[\u0000-\u001f\u007f]/.test(argument),
      )
    ) {
      throw new Error('Debugger adapter command or arguments exceed the native approval limits.');
    }
    const launchArgsJson = JSON.stringify(launchArgs);
    if (launchArgsJson.length > 8_000) {
      throw new Error('Debugger launch arguments exceed the native approval limit.');
    }
    const config: DebugLaunchConfig = {
      name: typeof c.name === 'string' ? c.name : 'Debug',
      adapterCommand,
      adapterArgs,
      request: c.request === 'attach' ? 'attach' : 'launch',
      launchArgs,
      cwd: root,
      // Server-transport adapters (js-debug) get a Main-reserved loopback port; any
      // other value falls back to the adapter's own stdio pipes.
      transport: c.transport === 'server' ? 'server' : 'stdio',
    };
    if (!o.breakpoints || typeof o.breakpoints !== 'object' || Array.isArray(o.breakpoints)) {
      throw new Error('Debugger breakpoints must be a file map.');
    }
    const bpsRaw = o.breakpoints as Record<string, unknown>;
    const breakpointEntries = Object.entries(bpsRaw);
    if (breakpointEntries.length > 100) {
      throw new Error('Debugger breakpoint file count exceeds 100.');
    }
    const breakpoints: Record<string, DebugBreakpoint[]> = {};
    let breakpointCount = 0;
    for (const [file, bps] of breakpointEntries) {
      const validated = toBreakpoints(bps);
      breakpointCount += validated.length;
      if (breakpointCount > 200) throw new Error('Debugger breakpoint count exceeds 200.');
      breakpoints[await assertPathInTrustedWorkspace(root, file)] = validated;
    }
    const breakpointsJson = JSON.stringify(breakpoints);
    if (breakpointsJson.length > 6_000) {
      throw new Error('Debugger breakpoint payload exceeds the native approval limit.');
    }

    if (debugBinding && debugBinding.owner !== event.sender) {
      throw new Error('Debug session is owned by another renderer.');
    }
    if (debugBinding) {
      debugBinding = null;
      setDebugEventSink(() => undefined);
      await debugStop();
    }
    await assertWorkspaceTrusted(root);
    await requireNativeGodModeApproval(
      event.sender,
      true,
      'Start Debugger Adapter',
      'Start this debugger adapter with your user privileges?',
      `Adapter: ${config.adapterCommand}\nAdapter arguments: ${JSON.stringify(config.adapterArgs)}\nLaunch request: ${config.request}\nLaunch arguments: ${launchArgsJson}\nBreakpoints: ${breakpointsJson}\nWorkspace: ${JSON.stringify(root)}`,
    );
    await assertWorkspaceTrusted(root);

    const binding: DebugBinding = { root, owner: event.sender };
    debugBinding = binding;
    setDebugEventSink((debugEvent) => {
      if (debugBinding !== binding) return;
      if (!binding.owner.isDestroyed()) binding.owner.send(IPC.debugEvent, debugEvent);
      if (debugEvent.kind === 'state' && debugEvent.state === 'terminated') {
        debugBinding = null;
        setDebugEventSink(() => undefined);
      }
    });
    binding.owner.once('destroyed', () => {
      if (debugBinding !== binding) return;
      debugBinding = null;
      setDebugEventSink(() => undefined);
      void debugStop();
    });

    const result = await debugStart(config, breakpoints);
    if (!result.ok && debugBinding === binding) {
      debugBinding = null;
      setDebugEventSink(() => undefined);
    }
    if (result.ok && debugBinding === binding) {
      try {
        await assertWorkspaceTrusted(root);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (debugBinding === binding) {
          debugBinding = null;
          setDebugEventSink(() => undefined);
          try {
            await debugStop();
          } catch (stopError) {
            const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
            return {
              ok: false,
              message: `${message} Failed to stop debug session: ${stopMessage}`,
            };
          }
        }
        return { ok: false, message };
      }
    }
    return result;
  });

  ipcMain.handle(IPC.debugControl, async (event, action: unknown, threadId: unknown) => {
    await requireActiveDebug(event.sender);
    const act = DEBUG_ACTIONS.find((a) => a === action);
    if (!act) throw new Error(`Unknown debug action: ${String(action)}`);
    return debugControl(act, typeof threadId === 'number' ? threadId : 0);
  });

  ipcMain.handle(IPC.debugSetBreakpoints, async (event, path: unknown, breakpoints: unknown) => {
    const binding = await requireActiveDebug(event.sender);
    return debugSetBreakpoints(
      await assertPathInTrustedWorkspace(binding.root, assertString(path, 'path')),
      toBreakpoints(breakpoints),
    );
  });
  ipcMain.handle(IPC.debugStackTrace, async (event, threadId: unknown) => {
    await requireActiveDebug(event.sender);
    return debugStackTrace(typeof threadId === 'number' ? threadId : 0);
  });
  ipcMain.handle(IPC.debugScopes, async (event, frameId: unknown) => {
    await requireActiveDebug(event.sender);
    return debugScopes(typeof frameId === 'number' ? frameId : 0);
  });
  ipcMain.handle(IPC.debugVariables, async (event, ref: unknown) => {
    await requireActiveDebug(event.sender);
    return debugVariables(typeof ref === 'number' ? ref : 0);
  });
  ipcMain.handle(IPC.debugEvaluate, async (event, expression: unknown, frameId: unknown) => {
    await requireActiveDebug(event.sender);
    return debugEvaluate(
      assertString(expression, 'expression'),
      typeof frameId === 'number' ? frameId : null,
    );
  });
  ipcMain.handle(IPC.debugStop, async (event) => {
    const binding = debugBinding;
    if (binding && binding.owner !== event.sender) {
      throw new Error('Debug session is owned by another renderer.');
    }
    debugBinding = null;
    setDebugEventSink(() => undefined);
    await debugStop();
  });

  // ---- Agent runtime (PRD Epoch H) ----
  ipcMain.handle(IPC.agentRun, async (event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const id = assertString(o.id, 'id');
    const sender = event.sender;
    const existing = agentBindings.get(id);
    if (existing) {
      throw new Error(
        existing.owner === sender
          ? `Agent run ${id} is already active.`
          : 'This agent run id is owned by another renderer.',
      );
    }
    const requestedRoot = assertString(o.root, 'root');
    const requestedAt = Date.now();
    let eventRoot = requestedRoot;
    let eventModel = '';
    let terminalDelivered = false;
    const binding: AgentBinding = { root: null, owner: sender };
    agentBindings.set(id, binding);
    const onSenderDestroyed = (): void => cancelAgent(id, sender.id);
    sender.once('destroyed', onSenderDestroyed);
    let preflight: ReturnType<typeof beginAgentPreflight> | null = null;

    try {
      preflight = beginAgentPreflight(id, sender.id, requestedRoot);
      const assertPreflightActive = (): void => {
        if (preflight?.signal.aborted) throw new Error('Agent run was cancelled during preflight.');
      };
      const provider = assertString(o.provider, 'provider');
      const model = assertString(o.model, 'model');
      eventModel = model;
      const task = assertString(o.task, 'task');
      const root = await trustedWorkspaceRoot(requestedRoot);
      eventRoot = root;
      preflight.setCanonicalRoot(root);
      assertPreflightActive();
      binding.root = root;
      if (model.length === 0) throw new Error('No model is configured for this provider.');
      // Main-authoritative hard budget stop. The renderer also gates its launch
      // buttons, but an agent run is the most expensive thing the app can do and
      // several surfaces can start one (Build, God Mode, durable tasks), so the
      // refusal lives here where every path must pass. Only 'block' enforcement
      // refuses; 'warn' and 'off' are advisory and never stop work.
      await assertAiSpendWithinBudget();
      assertPreflightActive();
      let maxIterations: number | undefined;
      if (o.maxIterations !== undefined) {
        const requestedMaxIterations = o.maxIterations;
        if (
          typeof requestedMaxIterations !== 'number' ||
          !Number.isInteger(requestedMaxIterations) ||
          requestedMaxIterations < 1 ||
          requestedMaxIterations > 10
        ) {
          throw new Error('God Mode maximum iterations must be an integer from 1 through 10.');
        }
        const durableJob = (await godModeJobsService.listGodModeJobs(root)).find(
          (job) => job.id === id && job.ownerWindowId === sender.id && job.status === 'running',
        );
        if (!durableJob || durableJob.maxIterations !== requestedMaxIterations) {
          throw new Error('The God Mode iteration budget is not bound to this claimed job.');
        }
        maxIterations = durableJob.maxIterations;
      }
      const requestedBaseUrl = typeof o.baseUrl === 'string' ? o.baseUrl : '';
      const headers = toHeaderMap(o.headers);
      const credential = await secretsService.resolveAiCredential(provider, requestedBaseUrl);
      assertPreflightActive();
      const preset = typeof o.preset === 'string' ? o.preset : 'coder';
      const rawPriorTurnSummary = typeof o.priorTurnSummary === 'string' ? o.priorTurnSummary : '';
      const priorTurnSummary = rawPriorTurnSummary.replace(/\0/g, '').trim().slice(0, 4000);
      const resumeRunId = typeof o.resumeRunId === 'string' ? o.resumeRunId : undefined;
      if (resumeRunId === id) throw new Error('A resumed run must use a new run id.');
      const settings = (await readSettings()) as Record<string, unknown>;
      assertPreflightActive();
      const autonomy = parseAutonomy(settings['ai.approval.autonomy']);
      const policy: ApprovalPolicy = {
        autonomy,
        overrides: {},
        confirmHighRisk: true,
      };
      await assertWorkspaceTrusted(root);
      assertPreflightActive();
      void appendAudit(
        'agent.run',
        `Agent run started (preset: ${preset}, autonomy: ${policy.autonomy})`,
      );
      void recordEvent('analytics', 'agent_run', { preset });
      // Build now shares Ask's provider resolution: optional resolved fallbacks and
      // the opt-in reasoning config, so a flaky primary or reasoning-only model no
      // longer fails every agent run.
      const fallbacks = await resolveAgentFallbackAttempts(provider, model, settings);
      assertPreflightActive();
      // The auto-approval gate is synchronous inside the loop, so the remembered
      // folder grants must already be in memory before the first action.
      await ensureWriteConsentLoaded();
      assertPreflightActive();
      const agentReasoning: ReasoningConfig = {
        enabled: settings['ai.reasoning.enabled'] === true,
        effort: parseReasoningEffort(settings['ai.reasoning.effort']),
        visibility: 'summary',
      };
      await runAgent(
        {
          id,
          provider,
          model,
          baseUrl: credential.baseUrl,
          headers,
          apiKey: credential.apiKey,
          credentialRevision: credential.revision,
          ownerId: sender.id,
          root,
          task,
          preset,
          policy,
          reasoning: agentReasoning,
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          ...(maxIterations ? { maxIterations } : {}),
          ...(priorTurnSummary ? { priorTurnSummary } : {}),
          ...(resumeRunId ? { resumeRunId } : {}),
        },
        (agentEvent) => {
          void godModeJobsService
            .recordGodModeAgentEvent(agentEvent, sender.id)
            .catch((error: unknown) => {
              log.warn('Could not persist God Mode agent evidence', {
                reason: error instanceof Error ? error.message : String(error),
              });
            });
          if (agentEvent.outcome) terminalDelivered = true;
          if (sender.isDestroyed()) return false;
          sender.send(IPC.agentEvent, agentEvent);
          return true;
        },
      );
    } catch (error) {
      if (terminalDelivered || sender.isDestroyed()) throw error;
      const at = Date.now();
      const outcome = preflight?.signal.aborted ? 'cancelled' : 'failed';
      const text =
        outcome === 'cancelled'
          ? 'Cancelled.'
          : error instanceof Error
            ? error.message
            : String(error);
      sender.send(IPC.agentEvent, {
        id,
        root: eventRoot,
        at,
        kind: 'error',
        step: 0,
        text,
        outcome,
        summary: {
          root: eventRoot,
          at,
          outcome,
          elapsedMs: Math.max(0, at - requestedAt),
          toolCalls: 0,
          filesChanged: 0,
          checkpointsCreated: 0,
          verification: 'not-run',
          modelTrail: eventModel ? [eventModel] : [],
        },
      });
      terminalDelivered = true;
    } finally {
      // A run that ends without delivering a terminal event leaves the panel showing
      // "working" forever, which is exactly what a user reported after the agent had
      // visibly finished. Main owns the run's lifetime, so reaching here IS the end of
      // it: if nothing terminal went out, one is emitted now. The failure path above
      // already sent its own and set the flag, so this never double-settles.
      if (!terminalDelivered && !sender.isDestroyed()) {
        const at = Date.now();
        const outcome = preflight?.signal.aborted ? 'cancelled' : 'completed';
        sender.send(IPC.agentEvent, {
          id,
          root: eventRoot,
          at,
          kind: outcome === 'completed' ? 'final' : 'error',
          step: 0,
          text: outcome === 'completed' ? '' : 'Cancelled.',
          outcome,
          summary: {
            root: eventRoot,
            at,
            outcome,
            elapsedMs: Math.max(0, at - requestedAt),
            toolCalls: 0,
            filesChanged: 0,
            checkpointsCreated: 0,
            verification: 'not-run',
            modelTrail: eventModel ? [eventModel] : [],
          },
        });
        terminalDelivered = true;
      }
      preflight?.finish();
      sender.removeListener('destroyed', onSenderDestroyed);
      if (agentBindings.get(id) === binding) agentBindings.delete(id);
    }
  });

  ipcMain.handle(IPC.agentCancel, (event, id: unknown) => {
    const runId = assertString(id, 'id');
    const binding = agentBindings.get(runId);
    if (binding && binding.owner !== event.sender) {
      throw new Error('This agent run is owned by another renderer.');
    }
    if (binding) cancelAgent(runId, event.sender.id);
    else if (!cancelAgentForOwner(runId, event.sender.id)) {
      // Preserve cancel-before-registration without creating a cross-owner tombstone.
      cancelAgent(runId, event.sender.id);
    }
  });

  ipcMain.handle(IPC.agentApprovalShown, (event, id: unknown, approvalToken: unknown) => {
    const acknowledged = acknowledgeAgentApproval(
      assertString(id, 'id'),
      assertString(approvalToken, 'approvalToken'),
      event.sender.id,
    );
    if (!acknowledged) throw new Error('This approval preview is no longer active.');
  });

  ipcMain.handle(
    IPC.agentApprove,
    async (event, id: unknown, approvalToken: unknown, approved: unknown, remember: unknown) => {
      const runId = assertString(id, 'id');
      const token = assertString(approvalToken, 'approvalToken');
      if (approved !== true) {
        const rejected = approveAgent(runId, token, false, event.sender.id);
        if (!rejected) throw new Error('This approval preview is no longer active.');
        void appendAudit('agent.approval', 'Agent action rejected');
        return;
      }
      const descriptor = getAgentNativeApprovalDescriptor(runId, token, event.sender.id);
      if (!descriptor) throw new Error('This approval preview is no longer active.');
      // A remember scope is accepted only if Main itself offers it for THIS preview,
      // so a renderer cannot widen an approval beyond what was previewed. Staged
      // before the dialog so the settlement below keeps its exact audited shape.
      const scope = stageAgentApprovalScope(
        runId,
        token,
        event.sender.id,
        parseCommandConsentScope(remember),
      );
      const question =
        scope === 'command'
          ? `Allow this exact ${descriptor.tool} action, and remember it for this folder?`
          : scope === 'program'
            ? `Allow this ${descriptor.tool} action, and always allow this program in this folder?`
            : `Allow this exact ${descriptor.tool} action once?`;
      try {
        // The Build card already showed this exact action and took a decision, so a
        // granted consent settles here instead of asking the same question twice.
        await requireNativeGodModeApproval(
          event.sender,
          true,
          'Approve Agent Action',
          question,
          descriptor.detail,
          { preauthorizable: true },
        );
      } catch (error) {
        approveAgent(runId, token, false, event.sender.id);
        throw error;
      }
      const accepted = approveAgent(runId, token, true, event.sender.id);
      if (!accepted) throw new Error('This approval preview is no longer active.');
      void appendAudit('agent.approval', `Agent action approved: ${descriptor.sha256}`);
      // A remembered scope is a separate, auditable fact from the approval itself.
      if (scope !== 'once') {
        void appendAudit(
          'agent.approval',
          `Agent command approval remembered (${scope}): ${descriptor.sha256}`,
        );
      }
    },
  );

  ipcMain.handle(IPC.agentTasks, async (event, root: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    return listAgentTasks(event.sender.id, canonicalRoot);
  });
  ipcMain.handle(IPC.agentRunsList, async (_event, root: unknown) =>
    listAgentRuns(await trustedWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.agentRunsClear, async (_event, root: unknown) =>
    clearAgentRuns(await trustedWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.agentRunsResumable, async (_event, root: unknown) =>
    listResumableAgentRuns(await trustedWorkspaceRoot(root)),
  );
  ipcMain.handle(
    IPC.agentRunBranch,
    async (_event, root: unknown, id: unknown, index: unknown, guidance: unknown) => {
      const canonicalRoot = await trustedWorkspaceRoot(root);
      return typeof id === 'string' && typeof index === 'number'
        ? branchAgentRun(
            id,
            canonicalRoot,
            index,
            typeof guidance === 'string' ? guidance : undefined,
          )
        : null;
    },
  );
  ipcMain.handle(
    IPC.agentRunReinvoke,
    async (
      _event,
      root: unknown,
      id: unknown,
      kind: unknown,
      branchIndex: unknown,
      guidance: unknown,
    ) => {
      const canonicalRoot = await trustedWorkspaceRoot(root);
      if (typeof id !== 'string' || (kind !== 'resume' && kind !== 'branch')) return null;
      return reinvokeAgentRun(id, canonicalRoot, kind, {
        ...(typeof branchIndex === 'number' ? { branchIndex } : {}),
        ...(typeof guidance === 'string' ? { guidance } : {}),
      });
    },
  );
  onAgentTaskUpdate((task) => {
    const ownerId = agentRunOwner(task.id);
    if (ownerId === null) return;
    void godModeJobsService.reconcileGodModeAgentTask(task, ownerId).catch((error: unknown) => {
      log.warn('Could not reconcile God Mode agent task', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    const ownerWindow = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === ownerId,
    );
    if (ownerWindow && !ownerWindow.webContents.isDestroyed()) {
      ownerWindow.webContents.send(IPC.agentTaskUpdate, task);
    }
  });

  // Repository-shared agents. Listing requires trust and only REPORTS what the repo
  // declares — enabling an agent is an explicit renderer-side decision bound to the
  // content digest, because a persona becomes system-level instructions.
  ipcMain.handle(IPC.workspaceAgentsList, async (_event, root: unknown) =>
    listWorkspaceAgents(await trustedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.workspaceAgentsShare, async (_event, root: unknown, id: unknown) => {
    const canonicalRoot = await trustedWorkspaceRoot(root);
    const agent = await getCustomAgent(assertString(id, 'id'));
    if (!agent) throw new Error('That custom agent no longer exists.');
    return shareWorkspaceAgent(canonicalRoot, agent);
  });

  ipcMain.handle(IPC.customAgentsList, () => listCustomAgents());
  ipcMain.handle(IPC.customAgentsSave, (_event, input: unknown) => saveCustomAgent(input));
  ipcMain.handle(IPC.customAgentsDelete, (_event, id: unknown) =>
    deleteCustomAgent(assertString(id, 'id')),
  );

  ipcMain.handle(IPC.auditRead, (_event, limit: unknown) =>
    readAudit(typeof limit === 'number' ? limit : undefined),
  );
  ipcMain.handle(IPC.auditVerify, () => verifyAudit());
  ipcMain.handle(IPC.autoUpdateCheck, () => checkForUpdates());

  // Production auto-update system (UPDATEFEATURE) — Supabase-driven check/download/install.
  ipcMain.handle(IPC.updateCheck, () => checkForUpdate());
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate());
  ipcMain.handle(IPC.updateInstall, () => installUpdate());
  ipcMain.handle(IPC.updateGetState, () => getUpdateSnapshot());
  // Bridge update lifecycle events to every renderer window (drives the update UI).
  onUpdateEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.updateStatus, event);
    }
  });

  ipcMain.handle(IPC.memoryList, () => listMemories());
  ipcMain.handle(IPC.memoryAdd, (_event, text: unknown, scope: unknown, workspaceKey: unknown) =>
    addMemory(
      assertString(text, 'text'),
      scope === 'global' ? 'global' : 'workspace',
      typeof workspaceKey === 'string' ? workspaceKey : null,
    ),
  );
  ipcMain.handle(IPC.memoryUpdate, (_event, id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    return updateMemory(assertString(id, 'id'), {
      ...(typeof p.text === 'string' ? { text: p.text } : {}),
      ...(typeof p.pinned === 'boolean' ? { pinned: p.pinned } : {}),
    });
  });
  ipcMain.handle(IPC.memoryDelete, (_event, id: unknown) => deleteMemory(assertString(id, 'id')));
  ipcMain.handle(IPC.memoryClear, () => clearMemories());
  ipcMain.handle(IPC.memorySelect, (_event, query: unknown, workspaceKey: unknown) =>
    selectRelevant(
      assertString(query, 'query'),
      typeof workspaceKey === 'string' ? workspaceKey : null,
    ),
  );

  ipcMain.handle(IPC.telemetryConsent, () => getConsent());
  ipcMain.handle(
    IPC.telemetryRecord,
    (_event, category: unknown, type: unknown, props: unknown) => {
      const cat =
        category === 'crashReports' || category === 'analytics' || category === 'performance'
          ? category
          : null;
      if (!cat) return Promise.resolve();
      return recordEvent(cat, assertString(type, 'type'), props);
    },
  );
  ipcMain.handle(IPC.telemetryRead, () => readTelemetry());
  ipcMain.handle(IPC.telemetryClear, () => clearTelemetry());

  ipcMain.handle(IPC.featureFlagsAll, () => getAllFlags());

  ipcMain.handle(IPC.dataExportBuild, async () => JSON.stringify(await buildExport(), null, 2));
  ipcMain.handle(IPC.dataExportSave, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    return saveExport(owner);
  });

  ipcMain.handle(IPC.aiReview, async (_event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const provider = assertString(o.provider, 'provider');
    const model = assertString(o.model, 'model');
    const code = assertString(o.code, 'code');
    const label = typeof o.label === 'string' ? o.label : 'code';
    if (model.length === 0) throw new Error('No model is configured for this provider.');
    const requestedBaseUrl = typeof o.baseUrl === 'string' ? o.baseUrl : '';
    const headers = toHeaderMap(o.headers);
    const credential = await secretsService.resolveAiCredential(provider, requestedBaseUrl);
    return reviewCode(
      {
        provider,
        model,
        baseUrl: credential.baseUrl,
        headers,
        apiKey: credential.apiKey,
        credentialRevision: credential.revision,
      },
      code,
      label,
    );
  });

  ipcMain.handle(IPC.aiCompose, async (_event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const provider = assertString(o.provider, 'provider');
    const model = assertString(o.model, 'model');
    const instruction = assertString(o.instruction, 'instruction');
    if (model.length === 0) throw new Error('No model is configured for this provider.');
    if (instruction.trim().length === 0) throw new Error('Describe the change to compose.');
    const requestedBaseUrl = typeof o.baseUrl === 'string' ? o.baseUrl : '';
    const headers = toHeaderMap(o.headers);
    const context = typeof o.context === 'string' ? o.context : undefined;
    const credential = await secretsService.resolveAiCredential(provider, requestedBaseUrl);
    return composeEdits(
      {
        provider,
        model,
        baseUrl: credential.baseUrl,
        headers,
        apiKey: credential.apiKey,
        credentialRevision: credential.revision,
      },
      instruction,
      context,
    );
  });

  ipcMain.handle(IPC.aiComplete, async (event, input: unknown) => {
    const startedAt = Date.now();
    const value = (input ?? {}) as Record<string, unknown>;
    const requestId = typeof value.requestId === 'string' ? value.requestId : '';
    const documentVersion = typeof value.documentVersion === 'number' ? value.documentVersion : 0;
    try {
      bindCompletionOwner(event.sender);
      const documentUri = await authorizedDocumentUri(value.documentUri);
      const completionRoot = authorizedWorkspaceRootForPath(fileURLToPath(documentUri));
      if (!completionRoot)
        throw new Error('Completion document is not inside an authorized workspace.');
      await assertWorkspaceTrusted(completionRoot);
      const trigger =
        value.trigger === 'explicit' || value.trigger === 'next-edit' ? value.trigger : 'typing';
      const request: PredictiveCompletionInput = {
        requestId,
        documentUri,
        documentVersion,
        prefix: typeof value.prefix === 'string' ? value.prefix : '',
        suffix: typeof value.suffix === 'string' ? value.suffix : '',
        language: typeof value.language === 'string' ? value.language : '',
        trigger,
        ...(typeof value.maxLines === 'number' ? { maxLines: value.maxLines } : {}),
      };
      const settings = (await readSettings()) as Record<string, unknown>;
      if (settings['ai.completion.enabled'] === false) {
        return runPredictiveCompletion(
          event.sender.id,
          request,
          'disabled',
          async () => '',
          completionRoot,
        );
      }
      const providerRaw = settings['ai.provider'];
      const provider = typeof providerRaw === 'string' ? providerRaw : 'anthropic';
      const str = (candidate: unknown): string =>
        typeof candidate === 'string' ? candidate.trim() : '';
      let model = '';
      let baseUrl = '';
      let headers: Record<string, string> = {};
      if (provider === 'custom') {
        model = str(settings['ai.custom.model']);
        baseUrl = str(settings['ai.custom.baseUrl']);
        try {
          headers = toHeaderMap(JSON.parse(str(settings['ai.custom.headers']) || '{}'));
        } catch {
          headers = {};
        }
      } else {
        model = str(settings['ai.model']) || (DEFAULT_COMPLETION_MODELS[provider] ?? '');
        baseUrl = str(settings['ai.baseUrl']);
      }
      if (!model) {
        return runPredictiveCompletion(
          event.sender.id,
          request,
          `${provider}:none`,
          async () => '',
          completionRoot,
        );
      }
      const credential = await secretsService.resolveAiCredential(provider, baseUrl);
      return runPredictiveCompletion(
        event.sender.id,
        request,
        `${provider}:${model}:${credential.revision}`,
        (signal) =>
          completeCode(
            {
              provider,
              model,
              baseUrl: credential.baseUrl,
              headers,
              apiKey: credential.apiKey,
              credentialRevision: credential.revision,
            },
            request.prefix,
            request.suffix,
            request.language,
            signal,
          ),
        completionRoot,
      );
    } catch {
      return {
        requestId,
        documentVersion,
        text: '',
        elapsedMs: Date.now() - startedAt,
        cached: false,
        stale: false,
      };
    }
  });
  ipcMain.handle(IPC.aiCompleteCancel, (event, requestId: unknown) => {
    cancelPredictiveCompletion(event.sender.id, requestId);
  });
  ipcMain.handle(IPC.aiCompleteFeedback, (event, input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>;
    const kind = value.kind;
    if (
      kind !== 'accepted' &&
      kind !== 'accepted-partial' &&
      kind !== 'dismissed' &&
      kind !== 'stale'
    ) {
      return;
    }
    const feedback: PredictionFeedback = {
      requestId: assertString(value.requestId, 'requestId'),
      kind,
      acceptedCharacters:
        typeof value.acceptedCharacters === 'number'
          ? Math.max(0, Math.floor(value.acceptedCharacters))
          : 0,
      at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : Date.now(),
    };
    recordPredictionFeedback(event.sender.id, feedback);
  });
  ipcMain.handle(IPC.aiCompleteMetrics, () => predictionMetrics());

  ipcMain.handle(
    IPC.aiInlineEdit,
    async (_event, input: unknown): Promise<{ text: string; error?: string }> => {
      // User-initiated (unlike ghost text), so return a helpful error rather than
      // silently doing nothing when the model/key is not configured.
      const o = (input ?? {}) as Record<string, unknown>;
      const instruction = typeof o.instruction === 'string' ? o.instruction.trim() : '';
      const selection = typeof o.selection === 'string' ? o.selection : '';
      const language = typeof o.language === 'string' ? o.language : '';
      if (instruction.length === 0) return { text: '', error: 'Describe the edit to make.' };
      try {
        const settings = (await readSettings()) as Record<string, unknown>;
        const providerRaw = settings['ai.provider'];
        const provider = typeof providerRaw === 'string' ? providerRaw : 'anthropic';
        const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
        let model = '';
        let baseUrl = '';
        let headers: Record<string, string> = {};
        if (provider === 'custom') {
          model = str(settings['ai.custom.model']);
          baseUrl = str(settings['ai.custom.baseUrl']);
          try {
            headers = toHeaderMap(JSON.parse(str(settings['ai.custom.headers']) || '{}'));
          } catch {
            headers = {};
          }
        } else {
          model = str(settings['ai.model']) || (DEFAULT_COMPLETION_MODELS[provider] ?? '');
          baseUrl = str(settings['ai.baseUrl']);
        }
        if (model.length === 0) {
          return { text: '', error: 'No AI model is configured. Set one in the AI panel.' };
        }
        const credential = await secretsService.resolveAiCredential(provider, baseUrl);
        const text = await editSelection(
          {
            provider,
            model,
            baseUrl: credential.baseUrl,
            headers,
            apiKey: credential.apiKey,
            credentialRevision: credential.revision,
          },
          {
            instruction,
            selection,
            language,
            ...(typeof o.filename === 'string' ? { filename: o.filename } : {}),
            ...(typeof o.prefix === 'string' ? { prefix: o.prefix } : {}),
            ...(typeof o.suffix === 'string' ? { suffix: o.suffix } : {}),
          },
        );
        return { text };
      } catch (e) {
        return { text: '', error: e instanceof Error ? e.message : 'Inline edit failed.' };
      }
    },
  );

  ipcMain.handle(
    IPC.aiInlineChat,
    async (_event, input: unknown): Promise<{ text: string; error?: string }> => {
      const o = (input ?? {}) as Record<string, unknown>;
      const question = typeof o.question === 'string' ? o.question.trim() : '';
      const selection = typeof o.selection === 'string' ? o.selection : '';
      const language = typeof o.language === 'string' ? o.language : '';
      if (question.length === 0) return { text: '', error: 'Ask a question.' };
      try {
        const settings = (await readSettings()) as Record<string, unknown>;
        const providerRaw = settings['ai.provider'];
        const provider = typeof providerRaw === 'string' ? providerRaw : 'anthropic';
        const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
        let model = '';
        let baseUrl = '';
        let headers: Record<string, string> = {};
        if (provider === 'custom') {
          model = str(settings['ai.custom.model']);
          baseUrl = str(settings['ai.custom.baseUrl']);
          try {
            headers = toHeaderMap(JSON.parse(str(settings['ai.custom.headers']) || '{}'));
          } catch {
            headers = {};
          }
        } else {
          model = str(settings['ai.model']) || (DEFAULT_COMPLETION_MODELS[provider] ?? '');
          baseUrl = str(settings['ai.baseUrl']);
        }
        if (model.length === 0) {
          return { text: '', error: 'No AI model is configured. Set one in the AI panel.' };
        }
        const credential = await secretsService.resolveAiCredential(provider, baseUrl);
        const text = await askInline(
          {
            provider,
            model,
            baseUrl: credential.baseUrl,
            headers,
            apiKey: credential.apiKey,
            credentialRevision: credential.revision,
          },
          {
            question,
            selection,
            language,
            ...(typeof o.filename === 'string' ? { filename: o.filename } : {}),
            ...(typeof o.prefix === 'string' ? { prefix: o.prefix } : {}),
            ...(typeof o.suffix === 'string' ? { suffix: o.suffix } : {}),
          },
        );
        return { text };
      } catch (e) {
        return { text: '', error: e instanceof Error ? e.message : 'Inline chat failed.' };
      }
    },
  );

  ipcMain.handle(
    IPC.aiCommitMessage,
    async (_event, input: unknown): Promise<{ text: string; error?: string }> => {
      const o = (input ?? {}) as Record<string, unknown>;
      const diff = typeof o.diff === 'string' ? o.diff : '';
      if (diff.trim().length === 0) return { text: '', error: 'No staged changes to summarize.' };
      try {
        const settings = (await readSettings()) as Record<string, unknown>;
        const providerRaw = settings['ai.provider'];
        const provider = typeof providerRaw === 'string' ? providerRaw : 'anthropic';
        const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
        let model = '';
        let baseUrl = '';
        let headers: Record<string, string> = {};
        if (provider === 'custom') {
          model = str(settings['ai.custom.model']);
          baseUrl = str(settings['ai.custom.baseUrl']);
          try {
            headers = toHeaderMap(JSON.parse(str(settings['ai.custom.headers']) || '{}'));
          } catch {
            headers = {};
          }
        } else {
          model = str(settings['ai.model']) || (DEFAULT_COMPLETION_MODELS[provider] ?? '');
          baseUrl = str(settings['ai.baseUrl']);
        }
        if (model.length === 0) {
          return { text: '', error: 'No AI model is configured. Set one in the AI panel.' };
        }
        const credential = await secretsService.resolveAiCredential(provider, baseUrl);
        const text = await generateCommitMessage(
          {
            provider,
            model,
            baseUrl: credential.baseUrl,
            headers,
            apiKey: credential.apiKey,
            credentialRevision: credential.revision,
          },
          diff,
        );
        return { text };
      } catch (e) {
        return { text: '', error: e instanceof Error ? e.message : 'Commit message failed.' };
      }
    },
  );

  ipcMain.handle(IPC.workflowsList, () => listWorkflows());
  ipcMain.handle(IPC.workflowsSave, (_event, wf: unknown) => saveWorkflow(wf));
  ipcMain.handle(IPC.workflowsDelete, (_event, id: unknown) =>
    deleteWorkflow(assertString(id, 'id')),
  );
  ipcMain.handle(IPC.workflowsSetEnabled, (_event, id: unknown, enabled: unknown) =>
    setWorkflowEnabled(assertString(id, 'id'), enabled === true),
  );

  ipcMain.handle(IPC.mcpListServers, async (_event, root: unknown) => {
    await authorizedWorkspaceRoot(root);
    return mcpListServers();
  });
  ipcMain.handle(IPC.mcpSaveServer, async (_event, root: unknown, cfg: unknown) => {
    await trustedWorkspaceRoot(root);
    return mcpSaveServer(cfg);
  });
  ipcMain.handle(IPC.mcpDeleteServer, async (_event, root: unknown, id: unknown) => {
    await authorizedWorkspaceRoot(root);
    return mcpDeleteServer(assertString(id, 'id'));
  });
  ipcMain.handle(
    IPC.mcpSetEnabled,
    async (_event, root: unknown, id: unknown, enabled: unknown) => {
      if (enabled === true) await trustedWorkspaceRoot(root);
      else await authorizedWorkspaceRoot(root);
      return mcpSetServerEnabled(assertString(id, 'id'), enabled === true);
    },
  );
  ipcMain.handle(IPC.mcpConnect, async (event, root: unknown, id: unknown) => {
    bindMcpOwner(event.sender);
    const canonicalRoot = await trustedWorkspaceRoot(root);
    const serverId = assertString(id, 'id');
    const approval = await prepareMcpConnectionApproval(canonicalRoot, serverId);
    await requireNativeGodModeApproval(
      event.sender,
      true,
      'Start external MCP server?',
      'Start this exact external process in the trusted workspace?',
      approval.detail,
    );
    await assertWorkspaceTrusted(canonicalRoot);
    return mcpConnectServer(canonicalRoot, serverId, event.sender.id, approval);
  });
  ipcMain.handle(IPC.mcpDisconnect, async (event, root: unknown, id: unknown) => {
    await mcpDisconnectServerForWorkspace(
      await authorizedWorkspaceRoot(root),
      assertString(id, 'id'),
      event.sender.id,
    );
  });
  ipcMain.handle(IPC.mcpDisconnectWorkspace, async (event, root: unknown) => {
    await mcpDisconnectForOwnerWorkspace(event.sender.id, await authorizedWorkspaceRoot(root));
  });
  ipcMain.handle(IPC.mcpConnections, async (event, root: unknown) =>
    mcpListConnections(await authorizedWorkspaceRoot(root), event.sender.id),
  );
  ipcMain.handle(
    IPC.mcpCallTool,
    async (event, root: unknown, serverId: unknown, tool: unknown, args: unknown) =>
      mcpCallTool(
        await trustedWorkspaceRoot(root),
        assertString(serverId, 'serverId'),
        assertString(tool, 'tool'),
        args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
        event.sender.id,
      ),
  );

  ipcMain.handle(IPC.rulesList, async (_event, root: unknown) =>
    listRules(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.rulesSaveGlobal, (_event, rule: unknown) => saveGlobalRule(rule));
  ipcMain.handle(IPC.rulesDeleteGlobal, (_event, id: unknown) =>
    deleteGlobalRule(assertString(id, 'id')),
  );
  ipcMain.handle(IPC.rulesProposeConventions, async (_event, root: unknown) =>
    proposeConventions(await authorizedOptionalWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.promptsList, () => listPrompts());
  ipcMain.handle(IPC.promptsSave, (_event, p: unknown) => savePrompt(p));
  ipcMain.handle(IPC.promptsDelete, (_event, id: unknown) => deletePrompt(assertString(id, 'id')));
  ipcMain.handle(IPC.promptsRecordUse, (_event, id: unknown) =>
    recordPromptUse(assertString(id, 'id')),
  );

  ipcMain.handle(IPC.extensionsList, async (_event, root: unknown) =>
    listExtensions(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(
    IPC.extensionsSetEnabled,
    async (_event, id: unknown, enabled: unknown, root: unknown) => {
      const extId = assertString(id, 'id');
      if (enabled === true) {
        return setExtensionEnabled(extId, true, await trustedWorkspaceRoot(root));
      }
      return setExtensionEnabled(extId, false, await authorizedOptionalWorkspaceRoot(root));
    },
  );
  ipcMain.handle(IPC.extensionsRegistry, async (_event, root: unknown) =>
    getExtensionRegistry(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.extensionsHostStatus, () => getActiveExtensionHosts());
  ipcMain.handle(IPC.extensionsRegistryIndex, async (_event, root: unknown) =>
    getRegistryIndex(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.extensionsInstall, async (_event, id: unknown, root: unknown) =>
    installExtension(assertString(id, 'id'), await authorizedOptionalWorkspaceRoot(root)),
  );

  // --- Open VSX marketplace -------------------------------------------------
  // Read-only registry browsing takes no workspace root: the catalogue is public and
  // identical regardless of what folder is open. Anything that mutates local state
  // resolves the root through the same authorization the rest of Main uses, so a
  // renderer cannot name a folder it was never granted.
  ipcMain.handle(IPC.marketReachable, () => registryReachable());
  ipcMain.handle(IPC.marketBrowse, (_event, query: unknown) =>
    searchExtensions(assertRecord(query, 'query')),
  );
  ipcMain.handle(IPC.marketDetail, (_event, id: unknown, version: unknown) =>
    registryExtensionDetail(
      assertString(id, 'id'),
      typeof version === 'string' ? version : undefined,
    ),
  );
  ipcMain.handle(IPC.marketVersions, (_event, id: unknown, offset: unknown, size: unknown) =>
    versionHistory(
      assertString(id, 'id'),
      typeof offset === 'number' ? offset : 0,
      typeof size === 'number' ? size : 25,
    ),
  );
  ipcMain.handle(IPC.marketReviews, (_event, id: unknown) =>
    extensionReviews(assertString(id, 'id')),
  );
  ipcMain.handle(IPC.marketPublisher, (_event, namespace: unknown) =>
    publisherDetail(assertString(namespace, 'namespace')),
  );
  ipcMain.handle(IPC.marketDocument, (_event, url: unknown) =>
    extensionDocument(assertString(url, 'url')),
  );

  ipcMain.handle(IPC.marketInstalled, async (_event, root: unknown) =>
    listInstalledExtensions(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketInstalledDetail, async (_event, id: unknown, root: unknown) =>
    installedExtensionDetail(assertString(id, 'id'), await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketInstall, async (event, id: unknown, version: unknown) => {
    const outcome = await marketInstallExtension(
      assertString(id, 'id'),
      typeof version === 'string' ? version : undefined,
    );
    notifyMarketplaceChanged(event.sender);
    return outcome;
  });
  ipcMain.handle(IPC.marketInstallFile, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return null;
    // Main runs the picker and installs the path it granted; the renderer never
    // supplies a filesystem path for this operation.
    const chosen = await openExtensionPackage(owner);
    if (!chosen) return null;
    const outcome = await installExtensionFromFile(chosen.path);
    notifyMarketplaceChanged(event.sender);
    return outcome;
  });
  ipcMain.handle(IPC.marketUninstall, async (event, id: unknown) => {
    await uninstallExtension(assertString(id, 'id'));
    notifyMarketplaceChanged(event.sender);
    return true;
  });
  ipcMain.handle(
    IPC.marketSetEnabled,
    async (event, id: unknown, enabled: unknown, target: unknown, root: unknown) => {
      const scope = target === 'workspace' ? 'workspace' : 'global';
      await setExtensionEnablement(
        assertString(id, 'id'),
        enabled === true,
        scope,
        await authorizedOptionalWorkspaceRoot(root),
      );
      notifyMarketplaceChanged(event.sender);
      return true;
    },
  );
  ipcMain.handle(IPC.marketSetAutoUpdate, async (_event, id: unknown, enabled: unknown) => {
    await setExtensionAutoUpdate(assertString(id, 'id'), enabled === true);
    return true;
  });
  ipcMain.handle(IPC.marketSetAutoUpdateAll, async (_event, enabled: unknown) => {
    await setAutoUpdateAll(enabled === true);
    return true;
  });
  ipcMain.handle(IPC.marketCheckUpdates, (_event, force: unknown) =>
    marketCheckForUpdates(force === true),
  );
  ipcMain.handle(IPC.marketUpdateAll, async (event) => {
    const outcome = await updateAllExtensions(false);
    notifyMarketplaceChanged(event.sender);
    return outcome;
  });

  ipcMain.handle(IPC.marketContributions, async (_event, root: unknown) =>
    buildContributionCatalog(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketLoadTheme, async (_event, key: unknown, root: unknown) =>
    loadContributedTheme(assertString(key, 'key'), await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketLoadIconTheme, async (_event, key: unknown, root: unknown) =>
    loadIconTheme(assertString(key, 'key'), await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketSnippets, async (_event, language: unknown, root: unknown) =>
    loadSnippets(assertString(language, 'language'), await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.marketLoadGrammar, async (_event, scopeName: unknown, root: unknown) =>
    loadGrammar(assertString(scopeName, 'scopeName'), await authorizedOptionalWorkspaceRoot(root)),
  );

  // --- Extension hosts ---------------------------------------------------
  // Every one of these re-derives the workspace root through the same authorization the rest
  // of this file uses. The renderer names an extension; it never names a process, a path, or
  // an entry point.
  ipcMain.handle(IPC.hostList, async (_event, root: unknown) =>
    listExtensionHosts(await authorizedOptionalWorkspaceRoot(root)),
  );
  ipcMain.handle(
    IPC.hostSetConsent,
    async (_event, id: unknown, granted: unknown, root: unknown) => {
      await setExtensionHostConsent(
        assertString(id, 'id'),
        granted === true,
        await authorizedOptionalWorkspaceRoot(root),
      );
      return true;
    },
  );
  ipcMain.handle(IPC.hostStop, async (_event, id: unknown) => {
    await stopExtensionHost(assertString(id, 'id'));
    return true;
  });
  ipcMain.handle(IPC.hostRestart, async (_event, id: unknown) => {
    await restartExtensionHost(assertString(id, 'id'));
    return true;
  });
  ipcMain.handle(
    IPC.hostRunCommand,
    async (_event, command: unknown, args: unknown, root: unknown) =>
      runExtensionCommand(
        assertString(command, 'command'),
        Array.isArray(args) ? args.slice(0, 16) : [],
        await authorizedOptionalWorkspaceRoot(root),
      ),
  );
  ipcMain.handle(IPC.hostStatusItems, () => listHostStatusBarItems());
  ipcMain.handle(IPC.hostDiagnostics, () => listHostDiagnostics());
  ipcMain.handle(IPC.hostOutput, (_event, id: unknown) => readHostOutput(assertString(id, 'id')));
  ipcMain.handle(
    IPC.hostActiveEditor,
    async (_event, path: unknown, languageId: unknown, root: unknown) => {
      const workspaceRoot = await authorizedOptionalWorkspaceRoot(root);
      // A null path is "no editor is active", which is a legitimate state and must not be
      // treated as a path to authorize.
      const authorized =
        typeof path === 'string' && path.length > 0
          ? await assertAuthorizedPath(path, { allowMissing: true })
          : null;
      reportActiveEditor(
        authorized,
        typeof languageId === 'string' ? languageId : null,
        workspaceRoot,
      );
      return true;
    },
  );
  // Triggers the *user interface* can legitimately raise. Startup, language and command
  // activation each have their own path, and the main-process subsystems that own the
  // remaining triggers (debug, tasks, authentication, deep links) call the activator
  // directly — so a renderer message can never claim one of those on their behalf.
  const RENDERER_ACTIVATION_KINDS = [
    'view',
    'webviewPanel',
    'customEditor',
    'notebook',
    'search',
    'terminalProfile',
    'editSession',
  ] as const;
  ipcMain.handle(IPC.hostActivate, async (_event, kind: unknown, value: unknown, root: unknown) => {
    const requested = typeof kind === 'string' ? kind : '';
    const allowed = RENDERER_ACTIVATION_KINDS.find((candidate) => candidate === requested);
    if (allowed === undefined) return [];
    return activateForTrigger(
      allowed,
      typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null,
      await authorizedOptionalWorkspaceRoot(root),
    );
  });

  ipcMain.handle(IPC.hostPromptReply, (_event, id: unknown, value: unknown) => {
    resolveHostPrompt(typeof id === 'number' ? id : -1, typeof value === 'string' ? value : null);
    return true;
  });

  // --- Extension webviews (PRD Phase 4) ----------------------------------
  // The renderer owns the iframes and nothing else: it names a handle, and Main decides what
  // that handle may do. No path, no HTML and no origin is ever taken from these messages.
  ipcMain.handle(IPC.webviewList, () => listWebviewSnapshots());
  ipcMain.handle(IPC.webviewFrameMessage, async (_event, handle: unknown, message: unknown) => {
    await receiveFrameMessage(assertString(handle, 'handle'), message);
    return true;
  });
  ipcMain.handle(
    IPC.webviewVisibility,
    (_event, handle: unknown, visible: unknown, active: unknown) => {
      setWebviewVisibility(assertString(handle, 'handle'), visible === true, active === true);
      return true;
    },
  );
  ipcMain.handle(IPC.webviewClose, (_event, handle: unknown) => {
    closeWebview(assertString(handle, 'handle'));
    return true;
  });
  ipcMain.handle(IPC.webviewReveal, (_event, handle: unknown) =>
    revealRestoredPanel(assertString(handle, 'handle')),
  );
  ipcMain.handle(IPC.webviewResolveView, (_event, viewType: unknown) =>
    ensureWebviewView(assertString(viewType, 'viewType')),
  );
  ipcMain.handle(IPC.webviewRestore, async () => {
    await restorePersistedWebviews();
    return true;
  });
  ipcMain.handle(IPC.webviewTheme, (_event, payload: unknown) => {
    const record =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const kind = record.kind;
    setWebviewTheme({
      kind:
        kind === 'light' || kind === 'high-contrast' || kind === 'high-contrast-light'
          ? kind
          : 'dark',
      name: typeof record.name === 'string' ? record.name : '',
      variables: record.variables,
    });
    return true;
  });

  // --- Workbench views (PRD Phase 5) --------------------------------------
  // The renderer draws rows and reports intents. It never holds an element, a provider or a path:
  // a row is an opaque handle, an icon is already a `data:` URL, and every command id a menu offers
  // is re-checked in Main against the menu that was actually resolved.
  ipcMain.handle(IPC.viewsWorkbench, async () => {
    await ensureViewRegistry();
    return workbenchSnapshot();
  });
  ipcMain.handle(IPC.viewsTree, (_event, viewId: unknown, viewportHeight: unknown) =>
    treeSnapshot(
      assertString(viewId, 'viewId'),
      typeof viewportHeight === 'number' && Number.isFinite(viewportHeight)
        ? Math.min(4000, Math.max(0, viewportHeight))
        : 600,
    ),
  );
  ipcMain.handle(IPC.viewsVisibility, async (_event, viewId: unknown, visible: unknown) => {
    await setViewVisible(assertString(viewId, 'viewId'), visible === true);
    return true;
  });
  ipcMain.handle(
    IPC.viewsExpand,
    async (_event, viewId: unknown, handle: unknown, expanded: unknown) => {
      const view = assertString(viewId, 'viewId');
      if (handle === null) {
        collapseAll(view);
        return true;
      }
      const row = assertString(handle, 'handle');
      if (expanded === true) await expandRow(view, row);
      else collapseRow(view, row);
      return true;
    },
  );
  ipcMain.handle(IPC.viewsSelect, (_event, viewId: unknown, handles: unknown) => {
    const list = Array.isArray(handles)
      ? handles.filter((entry): entry is string => typeof entry === 'string').slice(0, 500)
      : [];
    selectRows(assertString(viewId, 'viewId'), list);
    return true;
  });
  ipcMain.handle(IPC.viewsActivate, async (_event, viewId: unknown, handle: unknown) => {
    await activateRow(assertString(viewId, 'viewId'), assertString(handle, 'handle'));
    return true;
  });
  ipcMain.handle(IPC.viewsCheckbox, (_event, viewId: unknown, handle: unknown) => {
    toggleCheckbox(assertString(viewId, 'viewId'), assertString(handle, 'handle'));
    return true;
  });
  ipcMain.handle(IPC.viewsKey, async (_event, viewId: unknown, key: unknown) => {
    await handleTreeKey(assertString(viewId, 'viewId'), assertString(key, 'key'));
    return true;
  });
  ipcMain.handle(IPC.viewsResolveItem, async (_event, viewId: unknown, handle: unknown) => {
    await resolveTreeRow(assertString(viewId, 'viewId'), assertString(handle, 'handle'));
    return true;
  });
  ipcMain.handle(IPC.viewsLayout, async (_event, payload: unknown) => {
    const record =
      payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (typeof record.activeContainer === 'string' || record.activeContainer === null) {
      setActiveContainer(record.activeContainer as string | null);
    }
    if (typeof record.viewId === 'string') {
      if (typeof record.collapsed === 'boolean') {
        await setViewCollapsed(record.viewId, record.collapsed);
      }
      if (typeof record.size === 'number') setViewSize(record.viewId, record.size);
      if (record.size === null) setViewSize(record.viewId, null);
      if (typeof record.scrollTop === 'number') setViewScroll(record.viewId, record.scrollTop);
    }
    return true;
  });
  ipcMain.handle(IPC.viewsMenu, (_event, location: unknown, overlay: unknown) => {
    const where = assertString(location, 'location');
    const scope = menuOverlay(overlay);
    if (
      where === 'view/item/context' &&
      typeof scope.viewId === 'string' &&
      typeof scope.handle === 'string'
    ) {
      return resolveTreeItemMenu(scope.viewId, scope.handle);
    }
    if (where === 'view/title' && typeof scope.viewId === 'string') {
      return resolveViewTitleMenu(scope.viewId);
    }
    return resolveMenuFor(where, scope.keys);
  });
  ipcMain.handle(
    IPC.viewsMenuCommand,
    async (_event, location: unknown, command: unknown, overlay: unknown) => {
      const scope = menuOverlay(overlay);
      const keys =
        typeof scope.viewId === 'string' ? { ...scope.keys, view: scope.viewId } : scope.keys;
      await runMenuCommand(
        assertString(location, 'location'),
        assertString(command, 'command'),
        keys,
        scope.args,
      );
      return true;
    },
  );
  ipcMain.handle(IPC.viewsContext, (_event, values: unknown) => {
    applyWorkbenchContext(workbenchContextValues(values));
    return true;
  });

  // --- Language platform (PRD Phase 6) -------------------------------------
  // The renderer holds no provider and no extension identity: it asks for the registry, then asks for
  // a feature by name and gets a merged, already-sanitised result. Every payload is re-validated here
  // because a compromised renderer must not be able to reach a provider it was never offered.
  ipcMain.handle(IPC.languagesRegistry, async () => {
    await ensureLanguageContributions();
    return languageRegistrySnapshot();
  });
  ipcMain.handle(IPC.languagesProvide, (_event, payload: unknown) =>
    provideLanguageFeature(languageProvideInput(payload)),
  );
  ipcMain.handle(IPC.languagesCancel, (_event, requestId: unknown) =>
    cancelLanguageRequest(assertPositiveInteger(requestId, 'requestId')),
  );
  ipcMain.handle(IPC.languagesDocument, (_event, payload: unknown) =>
    reportDocumentEvent(languageDocumentInput(payload)),
  );
  ipcMain.handle(IPC.languagesApplyProviderEdit, (_event, payload: unknown) =>
    applyProviderWorkspaceEdit(providerEditInput(payload)),
  );

  // --- Extension runtime: terminals, tasks, debugging (PRD Phase 7) ---------
  // Pull channels only, plus one report channel. Everything that *happens* is pushed from Main on
  // the `runtime:*Changed` channels, so the renderer never polls and never holds extension state it
  // could disagree with. No channel here takes an extension id from the renderer: ownership is read
  // out of the registries in Main, which is the only place it is recorded.
  ipcMain.handle(IPC.runtimeTerminals, () => extensionTerminalList());
  ipcMain.handle(IPC.runtimeTerminalEvent, (_event, payload: unknown) => {
    const event = terminalEventInput(payload);
    switch (event.kind) {
      case 'opened':
        // A pane with no session id never became a terminal, so there is nothing to adopt.
        if (!event.sessionId) return false;
        reportTerminalOpened(
          event.handle,
          event.sessionId,
          event.processId ?? null,
          event.columns ?? 80,
          event.rows ?? 24,
        );
        return true;
      case 'closed':
        reportTerminalClosed(event.handle, event.exitCode ?? null);
        return true;
      case 'input':
        reportTerminalInput(event.handle, event.data ?? '');
        return true;
      case 'dimensions':
        reportTerminalDimensions(event.handle, event.columns ?? 80, event.rows ?? 24);
        return true;
      case 'active':
        reportActiveTerminal(event.sessionId ?? null);
        return true;
      case 'interacted':
        reportTerminalInteracted(event.handle);
        return true;
      case 'shell':
        reportTerminalShellIntegration(event.handle, event.available === true);
        return true;
      default:
        return false;
    }
  });
  ipcMain.handle(IPC.runtimeTasks, () => extensionTaskList());
  ipcMain.handle(IPC.runtimeDebugSessions, () => extensionDebugSessionList());
  ipcMain.handle(IPC.runtimeDebugConsole, (_event, sessionId: unknown) =>
    extensionDebugConsoleLines(assertString(sessionId, 'sessionId').slice(0, 128)),
  );

  ipcMain.handle(IPC.crashRecoveryNotice, () => getRecoveryNotice());

  ipcMain.handle(IPC.perfStartupReport, () => getStartupReport());
  ipcMain.handle(IPC.compatReport, () => getCompatReport());
  ipcMain.handle(IPC.perfMarkReady, () => {
    markDomReady();
    return true;
  });

  ipcMain.handle(IPC.syncStatus, () => getSyncStatus());
  ipcMain.handle(IPC.syncSnapshot, () => snapshotSettings());
  ipcMain.handle(IPC.syncFlush, () => flushQueue());

  ipcMain.handle(IPC.snapshotCapture, async (_event, paths: unknown, label: unknown) => {
    const list = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string')
      : [];
    if (list.length === 0) throw new Error('No files to snapshot.');
    const authorized = await Promise.all(
      list.map((path) => assertAuthorizedPath(path, { allowMissing: true })),
    );
    return serializeFileMutation(() =>
      captureFiles(authorized, typeof label === 'string' && label ? { label } : {}),
    );
  });
  ipcMain.handle(IPC.snapshotList, () => listCheckpoints());
  ipcMain.handle(IPC.snapshotRestore, (_event, runId: unknown) =>
    restoreCheckpoint(assertString(runId, 'runId')),
  );
  ipcMain.handle(IPC.snapshotRestoreEntry, (_event, entryId: unknown) =>
    restoreEntry(assertString(entryId, 'entryId')),
  );
  ipcMain.handle(IPC.snapshotReadEntry, (_event, entryId: unknown) =>
    readEntryContent(assertString(entryId, 'entryId')),
  );
  ipcMain.handle(IPC.snapshotClear, () => clearSnapshots());

  const coerceEdits = (input: unknown): StagedEdit[] => {
    if (!Array.isArray(input)) throw new Error('edits must be an array.');
    const kinds: EditKind[] = ['create', 'modify', 'delete'];
    const sha256Hex = /^[0-9a-f]{64}$/i;
    return input.map((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`edit[${i}]: edit must be an object.`);
      }
      const o = raw as Record<string, unknown>;
      const path = o.path;
      const kind = o.kind;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error(`edit[${i}]: path is required.`);
      }
      if (typeof kind !== 'string' || !kinds.includes(kind as EditKind)) {
        throw new Error(`edit[${i}]: kind must be create, modify, or delete.`);
      }

      const requireBaseHash = (): string => {
        if (typeof o.baseHash !== 'string' || !sha256Hex.test(o.baseHash)) {
          throw new Error(
            `edit[${i}]: ${kind} baseHash must be a 64-character SHA-256 hex digest.`,
          );
        }
        return o.baseHash;
      };

      switch (kind) {
        case 'create':
          if (typeof o.newText !== 'string') {
            throw new Error(`edit[${i}]: create requires newText.`);
          }
          if (Object.prototype.hasOwnProperty.call(o, 'baseHash')) {
            throw new Error(`edit[${i}]: create must not include baseHash.`);
          }
          return { path, kind: 'create', newText: o.newText };
        case 'modify':
          if (typeof o.newText !== 'string') {
            throw new Error(`edit[${i}]: modify requires newText.`);
          }
          return { path, kind: 'modify', newText: o.newText, baseHash: requireBaseHash() };
        case 'delete':
          if (Object.prototype.hasOwnProperty.call(o, 'newText')) {
            throw new Error(`edit[${i}]: delete must not include newText.`);
          }
          return { path, kind: 'delete', baseHash: requireBaseHash() };
        default:
          throw new Error(`edit[${i}]: unsupported edit kind.`);
      }
    });
  };
  ipcMain.handle(IPC.safeEditStage, async (_event, rootValue: unknown, edits: unknown) => {
    const root = await trustedWorkspaceRoot(rootValue);
    return stageEdits(await authorizeStagedEdits(root, coerceEdits(edits)));
  });
  ipcMain.handle(IPC.safeEditApply, async (event, rootValue: unknown, edits: unknown) => {
    const root = await trustedWorkspaceRoot(rootValue);
    const authorized = await authorizeStagedEdits(root, coerceEdits(edits));
    return applyEdits(authorized, {
      beforeCommit: async () => {
        await revalidateStagedEdits(root, authorized);
        assertWorkspaceClean(event.sender.id, root);
      },
    });
  });

  ipcMain.handle(IPC.aiConvRead, () => aiConversationsService.readConversations());

  ipcMain.handle(IPC.aiConvWrite, (_event, list: unknown) =>
    aiConversationsService.writeConversations(list),
  );

  ipcMain.handle(IPC.aiConvMutate, (_event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const scopeId = assertString(o.scopeId, 'scopeId');
    let mutation: AiConversationMutation;
    if (o.kind === 'upsert') {
      mutation = {
        kind: 'upsert',
        scopeId,
        conversation: (o.conversation ?? {}) as AiConversation,
      };
    } else if (o.kind === 'delete') {
      mutation = { kind: 'delete', scopeId, id: assertString(o.id, 'id') };
    } else if (o.kind === 'clear') {
      mutation = { kind: 'clear', scopeId };
    } else if (o.kind === 'migrateLegacy') {
      mutation = { kind: 'migrateLegacy', scopeId };
    } else {
      throw new Error('Unsupported conversation mutation.');
    }
    return aiConversationsService.mutateConversations(mutation);
  });

  ipcMain.handle(IPC.authGetState, (event) => {
    authService.registerAuthWebContents(event.sender);
    return authService.getState();
  });

  ipcMain.handle(IPC.authSignInGoogle, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) {
      throw new Error('Authentication is unavailable for this window.');
    }

    authService.registerAuthWebContents(event.sender);
    try {
      await authService.signInWithGoogle();
    } finally {
      // Return focus only to the renderer that initiated OAuth. Preview or
      // auxiliary windows must never be selected by global window ordering.
      if (!owner.isDestroyed()) {
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
      }
    }
  });

  ipcMain.handle(IPC.authSignOut, () => authService.signOut());

  ipcMain.handle(IPC.termListShells, () => terminalService.listShells());

  ipcMain.handle(IPC.termCreate, async (event, opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(o.cwd, 'cwd');
    // PRD Phase 7 — a pane the renderer adopted for an extension terminal. The renderer sends back
    // only the handle it was given; the shell, directory and environment the extension asked for are
    // read out of Main's own registry, which is also what consumes the pending spawn exactly once.
    const handle = typeof o.extensionHandle === 'number' ? Math.floor(o.extensionHandle) : 0;
    const override = handle > 0 ? extensionTerminalSpawnSpec(handle) : null;
    return terminalService.createTerminal(
      {
        id: assertString(o.id, 'id'),
        shell: typeof o.shell === 'string' ? o.shell : '',
        cwd: root,
        cols: typeof o.cols === 'number' ? o.cols : 80,
        rows: typeof o.rows === 'number' ? o.rows : 24,
      },
      event.sender,
      override,
    );
  });

  ipcMain.handle(IPC.termWrite, (event, id: unknown, data: unknown) =>
    terminalService.writeTerminal(assertString(id, 'id'), assertString(data, 'data'), event.sender),
  );

  ipcMain.handle(IPC.termResize, (event, id: unknown, cols: unknown, rows: unknown) =>
    terminalService.resizeTerminal(
      assertString(id, 'id'),
      typeof cols === 'number' ? cols : 80,
      typeof rows === 'number' ? rows : 24,
      event.sender,
    ),
  );

  ipcMain.handle(IPC.termKill, (event, id: unknown) =>
    terminalService.killTerminal(assertString(id, 'id'), event.sender),
  );

  // Rust Core sidecar (PRD Epoch C): ignore-aware walk + ripgrep-style search.
  ipcMain.handle(IPC.coreWalk, async (_event, root: unknown) =>
    coreWalk(await authorizedWorkspaceRoot(root)),
  );

  ipcMain.handle(
    IPC.coreSearch,
    async (_event, root: unknown, query: unknown, caseSensitive: unknown) =>
      coreSearch(
        await authorizedWorkspaceRoot(root),
        assertString(query, 'query'),
        caseSensitive === true,
      ),
  );

  ipcMain.handle(IPC.coreSymbols, async (_event, path: unknown) => {
    const target = await authorizedPath(path);
    const root = authorizedWorkspaceRootForPath(target);
    if (!root) throw new Error('Core symbol path is not inside an authorized workspace.');
    return coreSymbols(root, target);
  });

  ipcMain.handle(IPC.coreChunk, async (_event, path: unknown, options: unknown) => {
    const o = (options ?? {}) as Record<string, unknown>;
    const opts: { maxLines?: number; overlap?: number } = {};
    if (typeof o.maxLines === 'number') opts.maxLines = o.maxLines;
    if (typeof o.overlap === 'number') opts.overlap = o.overlap;
    const target = await authorizedPath(path);
    const root = authorizedWorkspaceRootForPath(target);
    if (!root) throw new Error('Core chunk path is not inside an authorized workspace.');
    return coreChunk(root, target, opts);
  });

  // On-device semantic retrieval + embedding (PRD Epoch C Phase 59/64, Part VIII §126).
  ipcMain.handle(
    IPC.coreRetrieve,
    async (_event, root: unknown, query: unknown, options: unknown) => {
      const o = (options ?? {}) as Record<string, unknown>;
      const opts: { topK?: number; maxLines?: number; dim?: number } = {};
      if (typeof o.topK === 'number') opts.topK = o.topK;
      if (typeof o.maxLines === 'number') opts.maxLines = o.maxLines;
      if (typeof o.dim === 'number') opts.dim = o.dim;
      return coreRetrieve(await authorizedWorkspaceRoot(root), assertString(query, 'query'), opts);
    },
  );

  ipcMain.handle(IPC.coreEmbed, (_event, text: unknown, dim: unknown) =>
    coreEmbed(assertString(text, 'text'), typeof dim === 'number' ? dim : undefined),
  );

  // Knowledge graph / dependency + impact analysis (PRD Epoch C Phases 65/66).
  ipcMain.handle(IPC.coreGraphBuild, async (_event, root: unknown) =>
    coreGraphBuild(await authorizedWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.coreGraphDependencies, async (_event, root: unknown, path: unknown) => {
    const target = await authorizedWorkspaceTarget(root, path);
    return coreGraphDependencies(target.root, target.path);
  });
  ipcMain.handle(IPC.coreGraphDependents, async (_event, root: unknown, path: unknown) => {
    const target = await authorizedWorkspaceTarget(root, path);
    return coreGraphDependents(target.root, target.path);
  });
  ipcMain.handle(IPC.coreGraphImpact, async (_event, root: unknown, path: unknown) => {
    const target = await authorizedWorkspaceTarget(root, path);
    return coreGraphImpact(target.root, target.path);
  });
  ipcMain.handle(IPC.coreGraphCycles, async (_event, root: unknown) =>
    coreGraphCycles(await authorizedWorkspaceRoot(root)),
  );
  ipcMain.handle(IPC.coreGraphEdges, async (_event, root: unknown) =>
    buildWorkspaceGraph(await authorizedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.coreProjectUnderstand, async (_event, root: unknown) =>
    coreProjectUnderstand(await authorizedWorkspaceRoot(root)),
  );

  ipcMain.handle(IPC.coreCatalogRebuild, async (_event, root: unknown, db: unknown) => {
    const target = await authorizedWorkspaceTarget(root, db, { allowMissing: true });
    return coreCatalogRebuild(target.root, target.path);
  });

  ipcMain.handle(IPC.coreCatalogStats, async (_event, db: unknown) =>
    coreCatalogStats(await authorizedPath(db, 'db')),
  );

  ipcMain.handle(
    IPC.coreCatalogQuery,
    async (_event, db: unknown, pattern: unknown, limit: unknown) =>
      coreCatalogQuery(
        await authorizedPath(db, 'db'),
        typeof pattern === 'string' ? pattern : undefined,
        typeof limit === 'number' ? limit : undefined,
      ),
  );

  ipcMain.handle(IPC.coreWatch, async (event, rootValue: unknown) => {
    const root = await trustedWorkspaceRoot(rootValue);
    bindCoreWatchOwner(event.sender);
    const key = workspacePathKey(root);
    const existing = coreWatchOwners.get(key);
    if (existing) {
      existing.owners.add(event.sender);
      return { watching: root };
    }
    const result = await coreWatch(root);
    await assertWorkspaceTrusted(root);
    if (event.sender.isDestroyed()) {
      await coreUnwatch(root).catch(() => undefined);
      throw new Error('Core watcher owner closed during startup.');
    }
    coreWatchOwners.set(key, { root, owners: new Set([event.sender]) });
    return result;
  });

  ipcMain.handle(IPC.coreUnwatch, async (event, rootValue: unknown) => {
    const root = await authorizedWorkspaceRoot(rootValue);
    const key = workspacePathKey(root);
    const binding = coreWatchOwners.get(key);
    if (!binding) return { stopped: root };
    binding.owners.delete(event.sender);
    if (binding.owners.size > 0) return { stopped: null };
    coreWatchOwners.delete(key);
    return coreUnwatch(root);
  });

  // Language servers are started only for a persisted-trusted canonical root.
  // Main owns each document→root→renderer binding; subsequent operations never
  // accept a renderer-supplied workspace identity and re-check trust every time.
  ipcMain.handle(IPC.lspDidOpen, async (event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const root = await trustedWorkspaceRoot(o.rootPath, 'rootPath');
    const uri = await trustedDocumentUri(root, o.uri);
    const key = lspDocumentKey(uri);
    const existing = lspBindings.get(key);
    if (existing) {
      if (existing.owner !== event.sender) {
        throw new Error('LSP document is owned by another renderer.');
      }
      if (!sameWorkspaceRoot(existing.root, root)) {
        throw new Error('LSP document is already bound to another workspace.');
      }
    }
    await assertWorkspaceTrusted(root);

    const binding = existing ?? { root, owner: event.sender, uri };
    if (!existing) lspBindings.set(key, binding);
    if (!lspBoundOwners.has(event.sender)) {
      lspBoundOwners.add(event.sender);
      event.sender.once('destroyed', () => closeLspBindingsForOwner(event.sender));
    }

    try {
      await lspDidOpen({
        uri: binding.uri,
        languageId: assertString(o.languageId, 'languageId'),
        version: typeof o.version === 'number' ? o.version : 1,
        text: typeof o.text === 'string' ? o.text : '',
        rootPath: binding.root,
      });
    } catch (error) {
      if (!existing && lspBindings.get(key) === binding) lspBindings.delete(key);
      throw error;
    }
  });

  // Incremental sync. Main keeps the authoritative document text, so a batch it
  // cannot apply is reported back as `resync` instead of being guessed at.
  ipcMain.handle(IPC.lspDidChange, async (event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const binding = await requireActiveLspDocument(event.sender, o.uri);
    const version = typeof o.version === 'number' ? o.version : 1;
    if (typeof o.text === 'string') {
      return lspDidChange({ uri: binding.uri, version, text: o.text });
    }
    const changes = toLspContentChanges(o.changes);
    if (changes.length === 0) return { resync: true };
    const payload: LspDidChangeInput = { uri: binding.uri, version, changes };
    if (typeof o.length === 'number' && o.length >= 0) payload.length = o.length;
    return lspDidChange(payload);
  });

  ipcMain.handle(IPC.lspResync, async (event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const binding = await requireActiveLspDocument(event.sender, o.uri);
    lspResync(
      binding.uri,
      typeof o.version === 'number' ? o.version : 1,
      typeof o.text === 'string' ? o.text : '',
    );
  });

  ipcMain.handle(IPC.lspDidSave, async (event, input: unknown) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const binding = await requireActiveLspDocument(event.sender, o.uri);
    lspDidSave(binding.uri, typeof o.text === 'string' ? o.text : '');
  });

  // Cancellation is scoped to the sender, so one renderer cannot abort another's
  // requests even though the key is a renderer-chosen number.
  ipcMain.handle(IPC.lspCancel, (event, requestId: unknown) => {
    const key = lspCancelKey(event.sender, requestId);
    if (key) lspCancel(key);
  });

  ipcMain.handle(IPC.lspDidClose, async (event, value: unknown) => {
    const uri = await authorizedDocumentUri(value);
    const key = lspDocumentKey(uri);
    const binding = lspBindings.get(key);
    if (!binding) return;
    if (binding.owner !== event.sender) {
      throw new Error('LSP document is owned by another renderer.');
    }
    closeLspBinding(key, binding);
  });

  ipcMain.handle(
    IPC.lspHover,
    async (event, uri: unknown, line: unknown, character: unknown, requestId: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspHover(
        binding.uri,
        typeof line === 'number' ? line : 0,
        typeof character === 'number' ? character : 0,
        lspCancelKey(event.sender, requestId),
      );
    },
  );

  ipcMain.handle(
    IPC.lspCompletion,
    async (
      event,
      uri: unknown,
      line: unknown,
      character: unknown,
      context: unknown,
      requestId: unknown,
    ) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspCompletion(
        binding.uri,
        typeof line === 'number' ? line : 0,
        typeof character === 'number' ? character : 0,
        toLspCompletionContext(context),
        lspCancelKey(event.sender, requestId),
      );
    },
  );

  // Resolve fills in documentation and the additionalTextEdits that make
  // auto-import work. The handle identifies Main's retained item, not a payload.
  ipcMain.handle(IPC.lspCompletionResolve, async (event, uri: unknown, handle: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspResolveCompletion(binding.uri, toLspHandle(handle));
  });

  ipcMain.handle(IPC.lspExecuteCompletionCommand, async (event, uri: unknown, handle: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspExecuteCompletionCommand(binding.uri, toLspHandle(handle));
  });

  // Every position-based language request shares one guard: resolve the document
  // binding Main owns, re-check trust, and pass `binding.uri` — never the string
  // the renderer sent. Registering them through a single helper means the guard
  // cannot be omitted from a new request by accident.
  const handleLspPositionRequest = <T>(
    channel: string,
    run: (uri: string, line: number, character: number, cancelKey?: string) => Promise<T>,
  ): void => {
    ipcMain.handle(
      channel,
      async (event, uri: unknown, line: unknown, character: unknown, requestId: unknown) => {
        const binding = await requireActiveLspDocument(event.sender, uri);
        return run(
          binding.uri,
          typeof line === 'number' ? line : 0,
          typeof character === 'number' ? character : 0,
          lspCancelKey(event.sender, requestId),
        );
      },
    );
  };

  handleLspPositionRequest(IPC.lspDefinition, lspDefinition);
  handleLspPositionRequest(IPC.lspDeclaration, lspDeclaration);
  handleLspPositionRequest(IPC.lspReferences, lspReferences);
  handleLspPositionRequest(IPC.lspTypeDefinition, lspTypeDefinition);
  handleLspPositionRequest(IPC.lspImplementation, lspImplementation);
  handleLspPositionRequest(IPC.lspDocumentHighlight, lspDocumentHighlight);
  handleLspPositionRequest(IPC.lspSignatureHelp, lspSignatureHelp);
  handleLspPositionRequest(IPC.lspPrepareRename, (uri, line, character) =>
    lspPrepareRename(uri, line, character),
  );

  ipcMain.handle(
    IPC.lspRename,
    async (event, uri: unknown, line: unknown, character: unknown, newName: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspRename(
        binding.uri,
        typeof line === 'number' ? line : 0,
        typeof character === 'number' ? character : 0,
        assertString(newName, 'newName'),
      );
    },
  );

  ipcMain.handle(IPC.lspSelectionRange, async (event, uri: unknown, positions: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    if (!Array.isArray(positions) || positions.length === 0 || positions.length > 32) return [];
    const points = positions.map((entry) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      return {
        line: typeof o.line === 'number' ? o.line : 0,
        character: typeof o.character === 'number' ? o.character : 0,
      };
    });
    return lspSelectionRange(binding.uri, points);
  });

  ipcMain.handle(
    IPC.lspOnTypeFormatting,
    async (
      event,
      uri: unknown,
      line: unknown,
      character: unknown,
      ch: unknown,
      tabSize: unknown,
      insertSpaces: unknown,
    ) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      const trigger = typeof ch === 'string' ? ch.slice(0, 1) : '';
      if (trigger.length === 0) return [];
      return lspOnTypeFormatting(
        binding.uri,
        typeof line === 'number' ? line : 0,
        typeof character === 'number' ? character : 0,
        trigger,
        typeof tabSize === 'number' ? tabSize : 2,
        insertSpaces !== false,
      );
    },
  );

  ipcMain.handle(
    IPC.lspCodeAction,
    async (
      event,
      uri: unknown,
      range: unknown,
      diagnostics: unknown,
      only: unknown,
      requestId: unknown,
    ) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspCodeAction(
        binding.uri,
        toLspRange(range),
        Array.isArray(diagnostics) ? (diagnostics as LspDiagnostic[]) : [],
        toCodeActionOnly(only),
        lspCancelKey(event.sender, requestId),
      );
    },
  );

  ipcMain.handle(IPC.lspCodeActionResolve, async (event, uri: unknown, handle: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspResolveCodeAction(binding.uri, toLspHandle(handle));
  });

  // Command-backed actions (organize imports, most refactors) run server-side
  // from Main's retained copy of the action the renderer was offered.
  ipcMain.handle(IPC.lspExecuteCodeAction, async (event, uri: unknown, handle: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspExecuteCodeAction(binding.uri, toLspHandle(handle));
  });

  ipcMain.handle(IPC.lspDocumentSymbol, async (event, uri: unknown, requestId: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspDocumentSymbol(binding.uri, lspCancelKey(event.sender, requestId));
  });

  ipcMain.handle(
    IPC.lspWorkspaceSymbol,
    async (event, uri: unknown, query: unknown, requestId: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      const text = typeof query === 'string' ? query.slice(0, 256) : '';
      return lspWorkspaceSymbol(binding.uri, text, lspCancelKey(event.sender, requestId));
    },
  );

  ipcMain.handle(
    IPC.lspInlayHint,
    async (event, uri: unknown, range: unknown, requestId: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspInlayHint(binding.uri, toLspRange(range), lspCancelKey(event.sender, requestId));
    },
  );

  ipcMain.handle(IPC.lspFoldingRange, async (event, uri: unknown, requestId: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspFoldingRange(binding.uri, lspCancelKey(event.sender, requestId));
  });

  ipcMain.handle(IPC.lspDocumentLink, async (event, uri: unknown, requestId: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspDocumentLink(binding.uri, lspCancelKey(event.sender, requestId));
  });

  ipcMain.handle(IPC.lspSemanticTokensLegend, async (event, uri: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspSemanticTokensLegend(binding.uri);
  });

  ipcMain.handle(IPC.lspSemanticTokens, async (event, uri: unknown, requestId: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspSemanticTokens(binding.uri, lspCancelKey(event.sender, requestId));
  });

  // Pull diagnostics: the editor asks for the document it is showing, rather than
  // waiting for the server to decide to push.
  ipcMain.handle(IPC.lspPullDiagnostics, async (event, uri: unknown, requestId: unknown) => {
    const binding = await requireActiveLspDocument(event.sender, uri);
    return lspPullDiagnostics(binding.uri, lspCancelKey(event.sender, requestId));
  });

  ipcMain.handle(IPC.lspServerStatuses, async (event, rootValue: unknown) => {
    const root = await authorizedWorkspaceRoot(rootValue, 'rootPath');
    void event;
    return lspServerStatuses(root);
  });

  // Toolchain detection is a read-only probe of the machine, so it needs no
  // workspace capability — but it is still Main-only, and the renderer cannot
  // influence WHICH executables are probed or with what arguments.
  ipcMain.handle(IPC.runtimesDetect, async (_event, refresh: unknown) => {
    return detectRuntimes(refresh === true ? { refresh: true } : {});
  });

  // ---- LANGUAGES view -----------------------------------------------------
  // Toolchain installation is Main-owned end to end. The renderer may only name a
  // language pack id; Main looks that id up in the pinned registry, builds the exact
  // argument vector itself, shows every command in a native approval dialog, and
  // only then spawns anything. No renderer value ever reaches an argv slot.
  let languageInstallId: string | null = null;
  let languageInstallOwner: WebContents | null = null;

  setLanguageInstallEventSink((installEvent) => {
    const owner = languageInstallOwner;
    if (!owner || installEvent.installId !== languageInstallId) return;
    if (!owner.isDestroyed()) owner.send(IPC.languagesInstallEvent, installEvent);
    if (installEvent.kind !== 'done') return;
    languageInstallId = null;
    languageInstallOwner = null;
    // An installer writes the new PATH for FUTURE processes; a process that is
    // already running keeps the environment it started with. When a successful
    // install is still invisible, saying so plainly — and offering the restart that
    // fixes it — beats leaving the user staring at a tool they just installed.
    if (!installEvent.restartRequired || owner.isDestroyed()) return;
    const ownerWindow = BrowserWindow.fromWebContents(owner);
    if (!ownerWindow || ownerWindow.isDestroyed()) return;
    void dialog
      .showMessageBox(ownerWindow, {
        type: 'info',
        title: 'Restart to finish setup',
        message: installEvent.text,
        detail:
          'The toolchain is installed on this machine. AXIOM needs one restart to pick up the environment the installer changed. After restarting, Run detects it automatically.',
        buttons: ['Restart AXIOM now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((result) => {
        if (result.response !== 0) return;
        // quit(), not exit(): unsaved editors still get their close prompts.
        app.relaunch();
        app.quit();
      })
      .catch(() => undefined);
  });

  // ---- Build execution consent --------------------------------------------
  // Read-only status, plus the user's own decision. The value itself lives in
  // Main-owned storage; the renderer can ask for a change but never writes it.
  // Read-only, and carries no email, user id, or path: the account UI only needs to
  // state that local data is separate per account, not to locate it.
  ipcMain.handle(IPC.accountProfileGet, async () => activeProfileInfo());

  ipcMain.handle(IPC.executionConsentGet, async () => loadExecutionConsent());
  ipcMain.handle(IPC.executionConsentSet, async (_event, granted: unknown) =>
    setExecutionConsent(granted === true),
  );

  ipcMain.handle(IPC.languagesCatalog, async () => buildLanguagesCatalog());

  // Re-reading PATH from the OS is what makes a just-installed toolchain visible
  // without a restart. It writes only PATH, and only from the same sources the
  // operating system itself consults, so nothing becomes reachable that the user's
  // own shell could not already reach.
  ipcMain.handle(IPC.languagesRescan, async () => {
    await refreshDetectionEnvironment();
    return buildLanguagesCatalog({ refresh: true });
  });

  ipcMain.handle(IPC.languagesInstall, async (event, languageIdValue: unknown) => {
    const languageId = assertString(languageIdValue, 'languageId');
    const plan = await planLanguageInstall(languageId);
    if (!plan.runnable) {
      throw new Error(
        plan.blockedReason ?? 'This toolchain cannot be installed automatically on this machine.',
      );
    }
    if (languageInstallId) throw new Error('Another toolchain install is already running.');
    const detail = [
      `Toolchain: ${plan.displayName}`,
      `Package manager: ${plan.managerName ?? 'unknown'}`,
      `Package manager path: ${plan.managerPath ?? 'resolved by name'}`,
      '',
      `Commands AXIOM will run, in this order (${plan.steps.length}):`,
      ...plan.steps.map((step, index) => `${index + 1}. ${step.commandLine}`),
    ].join('\n');
    await requireNativeGodModeApproval(
      event.sender,
      true,
      'Install Language Toolchain',
      'Install this language toolchain with your user privileges?',
      detail,
    );
    if (languageInstallId) throw new Error('Another toolchain install is already running.');
    const started = startLanguageInstall(plan);
    languageInstallId = started.installId;
    languageInstallOwner = event.sender;
    event.sender.once('destroyed', () => {
      if (languageInstallId !== started.installId) return;
      cancelLanguageInstall(started.installId);
      languageInstallId = null;
      languageInstallOwner = null;
    });
    return started;
  });

  ipcMain.handle(IPC.languagesInstallCancel, async (event, installIdValue: unknown) => {
    const installId = assertString(installIdValue, 'installId');
    if (languageInstallId !== installId || languageInstallOwner !== event.sender) return;
    cancelLanguageInstall(installId);
  });

  ipcMain.handle(IPC.lspRestartServer, async (event, rootValue: unknown, serverId: unknown) => {
    const root = await trustedWorkspaceRoot(rootValue, 'rootPath');
    await assertWorkspaceTrusted(root);
    void event;
    await lspRestartServer(root, assertString(serverId, 'serverId'));
  });

  ipcMain.handle(
    IPC.lspFormatting,
    async (event, uri: unknown, tabSize: unknown, insertSpaces: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspFormatting(
        binding.uri,
        typeof tabSize === 'number' ? tabSize : 2,
        insertSpaces !== false,
      );
    },
  );

  ipcMain.handle(
    IPC.lspRangeFormatting,
    async (event, uri: unknown, range: unknown, tabSize: unknown, insertSpaces: unknown) => {
      const binding = await requireActiveLspDocument(event.sender, uri);
      return lspRangeFormatting(
        binding.uri,
        toLspRange(range),
        typeof tabSize === 'number' ? tabSize : 2,
        insertSpaces !== false,
      );
    },
  );

  // Route only validated, canonical, root-contained Core filesystem events to
  // renderers that explicitly own that exact watcher capability.
  onCoreNotification((method, params) => {
    if (method !== 'fs/event') return;
    void (async () => {
      if (!params || typeof params !== 'object' || Array.isArray(params)) return;
      const value = params as Record<string, unknown>;
      if (
        typeof value.root !== 'string' ||
        !Array.isArray(value.paths) ||
        value.paths.length > 256
      ) {
        return;
      }
      const root = await assertWorkspaceTrusted(value.root).catch(() => null);
      if (!root) return;
      const binding = coreWatchOwners.get(workspacePathKey(root));
      if (!binding || !sameWorkspaceRoot(binding.root, root)) return;
      const kind = ['create', 'modify', 'remove', 'other'].includes(String(value.kind))
        ? String(value.kind)
        : 'other';
      const paths: string[] = [];
      for (const candidate of value.paths) {
        if (typeof candidate !== 'string' || candidate.length > 4_096) return;
        const canonical = await assertAuthorizedPath(candidate, { allowMissing: true }).catch(
          () => null,
        );
        if (!canonical) return;
        const rel = relative(root, canonical);
        if (rel.startsWith('..') || isAbsolute(rel)) return;
        paths.push(canonical);
      }
      if (paths.length === 0) return;
      const payload = { root, kind, paths };
      for (const owner of [...binding.owners]) {
        if (owner.isDestroyed()) binding.owners.delete(owner);
        else owner.send(IPC.coreFsEvent, payload);
      }
      if (binding.owners.size === 0) await closeCoreWatchesForWorkspace(root);
    })().catch((error: unknown) => {
      log.warn('Core watcher notification rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  // Route language-server diagnostics only to the renderer that owns the document.
  onLspDiagnostics((evt) => {
    const binding = lspBindings.get(lspDocumentKey(evt.uri));
    if (binding && !binding.owner.isDestroyed()) {
      binding.owner.send(IPC.lspDiagnostics, evt);
    }
  });

  // Server lifecycle + log lines go to every renderer that has bound a document,
  // so the status bar and the language-server output view stay truthful.
  const broadcastToLspOwners = (channel: string, payload: unknown): void => {
    const seen = new Set<WebContents>();
    for (const binding of lspBindings.values()) {
      if (binding.owner.isDestroyed() || seen.has(binding.owner)) continue;
      seen.add(binding.owner);
      binding.owner.send(channel, payload);
    }
  };

  onLspServerStatus((status: LspServerStatus) => {
    broadcastToLspOwners(IPC.lspServerStatusChanged, status);
  });

  onLspLog((evt: LspLogEvent) => {
    broadcastToLspOwners(IPC.lspLog, evt);
  });

  /**
   * `workspace/applyEdit`: a server asking us to change files. Main does not write
   * them — it forwards the edit to the renderer that owns a document in that
   * workspace so the change lands in an undoable Monaco model, and waits for a
   * real answer instead of telling the server it worked.
   */
  const pendingApplyEdits = new Map<number, (applied: boolean) => void>();
  const applyEditOwners = new Map<number, WebContents>();
  let applyEditNonce = 0;
  const APPLY_EDIT_TIMEOUT_MS = 10_000;

  ipcMain.handle(IPC.lspApplyEditResult, (event, nonce: unknown, applied: unknown) => {
    if (typeof nonce !== 'number') return;
    const resolve = pendingApplyEdits.get(nonce);
    if (!resolve) return;
    // Only the renderer the request was sent to may answer it.
    const owner = applyEditOwners.get(nonce);
    if (owner !== event.sender) return;
    pendingApplyEdits.delete(nonce);
    applyEditOwners.delete(nonce);
    resolve(applied === true);
  });

  onLspApplyEdit(async (root: string, edit: LspWorkspaceEdit) => {
    const trusted = await assertWorkspaceTrusted(root).catch(() => null);
    if (!trusted) return false;
    let owner: WebContents | null = null;
    for (const binding of lspBindings.values()) {
      if (!binding.owner.isDestroyed() && sameWorkspaceRoot(binding.root, trusted)) {
        owner = binding.owner;
        break;
      }
    }
    if (!owner) return false;
    // Every URI the server named must resolve inside the trusted root.
    const changes: LspWorkspaceEdit['changes'] = {};
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const authorized = await trustedDocumentUri(trusted, uri).catch(() => null);
      if (!authorized) return false;
      changes[authorized] = edits;
    }
    if (Object.keys(changes).length === 0) return false;

    const nonce = ++applyEditNonce;
    const target = owner;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingApplyEdits.delete(nonce);
        applyEditOwners.delete(nonce);
        resolve(false);
      }, APPLY_EDIT_TIMEOUT_MS);
      pendingApplyEdits.set(nonce, (applied) => {
        clearTimeout(timer);
        resolve(applied);
      });
      applyEditOwners.set(nonce, target);
      target.send(IPC.lspApplyEdit, { nonce, edit: { changes } } satisfies LspApplyEditRequest);
    });
  });

  // Start watching the given root; push a coarse change event to the requesting
  // renderer whenever the tree changes on disk. Bound to the sender's lifetime.
  ipcMain.handle(IPC.fsWatchStart, async (event, rootPath: unknown) => {
    const root = await authorizedWorkspaceRoot(rootPath, 'rootPath');
    const sender = event.sender;
    const disposeWatch = startWatching(root, (changedRoot) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.fsDidChange, { root: changedRoot } satisfies FsChangeEvent);
      }
    });
    sender.once('destroyed', disposeWatch);
  });

  // Initialize authentication (session restore + refresh loop + change events).
  authService.initAuth();

  log.info('IPC handlers registered', { channels: Object.values(IPC) });
}
