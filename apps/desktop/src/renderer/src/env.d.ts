/// <reference types="vite/client" />
import type {
  LanguageInstallEvent,
  LanguageInstallStarted,
  LanguagesCatalog,
} from '../../common/languagePacks';
import type { ExecutionConsentState } from '../../common/executionConsentTypes';
import type { AccountProfileInfo } from '../../common/ipc';
import type {
  AiConnectionInput,
  AiCredentialBinding,
  AiConnectionScopeInput,
  AiConversation,
  AiConversationMutation,
  AttachmentDescriptor,
  AttachmentTextInput,
  AiModelsResult,
  AiTestResult,
  AppInfo,
  TitleBarOverlayAppearance,
  WorkspaceTrustState,
  AuthState,
  ChatChunk,
  ChatSendInput,
  ChatUsage,
  BuildContextInput,
  ContextResult,
  InlineEditResult,
  InlineChatResult,
  SpendSummary,
  DebugControlAction,
  DebugBreakpoint,
  DebugEvalResult,
  DebugEvent,
  DebugLaunchConfig,
  DebugScope,
  DebugStackFrame,
  DebugStartResult,
  DebugVariable,
  DiscoveredDebugConfig,
  LocalModelProbe,
  WriteConsentState,
  WorkspaceAgentFile,
  AgentRunInput,
  AgentStepEvent,
  AgentTask,
  AuditEvent,
  AuditVerifyResult,
  MemoryEntry,
  MemoryScope,
  MemorySelection,
  TelemetryCategory,
  TelemetryConsent,
  TelemetryEvent,
  FlagValue,
  CoreCatalogQueryResult,
  CoreCatalogRebuildResult,
  CoreCatalogStatsResult,
  CoreChunkOptions,
  CoreChunkResult,
  CoreEmbedResult,
  CoreFsEvent,
  CoreGraphBuildResult,
  CoreGraphCyclesResult,
  CoreGraphEdgesResult,
  CoreGraphDependenciesResult,
  CoreGraphDependentsResult,
  CoreGraphImpactResult,
  CoreProjectProfile,
  CoreRetrieveOptions,
  CoreRetrieveResult,
  CoreSearchResult,
  CoreSymbolsResult,
  CoreUnwatchResult,
  CoreWalkResult,
  CoreWatchResult,
  LspApplyEditRequest,
  LspCodeAction,
  LspCompletionContext,
  LspCompletionItem,
  LspCompletionResult,
  LspDiagnostic,
  LspDiagnosticsEvent,
  LspDidChangeInput,
  LspDidChangeResult,
  LspDidOpenInput,
  LspDocumentHighlightResult,
  LspDocumentLink,
  LspDocumentSymbol,
  LspFoldingRange,
  LspHoverResult,
  LspInlayHint,
  LspLocationResult,
  LspLogEvent,
  LspPosition,
  LspPrepareRenameResult,
  LspRange,
  LspSemanticTokens,
  LspSemanticTokensLegend,
  LspServerStatus,
  LspSignatureHelp,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalShellInfo,
  CreateEntryResult,
  DeleteResult,
  EditorSessionState,
  ExtensionApplyEditPayload,
  ExtensionDebugSessionInfo,
  ExtensionDocumentInput,
  ExtensionDocumentResult,
  ExtensionLanguageRegistry,
  ExtensionProvideInput,
  ExtensionProvideResult,
  ExtensionProviderEditInput,
  ExtensionTaskExecutionInfo,
  ExtensionTaskOutputEvent,
  ExtensionTerminalCommand,
  ExtensionTerminalEvent,
  ExtensionTerminalInfo,
  FileContent,
  FsChangeEvent,
  GitBranches,
  GitDiff,
  GitDiffMode,
  GitLogEntry,
  GitStatusResult,
  GitOperationProgress,
  GitOperationResult,
  GitRemote,
  GitRepositoryInfo,
  GithubAuthState,
  GithubCreateRepositoryInput,
  GithubDeviceFlow,
  GithubFlowPollResult,
  GithubPublishResult,
  LayoutState,
  ListFilesResult,
  OpenFileResult,
  OpenFolderResult,
  OpenPathResult,
  PathIdentityResult,
  ReadDirectoryResult,
  RecentFolder,
  RenameResult,
  SaveFileResult,
  SearchOptions,
  SearchResult,
  SettingsData,
  ProfilePreferencesSnapshot,
  WriteFileResult,
} from '../../common/ipc';
import type { AgentPreset } from '../../common/agentPresets';
import type { CommandConsentScope } from '../../common/commandConsent';
import type { DetectedRuntime } from '../../common/runtimes';
import type { Workflow } from '../../common/workflows';
import type { McpServerConfig, McpConnectResult, McpConnectionStatus } from '../../common/mcp';
import type { Rule } from '../../common/rules';
import type { ProposedRule } from '../../common/conventionLearner';
import type { PromptTemplate } from '../../common/promptLibrary';
import type { ExtensionManifest } from '../../common/extensionManifest';
import type { ContributionRegistry } from '../../common/extensionRegistry';
import type { ReviewResult } from '../../common/review';
import type { EditPlan } from '../../common/editPlan';
import type { SyncStatus } from '../../common/sync';
import type { UpdateDecision } from '../../common/autoUpdate';
import type { UpdatePlan } from '../../common/updateConfig';
import type { UpdateEvent, UpdateSnapshot } from '../../common/updateState';
import type { Checkpoint } from '../../common/snapshot';
import type { ApplyResult, BatchPlan, StagedEdit } from '../../common/safeEdit';
import type { StartupReportResult } from '../../common/startupTiming';
import type { CompatReport } from '../../common/compatMatrix';
import type { RegistryIndex } from '../../common/extensionRegistryIndex';
import type {
  RegistryExtensionDetail,
  RegistryPublisherDetail,
  RegistryReview,
  RegistrySearchPage,
  RegistryVersionPage,
  SearchQuery as MarketSearchQuery,
} from '../../common/openVsx';
import type {
  InstallOutcome as MarketInstallOutcome,
  InstalledExtensionDetail,
  InstalledExtensionSummary,
  UpdateAllOutcome as MarketUpdateAllOutcome,
  UpdatePlanEntry as MarketUpdatePlanEntry,
} from '../../common/marketplace';
import type { ConvertedTheme } from '../../common/vscodeTheme';
import type {
  HostDiagnostic,
  HostPromptRequest,
  HostStatus,
  HostStatusBarItem,
} from '../../common/vscodeHost';
import type { WebviewSnapshot, WebviewThemeKind } from '../../common/vscodeWebview';
import type { TreeViewSnapshot, WorkbenchSnapshot } from '../../common/vscodeViews';
import type { ResolvedMenuGroup } from '../../common/vscodeMenus';
import type {
  ContributedGrammarSource,
  ContributedSnippet,
  ExtensionContributionCatalog,
  IconThemeDefinition,
} from '../../common/contributions';
import type { ProviderHealthSummary } from '../../common/providerHealth';
import type { RunRecord } from '../../common/runJournal';
import type { BranchPlan } from '../../common/timeTravel';
import type { ReinvokeKind, ReinvokeRequest } from '../../common/runReinvoke';
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
} from '../../common/godMode';

declare global {
  interface Window {
    axiom: {
      app: {
        getInfo: () => Promise<AppInfo>;
        setDirty: (state: { root: string | null; dirty: boolean }) => Promise<void>;
        onOpenPath: (callback: (entry: OpenPathResult) => void) => () => void;
      };
      window: {
        setTitleBarOverlay: (appearance: TitleBarOverlayAppearance) => Promise<void>;
      };
      workspaceTrust: {
        get: (root: string) => Promise<WorkspaceTrustState>;
        set: (root: string, trusted: boolean) => Promise<WorkspaceTrustState>;
      };
      dialog: {
        openFolder: () => Promise<OpenFolderResult | null>;
        openFiles: () => Promise<OpenFileResult[]>;
        openDroppedPath: (file: File) => Promise<OpenPathResult | null>;
        saveFile: (defaultName?: string) => Promise<SaveFileResult | null>;
        validateFolder: (path: string) => Promise<OpenFolderResult | null>;
      };
      attachments: {
        pickFiles: () => Promise<AttachmentDescriptor[]>;
        pickFolder: () => Promise<AttachmentDescriptor | null>;
        addWorkspaceFiles: (root: string, paths: string[]) => Promise<AttachmentDescriptor[]>;
        addText: (input: AttachmentTextInput) => Promise<AttachmentDescriptor>;
        addDropped: (file: File) => Promise<AttachmentDescriptor | null>;
        release: (ids: string[]) => Promise<void>;
      };
      recents: {
        get: () => Promise<RecentFolder[]>;
        add: (path: string, name: string) => Promise<RecentFolder[]>;
        remove: (path: string) => Promise<RecentFolder[]>;
        clear: () => Promise<RecentFolder[]>;
      };
      system: {
        revealInOS: (path: string) => Promise<void>;
        copyText: (text: string) => Promise<void>;
        readText: () => Promise<string>;
      };
      crash: {
        recoveryNotice: () => Promise<{ unclean: boolean; summary: string }>;
      };
      perf: {
        startupReport: () => Promise<StartupReportResult>;
        markReady: () => Promise<boolean>;
      };
      compat: {
        report: () => Promise<CompatReport>;
      };
      fs: {
        readDirectory: (path: string) => Promise<ReadDirectoryResult>;
        readFile: (path: string) => Promise<FileContent>;
        resolveIdentity: (path: string) => Promise<PathIdentityResult>;
        writeFile: (
          path: string,
          content: string,
          expectedEtag?: string | null,
          expectedIdentity?: string,
        ) => Promise<WriteFileResult>;
        createFile: (anchorPath: string, name: string) => Promise<CreateEntryResult>;
        createDirectory: (anchorPath: string, name: string) => Promise<CreateEntryResult>;
        rename: (targetPath: string, newName: string) => Promise<RenameResult>;
        move: (source: string, destDir: string) => Promise<RenameResult>;
        delete: (targetPath: string) => Promise<DeleteResult>;
        listFiles: (rootPath: string) => Promise<ListFilesResult>;
        search: (rootPath: string, query: string, options: SearchOptions) => Promise<SearchResult>;
        watchStart: (rootPath: string) => Promise<void>;
        onDidChange: (callback: (event: FsChangeEvent) => void) => () => void;
      };
      settings: {
        read: () => Promise<SettingsData>;
        write: (values: SettingsData) => Promise<void>;
        readWorkspace: (root: string) => Promise<SettingsData>;
        writeWorkspace: (root: string, values: SettingsData) => Promise<void>;
        resolve: (scope: 'user' | 'workspace', root?: string) => Promise<string>;
      };
      preferences: {
        applyProfile: (
          settings: SettingsData,
          keybindings: SettingsData,
        ) => Promise<ProfilePreferencesSnapshot>;
      };
      keybindings: {
        read: () => Promise<SettingsData>;
        write: (values: SettingsData) => Promise<void>;
      };
      editorState: {
        read: (root: string) => Promise<EditorSessionState>;
        write: (root: string, state: EditorSessionState) => Promise<void>;
      };
      layout: {
        read: () => Promise<Partial<LayoutState>>;
        write: (state: LayoutState) => Promise<void>;
      };
      git: {
        status: (root: string) => Promise<GitStatusResult>;
        stage: (root: string, filepath: string) => Promise<void>;
        unstage: (root: string, filepath: string) => Promise<void>;
        commit: (root: string, message: string) => Promise<string>;
        branches: (root: string) => Promise<GitBranches>;
        checkout: (root: string, ref: string) => Promise<GitOperationResult>;
        createBranch: (root: string, name: string) => Promise<GitOperationResult>;
        diff: (root: string, filepath: string, mode: GitDiffMode) => Promise<GitDiff>;
        discard: (root: string, filepath: string, confirmed: boolean) => Promise<void>;
        init: (root: string) => Promise<void>;
        log: (root: string, depth?: number) => Promise<GitLogEntry[]>;
        repository: (root: string) => Promise<GitRepositoryInfo>;
        remotes: (root: string) => Promise<GitRemote[]>;
        fetch: (root: string, remote?: string) => Promise<GitOperationResult>;
        pull: (root: string) => Promise<GitOperationResult>;
        push: (root: string) => Promise<GitOperationResult>;
        addRemote: (root: string, remote: string, url: string) => Promise<GitOperationResult>;
        deleteBranch: (
          root: string,
          ref: string,
          confirmed: boolean,
        ) => Promise<GitOperationResult>;
        merge: (root: string, ref: string, confirmed: boolean) => Promise<GitOperationResult>;
        rebase: (root: string, ref: string, confirmed: boolean) => Promise<GitOperationResult>;
        commitAndPush: (root: string, message: string) => Promise<GitOperationResult>;
        onProgress: (callback: (progress: GitOperationProgress) => void) => () => void;
      };
      github: {
        state: () => Promise<GithubAuthState>;
        start: () => Promise<GithubDeviceFlow>;
        poll: (flowId: string) => Promise<GithubFlowPollResult>;
        cancel: (flowId: string) => Promise<void>;
        openVerification: (flowId: string) => Promise<void>;
        disconnect: () => Promise<void>;
        publishRepository: (
          root: string,
          input: GithubCreateRepositoryInput,
          confirmed: boolean,
        ) => Promise<GithubPublishResult>;
        retryPublish: (
          root: string,
          cloneUrl: string,
          confirmed: boolean,
        ) => Promise<GitOperationResult>;
      };
      godMode: {
        snapshot: (root: string | null) => Promise<GodModeSnapshot>;
        context: {
          inspect: (input: ContextIntelligenceInput) => Promise<ContextIntelligenceReport>;
          evaluate: (root: string, cases: ContextEvalCase[]) => Promise<ContextEvalSuiteResult>;
        };
        jobs: {
          create: (input: CreateAutonomousJobInput) => Promise<GodModeJob>;
          list: (root: string) => Promise<GodModeJob[]>;
          claim: (root: string, id: string) => Promise<GodModeJob>;
          control: (root: string, input: JobControlInput) => Promise<GodModeJob>;
        };
        preview: {
          open: (input: PreviewOpenInput) => Promise<PreviewSnapshot>;
          get: (root: string) => Promise<PreviewSnapshot | null>;
          refresh: (root: string) => Promise<PreviewSnapshot>;
          capture: (root: string) => Promise<PreviewSnapshot>;
          selectElement: (root: string) => Promise<PreviewSnapshot>;
          close: (root: string) => Promise<void>;
        };
        verification: {
          plan: (root: string, changedFiles?: string[]) => Promise<VerificationPlan>;
          run: (
            planId: string,
            checkIds: string[],
            confirmation: boolean,
          ) => Promise<VerificationRunResult>;
          cancel: (planId: string) => Promise<void>;
        };
        debugger: {
          captureEvidence: (threadId: number) => Promise<DebugEvidenceSnapshot>;
        };
        issue: {
          load: (root: string, issue: GithubIssueRef) => Promise<GithubIssue>;
          plan: (root: string, issue: GithubIssueRef) => Promise<IssueWorkPlan>;
          start: (
            root: string,
            issue: GithubIssueRef,
            confirmation: boolean,
          ) => Promise<IssueWorkPlan>;
          createPr: (input: PullRequestInput) => Promise<PullRequestResult>;
        };
        workspaces: {
          list: (root: string) => Promise<IsolatedWorkspaceProfile[]>;
          create: (input: CreateIsolatedWorkspaceInput) => Promise<IsolatedWorkspaceProfile>;
          probe: (input: WorkspaceProbeInput) => Promise<RemoteProbeResult>;
          run: (
            root: string,
            profileId: string,
            command: string,
            confirmation: boolean,
          ) => Promise<WorkspaceCommandResult>;
          cancel: (profileId: string) => Promise<void>;
          remove: (
            root: string,
            profileId: string,
            confirmation: boolean,
          ) => Promise<IsolatedWorkspaceProfile[]>;
        };
        extensions: {
          list: (root: string) => Promise<ExtensionSandboxStatus[]>;
          enable: (
            root: string,
            id: string,
            confirmation: boolean,
            allowUnsigned: boolean,
          ) => Promise<ExtensionSandboxStatus[]>;
          disable: (root: string, id: string) => Promise<ExtensionSandboxStatus[]>;
        };
        collaboration: {
          list: (root: string) => Promise<CollaborationSession[]>;
          create: (root: string, title: string) => Promise<CollaborationSession>;
          addEvent: (
            root: string,
            sessionId: string,
            input: Pick<CollaborationEvent, 'kind' | 'text' | 'evidenceIds'>,
          ) => Promise<CollaborationSession>;
          export: (root: string, sessionId: string) => Promise<CollaborationExport>;
          share: (
            root: string,
            sessionId: string,
            confirmation: boolean,
          ) => Promise<CollaborationSession>;
          addMember: (
            root: string,
            sessionId: string,
            userId: string,
            role: CollaborationRole,
            confirmation: boolean,
          ) => Promise<CollaborationSession>;
        };
        deployment: {
          saveHook: (
            root: string,
            targetId: string,
            hookUrl: string,
            confirmation: boolean,
          ) => Promise<{
            secretRef: string;
            hookOrigin: string;
            hookRevision: string;
            hookUrlSha256: string;
          }>;
          plan: (root: string, target: DeploymentTarget) => Promise<DeploymentPlan>;
          execute: (root: string, input: ExecuteDeploymentInput) => Promise<DeploymentRun>;
          list: (root: string) => Promise<DeploymentRun[]>;
          cancel: (runId: string) => Promise<void>;
        };
      };
      secrets: {
        set: (key: string, value: string, binding: AiCredentialBinding) => Promise<void>;
        has: (key: string, binding?: AiCredentialBinding) => Promise<boolean>;
        delete: (key: string) => Promise<void>;
      };
      ai: {
        testConnection: (input: AiConnectionInput) => Promise<AiTestResult>;
        fetchModels: (input: AiConnectionInput) => Promise<AiModelsResult>;
        chatSend: (input: ChatSendInput) => Promise<import('../../common/ipc').ChatSendResult>;
        diagnostics: (
          input: import('../../common/ipc').AiDiagnosticsInput,
        ) => Promise<import('../../common/ipc').AiDiagnosticsSnapshot>;
        chatCancel: (id: string) => Promise<void>;
        connectionScope: (input: AiConnectionScopeInput) => Promise<string>;
        buildContext: (input: BuildContextInput) => Promise<ContextResult>;
        review: (input: {
          provider: string;
          model: string;
          baseUrl: string;
          headers: Record<string, string>;
          code: string;
          label: string;
        }) => Promise<ReviewResult>;
        compose: (input: {
          provider: string;
          model: string;
          baseUrl: string;
          headers: Record<string, string>;
          instruction: string;
          context?: string;
        }) => Promise<EditPlan>;
        complete: (input: PredictiveCompletionInput) => Promise<PredictiveCompletionResult>;
        cancelCompletion: (requestId: string) => Promise<void>;
        completionFeedback: (feedback: PredictionFeedback) => Promise<void>;
        completionMetrics: () => Promise<PredictionMetrics>;
        inlineEdit: (input: {
          instruction: string;
          selection: string;
          language: string;
          filename?: string;
          prefix?: string;
          suffix?: string;
        }) => Promise<InlineEditResult>;
        inlineChat: (input: {
          question: string;
          selection: string;
          language: string;
          filename?: string;
          prefix?: string;
          suffix?: string;
        }) => Promise<InlineChatResult>;
        commitMessage: (input: { diff: string }) => Promise<{ text: string; error?: string }>;
        spend: {
          summary: () => Promise<SpendSummary>;
          clear: () => Promise<SpendSummary>;
          onChanged: (callback: (summary: SpendSummary) => void) => () => void;
        };
        providerHealth: () => Promise<ProviderHealthSummary[]>;
        detectLocalModels: () => Promise<LocalModelProbe>;
        onChunk: (callback: (chunk: ChatChunk) => void) => () => void;
        onUsage: (callback: (usage: ChatUsage) => void) => () => void;
        conversations: {
          read: () => Promise<AiConversation[]>;
          write: (list: AiConversation[]) => Promise<void>;
          mutate: (mutation: AiConversationMutation) => Promise<AiConversation[]>;
        };
      };
      accountProfile: {
        get: () => Promise<AccountProfileInfo>;
      };
      auth: {
        getState: () => Promise<AuthState>;
        signInGoogle: () => Promise<void>;
        signOut: () => Promise<void>;
        onStateChanged: (callback: (state: AuthState) => void) => () => void;
      };
      debug: {
        discover: (root: string) => Promise<DiscoveredDebugConfig[]>;
        start: (
          config: DebugLaunchConfig,
          breakpoints: Record<string, DebugBreakpoint[]>,
        ) => Promise<DebugStartResult>;
        setBreakpoints: (path: string, breakpoints: DebugBreakpoint[]) => Promise<void>;
        control: (action: DebugControlAction, threadId: number) => Promise<void>;
        stackTrace: (threadId: number) => Promise<DebugStackFrame[]>;
        scopes: (frameId: number) => Promise<DebugScope[]>;
        variables: (ref: number) => Promise<DebugVariable[]>;
        evaluate: (expression: string, frameId: number | null) => Promise<DebugEvalResult>;
        stop: () => Promise<void>;
        onEvent: (callback: (e: DebugEvent) => void) => () => void;
      };
      agent: {
        run: (input: AgentRunInput) => Promise<void>;
        cancel: (id: string) => Promise<void>;
        acknowledgeApproval: (id: string, approvalToken: string) => Promise<void>;
        approve: (
          id: string,
          approvalToken: string,
          approved: boolean,
          remember?: CommandConsentScope,
        ) => Promise<void>;
        onEvent: (callback: (e: AgentStepEvent) => void) => () => void;
        writeConsent: {
          get: (root: string) => Promise<WriteConsentState>;
          grant: (
            root: string,
            confirmation: boolean,
            durationMs?: number,
            persist?: boolean,
          ) => Promise<WriteConsentState>;
          revoke: (root: string) => Promise<WriteConsentState>;
        };
        tasks: (root: string) => Promise<AgentTask[]>;
        onTaskUpdate: (callback: (t: AgentTask) => void) => () => void;
        runs: {
          list: (root: string) => Promise<RunRecord[]>;
          clear: (root: string) => Promise<void>;
          resumable: (root: string) => Promise<RunRecord[]>;
          branch: (
            root: string,
            id: string,
            branchIndex: number,
            guidance?: string,
          ) => Promise<BranchPlan | null>;
          reinvoke: (
            root: string,
            id: string,
            kind: ReinvokeKind,
            options?: { branchIndex?: number; guidance?: string },
          ) => Promise<ReinvokeRequest | null>;
        };
      };
      customAgents: {
        list: () => Promise<AgentPreset[]>;
        save: (input: Partial<AgentPreset>) => Promise<AgentPreset[]>;
        remove: (id: string) => Promise<AgentPreset[]>;
      };
      workspaceAgents: {
        list: (root: string) => Promise<WorkspaceAgentFile[]>;
        share: (root: string, id: string) => Promise<string>;
      };
      workflows: {
        list: () => Promise<Workflow[]>;
        save: (wf: Partial<Workflow>) => Promise<Workflow[]>;
        remove: (id: string) => Promise<Workflow[]>;
        setEnabled: (id: string, enabled: boolean) => Promise<Workflow[]>;
      };
      mcp: {
        listServers: (root: string) => Promise<McpServerConfig[]>;
        saveServer: (root: string, cfg: Partial<McpServerConfig>) => Promise<McpServerConfig[]>;
        deleteServer: (root: string, id: string) => Promise<McpServerConfig[]>;
        setEnabled: (root: string, id: string, enabled: boolean) => Promise<McpServerConfig[]>;
        connect: (root: string, id: string) => Promise<McpConnectResult>;
        disconnect: (root: string, id: string) => Promise<void>;
        disconnectWorkspace: (root: string) => Promise<void>;
        connections: (root: string) => Promise<McpConnectionStatus[]>;
        callTool: (
          root: string,
          serverId: string,
          tool: string,
          args: Record<string, unknown>,
        ) => Promise<{ text: string; isError: boolean }>;
      };
      rules: {
        list: (root: string | null) => Promise<Rule[]>;
        saveGlobal: (rule: Partial<Rule>) => Promise<Rule[]>;
        deleteGlobal: (id: string) => Promise<Rule[]>;
        proposeConventions: (root: string | null) => Promise<ProposedRule[]>;
      };
      prompts: {
        list: () => Promise<PromptTemplate[]>;
        save: (p: Partial<PromptTemplate>) => Promise<PromptTemplate[]>;
        remove: (id: string) => Promise<PromptTemplate[]>;
        recordUse: (id: string) => Promise<PromptTemplate[]>;
      };
      extensions: {
        list: (root: string | null) => Promise<ExtensionManifest[]>;
        setEnabled: (
          id: string,
          enabled: boolean,
          root: string | null,
        ) => Promise<ExtensionManifest[]>;
        registry: (root: string | null) => Promise<ContributionRegistry>;
        hostStatus: () => Promise<Array<{ extId: string; active: boolean }>>;
        registryIndex: (root: string | null) => Promise<RegistryIndex>;
        install: (id: string, root: string | null) => Promise<ExtensionManifest[]>;
      };
      /** Open VSX marketplace: browse, install, and read declarative contributions. */
      market: {
        reachable: () => Promise<boolean>;
        browse: (query: MarketSearchQuery) => Promise<RegistrySearchPage>;
        detail: (id: string, version?: string) => Promise<RegistryExtensionDetail>;
        versions: (id: string, offset?: number, size?: number) => Promise<RegistryVersionPage>;
        reviews: (id: string) => Promise<RegistryReview[]>;
        publisher: (namespace: string) => Promise<RegistryPublisherDetail>;
        document: (url: string) => Promise<string>;
        installed: (root: string | null) => Promise<InstalledExtensionSummary[]>;
        installedDetail: (id: string, root: string | null) => Promise<InstalledExtensionDetail>;
        install: (id: string, version?: string) => Promise<MarketInstallOutcome>;
        installFromFile: () => Promise<MarketInstallOutcome | null>;
        uninstall: (id: string) => Promise<boolean>;
        setEnabled: (
          id: string,
          enabled: boolean,
          target: 'global' | 'workspace',
          root: string | null,
        ) => Promise<boolean>;
        setAutoUpdate: (id: string, enabled: boolean) => Promise<boolean>;
        setAutoUpdateAll: (enabled: boolean) => Promise<boolean>;
        checkUpdates: (force?: boolean) => Promise<MarketUpdatePlanEntry[]>;
        updateAll: () => Promise<MarketUpdateAllOutcome>;
        contributions: (root: string | null) => Promise<ExtensionContributionCatalog>;
        loadTheme: (key: string, root: string | null) => Promise<ConvertedTheme | null>;
        loadIconTheme: (key: string, root: string | null) => Promise<IconThemeDefinition | null>;
        snippets: (language: string, root: string | null) => Promise<ContributedSnippet[]>;
        loadGrammar: (
          scopeName: string,
          root: string | null,
        ) => Promise<ContributedGrammarSource | null>;
        onChanged: (listener: () => void) => () => void;
      };
      /** Extension hosts: extension code running out of process. */
      host: {
        list: (root: string | null) => Promise<HostStatus[]>;
        setConsent: (id: string, granted: boolean, root: string | null) => Promise<boolean>;
        stop: (id: string) => Promise<boolean>;
        restart: (id: string) => Promise<boolean>;
        runCommand: (command: string, args: unknown[], root: string | null) => Promise<unknown>;
        statusItems: () => Promise<HostStatusBarItem[]>;
        diagnostics: () => Promise<Array<{ owner: string; diagnostics: HostDiagnostic[] }>>;
        output: (id: string) => Promise<string[]>;
        reportActiveEditor: (
          path: string | null,
          languageId: string | null,
          root: string | null,
        ) => Promise<boolean>;
        activate: (kind: string, value: string | null, root: string | null) => Promise<string[]>;
        answerPrompt: (id: number, value: string | null) => Promise<boolean>;
        onChanged: (listener: () => void) => () => void;
        onPrompt: (listener: (request: HostPromptRequest) => void) => () => void;
        onCrashLoop: (
          listener: (info: { extensionId: string; displayName: string; crashes: number }) => void,
        ) => () => void;
        onOpenFile: (listener: (path: string) => void) => () => void;
        onWorkbenchCommand: (listener: (command: string, args: unknown[]) => void) => () => void;
      };
      webview: {
        list: () => Promise<WebviewSnapshot[]>;
        frameMessage: (handle: string, message: unknown) => Promise<boolean>;
        visibility: (handle: string, visible: boolean, active: boolean) => Promise<boolean>;
        close: (handle: string) => Promise<boolean>;
        reveal: (handle: string) => Promise<boolean>;
        resolveView: (viewType: string) => Promise<WebviewSnapshot | null>;
        restore: () => Promise<boolean>;
        theme: (payload: {
          kind: WebviewThemeKind;
          name: string;
          variables: Record<string, string>;
        }) => Promise<boolean>;
        onChanged: (listener: () => void) => () => void;
        onPost: (
          listener: (handle: string, envelope: Record<string, unknown>) => void,
        ) => () => void;
      };
      views: {
        workbench: () => Promise<WorkbenchSnapshot>;
        tree: (viewId: string, viewportHeight: number) => Promise<TreeViewSnapshot | null>;
        visibility: (viewId: string, visible: boolean) => Promise<boolean>;
        expand: (viewId: string, handle: string | null, expanded: boolean) => Promise<boolean>;
        select: (viewId: string, handles: string[]) => Promise<boolean>;
        activate: (viewId: string, handle: string) => Promise<boolean>;
        checkbox: (viewId: string, handle: string) => Promise<boolean>;
        key: (viewId: string, key: string) => Promise<boolean>;
        resolveItem: (viewId: string, handle: string) => Promise<boolean>;
        layout: (payload: {
          activeContainer?: string | null;
          viewId?: string;
          collapsed?: boolean;
          size?: number | null;
          scrollTop?: number;
        }) => Promise<boolean>;
        menu: (
          location: string,
          scope?: { viewId?: string; handle?: string; keys?: Record<string, unknown> },
        ) => Promise<ResolvedMenuGroup[]>;
        runMenuCommand: (
          location: string,
          command: string,
          scope?: {
            viewId?: string;
            handle?: string;
            keys?: Record<string, unknown>;
            args?: unknown[];
          },
        ) => Promise<boolean>;
        context: (values: Record<string, unknown>) => Promise<boolean>;
        onChanged: (listener: () => void) => () => void;
      };
      languageProviders: {
        registry: () => Promise<ExtensionLanguageRegistry>;
        provide: (request: ExtensionProvideInput) => Promise<ExtensionProvideResult>;
        cancel: (requestId: number) => Promise<boolean>;
        document: (event: ExtensionDocumentInput) => Promise<ExtensionDocumentResult>;
        applyProviderEdit: (edit: ExtensionProviderEditInput) => Promise<boolean>;
        onChanged: (listener: () => void) => () => void;
        /** Providers whose answers went stale. The payload is validated by the renderer. */
        onProviderChanged: (listener: (batch: unknown) => void) => () => void;
        onApplyEdit: (listener: (payload: ExtensionApplyEditPayload) => void) => () => void;
      };
      audit: {
        read: (limit?: number) => Promise<AuditEvent[]>;
        verify: () => Promise<AuditVerifyResult>;
      };
      autoUpdate: {
        check: () => Promise<UpdateDecision>;
      };
      update: {
        check: () => Promise<UpdatePlan | null>;
        download: () => Promise<void>;
        install: () => Promise<void>;
        getState: () => Promise<UpdateSnapshot>;
        onStatus: (callback: (e: UpdateEvent) => void) => () => void;
      };
      memory: {
        list: () => Promise<MemoryEntry[]>;
        add: (
          text: string,
          scope: MemoryScope,
          workspaceKey: string | null,
        ) => Promise<MemoryEntry[]>;
        update: (id: string, patch: { text?: string; pinned?: boolean }) => Promise<MemoryEntry[]>;
        remove: (id: string) => Promise<MemoryEntry[]>;
        clear: () => Promise<MemoryEntry[]>;
        select: (query: string, workspaceKey: string | null) => Promise<MemorySelection>;
      };
      telemetry: {
        consent: () => Promise<TelemetryConsent>;
        record: (
          category: TelemetryCategory,
          type: string,
          props?: Record<string, unknown>,
        ) => Promise<void>;
        read: () => Promise<TelemetryEvent[]>;
        clear: () => Promise<void>;
      };
      featureFlags: {
        all: () => Promise<Record<string, FlagValue>>;
      };
      dataExport: {
        build: () => Promise<string>;
        save: () => Promise<SaveFileResult | null>;
      };
      sync: {
        status: () => Promise<SyncStatus>;
        snapshot: () => Promise<SyncStatus>;
        flush: () => Promise<{ flushed: number; reason?: string }>;
      };
      snapshots: {
        capture: (paths: string[], label?: string) => Promise<Checkpoint>;
        list: () => Promise<Checkpoint[]>;
        restore: (runId: string) => Promise<{ restored: number }>;
        restoreEntry: (entryId: string) => Promise<{ path: string } | null>;
        readEntry: (entryId: string) => Promise<string | null>;
        clear: () => Promise<void>;
      };
      safeEdit: {
        stage: (root: string, edits: StagedEdit[]) => Promise<BatchPlan>;
        apply: (root: string, edits: StagedEdit[]) => Promise<ApplyResult>;
      };
      terminal: {
        listShells: () => Promise<TerminalShellInfo[]>;
        create: (opts: TerminalCreateOptions) => Promise<TerminalCreateResult>;
        write: (id: string, data: string) => Promise<void>;
        resize: (id: string, cols: number, rows: number) => Promise<void>;
        kill: (id: string) => Promise<void>;
        onData: (callback: (event: TerminalDataEvent) => void) => () => void;
        onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
      };
      /**
       * The extension runtime: terminals, tasks and debug sessions (PRD Phase 7).
       *
       * The renderer owns the panes and reports what happened to them; Main owns which extension a
       * pane belongs to, so every command and report here is addressed by an opaque handle and the
       * renderer never names an extension.
       */
      extensionRuntime: {
        terminals: () => Promise<{ revision: number; terminals: ExtensionTerminalInfo[] }>;
        reportTerminal: (event: ExtensionTerminalEvent) => Promise<boolean>;
        tasks: () => Promise<{ revision: number; executions: ExtensionTaskExecutionInfo[] }>;
        debugSessions: () => Promise<{ revision: number; sessions: ExtensionDebugSessionInfo[] }>;
        debugConsole: (sessionId: string) => Promise<string[]>;
        onTerminalCommand: (listener: (command: ExtensionTerminalCommand) => void) => () => void;
        onTerminalsChanged: (listener: () => void) => () => void;
        onTaskOutput: (listener: (event: ExtensionTaskOutputEvent) => void) => () => void;
        onTasksChanged: (listener: () => void) => () => void;
        onDebugConsole: (
          listener: (payload: { sessionId: string; text: string }) => void,
        ) => () => void;
        onDebugChanged: (listener: () => void) => () => void;
      };
      core: {
        walk: (root: string) => Promise<CoreWalkResult>;
        search: (root: string, query: string, caseSensitive?: boolean) => Promise<CoreSearchResult>;
        symbols: (path: string) => Promise<CoreSymbolsResult>;
        chunk: (path: string, options?: CoreChunkOptions) => Promise<CoreChunkResult>;
        retrieve: (
          root: string,
          query: string,
          options?: CoreRetrieveOptions,
        ) => Promise<CoreRetrieveResult>;
        embed: (text: string, dim?: number) => Promise<CoreEmbedResult>;
        graph: {
          build: (root: string) => Promise<CoreGraphBuildResult>;
          dependencies: (root: string, path: string) => Promise<CoreGraphDependenciesResult>;
          dependents: (root: string, path: string) => Promise<CoreGraphDependentsResult>;
          impact: (root: string, path: string) => Promise<CoreGraphImpactResult>;
          cycles: (root: string) => Promise<CoreGraphCyclesResult>;
          edges: (root: string) => Promise<CoreGraphEdgesResult>;
        };
        project: {
          understand: (root: string) => Promise<CoreProjectProfile>;
        };
        watch: (root: string) => Promise<CoreWatchResult>;
        unwatch: (root: string) => Promise<CoreUnwatchResult>;
        catalog: {
          rebuild: (root: string, db: string) => Promise<CoreCatalogRebuildResult>;
          stats: (db: string) => Promise<CoreCatalogStatsResult>;
          query: (db: string, pattern?: string, limit?: number) => Promise<CoreCatalogQueryResult>;
        };
        onFsEvent: (callback: (event: CoreFsEvent) => void) => () => void;
      };
      lsp: {
        didOpen: (input: LspDidOpenInput) => Promise<void>;
        didChange: (input: LspDidChangeInput) => Promise<LspDidChangeResult>;
        resync: (uri: string, version: number, text: string) => Promise<void>;
        didSave: (uri: string, text: string) => Promise<void>;
        didClose: (uri: string) => Promise<void>;
        cancel: (requestId: number) => Promise<void>;
        hover: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspHoverResult>;
        completion: (
          uri: string,
          line: number,
          character: number,
          context?: LspCompletionContext,
          requestId?: number,
        ) => Promise<LspCompletionResult>;
        resolveCompletion: (uri: string, handle: number) => Promise<LspCompletionItem | null>;
        executeCompletionCommand: (uri: string, handle: number) => Promise<boolean>;
        definition: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspLocationResult>;
        declaration: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspLocationResult>;
        references: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspLocationResult>;
        typeDefinition: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspLocationResult>;
        implementation: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspLocationResult>;
        documentHighlight: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspDocumentHighlightResult>;
        prepareRename: (
          uri: string,
          line: number,
          character: number,
        ) => Promise<LspPrepareRenameResult>;
        rename: (
          uri: string,
          line: number,
          character: number,
          newName: string,
        ) => Promise<LspWorkspaceEdit>;
        signatureHelp: (
          uri: string,
          line: number,
          character: number,
          requestId?: number,
        ) => Promise<LspSignatureHelp>;
        codeAction: (
          uri: string,
          range: LspRange,
          diagnostics: LspDiagnostic[],
          only?: string[],
          requestId?: number,
        ) => Promise<LspCodeAction[]>;
        resolveCodeAction: (uri: string, handle: number) => Promise<LspCodeAction | null>;
        executeCodeAction: (uri: string, handle: number) => Promise<boolean>;
        documentSymbol: (uri: string, requestId?: number) => Promise<LspDocumentSymbol[]>;
        workspaceSymbol: (
          uri: string,
          query: string,
          requestId?: number,
        ) => Promise<LspSymbolInformation[]>;
        inlayHint: (uri: string, range: LspRange, requestId?: number) => Promise<LspInlayHint[]>;
        foldingRange: (uri: string, requestId?: number) => Promise<LspFoldingRange[]>;
        selectionRange: (uri: string, positions: LspPosition[]) => Promise<LspRange[]>;
        documentLink: (uri: string, requestId?: number) => Promise<LspDocumentLink[]>;
        semanticTokensLegend: (uri: string) => Promise<LspSemanticTokensLegend | null>;
        semanticTokens: (uri: string, requestId?: number) => Promise<LspSemanticTokens | null>;
        pullDiagnostics: (uri: string, requestId?: number) => Promise<LspDiagnosticsEvent[]>;
        formatting: (uri: string, tabSize: number, insertSpaces: boolean) => Promise<LspTextEdit[]>;
        rangeFormatting: (
          uri: string,
          range: LspRange,
          tabSize: number,
          insertSpaces: boolean,
        ) => Promise<LspTextEdit[]>;
        onTypeFormatting: (
          uri: string,
          line: number,
          character: number,
          ch: string,
          tabSize: number,
          insertSpaces: boolean,
        ) => Promise<LspTextEdit[]>;
        serverStatuses: (rootPath: string) => Promise<LspServerStatus[]>;
        restartServer: (rootPath: string, serverId: string) => Promise<void>;
        runtimes: (refresh?: boolean) => Promise<DetectedRuntime[]>;
        applyEditResult: (nonce: number, applied: boolean) => Promise<void>;
        onDiagnostics: (callback: (evt: LspDiagnosticsEvent) => void) => () => void;
        onServerStatus: (callback: (status: LspServerStatus) => void) => () => void;
        onLog: (callback: (evt: LspLogEvent) => void) => () => void;
        onApplyEdit: (callback: (request: LspApplyEditRequest) => void) => () => void;
      };
      executionConsent: {
        get: () => Promise<ExecutionConsentState>;
        set: (granted: boolean) => Promise<ExecutionConsentState>;
      };
      languages: {
        catalog: () => Promise<LanguagesCatalog>;
        rescan: () => Promise<LanguagesCatalog>;
        install: (languageId: string) => Promise<LanguageInstallStarted>;
        cancelInstall: (installId: string) => Promise<void>;
        onInstallEvent: (callback: (event: LanguageInstallEvent) => void) => () => void;
      };
    };
  }
}

export {};
