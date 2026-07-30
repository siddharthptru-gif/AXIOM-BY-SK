'use strict';

/**
 * Extension Platform validation (PRD Ch. 45–48).
 *
 * The repo has no unit-test framework, and adding one would change build tooling for a
 * change that is meant to be additive — so this follows the existing
 * `scripts/validate-*.cjs` pattern: transpile the pure `common/` modules in-process and
 * assert their contracts. Each PRD milestone appends a section here, so a regression in
 * an earlier chapter fails the same command.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const ts = require(path.join(root, 'node_modules', 'typescript'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

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

function load(relative) {
  const filename = path.join(root, relative);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(transpile(filename), filename);
  return loaded.exports;
}

const COMMON = 'apps/desktop/src/common/';

// --------------------------------------------------------------------------
// Ch. 26 LSP-2 — glob semantics
// --------------------------------------------------------------------------
function validateGlob() {
  const glob = load(`${COMMON}vscodeGlob.ts`);
  const cases = [
    ['**/*.ts', 'src/a/b/c.ts', true],
    ['src/**/*.{ts,tsx}', 'src/app/main.tsx', true],
    ['src/**/*.{ts,tsx}', 'src/app/main.js', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['*.ts', 'deep/nested/file.ts', true],
    ['src/*.ts', 'src/nested/file.ts', false],
    ['file-[0-9].ts', 'file-3.ts', true],
    ['file-[!0-9].ts', 'file-3.ts', false],
    ['?.ts', 'a.ts', true],
    ['package.json', 'apps/desktop/package.json', true],
  ];
  for (const [pattern, target, expected] of cases) {
    assert(
      glob.matchesVsCodeGlob(pattern, target) === expected,
      `glob ${pattern} vs ${target} should be ${expected}`,
    );
  }
  assert(glob.compileGlob('{unclosed') === null, 'An unclosed brace must not compile.');
  assert(glob.compileGlob('[unclosed') === null, 'An unclosed class must not compile.');
  assert(
    glob.matchesVsCodeGlob('**/*.ts', 'src\\win\\path.ts'),
    'Windows separators must normalize before matching.',
  );
  assert(
    glob.matchesRelativePattern('/repo/app', '**/*.ts', '/repo/app/src/a.ts'),
    'RelativePattern must match inside its base.',
  );
  assert(
    !glob.matchesRelativePattern('/repo/app', '**/*.ts', '/repo/other/src/a.ts'),
    'RelativePattern must not match outside its base.',
  );
}

// --------------------------------------------------------------------------
// Ch. 26 LSP-2/3/5 — selector scoring and provider merging
// --------------------------------------------------------------------------
function validateDocumentSelector() {
  const sel = load(`${COMMON}documentSelector.ts`);
  const doc = { languageId: 'typescript', scheme: 'file', path: '/repo/src/a.ts' };

  assert(sel.scoreDocumentSelector('typescript', doc) === 10, 'Exact language scores 10.');
  assert(sel.scoreDocumentSelector('*', doc) === 5, 'Wildcard string scores 5.');
  assert(sel.scoreDocumentSelector('javascript', doc) === 0, 'Other language scores 0.');
  assert(
    sel.scoreDocumentSelector({ language: 'typescript', scheme: 'file' }, doc) === 10,
    'language+scheme scores 10.',
  );
  assert(
    sel.scoreDocumentSelector({ language: 'typescript', scheme: 'untitled' }, doc) === 0,
    'A mismatched scheme rules the filter out entirely.',
  );
  assert(
    sel.scoreDocumentSelector({ language: '*', scheme: 'file' }, doc) === 10,
    'An exact clause lifts the score above the wildcard clause.',
  );
  assert(sel.scoreDocumentSelector({}, doc) === 5, 'An empty filter behaves as a wildcard.');
  assert(
    sel.scoreDocumentSelector({ pattern: '**/*.ts' }, doc) === 10,
    'A matching pattern scores 10.',
  );
  assert(
    sel.scoreDocumentSelector({ pattern: '**/*.py' }, doc) === 0,
    'A non-matching pattern scores 0.',
  );
  assert(
    sel.scoreDocumentSelector(['python', { language: 'typescript' }], doc) === 10,
    'An array selector takes its best member.',
  );
  assert(
    sel.scoreDocumentSelector({ notebookType: 'jupyter' }, doc) === 0,
    'A notebook filter must not match a plain document.',
  );

  const wildcard = { handle: 1, extensionId: 'a.a', selector: '*', sequence: 1 };
  const exact = { handle: 2, extensionId: 'b.b', selector: 'typescript', sequence: 2 };
  const other = { handle: 3, extensionId: 'c.c', selector: 'python', sequence: 3 };
  const ordered = sel.orderProviders([wildcard, exact, other], doc);
  assert(ordered.length === 2, 'Non-matching providers are dropped.');
  assert(ordered[0].provider.handle === 2, 'The more specific provider ranks first.');

  const merged = sel.selectProviders('completion', [wildcard, exact], doc);
  assert(merged.strategy === 'merge' && merged.providers.length === 2, 'Completions merge all.');
  assert(sel.mergeStrategyFor('hover') === 'stack', 'Hover stacks sections.');
  assert(sel.mergeStrategyFor('definition') === 'concat', 'Definitions concatenate.');
  assert(sel.mergeStrategyFor('unknown-feature') === 'merge', 'Unknown features default to merge.');

  const single = sel.selectProviders('formatting', [wildcard, exact], doc);
  assert(
    single.providers.length === 1 && single.providers[0].handle === 2 && !single.needsPicker,
    'Formatting uses only the highest-scored provider.',
  );
  const tie = sel.selectProviders(
    'formatting',
    [exact, { handle: 4, extensionId: 'd.d', selector: 'typescript', sequence: 4 }],
    doc,
  );
  assert(tie.needsPicker, 'Two equal-scoring formatters from different extensions need a picker.');

  const combined = sel.combineProviderResults([
    { ok: true, value: [1, 2] },
    { ok: false, error: 'boom' },
    { ok: true, value: [3] },
  ]);
  assert(
    combined.values.length === 3 && combined.failures.length === 1,
    'A failing provider is excluded without failing the request (LSP-5).',
  );
}

// --------------------------------------------------------------------------
// Ch. 41 — lazy activation index
// --------------------------------------------------------------------------
function validateActivationIndex() {
  const mod = load(`${COMMON}activationIndex.ts`);
  assert(mod.parseActivationEvent('*').kind === 'startup', '`*` is a startup event.');
  assert(
    mod.parseActivationEvent('onStartupFinished').kind === 'startup',
    'onStartupFinished is a startup event.',
  );
  assert(mod.parseActivationEvent('onLanguage:python').argument === 'python', 'Argument parsed.');
  assert(mod.parseActivationEvent('onView:myTree').kind === 'view', 'onView is recognized.');
  assert(mod.parseActivationEvent('onDebug').kind === 'debug', 'Bare onDebug is a family event.');
  assert(
    mod.parseActivationEvent('onWhatever:x').kind === 'unknown',
    'Unknown events stay unknown.',
  );
  assert(
    mod.parseActivationEvent('onLanguage:').kind === 'unknown',
    'An empty argument is invalid.',
  );

  const index = mod.buildActivationIndex([
    { extensionId: 'a.eager', activationEvents: ['*'] },
    { extensionId: 'b.py', activationEvents: ['onLanguage:python', 'onCommand:b.run'] },
    { extensionId: 'c.py', activationEvents: ['onLanguage:python'] },
    { extensionId: 'd.ws', activationEvents: ['workspaceContains:**/pom.xml'] },
    { extensionId: 'e.dbg', activationEvents: ['onDebug'] },
    { extensionId: 'f.bad', activationEvents: ['onNonsense'] },
  ]);
  assert(index.eager.length === 1 && index.eager[0] === 'a.eager', 'Only `*` is eager.');
  assert(
    mod.extensionsForTrigger(index, { kind: 'language', argument: 'python' }).length === 2,
    'Both python extensions activate on the language trigger.',
  );
  assert(
    mod.extensionsForTrigger(index, { kind: 'language', argument: 'go' }).length === 0,
    'An unrelated language activates nothing.',
  );
  assert(
    mod.extensionsForTrigger(index, { kind: 'debug', argument: 'node' })[0] === 'e.dbg',
    'A family listener fires for a specific debug trigger.',
  );
  assert(
    mod.extensionsForWorkspaceFiles(index, ['repo/module/pom.xml'])[0] === 'd.ws',
    'workspaceContains matches through a glob.',
  );
  assert(
    mod.extensionsForWorkspaceFiles(index, ['repo/build.gradle']).length === 0,
    'workspaceContains does not over-match.',
  );
  assert(index.unknown.length === 1, 'Unrecognized events are reported, not silently eager.');
  assert(
    mod.pendingActivations(['a.eager', 'b.py'], new Set(['a.eager'])).length === 1,
    'Already-activated extensions are filtered out (LA-6).',
  );

  // The firing side of the same vocabulary. Every event a real manifest can declare must
  // either fire for exactly one trigger family or be reported as unknown; an event that
  // parses as lazy but can never fire strands the extension forever.
  const host = load(`${COMMON}vscodeHost.ts`);
  const fires = (event, kind, value) =>
    host.activationMatches(event, value === undefined ? { kind } : { kind, value });
  assert(fires('*', 'startup'), '`*` fires at startup.');
  assert(!fires('*', 'view', 'x'), '`*` does not fire for a view.');
  assert(fires('onLanguage:python', 'language', 'python'), 'onLanguage fires for its language.');
  assert(!fires('onLanguage:python', 'language', 'go'), 'onLanguage ignores other languages.');
  assert(fires('onLanguage', 'language', 'go'), 'A bare onLanguage listens to every language.');
  assert(fires('onCommand:x.y', 'command', 'x.y'), 'onCommand fires for its command.');
  assert(fires('onView:cline.view', 'view', 'cline.view'), 'onView fires when its view is shown.');
  assert(fires('onUri', 'uri', 'callback'), 'A bare onUri fires for any deep link.');
  assert(fires('onOpenExternalUri:x', 'uri', 'x'), 'onOpenExternalUri shares the uri family.');
  assert(fires('onDebug', 'debug', 'python'), 'A bare onDebug fires for any debug type.');
  assert(
    fires('onDebugResolve:python', 'debug', 'python'),
    'onDebugResolve fires for its debug type.',
  );
  assert(fires('onTaskType:npm', 'taskType', 'npm'), 'onTaskType fires for its task type.');
  assert(
    fires('onAuthenticationRequest:github', 'authentication', 'github'),
    'onAuthenticationRequest fires when its provider is asked for a session.',
  );
  assert(fires('onTerminalProfile:p', 'terminalProfile', 'p'), 'onTerminalProfile fires.');
  assert(
    fires('onTerminalShellIntegration:python', 'terminalShellIntegration', 'python'),
    'onTerminalShellIntegration fires — ms-python.python declares it.',
  );
  assert(fires('onNotebook:jupyter', 'notebook', 'jupyter'), 'onNotebook fires for its type.');
  assert(
    fires('onCustomEditor:my.editor', 'customEditor', 'my.editor'),
    'onCustomEditor fires for its view type.',
  );
  assert(
    fires('onWebviewPanel:my.panel', 'webviewPanel', 'my.panel'),
    'onWebviewPanel fires when its panel is restored.',
  );
  assert(fires('onFileSystem:ftp', 'fileSystem', 'ftp'), 'onFileSystem fires for its scheme.');
  assert(fires('onSearch:ftp', 'search', 'ftp'), 'onSearch fires for its scheme.');
  assert(
    fires(
      'onLanguageModelTool:get_python_environment_details',
      'languageModelTool',
      'get_python_environment_details',
    ),
    'onLanguageModelTool fires — ms-python.python declares five of them.',
  );
  assert(
    fires('workspaceContains:**/pylock.*.toml', 'workspaceContains', 'sub/pylock.dev.toml'),
    'workspaceContains matches a found path against the declared glob.',
  );
  assert(
    fires('workspaceContains:pyproject.toml', 'workspaceContains', 'pyproject.toml'),
    'A literal workspaceContains pattern matches the file itself.',
  );
  assert(
    !fires('workspaceContains:pyproject.toml', 'workspaceContains', 'setup.py'),
    'workspaceContains does not fire for an unrelated file.',
  );
  assert(!fires('onNonsense:x', 'view', 'x'), 'An unknown event never fires.');
  assert(!fires('onView:a', 'view'), 'A specific event does not fire without a subject.');
  assert(
    host.activatesEagerly(['onLanguage:python']) === false &&
      host.activatesEagerly(['onStartupFinished']) === true,
    'Eagerness is unchanged by the wider vocabulary.',
  );
}

// --------------------------------------------------------------------------
// Ch. 42 — dependency resolution
// --------------------------------------------------------------------------
function validateDependencies() {
  const dep = load(`${COMMON}extensionDependencies.ts`);
  const catalog = new Map([
    ['a.a', { id: 'a.a', version: '1.0.0', extensionDependencies: ['b.b', 'c.c'] }],
    ['b.b', { id: 'b.b', version: '1.0.0', extensionDependencies: ['d.d'] }],
    ['c.c', { id: 'c.c', version: '1.0.0', extensionDependencies: ['d.d'] }],
    ['d.d', { id: 'd.d', version: '1.0.0' }],
  ]);
  const plan = dep.resolveInstallGraph('a.a', catalog);
  assert(plan.failures.length === 0, 'A complete graph resolves without failures.');
  assert(plan.order.length === 4, 'The diamond resolves to four unique installs.');
  assert(
    plan.order.indexOf('d.d') < plan.order.indexOf('b.b') &&
      plan.order.indexOf('b.b') < plan.order.indexOf('a.a'),
    'Dependencies install before dependents.',
  );

  const missing = dep.resolveInstallGraph('a.a', new Map([['a.a', catalog.get('a.a')]]));
  assert(
    missing.failures.some((f) => f.code === 'E_DEP_NOT_FOUND' && f.requestedBy === 'a.a'),
    'A missing dependency fails with E_DEP_NOT_FOUND naming the requester.',
  );
  const incompatible = dep.resolveInstallGraph(
    'x.x',
    new Map([['x.x', { id: 'x.x', version: null }]]),
  );
  assert(
    incompatible.failures[0].code === 'E_DEP_INCOMPATIBLE',
    'A candidate with no usable version fails with E_DEP_INCOMPATIBLE.',
  );

  const packed = dep.resolveInstallGraph(
    'p.pack',
    new Map([
      ['p.pack', { id: 'p.pack', version: '1.0.0', extensionPack: ['m.one', 'm.two'] }],
      ['m.one', { id: 'm.one', version: '1.0.0', extensionPack: ['m.three'] }],
      ['m.two', { id: 'm.two', version: '1.0.0' }],
      ['m.three', { id: 'm.three', version: '1.0.0' }],
    ]),
  );
  assert(packed.packMembers.length === 2, 'Packs expand exactly once, at the root.');
  assert(packed.versions['m.three'] === undefined, 'A nested pack is not expanded.');

  const cyclic = dep.resolveInstallGraph(
    'a.a',
    new Map([
      ['a.a', { id: 'a.a', version: '1.0.0', extensionDependencies: ['b.b'] }],
      ['b.b', { id: 'b.b', version: '1.0.0', extensionDependencies: ['a.a'] }],
    ]),
  );
  assert(cyclic.cycles.length > 0, 'A cycle is reported.');
  assert(cyclic.failures.length === 0, 'A cycle does not fail the install.');
  assert(cyclic.order.length === 2, 'Both members of a cycle still install.');

  const selfDep = dep.resolveInstallGraph(
    'a.a',
    new Map([['a.a', { id: 'a.a', version: '1.0.0', extensionDependencies: ['a.a'] }]]),
  );
  assert(selfDep.warnings.length === 1, 'A self-dependency warns and is ignored.');

  const graph = new Map([
    ['a.a', ['b.b', 'c.c']],
    ['b.b', ['d.d']],
    ['c.c', ['d.d']],
    ['d.d', []],
  ]);
  const activation = dep.activationOrder('a.a', graph);
  assert(
    activation.order[activation.order.length - 1] === 'a.a',
    'The dependent activates last (42.3).',
  );
  assert(
    activation.order.filter((id) => id === 'd.d').length === 1,
    'A shared node activates once.',
  );

  const issues = dep.diagnoseDependencies('a.a', ['b.b', 'c.c'], [{ id: 'b.b', enabled: false }]);
  assert(
    issues.some((i) => i.kind === 'disabled' && i.dependencyId === 'b.b'),
    'A disabled dependency is reported.',
  );
  assert(
    issues.some((i) => i.kind === 'missing' && i.dependencyId === 'c.c'),
    'An uninstalled dependency is reported.',
  );
  assert(
    dep.dependencyActivationError('a.a', 'b.b').code === 'ERR_DEPENDENCY_ACTIVATION_FAILED',
    'The documented error code is used.',
  );
  assert(
    dep.dependentsOf('d.d', [{ id: 'b.b', extensionDependencies: ['d.d'] }]).length === 1,
    'Uninstall warnings list dependents.',
  );
  assert(
    dep
      .removablePackMembers(
        'p.pack',
        ['m.one', 'm.two'],
        [{ id: 'other.ext', extensionDependencies: ['m.two'] }],
      )
      .join() === 'm.one',
    'Pack members still needed elsewhere are kept.',
  );
}

// --------------------------------------------------------------------------
// Ch. 43 — version compatibility
// --------------------------------------------------------------------------
function validateVersionSelect() {
  const ver = load(`${COMMON}extensionVersionSelect.ts`);
  assert(ver.isEngineCompatible('^1.90.0') === true, 'A satisfied caret range is compatible.');
  assert(ver.isEngineCompatible('^2.0.0') === false, 'A future major is incompatible.');
  assert(ver.isEngineCompatible('*') === true, '`*` is compatible.');
  assert(ver.isEngineCompatible(undefined) === false, 'A missing engine range is not compatible.');
  assert(
    ver.isEngineCompatible('not-a-range') === false,
    'An unparseable range is not compatible.',
  );
  assert(
    ver.isEngineCompatible('^1.96.0', '1.97.0-insider') === true,
    'Pre-release identifiers on the compat version are ignored.',
  );
  assert(
    ver.incompatibleMessage('^2.0.0').includes('^2.0.0'),
    'The block message names the required range.',
  );

  const candidates = [
    { version: '3.0.0', engine: '^2.0.0' },
    { version: '2.5.0', engine: '^1.90.0', preRelease: true },
    { version: '2.4.0', engine: '^1.90.0' },
    { version: '2.3.0', engine: '^1.90.0' },
    { version: '2.2.0', engine: '^1.90.0', targetPlatform: 'linux-x64' },
  ];
  const release = ver.selectVersion(candidates, { platform: 'win32-x64' });
  assert(release.picked.version === '2.4.0', 'The newest compatible release build wins.');
  const pre = ver.selectVersion(candidates, { platform: 'win32-x64', allowPreRelease: true });
  assert(pre.picked.version === '2.5.0', 'Opting into pre-release picks the pre-release build.');
  const blocked = ver.selectVersion(candidates, { platform: 'win32-x64', blocked: ['2.4.0'] });
  assert(blocked.picked.version === '2.3.0', 'A blocklisted version is skipped.');
  const platformOnly = ver.selectVersion([candidates[4]], { platform: 'win32-x64' });
  assert(platformOnly.picked === null, 'A foreign target platform is rejected.');
  const intersect = ver.selectVersion(candidates, {
    platform: 'win32-x64',
    requiredRanges: ['^2.0.0', '<2.4.0'],
  });
  assert(
    intersect.picked.version === '2.3.0',
    'Conflicting dependents resolve to the highest version satisfying both ranges.',
  );
  assert(
    ver.compatibleVersions(candidates, { platform: 'win32-x64' })[0].version === '2.5.0',
    '"Show Compatible Versions" includes pre-releases, newest first.',
  );

  assert(
    ver.classifyAxiomUpgrade('1.96.0', '1.96.1') === 'none',
    'A patch bump revalidates nothing.',
  );
  assert(
    ver.classifyAxiomUpgrade('1.95.0', '1.96.0') === 'revalidate',
    'A minor bump revalidates installed extensions.',
  );
  assert(
    ver.classifyAxiomUpgrade('1.96.0', '2.0.0') === 'full-revalidate',
    'A major bump forces a full revalidate.',
  );
  assert(ver.MAJOR_UPGRADE_PURGE.length === 3, 'A major upgrade purges three cache families.');
  assert(
    ver.decideUpdate({ version: '9.0.0', engine: '^1.90.0' }).apply,
    'A compatible update applies.',
  );
  const withheld = ver.decideUpdate({ version: '9.0.0', engine: '^3.0.0' });
  assert(
    !withheld.apply && withheld.withheldMessage.includes('newer editor'),
    'An update needing a newer editor is withheld with an explanation.',
  );

  // Target platform negotiation: the string the registry publishes builds under.
  assert(
    ver.targetPlatformFor('win32', 'x64') === 'win32-x64',
    'Windows on x64 negotiates the win32-x64 build.',
  );
  assert(
    ver.targetPlatformFor('darwin', 'arm64') === 'darwin-arm64',
    'Apple silicon negotiates the darwin-arm64 build.',
  );
  assert(
    ver.targetPlatformFor('linux', 'arm') === 'linux-armhf',
    '32-bit ARM Linux negotiates the armhf build.',
  );
  assert(
    ver.targetPlatformFor('linux', 'x64', 'musl') === 'alpine-x64',
    'A musl host negotiates the alpine build rather than the glibc one.',
  );
  assert(
    ver.targetPlatformFor('sunos', 'x64') === undefined,
    'An unrecognised host negotiates no platform-specific build at all.',
  );
  assert(
    ver.isTargetPlatform('web') && !ver.isTargetPlatform('win32-x86'),
    'Targets are a closed set.',
  );
  const perPlatform = [
    { version: '2.1.0', engine: '^1.90.0', targetPlatform: 'alpine-arm64' },
    { version: '2.1.0', engine: '^1.90.0', targetPlatform: 'win32-x64' },
    { version: '2.1.0', engine: '^1.90.0', targetPlatform: 'darwin-x64' },
  ];
  assert(
    ver.selectVersion(perPlatform, { platform: 'win32-x64' }).picked.targetPlatform === 'win32-x64',
    'One version published per target resolves to this platform, not the first listed.',
  );
  assert(
    ver.selectVersion(perPlatform, { platform: 'web' }).picked === null,
    'A platform with no published build selects nothing rather than a foreign binary.',
  );

  // The URL that addresses the negotiated build.
  const vsx = load(`${COMMON}openVsx.ts`);
  assert(
    vsx
      .extensionMetadataUrl('ns', 'name', '1.2.3', 'win32-x64')
      .endsWith('/api/ns/name/win32-x64/1.2.3'),
    'A platform-specific build is addressed by target and version.',
  );
  assert(
    vsx.extensionMetadataUrl('ns', 'name', '1.2.3', 'universal').endsWith('/api/ns/name/1.2.3'),
    '`universal` is not a path segment the registry serves.',
  );
  assert(
    vsx
      .extensionMetadataUrl('ns', 'name', undefined, 'win32-x64')
      .endsWith('/api/ns/name/win32-x64'),
    'The newest build for a platform is addressed without a version.',
  );
  assert(
    vsx.extensionMetadataUrl('ns', 'name', '1.2.3', '../../etc').endsWith('/api/ns/name/1.2.3'),
    'A target that is not a known platform never reaches the URL.',
  );
}

// --------------------------------------------------------------------------
// Ch. 29 — snippet engine
// --------------------------------------------------------------------------
function validateSnippets() {
  const parser = load(`${COMMON}snippetParser.ts`);
  const engine = load(`${COMMON}snippetEngine.ts`);
  const vars = load(`${COMMON}snippetVariables.ts`);
  const files = load(`${COMMON}snippetFiles.ts`);

  const simple = engine.expandSnippet('for (${1:i}) { $0 }');
  assert(simple.text === 'for (i) {  }', `Placeholder default inserted: ${simple.text}`);
  assert(simple.tabstops[0].index === 1 && simple.tabstops[0].value === 'i', 'Tabstop 1 recorded.');
  assert(simple.tabstops[simple.tabstops.length - 1].index === 0, '`$0` is visited last.');
  assert(simple.finalOffset === 'for (i) { '.length, 'The final cursor sits at `$0`.');

  const noFinal = engine.expandSnippet('log($1)');
  assert(noFinal.finalOffset === 'log()'.length, 'Without `$0` the cursor ends after the text.');

  const mirrored = engine.expandSnippet('<${1:div}>$2</$1>');
  assert(
    mirrored.text === '<div>2</div>' || mirrored.text === '<div></div>',
    'Mirrors reuse the value.',
  );
  assert(
    mirrored.tabstops.filter((stop) => stop.index === 1 && stop.primary).length === 1,
    'A repeated index is visited once; later occurrences are mirrors.',
  );

  const choice = engine.expandSnippet('${1|a,b,c|}');
  assert(choice.text === 'a', 'A choice inserts its first option.');
  assert(choice.tabstops[0].choices.length === 3, 'Choice options are preserved.');

  const escaped = engine.expandSnippet('cost: \\$1 \\} \\\\');
  assert(escaped.text === 'cost: $1 } \\', `Escapes are honoured: ${escaped.text}`);

  const nested = engine.expandSnippet('${1:${2:inner}}');
  assert(nested.text === 'inner', 'Nested placeholders resolve.');

  const withVar = engine.expandSnippet('${TM_FILENAME_BASE}.test.ts', {
    variables: { TM_FILENAME_BASE: 'thing' },
  });
  assert(withVar.text === 'thing.test.ts', 'Variables resolve from the context.');
  const varDefault = engine.expandSnippet('${TM_SELECTED_TEXT:fallback}', { variables: {} });
  assert(varDefault.text === 'fallback', 'An unset variable uses its default.');
  const unknownVar = engine.expandSnippet('$NOT_A_VARIABLE');
  assert(unknownVar.text === 'NOT_A_VARIABLE', 'An unknown variable inserts its own name.');

  const upcase = engine.expandSnippet('${TM_FILENAME/(.*)\\..+$/${1:/upcase}/}', {
    variables: { TM_FILENAME: 'my-file.ts' },
  });
  assert(upcase.text === 'MY-FILE', `/upcase transform: ${upcase.text}`);
  const conditional = engine.expandSnippet(
    '${TM_FILENAME/(ts)|(js)/${1:+TypeScript}${2:+JavaScript}/}',
    {
      variables: { TM_FILENAME: 'a.ts' },
    },
  );
  assert(conditional.text === 'a.TypeScript', `Conditional format: ${conditional.text}`);
  const elseBranch = engine.expandSnippet('${FOO/(x)/${1:-none}/}', { variables: { FOO: 'y' } });
  assert(elseBranch.text === '', 'A non-matching non-global transform yields the empty string.');
  const caseRun = engine.expandSnippet('${FOO/^(.)(.*)$/\\u$1\\L$2\\E!/}', {
    variables: { FOO: 'aBCD' },
  });
  assert(caseRun.text === 'Abcd!', `\\u/\\L/\\E control the case run: ${caseRun.text}`);
  const camel = engine.expandSnippet('${FOO/(.*)/${1:/pascalcase}/}', {
    variables: { FOO: 'my_thing-here' },
  });
  assert(camel.text === 'MyThingHere', `pascalcase: ${camel.text}`);
  const globalTransform = engine.expandSnippet('${FOO/,/ /g}', { variables: { FOO: 'a,b,c' } });
  assert(globalTransform.text === 'a b c', 'A global transform replaces every match.');
  const badRegex = engine.expandSnippet('${FOO/([/x/}', { variables: { FOO: 'keep' } });
  assert(badRegex.text === 'keep', 'An invalid transform regex leaves the value unchanged.');

  const broken = parser.parseSnippet('${1:unterminated');
  assert(broken.errors.length === 1, 'A malformed construct is reported (SN-10).');
  assert(
    engine.expandSnippet('${1:unterminated').text === '${1:unterminated',
    'A malformed construct degrades to literal text rather than throwing.',
  );
  assert(
    parser.snippetTabstopIndices(parser.parseSnippet('$1 ${2:a} $0').nodes).join() === '0,1,2',
    'Tabstop indices are reported ascending.',
  );

  const session = engine.createSnippetSession(engine.expandSnippet('$1 $2 $0'));
  let keys = engine.snippetContextKeys([session]);
  assert(
    keys.inSnippetMode && keys.hasNextTabstop && !keys.hasPrevTabstop,
    'Context keys drive Tab/Shift+Tab (SN-9).',
  );
  const moved = engine.moveTabstop(session, 1);
  keys = engine.snippetContextKeys([moved]);
  assert(keys.hasPrevTabstop && keys.hasNextTabstop, 'Mid-session both directions are available.');
  assert(engine.moveTabstop({ stops: [1], position: 0 }, 1) === null, 'Moving past the end exits.');
  assert(
    !engine.snippetContextKeys([]).inSnippetMode,
    'With no session the editor is not in snippet mode.',
  );

  const table = vars.resolveSnippetVariables(
    {
      filePath: 'C:/repo/app/src/thing.test.ts',
      relativePath: 'src/thing.test.ts',
      currentLine: 'const a = 1',
      lineIndex: 41,
      clipboard: 'pasted',
      comments: { lineComment: '//', blockStart: '/*', blockEnd: '*/' },
    },
    { now: new Date(2026, 6, 28, 9, 5, 3), random: () => 0.5 },
  );
  assert(table.TM_FILENAME === 'thing.test.ts', 'TM_FILENAME is the basename.');
  assert(table.TM_FILENAME_BASE === 'thing.test', 'TM_FILENAME_BASE drops only the last suffix.');
  assert(table.TM_DIRECTORY === 'C:/repo/app/src', 'TM_DIRECTORY is the parent directory.');
  assert(
    table.TM_LINE_NUMBER === '42' && table.TM_LINE_INDEX === '41',
    'Line variables are paired.',
  );
  assert(table.CURRENT_YEAR === '2026' && table.CURRENT_MONTH === '07', 'Date variables pad.');
  assert(table.CURRENT_DAY_NAME_SHORT.length === 3, 'Short day names are three characters.');
  assert(table.LINE_COMMENT === '//', 'Comment markers come from the language configuration.');
  assert(/^[0-9a-f-]{36}$/.test(table.UUID), 'UUID has the right shape.');
  assert(vars.supportedSnippetVariables().length >= 33, 'The documented variable set is complete.');

  const normalized = files.normalizeSnippetFile(
    {
      Ctor: { prefix: ['ctor', 'constructor'], body: ['constructor() {', '\t$0', '}'] },
      Scoped: { prefix: 'log', body: 'console.log($1)', scope: 'javascript,typescript' },
      Broken: { prefix: 'x' },
      NotAnObject: 'nope',
    },
    { defaultLanguage: 'typescript' },
  );
  assert(normalized.entries.length === 2, 'Malformed entries are skipped, valid ones kept.');
  assert(normalized.errors.length === 2, 'Each skipped entry is reported.');
  assert(normalized.entries[0].prefixes.length === 2, 'Prefix arrays keep every prefix.');
  assert(normalized.entries[0].body.includes('\n'), 'Array bodies join with newlines.');
  assert(
    normalized.entries[0].scopes.join() === 'typescript',
    'A scopeless entry takes the file language.',
  );
  assert(normalized.entries[1].scopes.length === 2, '`scope` is split on commas (.code-snippets).');
  assert(
    files.snippetsForLanguage(normalized.entries, 'javascript').length === 1,
    'Scope filtering selects the right entries.',
  );
  assert(
    files.orderSnippetSuggestions(['a'], ['s'], 'top').join() === 's,a',
    '`editor.snippetSuggestions: top` puts snippets first (SN-5).',
  );
  assert(
    files.orderSnippetSuggestions(['a'], ['s'], 'none').join() === 'a',
    '`none` hides snippet suggestions.',
  );
}

// --------------------------------------------------------------------------
// Ch. 25 KB-10 … KB-13 — keybinding policy and `when` clauses
// --------------------------------------------------------------------------
function validateContextKeys() {
  const ck = load(`${COMMON}contextKeyExpr.ts`);
  const evaluate = (source, context) =>
    ck.evaluateContextKey(ck.parseContextKeyExpression(source), context);
  assert(evaluate(null, {}) === true, 'A missing when clause always applies.');
  assert(evaluate('editorFocus', { editorFocus: true }) === true, 'A bare key is truthiness.');
  assert(evaluate('editorFocus', {}) === false, 'An unknown key is falsy.');
  assert(evaluate('!editorFocus', {}) === true, 'Negation works on unknown keys.');
  assert(
    evaluate('editorFocus && editorLangId == typescript', {
      editorFocus: true,
      editorLangId: 'typescript',
    }) === true,
    'Conjunction with equality.',
  );
  assert(
    evaluate('editorLangId == typescript || editorLangId == javascript', {
      editorLangId: 'javascript',
    }) === true,
    'Disjunction binds looser than conjunction.',
  );
  assert(
    evaluate('!(a && b) && c', { a: true, b: false, c: true }) === true,
    'Parentheses and negation compose.',
  );
  assert(
    evaluate('resourceFilename =~ /\\.test\\.ts$/', { resourceFilename: 'a.test.ts' }) === true,
    '`=~` evaluates a regex literal.',
  );
  assert(evaluate('view.count >= 2', { 'view.count': 3 }) === true, 'Numeric comparison.');
  assert(evaluate('view.count >= 2', { 'view.count': 1 }) === false, 'Numeric comparison, false.');
  assert(
    evaluate('lang in supported', { lang: 'go', supported: ['go', 'rust'] }) === true,
    '`in` tests membership of a context collection.',
  );
  assert(
    ck.parseContextKeyExpression('a &&') === null,
    'A truncated clause is rejected, not true.',
  );
  assert(ck.parseContextKeyExpression('a b c') === null, 'Trailing junk is rejected.');
  assert(
    ck.contextKeysUsed(ck.parseContextKeyExpression('a && b == 2')).join() === 'a,b',
    'contextKeysUsed reports every key read.',
  );
}

function validateKeybindings() {
  const kb = load(`${COMMON}extensionKeybindings.ts`);
  assert(
    kb.normalizeKeybindingChord('Shift+Ctrl+P') === 'ctrl+shift+p',
    'Modifiers are canonically ordered and lower-cased.',
  );
  assert(
    kb.normalizeKeybindingChord('cmd+k  cmd+s') === 'meta+k meta+s',
    'Chord sequences keep both parts; cmd normalizes to meta.',
  );
  assert(kb.normalizeKeybindingChord('ctrl+') === null, 'A modifier-only chord is invalid.');
  assert(kb.isReservedShortcut('Alt+F4', 'win') === true, 'KB-10 blocks Alt+F4 on Windows.');
  assert(kb.isReservedShortcut('cmd+q', 'mac') === true, 'KB-10 blocks Cmd+Q on macOS.');
  assert(kb.isReservedShortcut('ctrl+shift+p', 'win') === false, 'Ordinary chords are allowed.');

  const compiled = kb.compileExtensionKeybindings(
    [
      { extensionId: 'a.a', command: 'a.run', key: 'ctrl+alt+r' },
      { extensionId: 'a.a', command: 'a.quit', key: 'alt+f4' },
      { extensionId: 'a.a', command: 'a.bad', key: 'ctrl+b', when: 'editorFocus &&' },
      { extensionId: 'a.a', command: 'a.mac', key: '', mac: 'cmd+alt+r' },
    ],
    { platform: 'win' },
  );
  assert(compiled.rules.length === 1, 'Only the usable binding compiles.');
  const reasons = compiled.dropped.map((entry) => entry.reason).sort();
  assert(
    reasons.join() === 'invalid-when,reserved,unavailable-on-platform',
    `Each rejection is reported with a reason (got ${reasons.join()}).`,
  );
  assert(
    compiled.dropped.every((entry) => entry.message.length > 0),
    'KB-10 rejections carry a log message.',
  );
  const table = kb.compileKeybindingTable({
    platform: 'win',
    defaults: [{ command: 'editor.action.formatDocument', key: 'ctrl+shift+i' }],
    extensions: [
      { extensionId: 'fmt.fmt', extensionName: 'Fmt', command: 'fmt.format', key: 'ctrl+shift+i' },
      {
        extensionId: 'fmt.fmt',
        command: 'fmt.formatTs',
        key: 'ctrl+shift+i',
        when: 'editorLangId == typescript',
      },
    ],
    user: [{ command: 'workbench.action.showCommands', key: 'ctrl+shift+p' }],
  });
  assert(table.rules.length === 4, 'All three layers land in one table.');
  const plain = kb.resolveKeybinding(table.index, 'ctrl+shift+i', {});
  assert(plain.command === 'fmt.format', 'The later unconditional rule wins over the default.');
  assert(plain.shadowed.length === 2, 'Both losing candidates are reported (KB-13).');
  const scoped = kb.resolveKeybinding(table.index, 'ctrl+shift+i', { editorLangId: 'typescript' });
  assert(scoped.command === 'fmt.formatTs', 'A `when`-guarded later rule wins where it applies.');

  const attribution = kb.attributeKeybindings(table.rules);
  const override = attribution.find((entry) => entry.command === 'fmt.format');
  assert(
    override.extensionName === 'Fmt' && override.overridesDefault === true,
    'KB-11 attributes the override to the extension.',
  );
  const displaced = attribution.find((entry) => entry.command === 'editor.action.formatDocument');
  assert(displaced.active === false, 'The shadowed default is marked inactive.');
  const userEntry = attribution.find((entry) => entry.source === 'user');
  assert(
    userEntry.overridesDefault === true,
    'KB-11 treats a `workbench.action.*` user entry as an override.',
  );
  const chorded = kb.compileKeybindingTable({
    platform: 'win',
    defaults: [{ command: 'x.save', key: 'ctrl+k ctrl+s' }],
  });
  const pending = kb.resolveKeybinding(chorded.index, 'ctrl+k', {});
  assert(
    pending.command === null && pending.chordPending === true,
    'A chord prefix waits instead of missing.',
  );
  assert(
    kb.resolveKeybinding(chorded.index, 'ctrl+k ctrl+s', {}).command === 'x.save',
    'The full chord dispatches.',
  );

  const log = kb.troubleshootKeypress(table.index, 'ctrl+shift+i', {});
  const line = kb.formatTroubleshootEntry(log);
  assert(
    line.includes('fmt.format') && line.includes('shadowed:'),
    `KB-13 log names the binding and the shadowed candidates (got ${line}).`,
  );
  assert(
    log.shadowed.some((entry) => entry.reason === 'when-unsatisfied'),
    'A candidate blocked by its `when` says so.',
  );

  // KB-12: 2,000 entries must resolve well inside 1 ms.
  const many = [];
  for (let index = 0; index < 2_000; index += 1) {
    many.push({ command: `bulk.cmd${index}`, key: `ctrl+alt+f${index % 12} k${index % 40}` });
  }
  const bulk = kb.compileKeybindingTable({ platform: 'win', defaults: many });
  const started = process.hrtime.bigint();
  for (let index = 0; index < 200; index += 1) {
    kb.resolveKeybinding(bulk.index, 'ctrl+alt+f3 k7', {});
  }
  const perCall = Number(process.hrtime.bigint() - started) / 200 / 1e6;
  assert(perCall < 1, `KB-12 budget: ${perCall.toFixed(4)} ms per resolution exceeds 1 ms.`);
}

// --------------------------------------------------------------------------
// Phase 3 — authentication, secrets, and URI handling
// --------------------------------------------------------------------------
function validateExtensionAuth() {
  const auth = load(`${COMMON}vscodeAuth.ts`);

  // AUTH-1: provider ids are narrow enough to be safe as registry keys and activation events.
  for (const good of ['github', 'my.provider', 'copilot-auth', 'A0']) {
    assert(auth.isProviderId(good), `AUTH-1: "${good}" should be a usable provider id.`);
  }
  for (const bad of ['', '.github', 'a/b', 'a b', 'a\u0000b', 'x'.repeat(81), 42, null]) {
    assert(!auth.isProviderId(bad), `AUTH-1: ${JSON.stringify(bad)} must be refused.`);
  }

  // AUTH-2: secret keys may not carry separators or control characters, because keys are
  // namespaced per extension in one shared store.
  assert(auth.isSecretKey('token'), 'AUTH-2: a plain key should be accepted.');
  assert(auth.isSecretKey('a:b@c token'), 'AUTH-2: punctuation other than separators is fine.');
  for (const bad of ['', 'a/b', 'a\\b', 'a\nb', 'k'.repeat(auth.MAX_SECRET_KEY_CHARS + 1)]) {
    assert(!auth.isSecretKey(bad), `AUTH-2: ${JSON.stringify(bad)} must be refused.`);
  }
  assert(
    auth.secretRecordKey('Publisher.Name', 'token') === 'publisher.name token',
    'AUTH-2: the record key must fold the extension id to lower case.',
  );
  assert(
    auth.secretRecordKey('a', 'b') !== auth.secretRecordKey('a b', ''),
    'AUTH-2: two extensions must not be able to collide on one record key.',
  );

  // AUTH-3: scope normalization — order and duplicates must not force a second sign-in.
  assert(
    auth.scopeKey(['user', 'repo', 'repo']) === auth.scopeKey(['repo', 'user']),
    'AUTH-3: scope order and duplicates must not change the key.',
  );
  assert(
    auth.normalizeScopes([' repo ', '', 7, null]).join(',') === 'repo',
    'AUTH-3: blank and non-string scopes must be dropped.',
  );
  assert(
    auth.normalizeScopes(Array.from({ length: 500 }, (_, i) => `s${i}`)).length <=
      auth.MAX_AUTH_SCOPES,
    'AUTH-3: scope lists must be bounded.',
  );

  // AUTH-4: a superset satisfies a request; a subset does not.
  const wide = {
    id: 's1',
    accessToken: 't',
    account: { id: 'a', label: 'A' },
    scopes: ['repo', 'read:user'],
  };
  assert(auth.sessionSatisfies(wide, ['read:user']), 'AUTH-4: a superset must satisfy.');
  assert(auth.sessionSatisfies(wide, []), 'AUTH-4: no scopes must be satisfied by any session.');
  assert(!auth.sessionSatisfies(wide, ['admin']), 'AUTH-4: a missing scope must not satisfy.');
  assert(
    auth.selectSession([wide], ['repo']) === wide,
    'AUTH-4: selectSession must return the covering session.',
  );
  assert(
    auth.selectSession([wide], ['admin']) === null,
    'AUTH-4: selectSession must return null when nothing covers the request.',
  );

  // AUTH-5: a provider's answer is parsed with suspicion — it becomes a bearer credential.
  assert(auth.parseSession(wide) !== null, 'AUTH-5: a well formed session must parse.');
  for (const bad of [
    null,
    [],
    { id: '', accessToken: 't', account: { label: 'A' } },
    { id: 's', accessToken: '', account: { label: 'A' } },
    { id: 's', accessToken: 't', account: {} },
    { id: 's', accessToken: 'x'.repeat(auth.MAX_TOKEN_CHARS + 1), account: { label: 'A' } },
  ]) {
    assert(auth.parseSession(bad) === null, `AUTH-5: ${JSON.stringify(bad)} must be refused.`);
  }
  const filled = auth.parseSession({ id: 's', accessToken: 't', account: { label: 'Only label' } });
  assert(
    filled !== null && filled.account.id === 'Only label',
    'AUTH-5: a label-only account must still carry an id.',
  );
  assert(auth.parseSessionList('nope').length === 0, 'AUTH-5: a non-array answer yields nothing.');
  assert(
    auth.parseSessionList([wide, null, 7, wide]).length === 2,
    'AUTH-5: invalid entries must be dropped without dropping the good ones.',
  );
  assert(
    auth.parseSessionList(Array.from({ length: 100 }, () => wide)).length <= auth.MAX_AUTH_SESSIONS,
    'AUTH-5: a provider must not be able to return an unbounded session list.',
  );

  // AUTH-6: callback tokens have an entropy floor, and the loopback server serves one shape.
  const token = 'a'.repeat(43);
  assert(auth.isCallbackToken(token), 'AUTH-6: a 43-char base64url token must be accepted.');
  for (const bad of ['short', 'a'.repeat(31), 'a'.repeat(87), 'a'.repeat(42) + '/', 1]) {
    assert(!auth.isCallbackToken(bad), `AUTH-6: ${JSON.stringify(bad)} must be refused.`);
  }
  assert(
    auth.parseCallbackToken(auth.callbackPath(token)) === token,
    'AUTH-6: a minted path must round trip.',
  );
  for (const bad of [
    '/',
    '/favicon.ico',
    auth.CALLBACK_PATH_PREFIX,
    `${auth.callbackPath(token)}/x`,
  ]) {
    assert(auth.parseCallbackToken(bad) === null, `AUTH-6: "${bad}" must not be served.`);
  }
  assert(
    auth.loopbackCallbackUrl(51234, token) === `http://127.0.0.1:51234${auth.callbackPath(token)}`,
    'AUTH-6: the redirect target must be loopback only.',
  );

  // AUTH-7: the authority of an extension URI is the extension id, which is what makes a deep
  // link routable to exactly one host instead of broadcast.
  const parsed = auth.parseExtensionUri('axiom://Publisher.Name/callback?state=1#f');
  assert(parsed !== null, 'AUTH-7: a well formed extension URI must parse.');
  assert(parsed.extensionId === 'publisher.name', 'AUTH-7: the id must be folded to lower case.');
  assert(parsed.path === '/callback', 'AUTH-7: the path must survive.');
  assert(parsed.query === 'state=1', 'AUTH-7: the query must survive without its "?".');
  assert(parsed.fragment === 'f', 'AUTH-7: the fragment must survive without its "#".');
  for (const bad of ['', 'not a uri', 'https://example.com/x', 'axiom:///x', 'axiom://a b/x', 7]) {
    assert(auth.parseExtensionUri(bad) === null, `AUTH-7: ${JSON.stringify(bad)} must be refused.`);
  }
  assert(
    auth.parseExtensionUri('axiom://user:pass@ext.id/x') === null,
    'AUTH-7: credentials in the authority must be refused.',
  );
  assert(
    auth.formatExtensionUri(parsed) === 'axiom://publisher.name/callback?state=1#f',
    'AUTH-7: formatting must be the inverse of parsing.',
  );
  assert(
    auth.formatExtensionUri({ extensionId: 'a.b', path: 'x', query: '', fragment: '' }) ===
      'axiom://a.b/x',
    'AUTH-7: a relative path must be normalized.',
  );

  // AUTH-8: the provider's delivered parameters win, so a failed round trip cannot read as a
  // successful one by keeping a stale value.
  const merged = new URLSearchParams(
    auth.mergeCallbackQuery('state=mint&keep=1', 'state=real&code=c'),
  );
  assert(merged.get('state') === 'real', 'AUTH-8: delivered parameters must win.');
  assert(merged.get('code') === 'c', 'AUTH-8: the provider answer must be carried through.');
  assert(merged.get('keep') === '1', 'AUTH-8: minted parameters must survive.');
  assert(
    auth.mergeCallbackQuery('a=' + 'x'.repeat(10_000), '').length <= auth.MAX_CALLBACK_QUERY_CHARS,
    'AUTH-8: the merged query must be bounded.',
  );

  // AUTH-9: the host protocol accepts every Phase 3 request kind, and validates its payload.
  const host = load(`${COMMON}vscodeHost.ts`);
  for (const kind of [
    'authentication.getSession',
    'authentication.removeSession',
    'authentication.getAccounts',
    'authentication.registerProvider',
    'authentication.unregisterProvider',
    'authentication.sessionsChanged',
    'secrets.get',
    'secrets.store',
    'secrets.delete',
    'window.registerUriHandler',
    'env.asExternalUri',
  ]) {
    assert(host.isHostRequestKind(kind), `AUTH-9: "${kind}" must be a known request kind.`);
  }
  const session = host.validateHostRequest('authentication.getSession', {
    providerId: 'github',
    scopes: ['repo', 'repo'],
    createIfNone: true,
    silent: 'yes',
  });
  assert(session.ok === true, 'AUTH-9: a valid getSession payload must be accepted.');
  assert(session.payload.providerId === 'github', 'AUTH-9: the provider id must survive.');
  assert(session.payload.scopes.join(',') === 'repo', 'AUTH-9: scopes must arrive normalized.');
  assert(session.payload.createIfNone === true, 'AUTH-9: createIfNone must survive.');
  assert(session.payload.silent === false, 'AUTH-9: a non-boolean flag must not read as true.');
  assert(
    host.validateHostRequest('authentication.getSession', { providerId: 'a/b', scopes: [] }).ok ===
      false,
    'AUTH-9: an invalid provider id must be refused by the broker, not by the provider.',
  );
  assert(
    host.validateHostRequest('secrets.store', { key: 'token', value: 'v' }).ok === true,
    'AUTH-9: a valid secrets.store payload must be accepted.',
  );
  assert(
    host.validateHostRequest('secrets.store', { key: 'a/b', value: 'v' }).ok === false,
    'AUTH-9: a secret key with a separator must be refused.',
  );
  assert(
    host.validateHostRequest('secrets.store', {
      key: 'token',
      value: 'x'.repeat(auth.MAX_SECRET_CHARS + 10),
    }).ok === false,
    'AUTH-9: an oversized secret must be refused.',
  );
  assert(
    host.validateHostRequest('env.asExternalUri', { uri: 'axiom://a.b/cb' }).ok === true,
    'AUTH-9: a well formed asExternalUri payload must be accepted.',
  );
  assert(
    host.validateHostRequest('env.asExternalUri', { uri: 42 }).ok === false,
    'AUTH-9: a non-string URI must be refused.',
  );

  // AUTH-10: every new kind is effectful, so consent gating applies to all of them.
  for (const kind of [
    'authentication.getSession',
    'authentication.removeSession',
    'secrets.store',
    'secrets.delete',
    'env.asExternalUri',
  ]) {
    assert(
      host.EFFECTFUL_REQUEST_KINDS.includes(kind),
      `AUTH-10: "${kind}" must be treated as effectful.`,
    );
  }
}

// --------------------------------------------------------------------------
// Phase 4 — the webview runtime (PRD Ch. 49–52)
// --------------------------------------------------------------------------
function validateWebviewIdentity() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  const token = 'a'.repeat(32);
  assert(wv.isWebviewToken(token), 'WV-1: a 32-hex token must be a token.');
  assert(!wv.isWebviewToken('a'.repeat(31)), 'WV-1: a short token must be refused.');
  assert(!wv.isWebviewToken('A'.repeat(32)), 'WV-1: an uppercase token must be refused.');
  assert(wv.isWebviewHandle('b'.repeat(16)), 'WV-1: a 16-hex handle must be a handle.');
  assert(!wv.isWebviewHandle(token), 'WV-1: a token must not pass as a handle.');
  assert(
    wv.webviewOrigin(token) === `${wv.WEBVIEW_SCHEME}://${token}`,
    'WV-2: one webview, one origin.',
  );
  assert(
    wv.webviewCspSource(token) === wv.webviewOrigin(token),
    'WV-2: cspSource must be the origin an extension can actually load from.',
  );
  const document = wv.parseWebviewUrl(wv.webviewDocumentUrl(token));
  assert(
    document !== null && document.kind === 'document' && document.token === token,
    'WV-2: the document URL must parse back to its own webview.',
  );
  const resource = wv.parseWebviewUrl(wv.webviewResourceUrl(token, 'C:\\ext\\media\\logo.png'));
  assert(
    resource !== null &&
      resource.kind === 'resource' &&
      resource.fsPath === 'C:/ext/media/logo.png',
    'WV-3: asWebviewUri must round-trip a Windows path to a comparable fsPath.',
  );
  assert(
    wv.parseWebviewUrl(`${wv.WEBVIEW_SCHEME}://${token}/vscode-resource/../../secret`) === null,
    'WV-3: a traversal attempt must not resolve to a resource at all.',
  );
  assert(
    wv.parseWebviewUrl(`https://${token}/index.html`) === null,
    'WV-3: another scheme is not a webview URL.',
  );
  assert(wv.parseWebviewUrl(`${wv.WEBVIEW_SCHEME}://nope/index.html`) === null, 'WV-3: bad token.');
}

function validateWebviewContainment() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  assert(
    wv.normalizeWebviewPath('C:\\Ext\\Media\\..\\logo.png') === 'c:/Ext/logo.png',
    'WV-4: `..` must resolve before the path is ever compared to a root.',
  );
  assert(wv.normalizeWebviewPath('/ext/me\u0000dia') === null, 'WV-4: control chars are refused.');
  assert(wv.normalizeWebviewPath('media/logo.png') === null, 'WV-4: relative paths are refused.');
  assert(
    wv.normalizeWebviewPath('\\\\server\\share\\a.png') === '//server/share/a.png',
    'WV-4: a UNC root keeps both leading separators.',
  );
  const roots = wv.normalizeLocalResourceRoots(['/ext/media', '/ext/media', '/ext/dist']);
  assert(roots.length === 2, 'WV-5: duplicate roots collapse.');
  assert(
    wv.normalizeLocalResourceRoots(new Array(80).fill(0).map((_, i) => `/ext/r${i}`)).length ===
      wv.MAX_LOCAL_RESOURCE_ROOTS,
    'WV-5: the root list is bounded.',
  );
  assert(
    wv.isPathInsideRoots('/ext/media/logo.png', ['/ext/media'], false),
    'WV-6: a file under a root is inside it.',
  );
  assert(
    !wv.isPathInsideRoots('/ext/media-secrets/keys.json', ['/ext/media'], false),
    'WV-6: containment is a separator boundary, not a string prefix.',
  );
  assert(
    !wv.isPathInsideRoots('/ext/media/logo.png', [], false),
    'WV-6: no roots means no filesystem access at all.',
  );
  assert(
    wv.isPathInsideRoots('/EXT/Media/logo.png', ['/ext/media'], true) &&
      !wv.isPathInsideRoots('/EXT/Media/logo.png', ['/ext/media'], false),
    'WV-6: case sensitivity must follow the platform, not a guess.',
  );
}

function validateWebviewPolicy() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  const token = 'c'.repeat(32);
  const csp = wv.webviewDocumentCsp({
    token,
    enableScripts: true,
    enableForms: false,
    workbenchOrigin: 'axiom://workbench',
  });
  assert(csp.includes("default-src 'none'"), 'WV-7: the floor denies everything by default.');
  assert(csp.includes("base-uri 'none'"), 'WV-7: no <base> rewriting.');
  assert(csp.includes("object-src 'none'"), 'WV-7: no plugins.');
  assert(csp.includes("form-action 'none'"), 'WV-7: forms stay off unless enabled.');
  assert(
    csp.includes('frame-ancestors axiom://workbench'),
    'WV-7: only the workbench may frame a webview.',
  );
  assert(
    !/nonce-/.test(csp),
    'WV-8: the header CSP must not carry a nonce — the header is the floor, the nonce lives in the document.',
  );
  const forms = wv.webviewDocumentCsp({
    token,
    enableScripts: true,
    enableForms: true,
    workbenchOrigin: 'axiom://workbench',
  });
  assert(
    /form-action [^;]*'self'/.test(forms) &&
      forms.includes(`form-action 'self' ${wv.webviewOrigin(token)}`),
    'WV-7: enableForms opens forms, and only to the webview origin plus https.',
  );
  const scriptless = wv.webviewDocumentCsp({
    token,
    enableScripts: false,
    enableForms: false,
    workbenchOrigin: 'axiom://workbench',
  });
  assert(
    scriptless.includes("script-src 'none'"),
    'WV-7: enableScripts:false must be absolute in the header, where the document cannot undo it.',
  );
  const nonce = 'd'.repeat(32);
  assert(wv.isWebviewNonce(nonce) && !wv.isWebviewNonce('short'), 'WV-8: nonce shape is checked.');
  const patched = wv.patchCspValue("default-src 'none'; script-src 'self'", nonce);
  assert(patched.includes(`'nonce-${nonce}'`), 'WV-8: our nonce is added to the document CSP.');
  assert(
    wv.patchCspValue("script-src 'unsafe-inline'", nonce) === "script-src 'unsafe-inline'",
    'WV-8: a nonce must never be added beside `unsafe-inline` — it would kill the extension’s own inline scripts.',
  );
  const meta = wv.patchWebviewMetaCsp(
    `<meta http-equiv="Content-Security-Policy" content="script-src 'self';">`,
    nonce,
  );
  assert(meta.includes(`'nonce-${nonce}'`), 'WV-8: an extension meta CSP is patched in place.');
  assert(
    wv.patchWebviewMetaCsp('<meta http-equiv="Content-Security-Policy" content="x">', 'nope') ===
      '<meta http-equiv="Content-Security-Policy" content="x">',
    'WV-8: an invalid nonce changes nothing rather than half-patching.',
  );
  const sandbox = wv.webviewSandboxAttribute({ enableScripts: true, enableForms: true });
  assert(
    sandbox.includes('allow-same-origin'),
    'WV-9: same-origin is what makes origin checkable.',
  );
  assert(sandbox.includes('allow-scripts') && sandbox.includes('allow-forms'), 'WV-9: opt-ins.');
  for (const banned of [
    'allow-top-navigation',
    'allow-popups',
    'allow-modals',
    'allow-downloads',
  ]) {
    assert(!sandbox.includes(banned), `WV-9: a webview must never get ${banned}.`);
  }
  assert(
    !wv
      .webviewSandboxAttribute({ enableScripts: false, enableForms: false })
      .includes('allow-scripts'),
    'WV-9: a scriptless webview gets no script permission.',
  );
}

function validateWebviewHtml() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  const token = 'e'.repeat(32);
  const handle = 'f'.repeat(16);
  const nonce = '1'.repeat(32);
  const options = {
    token,
    handle,
    nonce,
    workbenchOrigin: 'axiom://workbench',
    themeKind: 'dark',
    themeVariables: wv.sanitizeWebviewThemeVariables({
      '--vscode-editor-background': '#1e1e1e',
      '--vscode-bad': 'red; } body { display: none',
      'not-a-variable': '#fff',
    }),
    codiconFontUrl: null,
    state: { scroll: 12 },
    enableCommandUris: false,
  };
  const themed = options.themeVariables;
  assert(themed['--vscode-editor-background'] === '#1e1e1e', 'WV-10: a colour survives.');
  assert(
    themed['--vscode-bad'] === undefined && themed['not-a-variable'] === undefined,
    'WV-10: a value that could close the declaration block, or a name that is not a variable, is dropped.',
  );
  const html = wv.rewriteWebviewHtml(
    '<html><head><script src="vscode-resource:/ext/media/main.js"></script></head><body class="app"><p>hi</p></body></html>',
    options,
  );
  assert(
    html.indexOf('acquireVsCodeApi') < html.indexOf('main.js'),
    'WV-11: the API must exist before the extension’s first script runs.',
  );
  assert(
    html.includes(`${wv.webviewOrigin(token)}${wv.WEBVIEW_RESOURCE_PREFIX}ext/media/main.js`),
    'WV-12: a legacy vscode-resource: URL is translated onto this webview’s origin.',
  );
  assert(
    html.includes(`<script nonce="${nonce}" data-axiom-webview="bootstrap">`),
    'WV-11: the bootstrap carries our nonce, so a tight extension CSP still admits it.',
  );
  assert(
    html.includes('class="app vscode-dark"'),
    'WV-13: the body class extensions style against.',
  );
  for (const forbidden of ['require(', 'process.', 'nodeIntegration', 'electron']) {
    assert(
      !html.includes(forbidden),
      `WV-14: nothing AXIOM injects may hand the frame ${forbidden} — a webview is ordinary web content.`,
    );
  }
  assert(
    html.includes('"axiom://workbench"') && !html.includes("postMessage(msg, '*')"),
    'WV-14: the frame posts to the workbench origin, never to `*`.',
  );
  const fragment = wv.rewriteWebviewHtml('<div id="root"></div>', options);
  assert(
    fragment.includes('acquireVsCodeApi') && fragment.endsWith('<div id="root"></div>'),
    'WV-11: a bare fragment still gets the API, and keeps its own markup last.',
  );
  const replaced = wv.rewriteWebviewHtml('<body class="vscode-light other">x</body>', {
    ...options,
    themeKind: 'high-contrast',
  });
  assert(
    replaced.includes('class="other vscode-high-contrast"'),
    'WV-13: a stale theme class is replaced, not accumulated.',
  );
}

function validateWebviewMessaging() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  const handle = 'a1b2c3d4e5f60718';
  const ok = wv.parseWebviewFrameMessage(
    { axiomWebview: handle, kind: 'message', payload: { hello: 1 } },
    handle,
  );
  assert(ok !== null && ok.kind === 'message', 'WV-15: a well-formed frame message is accepted.');
  assert(
    wv.parseWebviewFrameMessage({ axiomWebview: 'b'.repeat(16), kind: 'ready' }, handle) === null,
    'WV-15: a message naming another webview’s handle is not this webview’s message.',
  );
  assert(
    wv.parseWebviewFrameMessage({ axiomWebview: handle, kind: 'evaluate' }, handle) === null,
    'WV-15: the kind list is closed.',
  );
  assert(
    wv.parseWebviewFrameMessage('ready', handle) === null &&
      wv.parseWebviewFrameMessage([{ axiomWebview: handle, kind: 'ready' }], handle) === null,
    'WV-15: only an object envelope is a message.',
  );
  assert(
    wv.parseWebviewFrameMessage(
      { axiomWebview: handle, kind: 'state', state: 'x'.repeat(wv.MAX_WEBVIEW_STATE_CHARS + 1) },
      handle,
    ) === null,
    'WV-16: state is bounded — the frame cannot grow the workbench’s memory without limit.',
  );
  assert(
    wv.parseWebviewFrameMessage(
      {
        axiomWebview: handle,
        kind: 'message',
        payload: { big: 'y'.repeat(wv.MAX_WEBVIEW_MESSAGE_CHARS) },
      },
      handle,
    ) === null,
    'WV-16: an oversized payload is refused rather than forwarded.',
  );
  assert(
    wv.parseWebviewFrameMessage(
      { axiomWebview: handle, kind: 'command', href: 'command:ab' },
      handle,
    ) === null,
    'WV-16: control characters never reach command handling.',
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert(
    wv.normalizeWebviewMessagePayload(cyclic) === null,
    'WV-17: an unserializable extension payload resolves postMessage to false instead of throwing.',
  );
  const copy = wv.normalizeWebviewMessagePayload({ a: [1, 2] });
  assert(copy !== null && copy.payload.a[1] === 2, 'WV-17: a normal payload survives the copy.');
  const envelope = wv.webviewHostEnvelope(handle, { kind: 'message', payload: 1 });
  assert(
    envelope.axiomWebview === handle && envelope.kind === 'message',
    'WV-17: host→frame messages are stamped so the bootstrap can reject a stray one.',
  );
  const uri = wv.parseWebviewCommandUri('command:axiom.doThing?%5B1%2C%22two%22%5D');
  assert(
    uri !== null && uri.command === 'axiom.doThing' && uri.args.length === 2,
    'WV-18: a command URI parses to a command and its JSON arguments.',
  );
  assert(
    wv.parseWebviewCommandUri('https://example.com') === null &&
      wv.parseWebviewCommandUri('command:../../etc') === null,
    'WV-18: only a well-named command: URI parses.',
  );
  assert(
    wv.parseWebviewCommandUri('command:a?not-json') === null,
    'WV-18: unparseable arguments fail the whole link rather than running it bare.',
  );
  assert(
    !wv.isCommandUriAllowed('axiom.doThing', false) &&
      wv.isCommandUriAllowed('axiom.doThing', true) &&
      wv.isCommandUriAllowed('axiom.doThing', ['axiom.doThing']) &&
      !wv.isCommandUriAllowed('axiom.other', ['axiom.doThing']),
    'WV-19: enableCommandUris gates by value, and an array is an allow-list.',
  );
}

function validateWebviewOptions() {
  const wv = load(`${COMMON}vscodeWebview.ts`);
  const scripted = wv.sanitizeWebviewOptions({ enableScripts: true });
  assert(
    scripted.enableForms === true,
    'WV-20: enableForms defaults to enableScripts, as upstream does.',
  );
  assert(
    wv.sanitizeWebviewOptions({ enableScripts: true, enableForms: false }).enableForms === false,
    'WV-20: an explicit false still wins.',
  );
  assert(
    wv.sanitizeWebviewOptions(undefined).enableScripts === false,
    'WV-20: a webview with no options runs no scripts.',
  );
  assert(
    wv.sanitizeWebviewOptions({}).localResourceRoots === null &&
      Array.isArray(wv.sanitizeWebviewOptions({ localResourceRoots: [] }).localResourceRoots),
    'WV-21: "said nothing" and "said no roots" must stay distinguishable, because they mean different things.',
  );
  assert(
    wv.sanitizeWebviewOptions({ enableCommandUris: ['a.b', 5] }).enableCommandUris.length === 1,
    'WV-21: an allow-list keeps only command names.',
  );
  const panel = wv.sanitizeWebviewPanelOptions({ retainContextWhenHidden: 'yes' });
  assert(
    panel.retainContextWhenHidden === false,
    'WV-22: retainContextWhenHidden costs memory, so only a literal true buys it.',
  );
  assert(wv.sanitizeWebviewTitle('  a\u0000b  ') === 'a b', 'WV-22: a title is trimmed.');
  assert(
    wv.sanitizeWebviewTitle('x'.repeat(500)).length === wv.MAX_WEBVIEW_TITLE_CHARS,
    'WV-22: a title is bounded.',
  );
  assert(
    wv.sanitizeViewColumn(2) === 2 &&
      wv.sanitizeViewColumn(-1) === -1 &&
      wv.sanitizeViewColumn(99) === -1 &&
      wv.sanitizeViewColumn('two') === -1,
    'WV-22: a view column outside the range collapses to the active group.',
  );
  const persisted = wv.parsePersistedWebviewPanels({
    version: 1,
    panels: [
      { extensionId: 'pub.ext', viewType: 'ext.panel', title: 'One', state: '{}', viewColumn: 1 },
      { extensionId: 'pub.ext', viewType: '', title: 'Broken' },
      {
        extensionId: 'pub.ext',
        viewType: 'ext.two',
        state: 'x'.repeat(wv.MAX_WEBVIEW_STATE_CHARS + 1),
      },
    ],
  });
  assert(
    persisted.length === 1 && persisted[0].viewType === 'ext.panel',
    'WV-23: one bad persisted entry costs one panel, not the whole restore.',
  );
  assert(
    wv.parsePersistedWebviewPanels({ version: 2, panels: [] }).length === 0,
    'WV-23: version gate.',
  );
  assert(
    wv.parsePersistedWebviewPanels({
      version: 1,
      panels: new Array(60).fill({ extensionId: 'pub.ext', viewType: 'ext.panel', state: null }),
    }).length === wv.MAX_PERSISTED_PANELS,
    'WV-23: the restore list is capped.',
  );
  const file = wv.serializePersistedWebviewPanels(persisted);
  assert(
    file.version === 1 && wv.parsePersistedWebviewPanels(file).length === 1,
    'WV-23: persistence round-trips through its own validator.',
  );
  const cache = new Map();
  for (let index = 0; index < 6; index += 1) cache.set(`k${index}`, index);
  wv.trimResourceCache(cache, 4);
  assert(
    cache.size === 4 && !cache.has('k0') && cache.has('k5'),
    'WV-24: the resource cache evicts oldest-first and stays bounded.',
  );
  assert(
    wv.webviewResourceCacheKey('a'.repeat(32), '/x') !==
      wv.webviewResourceCacheKey('b'.repeat(32), '/x'),
    'WV-24: an authorization decision is scoped to the webview that earned it.',
  );
}

function validateWebviewRequests() {
  const host = load(`${COMMON}vscodeHost.ts`);
  const kinds = host.HOST_REQUEST_KINDS.filter((kind) => kind.startsWith('webview.'));
  assert(kinds.length === 12, 'WV-25: all twelve webview requests are declared capabilities.');
  const handle = '0123456789abcdef';
  const token = 'f'.repeat(32);
  for (const kind of kinds) {
    assert(
      host.validateHostRequest(kind, {}).ok === false,
      `WV-25: ${kind} must refuse an empty payload rather than act on a guess.`,
    );
  }
  const created = host.validateHostRequest('webview.create', {
    viewType: 'ext.panel',
    handle,
    token,
    title: 'Panel',
    viewColumn: 1,
    options: { enableScripts: true },
  });
  assert(
    created.ok && created.payload.handle === handle && created.payload.token === token,
    'WV-26: the identity the host minted is carried through, so asWebviewUri can be synchronous.',
  );
  assert(
    created.ok &&
      created.payload.options.enableForms === true &&
      created.payload.surface === 'panel',
    'WV-26: options are sanitized once, at the boundary.',
  );
  assert(
    host.validateHostRequest('webview.create', { viewType: 'ext.panel', handle, token: 'short' })
      .ok === false,
    'WV-26: a malformed token is refused — the token is an origin, not a label.',
  );
  assert(
    host.validateHostRequest('webview.create', { viewType: 'ext.panel', handle: 'zz', token })
      .ok === false,
    'WV-26: a malformed handle is refused.',
  );
  assert(
    host.validateHostRequest('webview.setHtml', {
      handle,
      html: 'x'.repeat(4 * 1024 * 1024 + 1),
    }).ok === false,
    'WV-27: one document cannot exceed the HTML budget.',
  );
  assert(
    host.validateHostRequest('webview.setHtml', { handle, html: '<b>hi</b>' }).ok,
    'WV-27: ordinary HTML passes.',
  );
  const badge = host.validateHostRequest('webview.setBadge', { handle, value: 1e9 });
  assert(badge.ok && badge.payload.value === 9999, 'WV-28: a badge value is clamped.');
  assert(
    host.validateHostRequest('webview.setBadge', { handle, value: 'lots' }).payload.value === null,
    'WV-28: a non-numeric badge clears it.',
  );
  const post = host.validateHostRequest('webview.postMessage', { handle, payload: { a: 1 } });
  assert(post.ok && post.payload.payload.a === 1, 'WV-29: postMessage payloads are re-parsed.');
  assert(
    host.validateHostRequest('webview.registerViewProvider', { viewType: 'ext.view' }).ok &&
      host.validateHostRequest('webview.registerSerializer', { viewType: 'bad type!' }).ok ===
        false,
    'WV-30: provider and serializer registration is gated on a real view type.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §1, §2 — view containers and the view registry
// --------------------------------------------------------------------------
/** One contributor, with every list defaulted, so a case states only what it exercises. */
function contributor(overrides) {
  return {
    extensionId: 'pub.ext',
    displayName: 'Ext',
    directory: '/ext',
    containers: [],
    views: [],
    welcome: [],
    menus: [],
    submenus: [],
    ...overrides,
  };
}

function validateViewRegistry() {
  const views = load(`${COMMON}vscodeViews.ts`);
  const registry = views.buildViewRegistry([
    contributor({
      extensionId: 'eamodio.gitlens',
      displayName: 'GitLens',
      containers: [
        { id: 'gitlens', title: 'GitLens', icon: 'images/gitlens.svg', location: 'activitybar' },
      ],
      views: [
        { id: 'gitlens.views.commits', container: 'gitlens', name: 'Commits', type: 'tree' },
        {
          id: 'gitlens.views.fileHistory',
          container: 'gitlens',
          name: 'File History',
          type: 'tree',
          when: 'gitlens:enabled',
        },
        { id: 'gitlens.views.scm', container: 'scm', name: 'Inline', type: 'tree' },
        { id: 'gitlens.views.nowhere', container: 'someoneElse', name: 'Orphan', type: 'tree' },
      ],
    }),
    contributor({
      extensionId: 'ms-azuretools.vscode-docker',
      displayName: 'Docker',
      containers: [
        {
          id: 'dockerView',
          title: 'Docker',
          icon: 'resources/docker.png',
          location: 'activitybar',
        },
        { id: 'gitlens', title: 'Impostor', icon: null, location: 'activitybar' },
      ],
      views: [
        { id: 'dockerContainers', container: 'dockerView', name: 'Containers', type: 'tree' },
        {
          id: 'dockerHelp',
          container: 'dockerView',
          name: 'Help',
          type: 'webview',
          visibility: 'collapsed',
        },
        { id: 'gitlens.views.commits', container: 'dockerView', name: 'Stolen', type: 'tree' },
      ],
    }),
  ]);

  assert(registry.containers.length === 2, 'V-1: each contributed container is registered once.');
  assert(registry.containers[0].id === 'gitlens', 'V-2: containers keep declaration order.');
  assert(
    registry.containers[0].order === 0 && registry.containers[1].order === 1,
    'V-3: order is the index drawn.',
  );
  assert(
    registry.containers[0].extensionName === 'GitLens',
    'V-4: a container carries its owner name for the tooltip.',
  );
  assert(
    registry.shadowed.some((entry) => entry.kind === 'container' && entry.id === 'gitlens'),
    'V-5: a second claim on a container id is shadowed, not accepted.',
  );
  assert(
    registry.shadowed.some(
      (entry) => entry.kind === 'view' && entry.id === 'gitlens.views.commits',
    ),
    'V-6: a duplicate view id is shadowed too.',
  );
  assert(
    registry.orphanViews.length === 1 && registry.orphanViews[0].container === 'someoneElse',
    'V-7: a view naming no known container is reported, not dropped silently.',
  );
  assert(
    registry.views.find((view) => view.id === 'gitlens.views.scm').builtIn === 'scm',
    'V-8: a view in an upstream built-in container maps onto AXIOM’s own sidebar.',
  );
  assert(
    views.builtInContainerFor('debug') === 'run',
    'V-9: upstream’s `debug` container is AXIOM’s Run view.',
  );
  assert(
    views.builtInContainerFor('explorer') === 'explorer',
    'V-10: `explorer` maps to the Explorer.',
  );
  assert(
    views.builtInContainerFor('gitlens') === null,
    'V-11: a contributed id is not a built-in.',
  );
  assert(
    views.builtInContainerFor('__proto__') === null,
    'V-12: the built-in map cannot be walked into Object.prototype.',
  );

  const all = { 'gitlens:enabled': true };
  assert(
    views.visibleViewsOf(registry, 'gitlens', all).length === 2,
    'V-13: a container’s views are listed in declaration order when their clauses pass.',
  );
  assert(
    views.visibleViewsOf(registry, 'gitlens', {}).length === 1,
    'V-14: a view whose `when` fails is not in the container.',
  );
  assert(
    views.activityBarContainers(registry, {}).length === 2,
    'V-15: a container with at least one visible view appears on the activity bar.',
  );
  assert(
    views.panelContainers(registry, {}).length === 0,
    'V-16: an activity-bar container is not drawn in the panel.',
  );
  assert(
    views.builtInViewsOf(registry, 'scm', {}).length === 1,
    'V-17: AXIOM’s Source Control sidebar is handed the view contributed into it.',
  );
  assert(
    views.builtInViewsOf(registry, 'explorer', {}).length === 0,
    'V-18: a sidebar nobody contributed to gets nothing.',
  );
  assert(
    registry.views.find((view) => view.id === 'dockerHelp').type === 'webview',
    'V-19: a webview-backed view keeps its type so the renderer can host it properly.',
  );
  assert(
    registry.views.find((view) => view.id === 'dockerHelp').visibility === 'collapsed',
    'V-20: declared visibility survives into the registry.',
  );

  const hiddenOnly = views.buildViewRegistry([
    contributor({
      containers: [{ id: 'c1', title: 'C', icon: null, location: 'activitybar' }],
      views: [{ id: 'v1', container: 'c1', name: 'V', type: 'tree', when: 'signedIn' }],
    }),
  ]);
  assert(
    views.activityBarContainers(hiddenOnly, {}).length === 0,
    'V-21: a container whose every view is gated off is hidden entirely, as upstream hides it.',
  );
  assert(
    views.activityBarContainers(hiddenOnly, { signedIn: true }).length === 1,
    'V-22: the same container appears once the gating key flips — sign-in reveals it.',
  );

  const many = views.buildViewRegistry([
    contributor({
      containers: Array.from({ length: views.MAX_VIEW_CONTAINERS + 5 }, (_unused, index) => ({
        id: `c${index}`,
        title: `C${index}`,
        icon: null,
        location: 'panel',
      })),
    }),
  ]);
  assert(
    many.containers.length === views.MAX_VIEW_CONTAINERS,
    'V-23: the container count is capped so a manifest cannot grow the activity bar without bound.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §8 — view welcome content
// --------------------------------------------------------------------------
function validateViewWelcome() {
  const views = load(`${COMMON}vscodeViews.ts`);
  const blocks = views.parseWelcomeContents(
    'Sign in to see your pull requests.\n[Sign in](command:github.pr.signin)\nOr read the [docs](https://aka.ms/pr).',
  );
  assert(blocks.length === 3, 'W-1: each non-empty line is one block.');
  assert(blocks[0].kind === 'text', 'W-2: prose stays text.');
  assert(
    blocks[1].kind === 'button' && blocks[1].command === 'github.pr.signin',
    'W-3: a link alone on its line is a button.',
  );
  assert(blocks[1].label === 'Sign in', 'W-4: the button keeps the extension’s label.');
  assert(
    blocks[2].kind === 'text' && blocks[2].spans.length === 3,
    'W-5: an inline link splits the line into spans.',
  );
  assert(
    blocks[2].spans[1].kind === 'link' && blocks[2].spans[1].href === 'https://aka.ms/pr',
    'W-6: an https link is clickable.',
  );
  assert(
    views.parseWelcomeContents('[Run](command:a b)')[0].kind === 'text',
    'W-7: a command id with a space is not a command — the line stays text.',
  );
  assert(
    views.parseWelcomeContents('[Go](javascript:alert(1))')[0].kind === 'text',
    'W-8: a `javascript:` target is never made clickable.',
  );
  assert(
    views.parseWelcomeContents('[Open](file:///etc/passwd)')[0].kind === 'text',
    'W-9: a `file:` target is never made clickable.',
  );
  assert(
    views.parseWelcomeContents('[Open](http://plain.example)')[0].kind === 'text',
    'W-10: plain http is not accepted either.',
  );
  const query = views.parseWelcomeContents('[Go](command:ext.do?%5B1%5D)')[0];
  assert(
    query.kind === 'button' && query.command === 'ext.do',
    'W-11: a command’s query string is dropped, not executed.',
  );
  assert(
    views.parseWelcomeContents('x\n'.repeat(200)).length === views.MAX_WELCOME_BLOCKS,
    'W-12: the block count is bounded.',
  );

  const registry = views.buildViewRegistry([
    contributor({
      containers: [{ id: 'c', title: 'C', icon: null, location: 'activitybar' }],
      views: [{ id: 'v', container: 'c', name: 'V', type: 'tree' }],
      welcome: [
        { view: 'v', contents: 'second', when: null, group: 'b' },
        { view: 'v', contents: 'first', when: null, group: 'a' },
        { view: 'v', contents: 'hidden', when: 'never' },
        { view: 'v', contents: 'loading', when: null, group: 'c', enablement: 'ready' },
        { view: 'other', contents: 'elsewhere', when: null },
      ],
    }),
  ]);
  const resolved = views.resolveWelcome(registry, 'v', {});
  assert(resolved.length === 3, 'W-13: only entries for this view whose `when` passes are shown.');
  assert(resolved[0].blocks[0].spans[0].text === 'first', 'W-14: entries sort by group.');
  assert(
    resolved[2].enabled === false,
    'W-15: `enablement` renders a visible but disabled button.',
  );
  assert(
    views.resolveWelcome(registry, 'v', { ready: true })[2].enabled === true,
    'W-16: the same entry becomes enabled when its clause passes.',
  );
  assert(
    views.resolveWelcome(registry, 'missing', {}).length === 0,
    'W-17: an unknown view has no welcome content.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §9 — persisted workbench state
// --------------------------------------------------------------------------
function validateViewPersistence() {
  const views = load(`${COMMON}vscodeViews.ts`);
  const empty = views.emptyWorkbenchState();
  assert(
    empty.version === 1 && empty.activeContainer === null,
    'P-1: an empty state restores AXIOM’s own sidebar.',
  );
  assert(
    views.parseWorkbenchState(null).activeContainer === null,
    'P-2: a missing file parses to the empty state.',
  );
  assert(views.parseWorkbenchState('nonsense').version === 1, 'P-3: a corrupt file never throws.');
  assert(
    views.parseWorkbenchState([1, 2]).views !== undefined,
    'P-4: an array is not a state object.',
  );

  const parsed = views.parseWorkbenchState({
    version: 1,
    activeContainer: 'gitlens',
    hiddenContainers: ['dockerView', 42],
    views: {
      'gitlens.views.commits': {
        collapsed: true,
        expanded: ['#a', '#b', 7],
        selected: ['#a'],
        scrollTop: 128.6,
        size: 10,
      },
      '': { collapsed: true },
      bad: 'not an object',
    },
  });
  assert(parsed.activeContainer === 'gitlens', 'P-5: the last active container round-trips.');
  assert(parsed.hiddenContainers.length === 1, 'P-6: a non-string hidden container is dropped.');
  const state = parsed.views['gitlens.views.commits'];
  assert(state.collapsed === true, 'P-7: a collapsed pane stays collapsed across restarts.');
  assert(state.expanded.length === 2, 'P-8: expanded node ids are kept, non-strings dropped.');
  assert(state.selected[0] === '#a', 'P-9: selection is persisted.');
  assert(state.scrollTop === 129, 'P-10: scroll position is rounded, never fractional.');
  assert(
    state.size === views.VIEW_SIZE_MIN,
    'P-11: a view size below the floor is clamped, not honoured.',
  );
  assert(parsed.views[''] === undefined, 'P-12: an empty view id is refused.');
  assert(parsed.views.bad === undefined, 'P-13: a non-object view entry is refused.');
  assert(
    views.parseWorkbenchState({ views: { v: { size: 1e9 } } }).views.v.size === views.VIEW_SIZE_MAX,
    'P-14: an absurd size is clamped to the ceiling.',
  );
  assert(
    views.parseWorkbenchState({
      views: { v: { expanded: Array.from({ length: 5_000 }, (_u, i) => `#${i}`) } },
    }).views.v.expanded.length === views.MAX_PERSISTED_EXPANDED,
    'P-15: the expanded list is bounded so a huge tree cannot grow the state file without limit.',
  );
  const pruned = views.pruneWorkbenchState(parsed, new Set(['gitlens.views.commits']));
  assert(
    Object.keys(pruned.views).length === 1,
    'P-16: state for an uninstalled view is pruned before writing.',
  );
  assert(pruned.activeContainer === 'gitlens', 'P-17: pruning keeps the rest of the state.');
  assert(views.emptyViewState().scrollTop === 0, 'P-18: a fresh view starts at the top, expanded.');
}

// --------------------------------------------------------------------------
// Phase 5 §4 — TreeItem normalisation
// --------------------------------------------------------------------------
function validateTreeItems() {
  const tree = load(`${COMMON}vscodeTree.ts`);
  const plain = tree.normalizeTreeItem({ label: 'README.md', collapsibleState: 0 }, '/0');
  assert(
    plain.label === 'README.md' && plain.handle === '/0',
    'T-1: a string label and its handle survive.',
  );
  assert(plain.collapsibleState === 'none', 'T-2: `TreeItemCollapsibleState.None` is a leaf.');
  assert(
    tree.normalizeTreeItem({ collapsibleState: 1 }, '/0').collapsibleState === 'collapsed' &&
      tree.normalizeTreeItem({ collapsibleState: 2 }, '/0').collapsibleState === 'expanded',
    'T-3: the numeric collapsible enum maps onto the wire values.',
  );
  const labelled = tree.normalizeTreeItem(
    { label: { label: 'index.ts', highlights: [[0, 5], [99, 100], 'junk'] } },
    '/1',
  );
  assert(labelled.label === 'index.ts', 'T-4: `TreeItemLabel` is accepted as well as a string.');
  assert(labelled.highlights.length === 1, 'T-5: a highlight range outside the label is dropped.');
  assert(
    tree.normalizeTreeItem({ label: 'x'.repeat(9_000) }, '/2').label.length ===
      tree.MAX_TREE_LABEL_CHARS,
    'T-6: a runaway label is clamped.',
  );
  assert(
    tree.normalizeTreeItem({ label: '<script>alert(1)</script>' }, '/3').label ===
      '<script>alert(1)</script>',
    'T-7: markup in a label stays literal text — it is never treated as markup.',
  );
  assert(
    tree.normalizeTreeItem({ resourceUri: 'file:///repo/a.ts' }, '/4').label ===
      'file:///repo/a.ts',
    'T-8: an item with only a `resourceUri` still draws, as upstream draws it.',
  );
  assert(
    tree.normalizeTreeItem({ description: true }, '/5').description === '',
    'T-9: `description: true` is upstream’s "derive it".',
  );
  assert(
    tree.normalizeTreeItem({ description: 'main' }, '/5').description === 'main',
    'T-10: a description string is kept.',
  );
  const markdown = tree.normalizeTreeItem({ tooltip: { value: '**bold**' } }, '/6');
  assert(
    markdown.tooltip === '**bold**' && markdown.tooltipIsMarkdown === true,
    'T-11: a MarkdownString tooltip is flagged as markdown.',
  );
  assert(
    tree.normalizeTreeItem({ tooltip: 'plain' }, '/6').tooltipIsMarkdown === false,
    'T-12: a string tooltip is not markdown.',
  );

  const themed = tree.normalizeTreeItem(
    { iconPath: { id: 'Git-Commit', color: { id: 'charts.blue' } } },
    '/7',
  );
  assert(
    themed.icon.kind === 'theme' && themed.icon.id === 'git-commit',
    'T-13: a ThemeIcon id is lower-cased.',
  );
  assert(themed.icon.color === 'charts.blue', 'T-14: a ThemeColor reference is carried through.');
  assert(
    tree.normalizeTreeItem({ iconPath: { id: 'bad id!' } }, '/7').icon === null,
    'T-15: an implausible codicon id is refused.',
  );
  assert(
    tree.normalizeTreeItem({ iconPath: { id: 'bug', color: { id: 'javascript:x' } } }, '/7').icon
      .color === null,
    'T-16: a colour reference that is not a theme colour id is dropped.',
  );
  const paths = tree.normalizeTreeItem({ iconPath: { light: 'l.svg', dark: 'd.svg' } }, '/8');
  assert(
    paths.icon.kind === 'path' && paths.icon.dark === 'd.svg',
    'T-17: light/dark icon paths are both carried.',
  );
  assert(
    tree.normalizeTreeItem({ iconPath: 'icon.png' }, '/8').icon.light === 'icon.png',
    'T-18: a single icon path fills both themes.',
  );
  assert(
    tree.normalizeTreeItem({ iconPath: {} }, '/8').icon === null,
    'T-19: an empty iconPath object is no icon.',
  );

  assert(
    tree.normalizeTreeItem({ checkboxState: 1 }, '/9').checkboxState === 'checked' &&
      tree.normalizeTreeItem({ checkboxState: 0 }, '/9').checkboxState === 'unchecked',
    'T-20: `TreeItemCheckboxState` is accepted numerically.',
  );
  const boxed = tree.normalizeTreeItem({ checkboxState: { state: 1, tooltip: 'Stage' } }, '/9');
  assert(
    boxed.checkboxState === 'checked' && boxed.checkboxTooltip === 'Stage',
    'T-21: the object form carries a tooltip.',
  );
  assert(
    tree.normalizeTreeItem({}, '/9').checkboxState === null,
    'T-22: no checkbox means no checkbox, not an unchecked one.',
  );

  const a11y = tree.normalizeTreeItem(
    { label: 'a', accessibilityInformation: { label: 'Commit a', role: 'treeitem' } },
    '/10',
  );
  assert(
    a11y.accessibilityLabel === 'Commit a',
    'T-23: `accessibilityInformation.label` reaches the renderer.',
  );
  assert(a11y.accessibilityRole === 'treeitem', 'T-24: its role does too.');

  const command = tree.normalizeTreeItem(
    {
      label: 'a',
      command: {
        command: 'gitlens.showCommit',
        title: 'Show',
        arguments: [{ sha: 'abc' }, () => 1],
      },
    },
    '/11',
  );
  assert(command.command.command === 'gitlens.showCommit', 'T-25: an item command id is kept.');
  assert(
    command.command.arguments.length === 1 && command.command.arguments[0].sha === 'abc',
    'T-26: a JSON argument survives and a function argument is dropped rather than crossing the boundary.',
  );
  assert(
    tree.normalizeTreeItem({ command: { command: 'rm -rf /' } }, '/11').command === null,
    'T-27: a command id that is not a command id is refused outright.',
  );
  assert(tree.isTreeCommandId('ext.do-thing') === true, 'T-28: ordinary command ids pass.');
  assert(tree.isTreeCommandId('ext do') === false, 'T-29: a space is not allowed in a command id.');
  assert(tree.isTreeCommandId('a'.repeat(500)) === false, 'T-30: an absurd command id is refused.');
  assert(
    tree.sanitizeCommandArguments('nope').length === 0,
    'T-31: non-array arguments are no arguments.',
  );
  assert(
    tree.sanitizeCommandArguments(Array.from({ length: 40 }, (_u, i) => i)).length ===
      tree.MAX_COMMAND_ARGUMENTS,
    'T-32: the argument count is capped.',
  );
  assert(
    tree.normalizeTreeItem({ contextValue: 'x'.repeat(400) }, '/12').contextValue.length ===
      tree.MAX_TREE_CONTEXT_VALUE_CHARS,
    'T-33: `contextValue` is clamped — it is a `when`-clause input, not a payload.',
  );
  assert(
    tree.normalizeTreeItem(null, '/13').label === '',
    'T-34: a hostile item degrades to an empty row, never a throw.',
  );
  assert(
    tree.normalizeTreeItem(42, '/13').icon === null,
    'T-35: a primitive item degrades the same way.',
  );
  assert(
    tree.composeHandle(null, 3, 'commit:abc') === '#commit:abc',
    'T-36: a provider-supplied id becomes the handle, so `reveal()` survives a refresh.',
  );
  assert(
    tree.composeHandle('/0', 2, null) === '/0/2',
    'T-37: without an id the handle is the child path.',
  );
  assert(
    tree.composeHandle(null, 0, 'x'.repeat(4_000)).length === tree.MAX_TREE_HANDLE_CHARS,
    'T-38: a handle is bounded.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §3 — the tree model: refresh, lazy loading, reveal, selection
// --------------------------------------------------------------------------
function validateTreeModel() {
  const tree = load(`${COMMON}vscodeTree.ts`);
  const item = (handle, overrides = {}) =>
    tree.normalizeTreeItem({ label: handle, collapsibleState: 1, ...overrides }, handle);
  const leaf = (handle) => tree.normalizeTreeItem({ label: handle }, handle);

  const model = new tree.TreeModel();
  assert(
    model.rootsLoaded === false,
    'M-1: a fresh model has not loaded roots — the provider has not been called.',
  );
  model.setRoots([item('/0'), item('/1'), leaf('/2')]);
  assert(model.rootsLoaded === true && model.size === 3, 'M-2: roots install.');
  assert(model.flattenVisible().length === 3, 'M-3: a collapsed tree flattens to its roots.');
  const version = model.version;
  assert(model.expand('/2') === 'not-expandable', 'M-4: a leaf cannot be expanded.');
  assert(model.expand('/nope') === 'unknown', 'M-5: an unknown handle is not an expansion.');
  assert(
    model.expand('/0') === 'needs-children',
    'M-6: expanding an unloaded node asks the provider — this is lazy loading.',
  );
  assert(model.version > version, 'M-7: expansion moves the version so the renderer re-reads.');
  assert(
    model.isExpanded('/0') === true,
    'M-8: the node is marked expanded before children arrive, so the twistie turns at once.',
  );
  assert(model.isLoading('/0') === true, 'M-9: and is reported as loading.');
  assert(
    model.flattenVisible().find((row) => row.handle === '/0').loading === true,
    'M-10: the row carries the spinner.',
  );
  assert(
    model.setChildren('/0', [item('/0/0'), leaf('/0/1')]) === 'ok',
    'M-11: children install under their parent.',
  );
  assert(model.isLoading('/0') === false, 'M-12: loading clears when they arrive.');
  assert(
    model.flattenVisible().length === 5,
    'M-13: an expanded node contributes its children to the flattened list.',
  );
  assert(
    model.expand('/0') === 'loaded',
    'M-14: re-expanding a loaded node does not re-ask the provider.',
  );
  assert(
    model.setChildren('/missing', []) === 'unknown-parent',
    'M-15: children for a node that is gone are refused.',
  );
  assert(model.node('/0/0').depth === 1, 'M-16: depth is tracked for indentation.');

  assert(
    model.expand('/0/0') === 'needs-children',
    'M-17: a nested expansion is the same contract.',
  );
  model.setChildren('/0/0', [leaf('/0/0/0')]);
  assert(
    model.ancestorsOf('/0/0/0').join() === '/0,/0/0',
    'M-18: `reveal()` gets the ancestor chain, root first.',
  );
  assert(model.ancestorsOf('/0').length === 0, 'M-19: a root has no ancestors.');
  assert(model.collapse('/0/0') === true, 'M-20: collapse reports a change.');
  assert(model.collapse('/0/0') === false, 'M-21: collapsing twice does not.');
  assert(
    model.flattenVisible().every((row) => row.handle !== '/0/0/0'),
    'M-22: a collapsed subtree contributes nothing.',
  );

  model.setSelection(['/0', '/1', '/0', '/gone']);
  assert(
    model.selection.length === 2,
    'M-23: selection drops duplicates and handles that do not exist.',
  );
  assert(model.focused === '/1', 'M-24: focus follows the last selected row.');
  model.setSelection(Array.from({ length: tree.MAX_TREE_SELECTION + 50 }, (_u, i) => `/x${i}`));
  assert(model.selection.length === 0, 'M-25: a multi-select of unknown handles selects nothing.');
  model.setFocus('/1');
  assert(model.focused === '/1', 'M-26: focus can be set directly for keyboard navigation.');
  model.setFocus('/gone');
  assert(model.focused === null, 'M-27: focus on a vanished row clears rather than dangles.');

  assert(
    model.updateCheckbox('/0', 'checked') === false,
    'M-28: a row with no checkbox cannot be checked.',
  );
  model.setRoots([item('/0', { checkboxState: 0 }), leaf('/1')]);
  assert(model.updateCheckbox('/0', 'checked') === true, 'M-29: a checkbox row toggles.');
  assert(
    model.node('/0').item.checkboxState === 'checked',
    'M-30: and the new state is what the renderer reads.',
  );

  const resolved = tree.normalizeTreeItem({ label: '/1', tooltip: 'resolved later' }, '/1');
  assert(
    model.updateItem(resolved) === true,
    'M-31: `resolveTreeItem` replaces one item in place.',
  );
  assert(
    model.node('/1').item.tooltip === 'resolved later',
    'M-32: the lazily resolved tooltip is stored.',
  );
  assert(
    model.updateItem(tree.normalizeTreeItem({}, '/gone')) === false,
    'M-33: resolving a vanished node is a no-op.',
  );

  model.expand('/0');
  model.setChildren('/0', [leaf('/0/0')]);
  assert(
    model.invalidate('/0') === true,
    'M-34: `onDidChangeTreeData(element)` drops that subtree.',
  );
  assert(
    model.node('/0/0') === undefined,
    'M-35: its children are gone, so the next expansion refetches.',
  );
  assert(
    model.isExpanded('/0') === true,
    'M-36: but the user’s expansion state survives a refresh.',
  );
  assert(
    model.invalidate('/gone') === false,
    'M-37: invalidating an unknown node reports nothing to do.',
  );
  assert(
    model.invalidate(null) === true,
    'M-38: `onDidChangeTreeData()` with no element drops the whole view.',
  );
  assert(model.rootsLoaded === false, 'M-39: which means the roots are refetched too.');

  const restored = new tree.TreeModel();
  restored.restoreExpanded(['#a', '#b', '', 42]);
  restored.setRoots([tree.normalizeTreeItem({ label: 'a', collapsibleState: 1, id: 'a' }, '#a')]);
  assert(
    restored.isExpanded('#a') === true,
    'M-40: persisted expansion is restored before the roots load.',
  );
  assert(restored.expandedList().length === 2, 'M-41: a non-string persisted handle is ignored.');
  assert(
    restored.expand('#a') === 'needs-children',
    'M-42: a restored expansion still fetches its children once.',
  );

  const deep = new tree.TreeModel();
  deep.setRoots([item('/0')]);
  let parent = '/0';
  let outcome = 'ok';
  for (let depth = 1; depth < tree.MAX_TREE_DEPTH + 5 && outcome === 'ok'; depth += 1) {
    const child = `${parent}/0`;
    outcome = deep.setChildren(parent, [item(child)]);
    parent = child;
  }
  assert(
    outcome === 'too-deep',
    'M-43: a provider that recurses forever is stopped at the depth cap.',
  );

  const wide = new tree.TreeModel();
  wide.setRoots(Array.from({ length: tree.MAX_TREE_CHILDREN + 100 }, (_u, i) => leaf(`/${i}`)));
  assert(
    wide.size === tree.MAX_TREE_CHILDREN,
    'M-44: a single level is capped, so one huge folder cannot exhaust memory.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §12, §13 — virtualisation, keyboard navigation, ARIA labels
// --------------------------------------------------------------------------
function validateTreeRendering() {
  const tree = load(`${COMMON}vscodeTree.ts`);
  const empty = tree.visibleWindow(0, 0, 600);
  assert(
    empty.start === 0 && empty.end === 0 && empty.totalHeight === 0,
    'R-1: an empty tree mounts no rows and reserves no height.',
  );
  const big = tree.visibleWindow(10_000, 5_000, 600, 22, 8);
  assert(
    big.totalHeight === 10_000 * 22,
    'R-2: the scroll height of a 10,000-row tree is exact, so the scrollbar stays honest.',
  );
  assert(big.end - big.start < 60, 'R-3: a 10,000-row tree mounts a few dozen rows, not 10,000.');
  assert(
    big.start === 219 && big.end === 264,
    'R-4: the window is the viewport plus overscan on both sides.',
  );
  assert(
    big.topPadding === big.start * 22,
    'R-5: the spacer above the first mounted row keeps every row at its true offset.',
  );
  const top = tree.visibleWindow(10_000, 0, 600, 22, 8);
  assert(top.start === 0 && top.topPadding === 0, 'R-6: at the top there is nothing to pad.');
  const past = tree.visibleWindow(100, 999_999, 300, 22, 8);
  assert(
    past.end === 100 && past.start >= 0,
    'R-7: a scroll position past the end clamps instead of producing a negative window.',
  );
  const short = tree.visibleWindow(10, 0, 600, 22, 8);
  assert(short.end === 10, 'R-8: a tree shorter than the viewport mounts all of it.');
  assert(
    tree.visibleWindow(5, 0, 100, 0).totalHeight === 5,
    'R-9: a zero row height cannot divide by zero.',
  );
  assert(
    tree.DEFAULT_ROW_HEIGHT === 22,
    'R-10: the default row height matches the tree the user already has.',
  );

  const model = new tree.TreeModel();
  model.setRoots([
    tree.normalizeTreeItem({ label: 'a', collapsibleState: 1 }, '/0'),
    tree.normalizeTreeItem({ label: 'b' }, '/1'),
    tree.normalizeTreeItem({ label: 'c', checkboxState: 0 }, '/2'),
  ]);
  const rows = model.flattenVisible();
  assert(
    tree.treeKeyAction(rows, null, 'ArrowDown').handle === '/0',
    'R-11: ArrowDown with nothing focused focuses the first row.',
  );
  assert(
    tree.treeKeyAction(rows, '/0', 'ArrowDown').handle === '/1',
    'R-12: ArrowDown moves down.',
  );
  assert(tree.treeKeyAction(rows, '/1', 'ArrowUp').handle === '/0', 'R-13: ArrowUp moves up.');
  assert(
    tree.treeKeyAction(rows, '/0', 'ArrowUp').handle === '/0',
    'R-14: ArrowUp on the first row stays put rather than wrapping.',
  );
  assert(
    tree.treeKeyAction(rows, '/2', 'ArrowDown').handle === '/2',
    'R-15: ArrowDown on the last row stays put.',
  );
  assert(
    tree.treeKeyAction(rows, '/2', 'Home').handle === '/0',
    'R-16: Home jumps to the first row.',
  );
  assert(tree.treeKeyAction(rows, '/0', 'End').handle === '/2', 'R-17: End jumps to the last.');
  assert(
    tree.treeKeyAction(rows, '/0', 'PageDown').handle === '/2',
    'R-18: PageDown clamps to the end.',
  );
  assert(
    tree.treeKeyAction(rows, '/2', 'PageUp').handle === '/0',
    'R-19: PageUp clamps to the start.',
  );
  const right = tree.treeKeyAction(rows, '/0', 'ArrowRight');
  assert(
    right.kind === 'expand' && right.handle === '/0',
    'R-20: ArrowRight on a collapsed node expands it.',
  );
  assert(
    tree.treeKeyAction(rows, '/1', 'ArrowRight').kind === 'focus',
    'R-21: ArrowRight on a leaf moves on instead.',
  );
  assert(
    tree.treeKeyAction(rows, '/1', 'ArrowLeft').kind === 'none',
    'R-22: ArrowLeft on a root leaf has nowhere to go.',
  );
  assert(tree.treeKeyAction(rows, '/1', 'Enter').kind === 'activate', 'R-23: Enter runs the row.');
  assert(
    tree.treeKeyAction(rows, '/2', ' ').kind === 'toggle-checkbox',
    'R-24: Space toggles a checkbox when the row has one.',
  );
  assert(
    tree.treeKeyAction(rows, '/1', ' ').kind === 'activate',
    'R-25: and activates the row when it does not.',
  );
  assert(
    tree.treeKeyAction(rows, '/1', 'F13').kind === 'none',
    'R-26: an unbound key does nothing at all.',
  );
  assert(
    tree.treeKeyAction([], '/1', 'ArrowDown').kind === 'none',
    'R-27: keys on an empty tree do nothing.',
  );

  model.expand('/0');
  model.setChildren('/0', [tree.normalizeTreeItem({ label: 'a1' }, '/0/0')]);
  const nested = model.flattenVisible();
  assert(
    tree.treeKeyAction(nested, '/0', 'ArrowRight').handle === '/0/0',
    'R-28: ArrowRight on an expanded node steps into its first child.',
  );
  assert(
    tree.treeKeyAction(nested, '/0/0', 'ArrowLeft').handle === '/0',
    'R-29: ArrowLeft on a child steps out to its parent.',
  );
  assert(
    tree.treeKeyAction(nested, '/0', 'ArrowLeft').kind === 'collapse',
    'R-30: ArrowLeft on an expanded node collapses it.',
  );

  const label = tree.treeRowAriaLabel(nested[0], 1, nested.length);
  assert(
    label.includes('1 of 4'),
    'R-31: a row announces its position, without which a tree is unnavigable by ear.',
  );
  assert(label.includes('expanded'), 'R-32: and its expansion state.');
  assert(
    tree.treeRowAriaLabel(nested[3], 4, 4).includes('not checked'),
    'R-33: a checkbox row announces whether it is checked.',
  );
  const described = tree.normalizeTreeItem(
    {
      label: 'index.ts',
      description: 'modified',
      accessibilityInformation: { label: 'index.ts, modified' },
    },
    '/x',
  );
  assert(
    tree.treeRowAriaLabel(
      {
        handle: '/x',
        depth: 0,
        item: described,
        expandable: false,
        expanded: false,
        loading: false,
      },
      1,
      1,
    ) === 'index.ts, modified, 1 of 1',
    'R-34: `accessibilityInformation.label` wins over the visible text when the extension supplied one.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §7, §10 — menu registry and resolution
// --------------------------------------------------------------------------
function validateMenus() {
  const menus = load(`${COMMON}vscodeMenus.ts`);
  const commands = new Map([
    ['gitlens.refresh', { title: 'Refresh', icon: 'refresh', enablement: null }],
    ['gitlens.openFile', { title: 'Open File', icon: null, enablement: 'gitlens:enabled' }],
    ['docker.start', { title: 'Start', icon: null, enablement: null }],
    ['gitlens.alt', { title: 'Open Revision', icon: null, enablement: null }],
  ]);
  const registry = menus.buildMenuRegistry([
    {
      extensionId: 'eamodio.gitlens',
      submenus: [{ id: 'gitlens/submenu', label: 'GitLens', icon: 'git-merge' }],
      menus: [
        { location: 'view/title', command: 'gitlens.refresh', group: 'navigation@2' },
        { location: 'view/title', command: 'docker.start', group: 'navigation@1' },
        {
          location: 'view/item/context',
          command: 'gitlens.openFile',
          group: 'inline',
          when: 'viewItem == commit',
        },
        {
          location: 'view/item/context',
          command: 'gitlens.refresh',
          group: '1_actions',
          alt: 'gitlens.alt',
          when: 'viewItem == commit',
        },
        { location: 'view/item/context', submenu: 'gitlens/submenu', group: '2_more' },
        { location: 'gitlens/submenu', command: 'docker.start', when: 'config.docker' },
        { location: 'commandPalette', command: 'gitlens.refresh', when: 'gitlens:enabled' },
        { location: 'touchBar', command: 'gitlens.refresh' },
        { location: 'view/title', command: 'never.declared' },
      ],
    },
  ]);
  assert(
    registry.total === 8,
    'X-1: an item contributed to a location this build does not draw is not registered.',
  );
  assert(
    registry.unsupportedLocations.length === 1,
    'X-2: it is reported as unsupported rather than dropped silently.',
  );
  assert(
    registry.unsupportedLocations[0].location === 'touchBar',
    'X-3: … naming the location, so the extension manager can show it.',
  );
  assert(
    registry.submenus.get('gitlens/submenu').label === 'GitLens',
    'X-4: `contributes.submenus` is registered by id.',
  );
  assert(
    menus.contributedLocations(registry).includes('view/item/context'),
    'X-5: contributed locations are reportable for diagnostics.',
  );

  const title = menus.resolveMenu(registry, 'view/title', {}, commands);
  assert(
    title.length === 1 && title[0].id === 'navigation',
    'X-6: one group, and it is the one that was declared.',
  );
  assert(
    title[0].items.length === 2,
    'X-7: the item naming an undeclared command is dropped — a menu cannot invoke what the command registry does not have.',
  );
  assert(title[0].items[0].command === 'docker.start', 'X-8: `@order` sorts within the group.');
  assert(
    title[0].items[0].title === 'Start',
    'X-9: the title comes from `contributes.commands`, not from the menu entry.',
  );
  assert(title[0].items[1].icon === 'refresh', 'X-10: so does the icon.');

  const gated = menus.resolveMenu(registry, 'view/item/context', {}, commands);
  assert(
    gated.every((group) => group.id !== 'inline'),
    'X-11: a false `when` clause hides its item.',
  );
  const onCommit = menus.resolveMenu(
    registry,
    'view/item/context',
    { viewItem: 'commit', 'gitlens:enabled': true },
    commands,
  );
  assert(
    onCommit[0].id === 'inline',
    'X-12: `inline` is pinned ahead of every other group, as upstream draws it.',
  );
  assert(
    onCommit[0].items[0].enabled === true,
    'X-13: a satisfied `enablement` clause leaves the item clickable.',
  );
  const disabled = menus.resolveMenu(
    registry,
    'view/item/context',
    { viewItem: 'commit' },
    commands,
  );
  assert(
    disabled[0].items[0].enabled === false,
    'X-14: a failing `enablement` draws the item disabled rather than hiding it — upstream’s distinction between `when` and `enablement`.',
  );
  const actions = onCommit.find((group) => group.id === '1_actions');
  assert(actions.items[0].alt === 'gitlens.alt', 'X-15: a declared `alt` command survives.');
  assert(
    onCommit.every((group) => group.id !== '2_more'),
    'X-16: a submenu whose every item is gated off is not drawn as an empty row.',
  );
  const withSub = menus.resolveMenu(
    registry,
    'view/item/context',
    { viewItem: 'commit', 'gitlens:enabled': true, 'config.docker': true },
    commands,
  );
  const sub = withSub.find((group) => group.id === '2_more');
  assert(
    sub.items[0].submenu === 'gitlens/submenu',
    'X-17: once it has a visible child the submenu appears.',
  );
  assert(
    sub.items[0].command === null,
    'X-18: a submenu row names no command, so it cannot invoke one.',
  );
  assert(sub.items[0].title === 'GitLens', 'X-19: it is titled by its own declaration.');
  assert(
    withSub.map((group) => group.id).join() === 'inline,1_actions,2_more',
    'X-20: unpinned groups sort lexically after the pinned ones.',
  );

  const altOnly = menus.buildMenuRegistry([
    {
      extensionId: 'a.b',
      submenus: [],
      menus: [{ location: 'view/title', command: 'docker.start', alt: 'not.declared' }],
    },
  ]);
  assert(
    menus.resolveMenu(altOnly, 'view/title', {}, commands)[0].items[0].alt === null,
    'X-21: an `alt` naming a command that does not exist is dropped, not passed through.',
  );
  assert(menus.parseMenuGroup('navigation@3').order === 3, 'X-22: `group@order` splits.');
  assert(
    menus.parseMenuGroup('navigation').order === 0,
    'X-23: a group with no order sorts first within itself.',
  );
  assert(menus.parseMenuGroup('a@b').order === 0, 'X-24: a non-numeric order is zero, not NaN.');
  assert(
    menus.parseMenuGroup('').group === 'z_end',
    'X-25: no group at all sorts last, as upstream does.',
  );
  assert(
    menus.parseMenuGroup(null).group === 'z_end',
    'X-26: … including when the field is absent.',
  );
  assert(
    menus.parseMenuGroup('@2').group === '@2',
    'X-27: a leading `@` is a group name, not an order.',
  );

  assert(
    menus.menuReadsKeys(registry, 'view/item/context', new Set(['viewItem'])) === true,
    'X-28: a location is re-resolved when a key its clauses read moves.',
  );
  assert(
    menus.menuReadsKeys(registry, 'view/item/context', new Set(['terminalFocus'])) === false,
    'X-29: and skipped when it does not — this is what makes dynamic menus affordable.',
  );
  assert(
    menus.menuReadsKeys(registry, 'nowhere', new Set(['viewItem'])) === false,
    'X-30: a location nobody contributed to reads nothing.',
  );
  assert(
    menus.resolveMenu(registry, 'nowhere', {}, commands).length === 0,
    'X-31: resolving an empty location is an empty list, not a throw.',
  );

  const flood = menus.buildMenuRegistry([
    {
      extensionId: 'a.b',
      submenus: [],
      menus: Array.from({ length: menus.MAX_MENU_ITEMS_PER_LOCATION + 50 }, () => ({
        location: 'view/title',
        command: 'docker.start',
      })),
    },
  ]);
  assert(
    flood.byLocation.get('view/title').length === menus.MAX_MENU_ITEMS_PER_LOCATION,
    'X-32: one location cannot be flooded past its cap.',
  );
  const total = menus.buildMenuRegistry(
    Array.from({ length: 12 }, (_u, i) => ({
      extensionId: `a.b${i}`,
      submenus: [],
      menus: Array.from({ length: 150 }, () => ({
        location: `view/title${i}`,
        command: 'docker.start',
      })),
    })),
  );
  assert(total.total <= menus.MAX_MENU_ITEMS, 'X-33: and the registry as a whole is bounded.');
  const recursive = menus.buildMenuRegistry([
    {
      extensionId: 'a.b',
      submenus: [{ id: 'loop/menu', label: 'Loop' }],
      menus: [
        { location: 'view/title', submenu: 'loop/menu' },
        { location: 'loop/menu', submenu: 'loop/menu' },
        { location: 'loop/menu', command: 'docker.start' },
      ],
    },
  ]);
  assert(
    menus.resolveMenu(recursive, 'view/title', {}, commands).length === 1,
    'X-34: a submenu that contains itself still resolves — the depth cap stops the recursion instead of the stack.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 §5, §6 — the context key store and compiled `when` clauses
// --------------------------------------------------------------------------
function validateContextKeyStore() {
  const keys = load(`${COMMON}vscodeContextKeys.ts`);
  const store = new keys.ContextKeyStore();
  assert(
    store.set('gitlens:enabled', true, 'eamodio.gitlens') === 'set',
    'K-1: an extension may write its own key.',
  );
  assert(
    store.set('gitlens:enabled', true, 'eamodio.gitlens') === 'unchanged',
    'K-2: writing the same value again does not move the version.',
  );
  const version = store.version;
  assert(
    store.set('gitlens:enabled', false, 'eamodio.gitlens') === 'set' && store.version > version,
    'K-3: a real change does.',
  );
  assert(
    store.ownerOf('gitlens:enabled') === 'eamodio.gitlens',
    'K-4: every key remembers who wrote it.',
  );
  assert(
    store.set('editorLangId', 'python', 'eamodio.gitlens') === 'reserved',
    'K-5: an extension cannot lie about which file is open.',
  );
  assert(
    store.set('__proto__', true, 'a.b') === 'invalid-key',
    'K-6: a prototype-polluting key name is refused.',
  );
  assert(store.set('constructor', true, 'a.b') === 'invalid-key', 'K-7: … as are the other two.');
  assert(
    store.set('has space', true, 'a.b') === 'invalid-key',
    'K-8: a key name that is not a key name is refused.',
  );
  assert(
    store.set('x'.repeat(200), true, 'a.b') === 'invalid-key',
    'K-9: an oversized key name is refused.',
  );
  assert(
    store.set('ok.key', { nested: 1 }, 'a.b') === 'invalid-value',
    'K-10: an object value is refused rather than coerced to "[object Object]".',
  );
  assert(store.set('ok.key', () => 1, 'a.b') === 'invalid-value', 'K-11: so is a function.');
  assert(
    store.set('ok.key', Number.NaN, 'a.b') === 'invalid-value',
    'K-12: and a non-finite number.',
  );
  assert(
    store.set('ok.key', 'x'.repeat(2_000), 'a.b') === 'invalid-value',
    'K-13: and a string long enough to be a payload.',
  );
  assert(
    store.set('ok.list', ['a', 1, true, null], 'a.b') === 'set',
    'K-14: a flat array of primitives is a legal value — `in` clauses need it.',
  );
  assert(
    store.set('ok.list', [{ a: 1 }], 'a.b') === 'invalid-value',
    'K-15: an array of objects is not.',
  );
  assert(
    store.set(
      'ok.list',
      Array.from({ length: keys.MAX_CONTEXT_ARRAY_ITEMS + 1 }, () => 1),
      'a.b',
    ) === 'invalid-value',
    'K-16: nor is an unbounded one.',
  );
  assert(
    store.set('ok.key', undefined, 'a.b') === 'unchanged',
    'K-17: removing a key that was never set is not a change.',
  );
  assert(
    store.set('gone.key', 1, 'a.b') === 'set' &&
      store.set('gone.key', undefined, 'a.b') === 'removed',
    'K-18: `undefined` is upstream’s "clear this key".',
  );
  assert(
    store.remove('ok.list', 'someone.else') === false,
    'K-19: one extension cannot delete another’s key.',
  );
  assert(store.get('ok.list').length === 4, 'K-20: … and the key is still there afterwards.');
  assert(
    store.remove('ok.list', 'workbench') === true,
    'K-21: the workbench can, because it owns the store.',
  );

  store.set('a.one', 1, 'a.b');
  store.set('a.two', 2, 'a.b');
  assert(
    store.removeOwner('a.b') === true,
    'K-22: everything one extension wrote is dropped when its host stops.',
  );
  assert(
    store.get('a.one') === undefined && store.get('gitlens:enabled') === false,
    'K-23: … and nothing another extension wrote goes with it.',
  );
  assert(
    store.removeOwner('never.installed') === false,
    'K-24: dropping an owner with no keys reports no change.',
  );

  const full = new keys.ContextKeyStore();
  for (let index = 0; index < keys.MAX_CONTEXT_KEYS; index += 1)
    full.set(`k.${index}`, index, 'a.b');
  assert(
    full.set('one.too.many', 1, 'a.b') === 'full',
    'K-25: the store is bounded, so `setContext` in a loop cannot exhaust memory.',
  );
  assert(
    full.set('k.0', 99, 'a.b') === 'set',
    'K-26: a full store still accepts a write to a key it already holds.',
  );

  const workbench = new keys.ContextKeyStore();
  workbench.set('ext.key', true, 'a.b');
  assert(
    workbench.applyWorkbench({ editorLangId: 'typescript', view: 'gitlens.views.commits' }) ===
      true,
    'K-27: the workbench half applies in one call.',
  );
  assert(workbench.get('editorLangId') === 'typescript', 'K-28: … and is readable.');
  assert(
    workbench.applyWorkbench({ editorLangId: 'typescript', view: 'gitlens.views.commits' }) ===
      false,
    'K-29: re-applying the same window state is not a change.',
  );
  assert(
    workbench.applyWorkbench({ editorLangId: 'typescript' }) === true,
    'K-30: a key the window no longer sends is removed — a stale `view` would keep a menu item alive for a closed view.',
  );
  assert(workbench.get('view') === undefined, 'K-31: … and really is gone.');
  assert(
    workbench.get('ext.key') === true,
    'K-32: replacing the workbench half leaves extension keys untouched.',
  );
  assert(
    workbench.applyWorkbench({ 'not a key': 1, editorLangId: 'typescript' }) === false,
    'K-33: an unusable key in a workbench push is skipped, not fatal.',
  );
  const snapshot = workbench.snapshot();
  assert(
    Object.getPrototypeOf(snapshot) === null,
    'K-34: the snapshot has no prototype, so a key named `toString` is a key.',
  );
  assert(snapshot.editorLangId === 'typescript', 'K-35: the snapshot is what `when` clauses read.');
  assert(
    workbench.keys().join() === 'editorLangId,ext.key',
    'K-36: keys are listed sorted, for diagnostics.',
  );
  workbench.clear();
  assert(workbench.size === 0, 'K-37: the store can be emptied when the last window closes.');

  assert(
    keys.isWorkbenchOwnedContextKey('resourceExtname') === true,
    'K-38: resource keys are workbench-owned.',
  );
  assert(
    keys.isWorkbenchOwnedContextKey('gitlens:enabled') === false,
    'K-39: an extension’s own namespace is not.',
  );
  assert(
    keys.WORKBENCH_OWNED_CONTEXT_KEYS.has('workspaceFolderCount'),
    'K-40: … and so is the workspace shape.',
  );
  assert(
    keys.normalizeContextValue(undefined).kind === 'remove',
    'K-41: `undefined` normalises to a removal.',
  );
  assert(
    keys.normalizeContextValue(Symbol('x')) === null,
    'K-42: an exotic value normalises to nothing at all.',
  );

  keys.clearWhenCache();
  const compiled = keys.compileWhen('view == gitlens.views.commits && !listMultiSelection');
  assert(compiled !== null, 'K-43: a real GitLens clause compiles.');
  assert(
    keys.compileWhen('view == gitlens.views.commits && !listMultiSelection') === compiled,
    'K-44: the same clause text is compiled once and cached — the parse-once requirement.',
  );
  assert(
    compiled.keys.includes('view') && compiled.keys.includes('listMultiSelection'),
    'K-45: a compiled clause knows which keys it reads.',
  );
  assert(keys.whenCacheSize() === 1, 'K-46: one clause, one cache entry.');
  assert(
    keys.compileWhen('view ==') === null,
    'K-47: a malformed clause fails to compile rather than throwing.',
  );
  assert(
    keys.compileWhen('view ==') === null && keys.whenCacheSize() === 2,
    'K-48: the failure is cached too, so a manifest typo costs one parse.',
  );
  assert(
    keys.evaluateWhen('view ==', { view: 'x' }) === false,
    'K-49: an unparseable clause is false, never true — a menu item cannot appear by being broken.',
  );
  assert(
    keys.compileWhen(null) !== null,
    'K-50: an absent clause compiles to "always", as upstream’s missing `when` does.',
  );
  assert(keys.evaluateWhen(null, {}) === true, 'K-51: … and evaluates true.');
  assert(
    keys.evaluateWhen(undefined, {}) === true,
    'K-52: including when it is `undefined` rather than absent.',
  );

  const context = {
    view: 'gitlens.views.commits',
    viewItem: 'commit',
    resourceExtname: '.ts',
    resourceLangId: 'typescript',
    editorTextFocus: true,
    workspaceFolderCount: 1,
    'gitlens:hasRemotes': true,
    listMultiSelection: false,
    'docker.tags': ['latest', 'dev'],
    dockerTag: 'latest',
    otherTag: 'archived',
  };
  assert(
    keys.evaluateWhen('view == gitlens.views.commits', context) === true,
    'K-53: a string comparison against an unquoted literal works, which is how manifests are written.',
  );
  assert(
    keys.evaluateWhen("resourceExtname == '.ts'", context) === true,
    'K-54: a quoted literal works too.',
  );
  assert(keys.evaluateWhen('resourceExtname != .js', context) === true, 'K-55: `!=` works.');
  assert(
    keys.evaluateWhen('resourceLangId =~ /^type/', context) === true,
    'K-56: `=~` matches a regex literal.',
  );
  assert(
    keys.evaluateWhen('resourceLangId =~ /^python$/', context) === false,
    'K-57: … and reports a miss.',
  );
  assert(
    keys.evaluateWhen('dockerTag in docker.tags', context) === true,
    'K-58: `in` tests one key’s value for membership of an array-valued key.',
  );
  assert(
    keys.evaluateWhen('otherTag in docker.tags', context) === false,
    'K-59: … and a non-member is false.',
  );
  assert(
    keys.evaluateWhen('otherTag not in docker.tags', context) === true,
    'K-60: `not in` is the negation, spaces and all.',
  );
  assert(
    keys.evaluateWhen('workspaceFolderCount > 0', context) === true,
    'K-61: numeric comparison works.',
  );
  assert(
    keys.evaluateWhen('workspaceFolderCount >= 2', context) === false,
    'K-62: … in both directions.',
  );
  assert(
    keys.evaluateWhen('editorTextFocus && viewItem == commit', context) === true,
    'K-63: `&&` binds two terms.',
  );
  assert(
    keys.evaluateWhen('!listMultiSelection', context) === true,
    'K-64: `!` negates a falsy key.',
  );
  assert(
    keys.evaluateWhen('nothingAtAll', context) === false,
    'K-65: an undefined key is falsy, not an error.',
  );
  assert(keys.evaluateWhen('!nothingAtAll', context) === true, 'K-66: … so its negation is true.');
  assert(
    keys.evaluateWhen(
      '(view == a || view == gitlens.views.commits) && !listMultiSelection',
      context,
    ) === true,
    'K-67: parentheses group as written.',
  );
  assert(
    keys.evaluateWhen('gitlens:hasRemotes', context) === true,
    'K-68: a colon in a key name is part of the key, not an operator.',
  );
  assert(
    keys.whenReadsAnyOf('view == gitlens.views.commits', new Set(['view'])) === true &&
      keys.whenReadsAnyOf('view == gitlens.views.commits', new Set(['viewItem'])) === false,
    'K-69: change-driven re-resolution asks only about the keys a clause actually reads.',
  );
  assert(
    keys.whenReadsAnyOf('view ==', new Set(['view'])) === false,
    'K-70: a clause that never compiled reads nothing.',
  );
}

// --------------------------------------------------------------------------
// Phase 5 SECURITY — no dynamic evaluation, no injected commands, no Node in views
// --------------------------------------------------------------------------
function validateWorkbenchSecurity() {
  const read = (relative) => fs.readFileSync(path.join(root, 'apps', 'desktop', relative), 'utf8');
  const files = [
    'src/common/contextKeyExpr.ts',
    'src/common/vscodeContextKeys.ts',
    'src/common/vscodeMenus.ts',
    'src/common/vscodeTree.ts',
    'src/common/vscodeViews.ts',
    'src/main/services/extensionViews.ts',
    'src/renderer/src/workbench/ContributedViews.tsx',
    'src/renderer/src/workbench/TreeView.tsx',
    'src/renderer/src/workbench/TreeItem.tsx',
  ];
  for (const relative of files) {
    const source = read(relative);
    assert(
      !/\beval\s*\(/.test(source),
      `S5: ${relative} contains no eval() — a when clause is parsed, never executed.`,
    );
    assert(
      !/new\s+Function\s*\(/.test(source),
      `S5: ${relative} contains no Function constructor.`,
    );
    assert(
      !/dangerouslySetInnerHTML/.test(source),
      `S5: ${relative} never sets raw HTML, so a tree label cannot become markup.`,
    );
  }
  const renderers = [
    'src/renderer/src/workbench/ContributedViews.tsx',
    'src/renderer/src/workbench/TreeView.tsx',
    'src/renderer/src/workbench/TreeItem.tsx',
  ];
  for (const relative of renderers) {
    const source = read(relative);
    assert(
      !/require\(|from '(node:|fs|path|child_process)/.test(source),
      `S5: ${relative} imports no Node module — a tree provider’s UI has no filesystem reach.`,
    );
  }
  const main = read('src/main/services/extensionViews.ts');
  assert(
    /runMenuCommand/.test(main),
    'S5-1: menu invocation goes through one funnel, so a command id cannot arrive from anywhere else.',
  );
  assert(
    /resolveMenu\(/.test(main) && /includes\(|some\(/.test(main),
    'S5-2: that funnel re-resolves the menu and checks the id against it, which is what "menus cannot execute injected commands" means.',
  );

  const tree = load(`${COMMON}vscodeTree.ts`);
  const hostile = tree.normalizeTreeItem(
    {
      label: '<img src=x onerror=alert(1)>',
      description: '</span><script>fetch("//evil")</script>',
      tooltip: 'javascript:alert(1)',
      command: { command: 'javascript:alert(1)' },
      iconPath: 'javascript:alert(1)',
    },
    '/0',
  );
  assert(
    hostile.label.includes('<img'),
    'S5-3: markup in a label survives as text — it is rendered as a text node, so it is inert.',
  );
  assert(hostile.command === null, 'S5-4: a `javascript:` "command id" is not a command id.');
  assert(
    hostile.icon.kind === 'path',
    'S5-5: an icon path stays a path; the main process, not the renderer, decides what may be read.',
  );
  const views = load(`${COMMON}vscodeViews.ts`);
  assert(
    views
      .parseWelcomeContents('[Go](javascript:alert(1))')
      .every((block) => block.kind !== 'button'),
    'S5-6: a welcome link with a script URL is never a button.',
  );
  const keys = load(`${COMMON}vscodeContextKeys.ts`);
  const store = new keys.ContextKeyStore();
  assert(
    store.set('__proto__', true, 'a.b') === 'invalid-key',
    'S5-7: a context key cannot reach Object.prototype.',
  );
  assert({}.polluted === undefined, 'S5-8: … and nothing was polluted proving it.');
  assert(
    store.set('view', 'gitlens.views.commits', 'a.b') === 'reserved',
    'S5-9: an extension cannot forge the workbench’s own view identity.',
  );
}

/**
 * The compatibility verdict an extension is judged by (Phase 5, extended in Phase 6).
 *
 * This table is the only place AXIOM says out loud "this API works". It is read by the
 * real-extension harness to decide what still counts as missing, so a stale entry either scares a
 * user off an extension that runs or promises one that throws. The assertions pin it to what the
 * shim in `extensionHostWorker.ts` actually exports: what Phases 4 to 6 delivered is `supported`,
 * what a later phase owns is not, and a probe over minified code — which recovers a bare member
 * name, never a namespaced one — must reach the same verdict as the full name.
 */
function validateCompatClassifier() {
  const compat = load(`${COMMON}vscodeCompat.ts`);
  const shim = fs.readFileSync(
    path.join(root, 'apps', 'desktop', 'src', 'main', 'extensionHostWorker.ts'),
    'utf8',
  );

  // Delivered through Phase 6: claimed supported, and present in the shim.
  const delivered = [
    ['createWebviewPanel', 'window.createWebviewPanel'],
    ['registerWebviewViewProvider', 'window.registerWebviewViewProvider'],
    ['registerWebviewPanelSerializer', 'window.registerWebviewPanelSerializer'],
    ['createTreeView', 'window.createTreeView'],
    ['registerTreeDataProvider', 'window.registerTreeDataProvider'],
    ['createStatusBarItem', 'window.createStatusBarItem'],
    ['createOutputChannel', 'window.createOutputChannel'],
    ['withProgress', 'window.withProgress'],
    ['registerUriHandler', 'window.registerUriHandler'],
    ['asExternalUri', 'env.asExternalUri'],
    ['openTextDocument', 'workspace.openTextDocument'],
    ['registerCompletionItemProvider', 'languages.registerCompletionItemProvider'],
    ['registerHoverProvider', 'languages.registerHoverProvider'],
    ['registerSignatureHelpProvider', 'languages.registerSignatureHelpProvider'],
    ['registerDefinitionProvider', 'languages.registerDefinitionProvider'],
    ['registerTypeDefinitionProvider', 'languages.registerTypeDefinitionProvider'],
    ['registerImplementationProvider', 'languages.registerImplementationProvider'],
    ['registerDeclarationProvider', 'languages.registerDeclarationProvider'],
    ['registerReferenceProvider', 'languages.registerReferenceProvider'],
    ['registerRenameProvider', 'languages.registerRenameProvider'],
    ['registerDocumentSymbolProvider', 'languages.registerDocumentSymbolProvider'],
    ['registerDocumentFormattingEditProvider', 'languages.registerDocumentFormattingEditProvider'],
    [
      'registerDocumentRangeFormattingEditProvider',
      'languages.registerDocumentRangeFormattingEditProvider',
    ],
    ['registerOnTypeFormattingEditProvider', 'languages.registerOnTypeFormattingEditProvider'],
    ['registerCodeActionsProvider', 'languages.registerCodeActionsProvider'],
    ['registerCodeLensProvider', 'languages.registerCodeLensProvider'],
    ['registerDocumentColorProvider', 'languages.registerDocumentColorProvider'],
    ['registerDocumentHighlightProvider', 'languages.registerDocumentHighlightProvider'],
    ['registerDocumentLinkProvider', 'languages.registerDocumentLinkProvider'],
    ['registerSelectionRangeProvider', 'languages.registerSelectionRangeProvider'],
    ['registerFoldingRangeProvider', 'languages.registerFoldingRangeProvider'],
    ['registerLinkedEditingRangeProvider', 'languages.registerLinkedEditingRangeProvider'],
    ['registerInlayHintsProvider', 'languages.registerInlayHintsProvider'],
    ['registerDocumentSemanticTokensProvider', 'languages.registerDocumentSemanticTokensProvider'],
    [
      'registerDocumentRangeSemanticTokensProvider',
      'languages.registerDocumentRangeSemanticTokensProvider',
    ],
    ['setLanguageConfiguration', 'languages.setLanguageConfiguration'],
    ['setTextDocumentLanguage', 'languages.setTextDocumentLanguage'],
    ['applyEdit', 'workspace.applyEdit'],
  ];
  for (const [member, qualified] of delivered) {
    assert(
      compat.classifyApi(qualified) === 'supported',
      `C-1: ${qualified} is delivered and must be classified supported.`,
    );
    assert(
      compat.classifyApi(member) === 'supported',
      `C-2: the bare member ${member} must reach the same verdict as ${qualified}.`,
    );
    assert(
      new RegExp(`\\b${member}\\b`).test(shim),
      `C-3: ${qualified} is claimed supported but ${member} is not in the shim.`,
    );
  }
  assert(
    compat.classifyApi('commands.setContext') === 'supported' &&
      compat.classifyApi('setContext') === 'supported',
    'C-4: setContext ships in Phase 5 and must be classified supported under either name.',
  );
  assert(
    /command === 'setContext'/.test(shim),
    'C-5: setContext is claimed supported but nothing in the shim handles it.',
  );

  // Later phases: must not be claimed. A claim here is how a user ends up with a broken install.
  for (const api of [
    'notebooks.registerNotebookSerializer',
    'lm.selectChatModels',
    'chat.createChatParticipant',
    'registerCustomEditorProvider',
    // Phase 7 delivered the members named in the table, not the whole `debug` or `tasks` namespace:
    // anything else in them still throws, so it must not be claimed off the namespace.
    'debug.addBreakpoints',
    'debug.asDebugSourceUri',
    'tasks.onDidChangeTaskExecutions',
    // Phase 6 delivered the 28 named provider registrations, not the whole `languages` namespace:
    // anything else in it still throws, so it must not be claimed off the namespace.
    'languages.registerInlineCompletionItemProvider',
    'languages.createLanguageStatusItem',
    'languages.registerEvaluatableExpressionProvider',
  ]) {
    assert(
      compat.classifyApi(api) === 'unsupported',
      `C-6: ${api} belongs to a later phase and must not be claimed.`,
    );
  }
  assert(
    compat.classifyApi('debug.onDidChangeBreakpoints') === 'partial',
    'C-7: an API that registers but has no surface to answer is partial — neither working nor absent.',
  );
  for (const [api, member] of [
    ['languages.registerWorkspaceSymbolProvider', 'registerWorkspaceSymbolProvider'],
    ['languages.registerCallHierarchyProvider', 'registerCallHierarchyProvider'],
    ['languages.registerTypeHierarchyProvider', 'registerTypeHierarchyProvider'],
    ['languages.registerInlineValuesProvider', 'registerInlineValuesProvider'],
  ]) {
    assert(
      compat.classifyApi(api) === 'supported',
      `C-7b: ${api} has no Monaco registration, but Phase 7 gave it the surface the API is specified against, so it is supported rather than partial.`,
    );
    assert(
      new RegExp(`\\b${member}\\b`).test(shim),
      `C-7c: ${api} is reported as supported, so the shim must accept ${member}.`,
    );
  }
  assert(
    compat.classifyApi('workspace.onDidChangeTextDocument') === 'supported' &&
      compat.classifyApi('onDidSaveTextDocument') === 'supported',
    'C-7d: Phase 6 mirrors editor documents into the hosts, so the lifecycle events now fire.',
  );
  // A name that says nothing on its own must not be matched off a namespaced entry.
  for (const generic of ['get', 'store', 'onDidChange', 'dispose']) {
    assert(
      compat.classifyApi(generic) === 'unsupported',
      `C-8: the bare name ${generic} is a coincidence, not evidence of ${generic} being supported.`,
    );
  }
  assert(
    compat.classifyApi('secrets.get') === 'supported' &&
      compat.classifyApi('authentication.getSession') === 'supported',
    'C-9: Phase 4 identity and secret storage are delivered and must be classified supported.',
  );

  // The rolled-up verdict: one unsupported call is enough to withhold a compatible verdict, and
  // coverage counts what at least partly works rather than rounding it away. The sample moved off
  // `createTerminal` and `createFileSystemWatcher` when Phase 7 delivered both, and off
  // `registerTypeHierarchyProvider` when Phase 7 gave it a view — `onDidChangeBreakpoints`, which
  // registers and never fires, is what `partial` now looks like.
  const mixed = compat.assessExtension([
    'createTreeView',
    'setContext',
    'debug.onDidChangeBreakpoints',
    'registerNotebookSerializer',
  ]);
  assert(mixed.level === 'unsupported', 'C-10: any unsupported API must sink the verdict.');
  assert(
    mixed.supported.length === 2 && mixed.partial.length === 1 && mixed.unsupported.length === 1,
    'C-11: the verdict must report each API at its own level.',
  );
  assert(mixed.coverage === 0.75, 'C-12: coverage must count supported and partial APIs.');
  const clean = compat.assessExtension(['createTreeView', 'setContext']);
  assert(
    clean.level === 'supported' && clean.coverage === 1,
    'C-13: an extension that only uses delivered APIs must read as compatible.',
  );
  assert(
    compat.assessExtension([]).label.includes('No VS Code APIs used'),
    'C-14: a declarative extension uses no API and must not be marked incompatible for it.',
  );

  /*
   * Phase 7 §1–§4 value types, and the §8 provider members.
   *
   * The table's own comment says a bare class name is what a probe over minified code recovers, and
   * that is the whole reason these need entries: `new vscode.ShellExecution(…)` reaches the classifier
   * as `ShellExecution`, and until Phase 7 added them every task-providing extension in the corpus was
   * reported "not compatible" over classes the shim exports. Each claim is checked against the shim's
   * export list rather than taken on trust.
   */
  for (const value of [
    'TerminalProfile',
    'Task',
    'ShellExecution',
    'ProcessExecution',
    'CustomExecution',
    'ShellQuoting',
    'DebugAdapterExecutable',
    'DebugAdapterServer',
    'DebugAdapterNamedPipeServer',
    'DebugAdapterInlineImplementation',
    'FileChangeType',
  ]) {
    assert(
      compat.classifyApi(value) === 'supported',
      `C-15: ${value} is constructible against the Phase 7 shim, so an extension must not be judged incompatible for building one.`,
    );
    assert(
      new RegExp(`\\n {2}${value},`).test(shim),
      `C-15b: ${value} is claimed supported, so the shim must export it.`,
    );
  }
  const changeEvents = load(`${COMMON}vscodeProviderEvents.ts`);
  for (const event of Object.values(changeEvents.PROVIDER_CHANGE_EVENTS)) {
    assert(
      compat.classifyApi(event) === 'supported',
      `C-16: ${event} is subscribed at registration and re-asks its provider, so a provider that declares it reaches a delivered surface.`,
    );
  }
  assert(
    compat.classifyApi('onDidChange') === 'unsupported' &&
      compat.classifyApi('onDidChangeBreakpoints') === 'partial',
    'C-16b: adding the five refresh events must not promote the bare `onDidChange` or disturb an event that registers and never fires.',
  );
  assert(
    compat.classifyApi('resolveWorkspaceSymbol') === 'supported' &&
      shim.includes("'workspaceSymbol:resolve'"),
    'C-17: the optional half of a workspace symbol provider is called for the picked symbol, so a provider that implements it is not reaching a stub.',
  );
}

// --------------------------------------------------------------------------
// Phase 6 — the VS Code language platform
//
// Every provider result an extension returns crosses `vscodeLanguageWire.ts`, so the
// wire normalisers are where the observable behaviour of each feature lives: a kind that
// shifts wrong recolours every icon, a snippet that loses `insertTextFormat` is inserted
// literally. The suites below assert those contracts directly, and use static-source
// assertions (the `validateWorkbenchSecurity` pattern) for the claims that live in the
// non-pure layers — cancellation propagation, provider disposal, Monaco-public-API-only
// bridging — which cannot be exercised without an Electron process.
// --------------------------------------------------------------------------
const phase6Read = (relative) =>
  fs.readFileSync(path.join(root, 'apps', 'desktop', relative), 'utf8');

function validatePhase6Diagnostics() {
  const host = load(`${COMMON}vscodeHost.ts`);
  const diag = (extra) => host.normalizeHostDiagnostics([{ ...extra }])[0];
  const one = (extra) => diag({ path: 'a.ts', message: 'boom', ...extra });

  assert(
    host.normalizeHostDiagnostics([{ message: 'no path' }]).length === 0,
    'D6-1: a diagnostic with no path must be dropped, not drawn at the origin.',
  );
  assert(
    host.normalizeHostDiagnostics([{ path: 'a.ts' }]).length === 0,
    'D6-2: a diagnostic with no message must be dropped rather than shown blank.',
  );
  assert(
    host.normalizeHostDiagnostics([['a.ts', 'boom']]).length === 0,
    'D6-3: an array is not a diagnostic and must be rejected.',
  );
  const clamped = one({ startLine: -4, startColumn: -9 });
  assert(
    clamped.startLine === 0 && clamped.startColumn === 0,
    'D6-4: negative positions must clamp to zero.',
  );
  const floored = one({ startLine: 3.9, startColumn: 2.7 });
  assert(
    floored.startLine === 3 && floored.startColumn === 2,
    'D6-5: fractional positions must floor to integers Monaco can draw.',
  );
  assert(
    one({ startLine: 5, endLine: 2 }).endLine === 5,
    'D6-6: an inverted range must be ordered, not rendered backwards.',
  );
  assert(
    one({ startLine: 1, endLine: 1, startColumn: 9, endColumn: 2 }).endColumn === 9,
    'D6-7: on one line the end column must not precede the start column.',
  );
  assert(
    one({ startLine: 1, endLine: 3, startColumn: 9, endColumn: 2 }).endColumn === 2,
    'D6-8: across lines the end column is independent and must be preserved.',
  );
  assert(
    one({ severity: 'nonsense' }).severity === 'error',
    'D6-9: an unknown severity must default to error.',
  );
  assert(
    one({ severity: 'hint' }).severity === 'hint' && one({ severity: 'info' }).severity === 'info',
    'D6-10: the four LSP severities must survive normalisation.',
  );
  const bare = one({});
  assert(bare.source === '' && bare.code === '', 'D6-11: source and code must default to empty.');
  assert(
    bare.tags === undefined && bare.relatedInformation === undefined && bare.codeHref === undefined,
    'D6-12: Phase 6 fields must stay absent for a Phase 5 shaped diagnostic (additive change).',
  );
  const tagged = one({ tags: [1, 'unnecessary', 2] });
  assert(
    JSON.stringify(tagged.tags) === '["unnecessary","deprecated"]',
    'D6-13: diagnostic tags must accept enum numbers and wire names, deduplicated.',
  );
  assert(
    one({ tags: [7, 'nope'] }).tags === undefined,
    'D6-14: an unknown diagnostic tag must not reach the marker.',
  );
  const related = one({
    relatedInformation: [{ path: 'b.ts', message: 'here' }, { message: 'no path' }],
  });
  assert(
    related.relatedInformation.length === 1 && related.relatedInformation[0].path === 'b.ts',
    'D6-15: related information without a path must be dropped.',
  );
  const flood = one({
    relatedInformation: Array.from({ length: host.MAX_HOST_DIAGNOSTIC_RELATED + 5 }, () => ({
      path: 'b.ts',
      message: 'x',
    })),
  });
  assert(
    flood.relatedInformation.length === host.MAX_HOST_DIAGNOSTIC_RELATED,
    'D6-16: related information must be capped.',
  );
  assert(
    one({ codeHref: 'https://x/y' }).codeHref === 'https://x/y',
    'D6-17: a diagnostic code link must survive so the marker can be clicked through.',
  );
  assert(
    one({ codeHref: '' }).codeHref === undefined,
    'D6-18: an empty code link must be omitted rather than rendered.',
  );
  const many = host.normalizeHostDiagnostics(
    Array.from({ length: host.MAX_HOST_DIAGNOSTICS + 25 }, () => ({
      path: 'a.ts',
      message: 'boom',
    })),
  );
  assert(
    many.length === host.MAX_HOST_DIAGNOSTICS,
    'D6-19: a diagnostic flood must be capped, not held resident.',
  );
  assert(
    host.validateHostRequest('languages.setDiagnostics', { entries: [] }).ok === false,
    'D6-20: setDiagnostics without an owner must be refused (an owner names the collection).',
  );
  assert(
    host.validateHostRequest('languages.setDiagnostics', { owner: 'eslint' }).ok === false,
    'D6-21: setDiagnostics without an entries array must be refused.',
  );
  const request = host.validateHostRequest('languages.setDiagnostics', {
    owner: 'eslint',
    entries: [{ path: 'a.ts', message: 'boom' }],
  });
  assert(
    request.ok === true && request.payload.owner === 'eslint',
    'D6-22: a well-formed setDiagnostics request must validate.',
  );
  const capped = host.validateHostRequest('languages.setDiagnostics', {
    owner: 'eslint',
    entries: Array.from({ length: 2_500 }, () => ({})),
  });
  assert(
    capped.ok === true && capped.payload.entries.length === 2_000,
    'D6-23: the request payload must cap entries before any handler sees them.',
  );
}
function validatePhase6Completion() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const item = (value, context) => wire.toWireCompletionItem(value, context ?? {});

  const plain = item('map');
  assert(
    plain.label === 'map' && plain.kind === undefined,
    'CP-1: a bare string completion is legal and must normalise to a label alone.',
  );
  assert(item({}) === undefined, 'CP-2: an item with no label must be dropped.');
  const labelled = item({ label: { label: 'map', detail: '(fn)', description: 'Array' } });
  assert(
    labelled.label === 'map' &&
      labelled.labelDetail === '(fn)' &&
      labelled.labelDescription === 'Array',
    'CP-3: CompletionItemLabel detail and description must reach the wire.',
  );
  assert(
    item({ label: 'x', kind: 2 }).kind === 3,
    'CP-4: vscode kinds are zero-based and must shift one place to LSP.',
  );
  assert(
    item({ label: 'x' }).kind === 1,
    'CP-5: a missing kind must fall back to Text rather than encode a wrong icon.',
  );
  assert(
    item({ label: 'x', kind: 'function' }).kind === 1,
    'CP-6: a non-numeric kind must fall back rather than throw.',
  );
  const literal = item({ label: 'x', insertText: 'a(b)' });
  assert(
    literal.insertText === 'a(b)' && literal.insertTextFormat === 1,
    'CP-7: a string insertText must be marked as plain text.',
  );
  const snippet = item({ label: 'x', insertText: { value: 'a(${1:b})' } });
  assert(
    snippet.insertText === 'a(${1:b})' && snippet.insertTextFormat === 2,
    'CP-8: a SnippetString insertText must be marked as a snippet (insertTextRules).',
  );
  const zero = { line: 0, character: 0 };
  const dual = item({
    label: 'x',
    range: { inserting: { start: zero, end: zero }, replacing: { start: zero, end: zero } },
  });
  assert(
    dual.insertRange !== undefined && dual.replaceRange !== undefined,
    'CP-9: an insert/replace range pair must carry both ranges Monaco needs.',
  );
  const single = item({ label: 'x', range: { start: zero, end: zero } });
  assert(
    single.replaceRange !== undefined && single.insertRange === undefined,
    'CP-10: a plain range is the replace range.',
  );
  assert(
    JSON.stringify(item({ label: 'x', commitCharacters: ['.', '.', 'abc'] }).commitCharacters) ===
      '[".","a"]',
    'CP-11: commit characters must be single characters, deduplicated.',
  );
  const deprecated = item({ label: 'x', tags: [1] });
  assert(
    deprecated.deprecated === true && JSON.stringify(deprecated.tags) === '[1]',
    'CP-12: the Deprecated tag must also set the flag Monaco renders.',
  );
  const sorted = item({ label: 'x', sortText: '0001', filterText: 'map', preselect: true });
  assert(
    sorted.sortText === '0001' && sorted.filterText === 'map' && sorted.preselect === true,
    'CP-13: sortText, filterText and preselect must survive — they are the list order.',
  );
  const markdown = item({ label: 'x', documentation: { value: '**bold**' } });
  assert(
    markdown.documentation === '**bold**' && markdown.documentationIsMarkdown === true,
    'CP-14: MarkdownString documentation must be flagged as markdown.',
  );
  assert(
    item({ label: 'x', documentation: 'plain' }).documentationIsMarkdown === undefined,
    'CP-15: string documentation must not be flagged as markdown.',
  );
  const additional = item({
    label: 'x',
    additionalTextEdits: [{ range: { start: zero, end: zero }, newText: "import x from 'y';\n" }],
  });
  assert(
    additional.additionalTextEdits.length === 1,
    'CP-16: additionalTextEdits are how auto-import works and must reach the wire.',
  );
  const commanded = item({
    label: 'x',
    command: { command: 'editor.action.triggerSuggest', title: 'More' },
  });
  assert(
    commanded.command.command === 'editor.action.triggerSuggest',
    'CP-17: an item command must survive normalisation.',
  );
  const minted = item({ label: 'x' }, { mint: () => 77 });
  assert(minted.id === 77, 'CP-18: a resolvable item must carry the token resolve() arrives with.');
  assert(
    item({ label: 'x' }).id === undefined,
    'CP-19: without a mint an item must simply be unresolvable, not broken.',
  );
  const list = wire.toWireCompletionList([{ label: 'a' }, { label: 'b' }]);
  assert(
    list.items.length === 2 && list.isIncomplete === undefined,
    'CP-20: a bare array of items is a complete list.',
  );
  assert(
    wire.toWireCompletionList({ items: [{ label: 'a' }], isIncomplete: true }).isIncomplete ===
      true,
    'CP-21: isIncomplete must propagate or stale suggestions stay on screen.',
  );
  const overflow = wire.toWireCompletionList(
    Array.from({ length: wire.MAX_COMPLETION_ITEMS + 10 }, (_unused, i) => ({ label: `i${i}` })),
  );
  assert(
    overflow.items.length === wire.MAX_COMPLETION_ITEMS && overflow.isIncomplete === true,
    'CP-22: a truncated list is incomplete by definition and must say so.',
  );
  assert(
    wire.toWireCompletionList(null) === undefined && wire.toWireCompletionList(42) === undefined,
    'CP-23: a provider that returned nothing usable must produce no list.',
  );
  const resolved = wire.normalizeProviderResult('completion', 'resolve', { label: 'a' }, {});
  assert(
    resolved.label === 'a' && resolved.items === undefined,
    'CP-24: resolveCompletionItem returns one item, not a list.',
  );
  const provided = wire.normalizeProviderResult('completion', 'provide', [{ label: 'a' }], {});
  assert(
    Array.isArray(provided.items) && provided.items.length === 1,
    'CP-25: provideCompletionItems must normalise to a list.',
  );
  const merged = wire.mergeWireResults('completion', [
    { items: [{ label: 'a' }] },
    { items: [{ label: 'b' }], isIncomplete: true },
  ]);
  assert(
    merged.items.length === 2 && merged.isIncomplete === true,
    'CP-26: several completion providers must merge, and incompleteness must OR.',
  );
  assert(
    wire.mergeWireResults('completion', [null, undefined]) === null,
    'CP-27: providers that all returned nothing must merge to nothing.',
  );
}
function validatePhase6Hover() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const zero = { line: 0, character: 0 };

  const single = wire.toWireHover({ contents: 'plain text' });
  assert(
    single.contents.length === 1 && single.contents[0].value === 'plain text',
    'HV-1: a string hover must become one block.',
  );
  const two = wire.toWireHover({ contents: ['first', { value: 'second' }] });
  assert(
    two.contents.length === 2,
    'HV-2: hover contents must stay an array — each entry is its own rendered block.',
  );
  assert(
    wire.toWireHover({ contents: ['', '   '] }) === undefined,
    'HV-3: a hover with nothing to show must be no hover at all.',
  );
  const ranged = wire.toWireHover({ contents: 'x', range: { start: zero, end: zero } });
  assert(ranged.range !== undefined, 'HV-4: a hover range must survive so Monaco can anchor it.');
  const capped = wire.toWireHover({
    contents: Array.from({ length: wire.MAX_HOVER_BLOCKS + 8 }, (_unused, i) => `b${i}`),
  });
  assert(capped.contents.length === wire.MAX_HOVER_BLOCKS, 'HV-5: hover blocks must be capped.');

  const stripped = wire.sanitizeMarkdown('<script>alert(1)</script>hello');
  assert(
    !stripped.value.includes('<script') && stripped.value.includes('hello'),
    'HV-6: raw HTML outside a fence must be stripped, keeping the text.',
  );
  assert(
    !wire.sanitizeMarkdown('a<!-- sneaky -->b').value.includes('sneaky'),
    'HV-7: HTML comments must be removed.',
  );
  const fenced = wire.sanitizeMarkdown('```html\n<div>kept</div>\n```');
  assert(
    fenced.value.includes('<div>kept</div>'),
    'HV-8: a fenced code sample is content and must pass through untouched.',
  );
  const unsafeLink = wire.sanitizeMarkdown('[click](javascript:alert(1))');
  assert(
    !unsafeLink.value.includes('javascript:') && unsafeLink.value.includes('click'),
    'HV-9: an unsafe link target must be unlinked, not silently deleted.',
  );
  const commandLink = wire.sanitizeMarkdown('[Show](command:gitlens.showView)', {
    allowCommands: true,
  });
  assert(
    commandLink.value.includes('command:gitlens.showView') &&
      JSON.stringify(commandLink.commands) === '["gitlens.showView"]',
    'HV-10: an allowed command link must be kept and the exact id reported for enablement.',
  );
  const refused = wire.sanitizeMarkdown('[Show](command:gitlens.showView)');
  assert(
    !refused.value.includes('command:') && refused.commands === undefined,
    'HV-11: command links must be refused unless the caller allows them.',
  );
  const hoverCommand = wire.toWireHover({ contents: '[Show](command:a.b)' });
  assert(
    JSON.stringify(hoverCommand.contents[0].commands) === '["a.b"]',
    'HV-12: hovers allow command links by default — that is what extensions put there.',
  );
  const hoverNoCommand = wire.toWireHover(
    { contents: '[Show](command:a.b)' },
    {
      allowCommands: false,
    },
  );
  assert(
    hoverNoCommand === undefined || hoverNoCommand.contents[0].commands === undefined,
    'HV-13: a caller that disallows commands must get none.',
  );
  assert(
    Object.keys(wire.sanitizeMarkdown('x')).every((key) => key === 'value' || key === 'commands'),
    'HV-14: sanitised markdown must carry nothing but text and command ids (never supportHtml).',
  );
  assert(
    !phase6Read('src/common/vscodeLanguageWire.ts').includes('supportHtml: true'),
    'HV-15: the wire must never enable HTML rendering in a markdown string.',
  );
  const marked = wire.markdownSource({ language: 'ts', value: 'const a = 1;' });
  assert(
    marked.startsWith('```ts\n') && marked.endsWith('\n```'),
    'HV-16: an LSP MarkedString must become a fenced block for its language.',
  );
  const stacked = wire.mergeWireResults('hover', [
    { contents: [{ value: 'a' }], range: { start: zero, end: zero } },
    { contents: [{ value: 'b' }] },
  ]);
  assert(
    stacked.contents.length === 2 && stacked.range !== undefined,
    'HV-17: several hover providers must stack, keeping the first range.',
  );
}
function validatePhase6SignatureHelp() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const help = (value) => wire.toWireSignatureHelp(value);

  assert(help({}) === undefined, 'SH-1: signature help without a signatures array is not help.');
  assert(
    help({ signatures: [{ label: '' }] }) === undefined,
    'SH-2: a signature with no label must be dropped, and an empty result must be no result.',
  );
  const basic = help({
    signatures: [{ label: 'f(a, b)', parameters: ['a', 'b'] }],
    activeSignature: 0,
    activeParameter: 1,
  });
  assert(
    basic.signatures.length === 1 && basic.signatures[0].parameters.length === 2,
    'SH-3: string parameter labels are legal and must survive.',
  );
  assert(
    basic.activeSignature === 0 && basic.activeParameter === 1,
    'SH-4: the active signature and parameter drive the highlight and must be carried.',
  );
  const clamped = help({ signatures: [{ label: 'f()' }], activeSignature: 9 });
  assert(
    clamped.activeSignature === 0,
    'SH-5: activeSignature must clamp to the signatures actually sent.',
  );
  const offsets = help({
    signatures: [{ label: 'f(a, b)', parameters: [{ label: [4, 2] }] }],
  });
  assert(
    JSON.stringify(offsets.signatures[0].parameters[0].labelOffsets) === '[2,4]' &&
      offsets.signatures[0].parameters[0].label === '',
    'SH-6: an offset parameter label must be ordered and must not invent label text.',
  );
  const docs = help({
    signatures: [
      {
        label: 'f()',
        documentation: { value: '_doc_' },
        parameters: [{ label: 'a', documentation: 'p' }],
      },
    ],
  });
  assert(
    docs.signatures[0].documentation === '_doc_' &&
      docs.signatures[0].documentationIsMarkdown === true,
    'SH-7: signature documentation must keep its markdown flag.',
  );
  assert(
    docs.signatures[0].parameters[0].documentation === 'p' &&
      docs.signatures[0].parameters[0].documentationIsMarkdown === undefined,
    'SH-8: a parameter documented with a plain string must not be flagged as markdown.',
  );
  const perSignature = help({
    signatures: [{ label: 'f(a)', activeParameter: 0, parameters: ['a'] }],
  });
  assert(
    perSignature.signatures[0].activeParameter === 0,
    'SH-9: a per-signature activeParameter must be preserved alongside the global one.',
  );
  const manySignatures = help({
    signatures: Array.from({ length: wire.MAX_SIGNATURES + 4 }, () => ({ label: 'f()' })),
  });
  assert(
    manySignatures.signatures.length === wire.MAX_SIGNATURES,
    'SH-10: signatures must be capped.',
  );
  const manyParameters = help({
    signatures: [
      { label: 'f()', parameters: Array.from({ length: wire.MAX_PARAMETERS + 4 }, () => 'p') },
    ],
  });
  assert(
    manyParameters.signatures[0].parameters.length === wire.MAX_PARAMETERS,
    'SH-11: parameters must be capped per signature.',
  );
  const registry = load(`${COMMON}vscodeLanguages.ts`);
  const providers = new registry.ProviderRegistry();
  providers.register({
    extensionId: 'a',
    feature: 'signatureHelp',
    selector: 'typescript',
    metadata: registry.normalizeProviderMetadata({
      triggerCharacters: ['(', ',', 'abc'],
      retriggerCharacters: [')'],
    }),
  });
  const document = { languageId: 'typescript', scheme: 'file', path: '/w/a.ts' };
  assert(
    JSON.stringify(providers.triggerCharactersFor('signatureHelp', document)) === '["(",",","a"]',
    'SH-12: signature trigger characters must be single characters, as Monaco takes them.',
  );
  assert(
    JSON.stringify(providers.triggerCharactersFor('signatureHelp', document, 'retrigger')) ===
      '[")"]',
    'SH-13: retrigger characters are a separate set and must not be merged into triggers.',
  );
  const stackedHelp = wire.mergeWireResults('signatureHelp', [
    { signatures: [{ label: 'a', parameters: [] }], activeSignature: 0, activeParameter: 0 },
    { signatures: [{ label: 'b', parameters: [] }], activeSignature: 0, activeParameter: 0 },
  ]);
  assert(
    stackedHelp.signatures[0].label === 'a',
    'SH-14: signature help stacks — the first provider owns the widget, as upstream does.',
  );
}
function validatePhase6Navigation() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const zero = { line: 0, character: 0 };
  const range = { start: zero, end: { line: 0, character: 4 } };

  const location = wire.toWireLocationLink({ uri: 'file:///w/a.ts', range });
  assert(
    location.uri === 'file:///w/a.ts' && location.range.end.character === 4,
    'NAV-1: a plain Location must normalise to a link with the same target.',
  );
  const link = wire.toWireLocationLink({
    targetUri: 'file:///w/a.ts',
    targetRange: range,
    targetSelectionRange: range,
    originSelectionRange: range,
  });
  assert(
    link.targetSelectionRange !== undefined && link.originSelectionRange !== undefined,
    'NAV-2: a LocationLink carries two extra ranges and both must reach the peek widget.',
  );
  assert(
    wire.toWireLocationLink({ uri: 'javascript:alert(1)', range }) === undefined,
    'NAV-3: a result must never point the editor at an executable scheme.',
  );
  assert(
    wire.toWireLocationLink({ uri: 'http://example.com/a.ts', range }) === undefined,
    'NAV-4: a document URI is whitelisted to document schemes; http is not one of them.',
  );
  assert(
    wire.toWireUri({ scheme: 'file', path: '/w/a.ts' }) === 'file:///w/a.ts',
    'NAV-5: a vscode.Uri object must be read field by field, not stringified.',
  );
  assert(
    wire.toWireUri({ toString: () => 'file:///w/evil.ts' }) === undefined,
    "NAV-6: an extension's own toString() must never be trusted to produce a URI.",
  );
  assert(
    wire.toWireUri('file:///w/a.ts', wire.UNSAFE_URI_SCHEMES) === undefined,
    'NAV-7: the unsafe-scheme set must be refused even when passed as the allowed set.',
  );
  const inverted = wire.toWireRange({ start: { line: 5, character: 0 }, end: zero });
  assert(
    inverted.start.line === 0 && inverted.end.line === 5,
    'NAV-8: an inverted range means the span between the two positions.',
  );
  assert(
    JSON.stringify(wire.toWirePosition([2, 3])) === '{"line":2,"character":3}',
    'NAV-9: a position given as a tuple must be read — helper libraries produce them.',
  );
  const singleDefinition = wire.normalizeProviderResult(
    'definition',
    'provide',
    { uri: 'file:///w/a.ts', range },
    {},
  );
  assert(
    Array.isArray(singleDefinition) && singleDefinition.length === 1,
    'NAV-10: a provider may return one Location or many; the wire form is always a list.',
  );
  const references = wire.normalizeProviderResult(
    'reference',
    'provide',
    Array.from({ length: wire.MAX_RESULT_ITEMS + 20 }, () => ({ uri: 'file:///w/a.ts', range })),
    {},
  );
  assert(
    references.length === wire.MAX_RESULT_ITEMS,
    'NAV-11: a reference search over a large workspace must be capped.',
  );
  const concatenated = wire.mergeWireResults('definition', [
    [{ uri: 'file:///w/a.ts', range }],
    [{ uri: 'file:///w/b.ts', range }],
  ]);
  assert(
    concatenated.length === 2,
    'NAV-12: definitions from several providers must concatenate, in provider order.',
  );
  const symbols = wire.normalizeProviderResult(
    'documentSymbol',
    'provide',
    [
      {
        name: 'Klass',
        kind: 4,
        range,
        selectionRange: range,
        children: [{ name: 'm', kind: 5, range }],
      },
      { name: 'flat', kind: 12, location: { uri: 'file:///w/a.ts', range } },
    ],
    {},
  );
  assert(
    symbols.symbols.length === 1 && symbols.flat.length === 1,
    'NAV-13: DocumentSymbol trees and SymbolInformation lists must be told apart by shape.',
  );
  assert(
    symbols.symbols[0].children.length === 1 && symbols.symbols[0].kind === 5,
    'NAV-14: a symbol tree must keep its children, and kinds must shift to LSP.',
  );
  const workspaceSymbols = wire.normalizeProviderResult(
    'workspaceSymbol',
    'provide',
    [{ name: 'Klass', kind: 4, location: { uri: 'file:///w/a.ts', range } }],
    { mint: () => 5 },
  );
  assert(
    workspaceSymbols[0].id === 5 && workspaceSymbols[0].location.uri === 'file:///w/a.ts',
    'NAV-15: a workspace symbol must carry a token so Quick Open can open it.',
  );
}
function validatePhase6Rename() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const zero = { line: 0, character: 0 };
  const range = { start: zero, end: { line: 0, character: 4 } };
  const prepare = (value) => wire.normalizeProviderResult('rename', 'prepare', value, {});

  assert(
    prepare({ start: zero, end: range.end }).range.end.character === 4,
    'RN-1: prepareRename may return a bare Range and must be read as one.',
  );
  const placeholder = prepare({ range, placeholder: 'oldName' });
  assert(
    placeholder.placeholder === 'oldName' && placeholder.range !== undefined,
    'RN-2: a placeholder tells the user what they are renaming and must be carried.',
  );
  assert(prepare({}) === null, 'RN-3: prepareRename without a range must refuse the rename.');
  const edit = wire.normalizeProviderResult(
    'rename',
    'provide',
    {
      _operations: [
        { kind: 'text', uri: 'file:///w/a.ts', edits: [{ range, newText: 'newName' }] },
        {
          kind: 'rename',
          uri: 'file:///w/a.ts',
          newUri: 'file:///w/b.ts',
          options: { overwrite: true },
        },
      ],
    },
    {},
  );
  assert(
    edit.entries.length === 2 && edit.entries[0].kind === 'text',
    'RN-4: a rename WorkspaceEdit must keep every operation, in the order the extension built it.',
  );
  assert(
    edit.entries[1].newUri === 'file:///w/b.ts' && edit.entries[1].overwrite === true,
    'RN-5: a file rename inside a WorkspaceEdit must carry its destination and options.',
  );
  const mapForm = wire.toWireWorkspaceEdit({
    changes: { 'file:///w/a.ts': [{ range, newText: 'x' }] },
  });
  assert(
    mapForm.entries.length === 1 && mapForm.entries[0].kind === 'text',
    'RN-6: a changes-map WorkspaceEdit must also be readable (a re-read of a wire edit).',
  );
  assert(
    wire.toWireWorkspaceEdit({ _operations: [] }) === undefined,
    'RN-7: an empty WorkspaceEdit must be no edit rather than an empty apply.',
  );
  assert(
    wire.toWireWorkspaceEdit({
      _operations: [{ kind: 'text', uri: 'javascript:x', edits: [{ range, newText: 'x' }] }],
    }) === undefined,
    'RN-8: an edit aimed at an unsafe scheme must not survive the wire.',
  );
  const snippetEdit = wire.toWireTextEdit({ range, snippet: { value: 'name${1:Suffix}' } });
  assert(
    snippetEdit.insertAsSnippet === true && snippetEdit.newText === 'name${1:Suffix}',
    'RN-9: a SnippetTextEdit must be flagged so it is inserted as a snippet, not literally.',
  );
  assert(
    wire.toWireTextEdit({ range, newText: 'plain' }).insertAsSnippet === undefined,
    'RN-10: a plain TextEdit must not be applied as a snippet.',
  );
  assert(
    wire.toWireTextEdit({ newText: 'x' }) === undefined,
    'RN-11: a text edit with no range cannot be applied and must be dropped.',
  );
  const registry = load(`${COMMON}vscodeLanguages.ts`);
  const providers = new registry.ProviderRegistry();
  providers.register({
    extensionId: 'a',
    feature: 'rename',
    selector: 'typescript',
    metadata: registry.normalizeProviderMetadata({ hasPrepare: true }),
  });
  providers.register({ extensionId: 'b', feature: 'rename', selector: 'typescript' });
  const document = { languageId: 'typescript', scheme: 'file', path: '/w/a.ts' };
  const selection = providers.select('rename', document);
  assert(
    selection.strategy === 'single' && selection.providers.length === 1,
    'RN-12: rename is single-provider — running two would corrupt the buffer.',
  );
  assert(
    selection.needsPicker === true,
    'RN-13: two equally specific rename providers from different extensions need a picker.',
  );
  assert(
    providers.get(selection.providers[0].handle).metadata.hasPrepare === undefined ||
      selection.providers[0].extensionId === 'b',
    'RN-14: the later registration wins a score tie, matching upstream.',
  );
  assert(
    registry.normalizeProviderMetadata({ hasPrepare: 'yes' }).hasPrepare === undefined,
    'RN-15: prepareRename support is a claim the worker makes explicitly, never inferred loosely.',
  );
}
function validatePhase6Formatting() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const selectors = load(`${COMMON}documentSelector.ts`);
  const registry = load(`${COMMON}vscodeLanguages.ts`);
  const zero = { line: 0, character: 0 };
  const range = { start: zero, end: { line: 0, character: 2 } };
  const format = (feature, value) => wire.normalizeProviderResult(feature, 'provide', value, {});

  const edits = format('formatting', [
    { range, newText: '  ' },
    { range, newText: '' },
  ]);
  assert(
    Array.isArray(edits) && edits.length === 2,
    'FMT-1: formatting returns Monaco edits directly, as an array.',
  );
  assert(
    format('formatting', { range, newText: 'x' }).length === 1,
    'FMT-2: a single edit returned bare must still normalise to a list.',
  );
  assert(
    format('rangeFormatting', [{ range, newText: 'x' }]).length === 1 &&
      format('onTypeFormatting', [{ range, newText: 'x' }]).length === 1,
    'FMT-3: range and on-type formatting share the text-edit form.',
  );
  assert(
    format('formatting', [{ newText: 'x' }, { range, newText: 'y' }]).length === 1,
    'FMT-4: an edit with no range must be dropped without failing the whole format.',
  );
  const flood = format(
    'formatting',
    Array.from({ length: wire.MAX_EDITS + 50 }, () => ({ range, newText: 'x' })),
  );
  assert(flood.length === wire.MAX_EDITS, 'FMT-5: formatting edits must be capped.');
  assert(
    selectors.mergeStrategyFor('formatting') === 'single' &&
      selectors.mergeStrategyFor('rangeFormatting') === 'single' &&
      selectors.mergeStrategyFor('onTypeFormatting') === 'single',
    'FMT-6: all three formatting features are single-provider.',
  );
  const providers = new registry.ProviderRegistry();
  providers.register({ extensionId: 'prettier', feature: 'formatting', selector: 'typescript' });
  providers.register({ extensionId: 'eslint', feature: 'formatting', selector: '*' });
  const document = { languageId: 'typescript', scheme: 'file', path: '/w/a.ts' };
  const chosen = providers.select('formatting', document);
  assert(
    chosen.providers.length === 1 && chosen.providers[0].extensionId === 'prettier',
    'FMT-7: the more specific formatter must win over a wildcard registration.',
  );
  assert(
    chosen.needsPicker === false,
    'FMT-8: a clear winner on specificity must not prompt the user.',
  );
  const onType = registry.normalizeProviderMetadata({
    firstTriggerCharacter: ';}',
    moreTriggerCharacter: ['\n', ';;'],
  });
  assert(
    onType.firstTriggerCharacter === ';',
    'FMT-9: on-type formatting takes exactly one first trigger character.',
  );
  assert(
    JSON.stringify(onType.moreTriggerCharacter) === '["\\n",";"]',
    'FMT-10: further on-type trigger characters must be single characters.',
  );
  const wse = load(`${COMMON}vscodeWorkspaceEdit.ts`);
  const unsorted = [
    { range: { start: zero, end: { line: 0, character: 1 } }, newText: 'a' },
    { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }, newText: 'b' },
  ];
  const sorted = wse.sortTextEditsForApply(unsorted);
  assert(
    sorted[0].newText === 'b',
    'FMT-11: edits must apply last-first so earlier offsets stay valid.',
  );
  assert(
    wse.textEditsOverlap(sorted) === false,
    'FMT-12: disjoint edits must not be reported as overlapping.',
  );
  const touching = wse.sortTextEditsForApply([
    { range: { start: zero, end: { line: 0, character: 2 } }, newText: 'a' },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: 'b' },
  ]);
  assert(
    wse.textEditsOverlap(touching) === false,
    'FMT-13: edits that merely touch are legal and must not be refused.',
  );
  const overlapping = wse.sortTextEditsForApply([
    { range: { start: zero, end: { line: 0, character: 4 } }, newText: 'a' },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } }, newText: 'b' },
  ]);
  assert(
    wse.textEditsOverlap(overlapping) === true,
    'FMT-14: genuinely overlapping edits must be detected — the result would depend on order.',
  );
}
function validatePhase6SemanticTokens() {
  const st = load(`${COMMON}vscodeSemanticTokens.ts`);
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);

  const legend = st.normalizeSemanticTokensLegend({
    tokenTypes: ['class', 'bad name', 'class', 42, 'variable'],
    tokenModifiers: ['declaration', 'readonly'],
  });
  assert(
    legend !== null && legend.tokenTypes.join(',') === 'class,variable',
    'ST-1: legend names that cannot be a theme scope, duplicates and non-strings are dropped.',
  );
  assert(
    st.normalizeSemanticTokensLegend({ tokenModifiers: ['readonly'] }) === null,
    'ST-2: a legend with no usable token type is rejected — every index would be unresolvable.',
  );
  assert(
    st.semanticTokensLegendEquals(legend, {
      tokenTypes: ['class', 'variable'],
      tokenModifiers: ['declaration', 'readonly'],
    }) === true,
    'ST-3: legends compare by value, so re-registration does not force a re-tokenise.',
  );
  assert(
    st.semanticTokensLegendEquals(legend, {
      tokenTypes: ['variable', 'class'],
      tokenModifiers: ['declaration', 'readonly'],
    }) === false,
    'ST-4: legend order is part of the legend — indices mean different types.',
  );
  assert(
    st.resolveTokenType(legend, 'variable') === 1 && st.resolveTokenType(legend, 'nope') === -1,
    'ST-5: an unknown token type reports -1 rather than colliding with index 0.',
  );
  assert(
    st.resolveTokenModifiers(legend, ['readonly', 'nope', 'declaration']) === 0b11,
    'ST-6: unknown modifiers are skipped without shifting the ones after them.',
  );

  const encoded = st.encodeSemanticTokens([
    { line: 2, character: 4, length: 3, tokenType: 0, tokenModifiers: 0 },
    { line: 0, character: 1, length: 2, tokenType: 1, tokenModifiers: 1 },
    { line: 2, character: 10, length: 4, tokenType: 1, tokenModifiers: 0 },
  ]);
  assert(
    encoded.join(',') === '0,1,2,1,1,2,4,3,0,0,0,6,4,1,0',
    'ST-7: tokens sort into document order and encode deltas (same-line start is relative).',
  );
  assert(
    st.encodeSemanticTokens([
      { line: 0, character: 0, length: 0, tokenType: 0, tokenModifiers: 0 },
      { line: -1, character: 0, length: 1, tokenType: 0, tokenModifiers: 0 },
      { line: 0, character: 0, length: 1, tokenType: 0, tokenModifiers: 0 },
    ]).length === 5,
    'ST-8: zero-length and negative tokens drop instead of poisoning later deltas.',
  );
  assert(
    st.normalizeSemanticTokensData([0, 0, 1, 0, 0]).length === 5 &&
      st.normalizeSemanticTokensData(new Uint32Array([0, 0, 1, 0, 0])).length === 5,
    'ST-9: an encoded array is accepted as an array or as a builder Uint32Array.',
  );
  assert(
    st.normalizeSemanticTokensData([0, 0, 1, 0]) === null &&
      st.normalizeSemanticTokensData([0, 0, 1, 0, -1]) === null,
    'ST-10: a ragged or negative buffer is rejected outright, never truncated into phase.',
  );
  const baseline = [0, 0, 1, 0, 0, 1, 0, 2, 1, 0];
  const edits = st.normalizeSemanticTokensEdits(
    [{ start: 5, deleteCount: 5, data: [2, 0, 3, 1, 0] }],
    baseline.length,
  );
  assert(
    Array.isArray(edits) && edits.length === 1 && edits[0].start === 5,
    'ST-11: a well-formed baseline-relative edit is accepted.',
  );
  assert(
    st.normalizeSemanticTokensEdits(
      [
        { start: 5, deleteCount: 5 },
        { start: 2, deleteCount: 1 },
      ],
      baseline.length,
    ) === null,
    'ST-12: unsorted edits are rejected — offsets index one shared baseline, not each other.',
  );
  assert(
    st.normalizeSemanticTokensEdits([{ start: 8, deleteCount: 5 }], baseline.length) === null,
    'ST-13: an edit reaching past the baseline is rejected rather than clamped.',
  );
  assert(
    st.normalizeSemanticTokensEdits([{ start: 0, deleteCount: 1, data: [1, 2] }], baseline.length)
      ?.length === 1,
    'ST-14: edit payloads are runs of integers, so a non-multiple-of-five delta is legal.',
  );
  assert(
    st.applySemanticTokensEdits(baseline, edits).join(',') === '0,0,1,0,0,2,0,3,1,0',
    'ST-15: edits apply against the baseline, producing a whole number of tokens.',
  );
  assert(
    st.applySemanticTokensEdits(baseline, [{ start: 0, deleteCount: 1 }]) === null,
    'ST-16: a delta leaving a partial token is refused so Monaco never sees mis-phased tokens.',
  );
  assert(
    st.applySemanticTokensEdits(
      baseline,
      st.normalizeSemanticTokensEdits(
        [
          { start: 0, deleteCount: 0, data: [0, 0, 1, 0, 0] },
          { start: 5, deleteCount: 5, data: [] },
        ],
        baseline.length,
      ),
    ).length === 10,
    'ST-17: multiple edits apply back to front, so earlier splices do not shift later offsets.',
  );
  assert(
    st.computeSemanticTokensDelta(baseline, baseline).length === 0,
    'ST-18: an unchanged result diffs to no edits, which the caller reports as unchanged.',
  );
  const delta = st.computeSemanticTokensDelta(baseline, [0, 0, 1, 0, 0, 1, 0, 9, 1, 0]);
  assert(
    delta.length === 1 &&
      delta[0].start === 7 &&
      delta[0].deleteCount === 1 &&
      delta[0].data.join(',') === '9',
    'ST-19: a one-field change diffs to one integer, not to the whole buffer.',
  );
  assert(
    st.applySemanticTokensEdits(baseline, st.computeSemanticTokensDelta(baseline, [0, 0, 1, 0, 0]))
      .length === 5,
    'ST-20: a computed delta round-trips through the applier (truncation case).',
  );
  const cache = new st.SemanticTokensCache(2);
  const firstId = cache.store(1, 'file:///a.ts', 7, baseline.slice());
  assert(
    typeof firstId === 'string' && firstId.length > 0,
    'ST-21: storing tokens mints the resultId a delta request is later asked against.',
  );
  assert(
    cache.store(1, 'file:///a.ts', 8, baseline.slice()) !== firstId,
    'ST-22: every stored result gets a fresh id, so a stale id is never honoured.',
  );
  const stale = cache.lookup(1, 'file:///a.ts', firstId, 8);
  assert(
    stale === undefined,
    'ST-23: a resultId the cache no longer holds yields no baseline — the caller re-requests.',
  );
  const current = cache.get(1, 'file:///a.ts');
  assert(
    cache.lookup(1, 'file:///a.ts', current.resultId, 8).fresh === true &&
      cache.lookup(1, 'file:///a.ts', current.resultId, 9).fresh === false,
    'ST-24: freshness is by document version, so an edited document is not answered from cache.',
  );
  assert(
    cache.lookup(2, 'file:///a.ts', current.resultId, 8) === undefined,
    'ST-25: baselines are keyed per provider handle — one provider never sees another’s tokens.',
  );
  const applied = cache.applyEdits(1, 'file:///a.ts', current.resultId, 9, [
    { start: 5, deleteCount: 5, data: [2, 0, 3, 1, 0] },
  ]);
  assert(
    applied !== null && applied.data.join(',') === '0,0,1,0,0,2,0,3,1,0',
    'ST-26: a delta applies against the stored baseline and is stored under a new id.',
  );
  assert(
    cache.applyEdits(1, 'file:///a.ts', firstId, 10, []) === null,
    'ST-27: a delta quoting a superseded id is refused rather than applied to newer tokens.',
  );
  cache.store(3, 'file:///b.ts', 1, [0, 0, 1, 0, 0]);
  cache.store(4, 'file:///c.ts', 1, [0, 0, 1, 0, 0]);
  assert(
    cache.size === 2 && cache.get(1, 'file:///a.ts') === undefined,
    'ST-28: the cache is bounded and evicts oldest-first, so token memory cannot grow unbounded.',
  );
  assert(
    cache.invalidateProvider(3) === 1 && cache.size === 1,
    'ST-29: disposing a provider forgets its baselines before its handle can be reused.',
  );
  assert(
    cache.invalidateDocument('file:///c.ts') === 1 && cache.size === 0,
    'ST-30: closing a document forgets its tokens across every provider.',
  );

  const full = wire.normalizeProviderResult(
    'semanticTokens',
    'provide',
    { resultId: '3', data: new Uint32Array([0, 0, 1, 0, 0]) },
    {},
  );
  assert(
    full !== null && Array.isArray(full.data) && full.resultId === '3',
    'ST-31: a builder Uint32Array crosses the wire as a plain array (structured clone safety).',
  );
  assert(
    wire.normalizeProviderResult('semanticTokens', 'provide', { data: [0, 0, 1, 0, 0, 9] }, {}).data
      .length === 5,
    'ST-32: a full result is truncated to whole tokens.',
  );
  assert(
    wire.normalizeProviderResult('semanticTokens', 'provide', { data: [0, 0, -1, 0, 0] }, {}) ===
      null,
    'ST-33: a negative integer rejects the whole full result rather than colouring wrongly.',
  );
  const wireDelta = wire.normalizeProviderResult(
    'semanticTokens',
    'edits',
    { resultId: '4', edits: [{ start: 7, deleteCount: 1, data: [9] }] },
    {},
  );
  assert(
    wireDelta.edits.length === 1 && wireDelta.edits[0].data.join(',') === '9',
    'ST-34: a one-integer delta survives the wire — edit payloads are not whole-token runs.',
  );
  assert(
    Array.isArray(
      wire.normalizeProviderResult('semanticTokens', 'edits', { data: [0, 0, 1, 0, 0] }, {}).data,
    ),
    'ST-35: a provider that gives up on the delta and resends everything is accepted.',
  );
  assert(
    wire.normalizeProviderResult('semanticTokensRange', 'provide', { data: [0, 0, 1, 0, 0] }, {})
      .data.length === 5,
    'ST-36: the range variant is read with the same encoding as the document one.',
  );
}
function validatePhase6LanguageRegistration() {
  const langs = load(`${COMMON}vscodeLanguages.ts`);
  const host = load(`${COMMON}vscodeHost.ts`);

  assert(
    langs.isLanguageId('objective-c++') === true && langs.isLanguageId('my lang') === false,
    'LR-1: a language id is a selectable token — one with a space could never be matched.',
  );
  const def = langs.normalizeLanguageDefinition(
    {
      id: 'axiomscript',
      aliases: ['AxiomScript', 'axs'],
      extensions: ['.AXS', 'axs2', '.axs'],
      filenames: ['Axiomfile', 'axiomfile'],
      filenamePatterns: ['*.axs.json'],
      mimetypes: ['text/x-axs'],
      firstLine: '^#!/usr/bin/axs',
      configuration: './language-configuration.json',
    },
    { extensionId: 'pub.axs' },
  );
  assert(
    def !== null && def.extensions.join(',') === '.axs,.axs2',
    'LR-2: extensions fold to lower case with a leading dot and deduplicate.',
  );
  assert(
    def.filenames.length === 1 && def.filenames[0] === 'axiomfile',
    'LR-3: filenames fold to lower case, matching how detection compares them.',
  );
  assert(
    def.extensionId === 'pub.axs' && def.configurationPath === './language-configuration.json',
    'LR-4: the contributing extension and its configuration path are carried for later removal.',
  );
  assert(
    langs.normalizeLanguageDefinition({ aliases: ['x'] }) === null &&
      langs.normalizeLanguageDefinition({ id: 'bad id' }) === null,
    'LR-5: a definition with no usable id is refused rather than becoming unmatchable.',
  );

  const registry = new langs.LanguageRegistry();
  assert(
    registry.register(def) === true && registry.has('axiomscript') && registry.size === 1,
    'LR-6: registerLanguage() adds a language the platform then knows.',
  );
  registry.register(
    langs.normalizeLanguageDefinition(
      { id: 'axiomscript', extensions: ['.axsx'], aliases: ['AxiomScript'] },
      { extensionId: 'other.ext' },
    ),
  );
  const merged = registry.resolve('axiomscript');
  assert(
    merged.extensions.join(',') === '.axs,.axs2,.axsx' && merged.aliases.length === 2,
    'LR-7: two extensions may extend one language; contributions merge and deduplicate on read.',
  );
  assert(
    registry.ids().length === 1,
    'LR-8: getLanguages() reports each id once however many extensions contributed to it.',
  );
  assert(
    registry.removeExtension('other.ext') === 1 &&
      registry.resolve('axiomscript').extensions.join(',') === '.axs,.axs2',
    'LR-9: uninstalling an extension takes its own contributions and nothing else.',
  );
  const detect = new langs.LanguageRegistry();
  detect.register(langs.normalizeLanguageDefinition({ id: 'typescript', extensions: ['.ts'] }));
  detect.register(
    langs.normalizeLanguageDefinition({ id: 'typescriptdefinition', extensions: ['.d.ts'] }),
  );
  detect.register(
    langs.normalizeLanguageDefinition({
      id: 'dockerfile',
      filenames: ['Dockerfile'],
      filenamePatterns: ['Dockerfile.*'],
    }),
  );
  detect.register(
    langs.normalizeLanguageDefinition({ id: 'shellscript', firstLine: '^#!.*\\bsh' }),
  );
  assert(
    detect.detect({ path: '/w/src/index.ts' }) === 'typescript',
    'LR-10: a plain extension resolves to its language.',
  );
  assert(
    detect.detect({ path: '/w/src/index.d.ts' }) === 'typescriptdefinition',
    'LR-11: the longest matching extension wins, so .d.ts beats .ts as upstream does.',
  );
  assert(
    detect.detect({ path: '/w/Dockerfile' }) === 'dockerfile',
    'LR-12: an exact filename outranks every extension match.',
  );
  assert(
    detect.detect({ path: '/w/Dockerfile.dev' }) === 'dockerfile',
    'LR-13: filename patterns are consulted after exact names and before extensions.',
  );
  assert(
    detect.detect({ path: '/w/run', firstLine: '#!/bin/sh' }) === 'shellscript',
    'LR-14: firstLine is the last resort, used only when nothing about the name matched.',
  );
  assert(
    detect.detect({ path: '/w/run', firstLine: '' }) === undefined,
    'LR-15: an unmatched document has no language rather than a guessed one.',
  );
  detect.register(
    langs.normalizeLanguageDefinition({ id: 'typescriptreact', extensions: ['.ts'] }),
  );
  assert(
    detect.detect({ path: '/w/index.ts' }) === 'typescriptreact',
    'LR-16: within a tier the most recent registration wins, so a user override takes effect.',
  );
  assert(
    langs.matchesFirstLine('^(', '#!/bin/sh') === false,
    'LR-17: an unparseable firstLine pattern does not match and does not throw through detection.',
  );

  const config = langs.normalizeLanguageConfiguration({
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], { open: '(', close: ')' }, ['unterminated']],
    autoClosingPairs: [{ open: '"', close: '"', notIn: ['string', 42] }],
    wordPattern: '[A-Za-z_]\\w*',
    indentationRules: { increaseIndentPattern: '\\{$', decreaseIndentPattern: '^\\s*\\}' },
    onEnterRules: [
      { beforeText: '\\{$', action: { indent: 'indentOutdent', appendText: ' ' } },
      { beforeText: '^x$', action: { indent: 'sideways' } },
    ],
    folding: { offSide: true, markers: { start: '^//#region', end: '^//#endregion' } },
  });
  assert(
    config.comments.lineComment === '//' && config.comments.blockComment.length === 2,
    'LR-18: comment tokens survive normalisation, which is what toggle-comment reads.',
  );
  assert(
    config.brackets.length === 2,
    'LR-19: brackets accept both spellings found in real configuration files; a half pair drops.',
  );
  assert(
    config.autoClosingPairs[0].notIn.join(',') === 'string',
    'LR-20: non-string notIn scopes drop without discarding the pair.',
  );
  assert(
    config.onEnterRules.length === 1 && config.onEnterRules[0].action.indent === 'indentOutdent',
    'LR-21: an onEnter rule whose action is not a Monaco IndentAction is dropped.',
  );
  assert(
    langs.normalizeLanguageConfiguration({ wordPattern: '[' }).wordPattern === undefined,
    'LR-22: an unparseable pattern is dropped here, never compiled with eval or new Function.',
  );
  assert(
    config.folding.markers.start === '^//#region',
    'LR-23: folding markers are carried so region folding works for contributed languages.',
  );

  assert(
    host.validateHostRequest('languages.registerLanguage', { definition: { id: 'axs' } }).ok ===
      true &&
      host.validateHostRequest('languages.registerLanguage', { definition: { id: 'a b' } }).ok ===
        false,
    'LR-24: the registerLanguage request validates the definition before Main sees it.',
  );
  assert(
    host.validateHostRequest('languages.setLanguageConfiguration', {
      languageId: 'axs',
      configuration: { comments: { lineComment: '#' } },
    }).payload.configuration.comments.lineComment === '#',
    'LR-25: setLanguageConfiguration normalises the configuration as part of validation.',
  );
  assert(
    host.validateHostRequest('languages.setTextDocumentLanguage', { languageId: 'axs' }).ok ===
      false &&
      host.validateHostRequest('languages.setTextDocumentLanguage', {
        uri: 'file:///w/a.axs',
        languageId: 'axs',
      }).ok === true,
    'LR-26: setTextDocumentLanguage needs both a document and a valid language id.',
  );
  assert(
    host.validateHostRequest('languages.getLanguages', undefined).ok === true,
    'LR-27: getLanguages takes no payload and is accepted with none.',
  );
}
function validatePhase6CodeActions() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const langs = load(`${COMMON}vscodeLanguages.ts`);
  const selectors = load(`${COMMON}documentSelector.ts`);
  const zero = { line: 0, character: 0 };
  const range = { start: zero, end: { line: 0, character: 3 } };
  let minted = 0;
  const context = {
    mint: () => {
      minted += 1;
      return `t${minted}`;
    },
  };
  const provide = (value, ctx = {}) =>
    wire.normalizeProviderResult('codeAction', 'provide', value, ctx);

  const actions = provide([
    { title: 'Add import', kind: { value: 'quickfix.import' }, isPreferred: true },
    { title: 'Run me', command: 'axiom.run', arguments: [1] },
    { title: 'Nothing yet' },
    { notATitle: true },
  ]);
  assert(
    actions.length === 3,
    'CA-1: an action with no title is dropped; the rest of the result survives.',
  );
  assert(
    actions[0].kind === 'quickfix.import' && actions[0].isPreferred === true,
    'CA-2: a CodeActionKind instance and a plain dotted string both read as the kind.',
  );
  assert(
    actions[1].command !== undefined && actions[1].command.command === 'axiom.run',
    'CA-3: a provider may return bare Commands instead of CodeActions, as upstream allows.',
  );
  assert(
    actions[1].kind === undefined && actions[1].edit === undefined,
    'CA-4: a Command-shaped action carries no kind or edit — it is only something to run.',
  );
  const withEdit = provide([
    {
      title: 'Fix',
      kind: 'quickfix',
      edit: {
        _operations: [
          {
            kind: 'text',
            uri: { scheme: 'file', path: '/w/a.ts' },
            edits: [{ range, newText: 'x' }],
          },
        ],
      },
      command: { title: 'After', command: 'axiom.after' },
      disabled: { reason: 'Not in this context' },
      diagnostics: [{ range, message: 'oops', severity: 0 }],
    },
  ])[0];
  assert(
    withEdit.edit !== undefined && withEdit.edit.entries.length === 1,
    'CA-5: an action edit is converted to a workspace edit rather than passed through raw.',
  );
  assert(
    withEdit.command.command === 'axiom.after',
    'CA-6: an action may carry both an edit and a command; upstream applies the edit first.',
  );
  assert(
    withEdit.disabledReason === 'Not in this context',
    'CA-7: a disabled action keeps its reason so the editor can show why it cannot run.',
  );
  assert(
    withEdit.diagnostics !== undefined && withEdit.diagnostics[0].message === 'oops',
    'CA-8: the diagnostics an action fixes are carried, which is what groups it in the lightbulb.',
  );
  assert(
    provide([{ title: 'Later' }], context)[0].id === 't1',
    'CA-9: a token is minted so resolveCodeAction can name the item it is resolving.',
  );
  assert(
    provide([{ title: 'No mint' }])[0].id === undefined,
    'CA-10: no token is minted when the provider has no resolve — nothing is retained.',
  );
  assert(
    wire.normalizeProviderResult('codeAction', 'resolve', { title: 'Fix', kind: 'quickfix' }, {})
      .title === 'Fix',
    'CA-11: resolveCodeAction returns one item, not a list.',
  );
  assert(
    wire.normalizeProviderResult('codeAction', 'resolve', null, {}) === null,
    'CA-12: a provider that resolves to nothing yields null, leaving the unresolved action intact.',
  );
  const metadata = langs.normalizeProviderMetadata({
    providedCodeActionKinds: ['quickfix'],
    codeActionKinds: ['quickfix', 'refactor.extract', 'quickfix', 42],
    documentation: [
      { kind: 'refactor', title: 'Learn more', command: 'axiom.docs' },
      { kind: 'refactor', title: 'No command' },
    ],
    displayName: 'Axiom fixes',
  });
  assert(
    metadata.codeActionKinds.join(',') === 'quickfix,refactor.extract',
    'CA-13: declared action kinds deduplicate and drop non-strings, bounding what is retained.',
  );
  assert(
    metadata.documentation.length === 1 && metadata.documentation[0].command === 'axiom.docs',
    'CA-14: a documentation entry without a command is dropped rather than shown as dead UI.',
  );
  assert(
    selectors.mergeStrategyFor('codeAction') === 'merge',
    'CA-15: every applicable code-action provider contributes — actions do not compete.',
  );
  const registry = new langs.ProviderRegistry();
  registry.register({
    extensionId: 'a.one',
    feature: 'codeAction',
    selector: langs.normalizeDocumentSelector('typescript'),
    metadata,
  });
  registry.register({
    extensionId: 'b.two',
    feature: 'codeAction',
    selector: langs.normalizeDocumentSelector('*'),
    metadata: {},
  });
  const chosen = registry.select('codeAction', {
    languageId: 'typescript',
    scheme: 'file',
    path: '/w/a.ts',
  });
  assert(
    chosen.providers.length === 2 && chosen.providers[0].extensionId === 'a.one',
    'CA-16: both providers are asked, the better-matching selector first.',
  );
  assert(
    chosen.needsPicker === false,
    'CA-17: a merge feature never needs a picker — that is only for single-provider features.',
  );
  const mergedActions = wire.mergeWireResults('codeAction', [
    provide([{ title: 'A' }]),
    null,
    provide([{ title: 'B' }]),
  ]);
  assert(
    mergedActions.length === 2,
    'CA-18: results concatenate across providers and a provider that returned nothing is skipped.',
  );
}
function validatePhase6CodeLensAndDecorations() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const zero = { line: 0, character: 0 };
  const range = { start: zero, end: { line: 0, character: 4 } };
  let minted = 0;
  const context = {
    mint: () => {
      minted += 1;
      return `t${minted}`;
    },
  };
  const provide = (feature, value, ctx = {}) =>
    wire.normalizeProviderResult(feature, 'provide', value, ctx);

  const lenses = provide(
    'codeLens',
    [
      { range, command: { title: '3 references', command: 'axiom.peek', arguments: [1] } },
      { range },
      { command: { title: 'no range', command: 'x' } },
    ],
    context,
  );
  assert(
    lenses.length === 2,
    'CL-1: a lens with no range is dropped — there is nowhere to draw it.',
  );
  assert(
    lenses[0].command.title === '3 references' && lenses[0].id === 't1',
    'CL-2: a lens carries its command and a token, so an unresolved lens can be resolved later.',
  );
  assert(
    lenses[1].command === undefined && lenses[1].id === 't2',
    'CL-3: a lens may arrive without a command; the token is what stops it staying blank.',
  );
  assert(
    wire.normalizeProviderResult(
      'codeLens',
      'resolve',
      { range, command: { title: 'a', command: 'b' } },
      {},
    ).command.title === 'a',
    'CL-4: resolveCodeLens returns one lens, not a list.',
  );

  const links = provide(
    'documentLink',
    [
      { range, target: 'https://example.com/a', tooltip: 'Open' },
      { range, target: 'javascript:alert(1)' },
      { range, target: 'command:axiom.run' },
      { range },
    ],
    context,
  );
  assert(
    links.length === 4 && links[0].target === 'https://example.com/a',
    'CL-5: an http link target survives; a link without a target is still a link.',
  );
  assert(
    links[1].target === undefined,
    'CL-6: a javascript: link target is refused — clicking a link must not run script.',
  );
  assert(
    links[2].target === undefined,
    'CL-7: a command: link target is refused; commands reach the editor through commands only.',
  );
  assert(
    links[0].tooltip === 'Open' && typeof links[0].id === 'string',
    'CL-8: tooltips and resolve tokens are carried for links.',
  );

  const hints = provide(
    'inlayHint',
    [
      { position: zero, label: 'count:', kind: 2, paddingRight: true },
      { position: zero, label: [{ value: 'a' }, { value: 'b' }, 'c'] },
      { position: zero, label: '' },
      { label: 'no position' },
    ],
    context,
  );
  assert(
    hints.length === 2,
    'CL-9: a hint with no position or an empty label is dropped rather than drawn empty.',
  );
  assert(
    hints[0].kind === 2 && hints[0].paddingRight === true,
    'CL-10: hint kind and padding survive, which is what distinguishes a type from a parameter hint.',
  );
  assert(
    hints[1].label === 'abc',
    'CL-11: InlayHintLabelParts flatten to the text the editor draws.',
  );
  assert(
    hints[0].textEdits === undefined &&
      provide('inlayHint', [
        { position: zero, label: ': T', textEdits: [{ range, newText: ': T' }] },
      ])[0].textEdits.length === 1,
    'CL-12: a hint may carry the edits that accepting it applies (double-click to insert a type).',
  );
  assert(
    wire.normalizeProviderResult('inlayHint', 'resolve', { position: zero, label: 'x' }, {})
      .label === 'x',
    'CL-13: resolveInlayHint returns one hint.',
  );

  const folds = provide('foldingRange', [
    { start: 8, end: 2, kind: 3 },
    { start: 4, end: 6 },
    { start: 1, end: 2, kind: 99 },
    { end: 4 },
  ]);
  assert(
    folds.length === 3,
    'CL-14: a folding range with no start line is dropped; the rest are kept.',
  );
  assert(
    folds[0].startLine === 2 && folds[0].endLine === 8 && folds[0].kind === 'region',
    'CL-15: an inverted folding range is ordered and the numeric kind maps to its LSP name.',
  );
  assert(
    folds[1].kind === undefined,
    'CL-16: a range with no kind stays kind-less rather than defaulting to comment.',
  );
  assert(
    folds[2].kind === 'region',
    'CL-17: an out-of-range fold kind clamps into the enum rather than becoming undefined.',
  );

  const colors = provide('color', [
    { range, color: { red: 1, green: 0.5, blue: 0, alpha: 0.25 } },
    { range, color: { red: 2, green: -1, blue: 0 } },
    { range, color: { red: 'x', green: 0, blue: 0 } },
    { color: { red: 0, green: 0, blue: 0 } },
  ]);
  assert(
    colors.length === 2,
    'CL-18: a colour needs a range and three numeric channels — otherwise it is dropped.',
  );
  assert(
    colors[0].color.alpha === 0.25 && colors[1].color.alpha === 1,
    'CL-19: alpha defaults to opaque, matching how Monaco reads a Color.',
  );
  assert(
    colors[1].color.red === 1 && colors[1].color.green === 0,
    'CL-20: channels clamp to 0..1 so a bad value cannot escape the colour picker.',
  );
  const presentations = wire.normalizeProviderResult(
    'color',
    'presentations',
    [
      { label: '#ff8000', textEdit: { range, newText: '#ff8000' } },
      { textEdit: { range, newText: 'x' } },
    ],
    {},
  );
  assert(
    presentations.length === 1 && presentations[0].textEdit.newText === '#ff8000',
    'CL-21: a colour presentation needs a label, and carries the edit that applies it.',
  );

  const highlights = provide('documentHighlight', [{ range, kind: 2 }, { range }]);
  assert(
    highlights[0].kind === 3 && highlights[1].kind === 1,
    'CL-22: highlight kinds shift zero-based to LSP one-based and default to Text.',
  );

  const chain = provide('selectionRange', {
    range,
    parent: { range: { start: zero, end: { line: 4, character: 0 } } },
  });
  assert(
    chain.ranges.length === 1 &&
      chain.ranges[0].length === 2 &&
      chain.ranges[0][0].end.character === 4,
    'CL-23: a selection-range parent chain flattens innermost-first, which is expand order.',
  );

  const linked = provide('linkedEditingRange', {
    ranges: [range, { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }],
    wordPattern: { source: '[\\w-]+' },
  });
  assert(
    linked.ranges.length === 2 && linked.wordPattern === '[\\w-]+',
    'CL-24: linked editing carries both ranges and the pattern as a string, not a live RegExp.',
  );
  assert(
    provide('linkedEditingRange', { ranges: [] }) === null,
    'CL-25: no ranges means no linked editing rather than an empty rename box.',
  );

  const values = provide('inlineValue', [
    { range, text: 'x = 1' },
    { range, variableName: 'x', caseSensitiveLookup: false },
    { range, expression: 'x + 1' },
    { range },
  ]);
  assert(
    values[0].kind === 'text' && values[1].kind === 'variable' && values[2].kind === 'expression',
    'CL-26: all three InlineValue shapes are distinguished by what the provider set.',
  );
  assert(
    values[1].caseSensitiveLookup === false && values[3].kind === 'expression',
    'CL-27: caseSensitiveLookup is preserved; a bare range falls back to an expression lookup.',
  );
}
function validatePhase6DocumentSync() {
  const sync = load(`${COMMON}vscodeDocumentSync.ts`);
  const text = 'const a = 1;\nconst b = 2;\n';

  assert(
    sync.offsetAt(text, { line: 1, character: 6 }) === 19,
    'DS-1: a position converts to an offset across lines, which every provider round-trip needs.',
  );
  assert(
    sync.offsetAt(text, { line: 0, character: 999 }) === 12,
    'DS-2: a position past the end of a line clamps to the line end as upstream does.',
  );
  assert(
    sync.offsetAt(text, { line: -1, character: 0 }) === 0 &&
      sync.offsetAt(text, { line: 99, character: 0 }) === text.length,
    'DS-3: positions outside the document clamp instead of throwing away the whole result.',
  );
  const round = sync.positionAt(text, 19);
  assert(
    round.line === 1 && round.character === 6,
    'DS-4: offset → position is the exact inverse, so an edit lands where the provider meant.',
  );
  assert(
    sync.applyContentChanges(text, [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'x' },
    ]) === 'const x = 1;\nconst b = 2;\n',
    'DS-5: an incremental change replaces exactly its range.',
  );
  assert(
    sync.applyContentChanges(text, [{ text: 'replaced' }]) === 'replaced',
    'DS-6: a change with no range is a full replacement, the other half of the LSP protocol.',
  );
  assert(
    sync.applyContentChanges('abc', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: 'X' },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, text: 'Y' },
    ]) === 'XYc',
    'DS-7: changes apply in order against the text as it stands, never sorted or reordered.',
  );
  assert(
    sync.applyContentChanges(text, [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 1 } }, text: 'x' },
    ]) === null,
    'DS-8: an end before its start is refused rather than silently splicing backwards.',
  );
  assert(
    sync.applyContentChanges(text, [{ text: 42 }]) === null,
    'DS-9: a non-string change text is refused; the document is never left half-applied.',
  );
  assert(
    sync.applyContentChanges(text, [
      { range: { start: { line: 0, character: 0.5 }, end: { line: 0, character: 1 } }, text: 'x' },
    ]) === null,
    'DS-10: a fractional position is refused — an offset between two UTF-16 units is meaningless.',
  );

  const store = new sync.DocumentStore(2);
  const opened = store.open({ uri: 'file:///w/a.ts', languageId: 'typescript', text, version: 3 });
  assert(
    opened.type === 'open' && opened.snapshot.version === 3 && opened.snapshot.lineCount === 3,
    'DS-11: opening a document reports an open event with the version the editor gave it.',
  );
  assert(
    store.open({ uri: '', languageId: 'typescript' }) === null &&
      store.open({ uri: 'file:///w/b.ts', languageId: '' }) === null,
    'DS-12: a document with no URI or no language is refused — nothing could select against it.',
  );
  const changed = store.change(
    'file:///w/a.ts',
    4,
    [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'x' }],
    { isDirty: true },
  );
  assert(
    changed.ok === true && changed.event.snapshot.text.startsWith('const x') === true,
    'DS-13: a change updates the stored text, so no provider can be handed stale content.',
  );
  assert(
    changed.event.snapshot.isDirty === true && changed.event.changes.length === 1,
    'DS-14: the change event carries the dirty state and the changes, as onDidChangeTextDocument does.',
  );
  assert(
    store.change('file:///w/a.ts', 4, [{ text: 'z' }]).reason === 'stale',
    'DS-15: a version that does not advance is refused as stale rather than corrupting the text.',
  );
  assert(
    store.change('file:///w/missing.ts', 9, [{ text: 'z' }]).reason === 'unknown',
    'DS-16: a change for a document that was never opened is reported, not invented.',
  );
  assert(
    store.change('file:///w/a.ts', 5, []).reason === 'invalid',
    'DS-17: an empty change batch is invalid — an event with no changes would be a lie.',
  );
  assert(
    store.replace('file:///w/a.ts', 9, 'fresh').snapshot.text === 'fresh',
    'DS-18: a refused change is recoverable by full resynchronisation, not by guessing.',
  );
  assert(
    store.save('file:///w/a.ts').snapshot.isDirty === false,
    'DS-19: saving clears the dirty flag, which is what a format-on-save extension reads.',
  );
  const language = store.setLanguage('file:///w/a.ts', 'javascript');
  assert(
    language.type === 'language' &&
      language.previousLanguageId === 'typescript' &&
      language.snapshot.languageId === 'javascript',
    'DS-20: setTextDocumentLanguage reports both languages so the old providers can be dropped.',
  );
  assert(
    store.setLanguage('file:///w/a.ts', 'javascript') === null,
    'DS-21: setting the language it already has is not an event — nothing needs re-selecting.',
  );
  assert(
    language.snapshot.version > 9,
    'DS-22: a language change advances the version, invalidating cached per-version results.',
  );
  const closed = store.close('file:///w/a.ts');
  assert(
    closed.snapshot.isClosed === true && store.has('file:///w/a.ts') === false,
    'DS-23: a closed document reports itself closed and stops answering with the text it had.',
  );
  assert(
    store.close('file:///w/a.ts') === null,
    'DS-24: closing twice is not an event; a duplicate close cannot fire onDidClose twice.',
  );
  store.open({ uri: 'file:///w/1.ts', languageId: 'typescript' });
  store.open({ uri: 'file:///w/2.ts', languageId: 'typescript' });
  assert(
    store.open({ uri: 'file:///w/3.ts', languageId: 'typescript' }) === null && store.size === 2,
    'DS-25: the open set is bounded, so a workspace-wide sweep cannot exhaust host memory.',
  );
  assert(
    store.open({ uri: 'file:///w/1.ts', languageId: 'typescript', text: 'x' }).snapshot.text ===
      'x',
    'DS-26: re-opening a known document replaces it, which is what a revert from disk sends.',
  );
  assert(
    store.offsetAt('file:///w/1.ts', { line: 0, character: 1 }) === 1 &&
      store.lineStartsFor('file:///w/1.ts').length === 1,
    'DS-27: line starts are cached per version for offset conversion on the provider hot path.',
  );
  assert(
    store.offsetAt('file:///w/missing.ts', { line: 0, character: 0 }) === undefined,
    'DS-28: offsets are only answered for documents the host actually holds.',
  );

  const crlf = new sync.DocumentStore();
  crlf.open({ uri: 'file:///w/c.ts', languageId: 'typescript', text: 'a\r\nb' });
  assert(
    crlf.get('file:///w/c.ts').eol === '\r\n' && crlf.get('file:///w/c.ts').lineCount === 2,
    'DS-29: EOL is detected from the content, which TextDocument.eol reports to extensions.',
  );
  const candidate = sync.toDocumentCandidate({
    uri: 'file:///c:/a%20b/x.ts',
    languageId: 'typescript',
  });
  assert(
    candidate.scheme === 'file' && candidate.path === 'c:/a b/x.ts',
    'DS-30: selector matching sees a decoded path, so a pattern selector matches as in VS Code.',
  );
  assert(
    sync.toDocumentCandidate({ uri: 'untitled:Untitled-1', languageId: 'plaintext' }).scheme ===
      'untitled',
    'DS-31: an untitled document keeps its scheme, which scheme-only selectors match on.',
  );
}
function validatePhase6WorkspaceEdits() {
  const wse = load(`${COMMON}vscodeWorkspaceEdit.ts`);
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const host = load(`${COMMON}vscodeHost.ts`);
  const policy = { roots: ['C:/w'], caseInsensitive: true };
  const range = (line, from, to) => ({
    start: { line, character: from },
    end: { line, character: to },
  });
  const textEntry = (uri, edits) => ({ kind: 'text', uri, edits });

  assert(
    wse.fileUriToPath('file:///c:/w/a%20b.ts') === 'c:/w/a b.ts',
    'WE-1: a file URI decodes to a comparable path before any boundary check runs.',
  );
  assert(
    wse.isEditableUri('file:///c:/w/%2e%2e/%2e%2e/etc/passwd', policy) === false,
    'WE-2: percent-encoded traversal is decoded before comparison, so it cannot escape the root.',
  );
  assert(
    wse.isEditableUri('file:///c:/w/a.ts', policy) === true &&
      wse.isEditableUri('file:///c:/other/a.ts', policy) === false,
    'WE-3: the workspace boundary is enforced on every edited URI.',
  );
  assert(
    wse.isEditableUri('untitled:Untitled-1', policy) === false &&
      wse.isEditableUri('untitled:Untitled-1', { ...policy, allowUntitled: true }) === true,
    'WE-4: an untitled buffer is editable only when the caller opted into it.',
  );
  assert(
    wse.isEditableUri('git:/c:/w/a.ts?ref=HEAD', policy) === false &&
      wse.isEditableUri('http://example.com/a.ts', policy) === false,
    'WE-5: read-only and remote schemes are refused rather than written and silently discarded.',
  );
  assert(
    wse.isValidEditRange(range(0, 0, 2)) === true &&
      wse.isValidEditRange(range(0, 4, 2)) === false &&
      wse.isValidEditRange({ start: { line: 0, character: 0 } }) === false,
    'WE-6: a range must be whole, non-negative and not end before it starts.',
  );

  const applied = wse.validateWorkspaceEdit(
    {
      entries: [
        textEntry('file:///c:/w/a.ts', [
          { range: range(0, 0, 1), newText: 'A' },
          { range: range(5, 0, 1), newText: 'B' },
        ]),
        { kind: 'create', uri: 'file:///c:/w/new.ts', contents: 'x' },
        { kind: 'rename', uri: 'file:///c:/w/old.ts', newUri: 'file:///c:/w/moved.ts' },
        { kind: 'delete', uri: 'file:///c:/w/gone.ts', recursive: true },
      ],
    },
    policy,
  );
  assert(
    applied.ok === true && applied.plan.entries.length === 4,
    'WE-7: text edits and all three file operations validate together as one plan.',
  );
  assert(
    applied.plan.textEditCount === 2 && applied.plan.fileOperationCount === 3,
    'WE-8: the plan counts both kinds of work, which is what the caller logs and reports.',
  );
  assert(
    applied.plan.touched.includes('file:///c:/w/moved.ts'),
    'WE-9: a rename destination counts as touched, so the editor reloads the file that appeared.',
  );
  assert(
    applied.plan.entries[0].edits[0].range.start.line === 5,
    'WE-10: text edits are sorted last-first so applying one cannot move the next.',
  );
  assert(
    wse.validateWorkspaceEdit({ entries: [] }, policy).rejection.code === 'empty' &&
      wse.validateWorkspaceEdit(undefined, policy).rejection.code === 'empty',
    'WE-11: an edit with no operations is rejected rather than reported as applied.',
  );
  assert(
    wse.validateWorkspaceEdit(
      { entries: [textEntry('file:///c:/w/a.ts', [{ range: range(0, 0, 1), newText: 'A' }])] },
      { roots: [], caseInsensitive: true },
    ).rejection.code === 'no-workspace',
    'WE-12: with no workspace open there is nothing an extension may write to.',
  );
  assert(
    wse.validateWorkspaceEdit(
      { entries: [textEntry('file:///c:/other/a.ts', [{ range: range(0, 0, 1), newText: 'A' }])] },
      policy,
    ).rejection.code === 'outside-workspace',
    'WE-13: one out-of-workspace entry rejects the whole edit — edits are all-or-nothing.',
  );
  assert(
    wse.validateWorkspaceEdit(
      {
        entries: [textEntry('output:extension-output', [{ range: range(0, 0, 1), newText: 'A' }])],
      },
      policy,
    ).rejection.code === 'unsupported-scheme',
    'WE-14: an unsupported scheme is named as such, so the log says why the edit failed.',
  );
  assert(
    wse.validateWorkspaceEdit({ entries: [textEntry(42, [])] }, policy).rejection.code ===
      'invalid-uri',
    'WE-15: an entry whose URI is not even a string is refused before any path handling.',
  );
  assert(
    wse.validateWorkspaceEdit(
      { entries: [textEntry('file:///c:/w/a.ts', [{ range: range(0, 4, 2), newText: 'A' }])] },
      policy,
    ).rejection.code === 'invalid-range',
    'WE-16: an invalid range rejects the edit rather than being clamped into a wrong write.',
  );
  assert(
    wse.validateWorkspaceEdit(
      {
        entries: [
          textEntry('file:///c:/w/a.ts', [
            { range: range(0, 0, 4), newText: 'A' },
            { range: range(0, 2, 6), newText: 'B' },
          ]),
        ],
      },
      policy,
    ).rejection.code === 'overlapping-edits',
    'WE-17: overlapping edits are refused — the result would depend on application order.',
  );
  assert(
    wse.validateWorkspaceEdit(
      {
        entries: [
          { kind: 'create', uri: 'file:///c:/w/big.ts', contents: 'x'.repeat(1024 * 1024 + 1) },
        ],
      },
      policy,
    ).rejection.code === 'too-large',
    'WE-18: inline contents for a created file are bounded; larger writes are not an edit’s job.',
  );
  assert(
    wse.validateWorkspaceEdit(
      {
        entries: [{ kind: 'rename', uri: 'file:///c:/w/a.ts', newUri: 'file:///c:/other/a.ts' }],
      },
      policy,
    ).rejection.code === 'outside-workspace',
    'WE-19: a rename destination is checked too — it is the one operation that can move a file out.',
  );
  assert(
    wse.validateWorkspaceEdit({ entries: [{ kind: 'chmod', uri: 'file:///c:/w/a.ts' }] }, policy)
      .ok === false,
    'WE-20: an operation kind the platform does not implement is refused, never ignored.',
  );
  assert(
    wse.validateWorkspaceEdit(
      { entries: [textEntry('file:///c:/w/a.ts', [{ range: range(0, 0, 1), newText: 'A' }])] },
      { ...policy, maxEntries: 0 },
    ).rejection.code === 'too-many-entries',
    'WE-21: the entry count is bounded by policy, so one edit cannot touch the whole disk.',
  );
  assert(
    wse.validateWorkspaceEdit(
      {
        entries: [
          textEntry('file:///c:/w/a.ts', [
            { range: range(0, 0, 1), newText: 'A' },
            { range: range(2, 0, 1), newText: 'B' },
          ]),
        ],
      },
      { ...policy, maxTotalEdits: 1 },
    ).rejection.code === 'too-many-edits',
    'WE-22: the total text-edit count is bounded as well as the per-file one.',
  );
  assert(
    wse
      .describeWorkspaceEditRejection({ code: 'outside-workspace', message: 'nope' })
      .startsWith('outside-workspace: '),
    'WE-23: a rejection describes itself for the log — applyEdit’s false says nothing on its own.',
  );

  const snippetEdit = wire.normalizeProviderResult(
    'codeAction',
    'provide',
    [
      {
        title: 'Snippet',
        edit: {
          _operations: [
            {
              kind: 'text',
              uri: 'file:///c:/w/a.ts',
              edits: [{ range: range(0, 0, 0), snippet: { value: 'log($1)' } }],
            },
          ],
        },
      },
    ],
    {},
  )[0].edit;
  assert(
    snippetEdit.entries[0].edits[0].insertAsSnippet === true,
    'WE-24: a SnippetTextEdit stays a snippet across the wire, so tab stops still work.',
  );
  assert(
    wse.validateWorkspaceEdit(snippetEdit, policy).ok === true,
    'WE-25: a snippet edit is validated by the same policy as a plain one.',
  );
  assert(
    host.validateHostRequest('languages.applyWorkspaceEdit', { edit: { entries: [] } }).ok ===
      false &&
      host.validateHostRequest('languages.applyWorkspaceEdit', {
        edit: {
          entries: [textEntry('file:///c:/w/a.ts', [{ range: range(0, 0, 1), newText: 'A' }])],
        },
      }).ok === true,
    'WE-26: applyWorkspaceEdit is shape-checked at the boundary and policy-checked where roots are known.',
  );
  assert(
    host.EFFECTFUL_REQUEST_KINDS.includes('languages.applyWorkspaceEdit') &&
      host.EFFECTFUL_REQUEST_KINDS.includes('languages.registerProvider') === false,
    'WE-27: writing the user’s files through a provider result is effectful; registering is not.',
  );
}
function validatePhase6ProviderOrdering() {
  const langs = load(`${COMMON}vscodeLanguages.ts`);
  const selectors = load(`${COMMON}documentSelector.ts`);
  const doc = { languageId: 'typescript', scheme: 'file', path: 'C:/w/src/a.ts' };
  const registry = new langs.ProviderRegistry();
  const add = (extensionId, feature, selector, extra = {}) =>
    registry.register({
      extensionId,
      feature,
      selector: langs.normalizeDocumentSelector(selector),
      ...extra,
    });

  assert(
    selectors.scoreDocumentSelector([{ language: 'typescript', scheme: 'file' }], doc) === 10 &&
      selectors.scoreDocumentSelector('typescript', doc) === 10 &&
      selectors.scoreDocumentSelector('*', doc) === 5 &&
      selectors.scoreDocumentSelector('python', doc) === 0,
    'PO-1: selector scores follow upstream — 10 exact, 5 wildcard, 0 no match.',
  );
  assert(
    selectors.scoreDocumentSelector({ language: 'typescript', pattern: '**/*.ts' }, doc) === 10 &&
      selectors.scoreDocumentSelector({ language: 'typescript', pattern: '**/*.py' }, doc) === 0,
    'PO-2: a pattern clause must match the document path or the whole filter declines.',
  );

  const wildcard = add('w.ext', 'completion', '*');
  const exact = add('e.ext', 'completion', 'typescript');
  const other = add('o.ext', 'completion', 'python');
  const ordered = registry.ordered('completion', doc);
  assert(
    ordered.length === 2 && ordered[0].extensionId === 'e.ext',
    'PO-3: only applicable providers are asked, most specific first.',
  );
  assert(
    ordered.some((p) => p.handle === other.handle) === false,
    'PO-4: a provider whose selector scores zero is never invoked for that document.',
  );
  const later = add('l.ext', 'completion', 'typescript');
  assert(
    registry.ordered('completion', doc)[0].handle === later.handle,
    'PO-5: equal scores break on registration order, so a later provider wins as upstream does.',
  );
  assert(
    exact.sequence < later.sequence && later.handle > exact.handle,
    'PO-6: registration order is recorded per provider, which is what makes ordering deterministic.',
  );

  add('a.fmt', 'formatting', 'typescript');
  add('b.fmt', 'formatting', 'typescript');
  const contested = registry.select('formatting', doc);
  assert(
    contested.strategy === 'single' && contested.providers.length === 1,
    'PO-7: a single-provider feature invokes exactly one provider, never two formatters.',
  );
  assert(
    contested.needsPicker === true,
    'PO-8: two equally-scoring formatters from different extensions require the user to choose.',
  );
  assert(
    selectors.scoreDocumentSelector({ language: 'typescript', pattern: '**/*.ts' }, doc) ===
      selectors.scoreDocumentSelector('typescript', doc),
    'PO-9: an exact match is the ceiling — extra matching clauses cannot outscore it.',
  );
  const sameExtension = new langs.ProviderRegistry();
  sameExtension.register({
    extensionId: 'one.ext',
    feature: 'rename',
    selector: langs.normalizeDocumentSelector('typescript'),
  });
  sameExtension.register({
    extensionId: 'one.ext',
    feature: 'rename',
    selector: langs.normalizeDocumentSelector('typescript'),
  });
  assert(
    sameExtension.select('rename', doc).needsPicker === false,
    'PO-10: one extension registering twice is not a conflict — only two extensions are.',
  );
  const wideFmt = registry.forFeature('formatting').find((p) => p.extensionId === 'b.fmt');
  registry.unregister(wideFmt.handle);
  assert(
    registry.select('formatting', doc).needsPicker === false &&
      registry.select('formatting', doc).providers[0].extensionId === 'a.fmt',
    'PO-11: with the rival gone the remaining formatter runs unattended.',
  );
  assert(
    registry.unregister(wideFmt.handle) === undefined,
    'PO-12: unregister is idempotent — disposing an extension Disposable twice is legal.',
  );
  assert(
    (() => {
      try {
        registry.register({
          extensionId: 'dup.ext',
          feature: 'hover',
          selector: 'typescript',
          handle: exact.handle,
        });
        return false;
      } catch {
        return true;
      }
    })(),
    'PO-13: a handle collision throws rather than shadowing a live provider.',
  );
  assert(
    registry.countFor('e.ext') === 1 && registry.countFor('b.fmt') === 0,
    'PO-14: the per-extension provider count tracks registration and disposal.',
  );
  assert(
    registry.activeFeatures().includes('completion') &&
      registry.activeFeatures().includes('formatting') &&
      registry.activeFeatures().includes('hover') === false,
    'PO-15: activeFeatures reports only features with a live provider, which is what the renderer registers.',
  );
  const beforeCrash = registry.size;
  const dropped = registry.removeExtension('e.ext');
  assert(
    dropped.length === 1 &&
      registry.size === beforeCrash - 1 &&
      registry.get(exact.handle) === undefined,
    'PO-16: removeExtension drops every provider an extension owns, so a crash and a clean deactivate are equivalent.',
  );
  const meta = new langs.ProviderRegistry();
  meta.register({
    extensionId: 'a.comp',
    feature: 'completion',
    selector: 'typescript',
    metadata: langs.normalizeProviderMetadata({ triggerCharacters: ['.', '.', '<'] }),
  });
  meta.register({
    extensionId: 'b.comp',
    feature: 'completion',
    selector: '*',
    metadata: langs.normalizeProviderMetadata({ triggerCharacters: ['"'] }),
  });
  const triggers = meta.triggerCharactersFor('completion', doc);
  assert(
    triggers.length === 3 &&
      triggers.includes('.') &&
      triggers.includes('<') &&
      triggers.includes('"'),
    'PO-17: Monaco takes one trigger set per language, so it is the deduplicated union across applicable providers.',
  );
  assert(
    meta.triggerCharactersFor('completion', { ...doc, languageId: 'python' }).length === 1,
    'PO-18: a provider that does not apply contributes no trigger characters.',
  );
  meta.register({
    extensionId: 'lo.sem',
    feature: 'semanticTokens',
    selector: '*',
    metadata: langs.normalizeProviderMetadata({
      legend: { tokenTypes: ['comment'], tokenModifiers: [] },
    }),
  });
  meta.register({
    extensionId: 'hi.sem',
    feature: 'semanticTokens',
    selector: 'typescript',
    metadata: langs.normalizeProviderMetadata({
      legend: { tokenTypes: ['class', 'variable'], tokenModifiers: ['static'] },
    }),
  });
  const legend = meta.legendFor(doc);
  assert(
    legend !== undefined && legend.tokenTypes.length === 2 && legend.tokenTypes[0] === 'class',
    'PO-19: the legend comes from the winning provider — mixing two legends would recolour the file at random.',
  );
  assert(
    meta.legendFor({ ...doc, languageId: 'python' })?.tokenTypes[0] === 'comment',
    'PO-20: another document can resolve to a different provider, and its own legend follows.',
  );
  const flood = new langs.ProviderRegistry();
  let registered = 0;
  let threw = false;
  try {
    for (let i = 0; i < langs.MAX_PROVIDERS_PER_EXTENSION + 5; i += 1) {
      flood.register({ extensionId: 'greedy.ext', feature: 'hover', selector: 'typescript' });
      registered += 1;
    }
  } catch {
    threw = true;
  }
  assert(
    threw === true && registered === langs.MAX_PROVIDERS_PER_EXTENSION,
    `PO-21: one extension cannot register more than ${langs.MAX_PROVIDERS_PER_EXTENSION} providers.`,
  );
  assert(
    langs.limitProviders(new Array(langs.MAX_PROVIDERS_PER_REQUEST + 10).fill(0)).length ===
      langs.MAX_PROVIDERS_PER_REQUEST,
    `PO-22: a single request fans out to at most ${langs.MAX_PROVIDERS_PER_REQUEST} providers, so one keystroke cannot stall the editor.`,
  );
  assert(
    selectors.mergeStrategyFor('formatting') === 'single' &&
      selectors.mergeStrategyFor('rename') === 'single' &&
      selectors.mergeStrategyFor('semanticTokens') === 'single' &&
      selectors.mergeStrategyFor('hover') === 'stack' &&
      selectors.mergeStrategyFor('reference') === 'concat' &&
      selectors.mergeStrategyFor('completion') === 'merge',
    'PO-23: the merge strategy per feature matches upstream — two formatters would corrupt the buffer, two hovers stack.',
  );
  assert(
    selectors.mergeStrategyFor('somethingNobodyDefined') === 'merge',
    'PO-24: an unlisted feature merges rather than silently dropping every provider but one.',
  );
  const combined = selectors.combineProviderResults([
    { ok: true, value: [1, 2] },
    { ok: false, error: 'boom in ext.a' },
    { ok: true, value: [3] },
  ]);
  assert(
    combined.values.length === 3 && combined.failures.length === 1,
    'PO-25: a provider that threw is excluded from the results and never fails the request — hover survives one broken extension.',
  );
  assert(
    langs.normalizeTriggerCharacters(['.', '..', 5, '', '<']).join('') === '.<' &&
      langs.normalizeTriggerCharacters('nonsense').length === 0,
    'PO-26: trigger characters are single characters or they are dropped.',
  );
  assert(
    langs.normalizeDocumentSelector({}) === null &&
      langs.normalizeDocumentSelector({ language: 'ts', nonsense: 1 }).nonsense === undefined,
    'PO-27: a selector that constrains nothing is refused, and unknown filter fields never survive the boundary.',
  );
}
/**
 * Cancellation, end to end.
 *
 * A cancellation that stops at a process boundary is worse than none: the editor moves on while a
 * provider keeps computing a result nobody will read, and on a large workspace that is what turns
 * fast typing into a stalled host. The propagation path is renderer token → `languageCancel` per
 * worker → the `CancellationToken` the provider is holding, and it spans three processes, so it is
 * asserted against the source of each hop rather than claimed.
 */
function validatePhase6Cancellation() {
  const client = phase6Read('src/renderer/src/editor/extensionLanguageClient.ts');
  const service = phase6Read('src/main/services/extensionLanguages.ts');
  const worker = phase6Read('src/main/extensionHostWorker.ts');
  const providers = phase6Read('src/renderer/src/editor/extensionProviders.ts');

  assert(
    /token\.onCancellationRequested\(\(\) => \{[\s\S]{0,160}languageProviders\.cancel\(requestId\)/.test(
      client,
    ),
    "CX-1: Monaco's own token is subscribed, so an abandoned request cancels rather than being dropped silently.",
  );
  assert(
    /if \(token\.isCancellationRequested\) return null;/.test(client),
    'CX-2: a token already tripped before dispatch short-circuits without troubling the host.',
  );
  assert(
    /finally \{\s*subscription\.dispose\(\);/.test(client),
    'CX-3: the cancellation subscription is disposed on every path, so a long session leaks no listeners.',
  );
  assert(
    /const requestId = nextRequestId\+\+;/.test(client) &&
      /const input: ExtensionProvideInput = \{ requestId, \.\.\.request \}/.test(client),
    'CX-4: the request id the cancel names is the id the request was sent under.',
  );
  assert(
    /if \(uri !== null\) await flushDocument\(uri\);\s*if \(token\.isCancellationRequested\) return null;/.test(
      providers,
    ),
    'CX-5: the token is re-checked after the document flush, because that await is where a keystroke lands.',
  );
  assert(
    /token: monaco\.CancellationToken,/.test(providers),
    'CX-6: every provider invocation carries a real Monaco CancellationToken, not a placeholder.',
  );
  assert(
    /const inFlight = new Map<number, Array<\{ extensionId: string; workerId: number \}>>\(\);/.test(
      service,
    ),
    'CX-7: Main records which worker invocations a request fanned out to, which is the only way a cancel can reach them.',
  );
  assert(
    /inFlight\.set\(requestId, \[\]\);/.test(service) &&
      /inFlight\.get\(requestId\)\?\.push\(\{ extensionId: link\.extensionId, workerId \}\);/.test(
        service,
      ),
    'CX-8: the invocation is recorded synchronously inside the message builder, before the post — so a cancel cannot race ahead of it.',
  );
  assert(
    /finally \{\s*inFlight\.delete\(requestId\);/.test(service),
    'CX-9: the in-flight entry is removed in a finally, so a thrown provider does not leak a cancellation route.',
  );
  assert(
    /export function cancelLanguageRequest\(requestId: number\): boolean \{[\s\S]{0,400}for \(const call of calls\) \{[\s\S]{0,200}host\.deliver\(call\.extensionId, \{ t: 'languageCancel', id: call\.workerId \}\);/.test(
      service,
    ),
    'CX-10: every worker the request reached is told — a token that fires in one of three hosts leaves two providers working.',
  );
  assert(
    /if \(!calls \|\| calls\.length === 0\) return false;/.test(service),
    'CX-11: a cancel for a request that already answered is a no-op rather than an error.',
  );
  assert(
    /const providerCalls = new Map<number, \{ handle: number; source: CancellationTokenSource \}>\(\);/.test(
      worker,
    ),
    'CX-12: the worker holds the token source per invocation id, because that id is all a languageCancel carries.',
  );
  assert(
    /providerCalls\.set\(message\.id, \{ handle: message\.handle, source \}\);/.test(worker),
    'CX-13: the source is recorded under the invocation id before the provider is awaited.',
  );
  assert(
    /function cancelLanguageProvide\(id: number\): void \{\s*const entry = providerCalls\.get\(id\);\s*if \(!entry\) return;\s*providerCalls\.delete\(id\);\s*entry\.source\.cancel\(\);/.test(
      worker,
    ),
    'CX-14: languageCancel trips the very token the provider is holding, so a cooperative provider stops work.',
  );
  assert(
    /if \(source\.token\.isCancellationRequested\) \{\s*fail\('The request was cancelled\.'\);/.test(
      worker,
    ),
    'CX-15: a provider that ignored the token and answered anyway has its result discarded, not rendered.',
  );
  assert(
    /finally \{\s*providerCalls\.delete\(message\.id\);\s*source\.dispose\(\);/.test(worker),
    'CX-16: the invocation record and its emitter are released on every path, cancelled or not.',
  );
  assert(
    /if \(providerCalls\.size >= MAX_CONCURRENT_PROVIDER_CALLS\) \{/.test(worker) &&
      /const MAX_CONCURRENT_PROVIDER_CALLS = \d+;/.test(worker),
    'CX-17: the worker applies back-pressure instead of queueing, so a fast typist cannot build an unbounded backlog.',
  );
  assert(
    /const PROVIDER_TIMEOUT_MS = [\d_]+;/.test(service) &&
      /const SLOW_PROVIDER_TIMEOUT_MS = [\d_]+;/.test(service) &&
      /timeoutFor\(link\.feature\)/.test(service),
    'CX-18: every call has a deadline, and the slow features get a longer one rather than sharing an unsafe average.',
  );
  assert(
    /return \{ ok: false, error: `\$\{link\.extensionId\}: \$\{errorText\(error\)\}` \};/.test(
      service,
    ),
    'CX-19: a timed-out or thrown provider becomes a named failure string, so one extension cannot fail the whole request.',
  );
  assert(
    /for \(const \[requestId, calls\] of inFlight\) \{\s*const kept = calls\.filter\(\(call\) => call\.extensionId !== extensionId\);/.test(
      service,
    ),
    'CX-20: an extension that unloads mid-request is pruned from every cancellation route, so no cancel is delivered to a dead worker.',
  );
  assert(
    /cancel: \(requestId: number\): Promise<boolean> =>\s*ipcRenderer\.invoke\(IPC\.languagesCancel, requestId\),/.test(
      phase6Read('src/preload/index.ts'),
    ),
    'CX-21: cancellation crosses the preload boundary as one number over a named channel, not as a live object.',
  );
  assert(
    /ipcMain\.handle\(IPC\.languagesCancel, \(_event, requestId: unknown\) =>\s*cancelLanguageRequest\(assertPositiveInteger\(requestId, 'requestId'\)\),/.test(
      phase6Read('src/main/ipc.ts'),
    ),
    'CX-22: the cancel channel validates its argument like every other IPC entry point.',
  );
  assert(
    /cancel\(\): void \{\s*if \(this\.token\.isCancellationRequested\) return;\s*this\.token\.isCancellationRequested = true;\s*this\.emitter\.fire\(undefined\);/.test(
      worker,
    ),
    "CX-23: cancelling twice fires the extension's onCancellationRequested once, as upstream's token does.",
  );
  assert(
    /case 'languageCancel':/.test(worker),
    'CX-24: the worker actually handles the cancel message — the route is wired, not merely defined.',
  );
  assert(
    load(`${COMMON}vscodeHost.ts`) &&
      /\{ t: 'languageCancel'; id: number \}/.test(phase6Read('src/common/vscodeHost.ts')),
    'CX-25: languageCancel is part of the typed host protocol, so both sides agree on its shape.',
  );
}
/**
 * The Monaco bridge, asserted against its source.
 *
 * "Use Monaco's public APIs only" is the one Phase 6 rule that cannot be checked from a pure module:
 * the bridge lives in the renderer and needs a live editor. What *can* be checked is the shape of the
 * code that does the bridging — that every feature arrives through a documented `register*` call, that
 * no private member, no injected DOM and no dynamic evaluation is anywhere near it, and that every
 * registration it makes is disposed on reload. A monkey-patch added later fails this suite.
 */
function validatePhase6MonacoBridge() {
  const bridge = phase6Read('src/renderer/src/editor/extensionProviders.ts');
  const client = phase6Read('src/renderer/src/editor/extensionLanguageClient.ts');
  const registrations = bridge.match(/monaco\.languages\.register[A-Za-z]+Provider\(/g) ?? [];
  const unique = new Set(registrations);

  assert(
    unique.size === 24,
    `MI-1: 24 distinct public Monaco provider registrations bridge the extension features Monaco can host (saw ${unique.size}).`,
  );
  for (const name of [
    'registerCompletionItemProvider',
    'registerHoverProvider',
    'registerSignatureHelpProvider',
    'registerDefinitionProvider',
    'registerTypeDefinitionProvider',
    'registerImplementationProvider',
    'registerDeclarationProvider',
    'registerReferenceProvider',
    'registerRenameProvider',
    'registerDocumentSymbolProvider',
    'registerDocumentFormattingEditProvider',
    'registerDocumentRangeFormattingEditProvider',
    'registerOnTypeFormattingEditProvider',
    'registerCodeActionProvider',
    'registerCodeLensProvider',
    'registerColorProvider',
    'registerDocumentHighlightProvider',
    'registerLinkProvider',
    'registerSelectionRangeProvider',
    'registerFoldingRangeProvider',
    'registerLinkedEditingRangeProvider',
    'registerInlayHintsProvider',
    'registerDocumentSemanticTokensProvider',
    'registerDocumentRangeSemanticTokensProvider',
  ]) {
    assert(
      unique.has(`monaco.languages.${name}(`),
      `MI-2/${name}: bridged through the public monaco.languages.${name}.`,
    );
  }
  assert(
    /monaco\.languages\.register\(\{/.test(bridge) &&
      /monaco\.languages\.setLanguageConfiguration\(descriptor\.id, configuration\)/.test(bridge),
    'MI-3: registerLanguage and setLanguageConfiguration go through their public Monaco counterparts.',
  );
  assert(
    /if \(!registeredLanguages\.has\(descriptor\.id\)\)/.test(bridge),
    'MI-4: a language is registered once — monaco.languages.register merges, so re-registering would append its extensions repeatedly.',
  );
  assert(
    /registrations\.push\(/.test(bridge) &&
      /function disposeRegistrations\(\): void \{[\s\S]{0,320}registration\.dispose\(\);/.test(
        bridge,
      ),
    'MI-5: every disposable registration is tracked and disposed, so an uninstalled extension leaves no provider behind.',
  );
  assert(
    /let reloadChain: Promise<void> = Promise\.resolve\(\);/.test(bridge),
    'MI-6: reloads are serialised — two overlapping rebuilds would dispose each other’s registrations.',
  );
  for (const [pattern, label] of [
    [/\beval\s*\(/, 'eval'],
    [/new\s+Function\s*\(/, 'new Function'],
    [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
    [/\.innerHTML\s*=/, 'innerHTML assignment'],
    [/document\.createElement\(/, 'direct DOM construction'],
    [/document\.body\./, 'document.body mutation'],
    [/StandaloneServices/, 'Monaco private services'],
    [/monaco\.editor\.getEditors\(\)\[0\]\._/, 'a private editor member'],
    [/\bmonaco\.languages\._[A-Za-z]/, 'a private monaco.languages member'],
    [/\bmonaco\.editor\._[A-Za-z]/, 'a private monaco.editor member'],
  ]) {
    assert(
      !pattern.test(bridge) && !pattern.test(client),
      `MI-7/${label}: the Monaco bridge contains no ${label}.`,
    );
  }
  assert(
    /catch \{/.test(bridge) &&
      /\/\/ One malformed language contribution must not stop/.test(bridge),
    'MI-8: one malformed contribution is contained, so the rest of the snapshot still applies.',
  );
  assert(
    /monaco\.editor\.registerCommand\(/.test(bridge),
    'MI-9: a code-lens or code-action command is run through Monaco’s public command registry, not by reaching into the editor.',
  );
  assert(
    /return filters\.length === 0 \? null : filters;/.test(bridge),
    'MI-10: an empty selector registers nothing rather than registering a provider for every document.',
  );
}

// --------------------------------------------------------------------------
// PRD Phase 7 §1 — Terminal API
// --------------------------------------------------------------------------
/**
 * `TerminalOptions` / `ExtensionTerminalOptions` validation.
 *
 * Every field an extension may set on a terminal is a path, an environment, a colour or a name, and
 * each of the four has a way of going wrong that only shows up once a pty exists: a cwd that leaves
 * the workspace, a variable name that is really a shell fragment, a CSS value where a theme colour id
 * belongs, a name long enough to push the tab strip apart. The normaliser is where those are refused,
 * so it is asserted directly rather than inferred from a spawn.
 */
function validatePhase7TerminalOptions() {
  const runtime = load(`${COMMON}vscodeTerminalRuntime.ts`);
  assert(
    runtime.normalizeTerminalRequest(undefined).name === 'Terminal',
    'T-1: a terminal with no options still has upstream’s default name.',
  );
  assert(
    runtime.normalizeTerminalRequest({ name: 'x'.repeat(500) }).name.length ===
      runtime.MAX_TERMINAL_NAME,
    'T-2: a terminal name is clamped to MAX_TERMINAL_NAME.',
  );
  assert(
    runtime.normalizeTerminalRequest({ name: '' }).name === 'Terminal',
    'T-3: an empty name falls back to the default rather than drawing a blank tab.',
  );
  assert(
    JSON.stringify(runtime.normalizeTerminalRequest({ shellArgs: '-l' }).shellArgs) ===
      JSON.stringify(['-l']),
    'T-4: a string `shellArgs` becomes a one-element argv, as upstream allows.',
  );
  assert(
    JSON.stringify(runtime.normalizeTerminalRequest({ shellArgs: ['-l', 7, null] }).shellArgs) ===
      JSON.stringify(['-l']),
    'T-5: a non-string entry in `shellArgs` is dropped, not coerced.',
  );
  assert(
    runtime.normalizeTerminalRequest({ cwd: { fsPath: '/work/src' } }).cwd === '/work/src',
    'T-6: a `Uri` cwd reduces to its filesystem path.',
  );
  assert(
    runtime.normalizeTerminalRequest({ cwd: 42 }).cwd === null,
    'T-7: a cwd that is neither a string nor a `Uri` is dropped.',
  );
  assert(
    runtime.normalizeTerminalRequest({ location: 2 }).location === 'editor',
    'T-8: `TerminalLocation.Editor` (2) places the terminal in an editor tab.',
  );
  assert(
    runtime.normalizeTerminalRequest({ location: { viewColumn: 1 } }).location === 'editor',
    'T-9: a `TerminalEditorLocationOptions` object is an editor location too.',
  );
  assert(
    runtime.normalizeTerminalRequest({ location: { parentTerminal: { _axiomHandle: 5 } } })
      .splitParent === 5,
    'T-10: a split request carries the parent terminal’s handle.',
  );
  for (const handle of [0, -1, 1.5, '3', null]) {
    assert(
      runtime.normalizeTerminalRequest({ location: { parentTerminal: { _axiomHandle: handle } } })
        .splitParent === null,
      `T-11: a split parent handle of ${JSON.stringify(handle)} is not adopted.`,
    );
  }
  assert(
    runtime.normalizeTerminalRequest({ pty: {} }).extensionPty === true &&
      runtime.normalizeTerminalRequest({ pty: true }).extensionPty === false &&
      runtime.normalizeTerminalRequest({ pty: null }).extensionPty === false,
    'T-12: only an object `pty` makes this an extension-owned terminal.',
  );
  const flags = runtime.normalizeTerminalRequest({
    strictEnv: 'yes',
    hideFromUser: 1,
    isTransient: {},
  });
  assert(
    flags.strictEnv === false && flags.hideFromUser === false && flags.isTransient === false,
    'T-13: the boolean terminal options are strict — a truthy non-boolean does not set them.',
  );
  const env = runtime.normalizeTerminalEnv({
    GOOD_1: 'v',
    '2BAD': 'v',
    'BAD-NAME': 'v',
    UNSET: null,
    WRONG: 7,
  });
  assert(
    Object.keys(env).length === 2 && env.GOOD_1 === 'v' && env.UNSET === null,
    'T-14: the environment grammar keeps portable names and a null unset, and drops the rest.',
  );
  assert(
    runtime.normalizeTerminalEnv({ BIG: 'v'.repeat(9_000) }).BIG.length === 4_096,
    'T-15: a terminal environment value is clamped.',
  );
  const manyEnv = {};
  for (let i = 0; i < runtime.MAX_ENV_MUTATIONS + 20; i += 1) manyEnv[`V_${i}`] = 'x';
  assert(
    Object.keys(runtime.normalizeTerminalEnv(manyEnv)).length === runtime.MAX_ENV_MUTATIONS,
    'T-16: a terminal environment is capped at MAX_ENV_MUTATIONS entries.',
  );
  assert(
    Object.keys(runtime.normalizeTerminalEnv(['A=1'])).length === 0 &&
      Object.keys(runtime.normalizeTerminalEnv('A=1')).length === 0,
    'T-17: an array or a string is not an environment.',
  );
  assert(
    runtime.normalizeThemeColorId('terminal.ansiRed') === 'terminal.ansiRed' &&
      runtime.normalizeThemeColorId({ id: 'terminal.ansiRed' }) === 'terminal.ansiRed',
    'T-18: a theme colour id is accepted as a string or as a `ThemeColor`.',
  );
  for (const bad of ['#ff0000', 'red', 'rgb(1,2,3)', 'a.b;c', 'url(x)', `a.${'b'.repeat(200)}`]) {
    assert(
      runtime.normalizeThemeColorId(bad) === null,
      `T-19: ${JSON.stringify(bad)} is not a theme colour id — no CSS reaches the tab strip.`,
    );
  }
  assert(
    runtime.normalizeTerminalIcon('terminal-bash') === 'terminal-bash' &&
      runtime.normalizeTerminalIcon({ id: 'flame' }) === 'flame',
    'T-20: a codicon id is accepted as a string or as a `ThemeIcon`.',
  );
  for (const bad of ['Terminal', '/tmp/icon.png', '../x', 'a'.repeat(80), { light: 'a.png' }]) {
    assert(
      runtime.normalizeTerminalIcon(bad) === null,
      `T-21: ${JSON.stringify(bad)} is not a codicon id — a file path never becomes a tab icon.`,
    );
  }
  assert(
    runtime.normalizeTerminalRequest({ message: 'm'.repeat(9_000) }).message.length === 2_000,
    'T-22: the greeting message an extension sets is clamped.',
  );
  const nul = String.fromCharCode(0);
  assert(
    runtime.normalizeSendText('npm test', undefined) === 'npm test\r',
    'T-23: `sendText` appends a carriage return by default — a pty reads CR as Enter.',
  );
  assert(
    runtime.normalizeSendText('npm test', false) === 'npm test',
    'T-24: `sendText(text, false)` sends the text verbatim.',
  );
  assert(
    runtime.normalizeSendText('a\r', true) === 'a\r' &&
      runtime.normalizeSendText('a\n', true) === 'a\n',
    'T-25: a newline is not doubled when the text already ends with one.',
  );
  assert(
    runtime.normalizeSendText(`ec${nul}ho`, false) === 'echo',
    'T-26: a NUL is stripped from `sendText` rather than truncating the line inside the pty.',
  );
  assert(
    runtime.normalizeSendText('x'.repeat(runtime.MAX_SEND_TEXT + 500), false).length ===
      runtime.MAX_SEND_TEXT,
    'T-27: `sendText` is clamped to MAX_SEND_TEXT.',
  );
  assert(
    runtime.normalizeSendText(42, undefined) === '\r',
    'T-28: a non-string `sendText` sends nothing but the newline.',
  );
}

/**
 * The terminal registry: identity, ownership, state transitions and disposal.
 *
 * A terminal is a real OS process, so both bounds are load-bearing and both refusals are visible to
 * the extension. The transition methods return true only on a change, because each one is the trigger
 * for exactly one `onDidChangeTerminalState` / `onDidChangeActiveTerminal` event and firing twice is
 * what breaks an extension that counts them.
 */
function validatePhase7TerminalRegistry() {
  const runtime = load(`${COMMON}vscodeTerminalRuntime.ts`);
  const request = () => runtime.normalizeTerminalRequest({ name: 'T' });
  const registry = new runtime.TerminalRegistry();
  const first = registry.create('a.one', request());
  const second = registry.create('a.one', request());
  assert(
    first.handle !== second.handle && first.handle > 0,
    'TR-1: handles are distinct positive integers.',
  );
  assert(
    registry.countFor('a.one') === 2 && registry.countFor('b.two') === 0,
    'TR-2: terminals are counted per owning extension.',
  );
  assert(
    first.sessionId === null && first.processId === null && first.disposed === false,
    'TR-3: a new terminal has no session and no process until one is reported.',
  );
  assert(
    first.state.isInteractedWith === false && first.state.shellIntegration === false,
    'TR-4: `TerminalState` starts at upstream’s defaults.',
  );
  assert(
    registry.bySession('') === undefined,
    'TR-5: an empty session id resolves to nothing — a blank report must not adopt a waiting terminal.',
  );
  assert(
    registry.attachSession(first.handle, 'sess-1', 4_242) === true &&
      registry.bySession('sess-1') === first &&
      first.processId === 4_242,
    'TR-6: attaching a session binds the pane and its pid.',
  );
  assert(
    registry.attachSession(first.handle, 'sess-2', 1) === false && first.sessionId === 'sess-1',
    'TR-7: a second attach is refused, so a duplicate report cannot move a live terminal.',
  );
  assert(
    registry.attachSession(second.handle, '', 1) === false,
    'TR-8: an empty session id never attaches.',
  );
  assert(
    registry.attachSession(9_999, 'sess-x', 1) === false,
    'TR-9: attaching an unknown handle is refused rather than creating a record.',
  );
  assert(
    registry.markInteracted(first.handle) === true &&
      registry.markInteracted(first.handle) === false,
    'TR-10: `isInteractedWith` fires once — the second call reports no transition.',
  );
  assert(
    registry.markShellIntegration(first.handle, true) === true &&
      registry.markShellIntegration(first.handle, true) === false &&
      registry.markShellIntegration(first.handle, false) === true,
    'TR-11: shell integration reports only real transitions, in both directions.',
  );
  assert(
    registry.setActive(first.handle) === true &&
      registry.setActive(first.handle) === false &&
      registry.active() === first,
    'TR-12: the active terminal changes once per change.',
  );
  assert(
    registry.setActive(9_999) === false && registry.active() === first,
    'TR-13: an unknown handle cannot become the active terminal.',
  );
  assert(
    registry.dispose(first.handle, 0) === first &&
      first.disposed === true &&
      first.exitCode === 0 &&
      registry.active() === null,
    'TR-14: disposal returns the record once, records the exit code, and clears the active handle.',
  );
  assert(
    registry.dispose(first.handle, 0) === undefined,
    'TR-15: disposing twice returns nothing, so `onDidCloseTerminal` cannot fire twice.',
  );
  assert(
    registry.bySession('sess-1') === undefined,
    'TR-16: a disposed terminal is out of the registry, so a late report finds nothing.',
  );
  const perExtension = new runtime.TerminalRegistry();
  for (let i = 0; i < runtime.MAX_TERMINALS_PER_EXTENSION; i += 1) {
    perExtension.create('a.one', request());
  }
  let refusedPerExtension = false;
  try {
    perExtension.create('a.one', request());
  } catch (error) {
    refusedPerExtension = /at most 16 terminals/.test(error.message);
  }
  assert(
    refusedPerExtension,
    'TR-17: the per-extension terminal cap throws, so the extension sees the refusal.',
  );
  assert(
    perExtension.create('b.two', request()).handle > 0,
    'TR-18: the per-extension cap is per extension — another extension is unaffected.',
  );
  const total = new runtime.TerminalRegistry();
  for (let i = 0; i < runtime.MAX_EXTENSION_TERMINALS; i += 1) {
    total.create(`ext.${Math.floor(i / runtime.MAX_TERMINALS_PER_EXTENSION)}`, request());
  }
  let refusedTotal = false;
  try {
    total.create('ext.fresh', request());
  } catch (error) {
    refusedTotal = /at most 64 extension terminals/.test(error.message);
  }
  assert(refusedTotal, 'TR-19: the global terminal cap throws once 64 are tracked.');
  const teardown = new runtime.TerminalRegistry();
  const owned = teardown.create('a.one', request());
  const foreign = teardown.create('b.two', request());
  teardown.setActive(owned.handle);
  const removed = teardown.removeExtension('a.one');
  assert(
    removed.length === 1 &&
      removed[0] === owned &&
      owned.disposed === true &&
      teardown.active() === null &&
      teardown.size === 1 &&
      teardown.get(foreign.handle) === foreign,
    'TR-20: removing an extension takes only its terminals, marks them disposed and clears the active handle.',
  );
  assert(
    teardown.removeExtension('a.one').length === 0,
    'TR-21: removing an extension twice is a no-op, so crash teardown is idempotent.',
  );
  teardown.clear();
  assert(
    teardown.size === 0 && teardown.list().length === 0,
    'TR-22: `clear` empties the registry.',
  );
}

/**
 * `EnvironmentVariableCollection` — the one terminal surface that outlives the terminal.
 *
 * A collection changes the environment of every *future* terminal, is persisted when the extension
 * asks for it, and is read back at startup from a file. That makes three separate trust boundaries in
 * one class: the name grammar on the way in, the persistence filter on the way out, and the restore
 * path, which must treat what it reads as untrusted because it survived a process.
 */
function validatePhase7TerminalEnvironment() {
  const runtime = load(`${COMMON}vscodeTerminalRuntime.ts`);
  const store = new runtime.EnvCollectionStore();
  assert(
    store.mutate('a.one', '', 'PATH', '/extra', 'prepend') === true,
    'TE-1: a well-named variable is accepted.',
  );
  assert(
    store.mutate('a.one', '', 'BAD-NAME', 'v', 'replace') === false &&
      store.mutate('a.one', '', '1BAD', 'v', 'replace') === false,
    'TE-2: the environment name grammar refuses a name a shell would reinterpret.',
  );
  assert(
    store.get('a.one', '', 'PATH').type === 'prepend' &&
      store.get('a.one', '', 'PATH').applyAtProcessCreation === true &&
      store.get('a.one', '', 'PATH').applyAtShellIntegration === false,
    'TE-3: the mutator options default the way upstream defaults them.',
  );
  assert(
    store.mutate('a.one', '', 'PATH', '/other', 'append') === true &&
      store.get('a.one', '', 'PATH').value === '/other' &&
      store.countFor('a.one') === 1,
    'TE-4: re-mutating one variable replaces it rather than accumulating.',
  );
  assert(
    store.mutate('a.one', '/work/pkg', 'SCOPED', 'v', 'replace') === true &&
      store.get('a.one', '/work/pkg', 'SCOPED').value === 'v' &&
      store.get('a.one', '', 'SCOPED') === undefined,
    'TE-5: a scoped collection is separate from the global one.',
  );
  assert(store.countFor('a.one') === 2, 'TE-6: the per-extension count spans every scope.');
  assert(
    store.delete('a.one', '/work/pkg', 'SCOPED') === true &&
      store.delete('a.one', '/work/pkg', 'SCOPED') === false,
    'TE-7: deleting a mutation is idempotent.',
  );
  const capped = new runtime.EnvCollectionStore();
  for (let i = 0; i < runtime.MAX_ENV_MUTATIONS; i += 1) {
    capped.mutate('a.one', '', `V_${i}`, 'x', 'replace');
  }
  assert(
    capped.mutate('a.one', '', 'ONE_TOO_MANY', 'x', 'replace') === false &&
      capped.mutate('a.one', '', 'V_0', 'y', 'replace') === true,
    'TE-8: the mutation cap refuses a new variable but still allows an existing one to be rewritten.',
  );
  const scopes = new runtime.EnvCollectionStore();
  scopes.mutate('a.one', '', 'G', 'g', 'replace');
  scopes.mutate('a.one', '/work/pkg', 'S', 's', 'replace');
  assert(
    scopes.clearScope('a.one', '/work/pkg') === true &&
      scopes.clearScope('a.one', '/work/pkg') === false &&
      scopes.countFor('a.one') === 1,
    'TE-9: clearing one scope leaves the global collection alone.',
  );
  scopes.mutate('a.one', '/work/pkg', 'S', 's', 'replace');
  assert(
    scopes.clearScope('a.one', '') === true && scopes.countFor('a.one') === 0,
    'TE-10: clearing the root scope clears every scope, as `collection.clear()` does upstream.',
  );
  const persisted = new runtime.EnvCollectionStore();
  persisted.mutate('a.keep', '', 'K', 'k', 'replace');
  persisted.mutate('b.drop', '', 'D', 'd', 'replace');
  persisted.setPersistent('b.drop', false);
  persisted.setDescription('a.keep', 'Adds K');
  assert(
    Object.keys(persisted.serialize()).length === 1 &&
      persisted.serialize()['a.keep'].description === 'Adds K',
    'TE-11: only a persistent collection is written out.',
  );
  assert(
    Object.keys(persisted.all()).length === 2,
    'TE-12: every collection applies to this session, persistent or not.',
  );
  const restored = new runtime.EnvCollectionStore();
  assert(
    restored.restore({
      'a.keep': {
        persistent: true,
        description: 'd'.repeat(900),
        mutations: [
          { variable: 'OK', value: 'v', type: 2 },
          { variable: 'BAD-NAME', value: 'v', type: 1 },
          'not-an-object',
        ],
        scoped: { '/work/pkg': [{ variable: 'S', value: 's', type: 3 }] },
      },
      'b.drop': { persistent: false, mutations: [{ variable: 'X', value: 'x', type: 1 }] },
      'c.bad': 7,
    }) === 1,
    'TE-13: restore accepts only the persistent, well-formed collections.',
  );
  assert(
    restored.countFor('a.keep') === 2 &&
      restored.get('a.keep', '', 'OK').type === 'append' &&
      restored.get('a.keep', '', 'BAD-NAME') === undefined &&
      restored.get('a.keep', '/work/pkg', 'S').type === 'prepend' &&
      restored.data('a.keep').description.length === 500,
    'TE-14: a restored collection is re-validated — a bad name from disk is dropped and the description clamped.',
  );
  assert(
    restored.data('b.drop') === undefined && restored.restore(null) === 0,
    'TE-15: a non-persistent collection is not resurrected, and a malformed file restores nothing.',
  );
  assert(
    runtime.normalizeEnvMutationType(1) === 'replace' &&
      runtime.normalizeEnvMutationType(2) === 'append' &&
      runtime.normalizeEnvMutationType(3) === 'prepend' &&
      runtime.normalizeEnvMutationType('append') === 'append' &&
      runtime.normalizeEnvMutationType(99) === 'replace',
    'TE-16: the mutation kind is read from upstream’s enum values, and an unknown one is a replace.',
  );
  assert(
    runtime.envScopeKey('/work/pkg') === '/work/pkg' &&
      runtime.envScopeKey({ workspaceFolder: { uri: { fsPath: '/work/pkg' } } }) === '/work/pkg' &&
      runtime.envScopeKey(undefined) === '' &&
      runtime.envScopeKey({ workspaceFolder: 7 }) === '',
    'TE-17: a scope reduces to a folder path from either shape, and to the global scope otherwise.',
  );
  const applied = runtime.applyEnvCollections(
    { PATH: '/usr/bin', KEEP: 'yes' },
    {
      'b.second': {
        mutations: [
          {
            variable: 'PATH',
            value: ':/b',
            type: 'append',
            applyAtProcessCreation: true,
            applyAtShellIntegration: false,
          },
        ],
        scoped: {},
        description: null,
        persistent: true,
      },
      'a.first': {
        mutations: [
          {
            variable: 'PATH',
            value: '/a:',
            type: 'prepend',
            applyAtProcessCreation: true,
            applyAtShellIntegration: false,
          },
        ],
        scoped: {},
        description: null,
        persistent: true,
      },
    },
    '',
  );
  assert(
    applied.PATH === '/a:/usr/bin:/b' && applied.KEEP === 'yes',
    'TE-18: collections fold in extension-id order, so two extensions touching one variable are deterministic.',
  );
  const shellOnly = runtime.applyEnvCollections(
    { A: 'base' },
    {
      'a.one': {
        description: null,
        persistent: true,
        scoped: {},
        mutations: [
          {
            variable: 'A',
            value: 'shell',
            type: 'replace',
            applyAtProcessCreation: false,
            applyAtShellIntegration: true,
          },
        ],
      },
    },
    '',
  );
  assert(
    shellOnly.A === 'base',
    'TE-19: a shell-integration-only mutation does not change the spawn environment — AXIOM runs no integration script.',
  );
  const scopedApply = runtime.applyEnvCollections(
    {},
    {
      'a.one': {
        description: null,
        persistent: true,
        mutations: [],
        scoped: {
          '/work/pkg': [
            {
              variable: 'S',
              value: 'v',
              type: 'replace',
              applyAtProcessCreation: true,
              applyAtShellIntegration: false,
            },
          ],
        },
      },
    },
    '/work/pkg',
  );
  assert(scopedApply.S === 'v', 'TE-20: a scoped mutation applies to a terminal in that folder.');
  const forget = new runtime.EnvCollectionStore();
  forget.mutate('a.one', '', 'A', 'v', 'replace');
  assert(
    forget.removeExtension('a.one') === true && forget.removeExtension('a.one') === false,
    'TE-21: an uninstalled extension’s collection is dropped once.',
  );
}

/** Contributed terminal profiles: one owner per id, and a bounded number of them. */
function validatePhase7TerminalProfiles() {
  const runtime = load(`${COMMON}vscodeTerminalRuntime.ts`);
  const profiles = new runtime.TerminalProfileRegistry();
  assert(
    profiles.register('a.one', 'axiom.bash') === true && profiles.owner('axiom.bash') === 'a.one',
    'TP-1: a profile provider registers and is found by id.',
  );
  assert(
    profiles.register('a.one', 'axiom.bash') === true && profiles.size === 1,
    'TP-2: re-registering the same id from the same extension replaces it.',
  );
  assert(
    profiles.register('b.two', 'axiom.bash') === false && profiles.owner('axiom.bash') === 'a.one',
    'TP-3: a second extension cannot hijack a profile id another already owns.',
  );
  assert(
    profiles.unregister('b.two', 'axiom.bash') === false,
    'TP-4: only the owner may unregister a profile.',
  );
  for (let i = 0; i < runtime.MAX_PROFILE_PROVIDERS - 1; i += 1) {
    assert(
      profiles.register('a.one', `axiom.p${i}`) === true,
      `TP-5.${i}: profile ${i} registers.`,
    );
  }
  assert(
    profiles.register('a.one', 'axiom.over') === false,
    'TP-6: the per-extension profile cap refuses the ninth.',
  );
  assert(
    profiles.removeExtension('a.one').length === runtime.MAX_PROFILE_PROVIDERS &&
      profiles.size === 0 &&
      profiles.owner('axiom.bash') === null,
    'TP-7: removing an extension takes every profile it owned.',
  );
  assert(
    profiles.register('b.two', 'axiom.zsh') === true &&
      profiles.list().length === 1 &&
      profiles.unregister('b.two', 'axiom.zsh') === true,
    'TP-8: the id is free again once its owner is gone.',
  );
}
// --------------------------------------------------------------------------
// PRD Phase 7 §2 — Task API
// --------------------------------------------------------------------------
/**
 * What a task *is* before anything runs.
 *
 * `ShellExecution` is the most dangerous thing Phase 7 adds — a command line an extension asks AXIOM
 * to run — and every decision that makes it safe is decidable without a process: is there a command at
 * all, are the arguments strings, is the environment a set of portable names. Each is asserted here, so
 * the service is left holding only the spawn.
 */
function validatePhase7TaskNormalisation() {
  const runtime = load(`${COMMON}vscodeTaskRuntime.ts`);
  const nul = String.fromCharCode(0);
  assert(
    runtime.normalizeShellQuoting(1) === 'escape' &&
      runtime.normalizeShellQuoting(2) === 'strong' &&
      runtime.normalizeShellQuoting(3) === 'weak' &&
      runtime.normalizeShellQuoting('strong') === 'strong' &&
      runtime.normalizeShellQuoting(9) === null,
    'TK-1: `ShellQuoting` is read from upstream’s enum values, and an unknown one asks for nothing.',
  );
  assert(
    runtime.normalizeTaskArgument('-p').value === '-p' &&
      runtime.normalizeTaskArgument('-p').quoting === null,
    'TK-2: a bare string argument carries no quoting request.',
  );
  assert(
    runtime.normalizeTaskArgument({ value: 'a b', quoting: 2 }).quoting === 'strong',
    'TK-3: a `ShellQuotedString` keeps its quoting.',
  );
  assert(
    runtime.normalizeTaskArgument({ quoting: 2 }) === null &&
      runtime.normalizeTaskArgument(7) === null,
    'TK-4: an argument with no string value is dropped rather than coerced onto a command line.',
  );
  assert(
    runtime.normalizeTaskArgument(`a${nul}b`).value === 'ab' &&
      runtime.normalizeTaskArgument('x'.repeat(9_000)).value.length === runtime.MAX_TASK_STRING,
    'TK-5: an argument is NUL-stripped and clamped — a NUL truncates argv at the C boundary.',
  );
  const process_ = runtime.normalizeTaskExecution({ command: 'tsc', args: ['-p', '.'] });
  assert(
    process_.kind === 'process' && process_.command === 'tsc' && process_.args.length === 2,
    'TK-6: a command with arguments and no shell request is a `ProcessExecution`.',
  );
  assert(
    runtime.normalizeTaskExecution({ commandLine: 'npm run build' }).kind === 'shell',
    'TK-7: a command line is a `ShellExecution` even when no kind was declared.',
  );
  assert(
    runtime.normalizeTaskExecution({ command: 'tsc', options: { shell: true } }).kind === 'shell',
    'TK-8: `options.shell` moves a command onto a shell.',
  );
  assert(
    runtime.normalizeTaskExecution({ kind: 'custom' }).kind === 'custom' &&
      runtime.normalizeTaskExecution({ custom: true }).kind === 'custom',
    'TK-9: a `CustomExecution` is recognised with no command at all — its callback lives in the host.',
  );
  assert(
    runtime.normalizeTaskExecution({}).kind === 'none' &&
      runtime.normalizeTaskExecution({ kind: 'shell' }).kind === 'none' &&
      runtime.normalizeTaskExecution({ kind: 'process' }).kind === 'none',
    'TK-10: an execution that names nothing to run is `none`, whatever it declared.',
  );
  assert(
    runtime.normalizeTaskExecution({ command: { value: 'my tool', quoting: 2 } }).command ===
      'my tool',
    'TK-11: a `ShellQuotedString` command is read through its value.',
  );
  const manyArgs = runtime.normalizeTaskExecution({
    command: 'x',
    args: Array.from({ length: 400 }, (_, index) => `a${index}`),
  });
  assert(
    manyArgs.args.length === runtime.MAX_TASK_ARGS,
    'TK-12: argv is capped at MAX_TASK_ARGS — a generated argument list cannot grow without bound.',
  );
  const dirty = runtime.normalizeTaskExecution({
    command: 'x',
    args: ['ok', 7, null, { value: 'also-ok' }, { quoting: 1 }],
  });
  assert(
    dirty.args.length === 2 && dirty.args[0].value === 'ok' && dirty.args[1].value === 'also-ok',
    'TK-13: a non-argument entry is dropped rather than stringified into the command line.',
  );
  const env = runtime.normalizeTaskExecution({
    command: 'x',
    options: { env: { GOOD: '1', '2BAD': 'x', 'BAD-NAME': 'x', NUMERIC: 7 } },
  });
  assert(
    Object.keys(env.env).length === 1 && env.env.GOOD === '1',
    'TK-14: a task environment keeps only portable names with string values.',
  );
  const bigEnv = {};
  for (let index = 0; index < 200; index += 1) bigEnv[`V${index}`] = 'x';
  assert(
    Object.keys(runtime.normalizeTaskExecution({ command: 'x', options: { env: bigEnv } }).env)
      .length === runtime.MAX_TASK_ENV,
    'TK-15: a task environment is capped at MAX_TASK_ENV.',
  );
  assert(
    runtime.normalizeTaskExecution({ command: 'x', options: { env: ['A=1'] } }).env &&
      Object.keys(runtime.normalizeTaskExecution({ command: 'x', options: { env: ['A=1'] } }).env)
        .length === 0,
    'TK-16: an array environment yields no variables rather than index-named ones.',
  );
  const cwd = runtime.normalizeTaskExecution({
    command: 'x',
    options: { cwd: { fsPath: '/repo/app' } },
  });
  assert(
    cwd.cwd === '/repo/app' &&
      runtime.normalizeTaskExecution({ command: 'x', options: { cwd: '/repo' } }).cwd === '/repo' &&
      runtime.normalizeTaskExecution({ command: 'x', options: { cwd: 7 } }).cwd === null,
    'TK-17: a task cwd is read from a string or a Uri and is otherwise absent — the service authorises it.',
  );
  const pinned = runtime.normalizeTaskExecution({
    commandLine: 'ls',
    options: { executable: '/bin/bash', shellArgs: ['-lc', 7] },
  });
  assert(
    pinned.shellExecutable === '/bin/bash' &&
      pinned.shellArgs.length === 1 &&
      pinned.shellArgs[0] === '-lc',
    'TK-18: a pinned shell keeps its executable and only its string arguments.',
  );
  assert(
    runtime.normalizeTaskGroup('build') === 'build' &&
      runtime.normalizeTaskGroup({ id: 'test' }) === 'test' &&
      runtime.normalizeTaskGroup('deploy') === null &&
      runtime.normalizeTaskGroup(null) === null,
    'TK-19: only upstream’s four task groups are recognised.',
  );
  assert(
    runtime.normalizeTaskScope(1).scope === 'global' &&
      runtime.normalizeTaskScope(2).scope === 'workspace' &&
      runtime.normalizeTaskScope({ uri: { fsPath: '/repo' } }).scope === 'folder' &&
      runtime.normalizeTaskScope({ uri: { fsPath: '/repo' } }).path === '/repo' &&
      runtime.normalizeTaskScope('nonsense').scope === 'workspace',
    'TK-20: `TaskScope` values and a `WorkspaceFolder` resolve, and anything else is workspace-scoped.',
  );
  const task = runtime.normalizeTask(
    {
      name: 'build',
      definition: { type: 'npm', script: 'build', nested: { dropped: true } },
      execution: { commandLine: 'npm run build' },
      group: 'build',
      problemMatchers: '$tsc',
      detail: 'Compile everything',
      isBackground: 'yes',
    },
    'acme.tools',
  );
  assert(
    task.id === 'acme.tools.npm.build' && task.source === 'acme.tools',
    'TK-21: a task id is source.type.name, so two extensions providing the same type stay distinct.',
  );
  assert(
    task.definitionType === 'npm' &&
      task.definition.type === 'npm' &&
      task.definition.script === 'build' &&
      task.definition.nested === undefined,
    'TK-22: a task definition keeps its scalars and drops nested values that would not survive the wire.',
  );
  assert(
    task.problemMatchers.length === 1 && task.problemMatchers[0] === '$tsc',
    'TK-23: a single problem matcher given as a string becomes a one-element list.',
  );
  assert(
    task.isBackground === false,
    'TK-24: `isBackground` is strictly boolean — a truthy string does not make a task a background one.',
  );
  assert(
    runtime.normalizeTask({}, 'acme.tools').name === 'task' &&
      runtime.normalizeTask({}, 'acme.tools').definitionType === 'axiom',
    'TK-25: an unnamed task is still listable, with upstream-shaped defaults.',
  );
  assert(
    runtime.normalizeTask({}, '').source === 'Workspace',
    'TK-26: a task with no owning extension is sourced to the workspace, as `tasks.json` tasks are.',
  );
  assert(
    runtime.normalizeTask(
      { problemMatchers: Array.from({ length: 100 }, () => '$tsc') },
      'acme.tools',
    ).problemMatchers.length === 32,
    'TK-27: problem matchers are capped.',
  );
  assert(
    runtime.normalizeTask({ detail: 'd'.repeat(4_000) }, 'acme.tools').detail.length === 1_000 &&
      runtime.normalizeTask({ name: 'n'.repeat(1_000) }, 'acme.tools').name.length === 300,
    'TK-28: task text shown in the UI is clamped at the boundary.',
  );
}

/**
 * What a validated execution becomes on the way to a spawn.
 *
 * A path with a space that renders as two arguments is the classic task bug, and on Windows it is the
 * classic task *vulnerability* — so both platforms are asserted for every quoting mode upstream
 * defines, including the unasked-for case, where AXIOM quotes anyway rather than let the shell re-split.
 */
function validatePhase7TaskRendering() {
  const runtime = load(`${COMMON}vscodeTaskRuntime.ts`);
  const quote = runtime.quoteShellArgument;
  assert(
    quote('a b', 'strong', false) === `'a b'` && quote('a b', 'strong', true) === '"a b"',
    'TQ-1: `strong` quoting is single quotes on POSIX and double quotes on Windows, where single quotes are not quoting.',
  );
  assert(
    quote(`it's`, 'strong', false) === String.raw`'it'\''s'`,
    'TQ-2: a single quote inside a strongly quoted POSIX argument is closed, escaped and reopened.',
  );
  assert(
    quote('say "hi"', 'strong', true) === String.raw`"say \"hi\""`,
    'TQ-3: a double quote inside a strongly quoted Windows argument is escaped.',
  );
  assert(
    quote('$PATH', 'weak', false) === String.raw`"\$PATH"` &&
      quote('$PATH', 'weak', true) === String.raw`"\$PATH"`,
    'TQ-4: `weak` quoting is double quotes on both platforms with expansion characters escaped.',
  );
  assert(
    quote('a b', 'escape', false) === String.raw`a\ b` && quote('a&b', 'escape', true) === 'a^&b',
    'TQ-5: `escape` quoting escapes per-character — backslash on POSIX, caret on Windows.',
  );
  assert(
    quote('a b', null, false) === `'a b'` && quote('a b', null, true) === '"a b"',
    'TQ-6: an argument that would split is quoted even when no quoting was asked for.',
  );
  assert(
    quote('simple', null, false) === 'simple' && quote('--flag=1', null, false) === '--flag=1',
    'TQ-7: an argument that cannot split is passed through unchanged.',
  );
  const shell = runtime.normalizeTaskExecution({
    command: 'npm',
    args: ['run', { value: 'my build', quoting: 2 }],
    options: { shell: true },
  });
  assert(
    runtime.renderShellCommandLine(shell, false) === `npm run 'my build'` &&
      runtime.renderShellCommandLine(shell, true) === 'npm run "my build"',
    'TQ-8: a shell execution renders as its command followed by its per-argument quoting.',
  );
  const line = runtime.normalizeTaskExecution({ commandLine: 'echo "hi" && ls' });
  assert(
    runtime.renderShellCommandLine(line, false) === 'echo "hi" && ls' &&
      runtime.renderShellCommandLine(line, true) === 'echo "hi" && ls',
    'TQ-9: an explicit command line is handed to the shell verbatim — re-quoting it would change what the workspace asked for.',
  );
  const none = runtime.normalizeTaskExecution({});
  assert(
    runtime.renderShellCommandLine(none, false) === '' &&
      runtime.renderProcessArgv(none).length === 0,
    'TQ-10: an execution with nothing to run renders to nothing, so the service has nothing to spawn.',
  );
  const argv = runtime.normalizeTaskExecution({
    command: 'node',
    args: ['--eval', 'console.log(1)', 'a b'],
  });
  assert(
    runtime.renderProcessArgv(argv).join('|') === 'node|--eval|console.log(1)|a b',
    'TQ-11: a process execution is argv — nothing is quoted, because nothing reaches a shell.',
  );
  assert(
    runtime.renderProcessArgv(argv)[0] === 'node',
    'TQ-12: the command is argv[0] of a process execution.',
  );
  const quoted = runtime.normalizeTaskExecution({
    command: 'my tool',
    args: [{ value: 'x', quoting: 3 }],
    options: { shell: true },
  });
  assert(
    runtime.renderShellCommandLine(quoted, false) === `'my tool' "x"` &&
      runtime.renderShellCommandLine(quoted, true) === '"my tool" "x"',
    'TQ-13: the command itself is quoted when it would split, independently of its arguments’ own quoting.',
  );
  assert(
    runtime.renderShellCommandLine(runtime.normalizeTaskExecution({ kind: 'custom' }), false) ===
      '',
    'TQ-14: a custom execution renders no command line — its callback runs in the extension host.',
  );
}

/**
 * Providers, executions, and the transitions the four task events are fired from.
 *
 * The invariant worth the most here is that `end` returns the record only on the transition: an
 * extension that resolves a promise inside `onDidEndTask` breaks if the event fires twice, and nothing
 * in the service can prevent that if the registry does not.
 */
function validatePhase7TaskLifecycle() {
  const runtime = load(`${COMMON}vscodeTaskRuntime.ts`);
  const providers = new runtime.TaskProviderRegistry();
  const first = providers.register('acme.tools', 'npm');
  const second = providers.register('other.ext', 'npm');
  assert(
    first.token !== second.token && first.type === 'npm' && second.extensionId === 'other.ext',
    'TL-1: two extensions may provide the same task type, each with its own token.',
  );
  assert(
    providers.providersFor('npm').length === 2 &&
      providers.providersFor('gulp').length === 0 &&
      providers.providersFor(null).length === 2,
    'TL-2: `fetchTasks` asks every provider for a type, or every provider at all when no type is given.',
  );
  assert(
    providers.unregister(first.token) === first && providers.unregister(first.token) === undefined,
    'TL-3: disposing a task provider is idempotent — a double dispose is not an error.',
  );
  assert(
    providers.providersFor('npm').length === 1 && providers.countFor('acme.tools') === 0,
    'TL-4: a disposed provider stops answering, and only that registration is gone.',
  );
  for (let index = 0; index < runtime.MAX_TASK_PROVIDERS; index += 1) {
    providers.register('acme.tools', `type${index}`);
  }
  assert(
    (() => {
      try {
        providers.register('acme.tools', 'overflow');
        return false;
      } catch (error) {
        return /at most 16 task providers/.test(String(error));
      }
    })(),
    'TL-5: task providers are capped per extension.',
  );
  assert(
    providers.countFor('other.ext') === 1,
    'TL-6: one extension reaching the provider cap does not stop another registering.',
  );
  assert(
    providers.removeExtension('acme.tools').length === runtime.MAX_TASK_PROVIDERS &&
      providers.countFor('acme.tools') === 0 &&
      providers.size === 1,
    'TL-7: unloading an extension takes every provider it owns and leaves the others.',
  );
  const executions = new runtime.TaskExecutionRegistry();
  const spec = runtime.normalizeTask(
    { name: 'build', definition: { type: 'npm' }, execution: { commandLine: 'npm run build' } },
    'acme.tools',
  );
  const run = executions.start(spec, 'caller.ext', 1_000);
  assert(
    run.id > 0 &&
      run.state === 'starting' &&
      run.processId === null &&
      run.exitCode === null &&
      run.cancelled === false &&
      run.endedAt === null,
    'TL-8: a new execution is `starting` with no process — `onDidStartTask` fires before one exists.',
  );
  assert(
    executions.attachProcess(run.id, 4_321) === run &&
      run.state === 'running' &&
      run.processId === 4_321,
    'TL-9: attaching the process moves the execution to `running` — the state `onDidStartTaskProcess` reports.',
  );
  assert(
    executions.attachProcess(9_999, 1) === undefined,
    'TL-10: an unknown execution id cannot be given a process.',
  );
  assert(
    executions.markCancelled(run.id) === true && executions.markCancelled(run.id) === false,
    'TL-11: cancellation is recorded once, so one `executeTask` cannot be cancelled twice.',
  );
  assert(
    executions.end(run.id, 0, 2_000) === run &&
      run.state === 'ended' &&
      run.exitCode === 0 &&
      run.endedAt === 2_000,
    'TL-12: ending an execution records the exit code and the time.',
  );
  assert(
    executions.end(run.id, 1, 3_000) === undefined && run.exitCode === 0,
    'TL-13: `onDidEndTask` can fire only once — a second end is refused and does not rewrite the exit code.',
  );
  assert(
    executions.attachProcess(run.id, 5) === undefined && executions.markCancelled(run.id) === false,
    'TL-14: an ended execution takes no process and cannot be cancelled.',
  );
  assert(
    executions.runningCount() === 0 && executions.running().length === 0,
    'TL-15: an ended execution is not running.',
  );
  const live = [];
  for (let index = 0; index < runtime.MAX_CONCURRENT_TASKS; index += 1) {
    live.push(executions.start(spec, 'caller.ext', 1_000 + index));
  }
  assert(
    executions.runningCount() === runtime.MAX_CONCURRENT_TASKS,
    'TL-16: concurrent executions are counted.',
  );
  assert(
    (() => {
      try {
        executions.start(spec, 'caller.ext', 9_000);
        return false;
      } catch (error) {
        return /at most 8 tasks at once/.test(String(error));
      }
    })(),
    'TL-17: the concurrency cap refuses a ninth running task — a provider loop cannot fork-bomb the machine.',
  );
  assert(
    executions.forExtension('caller.ext').length === runtime.MAX_CONCURRENT_TASKS &&
      executions.forExtension('acme.tools').length === runtime.MAX_CONCURRENT_TASKS &&
      executions.forExtension('nobody').length === 0,
    'TL-18: teardown reaches both the extension that started a task and the one that provided it.',
  );
  assert(
    executions.forExtension('caller.ext').every((record) => record.state !== 'ended'),
    'TL-19: teardown never re-terminates an execution that has already ended.',
  );
  executions.end(live[0].id, 130, 4_000);
  assert(
    executions.runningCount() === runtime.MAX_CONCURRENT_TASKS - 1 &&
      executions.start(spec, 'caller.ext', 5_000).id > 0,
    'TL-20: a slot freed by an ended task is immediately reusable.',
  );
  const churn = new runtime.TaskExecutionRegistry();
  const keep = [];
  for (let index = 0; index < 4; index += 1) keep.push(churn.start(spec, 'caller.ext', index));
  for (let index = 0; index < 400; index += 1) {
    const record = churn.start(spec, 'caller.ext', index);
    churn.end(record.id, 0, index);
  }
  assert(
    churn.size <= runtime.MAX_TRACKED_EXECUTIONS,
    'TL-21: finished executions are evicted, so a task-heavy session does not accumulate records for the life of the window.',
  );
  assert(
    keep.every((record) => churn.get(record.id) === record),
    'TL-22: eviction only ever takes ended executions — a running task is never forgotten while it runs.',
  );
  churn.clear();
  assert(
    churn.size === 0 && churn.runningCount() === 0,
    'TL-23: clearing the execution registry empties it — the workspace-change path.',
  );
  const providerBound = new runtime.TaskProviderRegistry();
  providerBound.register('acme.tools', 'x'.repeat(500));
  assert(
    providerBound.list()[0].type.length === 200,
    'TL-24: a provider’s task type is clamped before it is stored.',
  );
}

// --------------------------------------------------------------------------
// PRD Phase 7 §3 — Debug (DAP)
// --------------------------------------------------------------------------
/**
 * The wire between AXIOM and a debug adapter.
 *
 * Framing is the whole attack surface of a debug session: an adapter is a program the workspace named,
 * and everything it says arrives as bytes on a pipe. A lying `Content-Length` must close the read, a
 * body that is not a message must be dropped without taking the session down, and the length must be
 * counted in bytes — the three ways a DAP reader desynchronises in the field.
 */
function validatePhase7DapTransport() {
  const runtime = load(`${COMMON}vscodeDebugRuntime.ts`);
  const frame = (message) => Buffer.from(runtime.encodeDapMessage(message));
  const header = (text) => Buffer.from(`${text}\r\n\r\n`, 'utf8');
  const event = { seq: 1, type: 'event', event: 'output' };
  const nonAscii = { seq: 2, type: 'event', event: 'stopped', reason: 'pausé' };
  const framedNonAscii = frame(nonAscii);
  const declared = Number(/Content-Length: (\d+)/.exec(framedNonAscii.toString('utf8'))[1]);
  const json = JSON.stringify(nonAscii);
  assert(
    declared === Buffer.byteLength(json, 'utf8') && declared !== json.length,
    'D-1: `Content-Length` counts bytes, not characters — a non-ASCII path would desynchronise the session.',
  );
  const reader = new runtime.DapMessageReader();
  const first = reader.push(frame(event));
  assert(
    first.messages.length === 1 &&
      first.messages[0].event === 'output' &&
      first.errors.length === 0 &&
      reader.pending === 0,
    'D-2: a whole framed message round-trips and leaves nothing buffered.',
  );
  const split = frame(event);
  const partial = reader.push(split.subarray(0, 5));
  assert(
    partial.messages.length === 0 && reader.pending === 5,
    'D-3: a chunk that stops inside the header is buffered, not parsed — chunk boundaries are arbitrary.',
  );
  const completed = reader.push(split.subarray(5));
  assert(
    completed.messages.length === 1 && reader.pending === 0,
    'D-4: the message is delivered once the rest of it arrives.',
  );
  const both = reader.push(
    Buffer.concat([
      frame({ seq: 3, type: 'event', event: 'a' }),
      frame({ seq: 4, type: 'event', event: 'b' }),
    ]),
  );
  assert(
    both.messages.length === 2 && both.messages[0].event === 'a' && both.messages[1].event === 'b',
    'D-5: two messages in one chunk are delivered in order.',
  );
  const headerless = reader.push(Buffer.concat([header('X-Nonsense: 1'), frame(event)]));
  assert(
    headerless.errors.length === 1 &&
      headerless.errors[0] === 'bad-header' &&
      headerless.messages.length === 1,
    'D-6: a header block with no `Content-Length` is dropped up to the terminator and the next message still arrives.',
  );
  const lower = reader.push(
    Buffer.concat([
      header(`content-length: ${Buffer.byteLength(JSON.stringify(event), 'utf8')}`),
      Buffer.from(JSON.stringify(event), 'utf8'),
    ]),
  );
  assert(
    lower.messages.length === 1 && lower.errors.length === 0,
    'D-7: the header name is matched case-insensitively, as the protocol requires.',
  );
  assert(
    reader.push(Buffer.concat([header('Content-Length: -1'), frame(event)])).errors[0] ===
      'bad-header',
    'D-8: a negative length is refused as a bad header rather than treated as zero.',
  );
  assert(
    reader.push(Buffer.concat([header('Content-Length: 1.5'), frame(event)])).errors[0] ===
      'bad-header',
    'D-9: a non-integer length is refused.',
  );
  const badJson = reader.push(Buffer.concat([header('Content-Length: 3'), Buffer.from('abc')]));
  assert(
    badJson.errors.length === 1 && badJson.errors[0] === 'bad-json' && reader.isClosed === false,
    'D-10: a body that does not parse is reported and skipped — an adapter logging to stdout must not end the session.',
  );
  const notMessage = JSON.stringify({ hello: 'world' });
  const shaped = reader.push(
    Buffer.concat([
      header(`Content-Length: ${Buffer.byteLength(notMessage, 'utf8')}`),
      Buffer.from(notMessage, 'utf8'),
    ]),
  );
  assert(
    shaped.errors.length === 1 &&
      shaped.errors[0] === 'not-a-message' &&
      reader.isClosed === false &&
      shaped.messages.length === 0,
    'D-11: valid JSON that is not a DAP message is dropped rather than dispatched by a default branch.',
  );
  const liar = reader.push(header(`Content-Length: ${runtime.MAX_DAP_MESSAGE_BYTES + 1}`));
  assert(
    liar.errors[0] === 'too-large' && reader.isClosed === true,
    'D-12: a declared length over the cap closes the read — the reader cannot know where the next header would start.',
  );
  const afterClose = reader.push(frame(event));
  assert(
    afterClose.messages.length === 0 && afterClose.errors.length === 0,
    'D-13: a closed reader ignores everything that follows — nothing after a desynchronisation is trusted.',
  );
  reader.reset();
  assert(
    reader.isClosed === false &&
      reader.pending === 0 &&
      reader.push(frame(event)).messages.length === 1,
    'D-14: `reset` reopens the reader for the next session on the same transport.',
  );
  const flood = new runtime.DapMessageReader();
  const overflow = flood.push(Buffer.alloc(runtime.MAX_DAP_MESSAGE_BYTES * 2 + 1, 0x41));
  assert(
    overflow.errors[0] === 'too-large' && flood.isClosed === true && flood.pending === 0,
    'D-15: an adapter that never sends a terminator cannot pin memory — the buffer itself is bounded.',
  );
  assert(
    runtime.asDapMessage([{ type: 'event', event: 'x' }]) === null &&
      runtime.asDapMessage('event') === null &&
      runtime.asDapMessage(null) === null,
    'D-16: only an object is a message — an array would spread into numeric keys.',
  );
  assert(
    runtime.asDapMessage({ type: 'progress', seq: 1 }) === null,
    'D-17: the three DAP message types are closed.',
  );
  assert(
    runtime.asDapMessage({ type: 'request', seq: 1 }) === null &&
      runtime.asDapMessage({ type: 'request', seq: 1, command: 'next' }) !== null,
    'D-18: a request without a command is refused.',
  );
  assert(
    runtime.asDapMessage({ type: 'response', seq: 1 }) === null &&
      runtime.asDapMessage({ type: 'response', seq: 1, request_seq: 4 }) !== null,
    'D-19: a response without a `request_seq` is refused — nothing could be resolved by it.',
  );
  assert(
    runtime.asDapMessage({ type: 'event', seq: 1 }) === null &&
      runtime.asDapMessage({ type: 'event', seq: 1, event: 'exited' }) !== null,
    'D-20: an event without an event name is refused.',
  );
  assert(
    runtime.asDapMessage({ type: 'event', event: 'x' }).seq === 0 &&
      runtime.asDapMessage({ type: 'event', event: 'x', seq: Number.NaN }).seq === 0 &&
      runtime.asDapMessage({ type: 'event', event: 'x', seq: '7' }).seq === 0,
    'D-21: a missing or non-finite `seq` becomes 0 rather than leaking NaN into the protocol.',
  );
  const outbound = runtime.validateOutboundDapMessage({
    type: 'request',
    seq: 9,
    command: 'evaluate',
    arguments: { expression: '1+1' },
  });
  assert(
    outbound.ok === true &&
      outbound.message.command === 'evaluate' &&
      outbound.message.arguments.expression === '1+1',
    'D-22: a well-formed request from an extension is accepted with its arguments intact.',
  );
  assert(
    runtime.validateOutboundDapMessage({ command: 'evaluate' }).ok === false &&
      runtime.validateOutboundDapMessage({ command: 'evaluate' }).error === 'Not a DAP message.',
    'D-23: `customRequest` cannot send something that is not a DAP message.',
  );
  const cyclic = { type: 'event', seq: 1, event: 'x' };
  cyclic.self = cyclic;
  assert(
    runtime.validateOutboundDapMessage(cyclic).ok === false &&
      /not serialisable/.test(runtime.validateOutboundDapMessage(cyclic).error),
    'D-24: a cyclic message is refused here rather than throwing on the IPC boundary.',
  );
  const huge = runtime.validateOutboundDapMessage({
    type: 'request',
    seq: 1,
    command: 'evaluate',
    arguments: { blob: 'a'.repeat(runtime.MAX_DAP_MESSAGE_BYTES + 16) },
  });
  assert(
    huge.ok === false && /size limit/.test(huge.error),
    'D-25: an extension cannot smuggle a body past the framing cap by way of `arguments`.',
  );
}

/**
 * A launch configuration and an adapter descriptor, both authored outside AXIOM.
 *
 * A configuration is user JSON rewritten by every `resolveDebugConfiguration` hook in turn, and a
 * descriptor decides what AXIOM *starts*. The loopback pinning asserted here is a deliberate
 * divergence from upstream: a descriptor that named a remote host would have AXIOM speak a
 * file-reading protocol to an address an extension chose.
 */
function validatePhase7DebugConfiguration() {
  const runtime = load(`${COMMON}vscodeDebugRuntime.ts`);
  assert(
    runtime.normalizeDebugConfiguration({ type: 'node' }).name === 'node',
    'DC-1: an unnamed configuration is named after its type, as the debug UI needs a label.',
  );
  assert(
    runtime.normalizeDebugConfiguration({ type: '', name: 'x' }) === null &&
      runtime.normalizeDebugConfiguration({ name: 'x' }) === null &&
      runtime.normalizeDebugConfiguration({ type: '../node', name: 'x' }) === null &&
      runtime.normalizeDebugConfiguration({ type: 'a'.repeat(200) }) === null,
    'DC-2: a configuration with no usable type is refused — the type selects which factory is asked to start a process.',
  );
  assert(
    runtime.normalizeDebugConfiguration([]) === null &&
      runtime.normalizeDebugConfiguration('node') === null,
    'DC-3: only an object is a configuration.',
  );
  assert(
    runtime.normalizeDebugConfiguration({ type: 'node' }).request === 'launch' &&
      runtime.normalizeDebugConfiguration({ type: 'node', request: 'attach' }).request ===
        'attach' &&
      runtime.normalizeDebugConfiguration({ type: 'node', request: 'evil' }).request === 'launch',
    'DC-4: `request` is one of two values, defaulting to launch.',
  );
  const config = runtime.normalizeDebugConfiguration({
    type: 'node',
    name: 'Run',
    request: 'launch',
    program: '${workspaceFolder}/index.js',
    env: { A: '1' },
  });
  assert(
    config.rest.program === '${workspaceFolder}/index.js' &&
      config.rest.env.A === '1' &&
      config.rest.type === undefined &&
      config.rest.name === undefined &&
      config.rest.request === undefined,
    'DC-5: the three known fields are lifted out and everything else is carried in `rest`, unsubstituted.',
  );
  const deep = { type: 'node' };
  let node = deep;
  for (let index = 0; index < 20; index += 1) {
    node.child = {};
    node = node.child;
  }
  node.leaf = 'bottom';
  const bounded = runtime.normalizeDebugConfiguration(deep);
  let walk = bounded.rest.child;
  let depth = 1;
  while (walk !== null && typeof walk === 'object' && walk.child !== undefined) {
    walk = walk.child;
    depth += 1;
  }
  assert(
    depth < 20 && walk === null,
    'DC-6: cloning a configuration is depth-bounded, so a pathological object cannot be walked without limit.',
  );
  const wide = runtime.normalizeDebugConfiguration({
    type: 'node',
    name: 'n'.repeat(600),
    big: 'a'.repeat(40 * 1024),
    list: Array.from({ length: 400 }, () => 1),
    ['k'.repeat(300)]: 1,
    broken: Number.POSITIVE_INFINITY,
  });
  assert(
    wide.name.length === 300 &&
      wide.rest.big.length === 32 * 1024 &&
      wide.rest.list.length === 256 &&
      wide.rest['k'.repeat(300)] === undefined &&
      wide.rest.broken === 0,
    'DC-7: configuration values are clamped by length, breadth and key size, and a non-finite number becomes 0.',
  );
  assert(
    runtime.normalizeTriggerKind(2) === 'dynamic' &&
      runtime.normalizeTriggerKind('dynamic') === 'dynamic' &&
      runtime.normalizeTriggerKind(1) === 'initial' &&
      runtime.normalizeTriggerKind(undefined) === 'initial',
    'DC-8: `DebugConfigurationProviderTriggerKind` reads from upstream’s enum, defaulting to Initial.',
  );
  const exe = runtime.normalizeAdapterDescriptor({
    command: '/usr/bin/node',
    args: ['adapter.js', 7, null],
    options: { cwd: '/repo', env: { GOOD: '1', '2BAD': 'x', NUMERIC: 3 } },
  });
  assert(
    exe.kind === 'executable' &&
      exe.command === '/usr/bin/node' &&
      exe.args.length === 1 &&
      exe.cwd === '/repo' &&
      Object.keys(exe.env).length === 1,
    'DC-9: an executable descriptor keeps its command, its string arguments and a portable environment.',
  );
  assert(
    runtime.normalizeAdapterDescriptor({ args: ['x'] }) === null &&
      runtime.normalizeAdapterDescriptor({}) === null &&
      runtime.normalizeAdapterDescriptor('node') === null,
    'DC-10: a descriptor that names no adapter at all is refused — there is nothing to start.',
  );
  const server = runtime.normalizeAdapterDescriptor({ port: 5_678, host: 'evil.example.com' });
  assert(
    server.kind === 'server' &&
      server.port === 5_678 &&
      server.host === '127.0.0.1' &&
      server.command === null,
    'DC-11: a server descriptor is pinned to loopback — an extension cannot point the DAP transport at a remote host.',
  );
  assert(
    runtime.normalizeAdapterDescriptor({ kind: 'server', port: 0 }) === null &&
      runtime.normalizeAdapterDescriptor({ kind: 'server', port: 70_000 }) === null &&
      runtime.normalizeAdapterDescriptor({ kind: 'server', port: 1.5 }) === null &&
      runtime.normalizeAdapterDescriptor({ kind: 'server' }) === null,
    'DC-12: a server descriptor must name a real port.',
  );
  const pipe = runtime.normalizeAdapterDescriptor({ path: '/tmp/dbg.sock' });
  const named = runtime.normalizeAdapterDescriptor({ kind: 'namedPipe', pipeName: 'axiom-dbg' });
  assert(
    pipe.kind === 'namedPipe' &&
      pipe.pipe === '/tmp/dbg.sock' &&
      pipe.port === null &&
      named.pipe === 'axiom-dbg',
    'DC-13: a named pipe descriptor is recognised from `path` or `pipeName`.',
  );
  assert(
    runtime.normalizeAdapterDescriptor({ kind: 'namedPipe' }) === null,
    'DC-14: a named pipe descriptor with no pipe is refused.',
  );
  const inline = runtime.normalizeAdapterDescriptor({ implementation: { onDidSendMessage: 1 } });
  assert(
    inline.kind === 'inline' &&
      inline.command === null &&
      inline.port === null &&
      inline.pipe === null &&
      runtime.normalizeAdapterDescriptor({ kind: 'inline' }).kind === 'inline',
    'DC-15: an inline adapter carries no transport — the implementation stays in the worker and DAP is routed over the host protocol.',
  );
  const nul = String.fromCharCode(0);
  const dirty = runtime.normalizeAdapterDescriptor({
    command: `/usr/bin/node${nul}/evil`,
    args: [`a${nul}b`, ...Array.from({ length: 400 }, () => 'x')],
  });
  assert(
    dirty.command === '/usr/bin/node/evil' && dirty.args.length === 128 && dirty.args[0] === 'ab',
    'DC-16: NULs are stripped from an adapter command and its arguments, and argv is capped.',
  );
  const bigEnv = {};
  for (let index = 0; index < 200; index += 1) bigEnv[`V${index}`] = 'x';
  assert(
    Object.keys(
      runtime.normalizeAdapterDescriptor({ command: 'node', options: { env: bigEnv } }).env,
    ).length === 64,
    'DC-17: an adapter environment is capped.',
  );
}
/**
 * Who is asked to resolve a configuration, who builds the adapter, and the session tree that results.
 *
 * Two orderings carry the weight: providers must be asked in registration order, because each may
 * rewrite the configuration for the next, and `terminate` must return a subtree deepest-first, because
 * that is the order `onDidTerminateDebugSession` has to fire in for an extension tracking sessions in a
 * map to end up with an empty one.
 */
function validatePhase7DebugSessions() {
  const runtime = load(`${COMMON}vscodeDebugRuntime.ts`);
  const providers = new runtime.DebugConfigProviderRegistry();
  const forNode = providers.register('a.ext', 'node', 'initial');
  const wildcard = providers.register('b.ext', '*', 'initial');
  const dynamic = providers.register('c.ext', 'node', 'dynamic');
  const asked = providers.providersFor('node', 'initial');
  assert(
    asked.length === 2 && asked[0] === forNode && asked[1] === wildcard,
    'DS-1: providers are asked in registration order, since each may rewrite the configuration for the next.',
  );
  assert(
    providers.providersFor('python', 'initial').length === 1 &&
      providers.providersFor('python', 'initial')[0] === wildcard,
    'DS-2: a `*` registration answers for every debug type.',
  );
  assert(
    providers.providersFor('node', 'dynamic').length === 1 &&
      providers.providersFor('node', 'dynamic')[0] === dynamic,
    'DS-3: the trigger kind selects which providers answer — a dynamic provider is not asked at Initial.',
  );
  assert(
    providers.unregister(forNode.token) === forNode &&
      providers.unregister(forNode.token) === undefined &&
      providers.providersFor('node', 'initial').length === 1,
    'DS-4: disposing a configuration provider is idempotent and stops it being asked.',
  );
  for (let index = 0; index < runtime.MAX_CONFIG_PROVIDERS; index += 1) {
    providers.register('a.ext', `type${index}`, 'initial');
  }
  assert(
    (() => {
      try {
        providers.register('a.ext', 'overflow', 'initial');
        return false;
      } catch (error) {
        return /at most 16 debug configuration providers/.test(String(error));
      }
    })(),
    'DS-5: configuration providers are capped per extension.',
  );
  assert(
    providers.removeExtension('a.ext').length === runtime.MAX_CONFIG_PROVIDERS &&
      providers.countFor('a.ext') === 0 &&
      providers.size === 2,
    'DS-6: unloading an extension takes every configuration provider it owns and leaves the others.',
  );
  const factories = new runtime.DebugAdapterFactoryRegistry();
  const nodeToken = factories.register('a.ext', 'node');
  assert(
    nodeToken > 0 && factories.owner('node') === 'a.ext' && factories.owner('python') === null,
    'DS-7: a debug type has exactly one adapter factory, and its owner is recorded.',
  );
  assert(
    (() => {
      try {
        factories.register('evil.ext', 'node');
        return false;
      } catch (error) {
        return /already registered for 'node'/.test(String(error));
      }
    })(),
    'DS-8: a second extension cannot take over an existing debug type — that would be a way to have your program launched by someone else’s session.',
  );
  assert(
    factories.unregister(nodeToken) === 'node' &&
      factories.unregister(nodeToken) === null &&
      factories.owner('node') === null,
    'DS-9: unregistering a factory frees its type and is idempotent.',
  );
  assert(
    factories.register('evil.ext', 'node') > 0,
    'DS-10: the type is available again once the owning registration is gone.',
  );
  for (let index = 0; index < runtime.MAX_ADAPTER_FACTORIES; index += 1) {
    factories.register('a.ext', `type${index}`);
  }
  assert(
    (() => {
      try {
        factories.register('a.ext', 'overflow');
        return false;
      } catch (error) {
        return /at most 16 debug adapter factories/.test(String(error));
      }
    })(),
    'DS-11: adapter factories are capped per extension.',
  );
  assert(
    factories.removeExtension('a.ext').length === runtime.MAX_ADAPTER_FACTORIES &&
      factories.owner('type0') === null &&
      factories.size === 1,
    'DS-12: unloading an extension frees every debug type it owned, and only those.',
  );
  const sessions = new runtime.DebugSessionRegistry();
  const config = runtime.normalizeDebugConfiguration({ type: 'node', name: 'Run' });
  const root = sessions.create('a.ext', config, { workspaceFolder: '/repo', now: 10 });
  assert(
    root.id === 'axiom-dbg-1' &&
      root.state === 'starting' &&
      root.nextSeq === 1 &&
      root.parentId === null &&
      root.workspaceFolder === '/repo' &&
      sessions.active() === root,
    'DS-13: a new session is `starting`, becomes the active one, and carries the folder it was started in.',
  );
  assert(
    sessions.markRunning(root.id) === true &&
      root.state === 'running' &&
      sessions.markRunning(root.id) === false,
    'DS-14: a session becomes running once, so `onDidStartDebugSession` cannot be fired twice.',
  );
  assert(
    sessions.takeSeq(root.id) === 1 &&
      sessions.takeSeq(root.id) === 2 &&
      sessions.takeSeq('nope') === 0,
    'DS-15: request sequence numbers strictly increase per session, as DAP requires.',
  );
  const child = sessions.create('a.ext', config, { parentId: root.id });
  const grandchild = sessions.create('b.ext', config, { parentId: child.id });
  assert(
    child.parentId === root.id &&
      sessions.children(root.id).length === 1 &&
      sessions.children(child.id)[0] === grandchild,
    'DS-16: the `startDebugging` reverse request builds a session tree — js-debug spawns one child per worker.',
  );
  assert(
    (() => {
      try {
        sessions.create('a.ext', config, { parentId: 'axiom-dbg-999' });
        return false;
      } catch (error) {
        return /parent debug session no longer exists/.test(String(error));
      }
    })(),
    'DS-17: a child cannot be started under a parent that has already gone.',
  );
  assert(
    sessions.setActive('axiom-dbg-999') === false &&
      sessions.setActive(grandchild.id) === false &&
      sessions.setActive(root.id) === true,
    'DS-18: the active session can only be one that exists, and setting it to what it already is fires nothing.',
  );
  sessions.setActive(grandchild.id);
  const ended = sessions.terminate(child.id);
  assert(
    ended.length === 2 && ended[0] === grandchild && ended[1] === child,
    'DS-19: terminating a session returns its subtree deepest-first — the order `onDidTerminateDebugSession` must fire in.',
  );
  assert(
    sessions.get(grandchild.id) === undefined &&
      grandchild.state === 'terminated' &&
      sessions.size === 1,
    'DS-20: every session in the subtree is marked terminated and removed.',
  );
  assert(
    sessions.active() === root,
    'DS-21: the active session falls back to the surviving parent rather than to nothing.',
  );
  assert(
    sessions.terminate('axiom-dbg-999').length === 0,
    'DS-22: terminating an unknown session is a no-op, not an error — a stopDebugging race is normal.',
  );
  while (sessions.size < runtime.MAX_DEBUG_SESSIONS) sessions.create('a.ext', config);
  assert(
    (() => {
      try {
        sessions.create('a.ext', config);
        return false;
      } catch (error) {
        return /at most 8 debug sessions/.test(String(error));
      }
    })(),
    'DS-23: concurrent debug sessions are capped.',
  );
  sessions.clear();
  assert(
    sessions.size === 0 && sessions.active() === null,
    'DS-24: clearing the session registry forgets the active session too.',
  );
  const owned = new runtime.DebugSessionRegistry();
  const parent = owned.create('a.ext', config);
  const foreign = owned.create('b.ext', config, { parentId: parent.id });
  const removed = owned.removeExtension('a.ext');
  assert(
    removed.length === 2 && removed[0] === foreign && removed[1] === parent && owned.size === 0,
    'DS-25: unloading an extension terminates its sessions and their children, whoever started them — nothing is left attached to a dead adapter.',
  );
  const partial = new runtime.DebugSessionRegistry();
  const keptRoot = partial.create('a.ext', config);
  partial.create('b.ext', config, { parentId: keptRoot.id });
  assert(
    partial.removeExtension('b.ext').length === 1 &&
      partial.size === 1 &&
      partial.get(keptRoot.id) === keptRoot,
    'DS-26: unloading the extension that owns only a child leaves the parent session running.',
  );
  const console_ = new runtime.DebugConsoleBuffer();
  console_.append('partial');
  assert(
    console_.length === 1 && console_.snapshot()[0] === 'partial',
    'DS-27: `append` without a newline shows as an in-progress line — what an adapter streaming output depends on.',
  );
  console_.append(' line\n');
  assert(
    console_.snapshot().length === 1 && console_.snapshot()[0] === 'partial line',
    'DS-28: a later `append` continues the current line rather than starting a new one.',
  );
  console_.appendLine('second');
  assert(
    console_.snapshot().join('|') === 'partial line|second' && console_.length === 2,
    'DS-29: `appendLine` terminates the line it writes.',
  );
  const nul = String.fromCharCode(0);
  console_.appendLine(`a${nul}b`);
  console_.append('');
  console_.append(7);
  console_.appendLine(undefined);
  assert(
    console_.snapshot()[2] === 'ab' && console_.snapshot()[3] === '' && console_.length === 4,
    'DS-30: console text is NUL-stripped, and a non-string write adds nothing but an empty line.',
  );
  const ring = new runtime.DebugConsoleBuffer();
  for (let index = 0; index < runtime.MAX_CONSOLE_LINES + 500; index += 1) {
    ring.appendLine(`line ${index}`);
  }
  assert(
    ring.length === runtime.MAX_CONSOLE_LINES && ring.snapshot()[0] === 'line 500',
    'DS-31: the console is a ring — an extension can write to it without a user action, so the bound is "keep the recent output".',
  );
  const long = new runtime.DebugConsoleBuffer();
  long.append('a'.repeat(runtime.MAX_CONSOLE_TEXT));
  long.append('b');
  assert(
    long.length === 1 && long.snapshot()[0].length === runtime.MAX_CONSOLE_TEXT,
    'DS-32: a line that never ends is flushed at the text cap rather than accumulating for the session.',
  );
  ring.clear();
  assert(
    ring.length === 0 && ring.snapshot().length === 0,
    'DS-33: clearing the console drops the retained lines and any partial one.',
  );
}
// --------------------------------------------------------------------------
// PRD Phase 7 §4 — FileSystemWatcher
// --------------------------------------------------------------------------
/**
 * The watcher Phase 6 did not have.
 *
 * Phase 6 accepted `createFileSystemWatcher` and returned a watcher that never fired, which is why
 * Prettier, ESLint, GitLens and the Python extension were only partly compatible. Two properties make
 * the real one safe: a watcher is rooted inside the workspace at *registration* — refused, not silently
 * filtered — and however many watchers exist, the service holds one OS watch per distinct root.
 */
function validatePhase7FileWatching() {
  const watch = load(`${COMMON}vscodeFileWatch.ts`);
  assert(
    watch.isInsideRoot('/repo', '/repo/src/a.ts') === true &&
      watch.isInsideRoot('/repo', '/repo') === true &&
      watch.isInsideRoot('/repo/', '/repo/src/a.ts') === true,
    'W-1: a path inside a root, and the root itself, are inside it.',
  );
  assert(
    watch.isInsideRoot('/repo', '/repo-other/a.ts') === false &&
      watch.isInsideRoot('', '/repo/a.ts') === false,
    'W-2: a sibling directory sharing a prefix is not inside the root, and an empty root contains nothing.',
  );
  assert(
    watch.isInsideRoot('C:/Work', 'c:/work/src/a.ts') === true,
    'W-3: the boundary test folds case — both platforms AXIOM ships on have case-insensitive filesystems by default.',
  );
  assert(
    watch.rootContaining(['/a', '/b'], '/b/x.ts') === '/b' &&
      watch.rootContaining(['/a'], '/c/x.ts') === null &&
      watch.rootContaining(['C:\\repo\\'], 'C:/repo/x.ts') === 'C:/repo',
    'W-4: the containing root is found across a multi-root workspace and reported slash-normalised, with a trailing separator trimmed so one directory cannot read as two roots.',
  );
  const bare = watch.normalizeWatcherRequest('**/*.ts', undefined, undefined, undefined);
  assert(
    bare.base === null &&
      bare.pattern === '**/*.ts' &&
      bare.ignoreCreateEvents === false &&
      bare.ignoreChangeEvents === false &&
      bare.ignoreDeleteEvents === false,
    'W-5: a bare glob is matched against the workspace with every event kind wanted.',
  );
  assert(
    watch.normalizeWatcherRequest('**\\*.ts', 0, 0, 0).pattern === '**/*.ts' &&
      watch.normalizeWatcherRequest('./src/*.ts', 0, 0, 0).pattern === 'src/*.ts',
    'W-6: a pattern is slash-normalised and de-dotted, so a Windows-authored glob matches.',
  );
  assert(
    watch.normalizeWatcherRequest({ pattern: '*.ts', baseUri: { fsPath: '/repo/src' } }, 0, 0, 0)
      .base === '/repo/src' &&
      watch.normalizeWatcherRequest({ pattern: '*.ts', base: '/repo/lib' }, 0, 0, 0).base ===
        '/repo/lib' &&
      watch.normalizeWatcherRequest(
        { pattern: '*.ts', baseFolder: { uri: { fsPath: '/repo/app' } } },
        0,
        0,
        0,
      ).base === '/repo/app',
    'W-7: all three `RelativePattern` base shapes found in extensions in the wild are read.',
  );
  assert(
    watch.normalizeWatcherRequest({ base: '/repo' }, 0, 0, 0) === null &&
      watch.normalizeWatcherRequest('', 0, 0, 0) === null &&
      watch.normalizeWatcherRequest(7, 0, 0, 0) === null &&
      watch.normalizeWatcherRequest(null, 0, 0, 0) === null,
    'W-8: a request with no pattern is refused — a watcher that matches nothing would silently never fire.',
  );
  assert(
    watch.normalizeWatcherRequest('a'.repeat(4_000), 0, 0, 0).pattern.length ===
      watch.MAX_WATCH_PATTERN,
    'W-9: a pattern is clamped before it is compiled.',
  );
  const flags = watch.normalizeWatcherRequest('*.ts', 'yes', 1, true);
  assert(
    flags.ignoreCreateEvents === false &&
      flags.ignoreChangeEvents === false &&
      flags.ignoreDeleteEvents === true,
    'W-10: the ignore flags are strictly boolean — a truthy argument does not silence an event kind.',
  );
  const registry = new watch.WatcherRegistry();
  const roots = ['/repo', '/other'];
  const deep = registry.register('a.ext', watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots);
  assert(
    deep.base === '/repo' && deep.pattern === '**/*.ts' && deep.recursive === true,
    'W-11: a bare pattern is rooted at the first workspace root and watched recursively.',
  );
  const shallow = registry.register(
    'a.ext',
    watch.normalizeWatcherRequest(
      { pattern: '*.json', baseUri: { fsPath: '/repo/config' } },
      0,
      0,
      0,
    ),
    roots,
  );
  assert(
    shallow.base === '/repo/config' && shallow.recursive === false,
    'W-12: a pattern with no `**` and no separator is a single-directory watch, as `.env` and `tsconfig.json` need.',
  );
  assert(
    (() => {
      try {
        registry.register(
          'a.ext',
          watch.normalizeWatcherRequest({ pattern: '*.ts', base: '/etc' }, 0, 0, 0),
          roots,
        );
        return false;
      } catch (error) {
        return /rooted inside the workspace/.test(String(error));
      }
    })(),
    'W-13: a watcher based outside the workspace is refused at registration — the boundary is enforced once, not per event.',
  );
  assert(
    (() => {
      try {
        registry.register('a.ext', watch.normalizeWatcherRequest('*.ts', 0, 0, 0), []);
        return false;
      } catch (error) {
        return /No workspace is open to watch/.test(String(error));
      }
    })(),
    'W-14: with no workspace open there is nothing to watch, and the extension is told so.',
  );
  assert(
    watch.watcherMatches(deep, 'create', '/repo/src/a.ts') === true &&
      watch.watcherMatches(deep, 'change', '/repo/a.ts') === true &&
      watch.watcherMatches(deep, 'delete', '/repo/src/a.js') === false,
    'W-15: a recursive watcher matches its glob at any depth and nothing else.',
  );
  assert(
    watch.watcherMatches(deep, 'create', '/other/src/a.ts') === false,
    'W-16: an event outside the watcher’s base is not delivered even when the glob would match.',
  );
  assert(
    watch.watcherMatches(shallow, 'create', '/repo/config/a.json') === true &&
      watch.watcherMatches(shallow, 'create', '/repo/config/nested/a.json') === false,
    'W-17: a non-recursive watcher does not fire for a nested path.',
  );
  const silenced = registry.register(
    'a.ext',
    watch.normalizeWatcherRequest('**/*.ts', true, false, true),
    roots,
  );
  assert(
    watch.watcherMatches(silenced, 'create', '/repo/a.ts') === false &&
      watch.watcherMatches(silenced, 'change', '/repo/a.ts') === true &&
      watch.watcherMatches(silenced, 'delete', '/repo/a.ts') === false,
    'W-18: the ignore flags drop the kinds the extension asked not to hear about.',
  );
  assert(
    registry.roots().length === 2 &&
      registry.roots().includes('/repo') &&
      registry.roots().includes('/repo/config'),
    'W-19: three watchers over two directories need two OS watches — the point of the registry.',
  );
  const deliveries = registry.deliveriesFor({ kind: 'change', path: '/repo/src/a.ts' });
  assert(
    deliveries.length === 2 &&
      deliveries.every((delivery) => delivery.extensionId === 'a.ext') &&
      deliveries.some((delivery) => delivery.token === deep.token) &&
      deliveries.some((delivery) => delivery.token === silenced.token),
    'W-20: one raw event fans out to every watcher that asked for it, addressed by token.',
  );
  assert(
    registry.deliveriesFor({ kind: 'create', path: '/repo/src/a.ts' }).length === 1,
    'W-21: a watcher that silenced creates is not in the fan-out for a create.',
  );
  assert(
    registry.deliveriesFor({ kind: 'change', path: '/nowhere/a.ts' }).length === 0,
    'W-22: an event no watcher asked for is delivered to nobody rather than broadcast.',
  );
  assert(
    registry.unregister(shallow.token) === shallow &&
      registry.unregister(shallow.token) === undefined &&
      registry.get(shallow.token) === undefined &&
      registry.roots().length === 1,
    'W-23: disposing a watcher is idempotent and releases the OS watch its root no longer needs.',
  );
  while (registry.countFor('a.ext') < watch.MAX_WATCHERS_PER_EXTENSION) {
    registry.register('a.ext', watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots);
  }
  assert(
    (() => {
      try {
        registry.register('a.ext', watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots);
        return false;
      } catch (error) {
        return /at most 32 watchers/.test(String(error));
      }
    })(),
    'W-24: watchers are capped per extension.',
  );
  assert(
    registry.register('b.ext', watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots).token > 0,
    'W-25: one extension reaching its watcher cap does not stop another registering.',
  );
  let filler = 0;
  while (registry.size < watch.MAX_WATCHERS) {
    const owner = `filler${Math.floor(filler / watch.MAX_WATCHERS_PER_EXTENSION)}.ext`;
    registry.register(owner, watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots);
    filler += 1;
  }
  assert(
    (() => {
      try {
        registry.register('z.ext', watch.normalizeWatcherRequest('**/*.ts', 0, 0, 0), roots);
        return false;
      } catch (error) {
        return /at most 128 file system watchers/.test(String(error));
      }
    })(),
    'W-26: watchers are capped across every extension — an OS watch is a finite resource.',
  );
  assert(
    registry.removeExtension('a.ext').length === watch.MAX_WATCHERS_PER_EXTENSION &&
      registry.countFor('a.ext') === 0 &&
      registry.size === watch.MAX_WATCHERS - watch.MAX_WATCHERS_PER_EXTENSION,
    'W-27: unloading an extension releases every watcher it held and leaves the others watching.',
  );
  registry.clear();
  assert(
    registry.size === 0 && registry.roots().length === 0,
    'W-28: clearing the registry leaves no OS watch to hold — the workspace-change path.',
  );
  assert(
    watch.matchesWorkspacePattern('src/a.ts', '**/*.ts', null) === true &&
      watch.matchesWorkspacePattern('src\\a.ts', '**/*.ts', null) === true &&
      watch.matchesWorkspacePattern('src/a.js', '**/*.ts', null) === false,
    'W-29: `findFiles` matches the same globs the watcher does — an extension must see one file in both.',
  );
  assert(
    watch.matchesWorkspacePattern('node_modules/x/a.ts', '**/*.ts', '**/node_modules/**') ===
      false && watch.matchesWorkspacePattern('src/a.ts', '**/*.ts', '**/node_modules/**') === true,
    'W-30: an exclude pattern removes a match, as `findFiles` documents.',
  );
  assert(
    watch.matchesWorkspacePattern('src/a.ts', '**/*.ts', '') === true,
    'W-31: an empty exclude excludes nothing.',
  );
}
// --------------------------------------------------------------------------
// PRD Phase 7 §5 — Workspace runtime events
// --------------------------------------------------------------------------
/**
 * Coalescing, the bounded queue, and the order the workspace file events fire in.
 *
 * "Event ordering must match VS Code" only means something written down, so the plan is asserted rather
 * than left implicit in the order two services happen to be called. The coalescing rules matter just as
 * much: extensions are written against upstream's, and a single editor save produces several raw events
 * on both platforms.
 */
function validatePhase7FileEvents() {
  const watch = load(`${COMMON}vscodeFileWatch.ts`);
  const collapse = (...kinds) =>
    watch
      .coalesceFileEvents(kinds.map((kind) => ({ kind, path: '/repo/a.ts' })))
      .map((event) => event.kind)
      .join(',');
  assert(
    collapse('change', 'change', 'change') === 'change',
    'FE-1: repeated events of the same kind collapse to one — a save reports several.',
  );
  assert(
    collapse('create', 'change') === 'create',
    'FE-2: create then change stays a create; a linter treating change as “re-lint the open document” would look for one that was never opened.',
  );
  assert(
    collapse('create', 'delete') === '',
    'FE-3: create then delete cancels out — a temporary file never existed as far as a watcher is concerned.',
  );
  assert(
    collapse('delete', 'create') === 'change',
    'FE-4: delete then create is a change, which is what an atomic save looks like from outside.',
  );
  assert(
    collapse('change', 'delete') === 'delete' && collapse('delete', 'change') === 'change',
    'FE-5: otherwise the later kind is the truth.',
  );
  assert(
    collapse('create', 'delete', 'create') === 'create',
    'FE-6: a path that cancelled out starts again on a later event.',
  );
  const ordered = watch.coalesceFileEvents([
    { kind: 'change', path: '/repo/b.ts' },
    { kind: 'create', path: '/repo/a.ts' },
    { kind: 'change', path: '/repo/b.ts' },
  ]);
  assert(
    ordered.length === 2 && ordered[0].path === '/repo/b.ts' && ordered[1].path === '/repo/a.ts',
    'FE-7: a batch is delivered in the order the filesystem first reported each path.',
  );
  const merged = watch.coalesceFileEvents([
    { kind: 'create', path: '\\repo\\a.ts' },
    { kind: 'change', path: '/repo/a.ts' },
  ]);
  assert(
    merged.length === 1 && merged[0].path === '/repo/a.ts' && merged[0].kind === 'create',
    'FE-8: coalescing normalises separators first, so a Windows path and a POSIX one are the same file.',
  );
  const queue = new watch.FileEventQueue();
  assert(
    queue.push('change', '\\repo\\a.ts') === true && queue.size === 1 && queue.overflowed === false,
    'FE-9: a raw event is queued for the debounce window, slash-normalised.',
  );
  queue.push('change', '/repo/a.ts');
  const drained = queue.drain();
  assert(
    drained.events.length === 1 && drained.overflowed === false && queue.size === 0,
    'FE-10: draining coalesces the window and empties the queue.',
  );
  const flood = new watch.FileEventQueue();
  for (let index = 0; index < watch.MAX_PENDING_EVENTS; index += 1) {
    flood.push('change', `/repo/file${index}.ts`);
  }
  assert(
    flood.push('change', '/repo/one-too-many.ts') === false && flood.overflowed === true,
    'FE-11: a `git checkout` that outruns the window stops being collected and says so, rather than growing without limit.',
  );
  const overflowDrain = flood.drain();
  assert(
    overflowDrain.overflowed === true && flood.overflowed === false && flood.size === 0,
    'FE-12: the overflow flag is reported once and reset with the queue — the service reports the root as changed.',
  );
  const created = watch.planFileOperationEvents('create', [
    { oldPath: null, newPath: '/repo/new.ts' },
  ]);
  assert(
    created.length === 1 &&
      created[0].event === 'workspace.onDidCreateFiles' &&
      created[0].paths[0] === '/repo/new.ts',
    'FE-13: a create fires `onDidCreateFiles` with the new path, after the file exists on disk.',
  );
  assert(
    watch.planFileOperationEvents('copy', [{ oldPath: '/repo/a.ts', newPath: '/repo/b.ts' }])[0]
      .event === 'workspace.onDidCreateFiles',
    'FE-14: a copy is a create — upstream has no `onDidCopyFiles`.',
  );
  assert(
    watch.planFileOperationEvents('create', []).length === 0 &&
      watch.planFileOperationEvents('create', [{ oldPath: null, newPath: null }]).length === 0,
    'FE-15: an operation that touched nothing fires nothing.',
  );
  const deleted = watch.planFileOperationEvents('delete', [
    { oldPath: '/repo/gone.ts', newPath: null },
  ]);
  assert(
    deleted.length === 1 && deleted[0].event === 'workspace.onDidDeleteFiles',
    'FE-16: deleting a file nothing has open fires only the file event.',
  );
  const deletedOpen = watch.planFileOperationEvents(
    'delete',
    [{ oldPath: '/repo/gone.ts', newPath: null }],
    ['/repo/gone.ts'],
  );
  assert(
    deletedOpen.length === 2 &&
      deletedOpen[0].event === 'workspace.onDidDeleteFiles' &&
      deletedOpen[1].event === 'workspace.onDidCloseTextDocument',
    'FE-17: an open document closes *after* `onDidDeleteFiles`, so a handler reading the workspace state sees the delete first.',
  );
  const renamed = watch.planFileOperationEvents('rename', [
    { oldPath: '/repo/a.ts', newPath: '/repo/b.ts' },
  ]);
  assert(
    renamed.length === 1 &&
      renamed[0].event === 'workspace.onDidRenameFiles' &&
      renamed[0].paths[0] === '/repo/a.ts→/repo/b.ts',
    'FE-18: a rename reports the pair in one event, not a delete plus a create — how an extension moves per-file state across.',
  );
  const renamedOpen = watch.planFileOperationEvents(
    'rename',
    [{ oldPath: '/repo/a.ts', newPath: '/repo/b.ts' }],
    ['/REPO/A.TS'],
  );
  assert(
    renamedOpen.length === 3 &&
      renamedOpen[0].event === 'workspace.onDidRenameFiles' &&
      renamedOpen[1].event === 'workspace.onDidCloseTextDocument' &&
      renamedOpen[1].paths[0] === '/repo/a.ts' &&
      renamedOpen[2].event === 'workspace.onDidOpenTextDocument' &&
      renamedOpen[2].paths[0] === '/repo/b.ts',
    'FE-19: a moved document closes and reopens under the new path, and the open-document match folds case.',
  );
  assert(
    watch.planFileOperationEvents(
      'rename',
      [{ oldPath: '/repo/a.ts', newPath: '/repo/b.ts' }],
      ['/repo/other.ts'],
    ).length === 1,
    'FE-20: renaming a file nothing has open fires no document lifecycle events.',
  );
}
// --------------------------------------------------------------------------
// Phase 7 §6 — runtime wiring, and §9's named areas that live outside the pure
// modules: cancellation, lifecycle, disposal, crash recovery, listener cleanup.
// The three layers that carry them (the worker shim, the four Main runtimes and
// the host supervisor) cannot be exercised without an Electron process, so they
// are held to static assertions in the `validateWorkbenchSecurity` pattern —
// each one naming the line it protects, so deleting that line fails the suite.
// --------------------------------------------------------------------------
function validatePhase7WorkerWiring() {
  const source = phase6Read('src/main/extensionHostWorker.ts');
  const host = load(`${COMMON}vscodeHost.ts`);
  const cases = (names) => names.every((name) => source.includes(`case '${name}':`));

  assert(
    cases([
      'terminalOpened',
      'terminalClosed',
      'terminalState',
      'terminalActive',
      'terminalInput',
      'terminalDimensions',
      'terminalOpenPty',
      'terminalClosePty',
      'terminalProvideProfile',
    ]),
    'WW-1: the worker answers all nine terminal messages Main sends it (§1).',
  );
  assert(
    cases(['taskProvide', 'taskResolve', 'taskEvent', 'taskCustomStart', 'taskCustomCancel']),
    'WW-2: the worker answers all five task messages, including the two that drive a CustomExecution (§2).',
  );
  assert(
    cases([
      'debugResolveConfiguration',
      'debugCreateAdapter',
      'debugAdapterMessage',
      'debugAdapterStop',
      'debugSessionStarted',
      'debugSessionTerminated',
      'debugActiveSession',
      'debugCustomEvent',
    ]),
    'WW-3: the worker answers all eight debug messages, including inline-adapter traffic and its stop (§3).',
  );
  assert(
    cases(['watcherEvent', 'fileOperation']),
    'WW-4: the worker answers the watcher and workspace-file-operation messages (§4/§5).',
  );
  const guarded =
    source.match(/terminalsByHandle\s*\n?\s*\.get\(message\.handle\)\s*\n?\s*\?\./g) ?? [];
  assert(
    guarded.length >= 7 && !source.includes('terminalsByHandle.get(message.handle).'),
    'WW-5: every terminal message is delivered through an optional-chained handle lookup, so a message for a terminal the extension already disposed is dropped rather than thrown (§6 disposal).',
  );
  const deactivateAt = source.indexOf('async function deactivate()');
  const dropAdaptersAt = source.indexOf(
    'for (const sessionId of [...inlineDebugAdapters.keys()]) dropInlineAdapter(sessionId);',
    deactivateAt,
  );
  const deactivatedAt = source.indexOf("send({ t: 'deactivated' })", deactivateAt);
  assert(
    deactivateAt > 0 && dropAdaptersAt > deactivateAt && deactivatedAt > dropAdaptersAt,
    'WW-6: deactivate() disposes every inline debug adapter before it reports back, so the last chance to run the extension’s own dispose() is taken while the worker is still alive (§3/§6).',
  );
  const uncaughtAt = source.indexOf("process.on('uncaughtException'");
  const failedAt = source.indexOf("t: 'failed'", uncaughtAt);
  const exitAt = source.indexOf('process.exit(1)', uncaughtAt);
  assert(
    uncaughtAt > 0 && failedAt > uncaughtAt && exitAt > failedAt,
    'WW-7: an uncaught exception is reported to the supervisor before the process exits, so a crash is attributed to this extension rather than recorded as an anonymous exit code (§6 crash recovery).',
  );
  assert(
    !/(^|\n)\s*(?:import[^\n]*from '(?:electron|node:child_process)'|const [^\n]*= require\('electron'\))/.test(
      source,
    ),
    'WW-8: the worker imports neither Electron nor child_process — every Phase 7 effect is a request Main performs on its behalf (§7).',
  );
  assert(
    !/\beval\(/.test(source) && !source.includes('new Function('),
    'WW-9: the worker contains no eval() and no new Function() (§7).',
  );
  const phase7Kinds = host.HOST_REQUEST_KINDS.filter(
    (kind) =>
      /^(?:terminal|tasks|debug)\./.test(kind) ||
      [
        'workspace.createWatcher',
        'workspace.disposeWatcher',
        'workspace.copyFile',
        'workspace.renameFile',
      ].includes(kind),
  );
  assert(
    phase7Kinds.length === 31 && phase7Kinds.every((kind) => source.includes(`'${kind}'`)),
    'WW-10: all 31 Phase 7 request kinds in the host protocol are reached from the shim — none is declared and unused.',
  );
  const literals = [
    ...new Set(
      (source.match(/'(?:terminal|tasks|debug)\.[A-Za-z]+'/g) ?? []).map((x) => x.slice(1, -1)),
    ),
  ];
  assert(
    literals.length > 0 && literals.every((kind) => host.isHostRequestKind(kind)),
    'WW-11: every request kind the shim names is one the protocol table declares, so a typo cannot become a request Main silently ignores.',
  );
}

function validatePhase7MainWiring() {
  const services = {
    terminals: phase6Read('src/main/services/extensionTerminals.ts'),
    tasks: phase6Read('src/main/services/extensionTasks.ts'),
    debug: phase6Read('src/main/services/extensionDebug.ts'),
    fileEvents: phase6Read('src/main/services/extensionFileEvents.ts'),
  };
  const supervisor = phase6Read('src/main/services/marketplaceHost.ts');
  const shape = [
    ['terminals', 'Terminals'],
    ['tasks', 'Tasks'],
    ['debug', 'Debug'],
    ['fileEvents', 'FileEvents'],
  ];

  assert(
    shape.every(
      ([key, noun]) =>
        services[key].includes(`export function configureExtension${noun}(`) &&
        services[key].includes(`export async function handle${noun}Request(`) &&
        services[key].includes(`export function dispose${noun}ForExtension(`) &&
        services[key].includes(`export function resetExtension${noun}ForTesting(`),
    ),
    'MW-1: each of the four Phase 7 runtimes exposes the same four-part contract — configure, handle, dispose-for-extension, reset — so the supervisor drives them all the same way (§6).',
  );
  assert(
    shape.every(([key]) => /export function is[A-Za-z]+RequestKind\(/.test(services[key])),
    'MW-2: each runtime decides for itself which request kinds it owns, rather than the supervisor keeping a second list that can drift.',
  );
  const owners = Object.entries(services).map(([key, text]) => {
    const set = text.match(
      /_REQUEST_KINDS: ReadonlySet<string> = new Set<HostRequestKind>\(\[([^\]]*)\]/,
    );
    return [key, new Set((set?.[1] ?? '').match(/'[^']+'/g)?.map((x) => x.slice(1, -1)) ?? [])];
  });
  const host = load(`${COMMON}vscodeHost.ts`);
  const phase7Kinds = host.HOST_REQUEST_KINDS.filter(
    (kind) =>
      /^(?:terminal|tasks|debug)\./.test(kind) ||
      [
        'workspace.createWatcher',
        'workspace.disposeWatcher',
        'workspace.copyFile',
        'workspace.renameFile',
      ].includes(kind),
  );
  const claims = (kind) => owners.filter(([, set]) => set.has(kind)).map(([key]) => key);
  assert(
    phase7Kinds.every((kind) => claims(kind).length === 1),
    'MW-3: every Phase 7 request kind is claimed by exactly one runtime — no kind is unhandled and none is answered twice (§6 no dangling handlers).',
  );
  const routes = [
    'isTerminalsRequestKind(kind)',
    'isTasksRequestKind(kind)',
    'isDebugRequestKind(kind)',
    'isFileEventsRequestKind(kind)',
  ];
  const switchAt = supervisor.indexOf("case 'window.showMessage':");
  assert(
    routes.every((route) => {
      const at = supervisor.indexOf(route);
      return at > 0 && at < switchAt;
    }),
    'MW-4: the supervisor routes all four Phase 7 runtimes before its own switch, so adding a kind to a runtime needs no second edit here (§6).',
  );
  const teardownAt = supervisor.indexOf('function teardown(record: HostRecord)');
  const order = [
    'disposeTerminalsForExtension(record.extensionId)',
    'disposeTasksForExtension(record.extensionId)',
    'disposeDebugForExtension(record.extensionId)',
    'disposeFileEventsForExtension(record.extensionId)',
  ].map((call) => supervisor.indexOf(call, teardownAt));
  const killAt = supervisor.indexOf('child.kill()', teardownAt);
  assert(
    teardownAt > 0 &&
      order.every((at, index) => at > teardownAt && (index === 0 || at > order[index - 1])),
    'MW-5: teardown disposes panes and ptys, then task processes, then debug adapters, then OS watches — the order that leaves nothing running behind a host that is gone (§6 disposal).',
  );
  assert(
    killAt > order[order.length - 1],
    'MW-6: every Phase 7 resource is released before the child is killed, so a Pseudoterminal’s dispose and an inline adapter’s stop are still deliverable when they run.',
  );
  const pendingAt = supervisor.indexOf('record.pendingInvocations.clear()', teardownAt);
  assert(
    supervisor.indexOf("pending.reject(new Error('The extension host stopped.'))", teardownAt) >
      teardownAt &&
      pendingAt > teardownAt &&
      pendingAt < order[0],
    'MW-7: teardown rejects and clears every in-flight invocation before releasing the runtimes, so no Phase 7 request is left awaiting a process that has stopped (§6 cancellation).',
  );
  assert(
    supervisor.indexOf('clearTimeout(pending.timer)', teardownAt) > teardownAt &&
      supervisor.indexOf('if (record.readyTimer) clearTimeout(record.readyTimer)', teardownAt) >
        teardownAt,
    'MW-8: teardown clears the ready, restart and per-invocation timers, so a stopped host leaves no timer holding the event loop (§6 listener cleanup).',
  );
  assert(
    services.terminals.includes("bridge?.command({ op: 'dispose', handle: record.handle") &&
      services.terminals.includes('pendingSpawns.delete(record.handle)'),
    'MW-9: disposing an extension’s terminals closes each pane in the renderer and drops its pending spawn, so no pane outlives the host and no spawn reply lands on a handle that is gone (§1/§6).',
  );
  const removal = phase6Read('src/main/services/marketplaceExtensions.ts');
  assert(
    removal.includes("import { forgetTerminalEnvironment } from './extensionTerminals'") &&
      removal.includes('forgetTerminalEnvironment(normalized)'),
    'MW-10: uninstalling an extension forgets its environment variable collections, so a removed extension cannot keep prepending to PATH for every terminal opened afterwards (§1).',
  );
  assert(
    services.tasks.includes('const running = executions.forExtension(extensionId)') &&
      services.tasks.includes('for (const record of running) cancelExecution(record)'),
    'MW-11: disposing an extension’s tasks cancels every execution it still has running, so a task process is never orphaned by its provider unloading (§2/§6 cancellation).',
  );
  assert(
    services.debug.includes('configWorkerTokens.delete(token)') &&
      services.debug.includes('factoryWorkerTokens.delete(token)') &&
      services.debug.includes("endSession(record.id, 'The extension was stopped.')"),
    'MW-12: disposing an extension’s debug state drops both worker-token maps and ends every session it owned, so no token survives its owner and no adapter keeps a port (§3/§6).',
  );
  assert(
    services.fileEvents.includes('for (const spec of removed) workerTokens.delete(spec.token)') &&
      services.fileEvents.includes('syncWatches()'),
    'MW-13: releasing an extension’s watchers drops its tokens and re-syncs the OS watches, so a root nobody watches any more has its descriptor closed (§4/§6).',
  );
  assert(
    services.debug.includes('transport.stop()') &&
      services.debug.includes("rejectPending(sessionId, 'The debug runtime was reset.')") &&
      services.fileEvents.includes('closeHandle(root, handle)') &&
      services.fileEvents.includes('clearTimeout(flushTimer)'),
    'MW-14: a full reset stops live adapters, closes live watches and clears the debounce timer rather than abandoning them, so nothing survives a workspace change or a host restart (§6).',
  );
  assert(
    shape.every(
      ([key]) => !/\beval\(/.test(services[key]) && !services[key].includes('new Function('),
    ),
    'MW-15: none of the four Phase 7 runtimes contains eval() or new Function() (§7).',
  );
  assert(
    shape.every(([key]) => /MAX_[A-Z_]+/.test(services[key])),
    'MW-16: every runtime enforces the caps its pure module declares, rather than growing an unbounded registry (§8).',
  );
  const stateFields = (text, noun) => {
    const start = text.indexOf(`export function extension${noun}State(): {`);
    if (start < 0) return null;
    const end = text.indexOf('} {', start);
    return end > start ? text.slice(start, end) : null;
  };
  assert(
    shape.every(([key, noun]) => {
      const block = stateFields(services[key], noun);
      if (block === null) return false;
      const fields = block.match(/^\s+\w+: [a-z]+;$/gm) ?? [];
      return fields.length > 0 && fields.every((field) => /: (?:number|boolean);$/.test(field));
    }),
    'MW-17: every runtime’s introspection returns counters only — no path, command line or environment value reaches the diagnostics surface (§7).',
  );
}
function validatePhase7RendererWiring() {
  const bus = load('apps/desktop/src/renderer/src/state/extensionTerminalBus.ts');
  bus.resetExtensionTerminalWrites();

  assert(
    bus.deliverExtensionTerminalWrite(0, 'x') === false &&
      bus.deliverExtensionTerminalWrite(-1, 'x') === false &&
      bus.deliverExtensionTerminalWrite(1, '') === false,
    'RW-1: a write with no handle or no text is refused rather than buffered against a terminal that cannot exist.',
  );
  assert(
    bus.deliverExtensionTerminalWrite(1, 'npm ') && bus.deliverExtensionTerminalWrite(1, 'test\r'),
    'RW-2: text that arrives before a pane exists is held — an extension that calls createTerminal() and sendText() in one tick is ahead of React’s commit (§1).',
  );
  const seen = [];
  const off = bus.registerExtensionTerminalSink(1, (data) => seen.push(data));
  assert(
    seen.length === 1 && seen[0] === 'npm test\r' && bus.bufferedExtensionTerminalChars() === 0,
    'RW-3: registering the pane’s sink flushes everything held for it, in one write and in order.',
  );
  bus.deliverExtensionTerminalWrite(1, 'more');
  assert(
    seen.length === 2 && seen[1] === 'more',
    'RW-4: once a pane owns the handle, later writes reach it directly rather than accumulating.',
  );
  off();
  bus.deliverExtensionTerminalWrite(1, 'held again');
  const second = [];
  bus.registerExtensionTerminalSink(1, (data) => second.push(data));
  assert(
    seen.length === 2 && second.length === 1 && second[0] === 'held again',
    'RW-5: unregistering keeps the buffer, so a React strict-mode double mount re-registers without losing the extension’s first write (§6).',
  );
  bus.resetExtensionTerminalWrites();
  const long = 'x'.repeat(bus.MAX_BUFFERED_WRITE_CHARS);
  assert(
    bus.deliverExtensionTerminalWrite(2, long) &&
      bus.bufferedExtensionTerminalChars() === bus.MAX_BUFFERED_WRITE_CHARS &&
      bus.deliverExtensionTerminalWrite(2, 'overflow') === false,
    'RW-6: held text is capped per handle and further writes are refused rather than growing the buffer (§8).',
  );
  bus.resetExtensionTerminalWrites();
  for (let handle = 1; handle <= bus.MAX_BUFFERED_WRITE_HANDLES; handle += 1) {
    bus.deliverExtensionTerminalWrite(handle, 'a');
  }
  assert(
    bus.deliverExtensionTerminalWrite(bus.MAX_BUFFERED_WRITE_HANDLES + 1, 'a') === false &&
      bus.deliverExtensionTerminalWrite(1, 'b'),
    'RW-7: the number of handles holding text is bounded, while a handle already holding some may still append — a pane that never appears cannot grow the registry (§8).',
  );
  bus.dropExtensionTerminalWrites(1);
  assert(
    bus.bufferedExtensionTerminalChars() === bus.MAX_BUFFERED_WRITE_HANDLES - 1,
    'RW-8: dropping a terminal forgets its sink and its held text, so a disposed terminal keeps nothing alive (§6 disposal).',
  );
  bus.resetExtensionTerminalWrites();
  assert(
    bus.bufferedExtensionTerminalChars() === 0,
    'RW-9: a workspace change clears every sink and buffer.',
  );
  bus.suppressNextTerminalFocus('pane-1');
  bus.suppressNextTerminalFocus('');
  assert(
    bus.consumeSuppressedTerminalFocus('pane-1') === true &&
      bus.consumeSuppressedTerminalFocus('pane-1') === false &&
      bus.consumeSuppressedTerminalFocus('') === false,
    'RW-10: Terminal.show(preserveFocus) marks one pane once — the mark is consumed, so the next reveal focuses normally (§1).',
  );
  const calls = [];
  const offFirst = bus.setTerminalPanelController({
    reveal: (preserveFocus) => calls.push(`reveal:${preserveFocus}`),
    hide: () => calls.push('hide'),
  });
  bus.revealTerminalPanel(true);
  bus.revealTerminalPanel(false);
  bus.hideTerminalPanel();
  assert(
    calls.join('|') === 'reveal:true|reveal:false|hide',
    'RW-11: Terminal.show() and hide() reach the workbench chrome through the registered controller, carrying preserveFocus unchanged.',
  );
  const later = [];
  bus.setTerminalPanelController({
    reveal: () => later.push('reveal'),
    hide: () => later.push('hide'),
  });
  offFirst();
  bus.revealTerminalPanel(false);
  assert(
    later.length === 1 && calls.length === 3,
    'RW-12: a stale disposer cannot uninstall the controller that replaced it, so a remount does not leave the panel unreachable (§6 listener cleanup).',
  );
  bus.resetExtensionTerminalWrites();
  const state = phase6Read('src/renderer/src/state/terminals.tsx');
  const view = phase6Read('src/renderer/src/workbench/TerminalView.tsx');
  const app = phase6Read('src/renderer/src/App.tsx');
  const subscribeAt = state.indexOf('window.axiom.extensionRuntime.onTerminalCommand(');
  const pullAt = state.indexOf('.terminals()', subscribeAt);
  assert(
    subscribeAt > 0 && pullAt > subscribeAt,
    'RW-13: the provider subscribes before it pulls the existing terminals, so a command issued in the gap is not lost (§6).',
  );
  assert(
    /return \(\) => \{\s*cancelled = true;\s*off\(\);\s*\};/.test(state),
    'RW-14: the command subscription is torn down on unmount and a late reply is ignored, so no listener outlives the provider (§6 listener cleanup).',
  );
  assert(
    state.includes(".reportTerminal({ kind: 'closed', handle: info.handle })"),
    'RW-15: a terminal recorded by a previous renderer instance is reported closed rather than adopted — its pty died with that window, and onDidCloseTerminal is what an extension should see (§1).',
  );
  assert(
    view.includes('offSink = registerExtensionTerminalSink(') && view.includes('offSink?.()'),
    'RW-16: the pane claims its handle only once it can accept text and releases it on teardown, so sendText is never typed into a pane with no process behind it (§1/§6).',
  );
  assert(
    app.includes('setTerminalPanelController({') &&
      /useEffect\(\s*\(\) =>\s*setTerminalPanelController\(/.test(app),
    'RW-17: the workbench chrome installs the panel controller from an effect whose return value is the disposer, so it is removed when the chrome unmounts.',
  );
  const rendererFiles = [state, view, phase6Read('src/renderer/src/state/extensionTerminalBus.ts')];
  assert(
    rendererFiles.every(
      (text) =>
        !/\brequire\(/.test(text) &&
        !/from 'node:/.test(text) &&
        !/\bprocess\.env\b/.test(text) &&
        !/\b__dirname\b/.test(text) &&
        !/\beval\(/.test(text) &&
        !text.includes('new Function('),
    ),
    'RW-18: the renderer half of the terminal runtime reaches Node through nothing but window.axiom — no require, no node: import, no process.env, no eval (§7 no renderer Node.js access).',
  );
}
// --------------------------------------------------------------------------
// Phase 7 §8 — the hierarchy tree model (Type Hierarchy UI, call hierarchy callees)
//
// The panel is a provider round trip around a state machine, and the state machine is what
// decides whether the panel is correct: whether recursion terminates, whether an empty
// level reads as "nothing calls this" rather than as a failure, and whether a level
// fetched under one direction can still be showing when the user asks the other question.
// It is pure, so it is driven here directly with no provider in the loop.
// --------------------------------------------------------------------------
function validatePhase7HierarchyTree() {
  const ht = load(`${COMMON}hierarchyTree.ts`);
  const item = (name, uri, line, character = 0) => ({
    name,
    kind: 5,
    uri,
    range: { start: { line, character }, end: { line: line + 1, character: 0 } },
    selectionRange: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
  });
  const edge = (value, fromRanges = []) => ({ item: value, fromRanges });
  const names = (tree) => ht.visibleHierarchyRows(tree).map((node) => node.item.name);
  const rootOf = (tree) => tree.nodes.get(tree.roots[0]);

  assert(
    ht.hierarchyDirections('call').join(',') === 'incoming,outgoing' &&
      ht.hierarchyDirections('type').join(',') === 'supertypes,subtypes',
    'HT-1: both halves of both APIs must be offered — callers and calls, supertypes and subtypes — because a one-directional panel cannot express either provider.',
  );
  assert(
    ht.hierarchyFeature('call') === 'callHierarchy' &&
      ht.hierarchyFeature('type') === 'typeHierarchy' &&
      ht.hierarchyDirectionLabel('incoming') === 'Callers' &&
      ht.hierarchyDirectionLabel('outgoing') === 'Calls' &&
      ht.hierarchyDirectionLabel('supertypes') === 'Supertypes' &&
      ht.hierarchyDirectionLabel('subtypes') === 'Subtypes',
    'HT-2: each kind must route to the provider that answers it, and each direction must read as the question it asks.',
  );
  const roots = ht.createHierarchyTree('type', 'supertypes', [
    edge(item('Widget', 'file:///a.ts', 4)),
    edge(item('Panel', 'file:///b.ts', 9)),
  ]);
  assert(
    roots.roots.length === 2 &&
      new Set(roots.roots).size === 2 &&
      ht.visibleHierarchyRows(roots).every((node) => node.state === 'collapsed') &&
      ht.visibleHierarchyRows(roots).every((node) => node.children === null),
    'HT-3: a prepared hierarchy starts closed with distinct keys — nothing below the roots has been asked for yet, which is what makes the tree lazy.',
  );
  assert(
    names(roots).join(',') === 'Widget,Panel',
    'HT-4: roots must render in provider order; the provider ranked them.',
  );
  assert(
    ht.createHierarchyTree(
      'call',
      'incoming',
      new Array(ht.MAX_HIERARCHY_CHILDREN + 40)
        .fill(0)
        .map((_, i) => edge(item(`f${i}`, 'file:///a.ts', i))),
    ).roots.length === ht.MAX_HIERARCHY_CHILDREN,
    'HT-5: a provider that prepares thousands of roots must be capped, not rendered.',
  );
  const loading = ht.setHierarchyNodeLoading(roots, roots.roots[0]);
  assert(
    rootOf(loading).state === 'loading' && !ht.canExpandHierarchyNode(rootOf(loading)),
    'HT-6: a node being fetched cannot be expanded again, so a second click cannot double the provider round trip.',
  );
  const withKids = ht.setHierarchyNodeChildren(loading, roots.roots[0], [
    edge(item('Base', 'file:///c.ts', 1), [
      { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
    ]),
    edge(item('Mixin', 'file:///d.ts', 2)),
  ]);
  const kid = withKids.nodes.get(rootOf(withKids).children[0]);
  assert(
    rootOf(withKids).state === 'expanded' &&
      rootOf(withKids).children.length === 2 &&
      kid.depth === 1 &&
      kid.parent === roots.roots[0] &&
      kid.fromRanges.length === 1,
    'HT-7: a fetched level attaches under the node that asked for it, one level deeper, keeping the ranges that make the edge.',
  );
  assert(
    names(withKids).join(',') === 'Widget,Base,Mixin,Panel',
    'HT-8: rows are depth-first with parents before children, so an expanded branch reads as a tree rather than as two lists.',
  );
  const empty = ht.setHierarchyNodeChildren(withKids, rootOf(withKids).children[1], []);
  const leaf = empty.nodes.get(rootOf(withKids).children[1]);
  assert(
    leaf.state === 'leaf' &&
      leaf.children.length === 0 &&
      leaf.error === undefined &&
      !ht.canExpandHierarchyNode(leaf),
    'HT-9: an empty level is a leaf, not an error — "nothing extends this" is the answer for most types, and upstream shows it as a row that does not open.',
  );
  const many = ht.setHierarchyNodeChildren(
    roots,
    roots.roots[0],
    new Array(ht.MAX_HIERARCHY_CHILDREN + 5)
      .fill(0)
      .map((_, i) => edge(item(`c${i}`, 'file:///c.ts', i))),
  );
  assert(
    rootOf(many).children.length === ht.MAX_HIERARCHY_CHILDREN && rootOf(many).truncated === true,
    'HT-10: an oversized level is capped and the row says so, rather than the panel silently claiming the whole level was shown.',
  );
  const cycle = ht.setHierarchyNodeChildren(roots, roots.roots[0], [
    edge(item('Widget', 'FILE:///A.ts', 4)),
    edge(item('Other', 'file:///z.ts', 3)),
  ]);
  const repeated = cycle.nodes.get(rootOf(cycle).children[0]);
  assert(
    repeated.recursive === true &&
      repeated.state === 'leaf' &&
      !ht.canExpandHierarchyNode(repeated),
    'HT-11: a node that repeats one of its own ancestors renders as a cycle and refuses to expand — `class A extends B, class B extends A` is expressible by a provider, and unrolling it would never terminate.',
  );
  assert(
    cycle.nodes.get(rootOf(cycle).children[1]).recursive === false,
    'HT-12: only an ancestor makes a cycle; an unrelated sibling in the same level must still be explorable.',
  );
  assert(
    ht.hierarchyIdentity(item('Widget', 'FILE:///A.ts', 4)) ===
      ht.hierarchyIdentity(item('Widget', 'file:///a.ts', 4)),
    'HT-13: identity folds uri case, because the same file arrives with a different drive-letter case depending on which provider produced it.',
  );
  assert(
    ht.hierarchyIdentity(item('a', 'file:///a.ts', 4)) !==
      ht.hierarchyIdentity(item('b', 'file:///a.ts', 4)),
    'HT-14: two symbols a provider reports at the same position stay distinct, so a wrong position cannot collapse two rows into one.',
  );
  const twins = ht.setHierarchyNodeChildren(roots, roots.roots[0], [
    edge(item('Same', 'file:///s.ts', 7)),
    edge(item('Same', 'file:///s.ts', 7)),
  ]);
  const twinKeys = rootOf(twins).children;
  assert(
    twinKeys.length === 2 &&
      twinKeys[0] !== twinKeys[1] &&
      twins.nodes.get(twinKeys[0]).recursive === false &&
      twins.nodes.get(twinKeys[1]).recursive === false,
    'HT-15: identity is positional, not nominal — the same symbol reached down two paths is two rows that expand independently, because the user is exploring a path.',
  );
  const failed = ht.setHierarchyNodeError(loading, roots.roots[0], 'provider threw');
  assert(
    rootOf(failed).state === 'error' &&
      rootOf(failed).error === 'provider threw' &&
      rootOf(failed).children === null &&
      ht.canExpandHierarchyNode(rootOf(failed)),
    'HT-16: a level that could not be fetched keeps its message and stays openable, so a transient provider failure is retried by clicking rather than by rebuilding the tree.',
  );
  const recovered = ht.setHierarchyNodeChildren(failed, roots.roots[0], [
    edge(item('Base', 'file:///c.ts', 1)),
  ]);
  assert(
    !Object.prototype.hasOwnProperty.call(rootOf(recovered), 'error') &&
      rootOf(recovered).state === 'expanded',
    'HT-17: a retry that succeeds must drop the old message, not render it under a row that has since loaded.',
  );
  const closed = ht.collapseHierarchyNode(withKids, roots.roots[0]);
  assert(
    closed.nodes.get(roots.roots[0]).state === 'collapsed' &&
      closed.nodes.get(roots.roots[0]).children.length === 2 &&
      names(closed).join(',') === 'Widget,Panel',
    'HT-18: closing a row hides its children without discarding them, and the hidden rows leave the visible list.',
  );
  const reopened = ht.expandLoadedHierarchyNode(closed, roots.roots[0]);
  assert(
    reopened.nodes.get(roots.roots[0]).state === 'expanded' && names(reopened).length === 4,
    'HT-19: reopening a fetched row costs no provider call — the level is already in the model.',
  );
  assert(
    ht.expandLoadedHierarchyNode(roots, roots.roots[0]) === roots,
    'HT-20: a row whose level was never fetched cannot be reopened locally; it must go to the provider.',
  );
  let deep = ht.createHierarchyTree('call', 'incoming', [edge(item('f0', 'file:///d.ts', 0))]);
  let cursor = deep.roots[0];
  for (let i = 1; i <= ht.MAX_HIERARCHY_DEPTH; i += 1) {
    deep = ht.setHierarchyNodeChildren(deep, cursor, [edge(item(`f${i}`, 'file:///d.ts', i))]);
    cursor = deep.nodes.get(cursor).children[0];
  }
  const deepest = deep.nodes.get(cursor);
  assert(
    deepest.depth === ht.MAX_HIERARCHY_DEPTH &&
      deepest.state === 'leaf' &&
      !ht.canExpandHierarchyNode(deepest),
    'HT-21: the traversal stops at MAX_HIERARCHY_DEPTH even when no identity check caught a cycle, so a graph that repeats without repeating a position still terminates.',
  );
  assert(
    ht.hierarchyAncestors(deep, cursor).map((node) => node.item.name)[0] ===
      `f${ht.MAX_HIERARCHY_DEPTH - 1}`,
    'HT-22: ancestors are nearest-first, which is the order a breadcrumb of the path needs.',
  );
  const level = new Array(ht.MAX_HIERARCHY_CHILDREN)
    .fill(0)
    .map((_, i) => edge(item(`n${i}`, 'file:///n.ts', i)));
  let wide = ht.createHierarchyTree('call', 'incoming', level);
  for (const key of wide.roots) {
    if (wide.capped) break;
    wide = ht.setHierarchyNodeChildren(wide, key, level);
  }
  assert(
    wide.capped === true && wide.nodes.size <= ht.MAX_HIERARCHY_NODES,
    'HT-23: the tree refuses a level that would take it past MAX_HIERARCHY_NODES and reports being capped, so exploring a large graph cannot grow the renderer without bound.',
  );
  const switched = ht.switchHierarchyDirection(withKids, 'subtypes');
  assert(
    switched.direction === 'subtypes' &&
      switched.roots.join(',') === withKids.roots.join(',') &&
      switched.nodes.size === withKids.roots.length &&
      ht.visibleHierarchyRows(switched).every((node) => node.children === null),
    'HT-24: swapping direction discards everything fetched under the old one — a callers subtree left hanging under a "calls" toggle would be a lie about the code — while keeping the prepared roots.',
  );
  assert(
    ht.switchHierarchyDirection(withKids, withKids.direction) === withKids,
    'HT-25: re-selecting the current direction is a no-op, so the toggle does not throw away a tree the user just built.',
  );
  const view = phase6Read('src/renderer/src/workbench/HierarchyView.tsx');
  const bus = phase6Read('src/renderer/src/editor/hierarchyBus.ts');
  const pane = phase6Read('src/renderer/src/editor/EditorPane.tsx');
  const intel = phase6Read('src/renderer/src/workbench/ProjectIntelligenceView.tsx');
  assert(
    view.includes("from '../../../common/hierarchyTree'") &&
      !/function\s+visibleHierarchyRows/.test(view),
    'HT-26: the panel uses the validated state machine rather than a second copy of it, so what is asserted above is what ships.',
  );
  assert(
    /epochRef\.current \+= 1;/.test(view) &&
      (view.match(/if \(epochRef\.current !== epoch\) return;/g) ?? []).length === 2,
    'HT-27: both the success and the failure path of a level fetch check the epoch, so a level that answers a question the panel no longer asks is dropped instead of attached.',
  );
  assert(
    view.includes('callHierarchyIncoming(node.item)') &&
      view.includes('callHierarchyOutgoing(node.item)') &&
      view.includes('typeHierarchyRelated(node.item, direction)'),
    'HT-28: each direction is answered by the provider op that means it — callees are a real `provideCallHierarchyOutgoingCalls`, not the callers list reversed.',
  );
  assert(
    /event\.key === 'ArrowRight'/.test(view) &&
      /event\.key === 'ArrowLeft'/.test(view) &&
      /event\.key === 'Enter'/.test(view) &&
      /event\.key === ' '/.test(view) &&
      view.includes('aria-level={node.depth + 1}') &&
      view.includes("'aria-expanded': node.state === 'expanded'"),
    'HT-29: the tree is keyboard-operable and announces its levels — arrows open and close, Enter opens the symbol, and a row that cannot expand carries no aria-expanded (PRD accessibility).',
  );
  assert(
    view.includes('if (request === null || tree === null) return null;') &&
      view.includes('tree.capped ?'),
    'HT-30: the panel stays out of the workbench until an extension actually answered, and says so when the tree was capped.',
  );
  assert(
    intel.includes('<HierarchyView />') && intel.includes('<CallHierarchyView />'),
    "HT-31: the extension hierarchy is mounted alongside AXIOM's own call-hierarchy panel rather than replacing it — the existing language-server surface is untouched.",
  );
  assert(
    pane.includes("showHierarchy({ kind: 'type', symbol, roots })") &&
      pane.includes("showHierarchy({ kind: 'call', symbol, roots })") &&
      pane.includes("id: 'axiom.nav.typeHierarchy'"),
    'HT-32: both hierarchies are reachable from the editor, type hierarchy through its own navigation action.',
  );
  for (const [name, text] of [
    ['HierarchyView', view],
    ['hierarchyBus', bus],
  ]) {
    assert(
      !/\brequire\(/.test(text) &&
        !/from 'node:/.test(text) &&
        !/\bprocess\.env\b/.test(text) &&
        !/\beval\(/.test(text) &&
        !text.includes('new Function(') &&
        !text.includes('dangerouslySetInnerHTML'),
      `HT-33: ${name} reaches nothing but window.axiom — no require, no node: import, no eval, no raw HTML (§7 no renderer Node.js access).`,
    );
  }
}

// --------------------------------------------------------------------------
// Phase 7 §8 — inline values (Inline Values UI)
//
// A provider is called for a whole visible range, so one screenful can produce a hundred
// lookups and the same variable appears on many lines. What the module decides — which
// lookups are actually sent to the debugger, and what is drawn once they are answered — is
// the difference between inline values that keep up with stepping and inline values that
// make stepping feel broken. It is pure, so all of it is exercised here.
// --------------------------------------------------------------------------
function validatePhase7InlineValues() {
  const iv = load(`${COMMON}inlineValues.ts`);
  const at = (line, start = 0, end = 4) => ({
    start: { line, character: start },
    end: { line, character: end },
  });
  const text = (line, value) => ({ kind: 'text', range: at(line), text: value });
  const variable = (line, name, caseSensitiveLookup = true, start = 0, end = 4) => ({
    kind: 'variable',
    range: at(line, start, end),
    ...(name === null ? {} : { variableName: name }),
    caseSensitiveLookup,
  });
  const expression = (line, expr, start = 0, end = 4) => ({
    kind: 'expression',
    range: at(line, start, end),
    ...(expr === null ? {} : { expression: expr }),
  });
  const lines = ['total  ', '  count', 'items.length'];
  const lineTextAt = (line) => lines[line] ?? '';

  assert(
    iv.formatInlineValue('a\nb\tc') === 'a b c' && iv.formatInlineValue('  x   y  ') === 'x y',
    'IV-1: a value is flattened and its runs of whitespace collapsed — a newline inside a value would break the line it decorates.',
  );
  assert(
    iv.formatInlineValue('x'.repeat(200)).length === iv.MAX_INLINE_VALUE_TEXT &&
      iv.formatInlineValue('x'.repeat(200)).endsWith('…'),
    'IV-2: a long value is capped and marked as cut, so one enormous string cannot push the code off screen.',
  );
  assert(
    iv.sameInlineValuePath('C:\\src\\a.ts', 'c:/src/A.TS') === true &&
      iv.sameInlineValuePath('C:/src/a.ts', 'C:/src/b.ts') === false &&
      iv.sameInlineValuePath('', 'C:/src/a.ts') === false,
    'IV-3: the frame path and the editor path match across separator and case differences, so a stopped frame is decorated on Windows too — and an empty path matches nothing.',
  );
  assert(
    iv.inlineValueNameAt('items.length', at(0, 0, 5)) === 'items' &&
      iv.inlineValueNameAt('  count', at(0, 0, 7)) === 'count',
    'IV-4: a lookup that points at a range and names nothing reads the identifier written there, which is the documented one-argument form real providers use.',
  );
  assert(
    iv.inlineValueNameAt('abc', {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 2 },
    }) === null,
    'IV-5: a multi-line range is refused — the range is meant to cover one identifier.',
  );
  assert(
    iv.inlineValueNameAt('abc', at(0, 99, 200)) === null &&
      iv.inlineValueNameAt('   ', at(0, 0, 3)) === null,
    'IV-6: a range past the end of the line, or one covering only whitespace, yields no lookup instead of an empty label.',
  );
  const slots = iv.planInlineValues(
    [text(0, 'ready'), variable(1, 'count'), expression(2, 'items.length')],
    lineTextAt,
  );
  assert(
    slots.length === 3 &&
      slots[0].kind === 'text' &&
      slots[0].name === 'ready' &&
      slots[1].kind === 'variable' &&
      slots[1].name === 'count' &&
      slots[2].kind === 'expression' &&
      slots[2].name === 'items.length',
    "IV-7: the provider's three result kinds become three kinds of slot — a literal label, a scope lookup, and an expression to evaluate.",
  );
  assert(
    iv.planInlineValues([variable(0, 'explicit', true, 0, 5)], lineTextAt)[0].name === 'explicit',
    'IV-8: an explicit variableName wins over the text at the range; the provider knows which variable it meant.',
  );
  assert(
    iv.planInlineValues([variable(1, null, true, 2, 7)], lineTextAt)[0].name === 'count',
    'IV-9: a lookup with no name falls back to the identifier at its range, read from the line the caller supplied.',
  );
  assert(
    iv.planInlineValues([text(0, '   ')], lineTextAt).length === 0,
    'IV-10: a text result that is only whitespace is dropped rather than drawn as an empty chip.',
  );
  assert(
    iv.planInlineValues([variable(-1, 'x'), variable(1.5, 'y')], lineTextAt).length === 0,
    'IV-11: a negative or fractional line is refused, so a malformed provider result cannot decorate a line that does not exist.',
  );
  const crowded = iv.planInlineValues(
    new Array(20).fill(0).map((_, i) => variable(0, `v${i}`)),
    lineTextAt,
  );
  assert(
    crowded.length === iv.MAX_INLINE_VALUES_PER_LINE,
    'IV-12: one line keeps a readable number of values; beyond that the line is unreadable and the rest are dropped.',
  );
  const tall = iv.planInlineValues(
    new Array(iv.MAX_INLINE_VALUE_LINES + 50).fill(0).map((_, i) => variable(i, `v${i}`)),
    () => 'x',
  );
  assert(
    new Set(tall.map((slot) => slot.line)).size === iv.MAX_INLINE_VALUE_LINES,
    'IV-13: a provider that answers for a huge range decorates a bounded number of lines.',
  );
  assert(
    iv.inlineValueKey({ kind: 'variable', name: 'Count', caseSensitive: false }) ===
      iv.inlineValueKey({ kind: 'variable', name: 'count', caseSensitive: false }) &&
      iv.inlineValueKey({ kind: 'variable', name: 'Count', caseSensitive: true }) !==
        iv.inlineValueKey({ kind: 'variable', name: 'count', caseSensitive: true }),
    'IV-14: a case-insensitive lookup folds its name so two spellings are one request, while a case-sensitive one keeps them apart — the provider chose which language it is describing.',
  );
  assert(
    iv.inlineValueKey({ kind: 'expression', name: 'count', caseSensitive: true }) !==
      iv.inlineValueKey({ kind: 'variable', name: 'count', caseSensitive: true }),
    'IV-15: a scope lookup and an evaluated expression with the same text are different questions and must not share an answer.',
  );
  const requests = iv.inlineValueRequests([
    { line: 0, kind: 'text', name: 'ready', caseSensitive: true },
    { line: 1, kind: 'variable', name: 'count', caseSensitive: true },
    { line: 2, kind: 'variable', name: 'count', caseSensitive: true },
    { line: 3, kind: 'expression', name: 'a.b', caseSensitive: true },
  ]);
  assert(
    requests.length === 2 && requests[0].kind === 'variable' && requests[1].kind === 'expression',
    'IV-16: a loop counter on twenty lines is one lookup, not twenty, and a literal label asks the debugger nothing — this dedupe is what keeps a stepped line from costing a hundred evaluate requests.',
  );
  assert(
    iv.inlineValueRequests(
      new Array(400).fill(0).map((_, i) => ({
        line: i,
        kind: 'expression',
        name: `e${i}`,
        caseSensitive: true,
      })),
    ).length === iv.MAX_INLINE_VALUE_REQUESTS,
    'IV-17: the number of distinct lookups one refresh may send is capped, so a pathological provider cannot flood the adapter.',
  );
  const scopeVars = [
    { name: 'count', value: '3', type: 'number', variablesReference: 0 },
    { name: 'count', value: '99', type: 'number', variablesReference: 0 },
    { name: 'Total', value: '7', type: 'number', variablesReference: 0 },
  ];
  assert(
    iv.findInlineVariable(scopeVars, 'count', true) === '3',
    'IV-18: scopes arrive innermost first, so the first match wins — a local shadowing a global must read as the local, exactly as in the variables view.',
  );
  assert(
    iv.findInlineVariable(scopeVars, 'total', false) === '7' &&
      iv.findInlineVariable(scopeVars, 'total', true) === null,
    'IV-19: a case-insensitive lookup finds a differently-cased variable; a case-sensitive one does not invent a match.',
  );
  assert(
    iv.findInlineVariable(scopeVars, 'missing', true) === null,
    'IV-20: a variable that is not in scope resolves to nothing rather than to a value.',
  );
  const drawn = iv.composeInlineValueDecorations(
    [
      { line: 2, kind: 'variable', name: 'count', caseSensitive: true },
      { line: 2, kind: 'expression', name: 'a.b', caseSensitive: true },
      { line: 0, kind: 'text', name: 'ready', caseSensitive: true },
    ],
    new Map([
      ['variable:count', '3'],
      ['expression:a.b', '{ n: 1 }'],
    ]),
  );
  assert(
    drawn.length === 2 &&
      drawn[0].line === 2 &&
      drawn[0].label === 'count = 3, a.b = { n: 1 }' &&
      drawn[1].label === 'ready',
    'IV-21: one decoration per line, values in the order they are written in the source, a literal drawn as-is and a lookup drawn as `name = value`.',
  );
  assert(
    iv.composeInlineValueDecorations(
      [{ line: 1, kind: 'variable', name: 'gone', caseSensitive: true }],
      new Map(),
    ).length === 0,
    'IV-22: an unanswered lookup draws nothing — "not in scope on this line" and "holds the value undefined" are different facts, and only one of them is true.',
  );
  assert(
    iv.composeInlineValueDecorations(
      [
        { line: 1, kind: 'text', name: 'same', caseSensitive: true },
        { line: 1, kind: 'text', name: 'same', caseSensitive: true },
      ],
      new Map(),
    )[0].label === 'same',
    'IV-23: two provider results that produce the same label on one line are drawn once.',
  );
  const wide = iv.composeInlineValueDecorations(
    new Array(8).fill(0).map((_, i) => ({
      line: 4,
      kind: 'text',
      name: `label-${i}-${'y'.repeat(60)}`,
      caseSensitive: true,
    })),
    new Map(),
  );
  assert(
    wide[0].label.length === iv.MAX_INLINE_VALUE_LABEL && wide[0].label.endsWith('…'),
    "IV-24: a line's whole label is capped and marked as cut, so eight long values cannot run off into the next screen.",
  );
  assert(
    iv.composeInlineValueDecorations(
      new Array(iv.MAX_INLINE_VALUE_LINES + 20).fill(0).map((_, i) => ({
        line: i,
        kind: 'text',
        name: `v${i}`,
        caseSensitive: true,
      })),
      new Map(),
    ).length === iv.MAX_INLINE_VALUE_LINES,
    'IV-25: the number of decorated lines is capped on the way out as well as on the way in.',
  );
  // The bus is pure (its only import is a type), so the ownership contract is exercised, not grepped.
  const bus = load('apps/desktop/src/renderer/src/editor/inlineValuesBus.ts');
  const seen = [];
  assert(
    bus.inlineValueContext() === null,
    'IV-26: nothing is published until a session pauses, so a file opened outside debugging asks the provider nothing.',
  );
  const off = bus.subscribeInlineValues((value) => seen.push(value));
  assert(
    seen.length === 1 && seen[0] === null,
    'IV-27: a pane that mounts mid-session is handed the current context immediately rather than waiting for the next frame change.',
  );
  bus.setInlineValueContext({ frameId: 1, path: 'C:/a.ts', line: 12 });
  bus.setInlineValueContext({ frameId: 1, path: 'C:/a.ts', line: 12 });
  assert(
    seen.length === 2 && bus.inlineValueContext().frameId === 1,
    'IV-28: re-publishing the same frame notifies nobody — a DAP event storm must not cost one full refresh each.',
  );
  bus.setInlineValueContext({ frameId: 1, path: 'C:/a.ts', line: 13 });
  bus.setInlineValueContext(null);
  assert(
    seen.length === 4 && seen[3] === null && bus.inlineValueContext() === null,
    'IV-29: stepping to another line republishes, and a resumed program publishes null — which is what clears the decorations instead of leaving stale values on screen.',
  );
  off();
  bus.setInlineValueContext({ frameId: 2, path: 'C:/b.ts', line: 1 });
  assert(
    seen.length === 4,
    'IV-30: an unmounted pane stops being notified, so no listener outlives the editor it was drawing into.',
  );
  assert(
    bus.frameInlineValueContext(undefined) === null &&
      bus.frameInlineValueContext({ id: 3, name: 'f', path: null, line: 4, column: 1 }) === null &&
      bus.frameInlineValueContext({ id: 3, name: 'f', path: '', line: 4, column: 1 }) === null,
    'IV-31: a frame with no source file publishes nothing — there is no line in any editor to decorate.',
  );
  const mapped = bus.frameInlineValueContext({
    id: 9,
    name: 'main',
    path: 'C:/src/a.ts',
    line: 42,
    column: 3,
  });
  assert(
    mapped.frameId === 9 && mapped.path === 'C:/src/a.ts' && mapped.line === 42,
    'IV-32: the published context is the selected frame itself, so the values resolve in the frame the user is looking at rather than the topmost one.',
  );
  const pane = phase6Read('src/renderer/src/editor/EditorPane.tsx');
  const panel = phase6Read('src/renderer/src/workbench/DebugPanel.tsx');
  const css = phase6Read('src/renderer/src/styles/global.css');
  assert(
    pane.includes(
      "after: { content: `  ${decoration.label}`, inlineClassName: 'axiom-inline-value' }",
    ) && !/inlineValue[\s\S]{0,400}dangerouslySetInnerHTML/.test(pane),
    "IV-33: values are drawn as Monaco injected text, whose `content` is rendered as a text node — an extension's value string cannot introduce markup (§7 no unsafe HTML).",
  );
  assert(
    pane.includes('inlineValueEpochRef.current === epoch && editorRef.current === editor') &&
      (pane.match(/if \(!live\(\)\) return/g) ?? []).length >= 2,
    'IV-34: every await is gated on the refresh still being the current one for this editor, so a resumed program, a frame switch or a tab switch cannot let an in-flight answer paint.',
  );
  assert(
    pane.includes('!sameInlineValuePath(path, context.path)') &&
      /collection\.clear\(\);\s*\n\s*return;/.test(pane),
    "IV-35: a buffer that is not the stopped frame's file is cleared rather than decorated with another file's values.",
  );
  assert(
    pane.includes('editor.getVisibleRanges()') &&
      pane.includes('wireLineRange(model, stoppedLine, stoppedLine)'),
    'IV-36: the provider is asked for the visible range and told which line is stopped, which is what `InlineValuesProvider` is specified against and what keeps a 10,000-line file from costing 10,000 lookups.',
  );
  assert(
    pane.includes('if (inlineValueContext() === null) return;') &&
      pane.includes('window.setTimeout(refreshInlineValues, INLINE_VALUE_DEBOUNCE_MS)') &&
      /INLINE_VALUE_DEBOUNCE_MS = \d+/.test(pane),
    'IV-37: scrolling and typing refresh on a debounce, and cost nothing at all when no session is paused.',
  );
  assert(
    pane.includes("onExtensionProviderChanged('inlineValue', refreshInlineValues)") &&
      pane.includes('subscribeInlineValues(() => refreshInlineValues())'),
    'IV-38: a provider that fires `onDidChangeInlineValues` is re-consulted without the user moving, exactly as Monaco re-asks for lenses (§ provider refresh events).',
  );
  assert(
    pane.includes('inlineValueScrollSub.dispose()') &&
      pane.includes('inlineValueEditSub.dispose()') &&
      pane.includes('window.clearTimeout(inlineValueTimer)'),
    'IV-39: the watchers and the pending debounce are torn down with the pane, so a closed editor leaves no timer behind.',
  );
  assert(
    /if \(state !== 'stopped' \|\| selectedFrame === null\) \{\s*setInlineValueContext\(null\);/.test(
      panel,
    ) && panel.includes('setInlineValueContext(frameInlineValueContext('),
    'IV-40: only a paused session with a selected frame publishes a context; the Run and Debug view is the one place that knows both.',
  );
  assert(
    /setBreakpointSyncEnabled\(false\);\s*\n\s*setInlineValueContext\(null\);/.test(panel),
    'IV-41: the panel clears the context when it unmounts, alongside the other session state it owns.',
  );
  assert(
    css.includes('.axiom-inline-value'),
    'IV-42: the injected text has a class of its own, so values read as annotation rather than as code.',
  );
  assert(
    /if \(scope\.expensive \|\| scope\.variablesReference === 0\) continue;/.test(pane) &&
      /if \(requests\.some\(\(request\) => request\.kind === 'variable'\)\)/.test(pane),
    'IV-43: one scopes read answers every variable lookup on the screen, expensive scopes are skipped as the variables view leaves them collapsed, and a screenful of literals reads no scopes at all.',
  );
  assert(
    pane.includes('window.axiom.debug.evaluate(request.name, frameId)') &&
      !/queryInlineValues[\s\S]{0,600}\beval\(/.test(pane),
    "IV-44: only an `InlineValueEvaluatableExpression` reaches the adapter's `evaluate`, and nothing is evaluated in the renderer (§7 no eval()).",
  );
  assert(
    !/\brequire\(/.test(phase6Read('src/renderer/src/editor/inlineValuesBus.ts')) &&
      !/from 'node:/.test(phase6Read('src/renderer/src/editor/inlineValuesBus.ts')),
    'IV-45: the bus is renderer-pure — no require, no node: import (§7 no renderer Node.js access).',
  );
}

// --------------------------------------------------------------------------
// Phase 7 §8 — provider refresh events (onDidChangeCodeLenses / InlayHints / SemanticTokens)
//
// Firing is cheap for the extension and expensive for the editor: one `fire()` costs a
// function call and buys a full re-provide over every visible model. So the policy — which
// of a burst becomes a refresh, and when — is what decides whether a provider that fires in
// a loop holds the editor at 100%. Time is a parameter here, never a clock, so the whole
// policy is driven at chosen timestamps, and `no polling` holds by construction.
// --------------------------------------------------------------------------
function validatePhase7ProviderEvents() {
  const pe = load(`${COMMON}vscodeProviderEvents.ts`);
  const src = fs.readFileSync(path.join(root, COMMON, 'vscodeProviderEvents.ts'), 'utf8');

  assert(
    pe.providerChangeEventName('codeLens') === 'onDidChangeCodeLenses' &&
      pe.providerChangeEventName('inlayHint') === 'onDidChangeInlayHints' &&
      pe.providerChangeEventName('semanticTokens') === 'onDidChangeSemanticTokens' &&
      pe.providerChangeEventName('foldingRange') === 'onDidChangeFoldingRanges' &&
      pe.providerChangeEventName('inlineValue') === 'onDidChangeInlineValues',
    'PE-1: each feature subscribes to the member VS Code actually defines, spelled as upstream spells it — a provider declares `onDidChangeCodeLenses`, not a name AXIOM invented.',
  );
  assert(
    pe.providerChangeEventName('semanticTokensRange') === null &&
      pe.providerChangeEventName('hover') === null &&
      pe.providerChangeEventName('nonsense') === null,
    'PE-2: a feature with no change event in the VS Code API gets none here — advertising a refresh path that cannot arrive would be worse than having none.',
  );
  assert(
    pe.isChangeableFeature('codeLens') &&
      !pe.isChangeableFeature('definition') &&
      !pe.isChangeableFeature(7) &&
      !pe.isChangeableFeature(undefined),
    'PE-3: the feature guard rejects anything that is not one of the five, including a non-string.',
  );
  assert(
    !pe.MONACO_REFRESHED_FEATURES.includes('inlineValue') &&
      pe.MONACO_REFRESHED_FEATURES.every((feature) => pe.isChangeableFeature(feature)),
    "PE-4: inline values are absent from the Monaco-refreshed set because standalone Monaco has no inline-values provider — their refresh goes to AXIOM's own surface instead.",
  );
  assert(
    !/\bDate\.now\(\)/.test(src) && !/setInterval|setTimeout/.test(src),
    'PE-5: the module owns no clock — the caller passes `now` and asks for the one deadline it needs a timer for, which is what makes "no polling" structural rather than aspirational.',
  );
  const coalescer = new pe.ProviderChangeCoalescer();
  assert(
    coalescer.nextDueAt() === null && coalescer.size === 0 && coalescer.dropped === 0,
    'PE-6: with no provider firing there is nothing pending and no deadline, so the refresh pipeline at rest costs one empty map and no timer.',
  );
  assert(
    coalescer.record(1, 'codeLens', 1_000) === 'queued' &&
      coalescer.nextDueAt() === 1_000 + pe.PROVIDER_CHANGE_DEBOUNCE_MS,
    'PE-7: the first fire is queued one debounce ahead, so a provider that fires three times while computing wakes the editor once.',
  );
  assert(
    coalescer.record(1, 'codeLens', 1_010) === 'coalesced' && coalescer.size === 1,
    'PE-8: a second fire from the same provider is folded into the pending one rather than queued again.',
  );
  assert(
    coalescer.nextDueAt() === 1_000 + pe.PROVIDER_CHANGE_DEBOUNCE_MS,
    'PE-9: coalescing keeps the earliest deadline — a burst must not push back a refresh that was already due, or a provider firing steadily would never be delivered.',
  );
  coalescer.record(2, 'inlayHint', 1_020);
  assert(
    coalescer.size === 2,
    'PE-10: two providers that fire in the same millisecond are two refreshes — a code-lens refresh must not be swallowed because an unrelated inlay-hints provider fired first.',
  );
  const due = coalescer.drain(1_060);
  assert(
    due.length === 1 && due[0].handle === 1 && due[0].feature === 'codeLens',
    'PE-11: a drain takes only what is actually due, in the order it was first recorded.',
  );
  assert(
    coalescer.size === 1 && coalescer.nextDueAt() === 1_020 + pe.PROVIDER_CHANGE_DEBOUNCE_MS,
    'PE-12: what was drained is gone and the next deadline is the remaining one, which is what the single timer re-arms for.',
  );
  const hot = new pe.ProviderChangeCoalescer();
  let last = 'queued';
  for (let i = 0; i <= pe.MAX_CHANGES_PER_WINDOW; i += 1) {
    last = hot.record(5, 'semanticTokens', 2_000 + i);
    hot.drain(2_000 + i + pe.PROVIDER_CHANGE_DEBOUNCE_MS);
  }
  assert(
    last === 'deferred',
    'PE-13: a provider past its budget for the window is deferred rather than dropped — it still gets its refresh, it just waits for the window to close.',
  );
  assert(
    hot.nextDueAt() === 2_000 + pe.PROVIDER_CHANGE_WINDOW_MS,
    "PE-14: the deferred refresh lands at the end of that provider's own window, so a provider firing in a loop cannot hold the editor at 100%.",
  );
  assert(
    hot.record(5, 'semanticTokens', 2_000 + pe.PROVIDER_CHANGE_WINDOW_MS) === 'coalesced' &&
      new pe.ProviderChangeCoalescer().record(5, 'semanticTokens', 9_000) === 'queued',
    'PE-15: the rate window is a window, not a penalty box — once it has passed, the provider is back to being debounced normally.',
  );
  hot.forget(5);
  assert(
    hot.size === 0 && hot.nextDueAt() === null,
    'PE-16: a provider that unregistered has its pending refresh forgotten — its refresh means nothing once there is nothing to re-ask.',
  );
  const many = new pe.ProviderChangeCoalescer();
  many.record(11, 'codeLens', 100);
  many.record(12, 'codeLens', 100);
  many.record(13, 'inlayHint', 100);
  many.forgetMany([11, 12]);
  assert(
    many.size === 1 && many.drainAll().length === 1 && many.size === 0,
    'PE-17: an extension unloading forgets every handle it owned in one call, and a registry rebuild takes whatever is left regardless of deadline.',
  );
  const valve = new pe.ProviderChangeCoalescer();
  for (let handle = 1; handle <= pe.MAX_PENDING_PROVIDER_CHANGES; handle += 1) {
    valve.record(handle, 'codeLens', 500);
  }
  assert(
    valve.record(pe.MAX_PENDING_PROVIDER_CHANGES + 1, 'codeLens', 500) === 'dropped' &&
      valve.dropped === 1,
    'PE-18: the pending map is a valve with a counter, not an unbounded queue — anything it refuses is counted so the condition is reported rather than hidden.',
  );
  valve.clear();
  assert(
    valve.size === 0 && valve.dropped === 0 && valve.nextDueAt() === null,
    'PE-19: clearing resets the valve as well as the queue, so a fresh workspace does not start life already over budget.',
  );
  assert(
    pe.normalizeProviderChangeBatch(null) === null &&
      pe.normalizeProviderChangeBatch({ changes: [] }) === null &&
      pe.normalizeProviderChangeBatch({ revision: -1, changes: [] }) === null &&
      pe.normalizeProviderChangeBatch({ revision: 1, changes: 'all' }) === null,
    'PE-20: a malformed batch is rejected whole — the renderer turns these numbers into provider invocations, so it validates them even though Main sent them.',
  );
  const batch = pe.normalizeProviderChangeBatch({
    revision: 4.9,
    changes: [
      { handle: 3, feature: 'codeLens' },
      { handle: 3, feature: 'codeLens' },
      { handle: 0, feature: 'codeLens' },
      { handle: 4, feature: 'definition' },
      { handle: 5, feature: 'inlayHint' },
      'nope',
    ],
  });
  assert(
    batch.revision === 4 &&
      batch.changes.length === 2 &&
      batch.changes[0].handle === 3 &&
      batch.changes[1].handle === 5,
    'PE-21: one bad entry costs one refresh, not the batch — a duplicate, a zero handle, an unknown feature and a non-object are each dropped on their own.',
  );
  assert(
    pe
      .changedFeatures([
        { handle: 1, feature: 'codeLens' },
        { handle: 2, feature: 'codeLens' },
        { handle: 3, feature: 'inlineValue' },
      ])
      .join(',') === 'codeLens,inlineValue',
    'PE-22: a consumer that refreshes per feature is told each feature once, in the order the batch touched them.',
  );
  const worker = phase6Read('src/main/extensionHostWorker.ts');
  const service = phase6Read('src/main/services/extensionLanguages.ts');
  const providers = phase6Read('src/renderer/src/editor/extensionProviders.ts');
  assert(
    worker.includes('const changeEvent = providerChangeEventName(feature);') &&
      worker.includes('.bind(provider)'),
    "PE-23: the shim subscribes to the provider's own change event and binds it first — an extension is free to declare it as a prototype method, and an unbound call would throw on the extension's own `this`.",
  );
  assert(
    /if \(!workerProviders\.has\(handle\)\) return;/.test(worker) &&
      /unsubscribeChange\?\.\(\)/.test(worker),
    'PE-24: a disposed provider stops forwarding fires and its subscription is released, so a disposal does not leak a listener into the extension.',
  );
  assert(
    service.includes('if (!isChangeableFeature(link.feature)) return false;') &&
      service.includes('semanticTokens.invalidateProvider(link.global)') &&
      service.includes('forgetProviderResultIds(link.global)'),
    'PE-25: a semantic-tokens fire drops the baseline the next delta would have been computed against — answering with a delta against tokens the provider has just disowned would corrupt the colours, so the next answer is a full set.',
  );
  assert(
    service.includes('const dueAt = providerChanges.nextDueAt();') &&
      service.includes('providerChangeTimer.unref?.()') &&
      /if \(providerChanges\.size === 0 && providerChangeTimer !== null\)/.test(service),
    'PE-26: one timer for the whole process, armed only while something is pending, unref-ed so the refresh pipeline is never why the process stays alive, and cleared when the last pending change is forgotten.',
  );
  assert(
    service.includes('scheduleProviderChangeFlush();') &&
      /flushProviderChanges[\s\S]{0,400}scheduleProviderChangeFlush\(\);/.test(service),
    'PE-27: a flush re-arms for whatever a rate window held back, so a deferred refresh is delivered rather than stranded.',
  );
  assert(
    providers.includes('const batch = normalizeProviderChangeBatch(raw);') &&
      /emitter\.fire\(\);\s*\n\s*\} catch \{/.test(providers),
    "PE-28: the renderer validates the pushed batch and fires each provider's own change signal defensively — a listener Monaco has already torn down must not cost the rest of the batch its refresh.",
  );
  assert(
    providers.includes('if (batch.revision !== snapshotRevision) scheduleReload();'),
    'PE-29: a batch minted against a newer registry tells this window it is behind, so it catches up instead of dropping refreshes for providers it has not seen yet.',
  );
}

/**
 * Workspace-symbol identity (Phase 7 §8) — `resolveWorkspaceSymbol` and the mint plumbing under it.
 *
 * `resolveWorkspaceSymbol` is specified against the *same object* the provider returned, and a
 * structural copy over a wire is not that object: a provider that stashed a private field on its
 * symbol — which is how a real one carries the index entry it needs to compute the range — would be
 * handed a stranger. So the identity has to survive three process boundaries as a token, and these
 * assertions follow that token the whole way: minted in the worker from the entry the extension
 * returned, re-minted in Main so one extension cannot ask about another's objects, carried by the
 * renderer, and redeemed back to the original on the way in.
 */
function validatePhase7WorkspaceSymbols() {
  const wire = load(`${COMMON}vscodeLanguageWire.ts`);
  const worker = phase6Read('src/main/extensionHostWorker.ts');
  const service = phase6Read('src/main/services/extensionLanguages.ts');
  const providers = phase6Read('src/renderer/src/editor/extensionProviders.ts');
  const palette = phase6Read('src/renderer/src/workbench/PaletteHost.tsx');

  const loc = (line = 1) => ({
    uri: 'file:///w/a.ts',
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
  });
  /** A provider's own symbol object, with the private field a real one would resolve from. */
  const symbol = (name, line = 1) => ({ name, kind: 11, location: loc(line), _index: name });

  const minted = [];
  const context = {
    mint: (original) => {
      minted.push(original);
      return minted.length;
    },
  };

  const bare = wire.toWireWorkspaceSymbols([symbol('alpha')], {});
  assert(
    bare.length === 1 &&
      bare[0].name === 'alpha' &&
      !Object.prototype.hasOwnProperty.call(bare[0], 'id'),
    'WS-1: without a mint (Main re-normalising a result it received) symbols cross the wire with no id at all rather than a fabricated one — unresolvable is a degradation, an id that names nothing would be a bug.',
  );

  const first = symbol('alpha');
  const second = symbol('beta', 4);
  const two = wire.toWireWorkspaceSymbols([first, second], context);
  assert(
    two.length === 2 &&
      two[0].id === 1 &&
      two[1].id === 2 &&
      minted[0] === first &&
      minted[1] === second,
    "WS-2: each symbol's id is minted from the provider's own object, by reference — the token names the instance the extension returned, which is the whole reason `resolveWorkspaceSymbol` can be honoured at all.",
  );

  minted.length = 0;
  const third = symbol('gamma', 9);
  const mixed = wire.toWireWorkspaceSymbols(
    [{ name: 'no location' }, third, { location: loc(2) }, null, 'nonsense'],
    context,
  );
  assert(
    mixed.length === 1 && mixed[0].name === 'gamma' && minted[mixed[0].id - 1] === third,
    'WS-3: an entry that cannot be read is dropped without consuming a token, so the surviving symbols still name their own originals — an id shifted by one dropped entry would resolve the wrong symbol.',
  );

  minted.length = 0;
  const many = Array.from({ length: wire.MAX_RESULT_ITEMS + 40 }, (_, index) =>
    symbol(`s${index}`),
  );
  const capped = wire.toWireWorkspaceSymbols(many, context);
  assert(
    capped.length === wire.MAX_RESULT_ITEMS && minted.length === wire.MAX_RESULT_ITEMS,
    'WS-4: the result cap is applied before minting, so a provider answering with its whole index costs a bounded number of live objects rather than one per symbol it returned.',
  );

  minted.length = 0;
  const hierarchyItem = {
    name: 'Widget',
    kind: 4,
    uri: 'file:///w/widget.ts',
    range: { start: { line: 1, character: 0 }, end: { line: 9, character: 1 } },
    selectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 12 } },
    _handle: 'provider-private',
  };
  const wireItem = wire.toWireHierarchyItem(hierarchyItem, context);
  assert(
    wireItem !== undefined && wireItem.id === 1 && minted[0] === hierarchyItem,
    'WS-5: a hierarchy item mints too, because it is the argument to the next traversal call — `provideCallHierarchyIncomingCalls(item)` must receive the item its provider prepared, not a copy of its fields.',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(wire.toWireHierarchyItem(hierarchyItem, {}), 'id'),
    'WS-6: with no mint a hierarchy item is still a readable row, it simply cannot be expanded — the same honest degradation as an unresolvable symbol.',
  );

  minted.length = 0;
  const incoming = wire.toWireIncomingCall(
    { from: hierarchyItem, fromRanges: [loc(3).range] },
    context,
  );
  const outgoing = wire.toWireOutgoingCall({ to: hierarchyItem, fromRanges: [] }, context);
  assert(
    incoming !== undefined &&
      incoming.from.id === 1 &&
      incoming.fromRanges.length === 1 &&
      outgoing !== undefined &&
      outgoing.to.id === 2 &&
      minted[0] === hierarchyItem &&
      minted[1] === hierarchyItem,
    'WS-7: the item nested inside a call — `from` on an incoming call, `to` on an outgoing one — is what the user opens next, so it carries its own token rather than being a leaf of the answer.',
  );

  minted.length = 0;
  const provided = wire.normalizeProviderResult(
    'workspaceSymbol',
    'provide',
    [symbol('delta')],
    context,
  );
  const resolvedReply = wire.normalizeProviderResult(
    'workspaceSymbol',
    'resolve',
    symbol('delta', 7),
    context,
  );
  assert(
    Array.isArray(provided) && provided.length === 1 && provided[0].id === 1,
    'WS-8: minting happens on the one boundary every provider result crosses, so it cannot be forgotten at a call site — the dispatcher, not the caller, decides that a workspace symbol is resolvable.',
  );

  assert(
    resolvedReply !== null &&
      resolvedReply.name === 'delta' &&
      resolvedReply.location.range.start.line === 7 &&
      !Object.prototype.hasOwnProperty.call(resolvedReply, 'id') &&
      minted.length === 1,
    'WS-9: the resolve reply deliberately mints nothing — the renderer already holds the identity and re-attaches it, so picking the same symbol twice does not strand a second live reference to it in the worker.',
  );

  assert(
    /case 'workspaceSymbol':\s*\n\s*return \{ hasResolve: has\('resolveWorkspaceSymbol'\) \};/.test(
      worker,
    ),
    'WS-10: resolvability is advertised from the provider object itself, so a provider without the method is never asked — the capability is detected, not assumed.',
  );
  assert(
    /'workspaceSymbol:resolve': \(provider, payload, token\) =>\s*\n\s*call\(provider, 'resolveWorkspaceSymbol', \[mintedValue\(payload\), token\]\),/.test(
      worker,
    ),
    'WS-11: the resolve reaches the provider with the redeemed original and a cancellation token, in the order `resolveWorkspaceSymbol(symbol, token)` is specified in — and with the provider as `this`, because `call` invokes it as a method.',
  );
  assert(
    /function mintedValue\(payload: Record<string, unknown>\): unknown \{\s*\n\s*const id = payload\.id;\s*\n\s*return typeof id === 'number' \? mintedValues\.get\(id\) : undefined;/.test(
      worker,
    ),
    'WS-12: redemption is a map lookup on a number and nothing else — a payload carrying a string, an object or a crafted key cannot reach into the registry, and an unknown token reads `undefined` rather than throwing.',
  );
  assert(
    worker.includes('const MAX_MINTED_VALUES = 20_000;') &&
      /while \(mintedValues\.size > MAX_MINTED_VALUES\) \{[\s\S]{0,220}mintedValues\.delete\(oldest\.value\);/.test(
        worker,
      ),
    'WS-13: the registry is bounded and evicts oldest-first, so a user who reopens Quick Open all afternoon cannot grow the host without limit; a token is redeemed within a keystroke or two of being minted, or never.',
  );

  assert(
    /if \(key === 'id' && typeof record\.id === 'number' && Number\.isInteger\(record\.id\)\) \{\s*\n\s*record\.id = mintMainToken\(link, record\.id\);/.test(
      service,
    ) &&
      service.includes('function mintMainToken(link: ProviderLink, workerToken: number): number'),
    "WS-14: every worker token is re-minted under a Main identity before the renderer sees it, which is what stops one extension from asking about another's objects — a worker-local integer means nothing outside the worker that issued it.",
  );
  assert(
    service.includes('const MAX_REWRITE_DEPTH = 6;') &&
      service.includes('depth > MAX_REWRITE_DEPTH') &&
      service.includes('const MAX_MAIN_TOKENS = 50_000;'),
    'WS-15: the rewrite is depth-bounded and the token map is capped — the value being walked arrived from another process, so a cyclic or absurdly nested object must cost a bounded walk rather than hanging Main.',
  );
  assert(
    /TOKEN_ROUTED_OPS: ReadonlySet<ProviderOp> = new Set<ProviderOp>\(\[\s*\n\s*'resolve',\s*\n\s*'incoming',\s*\n\s*'outgoing',\s*\n\s*'supertypes',\s*\n\s*'subtypes',/.test(
      service,
    ),
    'WS-16: a resolve and the four traversals route by token, not by selector — the merged list the renderer holds has no provider identity left in it, so re-scoring could hand a token to an extension that never minted it.',
  );
  assert(
    service.includes(
      "if (!ref) return { ok: false, error: 'That result is no longer available.' };",
    ) &&
      service.includes(
        "if (ref.link.feature !== feature) return { ok: false, error: 'That result is not a ' + feature };",
      ) &&
      service.includes('payload.id = ref.workerToken;'),
    'WS-17: an evicted token, and a token redeemed against the wrong feature, both fail the request outright; the id the worker receives is rewritten back to its own, so a renderer-supplied number is never redeemed anywhere but the map that issued it.',
  );
  assert(
    service.includes('function forgetTokensFor(globalHandle: number): void') &&
      service.includes('function forgetTokensForExtension(extensionId: string): void') &&
      service.includes('forgetTokensFor(link.global);') &&
      service.includes('forgetTokensForExtension(extensionId);'),
    'WS-18: disposing a provider and losing a host both drop the tokens they minted — and both are actually called, so a symbol from an uninstalled extension cannot be resolved by whatever later takes its numbers.',
  );

  assert(
    providers.includes('if (symbol.id === undefined) return symbol;'),
    'WS-19: a symbol with no id short-circuits in the renderer — no IPC is spent asking Main to resolve something no provider offered to resolve.',
  );
  assert(
    providers.includes('return resolved === null ? symbol : { ...resolved, id: symbol.id };'),
    'WS-20: a provider without the method, and one that answers nothing, both leave the item exactly as it was — which is what upstream shows for an unresolvable symbol, rather than an empty row or a thrown error.',
  );
  assert(
    /resolveWorkspaceSymbol\([\s\S]{0,200}askAny<LspSymbolInformation>\(\s*\n\s*'workspaceSymbol',\s*\n\s*'resolve',\s*\n\s*null,\s*\n\s*\{ id: symbol\.id \},\s*\n\s*token,/.test(
      providers,
    ),
    'WS-21: the resolve carries the token and no handle, because the token is the routing — passing a handle as well would invite Main to score selectors for a call that already names its provider exactly.',
  );
  assert(
    /export async function resolveWorkspaceSymbol\(\s*\n\s*symbol: WireWorkspaceSymbol,\s*\n\s*token\?: monaco\.CancellationToken,/.test(
      providers,
    ),
    'WS-22: the resolve accepts a cancellation token like every other provider call, so a user who dismisses Quick Open mid-resolve stops the provider working on a symbol nobody will open.',
  );
  assert(
    palette.includes('const resolved = await resolveWorkspaceSymbol(symbol);') &&
      /resolved\.location\.range\.start\.line \+ 1/.test(palette) &&
      /resolved\.location\.range\.start\.character \+ 1/.test(palette),
    'WS-23: the position opened comes from the resolved symbol, which is the point of the API — a provider that answered the query from a cheap index computes the real range only for the one symbol about to be opened.',
  );
  assert(
    /onAccept=\{\(item\) => \{[\s\S]{0,300}void openWorkspaceSymbol\(symbol\);/.test(palette) &&
      !/symbols\.forEach[\s\S]{0,900}resolveWorkspaceSymbol\(/.test(palette),
    'WS-24: only the picked symbol is resolved — resolving the list would defeat the API and cost one provider round trip per keystroke per result.',
  );
  assert(
    palette.includes('const symbolTargets = useRef(new Map<string, WireWorkspaceSymbol>());') &&
      /const symbol = symbolTargets\.current\.get\(item\.id\);\s*\n\s*close\(\);\s*\n\s*if \(symbol === undefined\) return;/.test(
        palette,
      ),
    'WS-25: the picked row is mapped back to the wire symbol it was built from, so the id travels with the pick instead of being reconstructed from the label — two symbols with the same name in different files resolve to different objects.',
  );

  assert(
    !/\beval\(|new Function\(|require\(|from 'node:/.test(palette) &&
      !/\beval\(|new Function\(|require\(|from 'node:/.test(providers),
    'WS-26: neither the Quick Open surface nor the provider bridge reaches Node, Electron or a dynamic evaluator — a workspace symbol is data from an extension, and it is read as data.',
  );
  assert(
    /path = monaco\.Uri\.parse\(symbol\.location\.uri\)\.fsPath;\s*\n\s*\} catch \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(path\.length === 0\) return;/.test(
      palette,
    ),
    'WS-27: a symbol whose uri does not resolve to a file is dropped from the list rather than shown as a row that cannot open — the provider is not trusted to have returned an openable location.',
  );
  assert(
    /const source = new monaco\.CancellationTokenSource\(\);\s*\n\s*const timer = setTimeout\(/.test(
      palette,
    ) &&
      /clearTimeout\(timer\);\s*\n\s*source\.cancel\(\);\s*\n\s*source\.dispose\(\);/.test(
        palette,
      ) &&
      palette.includes('if (source.token.isCancellationRequested) return;'),
    'WS-28: each keystroke supersedes the one before it — the pending query is cleared, the in-flight one cancelled, and a late reply that beat the cancel is discarded rather than shown against newer text.',
  );
  assert(
    /askAny<WireWorkspaceSymbol\[\]>\(\s*\n\s*'workspaceSymbol',\s*\n\s*'provide',\s*\n\s*null,\s*\n\s*\{ query \},\s*\n\s*token,\s*\n\s*\);\s*\n\s*return symbols \?\? \[\];/.test(
      providers,
    ),
    'WS-29: the query fans out with no handle so every matching provider answers and Main merges them, and a fan-out that produced nothing reads as an empty list rather than null.',
  );
  const compatTable = load(`${COMMON}vscodeCompat.ts`);
  assert(
    compatTable.API_SUPPORT['languages.registerWorkspaceSymbolProvider'] === 'supported' &&
      worker.includes('registerWorkspaceSymbolProvider') &&
      providers.includes('export async function queryWorkspaceSymbols(') &&
      providers.includes('export async function resolveWorkspaceSymbol('),
    "WS-30: the compat table's claim is backed on one side by a shim registration and on the other by both halves the API is specified as — the query and the resolve — which is what moves this entry off `partial` honestly.",
  );
  assert(
    !/descriptor\.hasResolve[\s\S]{0,400}workspaceSymbol/.test(providers) &&
      service.includes('if (metadata.hasResolve === true) descriptor.hasResolve = true;'),
    'WS-31: the window does not gate the resolve on a capability flag; a workspace symbol has no Monaco registration to carry a descriptor, so `hasResolve` stays a Main-side fact and an unresolvable symbol costs one round trip and comes back unchanged.',
  );
}

const SUITES = [
  ['glob semantics (Ch. 26)', validateGlob],
  ['context key expressions (Ch. 25)', validateContextKeys],
  ['keybinding policy (Ch. 25)', validateKeybindings],
  ['document selectors (Ch. 26)', validateDocumentSelector],
  ['snippet engine (Ch. 29)', validateSnippets],
  ['lazy activation (Ch. 41)', validateActivationIndex],
  ['dependency resolution (Ch. 42)', validateDependencies],
  ['version compatibility (Ch. 43)', validateVersionSelect],
  ['authentication and secrets (Phase 3)', validateExtensionAuth],
  ['webview identity and URLs (Phase 4)', validateWebviewIdentity],
  ['webview resource containment (Phase 4)', validateWebviewContainment],
  ['webview CSP and isolation (Phase 4)', validateWebviewPolicy],
  ['webview HTML rewriting (Phase 4)', validateWebviewHtml],
  ['webview messaging (Phase 4)', validateWebviewMessaging],
  ['webview options and state (Phase 4)', validateWebviewOptions],
  ['webview host requests (Phase 4)', validateWebviewRequests],
  ['view containers and registry (Phase 5)', validateViewRegistry],
  ['view welcome content (Phase 5)', validateViewWelcome],
  ['workbench state persistence (Phase 5)', validateViewPersistence],
  ['tree item normalisation (Phase 5)', validateTreeItems],
  ['tree model and lazy loading (Phase 5)', validateTreeModel],
  ['tree virtualisation and keyboard (Phase 5)', validateTreeRendering],
  ['menu registry and resolution (Phase 5)', validateMenus],
  ['context key store (Phase 5)', validateContextKeyStore],
  ['workbench security posture (Phase 5)', validateWorkbenchSecurity],
  ['API compatibility verdict (Phase 5)', validateCompatClassifier],
  ['diagnostics normalisation (Phase 6)', validatePhase6Diagnostics],
  ['completion items and lists (Phase 6)', validatePhase6Completion],
  ['hover and markdown safety (Phase 6)', validatePhase6Hover],
  ['signature help (Phase 6)', validatePhase6SignatureHelp],
  ['navigation and symbols (Phase 6)', validatePhase6Navigation],
  ['rename and prepare (Phase 6)', validatePhase6Rename],
  ['formatting (Phase 6)', validatePhase6Formatting],
  ['semantic tokens (Phase 6)', validatePhase6SemanticTokens],
  ['language registration (Phase 6)', validatePhase6LanguageRegistration],
  ['code actions (Phase 6)', validatePhase6CodeActions],
  ['code lens and decorations (Phase 6)', validatePhase6CodeLensAndDecorations],
  ['document synchronisation (Phase 6)', validatePhase6DocumentSync],
  ['workspace edits (Phase 6)', validatePhase6WorkspaceEdits],
  ['provider ordering and registry (Phase 6)', validatePhase6ProviderOrdering],
  ['cancellation propagation (Phase 6)', validatePhase6Cancellation],
  ['Monaco bridge surface (Phase 6)', validatePhase6MonacoBridge],
  ['terminal options (Phase 7 §1)', validatePhase7TerminalOptions],
  ['terminal registry and lifecycle (Phase 7 §1)', validatePhase7TerminalRegistry],
  ['terminal environment collections (Phase 7 §1)', validatePhase7TerminalEnvironment],
  ['terminal profiles (Phase 7 §1)', validatePhase7TerminalProfiles],
  ['task normalisation (Phase 7 §2)', validatePhase7TaskNormalisation],
  ['task rendering (Phase 7 §2)', validatePhase7TaskRendering],
  ['task lifecycle and registries (Phase 7 §2)', validatePhase7TaskLifecycle],
  ['DAP transport (Phase 7 §3)', validatePhase7DapTransport],
  ['debug configurations and descriptors (Phase 7 §3)', validatePhase7DebugConfiguration],
  ['debug sessions and console (Phase 7 §3)', validatePhase7DebugSessions],
  ['file system watching (Phase 7 §4)', validatePhase7FileWatching],
  ['workspace file events (Phase 7 §5)', validatePhase7FileEvents],
  ['extension host worker wiring (Phase 7 §6)', validatePhase7WorkerWiring],
  ['main runtime wiring and teardown (Phase 7 §6)', validatePhase7MainWiring],
  ['renderer terminal delivery (Phase 7 §1/§6)', validatePhase7RendererWiring],
  ['hierarchy tree model (Phase 7 §8)', validatePhase7HierarchyTree],
  ['inline values (Phase 7 §8)', validatePhase7InlineValues],
  ['provider refresh events (Phase 7 §8)', validatePhase7ProviderEvents],
  ['workspace symbol identity (Phase 7 §8)', validatePhase7WorkspaceSymbols],
];

function main() {
  let failed = 0;
  for (const [label, suite] of SUITES) {
    try {
      suite();
      process.stdout.write(`  ok   ${label}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`  FAIL ${label}\n       ${error.message}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed} extension-platform suite(s) failed.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nAll ${SUITES.length} extension-platform suites passed.\n`);
}

main();
