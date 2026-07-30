'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const yaml = require('js-yaml');
const { deepStrictEqual } = require('node:assert/strict');

const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const mustThrow = (action, message) => {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  assert(threw, message);
};
const mustReject = async (action, message) => {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
};

function transpile(relative) {
  const filename = path.join(root, relative);
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
}

function loadTypeScript(relative, mocks = {}) {
  const filename = path.join(root, relative);
  const output = transpile(relative);
  const module = { exports: {} };
  const localRequire = (specifier) =>
    Object.prototype.hasOwnProperty.call(mocks, specifier) ? mocks[specifier] : require(specifier);
  new Function('module', 'exports', 'require', '__dirname', '__filename', output)(
    module,
    module.exports,
    localRequire,
    path.dirname(filename),
    filename,
  );
  return module.exports;
}

function sourceFile(relative) {
  const filename = path.join(root, relative);
  return ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function property(object, name) {
  return object.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      candidate.name.getText().replace(/^['"]|['"]$/g, '') === name,
  );
}

function booleanProperty(object, name, expected) {
  const found = property(object, name);
  return (
    found &&
    ((expected && found.initializer.kind === ts.SyntaxKind.TrueKeyword) ||
      (!expected && found.initializer.kind === ts.SyntaxKind.FalseKeyword))
  );
}

function callNames(node) {
  const names = [];
  walk(node, (candidate) => {
    if (!ts.isCallExpression(candidate)) return;
    if (ts.isIdentifier(candidate.expression)) names.push(candidate.expression.text);
    if (ts.isPropertyAccessExpression(candidate.expression))
      names.push(candidate.expression.name.text);
  });
  return names;
}

function functionDeclaration(file, name) {
  let result;
  walk(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node;
  });
  assert(result, `Function ${name} is missing.`);
  return result;
}

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(absolute));
    else result.push(absolute);
  }
  return result;
}

async function validateBuildAndHooks(tempRoot) {
  const hardeningPath = 'apps/desktop/src/common/buildHardening.ts';
  const hardening = loadTypeScript(hardeningPath);
  for (const kind of ['main', 'preload', 'renderer']) {
    const policy = hardening.productionBundleSettings(kind, true);
    assert(policy.sourcemap === false, `${kind} production sourcemaps are enabled.`);
    assert(policy.minify === 'esbuild', `${kind} production minification is not explicit.`);
    assert(policy.cssMinify === 'esbuild', `${kind} CSS minification is not explicit.`);
    assert(policy.output.compact === true, `${kind} output is not compact.`);
    assert(
      JSON.stringify(policy.esbuild.drop) === JSON.stringify(['debugger']),
      `${kind} must remove debugger without dropping console/structured logging.`,
    );
    assert(!policy.esbuild.drop.includes('console'), `${kind} drops structured logger output.`);
  }
  assert(
    hardening.productionBundleSettings('main', true).target === 'node20.18',
    'Main target does not match Electron 33 Node.',
  );
  assert(
    hardening.productionBundleSettings('renderer', true).target === 'chrome130',
    'Renderer target does not match Electron 33 Chromium.',
  );
  assert(
    hardening.productionBundleSettings('renderer', false) === null,
    'Development/HMR unexpectedly receives production hardening.',
  );

  const viteModule = loadTypeScript('apps/desktop/electron.vite.config.ts', {
    'electron-vite': {
      defineConfig: (config) => config,
      externalizeDepsPlugin: () => ({ name: 'externalize' }),
    },
    '@vitejs/plugin-react': { __esModule: true, default: () => ({ name: 'react' }) },
    './src/common/buildHardening': hardening,
  });
  const factory = viteModule.default;
  assert(typeof factory === 'function', 'electron-vite config is not environment-aware.');
  const production = factory({ command: 'build', mode: 'production' });
  for (const kind of ['main', 'preload', 'renderer']) {
    assert(production[kind].build.sourcemap === false, `${kind} config emits maps.`);
    assert(production[kind].build.minify === 'esbuild', `${kind} config is not minified.`);
    assert(production[kind].build.rollupOptions.output.compact, `${kind} config is not compact.`);
    assert(
      production[kind].esbuild.drop.join(',') === 'debugger',
      `${kind} config removes more than debugger.`,
    );
  }
  const development = factory({ command: 'serve', mode: 'development' });
  assert(
    development.main.build.sourcemap === undefined,
    'Development config was forced to prod maps.',
  );
  assert(
    development.renderer.esbuild === undefined,
    'Development renderer lost normal HMR transforms.',
  );

  const builderSource = read('apps/desktop/electron-builder.yml');
  const builder = yaml.load(builderSource);
  assert(builder.electronVersion === '33.2.0', 'electron-builder Electron changed.');
  assert(
    builder.asar && builder.asar.smartUnpack === false,
    'ASAR must be enabled with broad automatic smartUnpack disabled.',
  );
  assert(builder.compression === 'maximum', 'Maximum compression is not enabled.');
  assert(builder.publish === undefined, 'A package-level publish destination remains configured.');
  assert(
    !/YOUR-RELEASE-HOST|provider:\s*generic/i.test(builderSource),
    'Placeholder publisher remains.',
  );
  assert(builder.afterPack === 'scripts/after-pack-fuses.cjs', 'Fuse hook is not invoked.');
  assert(
    builder.afterAllArtifactBuild === 'scripts/after-all-artifact-build.cjs',
    'Artifact hash hook is not invoked.',
  );
  deepStrictEqual(
    builder.asarUnpack,
    [
      'node_modules/node-pty/build/Release/*.{node,dll,exe}',
      'node_modules/node-pty/build/Release/conpty/*.{dll,exe}',
    ],
    'ASAR unpacking must contain only rebuilt node-pty runtime binaries.',
  );
  assert(
    builder.extraResources?.length === 1 &&
      builder.extraResources[0].from === '../../target/release/axiom-core.exe' &&
      builder.extraResources[0].to === 'bin/axiom-core.exe',
    'Native core resource policy changed.',
  );
  const files = builder.files;
  assert(
    files.includes('out/**/*') && files.includes('package.json'),
    'Compiled allowlist is missing.',
  );
  for (const excluded of [
    '!**/*.map',
    '!**/*.d.ts',
    '!**/*.{ts,tsx,pdb,gyp,cc,cpp,c,h,hpp}',
    '!**/{script,scripts}/**/*',
    '!**/node_modules/node-pty/{bin,src,typings,scripts,deps,node-addon-api,third_party,prebuilds}/**/*',
    '!**/node_modules/node-pty/binding.gyp',
    '!**/node_modules/node-pty/build/deps/**/*',
    '!**/node_modules/node-pty/build/*.{sln,gypi,vcxproj,filters}',
    '!**/node_modules/node-addon-api/**/*',
  ]) {
    assert(files.includes(excluded), `Packaging exclusion missing: ${excluded}`);
  }
  assert(
    files.some((entry) => entry.includes('{test,tests,__tests__')),
    'Test exclusions missing.',
  );
  assert(
    builder.win.target.length === 1 &&
      builder.win.target[0].target === 'nsis' &&
      builder.win.target[0].arch.join(',') === 'x64',
    'Windows package must remain x64 NSIS.',
  );

  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  assert(
    desktopPackage.scripts.package ===
      'node scripts/prepare-package-output.cjs && electron-vite build && electron-builder --win --config.win.sign=null' &&
      desktopPackage.scripts['package:dir'] ===
        'node scripts/prepare-package-output.cjs && electron-vite build && electron-builder --win --dir --config.win.sign=null',
    'Desktop packaging does not run bounded stale-metadata cleanup inside the explicit unsigned boundary.',
  );
  const packagePreparation = require(path.join(desktop, 'scripts', 'prepare-package-output.cjs'));
  deepStrictEqual(packagePreparation.STALE_GENERIC_METADATA, ['latest.yml', 'latest.yml.sha256']);
  const staleOutput = path.join(tempRoot, 'stale-package-output');
  await fsp.mkdir(staleOutput, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(staleOutput, 'latest.yml'), 'stale'),
    fsp.writeFile(path.join(staleOutput, 'latest.yml.sha256'), 'stale'),
    fsp.writeFile(path.join(staleOutput, 'preserve-user-output.bin'), 'preserve'),
  ]);
  assert(
    (await packagePreparation.preparePackageOutput(staleOutput, staleOutput)) === 2,
    'Stale generic metadata cleanup did not report both files.',
  );
  assert(!fs.existsSync(path.join(staleOutput, 'latest.yml')), 'Stale latest.yml survived.');
  assert(
    fs.existsSync(path.join(staleOutput, 'preserve-user-output.bin')),
    'Package preparation removed unrelated output.',
  );
  await mustReject(
    () => packagePreparation.preparePackageOutput(staleOutput, path.join(tempRoot, 'other-output')),
    'Package preparation accepted a non-approved output directory.',
  );
  await fsp.mkdir(path.join(staleOutput, 'latest.yml'));
  await mustReject(
    () => packagePreparation.preparePackageOutput(staleOutput, staleOutput),
    'Package preparation accepted non-regular stale metadata.',
  );

  const fuseHook = require(path.join(desktop, 'scripts', 'after-pack-fuses.cjs'));
  deepStrictEqual(fuseHook.FUSE_POLICY, {
    RunAsNode: true,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
  });
  deepStrictEqual(fuseHook.EXPECTED_NODE_PTY_RUNTIME_FILES, [
    'node_modules/node-pty/build/Release/conpty.node',
    'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
    'node_modules/node-pty/build/Release/conpty/conpty.dll',
    'node_modules/node-pty/build/Release/conpty_console_list.node',
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/node-pty/build/Release/winpty-agent.exe',
    'node_modules/node-pty/build/Release/winpty.dll',
  ]);
  const validMainBundle =
    "const a='ELECTRON_RUN_AS_NODE',b='ELECTRON_RUN_AS_NODE';utilityProcess.fork(entry);throw new Error('Executable extensions are disabled until isolation exists');";
  const validMainGraph = {
    'out/main/index.js':
      "'use strict';Promise.resolve().then(() => require('./chunks/application.js'));",
    'out/main/chunks/application.js': `${validMainBundle};require('./shared.js');`,
    'out/main/chunks/shared.js': "'use strict';",
    'out/main/extensionSandboxWorker.js': "'use strict';require('./chunks/shared.js');",
    // The extension host is its own program, so the fixture declares it as its own root.
    'out/main/extensionHostWorker.js': "'use strict';require('./chunks/shared.js');",
  };
  const collectMainGraph = (files) => {
    const entries = Object.keys(files).map((entry) => `/${entry}`);
    const asar = {
      extractFile(_archivePath, entry) {
        const normalized = entry.replaceAll('\\', '/');
        const source = files[normalized];
        if (typeof source !== 'string') {
          throw new Error(`Fixture Main entry is unavailable: ${normalized}`);
        }
        return Buffer.from(source, 'utf8');
      },
    };
    return {
      entries,
      bundles: fuseHook.collectReachableMainBundles(asar, 'fixture.asar', entries),
    };
  };
  const validGraph = collectMainGraph(validMainGraph);
  const validAsarEntries = [
    ...validGraph.entries,
    '/node_modules/node-pty/package.json',
    '/node_modules/node-pty/lib/index.js',
    ...fuseHook.EXPECTED_NODE_PTY_RUNTIME_FILES,
  ];
  fuseHook.assertAsarEntryPolicy(validAsarEntries, validGraph.bundles);
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        [...validAsarEntries, '/node_modules/node-addon-api/tools/check-napi.js'],
        validMainBundle,
      ),
    'ASAR policy accepted hoisted node-addon-api build tooling.',
  );
  for (const forbiddenEntry of [
    '/node_modules/node-pty/src/index.ts',
    '/node_modules/node-pty/scripts/post-install.js',
    '/node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    '/node_modules/node-pty/build/config.gypi',
    '/node_modules/node-pty/build/Release/obj/conpty.obj',
  ]) {
    mustThrow(
      () => fuseHook.assertAsarEntryPolicy([...validAsarEntries, forbiddenEntry], validMainBundle),
      `ASAR policy accepted node-pty baggage: ${forbiddenEntry}`,
    );
  }
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        validAsarEntries,
        "const a='ELECTRON_RUN_AS_NODE',b='ELECTRON_RUN_AS_NODE';",
      ),
    'ASAR policy accepted Main without executable-extension rejection.',
  );
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        validAsarEntries,
        `${validMainBundle} Extension host activated`,
      ),
    'ASAR policy accepted dormant extension-host activation text.',
  );
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        validAsarEntries,
        validMainBundle.replace('utilityProcess.fork(entry);', ''),
      ),
    'ASAR policy accepted Main without the out-of-process extension host launcher.',
  );
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        validGraph.entries.filter((entry) => !entry.includes('extensionHostWorker')),
        validGraph.bundles,
      ),
    'ASAR policy accepted a package with no extension host bundle.',
  );
  const validUnpackedRecords = fuseHook.EXPECTED_NODE_PTY_RUNTIME_FILES.map((relative) => ({
    relative,
    isFile: true,
    isSymbolicLink: false,
    machine: 0x8664,
  }));
  fuseHook.assertUnpackedInventory(validUnpackedRecords);
  for (const [label, records] of [
    [
      'extra',
      [
        ...validUnpackedRecords,
        {
          relative: 'node_modules/node-pty/build/Release/debug.pdb',
          isFile: true,
          isSymbolicLink: false,
          machine: 0x8664,
        },
      ],
    ],
    ['missing', validUnpackedRecords.slice(1)],
    [
      'reparse',
      validUnpackedRecords.map((record, index) =>
        index === 0 ? { ...record, isFile: false, isSymbolicLink: true } : record,
      ),
    ],
    [
      'non-file',
      validUnpackedRecords.map((record, index) =>
        index === 0 ? { ...record, isFile: false } : record,
      ),
    ],
    [
      'non-x64',
      validUnpackedRecords.map((record, index) =>
        index === 0 ? { ...record, machine: 0x14c } : record,
      ),
    ],
  ]) {
    mustThrow(
      () => fuseHook.assertUnpackedInventory(records),
      `ASAR unpacked policy accepted ${label} inventory.`,
    );
  }
  mustThrow(
    () => fuseHook.assertAsarEntryPolicy(validAsarEntries, `${validMainBundle} bootstrap.cjs`),
    'ASAR policy accepted dormant extension-host bootstrap code.',
  );
  mustThrow(
    () =>
      fuseHook.assertAsarEntryPolicy(
        validAsarEntries,
        `${validMainBundle};const c='ELECTRON_RUN_AS_NODE'`,
      ),
    'ASAR policy accepted a third RunAsNode consumer.',
  );
  const workerConsumerGraph = collectMainGraph({
    ...validMainGraph,
    'out/main/extensionSandboxWorker.js':
      "'use strict';const workerConsumer='ELECTRON_RUN_AS_NODE';require('./chunks/shared.js');",
  });
  mustThrow(
    () => fuseHook.assertAsarEntryPolicy(validAsarEntries, workerConsumerGraph.bundles),
    'ASAR policy omitted the approved sandbox-worker graph from content inspection.',
  );
  const missingWorkerGraph = { ...validMainGraph };
  delete missingWorkerGraph['out/main/extensionSandboxWorker.js'];
  mustThrow(
    () => collectMainGraph(missingWorkerGraph),
    'Packaged Main graph accepted a missing sandbox worker.',
  );
  mustThrow(
    () =>
      collectMainGraph({
        ...validMainGraph,
        'out/main/chunks/orphan.js': "'use strict';",
      }),
    'Packaged Main graph accepted an orphan JavaScript chunk.',
  );
  mustThrow(
    () =>
      collectMainGraph({
        ...validMainGraph,
        'out/main/index.js': "'use strict';require('../../../outside.js');",
      }),
    'Packaged Main graph accepted a dependency that escaped its bundle root.',
  );
  mustThrow(
    () =>
      collectMainGraph({
        ...validMainGraph,
        'out/main/index.js': "'use strict';require('./chunks/application');",
        'out/main/chunks/application/index.js': validMainBundle,
      }),
    'Packaged Main graph accepted an ambiguous extensionless dependency.',
  );
  const excessiveMainGraph = {
    'out/main/index.js': "'use strict';require('./chunks/0.js');",
    'out/main/extensionSandboxWorker.js': "'use strict';",
  };
  for (let index = 0; index < 256; index += 1) {
    excessiveMainGraph[`out/main/chunks/${index}.js`] =
      index === 255 ? "'use strict';" : `'use strict';require('./${index + 1}.js');`;
  }
  mustThrow(
    () => collectMainGraph(excessiveMainGraph),
    'Packaged Main graph accepted more than the bounded number of reachable chunks.',
  );

  const fuseApi = await import('@electron/fuses');
  const appOutDir = path.join(tempRoot, 'win-unpacked');
  const resourcesDir = path.join(appOutDir, 'resources');
  const fixtureSource = path.join(tempRoot, 'asar-source');
  await Promise.all([
    fsp.mkdir(resourcesDir, { recursive: true }),
    fsp.mkdir(path.join(fixtureSource, 'node_modules', 'node-pty', 'lib'), { recursive: true }),
    ...Object.keys(validMainGraph).map((relative) =>
      fsp.mkdir(path.dirname(path.join(fixtureSource, ...relative.split('/'))), {
        recursive: true,
      }),
    ),
  ]);
  await Promise.all([
    fsp.writeFile(
      path.join(fixtureSource, 'package.json'),
      JSON.stringify({ name: 'fuse-fixture', version: '1.0.2', main: 'out/main/index.js' }),
    ),
    ...Object.entries(validMainGraph).map(([relative, source]) =>
      fsp.writeFile(path.join(fixtureSource, ...relative.split('/')), source),
    ),
    fsp.writeFile(
      path.join(fixtureSource, 'node_modules', 'node-pty', 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0', main: 'lib/index.js' }),
    ),
    fsp.writeFile(
      path.join(fixtureSource, 'node_modules', 'node-pty', 'lib', 'index.js'),
      "'use strict';\n",
    ),
  ]);
  for (const relative of fuseHook.EXPECTED_NODE_PTY_RUNTIME_FILES) {
    const withinNodePty = relative.replace(/^node_modules\/node-pty\//, '');
    const source = path.join(root, 'node_modules', 'node-pty', ...withinNodePty.split('/'));
    const destination = path.join(fixtureSource, ...relative.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
  }
  const asarPath = path.join(resourcesDir, 'app.asar');
  await require('@electron/asar').createPackage(fixtureSource, asarPath);
  const unpackedFixture = `${asarPath}.unpacked`;
  for (const relative of fuseHook.EXPECTED_NODE_PTY_RUNTIME_FILES) {
    const withinNodePty = relative.replace(/^node_modules\/node-pty\//, '');
    const source = path.join(root, 'node_modules', 'node-pty', ...withinNodePty.split('/'));
    const destination = path.join(unpackedFixture, ...relative.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
  }
  const headerHash = await fuseHook.hashAsarHeader(asarPath);
  const integrityPayload = fuseHook.windowsIntegrityPayload(headerHash);
  deepStrictEqual(JSON.parse(integrityPayload.toString('utf8')), [
    { file: 'resources\\app.asar', alg: 'SHA256', value: headerHash },
  ]);

  const executable = path.join(appOutDir, 'AXIOM.exe');
  if (process.platform === 'win32') {
    const electronExecutable = [
      path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(root, 'AXIOM EXE', 'dist', 'win-unpacked', 'AXIOM.exe'),
    ].find((candidate) => fs.existsSync(candidate));
    assert(electronExecutable, 'Pinned Electron executable is unavailable for fuse validation.');
    await fsp.copyFile(electronExecutable, executable);
    await fuseHook({
      appOutDir,
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'AXIOM' } },
    });
    await fuseHook.updateWindowsIntegrityResource(executable, integrityPayload, 'verify');
  } else {
    const fakeWire = Buffer.concat([
      Buffer.from('fake-electron-prefix'),
      Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
      Buffer.from([1, 8]),
      Buffer.alloc(8, fuseApi.FuseState.INHERIT),
    ]);
    await fsp.writeFile(executable, fakeWire);
    const config = { version: fuseApi.FuseVersion.V1, strictlyRequireAllFuses: true };
    for (const [name, enabled] of Object.entries(fuseHook.FUSE_POLICY)) {
      config[fuseApi.FuseV1Options[name]] = enabled;
    }
    await fuseApi.flipFuses(executable, config);
  }
  const actual = await fuseApi.getCurrentFuseWire(executable);
  fuseHook.assertFuseWire(actual, fuseApi);
  assert(
    actual[fuseApi.FuseV1Options.RunAsNode] === fuseApi.FuseState.ENABLE,
    'Actual packaged fuse wire did not retain operation-scoped askpass support.',
  );

  const artifactHook = require(path.join(desktop, 'scripts', 'after-all-artifact-build.cjs'));
  const outDir = path.join(tempRoot, 'artifacts');
  await fsp.mkdir(outDir, { recursive: true });
  const fixtureData = new Map([
    ['AXIOM-Setup-1.0.2-x64.exe', Buffer.from('signed-installer-fixture')],
    ['AXIOM-Setup-1.0.2-x64.exe.blockmap', Buffer.from('blockmap-fixture')],
    ['latest.yml', Buffer.from('version: 1.0.2\n')],
    ['renderer.js.map', Buffer.from('credential-fixture-must-not-be-hashed')],
  ]);
  for (const [name, value] of fixtureData) await fsp.writeFile(path.join(outDir, name), value);
  const artifactPaths = [...fixtureData.keys()].map((name) => path.join(outDir, name));
  const sidecars = await artifactHook.createSha256Sidecars(outDir, artifactPaths);
  assert(sidecars.length === 3, 'Unexpected artifact sidecar selection.');
  assert(!sidecars.some((item) => item.includes('.map.sha256')), 'Source map received a sidecar.');
  for (const sidecar of sidecars) {
    const artifact = sidecar.slice(0, -'.sha256'.length);
    const expected = crypto
      .createHash('sha256')
      .update(await fsp.readFile(artifact))
      .digest('hex');
    const content = await fsp.readFile(sidecar, 'utf8');
    assert(
      content === `${expected}  ${path.basename(artifact)}\n`,
      'Sidecar format/hash mismatch.',
    );
    assert(!content.includes(outDir), 'Sidecar disclosed an internal path.');
    assert(
      !content.includes('credential-fixture'),
      'Sidecar disclosed source/secret fixture text.',
    );
  }
  assert(
    !(await fsp.readdir(outDir)).some((name) => name.endsWith('.tmp')),
    'Atomic sidecar temporary file was left behind.',
  );
  const outside = path.join(tempRoot, 'outside.exe');
  await fsp.writeFile(outside, 'outside');
  await mustReject(
    () => artifactHook.createSha256Sidecars(outDir, [outside]),
    'Artifact hashing accepted a path outside the output directory.',
  );
}

function validateRuntimePolicies() {
  // `runtimeSecurity.ts` names the webview scheme in its frame allow-list, so the pure webview
  // module is supplied here rather than resolved as a runtime dependency.
  const runtime = loadTypeScript('apps/desktop/src/main/runtimeSecurity.ts', {
    '../common/vscodeWebview': loadTypeScript('apps/desktop/src/common/vscodeWebview.ts'),
  });
  assert(runtime.isProductionRuntime(true, 'http://localhost:5173'), 'Packaged app is not prod.');
  assert(!runtime.isProductionRuntime(false, 'http://localhost:5173'), 'Dev server lost dev mode.');
  assert(
    runtime.isProductionRuntime(false, undefined),
    'Unpackaged production build is not hardened.',
  );

  const renderer = 'axiom://renderer/index.html';
  assert(runtime.RENDERER_ENTRY_URL === renderer, 'Packaged renderer origin changed.');
  assert(runtime.isExactRendererNavigation(renderer, renderer), 'Exact renderer URL was rejected.');
  deepStrictEqual(
    [
      runtime.rendererAssetRelativePath(renderer),
      runtime.rendererAssetRelativePath('axiom://renderer/assets/index-Ab_c.123.js'),
      runtime.rendererAssetRelativePath('axiom://renderer/chunks/typescript-CMbDiYeM.js'),
    ],
    ['index.html', 'assets/index-Ab_c.123.js', 'chunks/typescript-CMbDiYeM.js'],
    'Packaged renderer asset allowlist rejected generated bundle paths.',
  );
  for (const invalid of [
    `${renderer}?debug=1`,
    `${renderer}#route`,
    renderer.replace('index.html', 'other.html'),
    'axiom://other/index.html',
    'axiom://renderer/assets/%2e%2e%2findex.html',
    'axiom://renderer/assets/nested/file.js',
    'axiom://user:pass@renderer/index.html',
    'https://user:pass@example.com/',
    'not a url',
  ]) {
    assert(
      !runtime.isExactRendererNavigation(invalid, renderer),
      `Non-exact renderer navigation accepted: ${invalid}`,
    );
    if (invalid !== renderer) {
      assert(
        runtime.rendererAssetRelativePath(invalid) === null,
        `Unsafe renderer asset URL accepted: ${invalid}`,
      );
    }
  }

  assert(
    runtime.externalUrlForOpen('https://example.com/docs?mode=read', false) ===
      'https://example.com/docs?mode=read',
    'Normal production HTTPS external URL was rejected.',
  );
  assert(
    runtime.externalUrlForOpen('http://127.0.0.1:5173/docs', true) !== null,
    'Development loopback HTTP was rejected.',
  );
  for (const [url, development] of [
    ['http://example.com/', false],
    ['http://example.com/', true],
    ['file:///C:/secret.txt', false],
    ['https://user:pass@example.com/', false],
    ['https://example.com/?access_token=fake', false],
    ['javascript:alert(1)', false],
  ]) {
    assert(
      runtime.externalUrlForOpen(url, development) === null,
      `Unsafe external URL accepted: ${url}`,
    );
  }

  const input = (key, overrides = {}) => ({
    type: 'keyDown',
    key,
    code: key,
    control: false,
    shift: false,
    meta: false,
    ...overrides,
  });
  assert(runtime.isBlockedDevToolsInput(input('F12')), 'F12 was not blocked.');
  for (const key of ['i', 'j', 'c']) {
    assert(
      runtime.isBlockedDevToolsInput(input(key, { control: true, shift: true })),
      `Ctrl+Shift+${key.toUpperCase()} was not blocked.`,
    );
  }
  assert(
    !runtime.isBlockedDevToolsInput(input('c', { control: true })),
    'Ordinary Ctrl+C was blocked.',
  );
  assert(
    !runtime.isBlockedDevToolsInput(input('p', { control: true, shift: true })),
    'Ordinary editor command shortcut was blocked.',
  );
  assert(
    !runtime.isBlockedDevToolsInput(input('F12', { type: 'keyUp' })),
    'Key-up was unnecessarily blocked.',
  );

  const malicious = new Error(
    'provider-marker https://user:password@example.com/?access_token=fake C:\\internal\\app.ts',
  );
  malicious.stack = `provider-marker\n    at C:\\internal\\app.ts:1:1`;
  const productionDetails = JSON.stringify(runtime.runtimeErrorDetails(malicious, true));
  for (const forbidden of ['provider-marker', 'internal', 'http', 'password', 'access_token']) {
    assert(!productionDetails.includes(forbidden), `Production diagnostic leaked ${forbidden}.`);
  }
  assert(
    JSON.stringify(runtime.runtimeErrorDetails(malicious, false)).includes('provider-marker'),
    'Development diagnostics lost useful detail.',
  );
  assert(
    JSON.stringify(runtime.windowLoadFailureDetails(-6, 'C:\\private\\renderer', true)) ===
      '{"code":-6}',
    'Production window failure reflected arbitrary detail.',
  );

  const directives = runtime.PRODUCTION_CSP_DIRECTIVES;
  for (const directive of ['default-src', 'object-src', 'form-action', 'media-src']) {
    assert(
      directives[directive].length === 1 && directives[directive][0] === "'none'",
      `CSP ${directive} is not default-deny.`,
    );
  }
  /**
   * Framing: extension webviews and nothing else.
   *
   * Phase 4 widened these two directives from `'none'` to the webview scheme, because the
   * workbench has to be able to embed a webview at all. The grant is narrow in both directions:
   * the scheme resolves only to one webview's allow-listed files, and the framed document's own
   * `frame-ancestors` keeps it embeddable nowhere but here.
   */
  for (const directive of ['frame-src', 'child-src']) {
    assert(
      directives[directive].length === 1 && directives[directive][0] === 'axiom-webview:',
      `CSP ${directive} must allow extension webviews and nothing else.`,
    );
  }
  /**
   * Scripts: same-origin only, plus WebAssembly compilation and nothing else.
   *
   * `'wasm-unsafe-eval'` is required by the TextMate highlighting engine, whose regular
   * expression matcher is the Oniguruma WebAssembly module — the same engine VS Code uses,
   * and the reason grammar-based highlighting is possible at all. It permits compiling and
   * instantiating WebAssembly; it does not permit `eval`, `new Function`, inline scripts, or
   * scripts from any other origin, all of which are asserted absent below rather than
   * implied by an equality check. Chromium enforces these as separate capabilities, so this
   * is a strictly narrower grant than `'unsafe-eval'`.
   *
   * Adding any other token here is expected to fail this gate. That is the point: the list
   * is short enough to justify one entry at a time.
   */
  assert(
    directives['script-src'].join(' ') === "'self' 'wasm-unsafe-eval'",
    'CSP script-src is not exactly same-origin plus WebAssembly.',
  );
  for (const forbiddenScriptToken of [
    "'unsafe-eval'",
    "'unsafe-inline'",
    "'unsafe-hashes'",
    "'strict-dynamic'",
    'data:',
    'blob:',
    '*',
  ]) {
    assert(
      !directives['script-src'].includes(forbiddenScriptToken),
      `CSP script-src allows ${forbiddenScriptToken}.`,
    );
  }
  assert(directives['connect-src'].join(' ') === "'self'", 'CSP allows remote connections.');
  assert(
    directives['worker-src'].join(' ') === "'self' blob:",
    'CSP does not narrowly support Monaco workers.',
  );
  assert(
    directives['style-src'].join(' ') === "'self' 'unsafe-inline'",
    'CSP does not narrowly support Monaco styles.',
  );
  assert(!/https?:|wss?:/.test(runtime.PRODUCTION_CSP), 'Production CSP contains remote origins.');
  assert(
    runtime.DEVELOPMENT_CSP.includes('http://localhost:*') &&
      runtime.DEVELOPMENT_CSP.includes('ws://localhost:*'),
    'Development CSP broke local HMR.',
  );

  const aiGateway = loadTypeScript('apps/desktop/src/main/services/aiGateway.ts', {
    '@axiom/shared': {
      rootLogger: { child: () => ({ debug: () => undefined, warn: () => undefined }) },
    },
    '../../common/requestDedup': { normalizeMessages: (messages) => messages },
    '../../common/aiSafety': {
      DEFAULT_EGRESS_POLICY: { mode: 'audit', blockSeverity: 'high' },
      resolveEgress: (text) => ({
        action: 'allow',
        text,
        findings: [],
        redactions: 0,
        summary: 'No findings.',
      }),
    },
  });
  deepStrictEqual(
    aiGateway.selectPinnedAiAddress(
      [
        { address: '64:ff9b::b90e:5c7f', family: 6 },
        { address: '185.14.92.127', family: 4 },
      ],
      false,
    ),
    { address: '185.14.92.127', family: 4 },
    'A blocked NAT64 answer prevented pinning an independently public address.',
  );
  deepStrictEqual(
    aiGateway.selectPinnedAiAddress(
      [
        { address: '127.0.0.1', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ],
      false,
    ),
    { address: '93.184.216.34', family: 4 },
    'A mixed DNS response did not pin only the policy-approved public address.',
  );
  mustThrow(
    () =>
      aiGateway.selectPinnedAiAddress(
        [
          { address: '64:ff9b::b90e:5c7f', family: 6 },
          { address: '127.0.0.1', family: 4 },
          { address: '192.168.1.10', family: 4 },
        ],
        false,
      ),
    'Private/special-use-only AI endpoint answers were accepted.',
  );

  const mainFile = sourceFile('apps/desktop/src/main/index.ts');
  const mainEvents = new Set();
  let menuRemoved = false;
  walk(mainFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'on' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      mainEvents.add(node.arguments[0].text);
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === 'Menu' &&
      node.expression.name.text === 'setApplicationMenu'
    ) {
      menuRemoved = node.arguments[0]?.kind === ts.SyntaxKind.NullKeyword;
    }
  });
  assert(menuRemoved, 'Production application menu removal is not wired.');
  for (const event of [
    'will-download',
    'before-input-event',
    'devtools-opened',
    'will-navigate',
    'will-redirect',
    'will-attach-webview',
    'select-hid-device',
    'select-usb-device',
    'select-serial-port',
    'select-bluetooth-device',
  ]) {
    assert(mainEvents.has(event), `Runtime deny handler missing: ${event}`);
  }

  const windowFile = sourceFile('apps/desktop/src/main/window.ts');
  let windowOptions;
  walk(windowFile, (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText() === 'BrowserWindow' &&
      node.arguments?.[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      windowOptions = node.arguments[0];
    }
  });
  assert(windowOptions, 'BrowserWindow options were not found.');
  const webPreferencesProperty = property(windowOptions, 'webPreferences');
  assert(
    webPreferencesProperty && ts.isObjectLiteralExpression(webPreferencesProperty.initializer),
    'BrowserWindow webPreferences are not explicit.',
  );
  const preferences = webPreferencesProperty.initializer;
  assert(booleanProperty(preferences, 'sandbox', true), 'Renderer sandbox is disabled.');
  assert(booleanProperty(preferences, 'contextIsolation', true), 'Context isolation is disabled.');
  assert(booleanProperty(preferences, 'nodeIntegration', false), 'Node integration is enabled.');
  assert(booleanProperty(preferences, 'webSecurity', true), 'Web security is disabled.');
  const devTools = property(preferences, 'devTools');
  assert(
    devTools && devTools.initializer.getText() === '!isProduction',
    'BrowserWindow DevTools are not disabled only in production.',
  );
}

function validateLoggingAndUpdater() {
  const logger = loadTypeScript('packages/shared/src/logger.ts');
  const normal = 'Token budget is 4096; open https://example.com/docs?mode=read.';
  assert(logger.redactString(normal) === normal, 'Logger corrupted an ordinary message.');
  const fakeGithub = `ghp_${'A'.repeat(30)}`;
  const fakeJwt = `eyJ${'A'.repeat(12)}.${'B'.repeat(12)}.${'C'.repeat(12)}`;
  const sensitive =
    `https://user:password@example.com/path?access_token=fake&mode=read ` +
    `Bearer abcdefgh ${fakeGithub} sk-${'Z'.repeat(24)} ${fakeJwt}`;
  const sanitized = logger.redactString(sensitive);
  for (const secret of ['user:password', 'access_token=fake', 'abcdefgh', fakeGithub, fakeJwt]) {
    assert(
      !sanitized.includes(secret),
      `Logger retained credential material: ${secret.slice(0, 12)}`,
    );
  }
  assert(sanitized.includes('mode=read'), 'Logger corrupted a normal URL parameter.');
  const nested = logger.redact({
    authorization: 'Bearer fake',
    message: 'api_key=synthetic-value',
    url: 'https://name:pass@example.com/path',
  });
  assert(nested.authorization === '[REDACTED]', 'Logger did not redact secret-shaped key.');
  assert(!nested.message.includes('synthetic-value'), 'Logger did not redact string assignment.');
  assert(!nested.url.includes('name:pass'), 'Logger did not redact URL userinfo.');
  const records = [];
  new logger.Logger({ sink: (record) => records.push(record) }).info('Bearer message-secret', {
    endpoint: 'https://u:p@example.com/?token=fake',
  });
  assert(!JSON.stringify(records).includes('message-secret'), 'Logger sink received a raw secret.');
  assert(!JSON.stringify(records).includes('token=fake'), 'Logger sink received a raw URL token.');

  const network = loadTypeScript('apps/desktop/src/common/updateNetwork.ts');
  assert(
    network.validateUpdateDownloadUrl('https://updates.example.com/app.exe') ===
      'https://updates.example.com/app.exe',
    'Valid update URL was rejected.',
  );
  for (const invalid of [
    'http://updates.example.com/app.exe',
    'https://user:pass@updates.example.com/app.exe',
    'https://updates.example.com/app.exe#fragment',
    'file:///C:/app.exe',
  ]) {
    assert(
      network.validateUpdateDownloadUrl(invalid) === null,
      `Unsafe update URL accepted: ${invalid}`,
    );
  }
  const controller = new AbortController();
  const options = network.updateFetchOptions(controller.signal);
  assert(options.redirect === 'error', 'Update redirects are not blocked.');
  assert(options.credentials === 'omit', 'Update fetch can send ambient credentials.');
  assert(
    options.signal === controller.signal,
    'Update timeout/cancellation signal is not attached.',
  );
  assert(options.referrerPolicy === 'no-referrer', 'Update URL can leak through a referrer.');
  network.assertUpdateResponseUrl(
    'https://updates.example.com/app.exe',
    'https://updates.example.com/app.exe',
    false,
  );
  mustThrow(
    () =>
      network.assertUpdateResponseUrl(
        'https://updates.example.com/app.exe',
        'https://cdn.example.com/app.exe',
        false,
      ),
    'Changed update response URL was accepted.',
  );
  mustThrow(
    () =>
      network.assertUpdateResponseUrl(
        'https://updates.example.com/app.exe',
        'https://updates.example.com/app.exe',
        true,
      ),
    'Redirected update response was accepted.',
  );
  assert(
    network.assertUpdateResponseBounds('1024', 1024) === 1024,
    'Valid update content length was rejected.',
  );
  mustThrow(
    () => network.assertUpdateResponseBounds(String(network.MAX_UPDATE_DOWNLOAD_BYTES + 1), null),
    'Oversized update content length was accepted.',
  );
  mustThrow(
    () => network.assertUpdateResponseBounds('1025', 1024),
    'Unexpected update content length was accepted.',
  );
  mustThrow(
    () => network.assertUpdateTransferredBytes(1025, 1024),
    'Streaming update overflow was accepted.',
  );
  assert(
    network.UPDATE_DOWNLOAD_TIMEOUT_MS > 0 && network.UPDATE_DOWNLOAD_TIMEOUT_MS <= 5 * 60 * 1000,
    'Update timeout is absent or unbounded.',
  );

  const updateFile = sourceFile('apps/desktop/src/main/services/updateService.ts');
  const downloadCalls = callNames(functionDeclaration(updateFile, 'downloadAndVerify'));
  for (const required of [
    'updateFetchOptions',
    'assertUpdateResponseUrl',
    'assertUpdateResponseBounds',
    'assertUpdateTransferredBytes',
    'verifyDownload',
    'hashFile',
  ]) {
    assert(downloadCalls.includes(required), `Updater does not enforce ${required}.`);
  }
  const installFunction = functionDeclaration(updateFile, 'performInstall');
  const installText = installFunction.getText();
  assert(
    installText.indexOf('revalidateInstaller(') >= 0 &&
      installText.indexOf('revalidateInstaller(') < installText.indexOf('spawn('),
    'Installer executes before immediate size/SHA-256 revalidation.',
  );
}

function validateSigningIsolation() {
  const local = read('AXIOM EXE/build-axiom-exe.ps1');
  const signer = read('AXIOM EXE/sign-release-artifacts.ps1');
  const runtimeVerifier = read('apps/desktop/scripts/verify-packaged-runtime.cjs');
  const mainBootstrap = read('apps/desktop/src/main/bootstrap.ts');
  const viteConfig = read('apps/desktop/electron.vite.config.ts');
  const builderConfig = read('apps/desktop/electron-builder.yml');
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  const workflowSource = read('.github/workflows/build-installers.yml');
  const workflow = yaml.load(workflowSource);

  const removeCredentials = local.indexOf(
    "foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'AXIOM_SIGNER_SHA1', 'AXIOM_SIGNER_SUBJECT'))",
  );
  const dependencyInstall = local.indexOf('npm.cmd ci');
  const unsignedApp = local.indexOf('& $builder --win --dir --config.win.sign=null');
  const signerFunction = local.indexOf('function Invoke-DedicatedSigner');
  const scopedCredential = local.indexOf('$env:CSC_LINK = $signingLink', signerFunction);
  const appSign = local.indexOf("Invoke-DedicatedSigner 'App' $unpacked");
  const unsignedNsis = local.indexOf(
    '& $builder --win nsis --prepackaged $unpacked --config.win.sign=null',
  );
  const installerSign = local.indexOf("Invoke-DedicatedSigner 'Installer' $installers[0].FullName");
  const sidecars = local.indexOf('# Sidecars are generated only after final signatures');
  assert(
    removeCredentials >= 0 &&
      removeCredentials < dependencyInstall &&
      unsignedApp > dependencyInstall &&
      signerFunction > unsignedApp &&
      scopedCredential > signerFunction &&
      appSign > scopedCredential &&
      unsignedNsis > appSign &&
      installerSign > unsignedNsis &&
      sidecars > installerSign,
    'Local release stages do not isolate signing credentials from build/package hooks.',
  );
  assert(
    (local.match(/\$env:CSC_LINK\s*=/g) || []).length === 1 &&
      local.includes('Release output directory must be absent or empty') &&
      (local.match(/verify-packaged-runtime\.cjs/g) || []).length === 2 &&
      local.includes('Final artifact has no checksum sidecar'),
    'Local release flow permits stale outputs, credential rescoping, or incomplete post-sign checks.',
  );

  assert(
    !/\bnpm(?:\.cmd)?\b|electron-builder|prepare-package-output|afterPack|afterAllArtifactBuild/.test(
      signer,
    ) &&
      signer.includes(
        "throw 'Remote certificate URLs are not accepted by the signing boundary.'",
      ) &&
      signer.includes('$certificate.Subject -ne $expectedSubject') &&
      signer.includes(
        "$certificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $expectedThumbprint",
      ) &&
      signer.includes("/fd SHA256 /td SHA256 /tr 'https://timestamp.digicert.com'") &&
      signer.includes("$signature.Status -ne 'Valid'") &&
      signer.includes('$signature.TimeStamperCertificate') &&
      signer.includes("$verification -notmatch '(?i)sha256'") &&
      signer.includes("$verification -notmatch '(?i)timestamp'"),
    'Dedicated signer executes build code or omits identity/SHA-256/timestamp enforcement.',
  );
  for (const exactTarget of [
    "'AXIOM.exe'",
    "'resources/bin/axiom-core.exe'",
    "'resources/elevate.exe'",
    "'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'",
  ]) {
    assert(signer.includes(exactTarget), `Dedicated signer inventory is missing ${exactTarget}.`);
  }
  assert(
    signer.includes("'apps/desktop/package.json'") &&
      signer.includes(
        "$desktopVersion -notmatch '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
      ) &&
      signer.includes('$expectedInstallerName = "AXIOM-Setup-$desktopVersion-x64.exe"') &&
      signer.includes('$item.Name -cne $expectedInstallerName') &&
      !signer.includes('AXIOM-Setup-1.0.2-x64.exe'),
    'Dedicated signer installer allowlist is not an exact name derived from the stable desktop package version.',
  );
  assert(
    signer.includes('Compare-Object -ReferenceObject $expectedAppTargets') &&
      signer.includes('$maxTargetBytes = 1GB') &&
      signer.includes('$maxTotalBytes = 2GB') &&
      signer.includes('The unpacked application contains a reparse point'),
    'Dedicated signer target inventory is not exact, byte-bounded, and reparse-safe.',
  );

  assert(
    desktopPackage.scripts.package.endsWith('--config.win.sign=null') &&
      desktopPackage.scripts['package:dir'].endsWith('--config.win.sign=null') &&
      !/CSC_LINK|CSC_KEY_PASSWORD|certificateFile|certificatePassword|signs the app \+ installer automatically/i.test(
        builderConfig,
      ),
    'Desktop package commands or electron-builder guidance bypass the dedicated unsigned packaging boundary.',
  );
  assert(
    viteConfig.includes("resolve(__dirname, 'src/main/bootstrap.ts')") &&
      (mainBootstrap.match(/^import\s.+from\s.+;$/gm) ?? []).length === 1 &&
      mainBootstrap.includes("import { app } from 'electron';") &&
      mainBootstrap.includes("process.argv.slice(1).includes('--version')") &&
      mainBootstrap.includes("void import('./index')") &&
      mainBootstrap.indexOf("process.argv.slice(1).includes('--version')") <
        mainBootstrap.indexOf("void import('./index')"),
    'Main entry does not isolate the exact packaged version probe from application import side effects.',
  );
  assert(
    runtimeVerifier.includes('assertPackagedAsarPolicy') &&
      runtimeVerifier.includes("updateWindowsIntegrityResource(executable, payload, 'verify')") &&
      runtimeVerifier.includes('getCurrentFuseWire(executable)') &&
      runtimeVerifier.includes("spawn(executable, ['--version']") &&
      runtimeVerifier.includes("const desktopVersion = require('../package.json').version") &&
      runtimeVerifier.includes("const ELECTRON_WINDOWS_STDOUT_PREFIX = '\\r\\n'") &&
      runtimeVerifier.includes(
        'const expectedStdout = `${ELECTRON_WINDOWS_STDOUT_PREFIX}${desktopVersion}\\n`',
      ) &&
      runtimeVerifier.includes('actualStdout !== expectedStdout') &&
      !runtimeVerifier.includes('.trim(') &&
      runtimeVerifier.includes("actualStderr !== ''") &&
      runtimeVerifier.includes("child.once('close'") &&
      runtimeVerifier.includes('SMOKE_TIMEOUT_MS = 20_000') &&
      runtimeVerifier.includes('const env = {}') &&
      runtimeVerifier.includes('await smokeRenderer(executable)') &&
      runtimeVerifier.includes("'--remote-debugging-address=127.0.0.1'") &&
      runtimeVerifier.includes("document.querySelector('.workbench')") &&
      runtimeVerifier.includes("cdp.send('Page.captureScreenshot'") &&
      runtimeVerifier.includes('MIN_RENDERER_SCREENSHOT_BYTES') &&
      read('apps/desktop/src/main/window.ts').includes(
        "join(app.getAppPath(), 'out', 'renderer')",
      ) &&
      read('apps/desktop/src/main/window.ts').includes(
        "join(app.getAppPath(), 'out', 'preload/index.js')",
      ) &&
      !read('apps/desktop/src/main/window.ts').includes("join(__dirname, '../"),
    'Post-sign runtime verifier omits inventory, resource, fuses, exact version launch, renderer paint proof, or app-root asset resolution.',
  );

  const steps = workflow?.jobs?.['build-windows-x64']?.steps;
  assert(Array.isArray(steps), 'Windows signing workflow steps are missing.');
  const secretSteps = steps.filter((step) => step.env?.CSC_LINK || step.env?.CSC_KEY_PASSWORD);
  assert(
    secretSteps.length === 2,
    'Signing PFX/password are available outside two dedicated CI steps.',
  );
  for (const step of secretSteps) {
    assert(
      String(step.run).includes('sign-release-artifacts.ps1') &&
        step.env.CSC_LINK === '${{ secrets.CSC_LINK }}' &&
        step.env.CSC_KEY_PASSWORD === '${{ secrets.CSC_KEY_PASSWORD }}' &&
        step.env.AXIOM_SIGNER_SHA1 === '${{ vars.AXIOM_SIGNER_SHA1 }}' &&
        step.env.AXIOM_SIGNER_SUBJECT === '${{ vars.AXIOM_SIGNER_SUBJECT }}',
      `CI signing credentials are not confined to an identity-pinned signer step: ${step.name}`,
    );
  }
  const builderSteps = steps.filter((step) =>
    String(step.run ?? '').includes('electron-builder.cmd'),
  );
  assert(
    builderSteps.length === 2 &&
      builderSteps.every(
        (step) =>
          step['working-directory'] === 'apps/desktop' &&
          String(step.run).includes('..\\..\\node_modules\\.bin\\electron-builder.cmd') &&
          String(step.run).includes('--config.win.sign=null') &&
          !step.env?.CSC_LINK &&
          !step.env?.CSC_KEY_PASSWORD,
      ),
    'CI electron-builder stages can receive signing credentials, run outside the desktop project, or invoke signing implicitly.',
  );
  const indexOfStep = (name) => steps.findIndex((step) => step.name === name);
  const appSignIndex = indexOfStep('Sign unpacked application in dedicated boundary');
  const appVerifyIndex = indexOfStep(
    'Verify signed application resources, fuses, inventory, and launch',
  );
  const nsisIndex = indexOfStep('Assemble unsigned NSIS from signed application');
  const installerSignIndex = indexOfStep('Sign final installer in dedicated boundary');
  const finalIndex = indexOfStep('Final post-sign verification and SHA-256 sidecars');
  const uploadIndex = indexOfStep('Upload signed installer and verification metadata');
  assert(
    appSignIndex >= 0 &&
      appVerifyIndex > appSignIndex &&
      nsisIndex > appVerifyIndex &&
      installerSignIndex > nsisIndex &&
      finalIndex > installerSignIndex &&
      uploadIndex > finalIndex,
    'CI post-sign verification, installer assembly/signing, sidecars, and upload are misordered.',
  );
  const finalRun = String(steps[finalIndex].run);
  assert(
    finalRun.includes('Get-AuthenticodeSignature') &&
      finalRun.includes('TimeStamperCertificate') &&
      finalRun.includes('Get-FileHash') &&
      finalRun.includes('Missing final sidecar'),
    'CI final gate omits signature/timestamp revalidation or final-byte sidecars.',
  );
  const uploadPath = String(steps[uploadIndex].with?.path ?? '');
  for (const artifactPair of [
    ['AXIOM EXE/dist/AXIOM-Setup-*-x64.exe', 'AXIOM EXE/dist/AXIOM-Setup-*-x64.exe.sha256'],
    ['AXIOM EXE/dist/*.blockmap', 'AXIOM EXE/dist/*.blockmap.sha256'],
    ['AXIOM EXE/dist/latest*.yml', 'AXIOM EXE/dist/latest*.yml.sha256'],
  ]) {
    assert(
      artifactPair.every((pattern) => uploadPath.includes(pattern)),
      `Uploaded artifact class lacks its final sidecar: ${artifactPair[0]}`,
    );
  }
}

function validateOAuthDocsAndIdentity() {
  const rootPackage = JSON.parse(read('package.json'));
  const desktopPackage = JSON.parse(read('apps/desktop/package.json'));
  const sharedPackage = JSON.parse(read('packages/shared/package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  // Version CONSISTENCY rather than a literal pin. The invariant a release
  // actually depends on is that every workspace package and the lockfile agree.
  // A hard-coded version failed every legitimate bump while still permitting the
  // shared package and lockfile to drift — which is exactly how the 1.0.8 bump
  // shipped half-applied. This form catches drift and survives a bump.
  const releaseVersion = rootPackage.version;
  assert(
    /^\d+\.\d+\.\d+$/.test(releaseVersion),
    `Root application version is not a plain semver release: ${releaseVersion}`,
  );
  assert(
    desktopPackage.version === releaseVersion,
    `Desktop version ${desktopPackage.version} does not match root ${releaseVersion}.`,
  );
  assert(
    sharedPackage.version === releaseVersion,
    `Shared package version ${sharedPackage.version} does not match root ${releaseVersion}.`,
  );
  assert(
    lock.version === releaseVersion &&
      lock.packages['']?.version === releaseVersion &&
      lock.packages['apps/desktop']?.version === releaseVersion &&
      lock.packages['packages/shared']?.version === releaseVersion,
    `Lockfile workspace versions do not all match root ${releaseVersion}.`,
  );
  assert(rootPackage.devDependencies.electron === '33.2.0', 'Root build Electron is not pinned.');
  assert(desktopPackage.devDependencies.electron === '33.2.0', 'Electron is not exactly pinned.');
  assert(
    desktopPackage.devDependencies['@electron/fuses'] === '2.0.0',
    '@electron/fuses is not exactly pinned.',
  );
  for (const buildOnly of ['7zip-bin', 'app-builder-bin', 'app-builder-lib', 'electron-updater']) {
    assert(
      desktopPackage.dependencies[buildOnly] === undefined,
      `${buildOnly} must not be packaged as a production dependency.`,
    );
  }
  const lockedElectron =
    lock.packages['apps/desktop/node_modules/electron'] ?? lock.packages['node_modules/electron'];
  assert(lockedElectron?.version === '33.2.0', 'Lockfile Electron is not 33.2.0.');
  assert(
    lock.packages['node_modules/@electron/fuses']?.version === '2.0.0',
    'Lockfile fuse tooling is not 2.0.0.',
  );
  assert(
    desktopPackage.scripts['validate:security-hardening'] ===
      'node scripts/validate-security-hardening.cjs',
    'Security validator script is not registered.',
  );

  const logo = fs.readFileSync(path.join(desktop, 'build', 'logo.png'));
  const logoHash = crypto.createHash('sha256').update(logo).digest('hex').toUpperCase();
  assert(
    logoHash === 'E6137563C6F63E2B0C0E4AA2A1F1B3FD1416008136F10F363440BFEDDE11D7E2',
    `Official desktop logo changed: ${logoHash}`,
  );

  const sourceDirectory = path.join(desktop, 'src');
  const productionSource = filesUnder(sourceDirectory)
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const forbiddenField = ['client', 'secret'].join('_');
  assert(
    !productionSource.toLowerCase().includes(forbiddenField),
    'A confidential OAuth field appears in production source.',
  );
  assert(!/GITHUB_CLIENT_SECRET/i.test(productionSource), 'A GitHub client-secret input exists.');
  const githubSource = read('apps/desktop/src/main/services/githubScm.ts');
  assert(
    /DEFAULT_PUBLIC_CLIENT_ID/.test(githubSource),
    'Fixed public Device Flow client ID is missing.',
  );
  assert(
    /shell\.openExternal\(GITHUB_VERIFICATION_URL\)/.test(githubSource),
    'Fixed GitHub verification opening is not Main-only.',
  );

  /**
   * Source with comments removed.
   *
   * The RunAsNode inventory below is an inventory of *code*. A file that documents why it does
   * not use RunAsNode would otherwise be counted as a consumer, which would either force the
   * threat-model list to name files that never touch it or pressure someone into deleting the
   * explanation to make a gate pass. Neither is an improvement.
   */
  const codeOf = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const runAsNodeFiles = filesUnder(path.join(desktop, 'src', 'main'))
    .filter((file) => codeOf(fs.readFileSync(file, 'utf8')).includes('ELECTRON_RUN_AS_NODE'))
    .map((file) => path.relative(path.join(desktop, 'src', 'main'), file).replaceAll('\\', '/'))
    .sort();
  deepStrictEqual(
    runAsNodeFiles,
    ['services/lsp.ts', 'services/systemGit.ts'],
    'Reachable RunAsNode consumers changed without updating the threat model.',
  );
  for (const relative of runAsNodeFiles) {
    assert(
      read(`apps/desktop/src/main/${relative}`).includes('process.execPath'),
      `${relative} does not bind RunAsNode to the packaged Main runtime.`,
    );
  }
  const extensionHostSource = read('apps/desktop/src/main/services/extensionHost.ts');
  const extensionsSource = read('apps/desktop/src/main/services/extensions.ts');
  assert(
    !/spawn\(|process\.execPath|ELECTRON_RUN_AS_NODE|bootstrap\.cjs|\bactivateExtension\b/.test(
      extensionHostSource,
    ),
    'Disabled extension-host lifecycle retains a dormant executable path.',
  );
  assert(
    extensionsSource.includes('Executable extensions are disabled until') &&
      !/\bactivateExtension\b/.test(extensionsSource),
    'Executable extension entry points are not fail-closed.',
  );

  /**
   * Marketplace extension code runs, and these are the terms.
   *
   * AXIOM's own native extension system above stays inert. Extensions installed from the
   * registry are a separate subsystem with a separate identity, and they *do* execute — which
   * makes the following the load-bearing statements of the threat model rather than
   * conveniences:
   *
   *   - The host is a `utilityProcess`. Not `child_process`, not a re-launch of the packaged
   *     binary with `ELECTRON_RUN_AS_NODE`, and not a worker inside a renderer. Each of those
   *     alternatives would either widen the RunAsNode surface asserted above or put extension
   *     code in the process that owns the DOM and the IPC bridge.
   *   - Consent is per extension and asked before the first process starts. Installing a
   *     package is not permission to run it.
   *   - A crash loop stops. The restart decision comes from one pure function so the policy
   *     has a single definition.
   *   - The worker reaches nothing directly: no Electron, no renderer, no ipcRenderer. Its
   *     only outward path is the validated request set.
   */
  const marketplaceHostSource = read('apps/desktop/src/main/services/marketplaceHost.ts');
  const hostWorkerSource = read('apps/desktop/src/main/extensionHostWorker.ts');
  // Comments stripped: the worker documents the APIs it deliberately does not use, and an
  // assertion that cannot tell prose from code would be satisfied by deleting the explanation.
  const hostWorkerCode = codeOf(hostWorkerSource);
  assert(
    marketplaceHostSource.includes('utilityProcess.fork('),
    'The extension host is not started as a utility process.',
  );
  assert(
    !/ELECTRON_RUN_AS_NODE|process\.execPath|child_process|\bspawn\(/.test(
      codeOf(marketplaceHostSource),
    ),
    'The extension host supervisor gained a second process-launching path.',
  );
  assert(
    marketplaceHostSource.includes('await readHostConsent(record.extensionId)') &&
      /consent === 'denied'/.test(marketplaceHostSource) &&
      /consent === 'unset'/.test(marketplaceHostSource),
    'Extension code can start without a recorded consent decision.',
  );
  assert(
    /full privileges/.test(marketplaceHostSource),
    'The consent prompt does not state the privilege being granted.',
  );
  const hostPolicySource = read('apps/desktop/src/common/vscodeHost.ts');
  assert(
    marketplaceHostSource.includes('decideCrashResponse(') &&
      /export const CRASH_LIMIT = 3;/.test(hostPolicySource) &&
      /export function decideCrashResponse\(/.test(hostPolicySource),
    'The crash policy is not a single pure decision the supervisor defers to.',
  );
  assert(
    marketplaceHostSource.includes('disabled-after-crashes') &&
      marketplaceHostSource.includes('IPC.hostCrashLoop'),
    'A crash loop neither stops nor reaches the user.',
  );
  assert(
    marketplaceHostSource.includes('validateHostRequest(message.kind, message.payload)'),
    'Extension host requests are handled without validation.',
  );
  assert(
    /await authorizedPath\(/.test(marketplaceHostSource) &&
      marketplaceHostSource.includes('assertAuthorizedPath'),
    'Extension host file access bypasses path authorization.',
  );
  assert(
    !/require\((['"])electron\1\)|from ['"]electron['"]/.test(hostWorkerCode),
    'The extension host worker imports Electron.',
  );
  assert(
    !/ipcRenderer|BrowserWindow|webContents/.test(hostWorkerCode),
    'The extension host worker can reach the renderer or a window.',
  );
  assert(
    hostWorkerSource.includes("specifier === 'vscode' ? vscodeApi") &&
      hostWorkerSource.includes('is not implemented by AXIOM'),
    'The vscode shim either does not intercept the module or fakes unimplemented members.',
  );
  // Phase 3 gave extensions a real `context.secrets`, so the invariant is no longer "refused"
  // but "reachable only through the broker, namespaced per extension, encrypted at rest".
  assert(
    /request<string \| null>\('secrets\.get'/.test(hostWorkerSource) &&
      !/safeStorage|keytar|readCredential/.test(hostWorkerSource),
    'The extension host worker reaches a secret store other than through the broker.',
  );
  const extensionSecretsSource = read('apps/desktop/src/main/services/extensionSecrets.ts');
  assert(
    /safeStorage\.encryptString\(/.test(extensionSecretsSource) &&
      /safeStorage\.decryptString\(/.test(extensionSecretsSource),
    'Extension secrets are not encrypted at rest by the OS keychain.',
  );
  assert(
    /secretRecordKey\(extensionId, key\)/.test(extensionSecretsSource) &&
      /readExtensionSecret\(record\.extensionId,/.test(marketplaceHostSource) &&
      /writeExtensionSecret\(record\.extensionId,/.test(marketplaceHostSource),
    'An extension can name another extension’s secret.',
  );
  const extensionAuthSource = read('apps/desktop/src/main/services/extensionAuth.ts');
  assert(
    /accessToken/.test(extensionAuthSource) &&
      !/token: session\.accessToken/.test(marketplaceHostSource),
    'An access token is carried into an audit record.',
  );
  const extensionUriSource = read('apps/desktop/src/main/services/extensionUri.ts');
  assert(
    /listen\(0, '127\.0\.0\.1'/.test(extensionUriSource) &&
      /randomBytes\(32\)\.toString\('base64url'\)/.test(extensionUriSource) &&
      /pending\.delete\(token\)/.test(extensionUriSource),
    'The extension OAuth callback is not a single-use loopback URL.',
  );
  assert(
    /An extension can only ask for a callback addressed to itself\./.test(extensionUriSource),
    'One extension can mint a callback that delivers another extension’s OAuth code.',
  );

  const powershellBuild = read('AXIOM EXE/build-axiom-exe.ps1');
  const cmdBuild = read('AXIOM EXE/build-axiom-exe.cmd');
  const workflow = read('.github/workflows/build-installers.yml');
  const buildPrompt = read('AXIOM EXE/GEMINI_BUILD_PROMPT.md');
  const githubValidator = read('apps/desktop/scripts/validate-github-scm.cjs');
  const operationalReleaseText = [powershellBuild, cmdBuild, workflow, buildPrompt].join('\n');
  assert(
    !/x64\s*\+\s*arm64|both \.exe files/i.test(operationalReleaseText),
    'An operational build path still claims ARM64 output.',
  );
  assert(
    !/code signing \(optional\)/i.test(operationalReleaseText),
    'An operational build path still treats public signing as optional.',
  );
  assert(/npm\.cmd ci/.test(powershellBuild), 'PowerShell build does not use npm ci.');
  assert(
    !/npm\.cmd install|npx(?:\.cmd)?\s+--yes|--no-save/i.test(powershellBuild),
    'PowerShell build resolves unpinned dependencies.',
  );
  assert(
    /-AllowUnsigned/.test(powershellBuild) && /Signing identity is absent/.test(powershellBuild),
    'Unsigned PowerShell packaging is not explicit and fail-closed.',
  );

  assert(
    powershellBuild.includes('validate:god-mode') && workflow.includes('validate:god-mode'),
    'God Mode validation is not mandatory in both local and CI release paths.',
  );

  assert(
    /powershell\.exe/i.test(cmdBuild) && !/\bnpm\b|\bnpx\b|electron-builder/i.test(cmdBuild),
    'CMD build path does not delegate exclusively to PowerShell.',
  );
  assert(/run:\s*npm ci/.test(workflow), 'CI does not install from the lockfile.');
  assert(
    !/run:\s*npm install\b|npx\s+--yes|--no-save/i.test(workflow),
    'CI resolves unpinned build dependencies.',
  );
  assert(
    (workflow.match(/CSC_LINK:\s*\$\{\{ secrets\.CSC_LINK \}\}/g) || []).length === 2 &&
      (workflow.match(/CSC_KEY_PASSWORD:\s*\$\{\{ secrets\.CSC_KEY_PASSWORD \}\}/g) || [])
        .length === 2,
    'CI does not fail closed with protected signing credentials in both dedicated boundaries.',
  );
  for (const pinnedAction of [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]) {
    assert(workflow.includes(pinnedAction), `CI action is not immutable: ${pinnedAction}`);
  }
  assert(
    !/uses:\s*actions\/[^@\s]+@v\d/i.test(workflow),
    'CI retains a mutable major-version action tag.',
  );
  assert(!/arch:\s*arm64|--arm64/i.test(workflow), 'CI still contains an ARM64 target.');
  assert(!/latest\.yml/i.test(workflow), 'CI still publishes generic latest.yml metadata.');
  assert(
    read('rust-toolchain.toml').includes('channel = "1.96.1"'),
    'Rust release toolchain is not exactly pinned.',
  );
  assert(
    !githubValidator.includes("fs.existsSync(path.join(root, 'process.env.GITHUB_CLIENT_SECRET'))"),
    'GitHub validation still requires the ignored credential artifact to exist.',
  );

  const security = read('SECURITY.md');
  const architecture = read('docs/security-architecture.md');
  const release = read('docs/release-hardening.md');
  const signingGuides = [
    read('apps/desktop/build/README.md'),
    read('AXIOM EXE/README.md'),
    read('AXIOM EXE/BUILD.md'),
    read('AXIOM EXE/GEMINI_BUILD_PROMPT.md'),
    release,
    read('docs/PROGRESS.md'),
  ];
  for (const guide of signingGuides) {
    for (const input of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'AXIOM_SIGNER_SHA1',
      'AXIOM_SIGNER_SUBJECT',
    ]) {
      assert(guide.includes(input), `Signed release guide omits ${input}.`);
    }
    assert(
      /npm package\s+commands\s+(?:never sign|are always unsigned|remain unsigned)/i.test(guide) &&
        /build-axiom-exe\.ps1/i.test(guide),
      'Release guide does not distinguish unsigned npm packaging from the dedicated signer.',
    );
  }
  for (const [document, claims] of [
    [
      security,
      [
        /reporting a vulnerability/i,
        /Device Flow/i,
        /public client ID/i,
        /safeStorage/i,
        /hashes alone do not establish publisher authenticity/i,
      ],
    ],
    [
      architecture,
      [
        /Main is the authority/i,
        /Preload is a narrow bridge/i,
        /Renderer is untrusted/i,
        /Workspace trust/i,
        /Safe Edit/i,
        /dirty-buffer/i,
        /Approvals and cancellation/i,
        /askpass/i,
        /bundled language-server CLIs/i,
        /executable extension entry points are rejected/i,
        /broader same-user local execution surface/i,
        /Git remote/i,
        /CSP/i,
        /IPC/i,
        /SHA-256/i,
        /userData/i,
        /local administrator/i,
      ],
    ],
    [
      release,
      [
        /clean checkout/i,
        /Electron.*33\.2\.0/i,
        /no.*\.map/i,
        /revoke\/rotate/i,
        /code-sign/i,
        /certificate/i,
        /timestamp/i,
        /fuse wire/i,
        /ElectronAsar/i,
        /SHA-256 sidecars/i,
        /clean supported Windows/i,
        /update metadata/i,
        /SBOM/i,
        /logo/i,
        /checksums, not signatures/i,
        /operation-scoped Git askpass and bundled language-server CLIs/i,
        /executable extension entry points remain disabled/i,
        /broader same-user local execution surface/i,
        /ASAR\/minification do not hide code/i,
        /local administrator compromise is out of scope/i,
      ],
    ],
  ]) {
    for (const claim of claims)
      assert(claim.test(document), `Required documentation claim missing: ${claim}`);
  }
}

/**
 * Phase 4 — webview isolation.
 *
 * A webview is the only place third-party HTML runs inside AXIOM, so the properties asserted
 * here are the ones that keep it web content: its own origin, a sandbox that cannot navigate or
 * pop out of the workbench, a CSP floor that only ever removes capability, filesystem access
 * bounded by `localResourceRoots`, and no preload, `require`, `process` or Electron object
 * reachable from the frame.
 */
function validateWebviewIsolation() {
  const webview = loadTypeScript('apps/desktop/src/common/vscodeWebview.ts');
  const token = 'ab'.repeat(16);

  // --- Frame isolation -----------------------------------------------------
  const sandbox = webview.webviewSandboxAttribute({ enableScripts: true, enableForms: true });
  for (const capability of [
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-modals',
    'allow-downloads',
    'allow-presentation',
    'allow-orientation-lock',
  ]) {
    assert(!sandbox.includes(capability), `Webview sandbox must never grant ${capability}.`);
  }
  assert(
    sandbox.startsWith('allow-same-origin'),
    'Webview frames need a real origin, or `event.origin` cannot distinguish them.',
  );
  assert(
    !webview
      .webviewSandboxAttribute({ enableScripts: false, enableForms: false })
      .includes('allow-scripts'),
    'A webview that did not ask for scripts must not be able to run them.',
  );
  for (const feature of ['camera', 'microphone', 'geolocation', 'display-capture', 'usb']) {
    assert(
      new RegExp(`${feature}=\\(\\)`).test(webview.WEBVIEW_PERMISSIONS_POLICY),
      `Webview permissions policy must deny ${feature}.`,
    );
  }

  // --- CSP floor -----------------------------------------------------------
  const csp = webview.webviewDocumentCsp({
    token,
    enableScripts: true,
    enableForms: false,
    workbenchOrigin: 'axiom-app://workbench',
  });
  for (const directive of [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    'frame-ancestors axiom-app://workbench',
  ]) {
    assert(csp.includes(directive), `Webview CSP floor is missing ${directive}.`);
  }
  assert(
    !/nonce-/.test(csp),
    'A header nonce would disable the extension’s own inline scripts; the nonce belongs in the document CSP.',
  );
  assert(
    webview
      .webviewDocumentCsp({
        token,
        enableScripts: false,
        enableForms: false,
        workbenchOrigin: 'axiom-app://workbench',
      })
      .includes("script-src 'none'"),
    'enableScripts:false must be enforced in the header, where the document cannot reverse it.',
  );
  assert(
    webview.patchCspValue("script-src 'unsafe-inline'", 'n'.repeat(32)) ===
      "script-src 'unsafe-inline'",
    'Patching must never weaken or silently break an extension-authored policy.',
  );

  // --- Filesystem containment ---------------------------------------------
  assert(
    !webview.isPathInsideRoots('/ext/media/logo.png', [], false),
    'A webview with no roots must reach no files at all.',
  );
  assert(
    !webview.isPathInsideRoots('/ext/media-secrets/token', ['/ext/media'], false),
    'Root containment must be a separator boundary, not a string prefix.',
  );
  assert(
    !webview.isPathInsideRoots('/ext/media/../../etc/passwd', ['/ext/media'], false),
    'Traversal must be resolved before containment is decided.',
  );
  assert(
    webview.parseWebviewUrl(`axiom-webview://${token}/vscode-resource/`) === null &&
      webview.parseWebviewUrl(`axiom-webview://${token}/index.html?x=1`) === null &&
      webview.parseWebviewUrl(`axiom-webview://user:pw@${token}/index.html`) === null,
    'The webview origin must not behave like a general-purpose file server.',
  );

  // --- Nothing privileged reaches the frame -------------------------------
  const document = webview.rewriteWebviewHtml('<html><head></head><body></body></html>', {
    token,
    handle: 'c'.repeat(16),
    nonce: 'd'.repeat(32),
    workbenchOrigin: 'axiom-app://workbench',
    themeKind: 'dark',
    themeVariables: {},
    codiconFontUrl: null,
    state: null,
    enableCommandUris: false,
  });
  for (const forbidden of [
    'require(',
    'process.',
    'nodeIntegration',
    'contextIsolation',
    'ipcRenderer',
    'electron',
    'webFrame',
  ]) {
    assert(
      !document.includes(forbidden),
      `Injected webview bootstrap must not expose ${forbidden} to extension HTML.`,
    );
  }
  assert(
    !/postMessage\([^)]*['"]\*['"]\s*\)/.test(document),
    'The bootstrap must post to the workbench origin, never to `*`.',
  );
  assert(
    document.includes('acquireVsCodeApi'),
    'The bootstrap must supply the one API a webview is allowed.',
  );

  // --- Wiring in Main and the renderer ------------------------------------
  const windowSource = read('apps/desktop/src/main/window.ts');
  assert(
    /scheme:\s*WEBVIEW_SCHEME/.test(windowSource) && /standard:\s*true/.test(windowSource),
    'The webview scheme must be registered as standard, or every webview shares one origin.',
  );
  assert(
    !/scheme:\s*WEBVIEW_SCHEME[\s\S]{0,400}corsEnabled/.test(windowSource),
    'Webview resources must not be fetchable cross-origin.',
  );
  const service = read('apps/desktop/src/main/services/extensionWebview.ts');
  assert(
    /randomBytes\(16\)\.toString\('hex'\)/.test(service) &&
      /randomBytes\(20\)\.toString\('base64url'\)/.test(service),
    'Webview tokens and nonces must come from a cryptographic source.',
  );
  assert(
    /isPathInsideRoots\(/.test(service) && /'x-content-type-options':\s*'nosniff'/.test(service),
    'Resource serving must enforce roots and refuse MIME sniffing.',
  );
  assert(
    /nodeIntegration|preload:/.test(service) === false,
    'The webview service must not attach a preload or Node integration to webview content.',
  );
  const layer = read('apps/desktop/src/renderer/src/workbench/WebviewLayer.tsx');
  assert(
    /event\.origin !== snapshot\.origin/.test(layer) &&
      /frame\.contentWindow === source/.test(layer) &&
      /parseWebviewFrameMessage\(event\.data, handle\) === null/.test(layer),
    'The renderer must check source, origin and envelope before forwarding a frame message.',
  );
  assert(
    /postMessage\(envelope, snapshot\.origin\)/.test(layer),
    'Host→frame messages must be targeted at the webview’s own origin.',
  );
  assert(
    /sandbox=\{item\.sandbox\}/.test(layer) && /allow=\{WEBVIEW_PERMISSIONS_POLICY\}/.test(layer),
    'Webview iframes must carry the sandbox and permissions policy the runtime derived.',
  );
  const mainSource = read('apps/desktop/src/main/index.ts');
  assert(
    /startsWith\(`\$\{WEBVIEW_SCHEME\}:`\)/.test(mainSource),
    'The workbench CSP must not overwrite a webview’s per-origin policy.',
  );
}

/**
 * Phase 5 — the contributed workbench.
 *
 * The workbench draws data an extension authored: tree labels, menu titles, welcome markdown,
 * icon paths. Four properties have to hold for that to be safe, and each is asserted against the
 * shipping source rather than a description of it:
 *
 *   1. A `when` clause is parsed, never executed — no `eval`, no `Function`, in any file on the
 *      path from a manifest string to a visible menu item.
 *   2. Extension text is rendered as text. React escapes by default, so the property to assert is
 *      that nothing on this path opts out of that with `dangerouslySetInnerHTML`.
 *   3. A command reached from a menu or a tree row is checked against the freshly resolved menu,
 *      so a manifest cannot name a command the user never granted and have it run.
 *   4. A tree provider's UI has no Node reach: the renderer files that draw contributed views
 *      import no Node builtin, and icons cross the boundary as data URLs read by Main from
 *      inside the extension's own directory.
 */
function validateWorkbenchContributions() {
  const parser = read('apps/desktop/src/common/contextKeyExpr.ts');
  assert(
    !/\beval\s*\(|new\s+Function\s*\(/.test(parser),
    'The when-clause engine must not evaluate code — it is a parser over a hostile string.',
  );
  assert(
    /function parseContextKeyExpression/.test(parser) && /MAX_DEPTH/.test(parser),
    'Clause parsing must be bounded, or a nested clause is a stack overflow.',
  );
  const phase5 = [
    'apps/desktop/src/common/vscodeContextKeys.ts',
    'apps/desktop/src/common/vscodeMenus.ts',
    'apps/desktop/src/common/vscodeTree.ts',
    'apps/desktop/src/common/vscodeViews.ts',
    'apps/desktop/src/main/services/extensionViews.ts',
    'apps/desktop/src/renderer/src/workbench/ContributedViews.tsx',
    'apps/desktop/src/renderer/src/workbench/TreeView.tsx',
    'apps/desktop/src/renderer/src/workbench/TreeItem.tsx',
  ];
  for (const relative of phase5) {
    const source = read(relative);
    assert(!/\beval\s*\(/.test(source), `${relative} must not call eval().`);
    assert(!/new\s+Function\s*\(/.test(source), `${relative} must not build a function from text.`);
    assert(
      !/dangerouslySetInnerHTML/.test(source),
      `${relative} must not set raw HTML: extension-authored text is rendered as text.`,
    );
  }
  for (const relative of phase5.filter((entry) => entry.includes('/renderer/'))) {
    const source = read(relative);
    assert(
      !/require\(|from '(node:|fs|path|child_process|electron)'/.test(source),
      `${relative} must not reach a Node or Electron module — contributed views run in the sandboxed window.`,
    );
  }
  const views = read('apps/desktop/src/main/services/extensionViews.ts');
  assert(
    /function runMenuCommand/.test(views),
    'Menu invocation must have one entry point, so the id can be checked in one place.',
  );
  assert(
    /resolveMenu\(/.test(views) &&
      /resolveMenuFor\(location[\s\S]{0,400}find\(\(item\)[\s\S]{0,120}item\.command === command/.test(
        views,
      ),
    'A menu command must be checked against the freshly resolved menu before it runs.',
  );
  assert(
    /WORKBENCH_OWNED_CONTEXT_KEYS|isWorkbenchOwnedContextKey|applyWorkbench/.test(views),
    'The workbench half of the context store must be owned by the workbench, not writable by an extension.',
  );
  assert(
    /data:image\/|toString\('base64'\)/.test(views),
    'Contributed icons must cross the boundary as data URLs rather than as filesystem paths.',
  );
  assert(
    /isPathInside|resolveIcon|path\.resolve/.test(views),
    'An icon path from a manifest must be resolved inside the extension directory before it is read.',
  );
  const keys = read('apps/desktop/src/common/vscodeContextKeys.ts');
  assert(
    /'__proto__'/.test(keys) && /new Map</.test(keys),
    'The context store must refuse prototype keys and must not be a plain object.',
  );
  assert(
    /Object\.create\(null\)/.test(keys),
    'The snapshot handed to clause evaluation must have no prototype.',
  );
  const tree = read('apps/desktop/src/common/vscodeTree.ts');
  assert(
    /COMMAND_ID_RE/.test(tree) && /sanitizeCommandArguments/.test(tree),
    'A tree item command id and its arguments must be validated before they can be invoked.',
  );
  assert(
    /MAX_TREE_NODES|MAX_TREE_CHILDREN/.test(tree),
    'A tree provider must not be able to grow the model without bound.',
  );
}

/**
 * The language platform's security posture (Phase 6).
 *
 * A language provider is the most privileged untrusted thing in the editor: it is asked about the
 * file the user is looking at on every keystroke, its answers are rendered as markdown, and one of
 * them — a `WorkspaceEdit` — writes to disk. So the four properties asserted here are the ones that
 * keep that from being a hole: markdown never renders HTML or an executable link, every URI is
 * parsed and bounded before it is trusted, every write is checked against the live workspace roots
 * before a file is touched, and a provider's result is data on the wire rather than a live object.
 */
function validateLanguagePlatformSecurity() {
  const wire = read('apps/desktop/src/common/vscodeLanguageWire.ts');
  const edits = read('apps/desktop/src/common/vscodeWorkspaceEdit.ts');
  const service = read('apps/desktop/src/main/services/extensionLanguages.ts');
  const worker = read('apps/desktop/src/main/extensionHostWorker.ts');
  const phase6 = [
    'apps/desktop/src/common/vscodeLanguageWire.ts',
    'apps/desktop/src/common/vscodeLanguages.ts',
    'apps/desktop/src/common/vscodeDocumentSync.ts',
    'apps/desktop/src/common/vscodeSemanticTokens.ts',
    'apps/desktop/src/common/vscodeWorkspaceEdit.ts',
    'apps/desktop/src/main/services/extensionLanguages.ts',
    'apps/desktop/src/renderer/src/editor/extensionProviders.ts',
    'apps/desktop/src/renderer/src/editor/extensionLanguageClient.ts',
    'apps/desktop/src/renderer/src/editor/extensionLanguageConvert.ts',
  ];
  for (const relative of phase6) {
    const source = read(relative);
    assert(!/\beval\s*\(/.test(source), `${relative} must not call eval().`);
    assert(!/new\s+Function\s*\(/.test(source), `${relative} must not build a function from text.`);
    assert(
      !/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(source),
      `${relative} must not set raw HTML from a provider result.`,
    );
    assert(
      !/new RegExp\([^)]*(pattern|wordPattern|source)/.test(source) ||
        /function safeRegExp|try \{/.test(source),
      `${relative} must not compile an extension-supplied pattern without a guard.`,
    );
  }
  for (const relative of phase6.filter((entry) => entry.includes('/renderer/'))) {
    const source = read(relative);
    assert(
      !/require\(|from '(node:|fs|path|child_process|electron)'/.test(source),
      `${relative} must not reach a Node or Electron module — the bridge runs in the sandboxed window.`,
    );
  }
  assert(
    /export function sanitizeMarkdown\(/.test(wire) &&
      /const HTML_TAG_RE = /.test(wire) &&
      /const HTML_COMMENT_RE = /.test(wire),
    'Markdown from an extension must be sanitised centrally, with HTML tags and comments stripped outside code fences.',
  );
  assert(
    !/supportHtml\s*:/.test(wire),
    'The wire layer must never set supportHtml — an HTML-rendering hover is a script gadget.',
  );
  assert(
    !/supportHtml\s*:/.test(
      read('apps/desktop/src/renderer/src/editor/extensionLanguageConvert.ts'),
    ),
    'The renderer must not enable HTML in a markdown string built from a provider result.',
  );
  assert(
    /isTrusted:\s*commands !== undefined && commands\.length > 0 \? \{ enabledCommands: commands \} : false,/.test(
      read('apps/desktop/src/renderer/src/editor/extensionLanguageConvert.ts'),
    ),
    'Markdown trust must be granted as an explicit command allow-list, never as `isTrusted: true`.',
  );
  assert(
    /const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set\(\['http', 'https', 'mailto', 'file'\]\)/.test(
      wire,
    ),
    'Only four link schemes may survive sanitisation; anything else is unlinked.',
  );
  assert(
    /if \(scheme === 'command'\) \{\s*if \(!allowCommands\) return null;/.test(wire) &&
      /COMMAND_ID_RE\.test\(id\)/.test(wire),
    'A `command:` link must be opt-in, syntactically valid, and recorded so only that id is enabled.',
  );
  assert(
    /const MAX_URI_LENGTH = \d+;/.test(wire) && /const MAX_MARKDOWN = /.test(wire),
    'URIs and markdown must be length-bounded before they cross the boundary.',
  );
  assert(
    /const LINK_SCHEMES: ReadonlySet<string> = new Set\(\[/.test(wire) &&
      /const target = toWireUri\(source\.target, LINK_SCHEMES\);/.test(wire),
    'A document link target must be parsed against an allow-list of schemes, so `javascript:` never reaches Monaco.',
  );
  assert(
    /export const EDITABLE_SCHEMES: ReadonlySet<string> = new Set\(\['file', 'untitled'\]\);/.test(
      edits,
    ),
    'Only `file:` and `untitled:` documents may be written by an extension edit.',
  );
  assert(
    /return isPathInsideRoots\(fsPath, policy\.roots, policy\.caseInsensitive\);/.test(edits),
    'Every written path must be proven inside a workspace root, on the same containment helper the webview layer uses.',
  );
  assert(
    /if \(path\.includes\('\\0'\)\) return null;/.test(edits) &&
      /path = decodeURIComponent\(path\);/.test(edits) &&
      /\} catch \{\s*return null;/.test(edits),
    'A URI is decoded before containment is judged, and a NUL byte or an undecodable URI is refused rather than guessed at.',
  );
  assert(
    /const validation = validateWorkspaceEdit\(edit, \{\s*roots: host\.workspaceRoots\(\),/.test(
      service,
    ),
    'Edit policy is evaluated against the live workspace roots at apply time, not a cached list.',
  );
  assert(
    /if \(!validation\.ok\) \{[\s\S]{0,240}return false;/.test(service),
    'A refused edit is refused whole — no entry is applied before the decision is made.',
  );
  assert(
    /export const MAX_WORKSPACE_EDIT_ENTRIES|MAX_TEXT_EDITS_PER_FILE|MAX_WORKSPACE_EDIT_TOTAL_EDITS/.test(
      edits,
    ) && /export const MAX_CREATED_FILE_BYTES = /.test(edits),
    'A workspace edit is bounded in entries, edits and created-file size, so one provider cannot rewrite the disk.',
  );
  assert(
    /textEditsOverlap|'overlapping-edits'/.test(edits),
    'Overlapping edits are rejected rather than applied in an order that corrupts the file.',
  );
  assert(
    /value: normalizeProviderResult\(\s*record\.feature,/.test(worker),
    'Every provider result is normalised in the worker before it is posted — a live object never crosses the boundary.',
  );
  assert(
    /\} catch \(error\) \{\s*fail\(errorMessage\(error\)\);/.test(worker),
    'A provider that throws becomes a failure message, not an unhandled rejection that takes the host down.',
  );
  assert(
    /const MAX_CONCURRENT_PROVIDER_CALLS = \d+;/.test(worker) &&
      /if \(providerCalls\.size >= MAX_CONCURRENT_PROVIDER_CALLS\) \{/.test(worker),
    'Concurrent provider calls are capped, so a fast typist cannot exhaust the host through an extension.',
  );
  assert(
    /if \(!workerProviders\.delete\(handle\)\) return;[\s\S]{0,420}entry\.source\.cancel\(\);/.test(
      worker,
    ),
    'Disposing a provider cancels its in-flight calls, so a disposed provider is never called again nor left computing.',
  );
  assert(
    /void request\('languages\.unregisterProvider', \{ handle \}\)/.test(worker),
    'Disposal is mirrored to Main, so the editor stops routing requests to a provider the extension has dropped.',
  );
  assert(
    /providers\.removeExtension\(extensionId\);/.test(service),
    'An unloaded or crashed extension has every provider removed, making a crash and a clean deactivate equivalent.',
  );
  assert(
    /export function cancelLanguageRequest\(requestId: number\): boolean \{/.test(service) &&
      /t: 'languageCancel', id: call\.workerId/.test(service),
    'Cancellation reaches every worker the request fanned out to, by invocation id rather than by extension.',
  );
  assert(
    /if \(source\.token\.isCancellationRequested\) \{\s*fail\('The request was cancelled\.'\);/.test(
      worker,
    ),
    'A cancelled request cannot deliver a result, so a slow provider cannot overwrite what the user is now looking at.',
  );
  assert(
    /finally \{\s*providerCalls\.delete\(message\.id\);\s*source\.dispose\(\);/.test(worker),
    'Cancellation state is released on every path, cancelled or not, so a long session accumulates no token sources.',
  );
  assert(
    /const languagesNamespace = strictNamespace\('languages', \{/.test(worker),
    'The `languages` namespace is strict: an API the shim does not implement throws instead of silently doing nothing.',
  );
}

function validatePhase7RuntimeSecurity() {
  const terminals = read('apps/desktop/src/main/services/extensionTerminals.ts');
  const tasks = read('apps/desktop/src/main/services/extensionTasks.ts');
  const debug = read('apps/desktop/src/main/services/extensionDebug.ts');
  const fileEvents = read('apps/desktop/src/main/services/extensionFileEvents.ts');
  const phase7 = [
    'apps/desktop/src/common/vscodeTerminalRuntime.ts',
    'apps/desktop/src/common/vscodeTaskRuntime.ts',
    'apps/desktop/src/common/vscodeDebugRuntime.ts',
    'apps/desktop/src/common/vscodeFileWatch.ts',
    'apps/desktop/src/main/services/extensionTerminals.ts',
    'apps/desktop/src/main/services/extensionTasks.ts',
    'apps/desktop/src/main/services/extensionDebug.ts',
    'apps/desktop/src/main/services/extensionFileEvents.ts',
    'apps/desktop/src/renderer/src/state/extensionTerminalBus.ts',
  ];
  for (const relative of phase7) {
    const source = read(relative);
    assert(!/\beval\s*\(/.test(source), `${relative} must not call eval().`);
    assert(!/new\s+Function\s*\(/.test(source), `${relative} must not build a function from text.`);
    assert(
      !/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(source),
      `${relative} must not set raw HTML from an extension-supplied value.`,
    );
  }
  for (const relative of phase7.filter((entry) => entry.includes('/renderer/'))) {
    const source = read(relative);
    assert(
      !/require\(|from '(node:|fs|path|child_process|electron)'/.test(source),
      `${relative} must not reach a Node or Electron module — the terminal bus runs in the sandboxed window.`,
    );
  }

  // Terminal isolation.
  assert(
    /function owned\(extensionId: string, handle: number\): TerminalRecord \{[\s\S]*?record\.extensionId !== extensionId[\s\S]*?That terminal does not belong to this extension\./.test(
      terminals,
    ),
    'Every terminal request must re-check ownership against the handle, so a guessed handle cannot type into another extension’s shell.',
  );
  assert(
    /const SHELL_IDS: Readonly<Record<string, string>> = \{/.test(terminals) &&
      /return SHELL_IDS\[name\] \?\? '';/.test(terminals),
    'A `shellPath` must resolve through a closed set of shell ids, never spawn the binary an extension named.',
  );
  assert(
    /cwd = await assertAuthorizedPath\(request\.cwd, \{ directory: true \}\)/.test(terminals),
    'A terminal `cwd` must be authorised against the workspace before any pane is created.',
  );
  assert(
    /if \(request\.splitParent !== null\) \{[\s\S]*?owned\(extensionId, request\.splitParent\);/.test(
      terminals,
    ),
    'Splitting must be authorised against a pane the same extension owns, or one extension could place a pane inside another’s.',
  );
  // Task execution.
  assert(
    /const cwd = await resolveTaskCwd\(task, host\.workspaceRoots\(\)\);\s*await assertWorkspaceTrusted\(cwd\);/.test(
      tasks,
    ),
    'A task must resolve its working directory inside the workspace and clear the trust gate before anything is spawned.',
  );
  assert(
    /if \(requested !== null\) return assertAuthorizedPath\(requested, \{ directory: true \}\);/.test(
      tasks,
    ),
    'A task `cwd` an extension names must be authorised, not taken on trust.',
  );
  assert(
    /const argv = renderProcessArgv\(execution\);\s*child = spawn\(argv\[0\] \?\? '', argv\.slice\(1\), \{[\s\S]*?shell: false,/.test(
      tasks,
    ),
    'A ProcessExecution must spawn its argv directly with `shell: false`, so an argument containing `&&` or `;` stays one argument.',
  );
  assert(
    /spawn\(shell, \[\.\.\.execution\.shellArgs, commandLine\], \{[\s\S]*?shell: false,/.test(
      tasks,
    ),
    'A ShellExecution with a pinned shell must pass the command line as one argument to that shell rather than through a second implicit shell.',
  );
  assert(
    /windowsHide: true,/.test(tasks),
    'A task process must not flash a console window on Windows.',
  );

  // DAP transport.
  assert(
    /const child = spawn\(descriptor\.command, \[\.\.\.descriptor\.args\], \{[\s\S]*?shell: false,/.test(
      debug,
    ),
    'A debug adapter must be spawned with `shell: false` and an explicit argv — a command line assembled for a shell would be injectable.',
  );
  assert(
    /connect\(\{ host: descriptor\.host \?\? '127\.0\.0\.1', port: descriptor\.port \?\? 0 \}\)/.test(
      debug,
    ),
    'A server adapter must be reached on the loopback address only; a descriptor may not name a remote host.',
  );
  assert(
    /const checked = validateOutboundDapMessage\(raw\);/.test(debug),
    'Every message the extension sends towards an adapter must be validated and size-checked before it reaches the wire.',
  );
  assert(
    /const result = reader\.push\(chunk\);[\s\S]*?if \(reader\.isClosed\) endSession\(sessionId, 'The debug adapter protocol stream is unusable\.'\);/.test(
      debug,
    ),
    'Adapter output must be framed by the byte-counted reader, and an unreadable stream must end the session rather than be re-synchronised blindly.',
  );
  assert(
    /if \(inflight\.size >= MAX_DAP_PENDING\) \{/.test(debug),
    'In-flight DAP requests must be bounded per session.',
  );
  // Filesystem watching.
  const watch = read('apps/desktop/src/common/vscodeFileWatch.ts');
  assert(
    /const spec = watchers\.register\(extensionId, request, host\.workspaceRoots\(\)\);/.test(
      fileEvents,
    ),
    'A watcher must be registered against the current workspace roots, so its base is decided by the workspace rather than by the extension.',
  );
  assert(
    /throw new Error\('A file system watcher must be rooted inside the workspace\.'\)/.test(watch),
    'A watcher rooted outside every workspace root must be refused outright, not silently re-rooted.',
  );
  assert(
    /if \(!isInsideRoot\(spec\.base, path\)\) return false;/.test(watch),
    'Every candidate event must clear the base boundary before the glob is even consulted, so a path outside the watched directory can never be delivered.',
  );
  assert(
    /function mainToken\(extensionId: string, workerToken: number\): number \| null \{[\s\S]*?owner\.extensionId === extensionId && owner\.workerToken === workerToken/.test(
      fileEvents,
    ),
    'A watcher handle must be resolved within the owning extension’s registrations only, so a guessed handle finds nothing to dispose.',
  );
  assert(
    /const owner = workerTokens\.get\(delivery\.token\);\s*if \(owner === undefined\) continue;/.test(
      fileEvents,
    ),
    'An event may only be delivered against a live token, so a watcher disposed mid-burst receives nothing further.',
  );
  assert(
    /if \(this\.specs\.size >= MAX_WATCHERS\)/.test(watch) &&
      /if \(this\.countFor\(extensionId\) >= MAX_WATCHERS_PER_EXTENSION\)/.test(watch),
    'Watchers must be bounded both globally and per extension, so no extension can exhaust the OS watch descriptors.',
  );

  // Workspace runtime events and `workspace.fs`.
  assert(
    /kind === 'rename'\s*\? await assertAuthorizedMutationPath\(source\)\s*: await assertAuthorizedPath\(source\)/.test(
      fileEvents,
    ),
    'A rename source must clear the mutation check, which refuses a symlink — renaming a link must move the link, not its target outside the workspace.',
  );
  assert(
    /const to = await assertAuthorizedPath\(target, \{ allowMissing: true \}\);/.test(fileEvents),
    'A copy or rename target must be authorised inside the workspace even though it does not exist yet.',
  );
  assert(
    /await appendAudit\(\s*`extension\.host\.\$\{kind\}`/.test(fileEvents),
    'Every extension-driven copy and rename must be written to the audit log.',
  );
  assert(
    /if \(!overwrite && \(await exists\(to\)\)\) throw new Error\('The target already exists\.'\);/.test(
      fileEvents,
    ),
    'A copy or rename must not overwrite an existing file unless the extension asked for it.',
  );
  // Permission gating and the renderer-facing IPC surface.
  const host = read('apps/desktop/src/common/vscodeHost.ts');
  const ipc = read('apps/desktop/src/main/ipc.ts');
  for (const kind of [
    'terminal.create',
    'terminal.sendText',
    'tasks.execute',
    'debug.start',
    'workspace.copyFile',
    'workspace.renameFile',
  ]) {
    assert(
      new RegExp(
        `EFFECTFUL_REQUEST_KINDS: readonly HostRequestKind\\[\\] = \\[[\\s\\S]*?'${kind.replace('.', '\\.')}',[\\s\\S]*?\\];`,
      ).test(host),
      `${kind} must be declared effectful, so it is audited and consented like a file write.`,
    );
  }
  assert(
    /function terminalEventInput\(raw: unknown\): ExtensionTerminalEvent \{\s*const source = assertRecord\(raw, 'event'\);\s*const kind = assertString\(source\.kind, 'kind'\);\s*if \(!TERMINAL_EVENT_KINDS\.has\(kind\)\)/.test(
      ipc,
    ),
    'The one report channel the renderer may call must validate its payload shape and reject an unknown event kind.',
  );
  assert(
    /\.\.\.\(typeof source\.data === 'string' \? \{ data: source\.data\.slice\(0, 64 \* 1024\) \} : \{\}\),/.test(
      ipc,
    ),
    'Terminal input reported from the renderer must be length-clamped before it reaches an extension.',
  );
  assert(
    /ipcMain\.handle\(IPC\.runtimeTerminals, \(\) => extensionTerminalList\(\)\);/.test(ipc) &&
      /ipcMain\.handle\(IPC\.runtimeTasks, \(\) => extensionTaskList\(\)\);/.test(ipc) &&
      /ipcMain\.handle\(IPC\.runtimeDebugSessions, \(\) => extensionDebugSessionList\(\)\);/.test(
        ipc,
      ),
    'The Phase 7 pull channels must take no argument at all — ownership is read out of the registries in Main, never named by the renderer.',
  );
  assert(
    /ipcMain\.handle\(IPC\.runtimeDebugConsole, \(_event, sessionId: unknown\) =>\s*extensionDebugConsoleLines\(assertString\(sessionId, 'sessionId'\)\.slice\(0, 128\)\),/.test(
      ipc,
    ),
    'The debug console channel must assert and clamp its session id rather than indexing a registry with whatever it was handed.',
  );
}

/**
 * Phase 7 §8 — the language surfaces added on top of Phase 6.
 *
 * Four features answer from AXIOM's own surfaces rather than through a Monaco registration, which
 * means four new paths along which extension-authored data reaches the window: a mint token redeemed
 * back to a provider's object, a hierarchy row, an end-of-line label, and a pushed refresh batch.
 * Each is checked here for the property that makes it safe — the token cannot name another
 * extension's object, the row and the label are text and never markup, and the batch is validated
 * rather than trusted because it crosses preload as `unknown`.
 */
function validatePhase7LanguageSurfaceSecurity() {
  const service = read('apps/desktop/src/main/services/extensionLanguages.ts');
  const worker = read('apps/desktop/src/main/extensionHostWorker.ts');
  const editor = read('apps/desktop/src/renderer/src/editor/EditorPane.tsx');
  const providers = read('apps/desktop/src/renderer/src/editor/extensionProviders.ts');
  const ipc = read('apps/desktop/src/main/ipc.ts');
  const preload = read('apps/desktop/src/preload/index.ts');
  const pure = [
    'apps/desktop/src/common/hierarchyTree.ts',
    'apps/desktop/src/common/inlineValues.ts',
    'apps/desktop/src/common/vscodeProviderEvents.ts',
    'apps/desktop/src/renderer/src/editor/inlineValuesBus.ts',
    'apps/desktop/src/renderer/src/editor/hierarchyBus.ts',
    'apps/desktop/src/renderer/src/workbench/HierarchyView.tsx',
    'apps/desktop/src/renderer/src/workbench/PaletteHost.tsx',
  ];
  for (const relative of pure) {
    const source = read(relative);
    assert(!/\beval\s*\(/.test(source), `${relative} must not call eval().`);
    assert(!/new\s+Function\s*\(/.test(source), `${relative} must not build a function from text.`);
    assert(
      !/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(source),
      `${relative} must not render a provider's name, detail or value as HTML.`,
    );
    assert(
      !/require\(|from '(node:|fs|path|child_process|electron)'/.test(source),
      `${relative} must not reach a Node or Electron module — these surfaces run in the sandboxed window.`,
    );
  }
  // Mint tokens: identity across three processes, with no way to name another extension's object.
  assert(
    /function resolveMintedToken\(token: unknown\): MintedRef \| undefined \{\s*if \(typeof token !== 'number' \|\| !Number\.isInteger\(token\)\) return undefined;\s*return mainTokens\.get\(token\);/.test(
      service,
    ),
    'A mint token from the renderer must be validated as an integer and redeemed by map lookup only — never used to index anything else.',
  );
  assert(
    service.includes(
      "if (ref.link.feature !== feature) return { ok: false, error: 'That result is not a ' + feature };",
    ) && service.includes('payload.id = ref.workerToken;'),
    'A token redeemed against the wrong feature must fail, and the id forwarded to a worker must be that worker’s own — a renderer-supplied number must never reach a foreign registry.',
  );
  assert(
    service.includes('const MAX_MAIN_TOKENS = 50_000;') &&
      worker.includes('const MAX_MINTED_VALUES = 20_000;'),
    'Both mint registries must be bounded, so holding a reference to every provider result is not a way to exhaust Main or a host.',
  );
  assert(
    service.includes('forgetTokensFor(link.global);') &&
      service.includes('forgetTokensForExtension(extensionId);'),
    'Disposing a provider and losing a host must drop the tokens they minted, so a later provider cannot inherit reachable numbers.',
  );
  assert(
    service.includes('depth > MAX_REWRITE_DEPTH'),
    'The mint-id rewrite walks a value that arrived from another process, so it must be depth-bounded rather than trusting the wire types.',
  );
  // Inline values: extension text reaching the editor, and the debugger reached on its behalf.
  assert(
    /after: \{ content: `  \$\{decoration\.label\}`, inlineClassName: 'axiom-inline-value' \}/.test(
      editor,
    ),
    'An inline value must be drawn as Monaco injected text, which is rendered as a text node — a provider-supplied label must never become markup.',
  );
  assert(
    /const result = await window\.axiom\.debug\.evaluate\(request\.name, frameId\)/.test(editor) &&
      /if \(request\.kind !== 'expression'\) continue;/.test(editor),
    'Only an InlineValueEvaluatableExpression may reach the debug adapter’s evaluate — a variable lookup is answered from scopes the frame already sent, and a literal reaches nothing.',
  );
  assert(
    /ipcMain\.handle\(IPC\.debugEvaluate, async \(event, expression: unknown, frameId: unknown\) => \{\s*await requireActiveDebug\(event\.sender\);\s*return debugEvaluate\(\s*assertString\(expression, 'expression'\),/.test(
      ipc,
    ),
    'The evaluate channel must require an active debug session owned by that renderer and assert its expression — an inline value must not become a way to evaluate text without a session.',
  );
  assert(
    /ipcMain\.handle\(IPC\.debugScopes, async \(event, frameId: unknown\) => \{\s*await requireActiveDebug\(event\.sender\);/.test(
      ipc,
    ) &&
      /ipcMain\.handle\(IPC\.debugVariables, async \(event, ref: unknown\) => \{\s*await requireActiveDebug\(event\.sender\);/.test(
        ipc,
      ),
    'The scopes and variables reads behind a variable lookup must be gated on session ownership too, not just the evaluate.',
  );
  const inlineValues = read('apps/desktop/src/common/inlineValues.ts');
  assert(
    /export const MAX_INLINE_VALUE_NAME = 128;/.test(inlineValues) &&
      /export const MAX_INLINE_VALUE_TEXT = 64;/.test(inlineValues) &&
      /export const MAX_INLINE_VALUE_LABEL = 240;/.test(inlineValues) &&
      /export const MAX_INLINE_VALUE_REQUESTS = 128;/.test(inlineValues),
    'Every quantity an inline-values provider controls — the name it evaluates, the value drawn, the whole line’s label, the number of lookups — must be capped, so one provider cannot make a stopped frame unusable.',
  );
  assert(
    /\.replace\(\/\[\\r\\n\\t\]\+\/g, ' '\)/.test(inlineValues),
    'A value carrying newlines or tabs must be flattened before it decorates a line — an end-of-line label must not be able to rewrite the layout of the editor.',
  );
  // Hierarchy rows: an extension controls both the shape of the tree and the text in it.
  const hierarchy = read('apps/desktop/src/common/hierarchyTree.ts');
  assert(
    /export const MAX_HIERARCHY_DEPTH = 16;/.test(hierarchy) &&
      /export const MAX_HIERARCHY_CHILDREN = 200;/.test(hierarchy) &&
      /export const MAX_HIERARCHY_NODES = 2_000;/.test(hierarchy),
    'Depth, breadth and total node count must all be bounded — a provider that answers every traversal with its own caller is otherwise a way to exhaust the window.',
  );
  const view = read('apps/desktop/src/renderer/src/workbench/HierarchyView.tsx');
  assert(
    /path = monaco\.Uri\.parse\(item\.uri\)\.fsPath;\s*\} catch \{\s*return null;/.test(view),
    'A hierarchy item’s uri must be parsed defensively — a provider-supplied string that is not a resolvable file must produce no row target rather than an exception.',
  );
  // The pushed refresh batch: unknown at the preload boundary, validated in the window.
  assert(
    /onProviderChanged: \(listener: \(batch: unknown\) => void\): \(\(\) => void\) => \{/.test(
      preload,
    ),
    'The provider-change channel must cross preload as `unknown` — preload has no registry to validate a handle against, so it must not pretend to.',
  );
  assert(
    providers.includes('const batch = normalizeProviderChangeBatch(raw);') &&
      providers.includes('if (batch === null) return;'),
    'The window must validate the pushed batch before turning a handle into a Monaco refresh, and drop a malformed one whole.',
  );
  const events = read('apps/desktop/src/common/vscodeProviderEvents.ts');
  assert(
    /export const MAX_PENDING_PROVIDER_CHANGES = 512;/.test(events) &&
      /export const MAX_CHANGES_PER_WINDOW = 20;/.test(events),
    'A provider firing its change event in a loop must be rate-limited and then dropped at a hard ceiling, so a refresh event cannot become an unbounded stream of IPC.',
  );
  // Workspace symbols: the one place a provider-supplied uri becomes a file the window opens.
  const wire = read('apps/desktop/src/common/vscodeLanguageWire.ts');
  assert(
    /function wireUri\(value: unknown, context: WireContext\): string \| undefined \{\s*return toWireUri\(value, context\.schemes \?\? SAFE_DOCUMENT_SCHEMES\);/.test(
      wire,
    ) && /const uri = wireUri\(source\.uri, context\);/.test(wire),
    'A hierarchy item’s and a workspace symbol’s location must pass the scheme allow-list at the wire boundary, so a `javascript:` or `data:` target never reaches the code that opens a file.',
  );
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'axiom-security-hardening-'));
  try {
    await validateBuildAndHooks(tempRoot);
    validateRuntimePolicies();
    validateLoggingAndUpdater();
    validateSigningIsolation();
    validateOAuthDocsAndIdentity();
    validateWebviewIsolation();
    validateWorkbenchContributions();
    validateLanguagePlatformSecurity();
    validatePhase7RuntimeSecurity();
    validatePhase7LanguageSurfaceSecurity();
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
  console.log('PASS security hardening: bundles, package policy, fuses, and artifact hashes');
  console.log('PASS security hardening: runtime, CSP, navigation, DevTools, and diagnostics');
  console.log(
    'PASS security hardening: logging, updater networking, docs, OAuth, versions, and logo',
  );
  console.log(
    'PASS security hardening: webview origins, sandbox, CSP floor, and resource containment',
  );
  console.log('PASS security hardening: workbench views, menus, trees, and context keys (Phase 5)');
  console.log(
    'PASS security hardening: language providers, markdown sanitisation, URIs, edits, and cancellation (Phase 6)',
  );
  console.log(
    'PASS security hardening: terminal isolation, task execution, DAP transport, file watching, and workspace events (Phase 7)',
  );
  console.log(
    'PASS security hardening: mint-token identity, inline value evaluation, hierarchy bounds, and pushed refresh batches (Phase 7 §8)',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
