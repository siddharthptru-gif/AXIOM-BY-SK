import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { CommandConsentScope } from '../common/commandConsent';
import type { DetectedRuntime } from '../common/runtimes';
import type {
  LanguageInstallEvent,
  LanguageInstallStarted,
  LanguagesCatalog,
} from '../common/languagePacks';
import type { ExecutionConsentState } from '../common/executionConsentTypes';
import {
  IPC,
  type AiConnectionInput,
  type AiCredentialBinding,
  type AiConnectionScopeInput,
  type AiConversation,
  type AiConversationMutation,
  type AttachmentDescriptor,
  type AttachmentTextInput,
  type AiModelsResult,
  type AiTestResult,
  type AppInfo,
  type TitleBarOverlayAppearance,
  type WorkspaceTrustState,
  type AccountProfileInfo,
  type AuthState,
  type ChatChunk,
  type ChatSendInput,
  type ChatUsage,
  type BuildContextInput,
  type ContextResult,
  type InlineEditResult,
  type InlineChatResult,
  type SpendSummary,
  type DebugControlAction,
  type DebugBreakpoint,
  type DebugEvalResult,
  type DebugEvent,
  type DebugLaunchConfig,
  type DebugScope,
  type DebugStackFrame,
  type DebugStartResult,
  type DebugVariable,
  type DiscoveredDebugConfig,
  type LocalModelProbe,
  type WriteConsentState,
  type WorkspaceAgentFile,
  type AgentRunInput,
  type AgentStepEvent,
  type AgentTask,
  type AuditEvent,
  type AuditVerifyResult,
  type MemoryEntry,
  type MemoryScope,
  type MemorySelection,
  type TelemetryCategory,
  type TelemetryConsent,
  type TelemetryEvent,
  type FlagValue,
  type CoreCatalogQueryResult,
  type CoreCatalogRebuildResult,
  type CoreCatalogStatsResult,
  type CoreChunkOptions,
  type CoreChunkResult,
  type CoreEmbedResult,
  type CoreFsEvent,
  type CoreGraphBuildResult,
  type CoreGraphCyclesResult,
  type CoreGraphEdgesResult,
  type CoreGraphDependenciesResult,
  type CoreGraphDependentsResult,
  type CoreGraphImpactResult,
  type CoreProjectProfile,
  type CoreRetrieveOptions,
  type CoreRetrieveResult,
  type CoreSearchResult,
  type CoreSymbolsResult,
  type CoreUnwatchResult,
  type CoreWalkResult,
  type CoreWatchResult,
  type LspApplyEditRequest,
  type LspCodeAction,
  type LspCompletionContext,
  type LspCompletionItem,
  type LspCompletionResult,
  type LspDiagnostic,
  type LspDiagnosticsEvent,
  type LspDidChangeInput,
  type LspDidChangeResult,
  type LspDidOpenInput,
  type LspDocumentHighlightResult,
  type LspDocumentLink,
  type LspDocumentSymbol,
  type LspFoldingRange,
  type LspHoverResult,
  type LspInlayHint,
  type LspLocationResult,
  type LspLogEvent,
  type LspPosition,
  type LspPrepareRenameResult,
  type LspRange,
  type LspSemanticTokens,
  type LspSemanticTokensLegend,
  type LspServerStatus,
  type LspSignatureHelp,
  type LspSymbolInformation,
  type LspTextEdit,
  type LspWorkspaceEdit,
  type TerminalCreateOptions,
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalShellInfo,
  type CreateEntryResult,
  type DeleteResult,
  type EditorSessionState,
  type ExtensionApplyEditPayload,
  type ExtensionDebugSessionInfo,
  type ExtensionDocumentInput,
  type ExtensionDocumentResult,
  type ExtensionLanguageRegistry,
  type ExtensionProvideInput,
  type ExtensionProvideResult,
  type ExtensionProviderEditInput,
  type ExtensionTaskExecutionInfo,
  type ExtensionTaskOutputEvent,
  type ExtensionTerminalCommand,
  type ExtensionTerminalEvent,
  type ExtensionTerminalInfo,
  type FileContent,
  type FsChangeEvent,
  type GitBranches,
  type GitDiff,
  type GitDiffMode,
  type GitLogEntry,
  type GitStatusResult,
  type GitOperationProgress,
  type GitOperationResult,
  type GitRemote,
  type GitRepositoryInfo,
  type GithubAuthState,
  type GithubCreateRepositoryInput,
  type GithubDeviceFlow,
  type GithubFlowPollResult,
  type GithubPublishResult,
  type LayoutState,
  type ListFilesResult,
  type OpenFileResult,
  type OpenFolderResult,
  type OpenPathResult,
  type PathIdentityResult,
  type ReadDirectoryResult,
  type RecentFolder,
  type RenameResult,
  type SaveFileResult,
  type SearchOptions,
  type SearchResult,
  type SettingsData,
  type ProfilePreferencesSnapshot,
  type WriteFileResult,
} from '../common/ipc';
import type { AgentPreset } from '../common/agentPresets';
import type { Workflow } from '../common/workflows';
import type { McpServerConfig, McpConnectResult, McpConnectionStatus } from '../common/mcp';
import type { Rule } from '../common/rules';
import type { ProposedRule } from '../common/conventionLearner';
import type { PromptTemplate } from '../common/promptLibrary';
import type { ExtensionManifest } from '../common/extensionManifest';
import type { RegistryIndex } from '../common/extensionRegistryIndex';
import type { ContributionRegistry } from '../common/extensionRegistry';
import type {
  RegistryExtensionDetail,
  RegistryPublisherDetail,
  RegistryReview,
  RegistrySearchPage,
  RegistryVersionPage,
  SearchQuery as MarketSearchQuery,
} from '../common/openVsx';
import type {
  InstallOutcome as MarketInstallOutcome,
  InstalledExtensionDetail,
  InstalledExtensionSummary,
  UpdateAllOutcome as MarketUpdateAllOutcome,
  UpdatePlanEntry as MarketUpdatePlanEntry,
} from '../common/marketplace';
import type { ConvertedTheme } from '../common/vscodeTheme';
import type {
  HostDiagnostic,
  HostPromptRequest,
  HostStatus,
  HostStatusBarItem,
} from '../common/vscodeHost';
import type { WebviewSnapshot, WebviewThemeKind } from '../common/vscodeWebview';
import type { TreeViewSnapshot, WorkbenchSnapshot } from '../common/vscodeViews';
import type { ResolvedMenuGroup } from '../common/vscodeMenus';
import type {
  ContributedGrammarSource,
  ContributedSnippet,
  ExtensionContributionCatalog,
  IconThemeDefinition,
} from '../common/contributions';
import type { ReviewResult } from '../common/review';
import type { UpdateDecision } from '../common/autoUpdate';
import type { UpdatePlan } from '../common/updateConfig';
import type { UpdateEvent, UpdateSnapshot } from '../common/updateState';
import type { EditPlan } from '../common/editPlan';
import type { SyncStatus } from '../common/sync';
import type { Checkpoint } from '../common/snapshot';
import type { ApplyResult, BatchPlan, StagedEdit } from '../common/safeEdit';
import type { StartupReportResult } from '../common/startupTiming';
import type { CompatReport } from '../common/compatMatrix';
import type { ProviderHealthSummary } from '../common/providerHealth';
import type { RunRecord } from '../common/runJournal';
import type { BranchPlan } from '../common/timeTravel';
import type { ReinvokeKind, ReinvokeRequest } from '../common/runReinvoke';
import type {
  CollaborationEvent,
  CollaborationExport,
  CollaborationRole,
  CollaborationSession,
  ContextEvalCase,
  ContextEvalSuiteResult,
  ContextIntelligenceInput,
  ContextIntelligenceReport,
  CreateAutonomousJobInput,
  CreateIsolatedWorkspaceInput,
  DeploymentPlan,
  DeploymentRun,
  DeploymentTarget,
  DebugEvidenceSnapshot,
  ExecuteDeploymentInput,
  ExtensionSandboxStatus,
  GithubIssue,
  GithubIssueRef,
  GodModeJob,
  GodModeSnapshot,
  IssueWorkPlan,
  JobControlInput,
  PredictionFeedback,
  PredictionMetrics,
  PredictiveCompletionInput,
  PredictiveCompletionResult,
  PreviewOpenInput,
  PreviewSnapshot,
  PullRequestInput,
  PullRequestResult,
  RemoteProbeResult,
  VerificationPlan,
  VerificationRunResult,
  WorkspaceCommandResult,
  WorkspaceProbeInput,
  IsolatedWorkspaceProfile,
} from '../common/godMode';

/**
 * Preload bridge. PRD Part X §178.4 / INV-3: expose ONLY a small, explicit,
 * allow-listed API. No raw ipcRenderer, no Node primitives, no secrets.
 */
const api = {
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    setDirty: (state: { root: string | null; dirty: boolean }): Promise<void> =>
      ipcRenderer.invoke(IPC.appSetDirty, state),
    /** Subscribe to Main-authorized OS "Open with AXIOM" targets. */
    onOpenPath: (callback: (entry: OpenPathResult) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: OpenPathResult): void => callback(payload);
      ipcRenderer.on(IPC.appOpenPath, listener);
      return () => ipcRenderer.removeListener(IPC.appOpenPath, listener);
    },
  },
  window: {
    setTitleBarOverlay: (appearance: TitleBarOverlayAppearance): Promise<void> =>
      ipcRenderer.invoke(IPC.windowSetTitleBarOverlay, appearance),
  },
  workspaceTrust: {
    get: (root: string): Promise<WorkspaceTrustState> =>
      ipcRenderer.invoke(IPC.workspaceTrustGet, root),
    set: (root: string, trusted: boolean): Promise<WorkspaceTrustState> =>
      ipcRenderer.invoke(IPC.workspaceTrustSet, root, trusted),
  },
  dialog: {
    openFolder: (): Promise<OpenFolderResult | null> => ipcRenderer.invoke(IPC.dialogOpenFolder),
    openFiles: (): Promise<OpenFileResult[]> => ipcRenderer.invoke(IPC.dialogOpenFiles),
    openDroppedPath: (
      file: Parameters<typeof webUtils.getPathForFile>[0],
    ): Promise<OpenPathResult | null> => {
      const path = webUtils.getPathForFile(file);
      return path
        ? ipcRenderer.invoke(IPC.dialogAuthorizeDroppedPath, path)
        : Promise.resolve(null);
    },
    saveFile: (defaultName?: string): Promise<SaveFileResult | null> =>
      ipcRenderer.invoke(IPC.dialogSaveFile, defaultName),
    validateFolder: (path: string): Promise<OpenFolderResult | null> =>
      ipcRenderer.invoke(IPC.dialogValidateFolder, path),
  },
  attachments: {
    pickFiles: (): Promise<AttachmentDescriptor[]> => ipcRenderer.invoke(IPC.attachmentPickFiles),
    pickFolder: (): Promise<AttachmentDescriptor | null> =>
      ipcRenderer.invoke(IPC.attachmentPickFolder),
    addWorkspaceFiles: (root: string, paths: string[]): Promise<AttachmentDescriptor[]> =>
      ipcRenderer.invoke(IPC.attachmentAddWorkspaceFiles, root, paths),
    addText: (input: AttachmentTextInput): Promise<AttachmentDescriptor> =>
      ipcRenderer.invoke(IPC.attachmentAddText, input),
    addDropped: (
      file: Parameters<typeof webUtils.getPathForFile>[0],
    ): Promise<AttachmentDescriptor | null> => {
      const path = webUtils.getPathForFile(file);
      return path ? ipcRenderer.invoke(IPC.attachmentAddDroppedPath, path) : Promise.resolve(null);
    },
    release: (ids: string[]): Promise<void> => ipcRenderer.invoke(IPC.attachmentRelease, ids),
  },
  recents: {
    get: (): Promise<RecentFolder[]> => ipcRenderer.invoke(IPC.recentsGet),
    add: (path: string, name: string): Promise<RecentFolder[]> =>
      ipcRenderer.invoke(IPC.recentsAdd, path, name),
    remove: (path: string): Promise<RecentFolder[]> => ipcRenderer.invoke(IPC.recentsRemove, path),
    clear: (): Promise<RecentFolder[]> => ipcRenderer.invoke(IPC.recentsClear),
  },
  system: {
    revealInOS: (path: string): Promise<void> => ipcRenderer.invoke(IPC.shellReveal, path),
    copyText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWrite, text),
    readText: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),
  },
  /** Crash-recovery journal (PRD Epoch A) — the startup recovery notice. */
  crash: {
    recoveryNotice: (): Promise<{ unclean: boolean; summary: string }> =>
      ipcRenderer.invoke(IPC.crashRecoveryNotice),
  },
  /** Startup-phase timing (PRD Epoch J / Phase 266). */
  perf: {
    startupReport: (): Promise<StartupReportResult> => ipcRenderer.invoke(IPC.perfStartupReport),
    markReady: (): Promise<boolean> => ipcRenderer.invoke(IPC.perfMarkReady),
  },
  /** Environment compatibility report (PRD Epoch J / Phase 276). */
  compat: {
    report: (): Promise<CompatReport> => ipcRenderer.invoke(IPC.compatReport),
  },
  fs: {
    readDirectory: (path: string): Promise<ReadDirectoryResult> =>
      ipcRenderer.invoke(IPC.fsReadDirectory, path),
    readFile: (path: string): Promise<FileContent> => ipcRenderer.invoke(IPC.fsReadFile, path),
    resolveIdentity: (path: string): Promise<PathIdentityResult> =>
      ipcRenderer.invoke(IPC.fsResolveIdentity, path),
    writeFile: (
      path: string,
      content: string,
      expectedEtag?: string | null,
      expectedIdentity?: string,
    ): Promise<WriteFileResult> =>
      ipcRenderer.invoke(IPC.fsWriteFile, path, content, expectedEtag, expectedIdentity),
    createFile: (anchorPath: string, name: string): Promise<CreateEntryResult> =>
      ipcRenderer.invoke(IPC.fsCreateFile, anchorPath, name),
    createDirectory: (anchorPath: string, name: string): Promise<CreateEntryResult> =>
      ipcRenderer.invoke(IPC.fsCreateDirectory, anchorPath, name),
    rename: (targetPath: string, newName: string): Promise<RenameResult> =>
      ipcRenderer.invoke(IPC.fsRename, targetPath, newName),
    move: (source: string, destDir: string): Promise<RenameResult> =>
      ipcRenderer.invoke(IPC.fsMove, source, destDir),
    delete: (targetPath: string): Promise<DeleteResult> =>
      ipcRenderer.invoke(IPC.fsDelete, targetPath),
    listFiles: (rootPath: string): Promise<ListFilesResult> =>
      ipcRenderer.invoke(IPC.fsListFiles, rootPath),
    search: (rootPath: string, query: string, options: SearchOptions): Promise<SearchResult> =>
      ipcRenderer.invoke(IPC.fsSearch, rootPath, query, options),
    watchStart: (rootPath: string): Promise<void> => ipcRenderer.invoke(IPC.fsWatchStart, rootPath),
    /** Subscribe to coarse workspace change events. Returns an unsubscribe fn. */
    onDidChange: (callback: (event: FsChangeEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: FsChangeEvent): void => callback(payload);
      ipcRenderer.on(IPC.fsDidChange, listener);
      return () => ipcRenderer.removeListener(IPC.fsDidChange, listener);
    },
  },
  settings: {
    read: (): Promise<SettingsData> => ipcRenderer.invoke(IPC.settingsRead),
    write: (values: SettingsData): Promise<void> => ipcRenderer.invoke(IPC.settingsWrite, values),
    readWorkspace: (root: string): Promise<SettingsData> =>
      ipcRenderer.invoke(IPC.settingsReadWorkspace, root),
    writeWorkspace: (root: string, values: SettingsData): Promise<void> =>
      ipcRenderer.invoke(IPC.settingsWriteWorkspace, root, values),
    resolve: (scope: 'user' | 'workspace', root?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.settingsResolve, scope, root ?? null),
  },
  preferences: {
    applyProfile: (
      settings: SettingsData,
      keybindings: SettingsData,
    ): Promise<ProfilePreferencesSnapshot> =>
      ipcRenderer.invoke(IPC.preferencesApplyProfile, { settings, keybindings }),
  },
  keybindings: {
    read: (): Promise<SettingsData> => ipcRenderer.invoke(IPC.keybindingsRead),
    write: (values: SettingsData): Promise<void> =>
      ipcRenderer.invoke(IPC.keybindingsWrite, values),
  },
  editorState: {
    read: (root: string): Promise<EditorSessionState> =>
      ipcRenderer.invoke(IPC.editorStateRead, root),
    write: (root: string, state: EditorSessionState): Promise<void> =>
      ipcRenderer.invoke(IPC.editorStateWrite, root, state),
  },
  layout: {
    read: (): Promise<Partial<LayoutState>> => ipcRenderer.invoke(IPC.layoutRead),
    write: (state: LayoutState): Promise<void> => ipcRenderer.invoke(IPC.layoutWrite, state),
  },
  git: {
    status: (root: string): Promise<GitStatusResult> => ipcRenderer.invoke(IPC.gitStatus, root),
    stage: (root: string, filepath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.gitStage, root, filepath),
    unstage: (root: string, filepath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.gitUnstage, root, filepath),
    commit: (root: string, message: string): Promise<string> =>
      ipcRenderer.invoke(IPC.gitCommit, root, message),
    branches: (root: string): Promise<GitBranches> => ipcRenderer.invoke(IPC.gitBranches, root),
    checkout: (root: string, ref: string): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitCheckout, root, ref),
    createBranch: (root: string, name: string): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitCreateBranch, root, name),
    diff: (root: string, filepath: string, mode: GitDiffMode): Promise<GitDiff> =>
      ipcRenderer.invoke(IPC.gitDiff, root, filepath, mode),
    discard: (root: string, filepath: string, confirmed: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.gitDiscard, root, filepath, confirmed),
    init: (root: string): Promise<void> => ipcRenderer.invoke(IPC.gitInit, root),
    log: (root: string, depth?: number): Promise<GitLogEntry[]> =>
      ipcRenderer.invoke(IPC.gitLog, root, depth),
    repository: (root: string): Promise<GitRepositoryInfo> =>
      ipcRenderer.invoke(IPC.gitRepository, root),
    remotes: (root: string): Promise<GitRemote[]> => ipcRenderer.invoke(IPC.gitRemotes, root),
    fetch: (root: string, remote?: string): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitFetch, root, remote),
    pull: (root: string): Promise<GitOperationResult> => ipcRenderer.invoke(IPC.gitPull, root),
    push: (root: string): Promise<GitOperationResult> => ipcRenderer.invoke(IPC.gitPush, root),
    addRemote: (root: string, remote: string, url: string): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitAddRemote, root, remote, url),
    deleteBranch: (root: string, ref: string, confirmed: boolean): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitDeleteBranch, root, ref, confirmed),
    merge: (root: string, ref: string, confirmed: boolean): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitMerge, root, ref, confirmed),
    rebase: (root: string, ref: string, confirmed: boolean): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitRebase, root, ref, confirmed),
    commitAndPush: (root: string, message: string): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.gitCommitAndPush, root, message),
    onProgress: (callback: (progress: GitOperationProgress) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, payload: GitOperationProgress): void =>
        callback(payload);
      ipcRenderer.on(IPC.gitProgress, listener);
      return () => ipcRenderer.removeListener(IPC.gitProgress, listener);
    },
  },
  github: {
    state: (): Promise<GithubAuthState> => ipcRenderer.invoke(IPC.githubState),
    start: (): Promise<GithubDeviceFlow> => ipcRenderer.invoke(IPC.githubStart),
    poll: (flowId: string): Promise<GithubFlowPollResult> =>
      ipcRenderer.invoke(IPC.githubPoll, flowId),
    cancel: (flowId: string): Promise<void> => ipcRenderer.invoke(IPC.githubCancel, flowId),
    openVerification: (flowId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.githubOpenVerification, flowId),
    disconnect: (): Promise<void> => ipcRenderer.invoke(IPC.githubDisconnect),
    publishRepository: (
      root: string,
      input: GithubCreateRepositoryInput,
      confirmed: boolean,
    ): Promise<GithubPublishResult> =>
      ipcRenderer.invoke(IPC.githubPublishRepository, root, input, confirmed),
    retryPublish: (
      root: string,
      cloneUrl: string,
      confirmed: boolean,
    ): Promise<GitOperationResult> =>
      ipcRenderer.invoke(IPC.githubRetryPublishRepository, root, cloneUrl, confirmed),
  },
  /**
   * BYOK secret store. The renderer can set, probe, or clear a secret — never
   * read one back (INV-3). Main holds and decrypts keys for outbound calls.
   */
  godMode: {
    snapshot: (root: string | null): Promise<GodModeSnapshot> =>
      ipcRenderer.invoke(IPC.godModeSnapshot, root),
    context: {
      inspect: (input: ContextIntelligenceInput): Promise<ContextIntelligenceReport> =>
        ipcRenderer.invoke(IPC.godModeContextInspect, input),
      evaluate: (root: string, cases: ContextEvalCase[]): Promise<ContextEvalSuiteResult> =>
        ipcRenderer.invoke(IPC.godModeContextEvaluate, root, cases),
    },
    jobs: {
      create: (input: CreateAutonomousJobInput): Promise<GodModeJob> =>
        ipcRenderer.invoke(IPC.godModeJobCreate, input),
      list: (root: string): Promise<GodModeJob[]> => ipcRenderer.invoke(IPC.godModeJobList, root),
      claim: (root: string, id: string): Promise<GodModeJob> =>
        ipcRenderer.invoke(IPC.godModeJobClaim, root, id),
      control: (root: string, input: JobControlInput): Promise<GodModeJob> =>
        ipcRenderer.invoke(IPC.godModeJobControl, root, input),
    },
    preview: {
      open: (input: PreviewOpenInput): Promise<PreviewSnapshot> =>
        ipcRenderer.invoke(IPC.godModePreviewOpen, input),
      get: (root: string): Promise<PreviewSnapshot | null> =>
        ipcRenderer.invoke(IPC.godModePreviewGet, root),
      refresh: (root: string): Promise<PreviewSnapshot> =>
        ipcRenderer.invoke(IPC.godModePreviewRefresh, root),
      capture: (root: string): Promise<PreviewSnapshot> =>
        ipcRenderer.invoke(IPC.godModePreviewCapture, root),
      selectElement: (root: string): Promise<PreviewSnapshot> =>
        ipcRenderer.invoke(IPC.godModePreviewSelect, root),
      close: (root: string): Promise<void> => ipcRenderer.invoke(IPC.godModePreviewClose, root),
    },
    verification: {
      plan: (root: string, changedFiles?: string[]): Promise<VerificationPlan> =>
        ipcRenderer.invoke(IPC.godModeVerificationPlan, root, changedFiles),
      run: (
        planId: string,
        checkIds: string[],
        confirmation: boolean,
      ): Promise<VerificationRunResult> =>
        ipcRenderer.invoke(IPC.godModeVerificationRun, planId, checkIds, confirmation),
      cancel: (planId: string): Promise<void> =>
        ipcRenderer.invoke(IPC.godModeVerificationCancel, planId),
    },
    debugger: {
      captureEvidence: (threadId: number): Promise<DebugEvidenceSnapshot> =>
        ipcRenderer.invoke(IPC.godModeDebugEvidence, threadId),
    },
    issue: {
      load: (root: string, issue: GithubIssueRef): Promise<GithubIssue> =>
        ipcRenderer.invoke(IPC.godModeIssueLoad, root, issue),
      plan: (root: string, issue: GithubIssueRef): Promise<IssueWorkPlan> =>
        ipcRenderer.invoke(IPC.godModeIssuePlan, root, issue),
      start: (root: string, issue: GithubIssueRef, confirmation: boolean): Promise<IssueWorkPlan> =>
        ipcRenderer.invoke(IPC.godModeIssueStart, root, issue, confirmation),
      createPr: (input: PullRequestInput): Promise<PullRequestResult> =>
        ipcRenderer.invoke(IPC.godModeIssueCreatePr, input),
    },
    workspaces: {
      list: (root: string): Promise<IsolatedWorkspaceProfile[]> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceList, root),
      create: (input: CreateIsolatedWorkspaceInput): Promise<IsolatedWorkspaceProfile> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceCreate, input),
      probe: (input: WorkspaceProbeInput): Promise<RemoteProbeResult> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceProbe, input),
      run: (
        root: string,
        profileId: string,
        command: string,
        confirmation: boolean,
      ): Promise<WorkspaceCommandResult> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceRun, root, profileId, command, confirmation),
      cancel: (profileId: string): Promise<void> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceCancel, profileId),
      remove: (
        root: string,
        profileId: string,
        confirmation: boolean,
      ): Promise<IsolatedWorkspaceProfile[]> =>
        ipcRenderer.invoke(IPC.godModeWorkspaceRemove, root, profileId, confirmation),
    },
    extensions: {
      list: (root: string): Promise<ExtensionSandboxStatus[]> =>
        ipcRenderer.invoke(IPC.godModeExtensionList, root),
      enable: (
        root: string,
        id: string,
        confirmation: boolean,
        allowUnsigned: boolean,
      ): Promise<ExtensionSandboxStatus[]> =>
        ipcRenderer.invoke(IPC.godModeExtensionEnable, root, id, confirmation, allowUnsigned),
      disable: (root: string, id: string): Promise<ExtensionSandboxStatus[]> =>
        ipcRenderer.invoke(IPC.godModeExtensionDisable, root, id),
    },
    collaboration: {
      list: (root: string): Promise<CollaborationSession[]> =>
        ipcRenderer.invoke(IPC.godModeCollaborationList, root),
      create: (root: string, title: string): Promise<CollaborationSession> =>
        ipcRenderer.invoke(IPC.godModeCollaborationCreate, { root, title }),
      addEvent: (
        root: string,
        sessionId: string,
        input: Pick<CollaborationEvent, 'kind' | 'text' | 'evidenceIds'>,
      ): Promise<CollaborationSession> =>
        ipcRenderer.invoke(IPC.godModeCollaborationAddEvent, root, sessionId, input),
      export: (root: string, sessionId: string): Promise<CollaborationExport> =>
        ipcRenderer.invoke(IPC.godModeCollaborationExport, root, sessionId),
      share: (
        root: string,
        sessionId: string,
        confirmation: boolean,
      ): Promise<CollaborationSession> =>
        ipcRenderer.invoke(IPC.godModeCollaborationShare, root, sessionId, confirmation),
      addMember: (
        root: string,
        sessionId: string,
        userId: string,
        role: CollaborationRole,
        confirmation: boolean,
      ): Promise<CollaborationSession> =>
        ipcRenderer.invoke(
          IPC.godModeCollaborationAddMember,
          root,
          sessionId,
          userId,
          role,
          confirmation,
        ),
    },
    deployment: {
      saveHook: (
        root: string,
        targetId: string,
        hookUrl: string,
        confirmation: boolean,
      ): Promise<{
        secretRef: string;
        hookOrigin: string;
        hookRevision: string;
        hookUrlSha256: string;
      }> =>
        ipcRenderer.invoke(IPC.godModeDeploymentSaveHook, root, targetId, hookUrl, confirmation),
      plan: (root: string, target: DeploymentTarget): Promise<DeploymentPlan> =>
        ipcRenderer.invoke(IPC.godModeDeploymentPlan, { root, target }),
      execute: (root: string, input: ExecuteDeploymentInput): Promise<DeploymentRun> =>
        ipcRenderer.invoke(IPC.godModeDeploymentExecute, { root, ...input }),
      list: (root: string): Promise<DeploymentRun[]> =>
        ipcRenderer.invoke(IPC.godModeDeploymentList, root),
      cancel: (runId: string): Promise<void> =>
        ipcRenderer.invoke(IPC.godModeDeploymentCancel, runId),
    },
  },
  secrets: {
    set: (key: string, value: string, binding: AiCredentialBinding): Promise<void> =>
      ipcRenderer.invoke(IPC.secretsSet, key, value, binding),
    has: (key: string, binding?: AiCredentialBinding): Promise<boolean> =>
      ipcRenderer.invoke(IPC.secretsHas, key, binding),
    delete: (key: string): Promise<void> => ipcRenderer.invoke(IPC.secretsDelete, key),
  },
  /** AI provider helpers. Test / discover a Custom OpenAI-compatible endpoint. */
  ai: {
    testConnection: (input: AiConnectionInput): Promise<AiTestResult> =>
      ipcRenderer.invoke(IPC.aiTestConnection, input),
    fetchModels: (input: AiConnectionInput): Promise<AiModelsResult> =>
      ipcRenderer.invoke(IPC.aiFetchModels, input),
    /** Start a streaming chat; resolves with Main-authoritative terminal metadata. */
    chatSend: (input: ChatSendInput): Promise<import('../common/ipc').ChatSendResult> =>
      ipcRenderer.invoke(IPC.aiChatSend, input),
    /** Read sanitized Main-only diagnostics for this provider connection. */
    diagnostics: (
      input: import('../common/ipc').AiDiagnosticsInput,
    ): Promise<import('../common/ipc').AiDiagnosticsSnapshot> =>
      ipcRenderer.invoke(IPC.aiDiagnosticsGet, input),
    /** Cancel an in-flight chat stream by request id. */
    chatCancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.aiChatCancel, id),
    /** Resolve an opaque workspace + egress identity for conversation isolation. */
    connectionScope: (input: AiConnectionScopeInput): Promise<string> =>
      ipcRenderer.invoke(IPC.aiConnectionScope, input),
    /** Assemble an automatic grounding-context block for a message. */
    buildContext: (input: BuildContextInput): Promise<ContextResult> =>
      ipcRenderer.invoke(IPC.aiBuildContext, input),
    /** Code Review (PRD §135) — review a scope of code into structured findings. */
    review: (input: {
      provider: string;
      model: string;
      baseUrl: string;
      headers: Record<string, string>;
      code: string;
      label: string;
    }): Promise<ReviewResult> => ipcRenderer.invoke(IPC.aiReview, input),
    /** Multi-file Composer (PRD §130) — produce a coordinated multi-file edit plan. */
    compose: (input: {
      provider: string;
      model: string;
      baseUrl: string;
      headers: Record<string, string>;
      instruction: string;
      context?: string;
    }): Promise<EditPlan> => ipcRenderer.invoke(IPC.aiCompose, input),
    /** Predictive ghost-text completion bound to a document version and request id. */
    complete: (input: PredictiveCompletionInput): Promise<PredictiveCompletionResult> =>
      ipcRenderer.invoke(IPC.aiComplete, input),
    cancelCompletion: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.aiCompleteCancel, requestId),
    completionFeedback: (feedback: PredictionFeedback): Promise<void> =>
      ipcRenderer.invoke(IPC.aiCompleteFeedback, feedback),
    completionMetrics: (): Promise<PredictionMetrics> => ipcRenderer.invoke(IPC.aiCompleteMetrics),
    /** Inline edit (PRD §129.3 / Phase 187) — rewrite a selection via instruction. */
    inlineEdit: (input: {
      instruction: string;
      selection: string;
      language: string;
      filename?: string;
      prefix?: string;
      suffix?: string;
    }): Promise<InlineEditResult> => ipcRenderer.invoke(IPC.aiInlineEdit, input),
    /** Inline chat (PRD §129.4 / Phase 188) — quick read-only Q&A at the cursor. */
    inlineChat: (input: {
      question: string;
      selection: string;
      language: string;
      filename?: string;
      prefix?: string;
      suffix?: string;
    }): Promise<InlineChatResult> => ipcRenderer.invoke(IPC.aiInlineChat, input),
    /** Git AI (PRD §113.8 / Phase 231) — generate a commit message from a staged diff. */
    commitMessage: (input: { diff: string }): Promise<{ text: string; error?: string }> =>
      ipcRenderer.invoke(IPC.aiCommitMessage, input),
    /** AI spend ledger — session/today/all-time totals (PRD Phases 152/197). */
    spend: {
      summary: (): Promise<SpendSummary> => ipcRenderer.invoke(IPC.aiSpendSummary),
      clear: (): Promise<SpendSummary> => ipcRenderer.invoke(IPC.aiSpendClear),
      onChanged: (callback: (summary: SpendSummary) => void): (() => void) => {
        const listener = (_e: IpcRendererEvent, payload: SpendSummary): void => callback(payload);
        ipcRenderer.on(IPC.aiSpendChanged, listener);
        return () => ipcRenderer.removeListener(IPC.aiSpendChanged, listener);
      },
    },
    /** Provider health / circuit breaker (PRD Phases 167/168). */
    providerHealth: (): Promise<ProviderHealthSummary[]> =>
      ipcRenderer.invoke(IPC.aiProviderHealth),
    /** Detect a local, keyless model server (free, zero-egress AI). */
    detectLocalModels: (): Promise<LocalModelProbe> => ipcRenderer.invoke(IPC.aiDetectLocalModels),
    /** Subscribe to streamed chat deltas. Returns an unsubscribe fn. */
    onChunk: (callback: (chunk: ChatChunk) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: ChatChunk): void => callback(payload);
      ipcRenderer.on(IPC.aiChatChunk, listener);
      return () => ipcRenderer.removeListener(IPC.aiChatChunk, listener);
    },
    /** Subscribe to a turn's token usage + estimated cost. Returns an unsubscribe fn. */
    onUsage: (callback: (usage: ChatUsage) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: ChatUsage): void => callback(payload);
      ipcRenderer.on(IPC.aiChatUsage, listener);
      return () => ipcRenderer.removeListener(IPC.aiChatUsage, listener);
    },
    /** Persisted chat conversations. */
    conversations: {
      read: (): Promise<AiConversation[]> => ipcRenderer.invoke(IPC.aiConvRead),
      write: (list: AiConversation[]): Promise<void> => ipcRenderer.invoke(IPC.aiConvWrite, list),
      mutate: (mutation: AiConversationMutation): Promise<AiConversation[]> =>
        ipcRenderer.invoke(IPC.aiConvMutate, mutation),
    },
  },
  /** Debugger (DAP) — start/stop, breakpoints, stepping, inspection (PRD 96–101). */
  debug: {
    discover: (root: string): Promise<DiscoveredDebugConfig[]> =>
      ipcRenderer.invoke(IPC.debugDiscover, root),
    start: (
      config: DebugLaunchConfig,
      breakpoints: Record<string, DebugBreakpoint[]>,
    ): Promise<DebugStartResult> => ipcRenderer.invoke(IPC.debugStart, { config, breakpoints }),
    setBreakpoints: (path: string, breakpoints: DebugBreakpoint[]): Promise<void> =>
      ipcRenderer.invoke(IPC.debugSetBreakpoints, path, breakpoints),
    control: (action: DebugControlAction, threadId: number): Promise<void> =>
      ipcRenderer.invoke(IPC.debugControl, action, threadId),
    stackTrace: (threadId: number): Promise<DebugStackFrame[]> =>
      ipcRenderer.invoke(IPC.debugStackTrace, threadId),
    scopes: (frameId: number): Promise<DebugScope[]> =>
      ipcRenderer.invoke(IPC.debugScopes, frameId),
    variables: (ref: number): Promise<DebugVariable[]> =>
      ipcRenderer.invoke(IPC.debugVariables, ref),
    evaluate: (expression: string, frameId: number | null): Promise<DebugEvalResult> =>
      ipcRenderer.invoke(IPC.debugEvaluate, expression, frameId),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.debugStop),
    onEvent: (callback: (e: DebugEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: DebugEvent): void => callback(payload);
      ipcRenderer.on(IPC.debugEvent, listener);
      return () => ipcRenderer.removeListener(IPC.debugEvent, listener);
    },
  },
  /** Agent runtime (PRD Epoch H) — run a tool-using agent on a task. */
  agent: {
    run: (input: AgentRunInput): Promise<void> => ipcRenderer.invoke(IPC.agentRun, input),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.agentCancel, id),
    acknowledgeApproval: (id: string, approvalToken: string): Promise<void> =>
      ipcRenderer.invoke(IPC.agentApprovalShown, id, approvalToken),
    /**
     * Settle an approval preview. `remember` asks Main to widen the decision to
     * future runs of the same command; Main accepts it only when it offers that
     * scope for the exact preview it emitted.
     */
    approve: (
      id: string,
      approvalToken: string,
      approved: boolean,
      remember?: CommandConsentScope,
    ): Promise<void> => ipcRenderer.invoke(IPC.agentApprove, id, approvalToken, approved, remember),
    onEvent: (callback: (e: AgentStepEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AgentStepEvent): void => callback(payload);
      ipcRenderer.on(IPC.agentEvent, listener);
      return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
    },
    /** Session-scoped batch consent for ordinary file edits in a trusted folder. */
    writeConsent: {
      get: (root: string): Promise<WriteConsentState> =>
        ipcRenderer.invoke(IPC.agentWriteConsentGet, root),
      grant: (
        root: string,
        confirmation: boolean,
        durationMs?: number,
        persist?: boolean,
      ): Promise<WriteConsentState> =>
        ipcRenderer.invoke(IPC.agentWriteConsentGrant, root, confirmation, durationMs, persist),
      revoke: (root: string): Promise<WriteConsentState> =>
        ipcRenderer.invoke(IPC.agentWriteConsentRevoke, root),
    },
    tasks: (root: string): Promise<AgentTask[]> => ipcRenderer.invoke(IPC.agentTasks, root),
    onTaskUpdate: (callback: (t: AgentTask) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AgentTask): void => callback(payload);
      ipcRenderer.on(IPC.agentTaskUpdate, listener);
      return () => ipcRenderer.removeListener(IPC.agentTaskUpdate, listener);
    },
    runs: {
      list: (root: string): Promise<RunRecord[]> => ipcRenderer.invoke(IPC.agentRunsList, root),
      clear: (root: string): Promise<void> => ipcRenderer.invoke(IPC.agentRunsClear, root),
      resumable: (root: string): Promise<RunRecord[]> =>
        ipcRenderer.invoke(IPC.agentRunsResumable, root),
      branch: (
        root: string,
        id: string,
        branchIndex: number,
        guidance?: string,
      ): Promise<BranchPlan | null> =>
        ipcRenderer.invoke(IPC.agentRunBranch, root, id, branchIndex, guidance),
      reinvoke: (
        root: string,
        id: string,
        kind: ReinvokeKind,
        options?: { branchIndex?: number; guidance?: string },
      ): Promise<ReinvokeRequest | null> =>
        ipcRenderer.invoke(
          IPC.agentRunReinvoke,
          root,
          id,
          kind,
          options?.branchIndex,
          options?.guidance,
        ),
    },
  },
  /** Custom agents (PRD §147) — user-authored agent definitions merged into the library. */
  customAgents: {
    list: (): Promise<AgentPreset[]> => ipcRenderer.invoke(IPC.customAgentsList),
    save: (input: Partial<AgentPreset>): Promise<AgentPreset[]> =>
      ipcRenderer.invoke(IPC.customAgentsSave, input),
    remove: (id: string): Promise<AgentPreset[]> => ipcRenderer.invoke(IPC.customAgentsDelete, id),
  },
  /**
   * Shareable agent presets committed in the repository (.axiom/agents). Listing
   * only reports what the repo declares; the renderer decides what to enable.
   */
  workspaceAgents: {
    list: (root: string): Promise<WorkspaceAgentFile[]> =>
      ipcRenderer.invoke(IPC.workspaceAgentsList, root),
    share: (root: string, id: string): Promise<string> =>
      ipcRenderer.invoke(IPC.workspaceAgentsShare, root, id),
  },
  /** Workflow automation & hooks (PRD §148 / Phase 236) — store user workflows. */
  workflows: {
    list: (): Promise<Workflow[]> => ipcRenderer.invoke(IPC.workflowsList),
    save: (wf: Partial<Workflow>): Promise<Workflow[]> => ipcRenderer.invoke(IPC.workflowsSave, wf),
    remove: (id: string): Promise<Workflow[]> => ipcRenderer.invoke(IPC.workflowsDelete, id),
    setEnabled: (id: string, enabled: boolean): Promise<Workflow[]> =>
      ipcRenderer.invoke(IPC.workflowsSetEnabled, id, enabled),
  },
  /** MCP client (PRD §80.3 / Phase 237) — connect external tool servers. */
  mcp: {
    listServers: (root: string): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(IPC.mcpListServers, root),
    saveServer: (root: string, cfg: Partial<McpServerConfig>): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(IPC.mcpSaveServer, root, cfg),
    deleteServer: (root: string, id: string): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(IPC.mcpDeleteServer, root, id),
    setEnabled: (root: string, id: string, enabled: boolean): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(IPC.mcpSetEnabled, root, id, enabled),
    connect: (root: string, id: string): Promise<McpConnectResult> =>
      ipcRenderer.invoke(IPC.mcpConnect, root, id),
    disconnect: (root: string, id: string): Promise<void> =>
      ipcRenderer.invoke(IPC.mcpDisconnect, root, id),
    disconnectWorkspace: (root: string): Promise<void> =>
      ipcRenderer.invoke(IPC.mcpDisconnectWorkspace, root),
    connections: (root: string): Promise<McpConnectionStatus[]> =>
      ipcRenderer.invoke(IPC.mcpConnections, root),
    callTool: (
      root: string,
      serverId: string,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ text: string; isError: boolean }> =>
      ipcRenderer.invoke(IPC.mcpCallTool, root, serverId, tool, args),
  },
  /** Workspace rules & coding standards (PRD §145 / Phase 233). */
  rules: {
    list: (root: string | null): Promise<Rule[]> => ipcRenderer.invoke(IPC.rulesList, root),
    saveGlobal: (rule: Partial<Rule>): Promise<Rule[]> =>
      ipcRenderer.invoke(IPC.rulesSaveGlobal, rule),
    deleteGlobal: (id: string): Promise<Rule[]> => ipcRenderer.invoke(IPC.rulesDeleteGlobal, id),
    proposeConventions: (root: string | null): Promise<ProposedRule[]> =>
      ipcRenderer.invoke(IPC.rulesProposeConventions, root),
  },
  /** Prompt library & history (PRD §146 / Phase 234). */
  prompts: {
    list: (): Promise<PromptTemplate[]> => ipcRenderer.invoke(IPC.promptsList),
    save: (p: Partial<PromptTemplate>): Promise<PromptTemplate[]> =>
      ipcRenderer.invoke(IPC.promptsSave, p),
    remove: (id: string): Promise<PromptTemplate[]> => ipcRenderer.invoke(IPC.promptsDelete, id),
    recordUse: (id: string): Promise<PromptTemplate[]> =>
      ipcRenderer.invoke(IPC.promptsRecordUse, id),
  },
  /** Extensions (PRD Epoch I §117 / Phases 239–242) — discover + enable + registry. */
  extensions: {
    list: (root: string | null): Promise<ExtensionManifest[]> =>
      ipcRenderer.invoke(IPC.extensionsList, root),
    setEnabled: (id: string, enabled: boolean, root: string | null): Promise<ExtensionManifest[]> =>
      ipcRenderer.invoke(IPC.extensionsSetEnabled, id, enabled, root),
    registry: (root: string | null): Promise<ContributionRegistry> =>
      ipcRenderer.invoke(IPC.extensionsRegistry, root),
    hostStatus: (): Promise<Array<{ extId: string; active: boolean }>> =>
      ipcRenderer.invoke(IPC.extensionsHostStatus),
    registryIndex: (root: string | null): Promise<RegistryIndex> =>
      ipcRenderer.invoke(IPC.extensionsRegistryIndex, root),
    install: (id: string, root: string | null): Promise<ExtensionManifest[]> =>
      ipcRenderer.invoke(IPC.extensionsInstall, id, root),
  },
  /**
   * Open VSX marketplace: browse the registry, install VS Code-compatible packages, and
   * read the declarative contributions of whatever is enabled.
   *
   * Deliberately separate from `extensions` above, which serves AXIOM's native model.
   * Only the operations Main actually implements are exposed; there is no generic
   * "invoke" escape hatch, so the renderer's reach is exactly this list.
   */
  market: {
    reachable: (): Promise<boolean> => ipcRenderer.invoke(IPC.marketReachable),
    browse: (query: MarketSearchQuery): Promise<RegistrySearchPage> =>
      ipcRenderer.invoke(IPC.marketBrowse, query),
    detail: (id: string, version?: string): Promise<RegistryExtensionDetail> =>
      ipcRenderer.invoke(IPC.marketDetail, id, version),
    versions: (id: string, offset?: number, size?: number): Promise<RegistryVersionPage> =>
      ipcRenderer.invoke(IPC.marketVersions, id, offset, size),
    reviews: (id: string): Promise<RegistryReview[]> => ipcRenderer.invoke(IPC.marketReviews, id),
    publisher: (namespace: string): Promise<RegistryPublisherDetail> =>
      ipcRenderer.invoke(IPC.marketPublisher, namespace),
    document: (url: string): Promise<string> => ipcRenderer.invoke(IPC.marketDocument, url),

    installed: (root: string | null): Promise<InstalledExtensionSummary[]> =>
      ipcRenderer.invoke(IPC.marketInstalled, root),
    installedDetail: (id: string, root: string | null): Promise<InstalledExtensionDetail> =>
      ipcRenderer.invoke(IPC.marketInstalledDetail, id, root),
    install: (id: string, version?: string): Promise<MarketInstallOutcome> =>
      ipcRenderer.invoke(IPC.marketInstall, id, version),
    /** Opens a native picker in Main; the renderer never supplies a path. */
    installFromFile: (): Promise<MarketInstallOutcome | null> =>
      ipcRenderer.invoke(IPC.marketInstallFile),
    uninstall: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.marketUninstall, id),
    setEnabled: (
      id: string,
      enabled: boolean,
      target: 'global' | 'workspace',
      root: string | null,
    ): Promise<boolean> => ipcRenderer.invoke(IPC.marketSetEnabled, id, enabled, target, root),
    setAutoUpdate: (id: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.marketSetAutoUpdate, id, enabled),
    setAutoUpdateAll: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.marketSetAutoUpdateAll, enabled),
    checkUpdates: (force?: boolean): Promise<MarketUpdatePlanEntry[]> =>
      ipcRenderer.invoke(IPC.marketCheckUpdates, force),
    updateAll: (): Promise<MarketUpdateAllOutcome> => ipcRenderer.invoke(IPC.marketUpdateAll),

    contributions: (root: string | null): Promise<ExtensionContributionCatalog> =>
      ipcRenderer.invoke(IPC.marketContributions, root),
    loadTheme: (key: string, root: string | null): Promise<ConvertedTheme | null> =>
      ipcRenderer.invoke(IPC.marketLoadTheme, key, root),
    loadIconTheme: (key: string, root: string | null): Promise<IconThemeDefinition | null> =>
      ipcRenderer.invoke(IPC.marketLoadIconTheme, key, root),
    snippets: (language: string, root: string | null): Promise<ContributedSnippet[]> =>
      ipcRenderer.invoke(IPC.marketSnippets, language, root),
    loadGrammar: (
      scopeName: string,
      root: string | null,
    ): Promise<ContributedGrammarSource | null> =>
      ipcRenderer.invoke(IPC.marketLoadGrammar, scopeName, root),

    /** Fires when the installed set or its enablement changes, in any window. */
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.marketChanged, handler);
      return () => ipcRenderer.removeListener(IPC.marketChanged, handler);
    },
  },
  /**
   * Extension hosts: extension code running out of process.
   *
   * The renderer names extensions and commands. It never receives a handle to a process, and
   * it never supplies a filesystem path here — activation, brokering and path authorization
   * all happen in Main.
   */
  host: {
    list: (root: string | null): Promise<HostStatus[]> => ipcRenderer.invoke(IPC.hostList, root),
    setConsent: (id: string, granted: boolean, root: string | null): Promise<boolean> =>
      ipcRenderer.invoke(IPC.hostSetConsent, id, granted, root),
    stop: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.hostStop, id),
    restart: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.hostRestart, id),
    runCommand: (command: string, args: unknown[], root: string | null): Promise<unknown> =>
      ipcRenderer.invoke(IPC.hostRunCommand, command, args, root),
    statusItems: (): Promise<HostStatusBarItem[]> => ipcRenderer.invoke(IPC.hostStatusItems),
    diagnostics: (): Promise<Array<{ owner: string; diagnostics: HostDiagnostic[] }>> =>
      ipcRenderer.invoke(IPC.hostDiagnostics),
    output: (id: string): Promise<string[]> => ipcRenderer.invoke(IPC.hostOutput, id),
    reportActiveEditor: (
      path: string | null,
      languageId: string | null,
      root: string | null,
    ): Promise<boolean> => ipcRenderer.invoke(IPC.hostActiveEditor, path, languageId, root),
    /**
     * Report a UI trigger so anything waiting on it activates: a contributed view being
     * revealed, a webview being restored, a notebook being opened. Returns the ids that
     * started, so a caller can render an empty state while it waits.
     */
    activate: (kind: string, value: string | null, root: string | null): Promise<string[]> =>
      ipcRenderer.invoke(IPC.hostActivate, kind, value, root),
    answerPrompt: (id: number, value: string | null): Promise<boolean> =>
      ipcRenderer.invoke(IPC.hostPromptReply, id, value),
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.hostChanged, handler);
      return () => ipcRenderer.removeListener(IPC.hostChanged, handler);
    },
    onPrompt: (listener: (request: HostPromptRequest) => void): (() => void) => {
      const handler = (_event: unknown, request: HostPromptRequest): void => listener(request);
      ipcRenderer.on(IPC.hostPrompt, handler);
      return () => ipcRenderer.removeListener(IPC.hostPrompt, handler);
    },
    onCrashLoop: (
      listener: (info: { extensionId: string; displayName: string; crashes: number }) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        info: { extensionId: string; displayName: string; crashes: number },
      ): void => listener(info);
      ipcRenderer.on(IPC.hostCrashLoop, handler);
      return () => ipcRenderer.removeListener(IPC.hostCrashLoop, handler);
    },
    onOpenFile: (listener: (path: string) => void): (() => void) => {
      const handler = (_event: unknown, payload: { path: string }): void => listener(payload.path);
      ipcRenderer.on(IPC.hostOpenFile, handler);
      return () => ipcRenderer.removeListener(IPC.hostOpenFile, handler);
    },
    onWorkbenchCommand: (listener: (command: string, args: unknown[]) => void): (() => void) => {
      const handler = (_event: unknown, payload: { command: string; args: unknown[] }): void =>
        listener(payload.command, payload.args ?? []);
      ipcRenderer.on(IPC.hostWorkbenchCommand, handler);
      return () => ipcRenderer.removeListener(IPC.hostWorkbenchCommand, handler);
    },
  },
  /**
   * Extension webviews (PRD Phase 4).
   *
   * The renderer owns the iframes: it draws them from these snapshots, and it forwards a frame's
   * messages only after checking `event.source` and `event.origin` itself. No extension HTML
   * crosses this boundary in either direction — the frame fetches its document from its own
   * origin — and the renderer never names a filesystem path here.
   */
  webview: {
    list: (): Promise<WebviewSnapshot[]> => ipcRenderer.invoke(IPC.webviewList),
    frameMessage: (handle: string, message: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC.webviewFrameMessage, handle, message),
    visibility: (handle: string, visible: boolean, active: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.webviewVisibility, handle, visible, active),
    close: (handle: string): Promise<boolean> => ipcRenderer.invoke(IPC.webviewClose, handle),
    reveal: (handle: string): Promise<boolean> => ipcRenderer.invoke(IPC.webviewReveal, handle),
    resolveView: (viewType: string): Promise<WebviewSnapshot | null> =>
      ipcRenderer.invoke(IPC.webviewResolveView, viewType),
    restore: (): Promise<boolean> => ipcRenderer.invoke(IPC.webviewRestore),
    theme: (payload: {
      kind: WebviewThemeKind;
      name: string;
      variables: Record<string, string>;
    }): Promise<boolean> => ipcRenderer.invoke(IPC.webviewTheme, payload),
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.webviewChanged, handler);
      return () => ipcRenderer.removeListener(IPC.webviewChanged, handler);
    },
    onPost: (
      listener: (handle: string, envelope: Record<string, unknown>) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        payload: { handle: string; envelope: Record<string, unknown> },
      ): void => listener(payload.handle, payload.envelope);
      ipcRenderer.on(IPC.webviewPost, handler);
      return () => ipcRenderer.removeListener(IPC.webviewPost, handler);
    },
  },
  /**
   * The workbench view runtime (PRD Phase 5).
   *
   * Contributed activity-bar containers, tree views, menus and context keys. The renderer draws
   * rows and reports what the user did; Main owns the providers, the handles and the decision about
   * which command a menu may run. Nothing here carries a path, an element or extension HTML.
   */
  views: {
    workbench: (): Promise<WorkbenchSnapshot> => ipcRenderer.invoke(IPC.viewsWorkbench),
    tree: (viewId: string, viewportHeight: number): Promise<TreeViewSnapshot | null> =>
      ipcRenderer.invoke(IPC.viewsTree, viewId, viewportHeight),
    visibility: (viewId: string, visible: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsVisibility, viewId, visible),
    /** `handle: null` collapses every row, for the view-title collapse-all button. */
    expand: (viewId: string, handle: string | null, expanded: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsExpand, viewId, handle, expanded),
    select: (viewId: string, handles: string[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsSelect, viewId, handles),
    activate: (viewId: string, handle: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsActivate, viewId, handle),
    checkbox: (viewId: string, handle: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsCheckbox, viewId, handle),
    key: (viewId: string, key: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsKey, viewId, key),
    resolveItem: (viewId: string, handle: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsResolveItem, viewId, handle),
    layout: (payload: {
      activeContainer?: string | null;
      viewId?: string;
      collapsed?: boolean;
      size?: number | null;
      scrollTop?: number;
    }): Promise<boolean> => ipcRenderer.invoke(IPC.viewsLayout, payload),
    menu: (
      location: string,
      scope?: { viewId?: string; handle?: string; keys?: Record<string, unknown> },
    ): Promise<ResolvedMenuGroup[]> => ipcRenderer.invoke(IPC.viewsMenu, location, scope ?? {}),
    runMenuCommand: (
      location: string,
      command: string,
      scope?: {
        viewId?: string;
        handle?: string;
        keys?: Record<string, unknown>;
        args?: unknown[];
      },
    ): Promise<boolean> => ipcRenderer.invoke(IPC.viewsMenuCommand, location, command, scope ?? {}),
    context: (values: Record<string, unknown>): Promise<boolean> =>
      ipcRenderer.invoke(IPC.viewsContext, values),
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.viewsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.viewsChanged, handler);
    },
  },
  /**
   * The language platform (PRD Phase 6).
   *
   * Monaco asks for the registry once, then asks for a feature by name. It never learns which
   * extension answered: results arrive already merged and sanitised, and a request is cancelled by id,
   * so a token from one provider can never be replayed against another. Named `languageProviders`
   * rather than `languages` because `languages` is already the language-pack installer.
   */
  languageProviders: {
    registry: (): Promise<ExtensionLanguageRegistry> => ipcRenderer.invoke(IPC.languagesRegistry),
    provide: (request: ExtensionProvideInput): Promise<ExtensionProvideResult> =>
      ipcRenderer.invoke(IPC.languagesProvide, request),
    cancel: (requestId: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.languagesCancel, requestId),
    document: (event: ExtensionDocumentInput): Promise<ExtensionDocumentResult> =>
      ipcRenderer.invoke(IPC.languagesDocument, event),
    /** Apply the part of a provider `WorkspaceEdit` the editor could not: closed files, file ops. */
    applyProviderEdit: (edit: ExtensionProviderEditInput): Promise<boolean> =>
      ipcRenderer.invoke(IPC.languagesApplyProviderEdit, edit),
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.languagesChanged, handler);
      return () => ipcRenderer.removeListener(IPC.languagesChanged, handler);
    },
    /**
     * Named providers invalidated their answers.
     *
     * The payload is forwarded unvalidated *here* on purpose — preload has no business deciding
     * whether a provider handle is one the renderer knows, and the renderer validates the batch it
     * receives before turning a handle into a Monaco event.
     */
    onProviderChanged: (listener: (batch: unknown) => void): (() => void) => {
      const handler = (_event: unknown, batch: unknown): void => listener(batch);
      ipcRenderer.on(IPC.languagesProviderChanged, handler);
      return () => ipcRenderer.removeListener(IPC.languagesProviderChanged, handler);
    },
    onApplyEdit: (listener: (payload: ExtensionApplyEditPayload) => void): (() => void) => {
      const handler = (_event: unknown, payload: ExtensionApplyEditPayload): void =>
        listener(payload);
      ipcRenderer.on(IPC.languagesApplyEdit, handler);
      return () => ipcRenderer.removeListener(IPC.languagesApplyEdit, handler);
    },
  },
  /**
   * The extension runtime: terminals, tasks and debug sessions (PRD Phase 7).
   *
   * Pull-then-subscribe, like every other extension surface here. The renderer owns the panes and
   * reports what happened to them; Main owns which extension a pane belongs to and never takes that
   * from the renderer, so a compromised renderer can report an event but cannot reassign a terminal.
   */
  extensionRuntime: {
    terminals: (): Promise<{ revision: number; terminals: ExtensionTerminalInfo[] }> =>
      ipcRenderer.invoke(IPC.runtimeTerminals),
    /** Report a pane the renderer adopted: opened, closed, typed into, resized, focused. */
    reportTerminal: (event: ExtensionTerminalEvent): Promise<boolean> =>
      ipcRenderer.invoke(IPC.runtimeTerminalEvent, event),
    tasks: (): Promise<{ revision: number; executions: ExtensionTaskExecutionInfo[] }> =>
      ipcRenderer.invoke(IPC.runtimeTasks),
    debugSessions: (): Promise<{ revision: number; sessions: ExtensionDebugSessionInfo[] }> =>
      ipcRenderer.invoke(IPC.runtimeDebugSessions),
    debugConsole: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC.runtimeDebugConsole, sessionId),
    /** An extension asked for one of its terminals to be created, shown, renamed, written or closed. */
    onTerminalCommand: (listener: (command: ExtensionTerminalCommand) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, command: ExtensionTerminalCommand): void =>
        listener(command);
      ipcRenderer.on(IPC.runtimeTerminalCommand, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeTerminalCommand, handler);
    },
    onTerminalsChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.runtimeTerminalsChanged, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeTerminalsChanged, handler);
    },
    onTaskOutput: (listener: (event: ExtensionTaskOutputEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: ExtensionTaskOutputEvent): void =>
        listener(payload);
      ipcRenderer.on(IPC.runtimeTaskOutput, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeTaskOutput, handler);
    },
    onTasksChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.runtimeTasksChanged, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeTasksChanged, handler);
    },
    onDebugConsole: (
      listener: (payload: { sessionId: string; text: string }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: { sessionId: string; text: string },
      ): void => listener(payload);
      ipcRenderer.on(IPC.runtimeDebugConsole, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeDebugConsole, handler);
    },
    onDebugChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener();
      ipcRenderer.on(IPC.runtimeDebugChanged, handler);
      return () => ipcRenderer.removeListener(IPC.runtimeDebugChanged, handler);
    },
  },
  /** Local hash-chained audit log (PRD Part X §187) — read + verify integrity. */ audit: {
    read: (limit?: number): Promise<AuditEvent[]> => ipcRenderer.invoke(IPC.auditRead, limit),
    verify: (): Promise<AuditVerifyResult> => ipcRenderer.invoke(IPC.auditVerify),
  },
  /** Auto-update check (PRD Epoch A §86 / Phase 17) — evaluates the local dev feed. */
  autoUpdate: {
    check: (): Promise<UpdateDecision> => ipcRenderer.invoke(IPC.autoUpdateCheck),
  },
  /**
   * Production automatic update system (UPDATEFEATURE) — Supabase-driven check,
   * background download with progress, integrity verify, install + restart, and a
   * status stream that drives the update UI + mandatory-update guard.
   */
  update: {
    check: (): Promise<UpdatePlan | null> => ipcRenderer.invoke(IPC.updateCheck),
    download: (): Promise<void> => ipcRenderer.invoke(IPC.updateDownload),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    getState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(IPC.updateGetState),
    onStatus: (callback: (e: UpdateEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: UpdateEvent): void => callback(payload);
      ipcRenderer.on(IPC.updateStatus, listener);
      return () => ipcRenderer.removeListener(IPC.updateStatus, listener);
    },
  },
  /** Long-term memory (PRD Epoch F §70) — local store CRUD + relevance selection. */
  memory: {
    list: (): Promise<MemoryEntry[]> => ipcRenderer.invoke(IPC.memoryList),
    add: (text: string, scope: MemoryScope, workspaceKey: string | null): Promise<MemoryEntry[]> =>
      ipcRenderer.invoke(IPC.memoryAdd, text, scope, workspaceKey),
    update: (id: string, patch: { text?: string; pinned?: boolean }): Promise<MemoryEntry[]> =>
      ipcRenderer.invoke(IPC.memoryUpdate, id, patch),
    remove: (id: string): Promise<MemoryEntry[]> => ipcRenderer.invoke(IPC.memoryDelete, id),
    clear: (): Promise<MemoryEntry[]> => ipcRenderer.invoke(IPC.memoryClear),
    select: (query: string, workspaceKey: string | null): Promise<MemorySelection> =>
      ipcRenderer.invoke(IPC.memorySelect, query, workspaceKey),
  },
  /** Opt-in, privacy-first telemetry (PRD Epoch E §52–53) — consent + local buffer. */
  telemetry: {
    consent: (): Promise<TelemetryConsent> => ipcRenderer.invoke(IPC.telemetryConsent),
    record: (
      category: TelemetryCategory,
      type: string,
      props?: Record<string, unknown>,
    ): Promise<void> => ipcRenderer.invoke(IPC.telemetryRecord, category, type, props),
    read: (): Promise<TelemetryEvent[]> => ipcRenderer.invoke(IPC.telemetryRead),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.telemetryClear),
  },
  /** Feature flags (PRD Epoch E §57) — resolved values (compiled defaults). */
  featureFlags: {
    all: (): Promise<Record<string, FlagValue>> => ipcRenderer.invoke(IPC.featureFlagsAll),
  },
  /** Data export / portability (PRD §32.3) — user-owned local data, no secrets. */
  dataExport: {
    build: (): Promise<string> => ipcRenderer.invoke(IPC.dataExportBuild),
    save: (): Promise<SaveFileResult | null> => ipcRenderer.invoke(IPC.dataExportSave),
  },
  /** Preferences sync engine (PRD §49.3/§55) — local mirror + offline write queue. */
  sync: {
    status: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC.syncStatus),
    snapshot: (): Promise<SyncStatus> => ipcRenderer.invoke(IPC.syncSnapshot),
    flush: (): Promise<{ flushed: number; reason?: string }> => ipcRenderer.invoke(IPC.syncFlush),
  },
  /** Snapshot & checkpoint system (PRD §143) — reversible-edit trust substrate. */
  snapshots: {
    capture: (paths: string[], label?: string): Promise<Checkpoint> =>
      ipcRenderer.invoke(IPC.snapshotCapture, paths, label),
    list: (): Promise<Checkpoint[]> => ipcRenderer.invoke(IPC.snapshotList),
    restore: (runId: string): Promise<{ restored: number }> =>
      ipcRenderer.invoke(IPC.snapshotRestore, runId),
    restoreEntry: (entryId: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke(IPC.snapshotRestoreEntry, entryId),
    readEntry: (entryId: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.snapshotReadEntry, entryId),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.snapshotClear),
  },
  /** Safe Edit Engine (PRD §142.4) — validated, atomic, all-or-nothing edits. */
  safeEdit: {
    stage: (root: string, edits: StagedEdit[]): Promise<BatchPlan> =>
      ipcRenderer.invoke(IPC.safeEditStage, root, edits),
    apply: (root: string, edits: StagedEdit[]): Promise<ApplyResult> =>
      ipcRenderer.invoke(IPC.safeEditApply, root, edits),
  },
  /** Integrated terminal (real PTY via node-pty). */
  terminal: {
    listShells: (): Promise<TerminalShellInfo[]> => ipcRenderer.invoke(IPC.termListShells),
    create: (opts: TerminalCreateOptions): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IPC.termCreate, opts),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke(IPC.termWrite, id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(IPC.termResize, id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.termKill, id),
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: TerminalDataEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.termData, listener);
      return () => ipcRenderer.removeListener(IPC.termData, listener);
    },
    onExit: (callback: (event: TerminalExitEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: TerminalExitEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.termExit, listener);
      return () => ipcRenderer.removeListener(IPC.termExit, listener);
    },
  },
  /** Rust Core sidecar (PRD Epoch C): walk, search, symbols, chunking, catalog, watcher. */
  core: {
    walk: (root: string): Promise<CoreWalkResult> => ipcRenderer.invoke(IPC.coreWalk, root),
    search: (root: string, query: string, caseSensitive = false): Promise<CoreSearchResult> =>
      ipcRenderer.invoke(IPC.coreSearch, root, query, caseSensitive),
    symbols: (path: string): Promise<CoreSymbolsResult> =>
      ipcRenderer.invoke(IPC.coreSymbols, path),
    chunk: (path: string, options?: CoreChunkOptions): Promise<CoreChunkResult> =>
      ipcRenderer.invoke(IPC.coreChunk, path, options ?? {}),
    /** On-device semantic retrieval: top-k chunks by similarity (PRD Phase 64, Part VIII §126). */
    retrieve: (
      root: string,
      query: string,
      options?: CoreRetrieveOptions,
    ): Promise<CoreRetrieveResult> =>
      ipcRenderer.invoke(IPC.coreRetrieve, root, query, options ?? {}),
    /** Embed a text into an L2-normalized vector via the on-device embedder (PRD Phase 59). */
    embed: (text: string, dim?: number): Promise<CoreEmbedResult> =>
      ipcRenderer.invoke(IPC.coreEmbed, text, dim),
    /** Knowledge graph / dependency + impact analysis (PRD Phases 65/66). */
    graph: {
      build: (root: string): Promise<CoreGraphBuildResult> =>
        ipcRenderer.invoke(IPC.coreGraphBuild, root),
      dependencies: (root: string, path: string): Promise<CoreGraphDependenciesResult> =>
        ipcRenderer.invoke(IPC.coreGraphDependencies, root, path),
      dependents: (root: string, path: string): Promise<CoreGraphDependentsResult> =>
        ipcRenderer.invoke(IPC.coreGraphDependents, root, path),
      impact: (root: string, path: string): Promise<CoreGraphImpactResult> =>
        ipcRenderer.invoke(IPC.coreGraphImpact, root, path),
      cycles: (root: string): Promise<CoreGraphCyclesResult> =>
        ipcRenderer.invoke(IPC.coreGraphCycles, root),
      edges: (root: string): Promise<CoreGraphEdgesResult> =>
        ipcRenderer.invoke(IPC.coreGraphEdges, root),
    },
    /** Automatic project understanding — frameworks, languages, scripts (PRD Phase 68). */
    project: {
      understand: (root: string): Promise<CoreProjectProfile> =>
        ipcRenderer.invoke(IPC.coreProjectUnderstand, root),
    },
    watch: (root: string): Promise<CoreWatchResult> => ipcRenderer.invoke(IPC.coreWatch, root),
    unwatch: (root: string): Promise<CoreUnwatchResult> =>
      ipcRenderer.invoke(IPC.coreUnwatch, root),
    catalog: {
      rebuild: (root: string, db: string): Promise<CoreCatalogRebuildResult> =>
        ipcRenderer.invoke(IPC.coreCatalogRebuild, root, db),
      stats: (db: string): Promise<CoreCatalogStatsResult> =>
        ipcRenderer.invoke(IPC.coreCatalogStats, db),
      query: (db: string, pattern?: string, limit?: number): Promise<CoreCatalogQueryResult> =>
        ipcRenderer.invoke(IPC.coreCatalogQuery, db, pattern, limit),
    },
    /** Subscribe to native filesystem change events. Returns an unsubscribe fn. */
    onFsEvent: (callback: (event: CoreFsEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: CoreFsEvent): void => callback(payload);
      ipcRenderer.on(IPC.coreFsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.coreFsEvent, listener);
    },
  },
  /**
   * Language servers (PRD §107). Document sync, the full LSP request surface, and
   * diagnostics. `requestId` on a request is an opaque renderer-chosen number
   * used only for cancellation — Main scopes it to this renderer.
   */
  lsp: {
    didOpen: (input: LspDidOpenInput): Promise<void> => ipcRenderer.invoke(IPC.lspDidOpen, input),
    didChange: (input: LspDidChangeInput): Promise<LspDidChangeResult> =>
      ipcRenderer.invoke(IPC.lspDidChange, input),
    /** Re-seed a document after Main reported sync drift. */
    resync: (uri: string, version: number, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.lspResync, { uri, version, text }),
    didSave: (uri: string, text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.lspDidSave, { uri, text }),
    didClose: (uri: string): Promise<void> => ipcRenderer.invoke(IPC.lspDidClose, uri),
    /** Abandon every in-flight request tagged with `requestId`. */
    cancel: (requestId: number): Promise<void> => ipcRenderer.invoke(IPC.lspCancel, requestId),
    hover: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspHoverResult> => ipcRenderer.invoke(IPC.lspHover, uri, line, character, requestId),
    completion: (
      uri: string,
      line: number,
      character: number,
      context?: LspCompletionContext,
      requestId?: number,
    ): Promise<LspCompletionResult> =>
      ipcRenderer.invoke(IPC.lspCompletion, uri, line, character, context, requestId),
    /** Fill in docs + auto-import edits for one item the user highlighted. */
    resolveCompletion: (uri: string, handle: number): Promise<LspCompletionItem | null> =>
      ipcRenderer.invoke(IPC.lspCompletionResolve, uri, handle),
    executeCompletionCommand: (uri: string, handle: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.lspExecuteCompletionCommand, uri, handle),
    definition: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspLocationResult> =>
      ipcRenderer.invoke(IPC.lspDefinition, uri, line, character, requestId),
    declaration: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspLocationResult> =>
      ipcRenderer.invoke(IPC.lspDeclaration, uri, line, character, requestId),
    references: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspLocationResult> =>
      ipcRenderer.invoke(IPC.lspReferences, uri, line, character, requestId),
    typeDefinition: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspLocationResult> =>
      ipcRenderer.invoke(IPC.lspTypeDefinition, uri, line, character, requestId),
    implementation: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspLocationResult> =>
      ipcRenderer.invoke(IPC.lspImplementation, uri, line, character, requestId),
    documentHighlight: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspDocumentHighlightResult> =>
      ipcRenderer.invoke(IPC.lspDocumentHighlight, uri, line, character, requestId),
    prepareRename: (
      uri: string,
      line: number,
      character: number,
    ): Promise<LspPrepareRenameResult> =>
      ipcRenderer.invoke(IPC.lspPrepareRename, uri, line, character),
    rename: (
      uri: string,
      line: number,
      character: number,
      newName: string,
    ): Promise<LspWorkspaceEdit> =>
      ipcRenderer.invoke(IPC.lspRename, uri, line, character, newName),
    signatureHelp: (
      uri: string,
      line: number,
      character: number,
      requestId?: number,
    ): Promise<LspSignatureHelp> =>
      ipcRenderer.invoke(IPC.lspSignatureHelp, uri, line, character, requestId),
    codeAction: (
      uri: string,
      range: LspRange,
      diagnostics: LspDiagnostic[],
      only?: string[],
      requestId?: number,
    ): Promise<LspCodeAction[]> =>
      ipcRenderer.invoke(IPC.lspCodeAction, uri, range, diagnostics, only, requestId),
    resolveCodeAction: (uri: string, handle: number): Promise<LspCodeAction | null> =>
      ipcRenderer.invoke(IPC.lspCodeActionResolve, uri, handle),
    /** Run a command-backed action (organize imports, refactors) server-side. */
    executeCodeAction: (uri: string, handle: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.lspExecuteCodeAction, uri, handle),
    documentSymbol: (uri: string, requestId?: number): Promise<LspDocumentSymbol[]> =>
      ipcRenderer.invoke(IPC.lspDocumentSymbol, uri, requestId),
    workspaceSymbol: (
      uri: string,
      query: string,
      requestId?: number,
    ): Promise<LspSymbolInformation[]> =>
      ipcRenderer.invoke(IPC.lspWorkspaceSymbol, uri, query, requestId),
    inlayHint: (uri: string, range: LspRange, requestId?: number): Promise<LspInlayHint[]> =>
      ipcRenderer.invoke(IPC.lspInlayHint, uri, range, requestId),
    foldingRange: (uri: string, requestId?: number): Promise<LspFoldingRange[]> =>
      ipcRenderer.invoke(IPC.lspFoldingRange, uri, requestId),
    selectionRange: (uri: string, positions: LspPosition[]): Promise<LspRange[]> =>
      ipcRenderer.invoke(IPC.lspSelectionRange, uri, positions),
    documentLink: (uri: string, requestId?: number): Promise<LspDocumentLink[]> =>
      ipcRenderer.invoke(IPC.lspDocumentLink, uri, requestId),
    semanticTokensLegend: (uri: string): Promise<LspSemanticTokensLegend | null> =>
      ipcRenderer.invoke(IPC.lspSemanticTokensLegend, uri),
    semanticTokens: (uri: string, requestId?: number): Promise<LspSemanticTokens | null> =>
      ipcRenderer.invoke(IPC.lspSemanticTokens, uri, requestId),
    /** Ask servers for this document's diagnostics rather than waiting for a push. */
    pullDiagnostics: (uri: string, requestId?: number): Promise<LspDiagnosticsEvent[]> =>
      ipcRenderer.invoke(IPC.lspPullDiagnostics, uri, requestId),
    formatting: (uri: string, tabSize: number, insertSpaces: boolean): Promise<LspTextEdit[]> =>
      ipcRenderer.invoke(IPC.lspFormatting, uri, tabSize, insertSpaces),
    rangeFormatting: (
      uri: string,
      range: LspRange,
      tabSize: number,
      insertSpaces: boolean,
    ): Promise<LspTextEdit[]> =>
      ipcRenderer.invoke(IPC.lspRangeFormatting, uri, range, tabSize, insertSpaces),
    onTypeFormatting: (
      uri: string,
      line: number,
      character: number,
      ch: string,
      tabSize: number,
      insertSpaces: boolean,
    ): Promise<LspTextEdit[]> =>
      ipcRenderer.invoke(IPC.lspOnTypeFormatting, uri, line, character, ch, tabSize, insertSpaces),
    serverStatuses: (rootPath: string): Promise<LspServerStatus[]> =>
      ipcRenderer.invoke(IPC.lspServerStatuses, rootPath),
    restartServer: (rootPath: string, serverId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.lspRestartServer, rootPath, serverId),
    /** Toolchains detected on this machine, for the Run system and settings. */
    runtimes: (refresh?: boolean): Promise<DetectedRuntime[]> =>
      ipcRenderer.invoke(IPC.runtimesDetect, refresh),
    /** Answer a server's `workspace/applyEdit` with whether the edit landed. */
    applyEditResult: (nonce: number, applied: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.lspApplyEditResult, nonce, applied),
    /** Subscribe to language-server diagnostics. Returns an unsubscribe fn. */
    onDiagnostics: (callback: (evt: LspDiagnosticsEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: LspDiagnosticsEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.lspDiagnostics, listener);
      return () => ipcRenderer.removeListener(IPC.lspDiagnostics, listener);
    },
    /** Subscribe to language-server lifecycle changes. Returns an unsubscribe fn. */
    onServerStatus: (callback: (status: LspServerStatus) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: LspServerStatus): void => callback(payload);
      ipcRenderer.on(IPC.lspServerStatusChanged, listener);
      return () => ipcRenderer.removeListener(IPC.lspServerStatusChanged, listener);
    },
    /** Subscribe to server log / progress lines. Returns an unsubscribe fn. */
    onLog: (callback: (evt: LspLogEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: LspLogEvent): void => callback(payload);
      ipcRenderer.on(IPC.lspLog, listener);
      return () => ipcRenderer.removeListener(IPC.lspLog, listener);
    },
    /** Subscribe to server-requested workspace edits. Returns an unsubscribe fn. */
    onApplyEdit: (callback: (request: LspApplyEditRequest) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: LspApplyEditRequest): void =>
        callback(payload);
      ipcRenderer.on(IPC.lspApplyEdit, listener);
      return () => ipcRenderer.removeListener(IPC.lspApplyEdit, listener);
    },
  },
  /**
   * Build execution consent — the single permission taken at install time. Main owns
   * the stored value; this only reads it or asks Main to change it.
   */
  executionConsent: {
    get: (): Promise<ExecutionConsentState> => ipcRenderer.invoke(IPC.executionConsentGet),
    set: (granted: boolean): Promise<ExecutionConsentState> =>
      ipcRenderer.invoke(IPC.executionConsentSet, granted),
  },
  /**
   * LANGUAGES view. The renderer may only name a language pack id; Main owns the
   * registry, the command, the approval dialog, and the spawn.
   */
  languages: {
    catalog: (): Promise<LanguagesCatalog> => ipcRenderer.invoke(IPC.languagesCatalog),
    /** Re-read PATH from the OS and re-probe, after something was installed. */
    rescan: (): Promise<LanguagesCatalog> => ipcRenderer.invoke(IPC.languagesRescan),
    install: (languageId: string): Promise<LanguageInstallStarted> =>
      ipcRenderer.invoke(IPC.languagesInstall, languageId),
    cancelInstall: (installId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.languagesInstallCancel, installId),
    /** Subscribe to install progress and output. Returns an unsubscribe fn. */
    onInstallEvent: (callback: (event: LanguageInstallEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: LanguageInstallEvent): void =>
        callback(payload);
      ipcRenderer.on(IPC.languagesInstallEvent, listener);
      return () => ipcRenderer.removeListener(IPC.languagesInstallEvent, listener);
    },
  },
  /**
   * Which account profile owns local data. Read-only, and intentionally free of any
   * identifier the renderer could use to reach another account's files.
   */
  accountProfile: {
    get: (): Promise<AccountProfileInfo> => ipcRenderer.invoke(IPC.accountProfileGet),
  },
  /** Authentication (Supabase Google OAuth). Tokens stay in Main (INV-3). */
  auth: {
    getState: (): Promise<AuthState> => ipcRenderer.invoke(IPC.authGetState),
    signInGoogle: (): Promise<void> => ipcRenderer.invoke(IPC.authSignInGoogle),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.authSignOut),
    /** Subscribe to auth state changes. Returns an unsubscribe fn. */
    onStateChanged: (callback: (state: AuthState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AuthState): void => callback(payload);
      ipcRenderer.on(IPC.authStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC.authStateChanged, listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld('axiom', api);

export type AxiomApi = typeof api;
