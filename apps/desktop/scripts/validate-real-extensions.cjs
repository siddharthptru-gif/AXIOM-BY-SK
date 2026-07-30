'use strict';

/**
 * Real-extension validation harness.
 *
 * This script does not test AXIOM against extensions we wrote. It downloads nothing and
 * mocks nothing about the extension itself: it takes actual `.vsix` packages published by
 * their real authors and pushes them through the *same* main-process code an install
 * triggers — `readVsixFile` → `inspectVsix` → `reportCompatibility` →
 * `installExtensionFromFile` → `listInstalledExtensions` → `buildContributionCatalog`.
 *
 * Why a script rather than a unit test: those modules are main-process modules that import
 * `electron`. Electron is stubbed here to the four members they actually touch (`app`
 * paths, `safeStorage`, `shell.openExternal`, `utilityProcess`), and `app.getPath` is
 * pointed at a scratch directory, so the run exercises the real staging/extraction/state
 * machinery without needing a window. Anything the harness cannot do headlessly — paint a
 * webview, click Sign In, complete a browser OAuth round-trip — is reported as
 * `not-verifiable-here` rather than asserted.
 *
 * Usage:
 *   node scripts/validate-real-extensions.cjs
 *   AXIOM_VSIX_DIR=/path/to/vsix node scripts/validate-real-extensions.cjs
 *
 * Packages are expected as `<publisher>.<name>.vsix` in AXIOM_VSIX_DIR (default
 * `<tmp>/axiom-ext/vsix`). `scripts/fetch-real-extensions.cjs` populates it from the real
 * registries.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const VSIX_DIR = process.env['AXIOM_VSIX_DIR'] ?? path.join(os.tmpdir(), 'axiom-ext', 'vsix');
const SCRATCH =
  process.env['AXIOM_TEST_USER_DATA'] ?? path.join(os.tmpdir(), 'axiom-ext', 'userData');
const WORKSPACE = process.env['AXIOM_TEST_WORKSPACE'] ?? repoRoot;
const REPORT = path.join(path.dirname(SCRATCH), 'real-extension-report.json');

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
}
if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = (loaded, filename) => loaded._compile(transpile(filename), filename);
}

/**
 * The smallest Electron that the install pipeline needs.
 *
 * Kept deliberately thin: if a service starts depending on an Electron member that is not
 * here, the harness fails loudly instead of silently testing a different code path.
 */
const electronStub = {
  app: {
    getPath: () => SCRATCH,
    getVersion: () => '0.0.0-harness',
    isPackaged: false,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
  },
  shell: { openExternal: () => Promise.resolve() },
  ipcMain: { handle: () => undefined, on: () => undefined },
  webContents: { getAllWebContents: () => [] },
  BrowserWindow: class {},
  dialog: {},
  session: { defaultSession: {} },
  net: {},
  utilityProcess: {
    fork() {
      throw new Error('The harness does not spawn extension host processes.');
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

function load(relative) {
  const filename = path.join(repoRoot, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(transpile(filename), filename);
  return loaded.exports;
}
const SRC = 'apps/desktop/src/';
const vsix = load(`${SRC}main/services/vsix.ts`);
const manifestModule = load(`${SRC}common/vscodeManifest.ts`);
const compat = load(`${SRC}common/vscodeCompat.ts`);
const hostProtocol = load(`${SRC}common/vscodeHost.ts`);
const marketplace = load(`${SRC}main/services/marketplaceExtensions.ts`);
const contributions = load(`${SRC}main/services/extensionContributions.ts`);
// Phase 5: the same pure modules the workbench itself resolves views and menus with, so this
// harness reports what AXIOM will actually draw rather than a second reading of the manifest.
const viewsModule = load(`${SRC}common/vscodeViews.ts`);
const menusModule = load(`${SRC}common/vscodeMenus.ts`);

/**
 * API members probed for inside each extension's shipped bundle.
 *
 * A bundled extension has no import graph left to walk, so the only honest signal available
 * is whether the member name appears in the emitted code. That over-reports (a name can sit
 * in dead code) but never under-reports the surface an extension may reach for, which is the
 * direction that matters when the question is "will this activate without throwing".
 */
const PROBES = [
  [
    'webview',
    ['createWebviewPanel', 'registerWebviewViewProvider', 'registerCustomEditorProvider'],
  ],
  // Split out from `webview` because Phase 4 delivers all three and each one fails differently:
  // a sidebar webview with no provider never appears, and a panel with no serializer silently
  // loses its state across a restart.
  ['webviewView', ['registerWebviewViewProvider']],
  ['webviewSerializer', ['registerWebviewPanelSerializer']],
  ['treeView', ['createTreeView', 'registerTreeDataProvider']],
  ['authentication', ['authentication.getSession', 'registerAuthenticationProvider']],
  ['secrets', ['secrets.get', 'secrets.store', 'secrets.onDidChange']],
  ['uriHandler', ['registerUriHandler', 'asExternalUri']],
  [
    'languageFeatures',
    [
      'registerCompletionItemProvider',
      'registerHoverProvider',
      'registerDefinitionProvider',
      'registerCodeActionsProvider',
      'registerDocumentFormattingEditProvider',
      'registerDocumentRangeFormattingEditProvider',
      'registerCodeLensProvider',
      'registerInlineCompletionItemProvider',
      'registerDocumentSymbolProvider',
      'registerReferenceProvider',
      'registerRenameProvider',
      'registerSignatureHelpProvider',
      'registerDocumentSemanticTokensProvider',
      'registerDocumentRangeSemanticTokensProvider',
      'registerInlayHintsProvider',
      'registerFoldingRangeProvider',
      'registerDocumentLinkProvider',
      'registerColorProvider',
      'registerDocumentColorProvider',
      'registerSelectionRangeProvider',
      'registerLinkedEditingRangeProvider',
      'registerDocumentHighlightProvider',
      'registerOnTypeFormattingEditProvider',
      'registerTypeDefinitionProvider',
      'registerImplementationProvider',
      'registerDeclarationProvider',
      'registerWorkspaceSymbolProvider',
      'registerCallHierarchyProvider',
      'registerTypeHierarchyProvider',
      'registerInlineValuesProvider',
      'setLanguageConfiguration',
      'setTextDocumentLanguage',
    ],
  ],
  // Split from `documents` because the two fail differently: an extension whose `applyEdit` is a
  // no-op looks like it worked and silently loses the user's refactor.
  ['workspaceEdit', ['applyEdit', 'WorkspaceEdit']],
  /*
   * Phase 7 §8: the four language surfaces with no Monaco provider to forward to.
   *
   * Split out of `languageFeatures` because none of them fails as a missing editor widget and each
   * fails in its own way — a workspace symbol whose resolve is never called opens the wrong file, a
   * hierarchy provider with nothing to expand in answers one level and stops, and an inline-values
   * provider with no surface drawing its labels is a debugger feature the user never sees. The members
   * stay in `languageFeatures` as well: an extension reaches both groups, the same way `applyEdit`
   * reaches `documents` and `workspaceEdit`.
   */
  ['workspaceSymbols', ['registerWorkspaceSymbolProvider', 'resolveWorkspaceSymbol']],
  [
    'callHierarchy',
    [
      'registerCallHierarchyProvider',
      'CallHierarchyItem',
      'CallHierarchyIncomingCall',
      'CallHierarchyOutgoingCall',
    ],
  ],
  ['typeHierarchy', ['registerTypeHierarchyProvider', 'TypeHierarchyItem']],
  [
    'inlineValues',
    [
      'registerInlineValuesProvider',
      'InlineValueText',
      'InlineValueVariableLookup',
      'InlineValueEvaluatableExpression',
    ],
  ],
  // Phase 7 §8: the refresh pipeline. A provider that fires one of these and is never asked again
  // leaves the user reading a stale answer, which is worse than none — and through Phase 6 nothing was
  // subscribed, so every fire went into nothing. `onDidChangeTreeData` is deliberately absent: it
  // belongs to `treeView`, which Phase 5 delivered.
  [
    'providerEvents',
    [
      'onDidChangeCodeLenses',
      'onDidChangeInlayHints',
      'onDidChangeSemanticTokens',
      'onDidChangeFoldingRanges',
      'onDidChangeInlineValues',
    ],
  ],
  // Phase 7 §1: the terminal surface an extension reaches for. `sendText` and `show` are left out
  // deliberately — they are member names half the objects in a bundle have, and a probe that matches
  // a coincidence puts an extension in a group it never touches.
  [
    'terminal',
    [
      'createTerminal',
      'registerTerminalProfileProvider',
      'onDidOpenTerminal',
      'onDidCloseTerminal',
      'onDidChangeActiveTerminal',
      'onDidChangeTerminalState',
      'activeTerminal',
    ],
  ],
  // Phase 7 §2. The three execution classes are how a provider builds a task, so an extension that
  // constructs one reaches this group whether or not it calls `executeTask` itself.
  [
    'tasks',
    [
      'registerTaskProvider',
      'tasks.executeTask',
      'onDidStartTask',
      'onDidEndTask',
      'onDidStartTaskProcess',
      'onDidEndTaskProcess',
      'ShellExecution',
      'ProcessExecution',
      'CustomExecution',
    ],
  ],
  // Phase 7 §3.
  [
    'debug',
    [
      'registerDebugAdapterDescriptorFactory',
      'startDebugging',
      'registerDebugConfigurationProvider',
      'activeDebugSession',
      'onDidStartDebugSession',
      'onDidTerminateDebugSession',
      'onDidReceiveDebugSessionCustomEvent',
      'DebugAdapterExecutable',
      'DebugAdapterServer',
    ],
  ],
  // Phase 7 §5 completes this group: a linter driven by `onDidSaveTextDocument` was reaching an
  // event Phase 6 fired, but the group did not say so, and the two close/save members are the ones
  // an extension keyed on save-to-lint depends on.
  [
    'documents',
    [
      'onDidChangeTextDocument',
      'onDidOpenTextDocument',
      'onDidSaveTextDocument',
      'onDidCloseTextDocument',
      'applyEdit',
      'openTextDocument',
    ],
  ],
  ['fileWatcher', ['createFileSystemWatcher']],
  // Phase 7 §5: the workbench file operations, which are a separate failure from the document
  // lifecycle — an extension that moves its own per-file state on a rename gets nothing at all
  // without `onDidRenameFiles`, and `workspace.fs.copy`/`rename` threw before Phase 7.
  [
    'workspaceRuntime',
    [
      'onDidCreateFiles',
      'onDidRenameFiles',
      'onDidDeleteFiles',
      'workspace.fs.copy',
      'workspace.fs.rename',
    ],
  ],
  ['statusBar', ['createStatusBarItem']],
  ['output', ['createOutputChannel', 'createLogOutputChannel']],
  ['progress', ['withProgress']],
  ['contextKeys', ['setContext']],
  ['languageClient', ['vscode-languageclient', 'LanguageClient']],
  ['notebooks', ['registerNotebookSerializer', 'notebooks.']],
  ['scm', ['scm.createSourceControl']],
  ['lm', ['lm.selectChatModels', 'chat.createChatParticipant']],
];
/**
 * Every trigger family the platform can fire, with a representative subject.
 *
 * An event is "honoured" when the real dispatcher agrees it fires for at least one of these.
 * The subject is taken from the event itself where one is declared, so `onView:cline.view`
 * is asked about its own view rather than a placeholder.
 */
const TRIGGER_KINDS = [
  'startup',
  'language',
  'command',
  'workspaceContains',
  'fileSystem',
  'view',
  'uri',
  'webviewPanel',
  'customEditor',
  'notebook',
  'debug',
  'taskType',
  'terminalProfile',
  'terminalShellIntegration',
  'terminalQuickFix',
  'authentication',
  'search',
  'editSession',
  'languageModelTool',
  'chatParticipant',
  'renderer',
];

/**
 * Whether the shim actually implements an API group, read from the shim itself.
 *
 * The group tallies below say what the installed set *reaches*; on their own they cannot tell
 * a delivered namespace from a refused one, which is exactly the thing a phase is supposed to
 * change. Each probe is a member the shim can only have if the namespace is real — a
 * `notImplemented` stub matches none of them — so this stays honest as phases land.
 */
const SHIM_PROBES = new Map([
  ['authentication', /\n  authentication: authenticationNamespace,/],
  ['secrets', /request<string \| null>\('secrets\.get'/],
  ['uriHandler', /\n  registerUriHandler: \(/],
  ['statusBar', /\n  createStatusBarItem,/],
  ['output', /\n  createOutputChannel,/],
  ['documents', /\n  openTextDocument: async \(/],
  ['progress', /\n  withProgress: async </],
  ['fileWatcher', /void request\('workspace\.createWatcher', \{/],
  // `setContext` is not a member of the shim's `commands` namespace and cannot be: upstream routes
  // it through `executeCommand`, so the honest probe is the branch that handles it there.
  ['contextKeys', /command === 'setContext'/],
  // Shorthand properties, because that is how the shim exports them.
  ['treeView', /\n {2,4}(createTreeView|registerTreeDataProvider)[,:]/],
  ['webview', /\n {2,4}createWebviewPanel[,:]/],
  ['webviewView', /\n {2,4}registerWebviewViewProvider[,:]/],
  ['webviewSerializer', /\n {2,4}registerWebviewPanelSerializer[,:]/],
  /*
   * Phase 7: the four runtimes Main owns.
   *
   * Each probe is the request the shim sends to Main, not the member name it exports, and that is the
   * whole point. Phases 1–6 shipped these four as `notImplemented` stubs that had the right member
   * names — `createTerminal`, `registerTaskProvider`, a `createFileSystemWatcher` returning three
   * emitters that never fired — so a name-shaped probe passed on a stub and reported the group as
   * delivered. (It did worse than that: the previous spellings were written against the stubs, so once
   * Phase 7 replaced them with real functions the probes stopped matching and read "not implemented"
   * for APIs that had just shipped.) A request kind only exists if there is a runtime on the other end
   * of it.
   */
  ['terminal', /void request<TerminalCreateReply>\('terminal\.create', \{/],
  ['tasks', /await request<unknown>\('tasks\.execute', \{ task: wire \}\)/],
  ['debug', /const started = await request<unknown>\('debug\.start', \{/],
  ['workspaceRuntime', /\n  onDidCreateFiles: onDidCreateFilesEmitter\.event,/],
  ['notebooks', /\n  {2,4}registerNotebookSerializer: /],
  ['scm', /\n  {2,4}createSourceControl: /],
  ['lm', /\n  {2,4}(createChatParticipant|selectChatModels): /],
  // Phase 6: the language platform. `registerLanguageProvider` is the one funnel every one of the 28
  // registrations goes through, so its presence — with the namespace actually exported — is what
  // distinguishes a delivered `languages` from the diagnostics-only namespace Phase 1 shipped.
  ['languageFeatures', /\n {2,4}registerCompletionItemProvider: \(/],
  ['workspaceEdit', /\n  applyEdit: async \(edit: unknown\): Promise<boolean> => \{/],
  /*
   * Phase 7 §8: the four surfaces answered outside Monaco, and the refresh pipeline.
   *
   * Probed by the op the worker dispatches — or, for the events, by the request it sends when a
   * provider fires — rather than by the member name it exports, for the same reason the four runtimes
   * above are: all four registrations already existed in Phase 6 and already returned a disposable, so
   * a name-shaped probe passed while the answer went nowhere. An op entry exists only if there is
   * something on the other side of it to answer.
   */
  ['workspaceSymbols', /'workspaceSymbol:resolve': \(provider, payload, token\) =>/],
  ['callHierarchy', /'callHierarchy:incoming': \(provider, payload, token\) =>/],
  ['typeHierarchy', /'typeHierarchy:supertypes': \(provider, payload, token\) =>/],
  ['inlineValues', /'inlineValue:provide': \(provider, payload, token, document\) =>/],
  ['providerEvents', /void request\('languages\.providerChanged', \{ handle \}\)/],
]);

/** Groups a completed phase promised, so a regression fails rather than shows up as a tally. */
const DELIVERED_API_GROUPS = new Set([
  'authentication',
  'secrets',
  'uriHandler',
  // Phase 4: the webview runtime. All three entry points ship together — a panel API without a
  // view provider or a serializer would leave sidebar webviews and restoration broken.
  'webview',
  'webviewView',
  'webviewSerializer',
  // Phase 5: the workbench. Tree data providers and `setContext` ship together — a contributed
  // view with no provider API is a permanently empty pane, and a tree whose `when` clauses cannot
  // be written to is one that never updates.
  'treeView',
  'contextKeys',
  // Phase 6: the language platform. The provider registrations, the document lifecycle they are
  // driven by, and `workspace.applyEdit` ship together — a rename provider whose edit cannot be
  // applied, or a linter that is never told the document changed, is a provider that does nothing.
  'languageFeatures',
  'documents',
  'workspaceEdit',
  // Phase 7: the four runtimes. They are listed together because §4 of the PRD is explicit that the
  // partial file watcher is what made Prettier, ESLint, GitLens and Python "partially compatible", and
  // the other three are the namespaces those same extensions reach for next — a terminal that cannot
  // open, a task that cannot run or a debug session that cannot start is a feature the user sees
  // missing, not a degraded one.
  'terminal',
  'tasks',
  'debug',
  'fileWatcher',
  'workspaceRuntime',
  /*
   * Phase 7 §8: the surfaces that answer outside Monaco, and the refresh pipeline that keeps every
   * provider's answer current.
   *
   * They belong in the gate rather than in the tally alone because §8 is what turns a registration
   * into an API that answers. A workspace symbol nobody resolves, a hierarchy that cannot be expanded,
   * an inline value with nothing drawing it and a provider that can never be re-asked are all calls an
   * extension makes successfully and gets nothing from — the failure mode the corpus is least able to
   * show, because a bundled extension's code cannot tell you whether the editor came back.
   */
  'workspaceSymbols',
  'callHierarchy',
  'typeHierarchy',
  'inlineValues',
  'providerEvents',
]);

const shimSource = fs.readFileSync(
  path.join(repoRoot, 'apps', 'desktop', 'src', 'main', 'extensionHostWorker.ts'),
  'utf8',
);

function shimStatus(group) {
  const probe = SHIM_PROBES.get(group);
  if (probe === undefined) return 'unclassified';
  return probe.test(shimSource) ? 'implemented' : 'not implemented';
}

function classifyActivation(events) {
  const honoured = [];
  const ignored = [];
  for (const event of events) {
    const raw = typeof event === 'string' ? event.trim() : '';
    const separator = raw.indexOf(':');
    const subject = separator < 0 ? 'x' : raw.slice(separator + 1);
    // `activationMatches` is the real dispatcher; asking it directly avoids a second,
    // drifting copy of the supported-trigger list.
    const fires = TRIGGER_KINDS.some((kind) =>
      hostProtocol.activationMatches(raw, { kind, value: subject }),
    );
    (fires ? honoured : ignored).push(event);
  }
  return { honoured, ignored };
}

/** Node's own resolution for a manifest `main` that omits the extension. */
function resolveEntry(directory, mainRelative) {
  if (typeof mainRelative !== 'string' || mainRelative.length === 0) return null;
  const base = path.join(directory, mainRelative);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

const SCAN_BUDGET_BYTES = 96 * 1024 * 1024;
const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

/**
 * Collect the extension's own JavaScript.
 *
 * The entry point alone is not enough: real extensions lazily `require` feature modules, so
 * a webview or tree-view call can sit three files away from `main`. Everything shipped in
 * the package is scanned instead, under a byte budget so a package that bundles a toolchain
 * cannot make the run unbounded.
 */
function collectScripts(directory) {
  const files = [];
  let budget = SCAN_BUDGET_BYTES;
  const walk = (current) => {
    if (budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size > budget) continue;
      budget -= size;
      files.push(full);
    }
  };
  walk(directory);
  return files;
}

function probeBundle(directory, mainRelative) {
  const entry = resolveEntry(directory, mainRelative);
  const files = collectScripts(directory);
  const hits = new Map();
  let scannedBytes = 0;
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scannedBytes += text.length;
    for (const [group, members] of PROBES) {
      for (const member of members) {
        if (!text.includes(member)) continue;
        const bucket = hits.get(group) ?? new Set();
        bucket.add(member);
        hits.set(group, bucket);
      }
    }
  }
  const used = [];
  for (const bucket of hits.values()) used.push(...bucket);
  return {
    entryResolved: entry !== null,
    scannedFiles: files.length,
    scannedBytes,
    used,
    groups: [...hits.keys()].sort(),
  };
}

/** Contribution points present in the package but not modelled by AXIOM's loader. */
function rawContributionPoints(manifestJson) {
  const contributes =
    manifestJson && typeof manifestJson === 'object' ? manifestJson.contributes : null;
  if (contributes === null || typeof contributes !== 'object') return [];
  return Object.keys(contributes).sort();
}
async function inspectOne(file) {
  const record = { file: path.basename(file), stage: 'read', errors: [] };
  const bytes = await vsix.readVsixFile(file);
  record.bytes = bytes.length;

  record.stage = 'inspect';
  const pkg = await vsix.inspectVsix(bytes);
  record.id = pkg.manifest.id;
  record.version = pkg.manifest.version;
  record.displayName = pkg.manifest.displayName;
  record.engine = pkg.manifest.engines?.vscode ?? null;
  record.main = pkg.manifest.main ?? null;
  record.activationEvents = pkg.manifest.activationEvents ?? [];

  record.stage = 'raw-manifest';
  const rawBytes = await vsix.readZipEntryBytes(bytes, 'extension/package.json');
  const rawJson = JSON.parse(rawBytes.toString('utf8'));
  record.declaredPoints = rawContributionPoints(rawJson);

  record.stage = 'compatibility';
  const report = manifestModule.reportCompatibility(
    pkg.manifest,
    manifestModule.AXIOM_VSCODE_API_VERSION,
  );
  record.engineSatisfied = report.engineSatisfied;
  record.compatSummary = report.summary;

  // Phase 5: what this package asks the workbench to draw. Kept as the contributor shape the
  // registry takes, so the merge below is the same code path the running app uses.
  record.stage = 'workbench';
  const contributed = pkg.manifest.contributes;
  record.workbench = {
    containers: contributed.viewsContainers.length,
    views: contributed.views.length,
    welcome: contributed.viewsWelcome.length,
    menus: contributed.menus.length,
    submenus: contributed.submenus.length,
  };
  record.contributor = {
    extensionId: pkg.manifest.id,
    displayName: pkg.manifest.displayName,
    directory: '',
    containers: contributed.viewsContainers,
    views: contributed.views,
    welcome: contributed.viewsWelcome,
    menus: contributed.menus,
    submenus: contributed.submenus,
  };

  record.stage = 'install';
  try {
    const outcome = await marketplace.installExtensionFromFile(file);
    record.installed = { id: outcome.id, version: outcome.version, upgraded: outcome.upgraded };
    record.stage = 'installed';
  } catch (error) {
    // A refused install is data, not a harness error: the manifest above is still the real
    // manifest, and *why* AXIOM refused a package a user could install in VS Code is
    // exactly what this run is for.
    record.installed = null;
    record.stage = 'refused';
    record.errors.push(error instanceof Error ? error.message : String(error));
  }
  return record;
}
/**
 * Where an installed package landed.
 *
 * `listInstalledExtensions` deliberately returns a renderer-facing summary with no
 * filesystem paths in it, so the harness resolves the directory the same way the install
 * layout defines it: `<userData>/extensions/<id>-<version>`.
 */
function installedDirectory(id, version) {
  const root = path.join(SCRATCH, 'extensions');
  const exact = path.join(root, `${id}-${version}`);
  if (fs.existsSync(exact)) return exact;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const match = names.find((name) => name.startsWith(`${id}-`));
  return match === undefined ? null : path.join(root, match);
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

async function main() {
  if (!fs.existsSync(VSIX_DIR)) {
    console.error(`No VSIX directory at ${VSIX_DIR}. Run scripts/fetch-real-extensions.cjs first.`);
    process.exit(2);
  }
  const files = fs
    .readdirSync(VSIX_DIR)
    .filter((name) => name.endsWith('.vsix'))
    .map((name) => path.join(VSIX_DIR, name))
    .filter((file) => fs.statSync(file).size > 0);
  if (files.length === 0) {
    console.error(`No .vsix packages in ${VSIX_DIR}.`);
    process.exit(2);
  }

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  const records = [];
  for (const file of files) {
    const started = Date.now();
    try {
      const record = await inspectOne(file);
      record.ms = Date.now() - started;
      records.push(record);
      const verdict = record.stage === 'installed' ? 'installed' : 'REFUSED  ';
      console.log(
        `${verdict}  ${pad(record.id, 30)} ${pad(record.version, 12)} ${record.ms} ms ${record.errors.join(
          '; ',
        )}`,
      );
    } catch (error) {
      const failure = {
        file: path.basename(file),
        stage: 'failed',
        errors: [error instanceof Error ? error.message : String(error)],
      };
      records.push(failure);
      console.log(`FAILED     ${pad(path.basename(file), 30)} ${failure.errors[0]}`);
    }
  }
  // --- what AXIOM makes of the installed set ------------------------------
  const installedList = await marketplace.listInstalledExtensions(WORKSPACE);
  const catalog = await contributions.buildContributionCatalog(WORKSPACE);
  const byId = new Map(installedList.map((entry) => [entry.id, entry]));

  for (const record of records) {
    if (record.id === undefined) continue;
    const entry = byId.get(record.id);
    record.discovered = entry !== undefined;
    record.directory = installedDirectory(record.id, record.version);
    record.catalog = {
      commands: catalog.commands.filter((item) => item.extensionId === record.id).length,
      invocableCommands: catalog.commands.filter(
        (item) => item.extensionId === record.id && item.invocable,
      ).length,
      keybindings: catalog.keybindings.filter((item) => item.extensionId === record.id).length,
      languages: catalog.languages.filter((item) => item.extensionId === record.id).length,
      grammars: catalog.grammars.filter((item) => item.extensionId === record.id).length,
      themes: catalog.themes.filter((item) => item.extensionId === record.id).length,
      settings: catalog.settings.filter((item) => item.extensionId === record.id).length,
    };
    record.inertPoints = catalog.inert.find((item) => item.extensionId === record.id)?.points ?? [];
    record.activation = classifyActivation(record.activationEvents);
    if (record.directory !== null) {
      const probe = probeBundle(record.directory, record.main);
      record.entryResolved = probe.entryResolved;
      record.scannedFiles = probe.scannedFiles;
      record.apiGroups = probe.groups;
      record.assessment = compat.assessExtension(probe.used);
    }
  }
  console.log('');
  console.log(
    'extension                      ver          cmds  kb  lang  activation-ignored  unmodelled-points',
  );
  for (const record of records) {
    if (record.id === undefined) continue;
    console.log(
      [
        pad(record.id, 30),
        pad(record.version, 12),
        pad(record.catalog.commands, 5),
        pad(record.catalog.keybindings, 3),
        pad(record.catalog.languages, 5),
        pad(record.activation.ignored.length, 19),
        record.inertPoints.join(','),
      ].join(' '),
    );
  }

  const blockers = new Map();
  for (const record of records) {
    for (const group of record.apiGroups ?? []) {
      blockers.set(group, (blockers.get(group) ?? 0) + 1);
    }
  }
  // --- Phase 5: the workbench the installed set actually produces -----------
  const contributors = records
    .filter((record) => record.contributor !== undefined && record.stage === 'installed')
    .map((record) => ({ ...record.contributor, directory: record.directory ?? '' }));
  const viewRegistry = viewsModule.buildViewRegistry(contributors);
  const menuRegistry = menusModule.buildMenuRegistry(
    contributors.map((entry) => ({
      extensionId: entry.extensionId,
      menus: entry.menus,
      submenus: entry.submenus,
    })),
  );
  const commandInfo = new Map(
    catalog.commands.map((item) => [
      item.command,
      { title: item.title, icon: null, enablement: item.enablement ?? null },
    ]),
  );
  for (const record of records) {
    if (record.id === undefined) continue;
    record.registered = {
      containers: viewRegistry.containers
        .filter((item) => item.extensionId === record.id)
        .map((item) => item.id),
      treeViews: viewRegistry.views
        .filter((item) => item.extensionId === record.id && item.type === 'tree')
        .map((item) => item.id),
      webviewViews: viewRegistry.views
        .filter((item) => item.extensionId === record.id && item.type === 'webview')
        .map((item) => item.id),
      intoBuiltIn: viewRegistry.views
        .filter((item) => item.extensionId === record.id && item.builtIn !== null)
        .map((item) => `${item.id}→${item.builtIn}`),
      welcome: viewRegistry.welcome.filter((item) => item.extensionId === record.id).length,
      orphanViews: viewRegistry.orphanViews
        .filter((item) => item.extensionId === record.id)
        .map((item) => item.viewId),
      unsupportedMenus: menuRegistry.unsupportedLocations
        .filter((item) => item.extensionId === record.id)
        .map((item) => `${item.location}×${item.items}`),
    };
  }
  console.log('');
  console.log('Phase 5 workbench — contributed UI as the view registry resolves it:');
  console.log(
    'extension                      containers  tree  webview  into-built-in  welcome  orphan',
  );
  for (const record of records) {
    if (record.registered === undefined) continue;
    console.log(
      [
        pad(record.id, 30),
        pad(record.registered.containers.length, 11),
        pad(record.registered.treeViews.length, 5),
        pad(record.registered.webviewViews.length, 8),
        pad(record.registered.intoBuiltIn.length, 14),
        pad(record.registered.welcome, 8),
        record.registered.orphanViews.join(','),
      ].join(' '),
    );
  }
  const drawnMenus = menusModule.contributedLocations(menuRegistry).map((location) => {
    const resolved = menusModule.resolveMenu(
      menuRegistry,
      location,
      {
        view: 'x',
        viewItem: 'x',
        resourceLangId: 'typescript',
        editorTextFocus: true,
        workspaceFolderCount: 1,
      },
      commandInfo,
    );
    const items = resolved.reduce((sum, group) => sum + group.items.length, 0);
    return `${location}: ${menuRegistry.byLocation.get(location).length} declared, ${items} resolvable`;
  });
  console.log('');
  console.log(
    'Phase 5 menus — declared vs resolvable against a representative context (no extension-owned' +
      ' context keys set, so a location gated on one resolves to nothing here):',
  );
  for (const line of drawnMenus) console.log(`  ${line}`);
  if (viewRegistry.shadowed.length > 0) {
    console.log('');
    console.log('Ids declared twice (first declaration wins):');
    for (const entry of viewRegistry.shadowed) {
      console.log(`  ${entry.kind} ${entry.id} (${entry.extensionId})`);
    }
  }
  if (menuRegistry.unsupportedLocations.length > 0) {
    console.log('');
    console.log('Menu locations contributed but not drawn by this build:');
    for (const entry of menuRegistry.unsupportedLocations) {
      console.log(`  ${entry.location} ×${entry.items} (${entry.extensionId})`);
    }
  }
  console.log('');
  console.log('API surface reached by the installed set (extension count per group):');
  for (const [group, count] of [...blockers.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(group, 20)} ${count} ${shimStatus(group)}`);
  }
  console.log('');
  console.log('Delivered API groups — the shim, probed directly (independent of the corpus):');
  for (const group of DELIVERED_API_GROUPS) {
    console.log(`  ${pad(group, 20)} ${shimStatus(group)}`);
  }
  /*
   * "A regression in any delivered API must fail validation" — every delivered group, not only the
   * ones this installed set happens to reach.
   *
   * The tally above is built from the corpus, so a group nobody in it touches was never checked. That
   * is the wrong way round for a regression gate: the corpus is a sample of real extensions, and the
   * groups it under-represents (terminals, tasks, debugging) are exactly the ones a shim could quietly
   * stop exporting between phases with nothing failing.
   */
  const regressed = [...DELIVERED_API_GROUPS].filter(
    (group) => shimStatus(group) !== 'implemented',
  );

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: Date.now(), records }, null, 2));
  console.log('');
  console.log(`report: ${REPORT}`);

  const failures = records.filter((record) => record.stage === 'failed');
  const refused = records.filter((record) => record.stage === 'refused');
  if (refused.length > 0) {
    console.error('');
    console.error('Refused by AXIOM but installable in VS Code:');
    for (const record of refused)
      console.error(`  ${record.id ?? record.file}: ${record.errors[0]}`);
  }
  if (regressed.length > 0) {
    console.error('');
    console.error('API groups a completed phase delivered but the shim no longer implements:');
    for (const group of regressed) console.error(`  ${group}`);
  }
  if (failures.length > 0 || refused.length > 0 || regressed.length > 0) {
    // `exitCode` rather than `process.exit`: the logger still holds an open handle, and
    // exiting through it aborts inside libuv on Windows.
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
