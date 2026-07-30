/**
 * IPC contract shared by the main process, preload, and (types only) renderer.
 * PRD Part II §14: typed, allow-listed channels. The renderer requests intent;
 * it never receives secrets (INV-3). File access is mediated by Main (Part X §182).
 */
export const IPC = {
  appGetInfo: 'app:getInfo',
  appSetDirty: 'app:setDirty',
  windowSetTitleBarOverlay: 'window:setTitleBarOverlay',
  workspaceTrustGet: 'workspaceTrust:get',
  workspaceTrustSet: 'workspaceTrust:set',
  dialogOpenFolder: 'dialog:openFolder',
  dialogOpenFiles: 'dialog:openFiles',
  dialogAuthorizeDroppedPath: 'dialog:authorizeDroppedPath',
  /** Main → renderer push: a file/folder AXIOM was launched with (OS "Open with"). */
  appOpenPath: 'app:openPath',
  dialogSaveFile: 'dialog:saveFile',
  attachmentPickFiles: 'attachment:pickFiles',
  attachmentPickFolder: 'attachment:pickFolder',
  attachmentAddWorkspaceFiles: 'attachment:addWorkspaceFiles',
  attachmentAddText: 'attachment:addText',
  attachmentAddDroppedPath: 'attachment:addDroppedPath',
  attachmentRelease: 'attachment:release',
  fsReadDirectory: 'fs:readDirectory',
  fsReadFile: 'fs:readFile',
  fsResolveIdentity: 'fs:resolveIdentity',
  fsWriteFile: 'fs:writeFile',
  fsCreateFile: 'fs:createFile',
  fsCreateDirectory: 'fs:createDirectory',
  fsRename: 'fs:rename',
  fsMove: 'fs:move',
  fsDelete: 'fs:delete',
  shellReveal: 'shell:reveal',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  fsWatchStart: 'fs:watchStart',
  /** Main → renderer push: the watched workspace tree changed. */
  fsDidChange: 'fs:didChange',
  fsListFiles: 'fs:listFiles',
  fsSearch: 'fs:search',
  dialogValidateFolder: 'dialog:validateFolder',
  recentsGet: 'recents:get',
  recentsAdd: 'recents:add',
  recentsRemove: 'recents:remove',
  recentsClear: 'recents:clear',
  settingsRead: 'settings:read',
  settingsWrite: 'settings:write',
  settingsReadWorkspace: 'settings:readWorkspace',
  settingsWriteWorkspace: 'settings:writeWorkspace',
  settingsResolve: 'settings:resolve',
  preferencesApplyProfile: 'preferences:applyProfile',
  keybindingsRead: 'keybindings:read',
  keybindingsWrite: 'keybindings:write',
  editorStateRead: 'editorState:read',
  editorStateWrite: 'editorState:write',
  layoutRead: 'layout:read',
  layoutWrite: 'layout:write',
  gitStatus: 'git:status',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  gitBranches: 'git:branches',
  gitCheckout: 'git:checkout',
  gitCreateBranch: 'git:createBranch',
  gitDiff: 'git:diff',
  gitDiscard: 'git:discard',
  gitInit: 'git:init',
  gitLog: 'git:log',
  gitRepository: 'git:repository',
  gitRemotes: 'git:remotes',
  gitFetch: 'git:fetch',
  gitPull: 'git:pull',
  gitPush: 'git:push',
  gitAddRemote: 'git:addRemote',
  gitDeleteBranch: 'git:deleteBranch',
  gitMerge: 'git:merge',
  gitRebase: 'git:rebase',
  gitCommitAndPush: 'git:commitAndPush',
  /** Main → renderer push: sanitized progress for the owner's serialized Git operation. */
  gitProgress: 'git:progress',
  githubState: 'github:state',
  githubStart: 'github:start',
  githubPoll: 'github:poll',
  githubCancel: 'github:cancel',
  githubOpenVerification: 'github:openVerification',
  githubDisconnect: 'github:disconnect',
  githubPublishRepository: 'github:publishRepository',
  githubRetryPublishRepository: 'github:retryPublishRepository',
  godModeSnapshot: 'godMode:snapshot',
  godModeContextInspect: 'godMode:contextInspect',
  godModeContextEvaluate: 'godMode:contextEvaluate',
  godModeJobCreate: 'godMode:jobCreate',
  godModeJobList: 'godMode:jobList',
  godModeJobClaim: 'godMode:jobClaim',
  godModeJobControl: 'godMode:jobControl',
  godModePreviewOpen: 'godMode:previewOpen',
  godModePreviewGet: 'godMode:previewGet',
  godModePreviewRefresh: 'godMode:previewRefresh',
  godModePreviewCapture: 'godMode:previewCapture',
  godModePreviewSelect: 'godMode:previewSelect',
  godModePreviewClose: 'godMode:previewClose',
  godModeVerificationPlan: 'godMode:verificationPlan',
  godModeVerificationRun: 'godMode:verificationRun',
  godModeVerificationCancel: 'godMode:verificationCancel',
  godModeDebugEvidence: 'godMode:debugEvidence',
  godModeIssueLoad: 'godMode:issueLoad',
  godModeIssuePlan: 'godMode:issuePlan',
  godModeIssueStart: 'godMode:issueStart',
  godModeIssueCreatePr: 'godMode:issueCreatePr',
  godModeWorkspaceList: 'godMode:workspaceList',
  godModeWorkspaceCreate: 'godMode:workspaceCreate',
  godModeWorkspaceProbe: 'godMode:workspaceProbe',
  godModeWorkspaceRun: 'godMode:workspaceRun',
  godModeWorkspaceCancel: 'godMode:workspaceCancel',
  godModeWorkspaceRemove: 'godMode:workspaceRemove',
  godModeExtensionList: 'godMode:extensionList',
  godModeExtensionEnable: 'godMode:extensionEnable',
  godModeExtensionDisable: 'godMode:extensionDisable',
  godModeCollaborationList: 'godMode:collaborationList',
  godModeCollaborationCreate: 'godMode:collaborationCreate',
  godModeCollaborationAddEvent: 'godMode:collaborationAddEvent',
  godModeCollaborationExport: 'godMode:collaborationExport',
  godModeCollaborationShare: 'godMode:collaborationShare',
  godModeCollaborationAddMember: 'godMode:collaborationAddMember',
  godModeDeploymentSaveHook: 'godMode:deploymentSaveHook',
  godModeDeploymentPlan: 'godMode:deploymentPlan',
  godModeDeploymentExecute: 'godMode:deploymentExecute',
  godModeDeploymentList: 'godMode:deploymentList',
  godModeDeploymentCancel: 'godMode:deploymentCancel',
  aiCompleteCancel: 'ai:completeCancel',
  aiCompleteFeedback: 'ai:completeFeedback',
  aiCompleteMetrics: 'ai:completeMetrics',
  secretsSet: 'secrets:set',
  secretsHas: 'secrets:has',
  secretsDelete: 'secrets:delete',
  aiTestConnection: 'ai:testConnection',
  aiFetchModels: 'ai:fetchModels',
  aiChatSend: 'ai:chatSend',
  aiChatCancel: 'ai:chatCancel',
  aiConnectionScope: 'ai:connectionScope',
  aiBuildContext: 'ai:buildContext',
  aiSpendSummary: 'ai:spendSummary',
  aiSpendClear: 'ai:spendClear',
  aiProviderHealth: 'ai:providerHealth',
  /** Detect a local, keyless model server (Ollama) for free zero-egress AI. */
  aiDetectLocalModels: 'ai:detectLocalModels',
  /** Session-scoped batch write consent for a trusted workspace. */
  agentWriteConsentGet: 'agent:writeConsentGet',
  agentWriteConsentGrant: 'agent:writeConsentGrant',
  agentWriteConsentRevoke: 'agent:writeConsentRevoke',
  aiDiagnosticsGet: 'ai:diagnosticsGet',
  /** Main → renderer push: updated spend summary after a recorded turn. */
  aiSpendChanged: 'ai:spendChanged',
  debugStart: 'debug:start',
  debugDiscover: 'debug:discover',
  debugSetBreakpoints: 'debug:setBreakpoints',
  debugControl: 'debug:control',
  debugStackTrace: 'debug:stackTrace',
  debugScopes: 'debug:scopes',
  debugVariables: 'debug:variables',
  debugEvaluate: 'debug:evaluate',
  debugStop: 'debug:stop',
  /** Main → renderer push: a debugger state/output event (DAP). */
  debugEvent: 'debug:event',
  agentRun: 'agent:run',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentApprovalShown: 'agent:approvalShown',
  /** Main → renderer push: an agent step (tool call, final answer, or error). */
  agentEvent: 'agent:event',
  agentTasks: 'agent:tasks',
  /** Main → renderer push: a tracked agent task's status changed. */
  agentTaskUpdate: 'agent:taskUpdate',
  agentRunsList: 'agent:runsList',
  agentRunsClear: 'agent:runsClear',
  agentRunsResumable: 'agent:runsResumable',
  agentRunBranch: 'agent:runBranch',
  agentRunReinvoke: 'agent:runReinvoke',
  customAgentsList: 'customAgents:list',
  customAgentsSave: 'customAgents:save',
  customAgentsDelete: 'customAgents:delete',
  /** Shareable agent presets committed in the repository (.axiom/agents). */
  workspaceAgentsList: 'workspaceAgents:list',
  workspaceAgentsShare: 'workspaceAgents:share',
  auditRead: 'audit:read',
  auditVerify: 'audit:verify',
  autoUpdateCheck: 'autoUpdate:check',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateGetState: 'update:getState',
  updateStatus: 'update:status',
  memoryList: 'memory:list',
  memoryAdd: 'memory:add',
  memoryUpdate: 'memory:update',
  memoryDelete: 'memory:delete',
  memoryClear: 'memory:clear',
  memorySelect: 'memory:select',
  telemetryConsent: 'telemetry:consent',
  telemetryRecord: 'telemetry:record',
  telemetryRead: 'telemetry:read',
  telemetryClear: 'telemetry:clear',
  featureFlagsAll: 'featureFlags:all',
  dataExportBuild: 'dataExport:build',
  dataExportSave: 'dataExport:save',
  syncStatus: 'sync:status',
  syncSnapshot: 'sync:snapshot',
  syncFlush: 'sync:flush',
  snapshotCapture: 'snapshot:capture',
  snapshotList: 'snapshot:list',
  snapshotRestore: 'snapshot:restore',
  snapshotRestoreEntry: 'snapshot:restoreEntry',
  snapshotReadEntry: 'snapshot:readEntry',
  snapshotClear: 'snapshot:clear',
  safeEditStage: 'safeEdit:stage',
  safeEditApply: 'safeEdit:apply',
  /** Main → renderer push: a streamed text delta during a chat completion. */
  aiChatChunk: 'ai:chatChunk',
  /** Main → renderer push: token usage + estimated cost for a finished turn. */
  aiChatUsage: 'ai:chatUsage',
  aiConvRead: 'aiConv:read',
  aiConvWrite: 'aiConv:write',
  aiConvMutate: 'aiConv:mutate',
  aiReview: 'ai:review',
  aiCompose: 'ai:compose',
  aiComplete: 'ai:complete',
  aiInlineEdit: 'ai:inlineEdit',
  aiInlineChat: 'ai:inlineChat',
  aiCommitMessage: 'ai:commitMessage',
  workflowsList: 'workflows:list',
  workflowsSave: 'workflows:save',
  workflowsDelete: 'workflows:delete',
  workflowsSetEnabled: 'workflows:setEnabled',
  mcpListServers: 'mcp:listServers',
  mcpSaveServer: 'mcp:saveServer',
  mcpDeleteServer: 'mcp:deleteServer',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpConnect: 'mcp:connect',
  mcpDisconnect: 'mcp:disconnect',
  mcpDisconnectWorkspace: 'mcp:disconnectWorkspace',
  mcpConnections: 'mcp:connections',
  mcpCallTool: 'mcp:callTool',
  rulesList: 'rules:list',
  rulesSaveGlobal: 'rules:saveGlobal',
  rulesDeleteGlobal: 'rules:deleteGlobal',
  rulesProposeConventions: 'rules:proposeConventions',
  promptsList: 'prompts:list',
  promptsSave: 'prompts:save',
  promptsDelete: 'prompts:delete',
  promptsRecordUse: 'prompts:recordUse',
  extensionsList: 'extensions:list',
  extensionsSetEnabled: 'extensions:setEnabled',
  extensionsRegistry: 'extensions:registry',
  extensionsHostStatus: 'extensions:hostStatus',
  extensionsRegistryIndex: 'extensions:registryIndex',
  extensionsInstall: 'extensions:install',

  // --- Open VSX marketplace -------------------------------------------------
  // A separate namespace from the `extensions:*` channels above, which serve
  // AXIOM's native extension model. These carry VS Code-compatible packages, whose
  // identity, enablement defaults and install pipeline are all different.
  /** Browse the registry: search text, category, sort, paging. */
  marketBrowse: 'market:browse',
  /** Full registry metadata for one extension. */
  marketDetail: 'market:detail',
  /** Published version history for one extension. */
  marketVersions: 'market:versions',
  /** User reviews and ratings for one extension. */
  marketReviews: 'market:reviews',
  /** Publisher (namespace) profile and the extensions it publishes. */
  marketPublisher: 'market:publisher',
  /** Readme or changelog markdown for the details pane. */
  marketDocument: 'market:document',
  /** Whether the registry answered, so the UI can show an honest offline state. */
  marketReachable: 'market:reachable',
  /** Everything installed, with enablement, integrity and capability reporting. */
  marketInstalled: 'market:installed',
  /** One installed extension including its parsed manifest and location on disk. */
  marketInstalledDetail: 'market:installedDetail',
  /** Install (or upgrade) from the registry, resolving dependencies first. */
  marketInstall: 'market:install',
  /** Install from a `.vsix` chosen by the user. */
  marketInstallFile: 'market:installFile',
  marketUninstall: 'market:uninstall',
  /** Enable/disable, globally or for the current workspace only. */
  marketSetEnabled: 'market:setEnabled',
  marketSetAutoUpdate: 'market:setAutoUpdate',
  marketSetAutoUpdateAll: 'market:setAutoUpdateAll',
  /** Ask the registry which installed extensions have a newer version. */
  marketCheckUpdates: 'market:checkUpdates',
  marketUpdateAll: 'market:updateAll',
  /** Aggregated declarative contributions from every enabled extension. */
  marketContributions: 'market:contributions',
  /** Load one contributed colour theme, converted to AXIOM tokens. */
  marketLoadTheme: 'market:loadTheme',
  /** Load one contributed icon theme with its icons inlined. */
  marketLoadIconTheme: 'market:loadIconTheme',
  /** Snippets contributed for a language. */
  marketSnippets: 'market:snippets',
  /** One contributed TextMate grammar, addressed by scope name rather than by path. */
  marketLoadGrammar: 'market:loadGrammar',
  /** Main → renderer push: the installed set or its enablement changed. */
  marketChanged: 'market:changed',

  // --- Extension hosts (extension code running out of process) ---
  /** Every extension that ships code, with whether it is running. */
  hostList: 'host:list',
  /** Grant or refuse permission for one extension's code to run. */
  hostSetConsent: 'host:setConsent',
  /** Stop one extension's host. */
  hostStop: 'host:stop',
  /** Clear a crash loop and start one extension again. */
  hostRestart: 'host:restart',
  /** Run a command an extension registered, activating it if needed. */
  hostRunCommand: 'host:runCommand',
  /** Status bar items extensions are currently showing. */
  hostStatusItems: 'host:statusItems',
  /** Diagnostics extensions have published. */
  hostDiagnostics: 'host:diagnostics',
  /** The captured output of one extension host. */
  hostOutput: 'host:output',
  /** The renderer reporting which file is active, for lazy activation. */
  hostActiveEditor: 'host:activeEditor',
  /** The renderer reporting a UI trigger (a view revealed, a link opened) for activation. */
  hostActivate: 'host:activate',
  /** The renderer answering a prompt an extension asked for. */
  hostPromptReply: 'host:promptReply',
  /** Main → renderer push: host state, status items or diagnostics changed. */
  hostChanged: 'host:changed',
  /** Main → renderer push: an extension is asking the user something. */
  hostPrompt: 'host:prompt',
  /** Main → renderer push: an extension crashed too many times to keep restarting. */
  hostCrashLoop: 'host:crashLoop',
  /** Main → renderer push: an extension asked for a file to be opened. */
  hostOpenFile: 'host:openFile',
  /** Main → renderer push: an extension asked the workbench to run one of its commands. */
  hostWorkbenchCommand: 'host:workbenchCommand',

  // --- Extension webviews (PRD Phase 4) ---
  /** Every live webview the workbench should be drawing. Never carries extension HTML. */
  webviewList: 'webview:list',
  /** One validated message from a webview frame, already origin-checked by the renderer. */
  webviewFrameMessage: 'webview:frameMessage',
  /** A frame became visible, hidden, focused or blurred. */
  webviewVisibility: 'webview:visibility',
  /** The user closed a panel, or the workbench tore a view down. */
  webviewClose: 'webview:close',
  /** A restored placeholder was looked at: its serializer must rebuild it now. */
  webviewReveal: 'webview:reveal',
  /** Show a contributed webview view, activating the extension that provides it. */
  webviewResolveView: 'webview:resolveView',
  /** Bring back the panels a previous session left open. */
  webviewRestore: 'webview:restore',
  /** The workbench theme, pushed so webview documents can carry its variables. */
  webviewTheme: 'webview:theme',
  /** Main → renderer push: the webview list changed. */
  webviewChanged: 'webview:changed',
  /** Main → renderer push: one host→frame envelope for the renderer to forward. */
  webviewPost: 'webview:post',

  // --- Workbench views: activity bar, tree views, menus, context keys (PRD Phase 5) ---
  /** Containers, views and badges the workbench should draw. */
  viewsWorkbench: 'views:workbench',
  /** One tree view's windowed rows. */
  viewsTree: 'views:tree',
  /** A pane became visible or hidden. */
  viewsVisibility: 'views:visibility',
  /** Expand, collapse or collapse-all on a tree row. */
  viewsExpand: 'views:expand',
  /** Selection changed, from a click or the keyboard. */
  viewsSelect: 'views:select',
  /** A row was activated: run the command it carries. */
  viewsActivate: 'views:activate',
  /** A row's checkbox was toggled. */
  viewsCheckbox: 'views:checkbox',
  /** One key press, resolved against the tree's own bindings. */
  viewsKey: 'views:key',
  /** `resolveTreeItem` for a row the user is looking at. */
  viewsResolveItem: 'views:resolveItem',
  /** Scroll position, pane size, collapsed state, active container. */
  viewsLayout: 'views:layout',
  /** Resolve a contributed menu location for the current context. */
  viewsMenu: 'views:menu',
  /** Run a command a resolved menu offered. */
  viewsMenuCommand: 'views:menuCommand',
  /** The workbench's own context keys, pushed from the renderer. */
  viewsContext: 'views:context',
  /** Main → renderer push: the workbench view model changed. */
  viewsChanged: 'views:changed',

  // --- Language platform: extension language providers (PRD Phase 6) ---
  /** Which features have providers, with their selectors, trigger characters and legends. */
  languagesRegistry: 'languages:registry',
  /** Invoke the providers applicable to one document for one feature, and await the merged result. */
  languagesProvide: 'languages:provide',
  /** Abandon an in-flight `languagesProvide`, tripping every provider's cancellation token. */
  languagesCancel: 'languages:cancel',
  /** A document was opened, changed, saved, closed, or had its language set in the editor. */
  languagesDocument: 'languages:document',
  /** Main → renderer push: the provider set changed, so Monaco registrations must be rebuilt. */
  languagesChanged: 'languages:changed',
  /**
   * Main → renderer push: named providers fired their change event, so their answers are stale.
   *
   * Deliberately not `languagesChanged`: that channel means "the set of providers is different" and
   * costs a full rebuild — every Monaco registration disposed and re-registered, every per-provider
   * cache in Monaco thrown away. A provider firing `onDidChangeCodeLenses` has not changed the set;
   * it has invalidated its own answers, and the faithful response is the one upstream makes — fire
   * that provider's own change event and let Monaco re-ask it for the models it is showing.
   */
  languagesProviderChanged: 'languages:providerChanged',
  /** Main → renderer push: apply a validated `WorkspaceEdit` to open models. */
  languagesApplyEdit: 'languages:applyEdit',
  /**
   * The part of a provider-returned `WorkspaceEdit` the editor cannot apply itself.
   *
   * A rename that touches twenty files usually has one of them open. Monaco applies the edits for
   * open models (one undo step, its own preview); closed files and `createFile`/`renameFile`/
   * `deleteFile` operations come back here so they go through the same validation and the same
   * workspace-boundary check as an edit an extension applied through `workspace.applyEdit`.
   */
  languagesApplyProviderEdit: 'languages:applyProviderEdit',
  // --- Extension runtime: terminals, tasks, debugging (PRD Phase 7) ---
  /**
   * Every terminal an extension owns, so the workbench can draw the panes it asked for.
   *
   * Extension terminals are *adopted* into the integrated terminal rather than given one of their
   * own: the renderer still owns creation, `term:create` still spawns the only pty there is, and
   * this channel only tells the renderer which of its panes belong to an extension.
   */
  runtimeTerminals: 'runtime:terminals',
  /** The renderer reporting a terminal it adopted: opened, closed, resized, focused, or typed into. */
  runtimeTerminalEvent: 'runtime:terminalEvent',
  /** Main → renderer push: an extension asked for a terminal to be created, shown, renamed or closed. */
  runtimeTerminalCommand: 'runtime:terminalCommand',
  /** Main → renderer push: the extension terminal list changed. */
  runtimeTerminalsChanged: 'runtime:terminalsChanged',
  /** Task executions extensions have started, for the workbench's own task UI. */
  runtimeTasks: 'runtime:tasks',
  /** Main → renderer push: one chunk of a running task's output. */
  runtimeTaskOutput: 'runtime:taskOutput',
  /** Main → renderer push: a task started, changed process, or ended. */
  runtimeTasksChanged: 'runtime:tasksChanged',
  /** Debug sessions extensions have started, with their type, name and parent. */
  runtimeDebugSessions: 'runtime:debugSessions',
  /** One extension debug session's console output. */
  runtimeDebugConsole: 'runtime:debugConsole',
  /** Main → renderer push: a debug session started or terminated. */
  runtimeDebugChanged: 'runtime:debugChanged',
  perfStartupReport: 'perf:startupReport',
  perfMarkReady: 'perf:markReady',
  compatReport: 'compat:report',
  crashRecoveryNotice: 'crash:recoveryNotice',
  authGetState: 'auth:getState',
  authSignInGoogle: 'auth:signInGoogle',
  authSignOut: 'auth:signOut',
  /** Which account profile owns this session's local data (read-only). */
  accountProfileGet: 'accountProfile:get',
  /** Main → renderer push: the authentication state changed. */
  authStateChanged: 'auth:stateChanged',
  termListShells: 'term:listShells',
  termCreate: 'term:create',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termKill: 'term:kill',
  /** Main → renderer push: pty output for a terminal. */
  termData: 'term:data',
  /** Main → renderer push: a terminal process exited. */
  termExit: 'term:exit',
  coreWalk: 'core:walk',
  coreSearch: 'core:search',
  coreSymbols: 'core:symbols',
  coreChunk: 'core:chunk',
  coreRetrieve: 'core:retrieve',
  coreEmbed: 'core:embed',
  coreGraphBuild: 'core:graph:build',
  coreGraphDependencies: 'core:graph:dependencies',
  coreGraphDependents: 'core:graph:dependents',
  coreGraphImpact: 'core:graph:impact',
  coreGraphCycles: 'core:graph:cycles',
  coreGraphEdges: 'core:graph:edges',
  coreProjectUnderstand: 'core:project:understand',
  coreCatalogRebuild: 'core:catalog:rebuild',
  coreCatalogStats: 'core:catalog:stats',
  coreCatalogQuery: 'core:catalog:query',
  coreWatch: 'core:watch',
  coreUnwatch: 'core:unwatch',
  /** Main → renderer push: a filesystem change from the Rust Core native watcher. */
  coreFsEvent: 'core:fsEvent',
  lspDidOpen: 'lsp:didOpen',
  lspDidChange: 'lsp:didChange',
  lspDidClose: 'lsp:didClose',
  lspHover: 'lsp:hover',
  lspCompletion: 'lsp:completion',
  lspDefinition: 'lsp:definition',
  lspReferences: 'lsp:references',
  lspTypeDefinition: 'lsp:typeDefinition',
  lspImplementation: 'lsp:implementation',
  lspDocumentHighlight: 'lsp:documentHighlight',
  lspRename: 'lsp:rename',
  lspSignatureHelp: 'lsp:signatureHelp',
  lspCodeAction: 'lsp:codeAction',
  lspDocumentSymbol: 'lsp:documentSymbol',
  lspInlayHint: 'lsp:inlayHint',
  lspFormatting: 'lsp:formatting',
  lspRangeFormatting: 'lsp:rangeFormatting',
  lspCompletionResolve: 'lsp:completionResolve',
  lspCodeActionResolve: 'lsp:codeActionResolve',
  lspExecuteCodeAction: 'lsp:executeCodeAction',
  lspExecuteCompletionCommand: 'lsp:executeCompletionCommand',
  lspResync: 'lsp:resync',
  lspDidSave: 'lsp:didSave',
  lspApplyEditResult: 'lsp:applyEditResult',
  lspPrepareRename: 'lsp:prepareRename',
  lspDeclaration: 'lsp:declaration',
  lspSelectionRange: 'lsp:selectionRange',
  lspDocumentLink: 'lsp:documentLink',
  lspOnTypeFormatting: 'lsp:onTypeFormatting',
  lspFoldingRange: 'lsp:foldingRange',
  lspSemanticTokens: 'lsp:semanticTokens',
  lspSemanticTokensLegend: 'lsp:semanticTokensLegend',
  lspWorkspaceSymbol: 'lsp:workspaceSymbol',
  lspPullDiagnostics: 'lsp:pullDiagnostics',
  lspCancel: 'lsp:cancel',
  lspServerStatuses: 'lsp:serverStatuses',
  lspRestartServer: 'lsp:restartServer',
  /** Detected developer toolchains on this machine (Run system + settings). */
  runtimesDetect: 'runtimes:detect',
  /** LANGUAGES view: what is installed, what each language needs, how to install it. */
  languagesCatalog: 'languages:catalog',
  /** Re-read PATH from the OS and re-probe, after the user installs something. */
  languagesRescan: 'languages:rescan',
  /** Install one language toolchain. Native approval precedes every command. */
  languagesInstall: 'languages:install',
  languagesInstallCancel: 'languages:installCancel',
  /** Main → renderer push: install progress, output, and completion. */
  languagesInstallEvent: 'languages:installEvent',
  /**
   * Build execution consent: the single permission collected at install time that
   * lets an in-app approval settle an action without a second confirmation.
   */
  executionConsentGet: 'executionConsent:get',
  executionConsentSet: 'executionConsent:set',
  /** Main → renderer push: diagnostics for a document from the language server. */
  lspDiagnostics: 'lsp:diagnostics',
  /** Main → renderer push: a language server's lifecycle state changed. */
  lspServerStatusChanged: 'lsp:serverStatusChanged',
  /** Main → renderer push: a `window/logMessage` / progress line from a server. */
  lspLog: 'lsp:log',
  /** Main → renderer push: a server asked for edits via `workspace/applyEdit`. */
  lspApplyEdit: 'lsp:applyEdit',
} as const;

/**
 * The secret-store key under which a provider's BYOK API key is saved. Shared by
 * Main (to read for outbound calls) and the renderer (to set / probe / clear).
 */
export function aiSecretKey(provider: string): string {
  return `ai.apiKey.${provider}`;
}

/** Non-secret authorization scope persisted beside a BYOK credential. */
export interface AiCredentialBinding {
  provider: string;
  baseUrl: string;
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface AppInfo {
  name: string;
  tagline: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
}

/** Opaque native titlebar colors; Main validates format and WCAG contrast. */
export interface TitleBarOverlayAppearance {
  color: string;
  symbolColor: string;
}

/** Persisted Main-owned trust decision for one canonical workspace root. */
export interface WorkspaceTrustState {
  root: string;
  trusted: boolean;
}

export type DirEntryKind = 'file' | 'directory';

export interface DirEntry {
  name: string;
  path: string;
  kind: DirEntryKind;
}

export interface ReadDirectoryResult {
  path: string;
  entries: DirEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  /** True if the file exceeded the read cap and only a preview was returned. */
  truncated: boolean;
  /** False for truncated, binary, or invalid UTF-8 content; such previews are read-only. */
  editable: boolean;
  binary: boolean;
  size: number;
  /** Safe explanation shown when editing is disabled. */
  readOnlyReason: string | null;
  /** Opaque disk revision used to reject saves over external changes. */
  etag: string;
}

export interface PathIdentityResult {
  /** Canonical read/write target. */
  path: string;
  /** Platform-normalized equality key (case-folded on Windows). */
  identity: string;
}

export interface WriteFileResult {
  path: string;
  /** Platform-normalized canonical equality key for `path`. */
  identity: string;
  bytes: number;
  /** New opaque disk revision after the atomic write. */
  etag: string;
}

export interface OpenFolderResult {
  path: string;
  name: string;
}

/** Result of a native file selection: an exact Main-authorized file capability. */
export interface OpenFileResult {
  path: string;
  name: string;
}

/** A file or directory path derived by preload from a real OS drag operation. */
export interface OpenPathResult {
  path: string;
  name: string;
  kind: DirEntryKind;
}

/** A read-only, Main-owned attachment capability. The absolute source path is never exposed. */
export type AttachmentKind = 'text' | 'image' | 'folder' | 'environment';

export interface AttachmentDescriptor {
  /** Opaque owner-bound capability used only by the chat IPC. */
  id: string;
  name: string;
  /** Workspace-relative path or a safe native-selection label. */
  detail: string;
  kind: AttachmentKind;
  /** Bounded source size at registration; folder sizes are unknown. */
  size: number | null;
  /** Environment values are always redacted before provider egress. */
  redacted: boolean;
}

export interface AttachmentTextInput {
  name: string;
  text: string;
}

/** Main-internal validated image data. Renderer input can reference only attachment ids. */
export interface AiImageInput {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
  sha256: string;
}

/** Result of the native "Save As" dialog: selected path and canonical write identity. */
export interface SaveFileResult {
  /** Canonical-parent path retaining the selected lexical leaf. */
  path: string;
  /** Canonical identity that a read/write through `path` currently targets. */
  canonicalPath: string;
  /** Platform-normalized equality key for `canonicalPath`. */
  canonicalIdentity: string;
  name: string;
}

/** A recently opened workspace folder (PRD Part VI §85 onboarding). */
export interface RecentFolder {
  path: string;
  name: string;
  lastOpened: number;
}

/** Result of creating a file or directory. `path` is the absolute path Main composed. */
export interface CreateEntryResult {
  path: string;
  name: string;
  kind: DirEntryKind;
}

export interface RenameResult {
  oldPath: string;
  newPath: string;
  name: string;
}

export interface DeleteResult {
  path: string;
  /** True if the entry was moved to the OS trash; false if permanently removed (fallback). */
  trashed: boolean;
}

/** Coarse change notification for the watched workspace root (Part VII §104). */
export interface FsChangeEvent {
  root: string;
}

/** A single file in the workspace, used by Quick Open (Part VII §105). */
export interface WorkspaceFile {
  /** Absolute path. */
  path: string;
  /** Base name (with extension). */
  name: string;
  /** Path relative to the workspace root, using `/` separators. */
  rel: string;
}

export interface ListFilesResult {
  root: string;
  files: WorkspaceFile[];
  /** True if the file cap was reached and the listing is partial. */
  truncated: boolean;
}

/** Cross-file search options (PRD Part VII §105 / search). */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One match occurrence within a line. Columns/lines are 1-based (Monaco-native). */
export interface SearchMatch {
  line: number;
  column: number;
  /** The (possibly windowed) line text shown in results. */
  preview: string;
  /** Match start offset within `preview`. */
  matchStart: number;
  matchLength: number;
}

export interface SearchFileResult {
  path: string;
  name: string;
  rel: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  query: string;
  files: SearchFileResult[];
  totalMatches: number;
  /** True if a cap (files or matches) was hit and results are partial. */
  truncated: boolean;
  /** Set when the query itself was invalid (e.g., a malformed regex). */
  error?: string | undefined;
}

/**
 * User settings overrides (Part IV §55 / Part VII §120). Only keys the user has
 * changed are persisted; defaults live in the renderer schema and are merged in.
 * Values are JSON scalars/objects (numbers, booleans, strings).
 */
export type SettingsData = Record<string, unknown>;

/** Exact normalized preference snapshots committed by an atomic profile apply. */
export interface ProfilePreferencesSnapshot {
  settings: SettingsData;
  keybindings: Record<string, string>;
}

/** A single disk-backed editor tab restored by path. */
export interface EditorTabState {
  path: string;
  name: string;
}

/**
 * Per-workspace disk-backed editor metadata. Open tab identities and which
 * one was active are persisted per workspace root so reopening a folder restores
 * the editors that were open when it was last closed.
 */
export interface EditorSessionState {
  tabs: EditorTabState[];
  active: string | null;
}

/**
 * Versioned persisted workbench layout. Geometry is clamped in Main and again
 * against the live viewport in the renderer so stale or multi-display state is safe.
 */
export interface LayoutState {
  version: 1;
  activeView: string;
  sidebarVisible: boolean;
  sidebarWidth: number;
  aiPanelVisible: boolean;
  aiPanelWidth: number;
  activityBarVisible: boolean;
  statusBarVisible: boolean;
  centeredLayout: boolean;
}

/** Source control (PRD Part VIII / Epoch D). Git operations are mediated by Main. */
export type GitChangeType = 'added' | 'modified' | 'deleted' | 'untracked';

/** A single changed file, path relative to the repo root (forward slashes). */
export interface GitChange {
  path: string;
  type: GitChangeType;
}

/** System Git availability. No executable paths or environment details cross IPC. */
export interface GitSystemInfo {
  available: boolean;
  version: string | null;
  message: string | null;
}

/** A sanitized configured remote. Credential components and URL queries are never returned. */
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  github: boolean;
}

/** System-Git repository metadata augmenting the careful local status matrix. */
export interface GitRepositoryInfo {
  isRepo: boolean;
  systemGit: GitSystemInfo;
  remotes: GitRemote[];
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  conflicts: string[];
}

/** Working-tree status: local matrix plus sanitized system-Git metadata. */
export interface GitStatusResult extends GitRepositoryInfo {
  branch: string | null;
  staged: GitChange[];
  unstaged: GitChange[];
}

/** Local branches and which one is currently checked out. */
export interface GitBranches {
  current: string | null;
  branches: string[];
  detached?: boolean;
}

/** The two source-control comparisons supported by the Git diff bridge. */
export type GitDiffMode = 'staged' | 'unstaged';

/**
 * A file diff. In staged mode this is HEAD → index; in unstaged mode this is
 * index → working tree. Either side may be empty (added / deleted).
 */
export interface GitDiff {
  original: string;
  modified: string;
}

/** One commit in the history log. `timestamp` is Unix seconds (author time). */
export interface GitLogEntry {
  oid: string;
  message: string;
  author: string;
  email: string;
  timestamp: number;
}

export type GitOperationKind =
  | 'fetch'
  | 'pull'
  | 'push'
  | 'add-remote'
  | 'checkout'
  | 'create-branch'
  | 'delete-branch'
  | 'merge'
  | 'rebase'
  | 'commit-and-push'
  | 'publish';

export interface GitOperationProgress {
  operationId: string;
  root: string;
  operation: GitOperationKind;
  phase: 'queued' | 'running' | 'progress' | 'complete' | 'error';
  percent: number | null;
  message: string;
}

export interface GitOperationRecovery {
  stage: 'commit-created' | 'repository-created' | 'remote-added';
  action: 'retry-push' | 'configure-origin';
  repositoryUrl: string | null;
}

export type GitOperationResult =
  | {
      operationId: string;
      outcome: 'success';
      message: string;
      recovery: null;
      commitOid?: string;
    }
  | {
      operationId: string;
      outcome: 'partial';
      message: string;
      recovery: GitOperationRecovery;
      commitOid?: string;
    };

/** Sanitized GitHub identity; authorization credentials never enter this contract. */
export interface GithubAccount {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string;
  scopes: string[];
  repositoryAccess: 'full' | 'public' | 'none';
  warning: string | null;
}

export type GithubAuthState =
  { status: 'disconnected'; account: null } | { status: 'connected'; account: GithubAccount };

export interface GithubDeviceFlow {
  flowId: string;
  userCode: string;
  verificationUrl: 'https://github.com/login/device';
  expiresAt: number;
  intervalSeconds: number;
}

export type GithubFlowPollResult =
  | { status: 'pending' | 'slow_down'; flow: GithubDeviceFlow; message: string }
  | { status: 'connected'; account: GithubAccount; message: string }
  | {
      status: 'cancelled' | 'expired' | 'access_denied' | 'device_flow_disabled' | 'error';
      message: string;
    };

export interface GithubCreateRepositoryInput {
  name: string;
  description?: string;
  visibility: 'public' | 'private';
}

export interface GithubRepository {
  id: number;
  name: string;
  fullName: string;
  visibility: 'public' | 'private';
  cloneUrl: string;
  htmlUrl: string;
}

export interface GithubPublishResult {
  ok: boolean;
  stage: 'published' | 'repository-created' | 'remote-added';
  repository: GithubRepository;
  message: string;
  recovery: string | null;
}

/**
 * Credentials for probing a Custom OpenAI-compatible endpoint (PRD Epoch F).
 * Sent renderer → Main only. When `apiKey` is empty, Main falls back to the
 * stored custom-provider key; the key never returns to the renderer (INV-3).
 */
export interface AiConnectionInput {
  baseUrl: string;
  apiKey: string;
  /** Optional extra request headers (name → value). */
  headers?: Record<string, string>;
  /**
   * Model to verify during Test Connection. Omitted or empty tests only endpoint
   * reachability; supplying it also proves the model's chat route works.
   */
  model?: string;
}

/** Result of a Test Connection probe against an OpenAI-compatible endpoint. */
export interface AiTestResult {
  ok: boolean;
  message: string;
  detail?: string;
}

/** Result of a Fetch Models request (`/models`) against an OpenAI-compatible endpoint. */
export interface AiModelsResult {
  ok: boolean;
  models: string[];
  message?: string;
}

/** A single message in a chat conversation (PRD Epoch F). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Request to start a streaming chat completion. The renderer supplies the
 * resolved provider/model/baseUrl (+ custom headers); Main reads the API key
 * from the secret store — the key never crosses back into the renderer (INV-3).
 */
export interface ChatSendInput {
  /** Correlates the request with its streamed chunks and cancellation. */
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  headers?: Record<string, string>;
  messages: ChatMessage[];
  /** Opaque Main-owned read-only attachment capabilities for this request. */
  attachmentIds?: string[];
}

/** Non-secret inputs used by Main to derive an opaque conversation scope. */
export interface AiConnectionScopeInput {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  workspaceRoot: string | null;
}

/** A streamed text delta pushed from Main during a chat completion. */
export interface ChatChunk {
  id: string;
  delta: string;
}

/** Response envelope returned after Main has authoritatively settled a chat request. */
export type AiResponseFormat =
  'openai-sse' | 'openai-json' | 'anthropic-sse' | 'gemini-sse' | 'unknown';

export type AiRequestPhase =
  | 'idle'
  | 'testing'
  | 'credential'
  | 'routing'
  | 'connecting'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AiCredentialStatus = 'available' | 'keyless' | 'missing' | 'error';

export interface AiDiagnosticsInput {
  provider: string;
  model: string;
  baseUrl: string;
}

export interface AiConnectionTestDiagnostic {
  ok: boolean;
  message: string;
  at: number;
}

/** Sanitized Main-owned connection/request state. Never contains prompts, code, keys, or headers. */
export interface AiDiagnosticsSnapshot {
  provider: string;
  model: string;
  endpointHost: string;
  endpointPath: string;
  credentialStatus: AiCredentialStatus;
  lastConnectionTest: AiConnectionTestDiagnostic | null;
  lastRequestPhase: AiRequestPhase;
  lastSafeError: string | null;
  failoverUsed: boolean;
  responseFormat: AiResponseFormat | null;
  updatedAt: number;
}

/** Token usage + estimated cost for a finished chat turn (PRD Phase 151 / §54). */
export interface ChatUsage {
  /** Correlates with the originating chat request id. */
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost, or null when the model's pricing is unknown. */
  costUsd: number | null;
}

export type ChatSendResult =
  | { id: string; status: 'cancelled' }
  | {
      id: string;
      status: 'completed';
      provider: string;
      model: string;
      failoverUsed: boolean;
      responseFormat: AiResponseFormat;
      usage: ChatUsage | null;
    };

/** Request to rewrite a selected region via natural language (PRD Phase 187). */
export interface InlineEditInput {
  instruction: string;
  selection: string;
  language: string;
  filename?: string;
  prefix?: string;
  suffix?: string;
}

/** Result of an inline edit: the replacement text, or an error to surface. */
export interface InlineEditResult {
  text: string;
  error?: string;
}

/** Request a quick, read-only Q&A about the code at the cursor (PRD Phase 188). */
export interface InlineChatInput {
  question: string;
  selection: string;
  language: string;
  filename?: string;
  prefix?: string;
  suffix?: string;
}

/** Result of an inline chat: the answer text, or an error to surface. */
export interface InlineChatResult {
  text: string;
  error?: string;
}

/** Input to the automatic context builder (PRD Phase 153). */
export interface BuildContextInput {
  root: string;
  query: string;
  activePath?: string;
  budgetTokens?: number;
  topK?: number;
}

/** A single piece of code selected for grounding context, with provenance. */
export interface ContextSource {
  path: string;
  rel: string;
  startLine: number;
  endLine: number;
  /** Retrieval similarity (0..1), or null for the always-included active file. */
  score: number | null;
  reason: 'active' | 'retrieval' | 'dependency';
}

/** Result of the context builder — a formatted system message + its sources. */
export interface ContextResult {
  text: string;
  sources: ContextSource[];
  tokensEstimated: number;
  truncated: boolean;
}

/** One recorded AI spend event — a completed chat turn (PRD Phases 152/197). */
export interface SpendEntry {
  ts: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Per-model cost rollup for the spend dashboard. */
export interface SpendModelTotal {
  model: string;
  usd: number;
}

/** Aggregated spend for the status bar + dashboard (session / today / all-time). */
export interface SpendSummary {
  sessionUsd: number;
  todayUsd: number;
  totalUsd: number;
  todayTokens: number;
  totalTokens: number;
  count: number;
  topModels: SpendModelTotal[];
}

// ---- Debugger (Debug Adapter Protocol, PRD Phases 96–101) --------------------

/** A debug launch/attach configuration targeting a DAP adapter. */
export interface DebugLaunchConfig {
  name: string;
  /** Command that starts the DAP adapter (e.g. 'node', 'python'). */
  adapterCommand: string;
  adapterArgs: string[];
  request: 'launch' | 'attach';
  /** Adapter-specific launch/attach arguments (program, args, cwd, …). */
  launchArgs: Record<string, unknown>;
  cwd?: string;
  /**
   * How the adapter speaks DAP. `stdio` (default) uses the adapter's own pipes;
   * `server` reserves a loopback port, passes it to the adapter, and connects over
   * TCP on 127.0.0.1 — required by js-debug, the standard Node/TypeScript debugger.
   */
  transport?: 'stdio' | 'server';
}

/**
 * One agent definition file found in a repository's `.axiom/agents` directory.
 *
 * Repository-authored agents are untrusted input: a persona becomes system-level
 * instructions, so nothing here is active until the user enables it. `digest` binds
 * that approval to the exact content, so any later edit requires a fresh review.
 */
export interface WorkspaceAgentFile {
  /** Workspace-relative path, e.g. `.axiom/agents/reviewer.axiom-agent.json`. */
  rel: string;
  valid: boolean;
  /** Present only when `valid`. */
  agent?: AgentPresetShape;
  /** SHA-256 of the agent's meaningful fields; present only when `valid`. */
  digest?: string;
  /** Why the file could not be used; present only when `!valid`. */
  reason?: string;
}

/**
 * Structural shape of an agent preset as it crosses IPC. Mirrors
 * `common/agentPresets.AgentPreset` without importing it into the channel map.
 */
export interface AgentPresetShape {
  id: string;
  name: string;
  description: string;
  persona: string;
  toolScope: 'all' | readonly string[];
  plan: boolean;
}

/**
 * Session-scoped batch consent that lets Build edit files in the trusted folder
 * without a prompt per edit. Main-held and memory-only, so it never outlives the
 * session. Commands, Git writes, MCP tools, and high-risk actions stay gated.
 */
export interface WriteConsentState {
  granted: boolean;
  /** Epoch ms when the grant lapses, or null for a session-free persisted grant. */
  expiresAt: number | null;
  remainingMs: number;
  /**
   * True when the grant is remembered for this folder across restarts. A persisted
   * grant never expires and is revoked by revoking it explicitly or by revoking
   * workspace trust.
   */
  persisted: boolean;
}

/**
 * Result of probing for a local, keyless model server (free zero-egress AI).
 * `available: false` carries actionable setup guidance instead of an error.
 */
export interface LocalModelProbe {
  available: boolean;
  provider: string;
  label: string;
  /** OpenAI-compatible base URL to use when available; '' otherwise. */
  baseUrl: string;
  models: string[];
  message: string;
}

export interface DebugStartResult {
  ok: boolean;
  message?: string;
}

/**
 * A Main-discovered debug configuration for the selected workspace. Main detects
 * the project runtime and resolves whether a real DAP adapter is actually present
 * on this machine, so the user picks a ready configuration instead of hand-typing
 * an adapter command. `available: false` entries carry actionable enablement steps.
 */
export interface DiscoveredDebugConfig {
  id: string;
  label: string;
  runtime: 'node' | 'python';
  available: boolean;
  /** Resolved adapter command (absolute or PATH-resolvable); empty when unavailable. */
  adapterCommand: string;
  adapterArgs: string[];
  request: 'launch' | 'attach';
  /** How the program field should be populated when this config is applied. */
  program: 'active-file' | 'workspace' | 'none';
  /** Why it is available, or the exact steps to enable it. */
  detail: string;
  /** Transport this adapter needs; `server` adapters get a reserved loopback port. */
  transport: 'stdio' | 'server';
  /**
   * Entry point Main resolved for this project (absolute, inside the workspace), or
   * '' when it could not be determined. This is what makes debugging zero-config:
   * the user does not have to know or type the entry file.
   */
  programPath: string;
  /**
   * Extra adapter-specific launch arguments this runtime needs (source maps, a
   * TypeScript loader, skipped internals, …). Merged under the caller's program/cwd.
   */
  launchArgs: Record<string, unknown>;
}

/** A breakpoint with optional condition / log message (PRD Phase 100). */
export interface DebugBreakpoint {
  line: number;
  condition?: string;
  logMessage?: string;
}

/** Result of evaluating a watch/hover expression against a stack frame. */
export interface DebugEvalResult {
  result: string;
  variablesReference: number;
  ok: boolean;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
}

export interface DebugScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
}

export type DebugState = 'inactive' | 'initializing' | 'running' | 'stopped' | 'terminated';

export type DebugControlAction = 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause';

/** Main → renderer push: a debugger lifecycle/output event. */
export type DebugEvent =
  | { kind: 'state'; state: DebugState; threadId: number | null; reason: string | null }
  | { kind: 'output'; category: string; output: string };

// ---- Agent runtime (PRD Epoch H, Phases 201+) -------------------------------

/** Request to run the agent on a task (the key is resolved in Main; INV-3). */
export interface AgentRunInput {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  headers?: Record<string, string>;
  root: string;
  task: string;
  /** Agent-library preset id (persona + tool scope). Defaults to 'coder'. */
  preset?: string;
  /**
   * Bounded renderer-authored continuity from earlier Build turns. Main treats it as
   * untrusted conversation text; it never grants tools, paths, trust, or approval.
   */
  priorTurnSummary?: string;
  /**
   * When present, Main accepts this only for a claimed owner/root-bound God Mode
   * job and derives the authoritative value from the durable job record.
   */
  maxIterations?: number;
  /**
   * When set, this run RESUMES the run with this id (Phase 210): completed
   * side-effecting steps from that run are replayed (skipped), not re-executed.
   */
  resumeRunId?: string;
}

/** One line of a unified-diff preview shown in an agent approval prompt. */
export interface AgentDiffLine {
  /** `hunk` = an `@@ … @@` header; `ctx` = unchanged; `add`/`del` = changed. */
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  /** 1-based line number in the current file (null for adds/hunk headers). */
  oldLine: number | null;
  /** 1-based line number in the proposed file (null for deletes/hunk headers). */
  newLine: number | null;
}

/** A file-change preview for an approval-gated or completed Agent edit. */
export interface AgentFileDiff {
  /** Workspace-relative path being changed. */
  path: string;
  /** Explicit semantic kind, including destructive deletion. */
  changeKind: 'create' | 'modify' | 'delete';
  /** Backward-compatible creation flag. */
  isNew: boolean;
  /** Count of added lines. */
  added: number;
  /** Count of removed lines. */
  removed: number;
  /** Unified-diff lines (hunks + context); empty when there is no change. */
  lines: AgentDiffLine[];
  /** True when the diff was capped for size. */
  truncated: boolean;
}

/** Process status Main observed for an approved `run_command` execution. */
export type AgentCommandStatus = 'completed' | 'cancelled' | 'timeout' | 'error';

/**
 * Main-authored, sanitized record of one approved shell command.
 *
 * Build already captured the exit code and combined output, but flattened them
 * into the free-text `observation` the renderer is forbidden to display — so a
 * failing command showed only "Verification completed; output hidden." and the
 * user had no way to see why. This is the structured, Main-owned alternative:
 * every field is redacted and length-capped in Main before it crosses IPC, and it
 * is deliberately never written to the durable run journal.
 */
export interface AgentCommandResult {
  /** The exact command Main executed (single line, control-free, bounded). */
  command: string;
  status: AgentCommandStatus;
  /** Process exit code, or null when the process never reported one. */
  exitCode: number | null;
  /** Combined stdout+stderr, credential-redacted and capped by Main. */
  output: string;
  /** True when Main capped the output. */
  truncated: boolean;
}

export type AgentProgressPhase =
  | 'queued'
  | 'preparing'
  | 'planning'
  | 'grounding'
  | 'acting'
  | 'awaiting-approval'
  | 'verifying'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Canonical Main-authored progress; models and renderers cannot stamp this data. */
export interface AgentProgress {
  root: string;
  at: number;
  phase: AgentProgressPhase;
  /** Present together when Main has a meaningful finite unit count. */
  completed?: number;
  total?: number;
  elapsedMs: number;
  /** Coarse remaining time, or null until Main has enough observations. */
  etaMs: number | null;
}

export type AgentVerificationState = 'not-run' | 'passed' | 'failed';
export type AgentRunOutcome = 'completed' | 'failed' | 'cancelled';

export interface AgentActivityMetadata {
  /** Allow-listed Main-authored status; renderer copy never consumes raw payloads. */
  status: 'succeeded' | 'failed' | 'blocked' | 'rejected' | 'cancelled' | 'replayed';
}

/** Canonical terminal accounting synthesized by Main, never copied from model prose. */
export interface AgentTerminalSummary {
  root: string;
  at: number;
  outcome: AgentRunOutcome;
  elapsedMs: number;
  toolCalls: number;
  filesChanged: number;
  checkpointsCreated: number;
  verification: AgentVerificationState;
  modelTrail: string[];
}

/** Main → renderer push: one rooted, timestamped agent event. */
export interface AgentStepEvent {
  id: string;
  root: string;
  at: number;
  kind: 'tool' | 'final' | 'error' | 'approval' | 'plan' | 'progress';
  step: number;
  /** Tool name (kind === 'tool' | 'approval'). */
  tool?: string;
  /** JSON-encoded tool arguments (kind === 'tool' | 'approval'). */
  args?: string;
  /** Tool result (kind === 'tool'). */
  observation?: string;
  /** Final answer / error / status / approval-preview message. */
  text?: string;
  /** Opaque decision token bound to this exact emitted preview (kind === 'approval'). */
  approvalToken?: string;
  /** Structured diff for an approval preview or a completed file mutation. */
  diff?: AgentFileDiff;
  /** True only when the corresponding tool event actually applied this diff. */
  applied?: boolean;
  /**
   * Main-authored sanitized command record. Present only on a `run_command` tool
   * event that actually reached process execution.
   */
  command?: AgentCommandResult;
  /**
   * Snapshot checkpoint that restores this file to its pre-edit state. Present
   * only on an applied file mutation, and it is the only handle the renderer gets
   * for undoing a turn — Main still owns authorization and the restore itself.
   */
  checkpointId?: string;
  /** Main-authored result for replay: whether a side-effecting action took effect. */
  effectApplied?: boolean;
  /** Ordered plan steps the agent drafted before acting (kind === 'plan'). */
  plan?: string[];
  /** Present only on Main-authored progress events. */
  progress?: AgentProgress;
  /** Structured, allow-listed tool status; contains no model/provider payload. */
  activity?: AgentActivityMetadata;
  /** Main-authored terminal outcome, present only on final/error events. */
  outcome?: AgentRunOutcome;
  /** Present only on final/error events after Main has settled accounting. */
  summary?: AgentTerminalSummary;
}

/** Renderer → main: the user's decision on a pending agent approval. */
export interface AgentApproval {
  id: string;
  approvalToken: string;
  approved: boolean;
}

/** Lifecycle status of a tracked agent run (PRD Epoch H §72.5 / §149). */
export type AgentTaskStatus =
  'queued' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled';

/** A tracked agent run for the task queue / agent-management view. */
export interface AgentTask {
  id: string;
  /** Canonical workspace identity used to reject stale cross-workspace push events. */
  root: string;
  preset: string;
  task: string;
  status: AgentTaskStatus;
  steps: number;
  startedAt: number;
  endedAt: number | null;
  lastText: string | null;
  progress: AgentProgress | null;
  summary: AgentTerminalSummary | null;
}

/** One entry in the local hash-chained audit log (PRD Part IV §56 / Part X §187). */
export interface AuditEvent {
  seq: number;
  ts: number;
  type: string;
  summary: string;
  prevHash: string;
  hash: string;
}

/** Result of verifying the audit chain's tamper-evidence. */
export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  /** seq of the first broken entry, or null when the chain is intact. */
  brokenAt: number | null;
}

/** Scope of a long-term memory entry (PRD Epoch F §70). */
export type MemoryScope = 'global' | 'workspace';

/** A single long-term memory entry (local only; never uploaded — INV-4). */
export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Local workspace root when scope === 'workspace'; null for global. */
  workspaceKey: string | null;
  text: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A ready-to-inject block of memories selected as relevant to a query. */
export interface MemorySelection {
  text: string;
  count: number;
}

/** Telemetry consent categories (PRD Epoch E §52–53). All default off (opt-in). */
export type TelemetryCategory = 'crashReports' | 'analytics' | 'performance';

/** Per-category telemetry consent. */
export type TelemetryConsent = Record<TelemetryCategory, boolean>;

/** A sanitized, buffered telemetry event (no code/PII/free text). */
export interface TelemetryEvent {
  ts: number;
  category: TelemetryCategory;
  type: string;
  props: Record<string, number | boolean | string>;
}

/** A feature-flag value (PRD Epoch E §57 / Phase 129). */
export type FlagValue = boolean | number | string;

/** A feature-flag definition with optional targeting + rollout + kill switch. */
export interface FeatureFlag {
  key: string;
  value: FlagValue;
  /** Percentage rollout 0–100 (boolean flags only); stable per user. */
  rolloutPct?: number;
  /** Minimum app version required (boolean flags only). */
  minVersion?: string;
  /** Allowed OS platforms (boolean flags only). */
  os?: string[];
  /** Kill switch — forces a boolean flag off. */
  killed?: boolean;
}

/** Evaluation context for feature flags. */
export interface FlagContext {
  appVersion: string;
  os: string;
  userId: string;
}

/** A persisted chat conversation (PRD Epoch G). Timestamps are epoch millis. */
export interface AiConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /**
   * Opaque Main-issued connection/workspace identity. Missing only on legacy
   * records, which require an explicit user migration before reuse.
   */
  scopeId?: string;
  /** Pinned threads sort first and are surfaced above the rest (PRD Phase 179). */
  pinned?: boolean;
}

/** Serialized, scope-local conversation mutations performed by trusted Main. */
export type AiConversationMutation =
  | { kind: 'upsert'; scopeId: string; conversation: AiConversation }
  | { kind: 'delete'; scopeId: string; id: string }
  | { kind: 'clear'; scopeId: string }
  | { kind: 'migrateLegacy'; scopeId: string };

/**
 * The authenticated user, sanitized for the renderer (PRD Epoch E / INV-3).
 * Never includes tokens — those stay in the Main process.
 */
export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export type AuthStatus = 'loading' | 'signedOut' | 'signingIn' | 'signedIn' | 'error';

/** Authentication state broadcast to the renderer. */
export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error?: string;
}

/**
 * Non-identifying description of the account profile that owns local data.
 *
 * Deliberately carries no email, user id, or filesystem path: the renderer only needs
 * to be able to TELL the user their data is separate per account, not to locate it.
 */
export interface AccountProfileInfo {
  /** True when a signed-in account owns this session's data. */
  signedInProfile: boolean;
  /** Short opaque reference, for support conversations only. */
  reference: string;
  /** How many AXIOM-owned entries this profile currently stores. */
  entries: number;
}

/** An available terminal shell (PRD Epoch D / integrated terminal). */
export interface TerminalShellInfo {
  /** Stable shell id: 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'wsl'. */
  id: string;
  label: string;
}

/** Options for spawning a pty-backed terminal in a trusted workspace. */
export interface TerminalCreateOptions {
  id: string;
  /** Shell id from TerminalShellInfo, or '' for the default. */
  shell: string;
  /** Canonical trusted workspace root used as the working directory. */
  cwd: string;
  cols: number;
  rows: number;
  /**
   * The extension terminal handle this pane was adopted for, if any (PRD Phase 7).
   *
   * The renderer echoes back only the handle it was given. Main looks the rest of the spawn up in
   * its own registry, so the shell, the working directory and the environment an extension asked
   * for never travel through the renderer.
   */
  extensionHandle?: number;
}

/** Result of creating a terminal. */
export interface TerminalCreateResult {
  id: string;
  pid: number;
  shell: string;
}

/** Main → renderer: pty output chunk. */
export interface TerminalDataEvent {
  id: string;
  data: string;
}

/** Main → renderer: a terminal process exited. */
export interface TerminalExitEvent {
  id: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Extension runtime: terminals, tasks, debugging (PRD Phase 7)
// ---------------------------------------------------------------------------
/**
 * One terminal an extension owns, as the workbench sees it.
 *
 * `sessionId` is the id the *renderer* minted when it adopted the terminal — the same id the
 * existing `term:*` channels use — and is empty until it has. `handle` is the extension's own,
 * and is what every command and event is addressed by, so an extension can never name a pane
 * that is not its own.
 */
export interface ExtensionTerminalInfo {
  handle: number;
  extensionId: string;
  name: string;
  sessionId: string;
  /** True for a `Pseudoterminal`: the extension is the process, so no pty is spawned. */
  extensionPty: boolean;
  location: 'panel' | 'editor';
  /** The handle this terminal was split from, or 0. */
  splitParent: number;
  /** Codicon id, never a path or a URL. */
  iconId: string;
  /** Theme colour id, never a CSS colour. */
  colorId: string;
  hideFromUser: boolean;
  isInteractedWith: boolean;
  shellIntegration: boolean;
}

/**
 * Main → renderer: something an extension asked for one of its terminals.
 *
 * Deliberately carries no shell, working directory or environment. The renderer's job on `create`
 * is to draw a pane and echo the handle back on `term:create`; Main resolves the spawn from its own
 * registry, so the process environment never crosses the preload boundary.
 */
export interface ExtensionTerminalCommand {
  op: 'create' | 'dispose' | 'show' | 'hide' | 'name' | 'write';
  handle: number;
  extensionId: string;
  /** Present on `create`. */
  terminal?: ExtensionTerminalInfo;
  /** Text for `write` — a `Pseudoterminal`'s own output, escape sequences included. */
  data?: string;
  /** The new name for `name`. */
  name?: string;
  /** `show` without stealing focus. */
  preserveFocus?: boolean;
}

/** The renderer reporting what happened to a terminal it adopted for an extension. */
export interface ExtensionTerminalEvent {
  kind: 'opened' | 'closed' | 'input' | 'dimensions' | 'active' | 'interacted' | 'shell';
  handle: number;
  /** `opened`: the renderer's own terminal id. */
  sessionId?: string;
  processId?: number;
  exitCode?: number;
  /** `input`: what the user typed into an extension pty. */
  data?: string;
  columns?: number;
  rows?: number;
  /** `shell`: whether shell integration sequences were seen in this pane. */
  available?: boolean;
}

/** One task execution an extension started. */
export interface ExtensionTaskExecutionInfo {
  executionId: number;
  extensionId: string;
  name: string;
  type: string;
  source: string;
  state: 'starting' | 'running' | 'ended';
  processId: number | null;
  exitCode: number | null;
  /** True for a `CustomExecution`: the extension is the process. */
  custom: boolean;
}

/** Main → renderer: one chunk of a task's output. */
export interface ExtensionTaskOutputEvent {
  executionId: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

/** One debug session an extension started. */
export interface ExtensionDebugSessionInfo {
  sessionId: string;
  extensionId: string;
  type: string;
  name: string;
  parentId: string | null;
  state: 'starting' | 'running' | 'terminated';
  /** How the adapter is being spoken to. `inline` means the extension implements it. */
  transport: 'executable' | 'server' | 'namedPipe' | 'inline' | 'none';
}

/** Rust Core `walk` result: the ignore-aware file list for a directory (PRD Epoch C). */
export interface CoreWalkResult {
  root: string;
  files: string[];
  count: number;
}

/** A single Rust Core search hit. */
export interface CoreSearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Rust Core `search` result. */
export interface CoreSearchResult {
  root: string;
  query: string;
  matches: CoreSearchMatch[];
  count: number;
}

/** A single symbol extracted by the Rust Core Tree-sitter pass (PRD Phase 52/53). */
export interface CoreSymbol {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

/** Rust Core `symbols` result: the definitions found in a file. */
export interface CoreSymbolsResult {
  path: string;
  language: string;
  symbols: CoreSymbol[];
  count: number;
}

/** Options for the Rust Core semantic chunker (PRD Phase 57). */
export interface CoreChunkOptions {
  maxLines?: number;
  overlap?: number;
}

/** A single semantic chunk (line window) produced by the Rust Core. */
export interface CoreChunk {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
}

/** Rust Core `chunk` result. */
export interface CoreChunkResult {
  path: string;
  chunks: CoreChunk[];
  count: number;
}

/** Options for on-device semantic retrieval (PRD Phase 64). */
export interface CoreRetrieveOptions {
  /** Max number of chunks to return (default 10). */
  topK?: number;
  /** Line-window size per chunk (default 60). */
  maxLines?: number;
  /** Embedding dimensionality (default 256). */
  dim?: number;
}

/** A single semantic retrieval hit with file/line provenance (PRD Phase 64, Part VIII §126). */
export interface CoreRetrieveHit {
  path: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity to the query in [-1, 1]; higher is more relevant. */
  score: number;
  preview: string;
}

/** Rust Core `retrieve` result: top-k workspace chunks ranked by similarity. */
export interface CoreRetrieveResult {
  root: string;
  query: string;
  results: CoreRetrieveHit[];
  count: number;
}

/** Rust Core `embed` result: an L2-normalized embedding vector for a text. */
export interface CoreEmbedResult {
  dim: number;
  vector: number[];
}

/** Rust Core `graph/build` result — dependency graph size (PRD Phase 65). */
export interface CoreGraphBuildResult {
  root: string;
  files: number;
  edges: number;
}

/** Rust Core `graph/dependencies` result — files + packages a file imports (PRD Phase 66). */
export interface CoreGraphDependenciesResult {
  path: string;
  dependencies: string[];
  external: string[];
  count: number;
}

/** Rust Core `graph/dependents` result — files that import a file (PRD Phase 66). */
export interface CoreGraphDependentsResult {
  path: string;
  dependents: string[];
  count: number;
}

/** Rust Core `graph/impact` result — transitive dependents / blast radius (PRD Phase 66). */
export interface CoreGraphImpactResult {
  path: string;
  impacted: string[];
  count: number;
}

/** Rust Core `graph/cycles` result — example import cycles (PRD Phase 66). */
export interface CoreGraphCyclesResult {
  cycles: string[][];
  count: number;
}

/** A node in the full-repo knowledge graph (PRD Phase 65). Structurally matches
 * `common/knowledgeGraph` KnowledgeNode so the result can be queried directly. */
export interface CoreGraphEdgeNode {
  id: string;
  kind: 'file' | 'symbol' | 'module' | 'package';
  name: string;
}

/** A typed edge in the full-repo knowledge graph (PRD Phase 65). */
export interface CoreGraphEdge {
  from: string;
  to: string;
  kind: 'imports' | 'calls' | 'extends' | 'refs';
}

/**
 * Symbol-level summary for the knowledge graph (PRD Phase 65, symbol level). Totals +
 * the most cross-file-referenced symbols. Structurally matches
 * `common/symbolGraph` SymbolGraphSummary.
 */
export interface CoreGraphSymbolSummary {
  symbols: number;
  files: number;
  references: number;
  topReferenced: { symbol: string; count: number }[];
  summary: string;
}

/**
 * Full-repo file-level knowledge graph (PRD Phase 65). Built main-side by scanning
 * workspace sources for relative imports (`common/importGraph`), so the renderer can
 * run whole-repo reachability / blast-radius queries the per-file Core APIs can't.
 */
export interface CoreGraphEdgesResult {
  nodes: CoreGraphEdgeNode[];
  edges: CoreGraphEdge[];
  /** Optional symbol-level summary (PRD Phase 65, symbol level). */
  symbols?: CoreGraphSymbolSummary;
}

/** A build/test/dev script from package.json (PRD Phase 68). */
export interface CoreProjectScript {
  name: string;
  command: string;
}

/** A language breakdown entry (source files of that language). */
export interface CoreProjectLanguage {
  name: string;
  files: number;
}

/** Rust Core `project/understand` result — the derived project profile (Phase 68 / §125.4). */
export interface CoreProjectProfile {
  root: string;
  name: string | null;
  totalFiles: number;
  languages: CoreProjectLanguage[];
  packageManagers: string[];
  frameworks: string[];
  testFramework: string | null;
  scripts: CoreProjectScript[];
  entryPoints: string[];
  monorepo: boolean;
  workspaces: string[];
}

/** Rust Core `catalog/rebuild` result (PRD Phase 56). */
export interface CoreCatalogRebuildResult {
  root: string;
  db: string;
  indexed: number;
}

/** One extension bucket in the catalog stats breakdown. */
export interface CoreCatalogExtStat {
  ext: string;
  count: number;
}

/** Rust Core `catalog/stats` result. */
export interface CoreCatalogStatsResult {
  files: number;
  bytes: number;
  byExt: CoreCatalogExtStat[];
}

/** A single catalog entry. `mtime` is Unix seconds. */
export interface CoreCatalogFile {
  path: string;
  ext: string;
  size: number;
  mtime: number;
}

/** Rust Core `catalog/query` result. */
export interface CoreCatalogQueryResult {
  files: CoreCatalogFile[];
  count: number;
}

/** Rust Core `watch` acknowledgement. */
export interface CoreWatchResult {
  watching: string;
}

/** Rust Core `unwatch` acknowledgement. */
export interface CoreUnwatchResult {
  unwatched: string;
  stopped: boolean;
}

/** Main → renderer push: a filesystem change from the Rust Core native watcher. */
export interface CoreFsEvent {
  kind: string;
  paths: string[];
}

/** LSP 0-based position (line + UTF-16 character offset). PRD Part VII §107. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** A source location: a URI + a range within it (0-based LSP coords). */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** A secondary location explaining a diagnostic (LSP `relatedInformation`). */
export interface LspDiagnosticRelated {
  location: LspLocation;
  message: string;
}

/**
 * A diagnostic from the language server (LSP severity: 1 error…4 hint).
 * `tags` carries LSP DiagnosticTag (1 = unnecessary, 2 = deprecated) so the editor
 * can render faded/struck text, and `data` is the server's opaque round-trip token
 * required by `codeAction/resolve` for quick fixes.
 */
export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity: number;
  source?: string;
  code?: string;
  /** Server-provided URL documenting the rule behind this diagnostic. */
  codeDescription?: string;
  tags?: number[];
  relatedInformation?: LspDiagnosticRelated[];
  data?: unknown;
}

/** Main → renderer push: the current diagnostics for a document URI. */
export interface LspDiagnosticsEvent {
  uri: string;
  diagnostics: LspDiagnostic[];
  /** Server id that produced them, so per-server results never clobber each other. */
  serverId?: string;
}

/** Hover result: markdown `contents` ('' when none) + optional highlight range. */
export interface LspHoverResult {
  contents: string;
  range?: LspRange;
}

/**
 * A normalized completion item from the language server.
 *
 * `id` is Main's handle for the unresolved item: passing it back to
 * `completionItem/resolve` fills in the documentation, detail, and — critically
 * for auto-imports — the `additionalTextEdits` that insert the import statement.
 * `insertTextFormat` is LSP's (1 = plain text, 2 = snippet).
 */
export interface LspCompletionItem {
  label: string;
  /** Main-side handle used by `resolveCompletion`; never sent by the renderer. */
  id?: number;
  kind?: number;
  detail?: string;
  labelDetail?: string;
  labelDescription?: string;
  documentation?: string;
  /** True when `documentation` is markdown rather than plain text. */
  documentationIsMarkdown?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  deprecated?: boolean;
  commitCharacters?: string[];
  /** Server-authored replacement range, which may differ from the current word. */
  textEdit?: LspTextEdit;
  /** Extra edits applied with the item — how auto-import inserts the import. */
  additionalTextEdits?: LspTextEdit[];
  command?: LspCommand;
}

export interface LspCompletionResult {
  items: LspCompletionItem[];
  /** True when the list is partial and must be recomputed as the user types. */
  isIncomplete?: boolean;
}

/** How a completion was triggered (LSP CompletionTriggerKind). */
export interface LspCompletionContext {
  triggerKind: number;
  triggerCharacter?: string;
}

/** A server-side command reference (`workspace/executeCommand`). */
export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface LspLocationResult {
  locations: LspLocation[];
}

/** A highlighted occurrence of the symbol under the cursor (1 text, 2 read, 3 write). */
export interface LspDocumentHighlight {
  range: LspRange;
  kind: number;
}

export interface LspDocumentHighlightResult {
  highlights: LspDocumentHighlight[];
}

/** A single text edit: replace `range` with `newText` (0-based LSP coords). */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** A rename result: text edits grouped by document URI (PRD Phase 93). */
export interface LspWorkspaceEdit {
  changes: Record<string, LspTextEdit[]>;
}

/** Signature help (PRD Phase 91). */
export interface LspSignatureParam {
  label: string;
  documentation?: string;
}
export interface LspSignature {
  label: string;
  documentation?: string;
  parameters: LspSignatureParam[];
  /** Per-signature active parameter, which overrides the top-level index. */
  activeParameter?: number;
}
export interface LspSignatureHelp {
  signatures: LspSignature[];
  activeSignature?: number;
  activeParameter?: number;
}

/**
 * A code action / quick fix (PRD Phase 93). Either or both of `edit` and
 * `command` may be present: tsserver's organize-imports and most refactors are
 * command-only, and lazy servers send neither until `codeAction/resolve` is
 * called with `id`.
 */
export interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  isPreferred?: boolean;
  /** Set when the server marked the action unavailable, with its reason. */
  disabledReason?: string;
  /** Main-side handle for `resolveCodeAction`; present when resolution may help. */
  id?: number;
}

/** LSP `textDocument/prepareRename` result: the identifier range + placeholder. */
export interface LspPrepareRenameResult {
  range: LspRange | null;
  placeholder?: string;
}

/** A foldable region (LSP `textDocument/foldingRange`). */
export interface LspFoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  /** 'comment' | 'imports' | 'region' when the server classifies the range. */
  kind?: string;
}

/** The server's semantic-token legend, resolved at initialize time. */
export interface LspSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** Encoded semantic tokens (LSP's 5-integer relative encoding). */
export interface LspSemanticTokens {
  resultId?: string;
  data: number[];
}

/** A clickable link inside a document (LSP `textDocument/documentLink`). */
export interface LspDocumentLink {
  range: LspRange;
  target?: string;
  tooltip?: string;
}

/** A flat workspace symbol (LSP `workspace/symbol`). */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

/** Progressively widening selection ranges, innermost first. */
export interface LspSelectionRangeResult {
  ranges: LspRange[];
}

/** Lifecycle state of one language server instance, for the status UI. */
export type LspServerState = 'stopped' | 'starting' | 'running' | 'failed';

/** Main → renderer: one server's health, used by the status bar and output view. */
export interface LspServerStatus {
  id: string;
  displayName: string;
  languageIds: string[];
  state: LspServerState;
  /** How many times this server has crashed and been restarted this session. */
  restarts: number;
  /** Populated when `state` is 'failed' — why it is unavailable. */
  detail?: string;
  /** True for servers detected on PATH rather than bundled with AXIOM. */
  external: boolean;
}

/** Main → renderer push: a `window/logMessage` or `$/progress` line from a server. */
export interface LspLogEvent {
  serverId: string;
  /** LSP MessageType: 1 error, 2 warning, 3 info, 4 log. */
  type: number;
  message: string;
}

/**
 * Main → renderer: a server requested edits (`workspace/applyEdit`), which is how
 * organize-imports and command-backed refactors deliver their result. The
 * renderer applies them to its models and answers with the same `nonce`, so the
 * server learns whether the edit actually landed instead of being told it did.
 */
export interface LspApplyEditRequest {
  nonce: number;
  edit: LspWorkspaceEdit;
}

/** A (possibly nested) document symbol for the outline/breadcrumbs (PRD §108/95). */
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children: LspDocumentSymbol[];
}

/** An inlay hint (inferred type/parameter name) shown inline (PRD Phase 94). */
export interface LspInlayHint {
  position: LspPosition;
  label: string;
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** `textDocument/didOpen` payload from the renderer; `rootPath` scopes the server. */
export interface LspDidOpenInput {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  rootPath: string;
}

/**
 * One incremental content change. `range` + `rangeLength` describe the replaced
 * span; omitting `range` means `text` is the whole document (full sync fallback,
 * used only when a server does not advertise incremental support).
 */
export interface LspContentChange {
  text: string;
  range?: LspRange;
  rangeLength?: number;
}

/**
 * `textDocument/didChange` payload.
 *
 * `changes` carries the incremental edits in the order Monaco produced them —
 * this is what goes on the wire for servers advertising incremental sync. Main
 * maintains its own copy of the document by applying them, which is also what
 * lets it re-seed a server that crashed and full-sync the ones that need it.
 * `length` is the renderer's authoritative character count: when it disagrees
 * with Main's reconstruction the call answers `{ resync: true }` and the renderer
 * resends with `text` populated, so drift can never go unnoticed.
 */
export interface LspDidChangeInput {
  uri: string;
  version: number;
  changes?: LspContentChange[];
  /** Full document text. Sent on the resync path only. */
  text?: string;
  /** UTF-16 length of the renderer's document, for drift detection. */
  length?: number;
}

/** Answer to `didChange`: `resync` asks the renderer to resend the full text. */
export interface LspDidChangeResult {
  resync: boolean;
}

// ---------------------------------------------------------------------------
// Extension language platform (PRD Phase 6)
//
// These shapes cross `languages:*`. They are deliberately close to the LSP ones above so the
// renderer's existing `lspConvert.ts` converters serve extension providers unchanged; the two
// provider sets are registered independently in Monaco and neither knows about the other.
// ---------------------------------------------------------------------------

/** One extension provider, as the renderer needs it to build a Monaco registration. */
export interface ExtensionProviderDescriptor {
  /** Main's global handle. Passed back on `languages:provide` when a feature needs one provider. */
  handle: number;
  extensionId: string;
  /** `DocumentSelector` filters, already normalised to objects. */
  selector: Array<{ language?: string; scheme?: string; pattern?: string; notebookType?: string }>;
  triggerCharacters?: string[];
  retriggerCharacters?: string[];
  firstTriggerCharacter?: string;
  moreTriggerCharacter?: string[];
  codeActionKinds?: string[];
  legend?: { tokenTypes: string[]; tokenModifiers: string[] };
  hasResolve?: boolean;
  hasEdits?: boolean;
  hasPrepare?: boolean;
  /**
   * The provider carries its feature's change event (`onDidChangeCodeLenses` and the rest).
   *
   * Monaco is told per registration: a `CodeLensProvider` with an `onDidChange` is one Monaco has to
   * subscribe to, and one without is one it can treat as constant. Advertising the event for a
   * provider that has none would leave Monaco holding a subscription that never fires, which costs
   * nothing but says something untrue; withholding it for a provider that has one is worse — the
   * refresh arrives in Main and stops there.
   */
  hasChangeEvent?: boolean;
  displayName?: string;
}

/** A language an extension contributed, for `monaco.languages.register`. */
export interface ExtensionLanguageDescriptor {
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
  mimetypes: string[];
  firstLine?: string;
  /** `monaco.languages.setLanguageConfiguration` input, already normalised. */
  configuration?: unknown;
}

/** The whole extension-provider registry, as one snapshot the renderer rebuilds Monaco from. */
export interface ExtensionLanguageRegistry {
  /** Bumped on every change, so a stale snapshot can be recognised and discarded. */
  revision: number;
  /** Feature name → the providers registered for it, best-scoring order decided per document. */
  features: Record<string, ExtensionProviderDescriptor[]>;
  languages: ExtensionLanguageDescriptor[];
}

/** One provider invocation, from the renderer's Monaco provider into the extension hosts. */
export interface ExtensionProvideInput {
  /** Renderer-chosen id, unique while the call is in flight. Cancellation names it. */
  requestId: number;
  feature: string;
  /** `provide`, `resolve`, `prepare`, `presentations`, `incoming`, `outgoing`, `supertypes`, `subtypes`, `edits`. */
  op: string;
  /** The document the call is about. Absent only for `workspaceSymbol`. */
  uri?: string;
  /** Route to exactly one provider, for features Monaco registers per provider. */
  handle?: number;
  /** Feature-specific arguments: position, range, context, formatting options, mint tokens. */
  payload?: Record<string, unknown>;
}

/** The merged answer. `ok: false` carries a reason for the log, never for the UI. */
export interface ExtensionProvideResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Providers that threw or timed out while others answered. */
  failures?: string[];
}

/** A document lifecycle event the renderer reports so every host stays in step with the editor. */
export interface ExtensionDocumentInput {
  type: 'open' | 'change' | 'save' | 'close' | 'language';
  uri: string;
  languageId?: string;
  version?: number;
  text?: string;
  isDirty?: boolean;
  changes?: Array<{ range?: LspRange; text: string }>;
}

/** Answer to a document event: `resync` asks the renderer to resend the full text. */
export interface ExtensionDocumentResult {
  ok: boolean;
  resync?: boolean;
}

/** Main → renderer: text edits a validated `WorkspaceEdit` needs the editor to apply. */
export interface ExtensionApplyEditPayload {
  entries: Array<{
    kind: 'text';
    uri: string;
    edits: Array<{ range: LspRange; newText: string; insertAsSnippet?: boolean }>;
  }>;
  touched: string[];
}

/**
 * Renderer → Main: the part of a provider-returned `WorkspaceEdit` the editor cannot apply.
 *
 * Deliberately the same shape as the wire `WorkspaceEdit` an extension hands to
 * `workspace.applyEdit`, because it is validated by the same function against the same workspace
 * roots. The renderer keeps the text edits for models it has open — those belong in Monaco's undo
 * stack — and sends everything else here.
 */
export interface ExtensionProviderEditInput {
  entries: Array<
    | {
        kind: 'text';
        uri: string;
        edits: Array<{ range: LspRange; newText: string; insertAsSnippet?: boolean }>;
      }
    | {
        kind: 'create';
        uri: string;
        overwrite?: boolean;
        ignoreIfExists?: boolean;
        contents?: string;
      }
    | { kind: 'rename'; uri: string; newUri: string; overwrite?: boolean; ignoreIfExists?: boolean }
    | { kind: 'delete'; uri: string; recursive?: boolean; ignoreIfNotExists?: boolean }
  >;
}
