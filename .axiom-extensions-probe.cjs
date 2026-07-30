#!/usr/bin/env node
/**
 * Verification probe for the extension manifest reader, semver range evaluator, and
 * VSIX package reader.
 *
 * Two halves, deliberately:
 *
 *   1. Adversarial unit tests. A VSIX arrives before its publisher is proven, so the
 *      reader is exercised with traversal names, symlink entries, bombs, encrypted
 *      entries and junk manifests — the cases that matter are the ones a real package
 *      never contains.
 *
 *   2. Real packages from Open VSX. Synthetic archives prove the guards fire; real
 *      ones prove the reader still accepts the thing it exists to accept. A parser that
 *      passes only its own fixtures has not been tested.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('module');
const ts = require('typescript');

let failures = 0;
const lines = [];
function check(name, ok, detail) {
  lines.push(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function note(text) {
  lines.push(`       ${text}`);
}
/** Read a source file under apps/desktop, for wiring assertions. */
function read(relative) {
  return fs.readFileSync(path.join('apps', 'desktop', relative), 'utf8');
}
function flush() {
  lines.push('', failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`);
  fs.writeFileSync('extensions-probe.txt', `${lines.join('\n')}\n`, 'utf8');
  // Also to stdout: the full report lives in the file, but the verdict and any failures
  // must be readable without depending on a file read landing after the write.
  const verdict = lines.filter((line) => line.startsWith('FAIL') || /^(ALL PASS|FAILURES)/.test(line));
  process.stdout.write(`checks ${lines.filter((l) => /^(PASS|FAIL) /.test(l)).length}\n`);
  process.stdout.write(`${verdict.join('\n')}\n`);
  try {
    fs.rmSync(stubUserData, { recursive: true, force: true });
  } catch {
    // A leftover temporary directory is harmless.
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

// --- TypeScript module loader ------------------------------------------------
// The modules under test are TypeScript and import each other relatively, so they are
// transpiled on demand and cached. `@axiom/shared` is stubbed (logging is not what is
// being tested); `yauzl` resolves to the real installed package, because using a fake
// zip reader would test nothing.
const DESKTOP = path.join('apps', 'desktop');
const cache = new Map();
// The registry service reads a cache directory from Electron's userData. A temporary
// directory stands in, so the probe exercises the real read/write path without touching
// a developer's actual profile.
const stubUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-userdata-'));
const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? stubUserData : os.tmpdir()),
    getVersion: () => '0.0.0',
  },
};
const sharedStub = {
  rootLogger: (() => {
    const noop = () => undefined;
    const child = { info: noop, warn: noop, debug: noop, error: noop, trace: noop };
    child.child = () => child;
    return child;
  })(),
};

function loadTs(relative) {
  const filename = path.resolve(DESKTOP, relative);
  const cached = cache.get(filename);
  if (cached) return cached.exports;
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const wrapper = new Module(filename, null);
  wrapper.filename = filename;
  wrapper.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, wrapper);
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === '@axiom/shared') return sharedStub;
    if (request === 'electron') return electronStub;
    if (request === 'yauzl') {
      return originalLoad.call(this, path.resolve(DESKTOP, 'node_modules', 'yauzl'), parent, isMain);
    }
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [`${resolved}.ts`, path.join(resolved, 'index.ts')]) {
        if (fs.existsSync(candidate)) {
          return loadTs(path.relative(path.resolve(DESKTOP), candidate));
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    wrapper._compile(js, filename);
  } finally {
    Module._load = originalLoad;
  }
  return wrapper.exports;
}

const semver = loadTs('src/common/semverRange.ts');
const manifestModule = loadTs('src/common/vscodeManifest.ts');
const vsix = loadTs('src/main/services/vsix.ts');
const openVsx = loadTs('src/common/openVsx.ts');
const registry = loadTs('src/main/services/openVsxRegistry.ts');

// --- Synthetic zip builder ---------------------------------------------------
// Hand-built so entries can be given properties no packaging tool would produce:
// traversal names, symlink modes, and lying ratios.
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let c = -1;
  for (const byte of buffer) c = (c >>> 8) ^ table[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const raw = file.data ?? Buffer.alloc(0);
    const store = file.store === true;
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((file.madeBy ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((((file.mode ?? 0) << 16) >>> 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

function manifestJson(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      publisher: 'axiom',
      name: 'probe',
      version: '1.0.0',
      displayName: 'Probe',
      engines: { vscode: '^1.90.0' },
      ...overrides,
    }),
    'utf8',
  );
}

async function rejects(label, bytes, expectation) {
  try {
    await vsix.inspectVsix(bytes);
    check(label, false, 'the package was accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, expectation.test(message), message.slice(0, 140));
  }
}

// --- Open VSX helpers --------------------------------------------------------
const ALLOWED_HOSTS = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org']);
async function getFile(rawUrl, accept) {
  let url = rawUrl;
  for (let hop = 0; hop <= 1; hop += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.host)) {
      throw new Error(`refused ${url}`);
    }
    const response = await fetch(url, {
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept },
    });
    if ([301, 302, 307].includes(response.status)) {
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    return response;
  }
  throw new Error('too many redirects');
}

async function main() {
  // =========================================================================
  lines.push('--- semver ranges ---');
  const rangeCases = [
    ['1.96.0', '^1.80.0', true],
    ['1.96.0', '^1.99.0', false],
    ['1.96.0', '>=1.75.0', true],
    ['1.96.0', '>=2.0.0', false],
    ['1.96.0', '*', true],
    ['1.96.0', '', true],
    ['1.96.0', '~1.96.0', true],
    ['1.97.0', '~1.96.0', false],
    ['1.96.0', '1.96.0', true],
    ['1.96.1', '1.96.0', false],
    ['1.96.0', '1.96', true],
    ['1.96.0', '1.x', true],
    ['1.96.0', '>=1.60.0 <2.0.0', true],
    ['2.1.0', '>=1.60.0 <2.0.0', false],
    ['1.96.0', '^1.50.0 || ^2.0.0', true],
    ['2.5.0', '^1.50.0 || ^2.0.0', true],
    ['3.0.0', '^1.50.0 || ^2.0.0', false],
    ['1.70.0', '1.60.0 - 1.80.0', true],
    ['1.90.0', '1.60.0 - 1.80.0', false],
    ['0.5.2', '^0.5.0', true],
    ['0.6.0', '^0.5.0', false],
  ];
  let rangeFailures = 0;
  for (const [version, range, expected] of rangeCases) {
    const actual = semver.satisfiesRange(version, range);
    if (actual !== expected) {
      rangeFailures += 1;
      note(`  ${version} vs ${JSON.stringify(range)} -> ${actual}, expected ${expected}`);
    }
  }
  check('every semver range case resolves as specified', rangeFailures === 0, `${rangeCases.length} cases`);
  check(
    'an unparseable range reports unknown rather than satisfied',
    semver.satisfiesRange('1.0.0', 'not-a-range') === null &&
      semver.satisfiesRange('1.0.0', '>=<1') === null,
  );
  check('a lower bound can be reported for the UI', semver.minimumForRange('^1.84.0') === '1.84.0');
  check('a wildcard range has no lower bound to report', semver.minimumForRange('*') === null);

  // =========================================================================
  lines.push('', '--- manifest reader ---');
  const good = manifestModule.parseVsCodeManifest(
    JSON.parse(
      manifestJson({
        contributes: {
          themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' }],
          iconThemes: [{ id: 'icons', label: 'Icons', path: './icons.json' }],
          snippets: [{ language: 'python', path: './snippets/py.json' }],
          keybindings: [{ command: 'a.b', key: 'ctrl+k', when: 'editorFocus' }],
          languages: [{ id: 'toml', extensions: ['.toml'], configuration: './lang.json' }],
          grammars: [{ language: 'toml', scopeName: 'source.toml', path: './toml.tmLanguage.json' }],
          commands: [{ command: 'a.b', title: 'Do it' }],
          configuration: { title: 'Probe', properties: { 'probe.on': { type: 'boolean', default: true } } },
          configurationDefaults: { 'editor.tabSize': 2 },
          jsonValidation: [{ fileMatch: 'probe.json', url: './schema.json' }],
          menus: { 'editor/context': [] },
          debuggers: [{ type: 'probe' }],
        },
        activationEvents: ['onLanguage:toml'],
        extensionDependencies: ['ms-python.python'],
        categories: ['Themes', 'Programming Languages'],
        repository: { type: 'git', url: 'https://example.com/repo.git' },
        main: './out/extension.js',
      }).toString('utf8'),
    ),
  );
  check('a well-formed manifest parses', good.ok === true);
  if (good.ok) {
    const m = good.manifest;
    check('the identifier is publisher.name lowercased', m.id === 'axiom.probe', m.id);
    check('every modelled contribution point is read', [
      m.contributes.themes.length === 1,
      m.contributes.iconThemes.length === 1,
      m.contributes.snippets.length === 1,
      m.contributes.keybindings.length === 1,
      m.contributes.languages.length === 1,
      m.contributes.grammars.length === 1,
      m.contributes.commands.length === 1,
      m.contributes.configuration.length === 1,
      m.contributes.jsonValidation.length === 1,
      Object.keys(m.contributes.configurationDefaults).length === 1,
    ].every(Boolean));
    check(
      'contribution paths are stored without the ./ prefix',
      m.contributes.themes[0].path === 'themes/night.json',
      m.contributes.themes[0].path,
    );
    check(
      'unmodelled contribution points are recorded, not silently dropped',
      m.contributes.unmodelled.includes('menus') && m.contributes.unmodelled.includes('debuggers'),
      m.contributes.unmodelled.join(', '),
    );
    const capabilities = manifestModule.reportCapabilities(m);
    check(
      'an extension with a main entry is reported as needing the host',
      capabilities.activation === 'requires-host',
    );
    check(
      'its declarative contributions are still reported as supported',
      capabilities.usableNow === true && capabilities.supported.some((s) => s.point === 'themes'),
    );
    check(
      'its commands are reported as inert rather than working',
      capabilities.inert.some((s) => s.point === 'commands'),
    );
    const compatibility = manifestModule.reportCompatibility(m);
    check('compatibility is evaluated against the declared engine', compatibility.engineSatisfied === true);
  }

  for (const [label, overrides] of [
    ['a missing publisher is fatal', { publisher: undefined }],
    ['a missing name is fatal', { name: undefined }],
    ['a non-semver version is fatal', { version: '1.0' }],
    ['a publisher with a path separator is fatal', { publisher: '../evil' }],
  ]) {
    const parsedJson = JSON.parse(manifestJson().toString('utf8'));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete parsedJson[key];
      else parsedJson[key] = value;
    }
    const result = manifestModule.parseVsCodeManifest(parsedJson);
    check(label, result.ok === false, result.ok ? 'accepted' : result.errors[0]);
  }
  check(
    'a traversal path in a contribution is dropped',
    manifestModule.safeRelativePath('../../etc/passwd') === null &&
      manifestModule.safeRelativePath('/etc/passwd') === null &&
      manifestModule.safeRelativePath('C:\\windows') === null &&
      manifestModule.safeRelativePath('./ok/file.json') === 'ok/file.json',
  );
  const noEngine = manifestModule.parseVsCodeManifest(
    JSON.parse(manifestJson({ engines: {} }).toString('utf8')),
  );
  check(
    'a manifest with no declared engine reports unknown compatibility',
    noEngine.ok && manifestModule.reportCompatibility(noEngine.manifest).engineSatisfied === null,
  );

  // =========================================================================
  lines.push('', '--- VSIX reader: hostile archives ---');
  const okZip = buildZip([
    { name: 'extension.vsixmanifest', data: Buffer.from('<xml/>', 'utf8') },
    { name: 'extension/package.json', data: manifestJson() },
    { name: 'extension/readme.md', data: Buffer.from('hello', 'utf8') },
  ]);
  const inspected = await vsix.inspectVsix(okZip);
  check('a minimal well-formed VSIX is accepted', inspected.manifest.id === 'axiom.probe');
  check(
    'the package digest is reported',
    inspected.sha256 === crypto.createHash('sha256').update(okZip).digest('hex'),
  );
  check('the payload size counts only extension/ files', inspected.payloadBytes === manifestJson().length + 5,
    String(inspected.payloadBytes));

  await rejects(
    'a traversal entry name is refused',
    buildZip([
      { name: 'extension/package.json', data: manifestJson() },
      { name: 'extension/../../evil.txt', data: Buffer.from('x', 'utf8') },
    ]),
    /refuses to read|invalid relative path/i,
  );
  await rejects(
    'an absolute entry name is refused',
    buildZip([
      { name: 'extension/package.json', data: manifestJson() },
      { name: '/etc/passwd', data: Buffer.from('x', 'utf8') },
    ]),
    /refuses to read|absolute path/i,
  );
  await rejects(
    'a symlink entry is refused',
    buildZip([
      { name: 'extension/package.json', data: manifestJson() },
      {
        name: 'extension/link',
        data: Buffer.from('/etc/passwd', 'utf8'),
        madeBy: 3,
        mode: 0xa1ff,
      },
    ]),
    /symbolic link/i,
  );
  await rejects(
    'a decompression bomb is refused',
    buildZip([
      { name: 'extension/package.json', data: manifestJson() },
      { name: 'extension/bomb.bin', data: Buffer.alloc(64 * 1024 * 1024, 0) },
    ]),
    /ratio|larger than|total size/i,
  );
  await rejects(
    'an archive without a manifest is refused',
    buildZip([{ name: 'extension/readme.md', data: Buffer.from('x', 'utf8') }]),
    /package\.json/i,
  );
  await rejects(
    'a manifest that is not JSON is refused',
    buildZip([{ name: 'extension/package.json', data: Buffer.from('{ not json', 'utf8') }]),
    /valid JSON/i,
  );
  await rejects(
    'a manifest without an identity is refused',
    buildZip([{ name: 'extension/package.json', data: Buffer.from('{"name":"x"}', 'utf8') }]),
    /publisher|version/i,
  );
  await rejects('an empty buffer is refused', Buffer.alloc(0), /empty/i);
  await rejects('a non-zip buffer is refused', Buffer.from('not a zip at all', 'utf8'), /readable VSIX/i);

  // Extraction containment: the payload prefix must be stripped and nothing may land
  // outside the target directory.
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-vsix-'));
  try {
    const written = await vsix.extractVsix(okZip, extractRoot);
    check('extraction writes the payload files', written === 2, `${written} files`);
    check(
      'the extension/ prefix is stripped',
      fs.existsSync(path.join(extractRoot, 'package.json')) &&
        fs.existsSync(path.join(extractRoot, 'readme.md')),
    );
    check(
      'packaging metadata is not extracted',
      !fs.existsSync(path.join(extractRoot, 'extension.vsixmanifest')),
    );
    const nested = buildZip([
      { name: 'extension/package.json', data: manifestJson() },
      { name: 'extension/deep/a/b/c.txt', data: Buffer.from('deep', 'utf8') },
    ]);
    const nestedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-vsix-'));
    await vsix.extractVsix(nested, nestedRoot);
    check(
      'nested directories are created',
      fs.readFileSync(path.join(nestedRoot, 'deep', 'a', 'b', 'c.txt'), 'utf8') === 'deep',
    );
    fs.rmSync(nestedRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }

  // =========================================================================
  lines.push('', '--- registry URL policy ---');
  check(
    'an API url on the registry host is accepted',
    openVsx.validateRegistryApiUrl('https://open-vsx.org/api/-/search?query=a') !== null,
  );
  check(
    'the content CDN may serve files but not the API',
    openVsx.validateRegistryFileUrl('https://openvsx.eclipsecontent.org/a/b.vsix') !== null &&
      openVsx.validateRegistryApiUrl('https://openvsx.eclipsecontent.org/api/version') === null,
  );
  const refusedUrls = [
    ['plain http', 'http://open-vsx.org/api/version'],
    ['a foreign host', 'https://evil.example.com/api/version'],
    ['a lookalike host', 'https://open-vsx.org.evil.example.com/api/version'],
    ['embedded credentials', 'https://user:pass@open-vsx.org/api/version'],
    ['a fragment', 'https://open-vsx.org/api/version#x'],
    ['a non-url', 'not a url'],
  ];
  const wronglyAccepted = refusedUrls.filter(
    ([, url]) => openVsx.validateRegistryFileUrl(url) !== null,
  );
  check(
    'every disallowed url shape is refused',
    wronglyAccepted.length === 0,
    wronglyAccepted.map(([label]) => label).join(', ') || `${refusedUrls.length} shapes`,
  );
  const searchUrl = new URL(openVsx.registrySearchUrl({ query: 'python', size: 5000, offset: -3 }));
  check(
    'search paging is clamped rather than rejected',
    searchUrl.searchParams.get('size') === '1000' && searchUrl.searchParams.get('offset') === '0',
    `${searchUrl.searchParams.get('size')}/${searchUrl.searchParams.get('offset')}`,
  );
  check(
    'an unknown sort key is dropped instead of forwarded',
    !new URL(openVsx.registrySearchUrl({ sortBy: 'sneaky' })).searchParams.has('sortBy'),
  );
  const idCases = [
    ['ms-python.python', true],
    ['redhat.vscode-yaml', true],
    ['nodot', false],
    ['.leading', false],
    ['trailing.', false],
    ['a/b.c', false],
    ['a.b/../c', false],
    ['a b.c', false],
  ];
  const idWrong = idCases.filter(([id, expected]) => (openVsx.splitExtensionId(id) !== null) !== expected);
  check('extension identifiers are parsed strictly', idWrong.length === 0, idWrong.map(([id]) => id).join(', '));
  check(
    'a published digest is parsed only when it is exactly a sha256',
    openVsx.parsePublishedDigest(`  ${'a'.repeat(64)}\n`) === 'a'.repeat(64) &&
      openVsx.parsePublishedDigest('deadbeef') === null &&
      openVsx.parsePublishedDigest(`${'a'.repeat(65)}`) === null,
  );
  check(
    'Retry-After is honoured and clamped',
    openVsx.retryAfterMs('2') === 2000 &&
      openVsx.retryAfterMs('99999') === 30_000 &&
      openVsx.retryAfterMs('garbage') === 1000 &&
      openVsx.retryAfterMs(null) === 1000,
  );
  check(
    'an unverifiable signature is never described as verified',
    !openVsx
      .describeIntegrity({
        sha256: 'x',
        publishedSha256: 'x',
        digestVerified: true,
        signatureManifestVerified: true,
        signature: 'present-unverified',
      })
      .match(/signature verified/i),
  );

  // =========================================================================
  lines.push('', '--- registry client against the live registry ---');
  check('the registry is reachable', (await registry.registryReachable()) === true);
  const page = await registry.searchExtensions({
    query: 'theme',
    size: 5,
    sortBy: 'downloadCount',
    sortOrder: 'desc',
  });
  check(
    'search returns a normalized page',
    page.extensions.length > 0 && page.totalSize > 0,
    `${page.extensions.length} of ${page.totalSize}`,
  );
  check(
    'every search entry carries a usable identity',
    page.extensions.every((e) => /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/.test(e.id)),
    page.extensions.map((e) => e.id).slice(0, 3).join(', '),
  );
  check(
    'search results are cached in-session',
    (await registry.searchExtensions({ query: 'theme', size: 5, sortBy: 'downloadCount', sortOrder: 'desc' })) ===
      page,
  );
  const detail = await registry.extensionDetail('dracula-theme.theme-dracula');
  check('details resolve with publisher and files', detail.publisher !== null && detail.files.download !== null,
    `${detail.id}@${detail.version} by ${detail.publisher?.loginName}`);
  check('details expose the engine range', typeof detail.engines.vscode === 'string', detail.engines.vscode);
  check('details expose categories', detail.categories.length > 0, detail.categories.join(', '));
  const history = await registry.versionHistory('dracula-theme.theme-dracula', 0, 5);
  check('version history is paginated', history.versions.length > 0 && history.totalSize > 0,
    `${history.versions.length} of ${history.totalSize}: ${history.versions.map((v) => v.version).join(', ')}`);
  const reviews = await registry.extensionReviews('dracula-theme.theme-dracula');
  check('reviews resolve', Array.isArray(reviews), `${reviews.length} reviews`);
  const publisher = await registry.publisherDetail('dracula-theme');
  check('publisher details resolve with their extensions', publisher.extensions.length > 0,
    `${publisher.displayName}: ${publisher.extensions.length} extensions`);
  await (async () => {
    try {
      await registry.extensionDetail('definitely-not.a-real-extension-xyz');
      check('a missing extension reports a 404 rather than hanging', false, 'it resolved');
    } catch (error) {
      check('a missing extension reports a 404 rather than hanging', error.status === 404, String(error.status));
    }
  })();

  const downloaded = await registry.downloadPackage(detail);
  check(
    'a package downloads and its published digest is verified',
    downloaded.integrity.digestVerified === true,
    downloaded.integrity.sha256,
  );
  check(
    'the signature manifest independently confirms the same bytes',
    downloaded.integrity.signatureManifestVerified === true,
  );
  check(
    'the signature itself is reported as present but unverified',
    downloaded.integrity.signature === 'present-unverified',
  );
  note(`integrity summary: ${downloaded.integritySummary}`);
  const downloadedPackage = await vsix.inspectVsix(downloaded.bytes);
  check(
    'the downloaded bytes are the extension the details described',
    downloadedPackage.manifest.id === detail.id && downloadedPackage.manifest.version === detail.version,
  );
  await (async () => {
    // Tampering must be caught by the digest comparison, not discovered later.
    const tampered = { ...detail, files: { ...detail.files, download: detail.files.manifest } };
    try {
      await registry.downloadPackage(tampered);
      check('bytes that disagree with the published digest are refused', false, 'accepted');
    } catch (error) {
      check(
        'bytes that disagree with the published digest are refused',
        /does not match the checksum/.test(String(error.message)),
        String(error.message).slice(0, 90),
      );
    }
  })();

  const lookups = await registry.latestVersions(['dracula-theme.theme-dracula', 'redhat.vscode-yaml']);
  check(
    'latest versions resolve for a batch',
    lookups.every((l) => l.latestVersion !== null && l.error === null),
    lookups.map((l) => `${l.id}=${l.latestVersion}`).join(', '),
  );
  const cachedLookups = await registry.latestVersions(['dracula-theme.theme-dracula']);
  check('a repeat update check is served from the on-disk catalog', cachedLookups[0].fromCache === true);
  check(
    'the catalog cache is written where it can be discarded safely',
    fs.existsSync(path.join(stubUserData, 'extension-registry', 'catalog.json')),
  );
  const batchWithBadId = await registry.latestVersions(['dracula-theme.theme-dracula', 'nope.nope-nope-xyz']);
  check(
    'one failing lookup does not sink the batch',
    batchWithBadId[0].latestVersion !== null && batchWithBadId[1].error !== null,
    batchWithBadId[1].error?.slice(0, 60),
  );

  // =========================================================================
  lines.push('', '--- install policy (pure) ---');
  const marketplace = loadTs('src/common/marketplace.ts');
  check(
    'a corrupt state file degrades instead of throwing',
    JSON.stringify(marketplace.sanitizeMarketplaceState('nonsense')) ===
      JSON.stringify(marketplace.emptyMarketplaceState()),
  );
  check(
    'a state entry with a traversal directory name is dropped',
    Object.keys(
      marketplace.sanitizeMarketplaceState({
        extensions: {
          'a.b': { version: '1.0.0', directoryName: '../escape' },
          'c.d': { version: '1.0.0', directoryName: 'c.d-1.0.0' },
        },
      }).extensions,
    ).join(',') === 'c.d',
  );
  check(
    'an installed extension is enabled by default',
    marketplace.resolveMarketplaceEnablement(
      { disabledGlobally: false, disabledWorkspaces: [] },
      null,
    ).enabled === true,
  );
  check(
    'a workspace disable is narrower than the global setting',
    marketplace.resolveMarketplaceEnablement(
      { disabledGlobally: false, disabledWorkspaces: ['C:\\proj'] },
      'C:\\proj',
    ).scope === 'workspace' &&
      marketplace.resolveMarketplaceEnablement(
        { disabledGlobally: false, disabledWorkspaces: ['C:\\proj'] },
        'C:\\other',
      ).enabled === true,
  );
  check(
    'only a strictly newer version counts as an update',
    marketplace.planUpdates(
      [
        { id: 'a.b', version: '1.0.0', displayName: 'B', autoUpdate: true },
        { id: 'c.d', version: '2.0.0', displayName: 'D', autoUpdate: true },
        { id: 'e.f', version: '3.0.0', displayName: 'F', autoUpdate: true },
      ],
      new Map([
        ['a.b', '1.1.0'],
        ['c.d', '1.0.0'],
        ['e.f', '3.0.0'],
      ]),
    ).map((entry) => entry.id).join(',') === 'a.b',
  );
  const order = marketplace.resolveInstallOrder(
    'root.pack',
    { edges: new Map([['root.pack', ['dep.one', 'dep.two']], ['dep.one', ['dep.deep']], ['dep.two', []], ['dep.deep', []]]) },
  );
  check(
    'dependencies are ordered before what requires them',
    order.ok && order.order.indexOf('dep.deep') < order.order.indexOf('dep.one') &&
      order.order.indexOf('dep.one') < order.order.indexOf('root.pack'),
    order.ok ? order.order.join(' -> ') : order.reason,
  );
  const cyclic = marketplace.resolveInstallOrder('a.a', {
    edges: new Map([['a.a', ['b.b']], ['b.b', ['a.a']]]),
  });
  check('a dependency cycle is named rather than hung on', cyclic.ok === false && Array.isArray(cyclic.cycle),
    cyclic.ok ? '' : cyclic.cycle?.join(' -> '));

  // =========================================================================
  lines.push('', '--- install pipeline against the live registry ---');
  const market = loadTs('src/main/services/marketplaceExtensions.ts');
  const extensionsRoot = path.join(stubUserData, 'extensions');
  const THEME_ID = 'dracula-theme.theme-dracula';

  const installed = await market.installExtension(THEME_ID);
  check(
    'an extension installs from the registry',
    installed.id === THEME_ID && installed.upgraded === false,
    `${installed.id}@${installed.version}`,
  );
  note(`integrity: ${installed.integritySummary}`);
  check(
    'it lands in a versioned directory with its manifest at the root',
    fs.existsSync(path.join(extensionsRoot, `${THEME_ID}-${installed.version}`, 'package.json')),
  );
  check('the install is recorded in state', fs.existsSync(path.join(extensionsRoot, '.marketplace-state.json')));
  const recorded = JSON.parse(
    fs.readFileSync(path.join(extensionsRoot, '.marketplace-state.json'), 'utf8'),
  ).extensions[THEME_ID];
  check(
    'the record keeps what was verified about the bytes',
    recorded.integrity.digestVerified === true && recorded.integrity.signature === 'present-unverified',
    JSON.stringify(recorded.integrity),
  );

  let list = await market.listInstalledExtensions(null);
  check('the installed list reports it', list.length === 1 && list[0].id === THEME_ID);
  check('it is enabled on arrival', list[0].enabled === true && list[0].enablementScope === 'default');
  check(
    'its working contributions are reported',
    list[0].capabilities.supported.some((s) => s.point === 'themes'),
    list[0].capabilities.supported.map((s) => `${s.point}=${s.count}`).join(', '),
  );
  const detailView = await market.installedExtensionDetail(THEME_ID, null);
  check(
    'the detail view exposes the manifest and its location',
    detailView.manifest.contributes.themes.length > 0 && detailView.directory.includes(THEME_ID),
  );

  await market.setExtensionEnablement(THEME_ID, false, 'global', null);
  list = await market.listInstalledExtensions(null);
  check('a global disable takes effect', list[0].enabled === false && list[0].enablementScope === 'global');
  await market.setExtensionEnablement(THEME_ID, true, 'global', null);
  await market.setExtensionEnablement(THEME_ID, false, 'workspace', 'C:\\project-a');
  const inA = await market.listInstalledExtensions('C:\\project-a');
  const inB = await market.listInstalledExtensions('C:\\project-b');
  check(
    'a workspace disable applies only to that workspace',
    inA[0].enabled === false && inA[0].enablementScope === 'workspace' && inB[0].enabled === true,
  );
  await market.setExtensionEnablement(THEME_ID, true, 'workspace', 'C:\\project-a');
  await (async () => {
    try {
      await market.setExtensionEnablement(THEME_ID, false, 'workspace', null);
      check('a workspace change without an open folder is refused', false, 'accepted');
    } catch (error) {
      check('a workspace change without an open folder is refused', /folder must be open/i.test(error.message));
    }
  })();

  await market.setExtensionAutoUpdate(THEME_ID, false);
  list = await market.listInstalledExtensions(null);
  check('auto-update can be turned off per extension', list[0].autoUpdate === false);
  await market.setExtensionAutoUpdate(THEME_ID, true);

  check('an up-to-date install reports no updates', (await market.checkForUpdates(true)).length === 0);

  // Downgrade on purpose, then confirm the update path both detects and applies it.
  const older = await market.installExtension(THEME_ID, '2.24.0');
  check('a specific version can be installed', older.version === '2.24.0' && older.upgraded === true);
  check(
    'the superseded directory is pruned',
    !fs.existsSync(path.join(extensionsRoot, `${THEME_ID}-${installed.version}`)),
  );
  const plan = await market.checkForUpdates(true);
  check(
    'an outdated install is detected',
    plan.length === 1 && plan[0].fromVersion === '2.24.0',
    plan.map((entry) => `${entry.id} ${entry.fromVersion}->${entry.toVersion}`).join(', '),
  );
  const updateOutcome = await market.updateAllExtensions(false);
  check(
    'Update All installs the newer version',
    updateOutcome.updated.includes(THEME_ID) && updateOutcome.failed.length === 0,
    JSON.stringify(updateOutcome),
  );
  list = await market.listInstalledExtensions(null);
  check('the update is reflected on disk', list[0].version !== '2.24.0', list[0].version);

  // Enablement must survive an upgrade: a user who switched something off does not
  // expect a new version to switch it back on.
  await market.setExtensionEnablement(THEME_ID, false, 'global', null);
  await market.installExtension(THEME_ID, '2.24.0');
  list = await market.listInstalledExtensions(null);
  check('a disable survives reinstalling a different version', list[0].enabled === false);
  await market.setExtensionEnablement(THEME_ID, true, 'global', null);

  // Install from a local file.
  const localVsix = path.join(os.tmpdir(), `axiom-local-${Date.now()}.vsix`);
  fs.writeFileSync(
    localVsix,
    buildZip([
      { name: 'extension.vsixmanifest', data: Buffer.from('<xml/>', 'utf8') },
      {
        name: 'extension/package.json',
        data: manifestJson({
          publisher: 'localtest',
          name: 'sample',
          contributes: { themes: [{ label: 'Local', uiTheme: 'vs-dark', path: './t.json' }] },
        }),
      },
      { name: 'extension/t.json', data: Buffer.from('{"colors":{}}', 'utf8') },
    ]),
  );
  try {
    const fromFile = await market.installExtensionFromFile(localVsix);
    check('a local .vsix installs', fromFile.id === 'localtest.sample', fromFile.id);
    const localList = await market.listInstalledExtensions(null);
    const local = localList.find((e) => e.id === 'localtest.sample');
    check(
      'a local install is not presented as checksum-verified',
      local.source === 'vsix' && local.integrity.digestVerified === false,
    );
    await (async () => {
      try {
        await market.installExtensionFromFile(localVsix.replace('.vsix', '.zip'));
        check('a non-vsix file is refused', false, 'accepted');
      } catch (error) {
        check('a non-vsix file is refused', /only \.vsix/i.test(error.message));
      }
    })();
  } finally {
    fs.rmSync(localVsix, { force: true });
  }

  // An extension demanding a newer editor API must not be installed silently.
  const futureVsix = buildZip([
    {
      name: 'extension/package.json',
      data: manifestJson({ publisher: 'future', name: 'ext', engines: { vscode: '^99.0.0' } }),
    },
  ]);
  fs.writeFileSync(path.join(os.tmpdir(), 'axiom-future.vsix'), futureVsix);
  try {
    await market.installExtensionFromFile(path.join(os.tmpdir(), 'axiom-future.vsix'));
    check('an extension needing a newer editor API is refused', false, 'accepted');
  } catch (error) {
    check('an extension needing a newer editor API is refused', /newer editor API/i.test(error.message),
      error.message.slice(0, 90));
  } finally {
    fs.rmSync(path.join(os.tmpdir(), 'axiom-future.vsix'), { force: true });
  }

  // Interrupted installs leave staging directories; startup must clear them.
  const orphanStaging = path.join(extensionsRoot, '.staging-deadbeef');
  fs.mkdirSync(orphanStaging, { recursive: true });
  fs.writeFileSync(path.join(orphanStaging, 'partial.txt'), 'x');
  await market.cleanStagingDirectories();
  check('an interrupted install leaves nothing behind after cleanup', !fs.existsSync(orphanStaging));
  check(
    'staging directories are never treated as installed extensions',
    (await market.listInstalledExtensions(null)).every((e) => !e.id.includes('staging')),
  );

  await market.uninstallExtension('localtest.sample');
  await market.uninstallExtension(THEME_ID);
  const afterRemoval = await market.listInstalledExtensions(null);
  check('uninstall removes the extension and its directory', afterRemoval.length === 0,
    afterRemoval.map((e) => e.id).join(', '));
  check(
    'no extension directories are left on disk',
    fs.readdirSync(extensionsRoot).filter((n) => !n.startsWith('.')).length === 0,
    fs.readdirSync(extensionsRoot).join(', '),
  );
  await (async () => {
    try {
      await market.uninstallExtension('never.installed');
      check('uninstalling something absent is refused clearly', false, 'accepted');
    } catch (error) {
      check('uninstalling something absent is refused clearly', /not installed/i.test(error.message));
    }
  })();

  // =========================================================================
  lines.push('', '--- theme conversion (pure) ---');
  const vscodeTheme = loadTs('src/common/vscodeTheme.ts');
  const AXIOM_TOKENS = [
    '--bg-void', '--bg-canvas', '--bg-editor', '--bg-surface', '--bg-raised', '--bg-overlay',
    '--bg-overlay-strong', '--bg-hover', '--bg-active', '--bg-scrim',
    '--fg-max', '--fg-strong', '--fg-default', '--fg-muted', '--fg-subtle', '--fg-faint',
    '--border-subtle', '--border', '--border-strong',
    '--info', '--success', '--warning', '--danger',
    '--fg-on-danger', '--fg-on-warning', '--fg-on-subtle', '--ai', '--warning-soft',
  ];
  const sparse = vscodeTheme.convertVsCodeTheme(
    { name: 'Sparse', colors: { 'editor.background': '#101020', 'editor.foreground': '#e0e0f0' } },
    { label: 'Sparse', uiTheme: 'vs-dark' },
  );
  const missingTokens = AXIOM_TOKENS.filter((token) => !(token in sparse.tokens));
  check(
    'a theme defining only two colours still yields a complete token set',
    missingTokens.length === 0,
    missingTokens.join(', ') || `${Object.keys(sparse.tokens).length} tokens`,
  );
  check(
    'derived surfaces stay distinct rather than collapsing to one colour',
    new Set([sparse.tokens['--bg-void'], sparse.tokens['--bg-canvas'], sparse.tokens['--bg-editor'], sparse.tokens['--bg-raised']]).size ===
      4,
    [sparse.tokens['--bg-void'], sparse.tokens['--bg-canvas'], sparse.tokens['--bg-editor'], sparse.tokens['--bg-raised']].join(' '),
  );
  check(
    'the declared uiTheme decides light or dark even when the file omits type',
    vscodeTheme.convertVsCodeTheme({ colors: { 'editor.background': '#ffffff' } }, { label: 'x', uiTheme: 'vs' }).kind ===
      'light' &&
      vscodeTheme.convertVsCodeTheme({ colors: { 'editor.background': '#ffffff' } }, { label: 'x', uiTheme: 'vs-dark' })
        .kind === 'dark',
  );
  check(
    'with no uiTheme and no type, background luminance decides',
    vscodeTheme.convertVsCodeTheme({ colors: { 'editor.background': '#ffffff' } }, { label: 'x' }).kind === 'light' &&
      vscodeTheme.convertVsCodeTheme({ colors: { 'editor.background': '#101010' } }, { label: 'x' }).kind === 'dark',
  );
  const alphaTheme = vscodeTheme.convertVsCodeTheme(
    { colors: { 'editor.background': '#101020', 'list.hoverBackground': '#ffffff20' } },
    { label: 'x', uiTheme: 'vs-dark' },
  );
  check(
    'translucent workbench colours keep their alpha',
    /^rgba\(255, 255, 255, 0\.12[0-9]?\)$/.test(alphaTheme.tokens['--bg-hover']),
    alphaTheme.tokens['--bg-hover'],
  );
  const scoped = vscodeTheme.convertVsCodeTheme(
    {
      colors: { 'editor.background': '#000000' },
      tokenColors: [
        { scope: 'comment, comment.line', settings: { foreground: '#6a9955', fontStyle: 'italic' } },
        { scope: ['keyword', 'storage.type'], settings: { foreground: '#569cd6' } },
        { settings: { foreground: '#d4d4d4' } },
        { scope: 'ignored', settings: {} },
        { scope: 'alpha', settings: { foreground: '#ff000080' } },
      ],
    },
    { label: 'x', uiTheme: 'vs-dark' },
  );
  check(
    'comma and array scopes each become their own rule',
    scoped.rules.filter((r) => r.token === 'comment').length === 1 &&
      scoped.rules.filter((r) => r.token === 'comment.line').length === 1 &&
      scoped.rules.filter((r) => r.token === 'storage.type').length === 1,
    scoped.rules.map((r) => r.token).join(','),
  );
  check('a scopeless rule becomes the default rule', scoped.rules.some((r) => r.token === ''));
  check('a rule with no colour and no style is dropped', !scoped.rules.some((r) => r.token === 'ignored'));
  check(
    'token colours are emitted without alpha, which Monaco rejects',
    scoped.rules.find((r) => r.token === 'alpha').foreground === 'ff0000',
  );
  check(
    'a file with neither colours nor token rules is not a theme',
    vscodeTheme.convertVsCodeTheme({ name: 'empty' }, { label: 'x' }) === null,
  );
  const merged = vscodeTheme.mergeIncludedTheme(
    { colors: { a: '#111111', b: '#222222' }, tokenColors: [{ scope: 'base', settings: {} }] },
    { colors: { b: '#333333' }, tokenColors: [{ scope: 'child', settings: {} }] },
  );
  check(
    'an included base merges with the child winning',
    merged.colors.a === '#111111' && merged.colors.b === '#333333' && merged.tokenColors.length === 2,
  );

  // =========================================================================
  lines.push('', '--- contribution engine against real installs ---');
  const contributions = loadTs('src/main/services/extensionContributions.ts');
  await market.installExtension(THEME_ID);
  await market.installExtension('vscode-icons-team.vscode-icons');

  let catalog = await contributions.buildContributionCatalog(null);
  check(
    'the catalog lists themes contributed by installed extensions',
    catalog.themes.length >= 2 && catalog.themes.every((t) => t.key.includes('::')),
    catalog.themes.map((t) => `${t.label}(${t.kind})`).join(', '),
  );
  check(
    'the catalog lists contributed icon themes',
    catalog.iconThemes.some((t) => t.extensionId === 'vscode-icons-team.vscode-icons'),
    catalog.iconThemes.map((t) => t.label).join(', '),
  );
  check(
    'contributed commands report invocability from whether the extension ships an entry point',
    catalog.commands.length > 0 &&
      catalog.commands.every((c) => typeof c.invocable === 'boolean') &&
      catalog.commands.filter((c) => c.extensionId === THEME_ID).every((c) => c.invocable === false),
    `${catalog.commands.length} commands, ${catalog.commands.filter((c) => c.invocable).length} invocable`,
  );
  check(
    'contributed settings are listed with their defaults',
    catalog.settings.length > 0 && catalog.settings.some((s) => s.hasDefault),
    `${catalog.settings.length} settings`,
  );
  check(
    'contribution points that will not act are reported as inert',
    catalog.inert.some((i) => i.points.includes('commands')),
    catalog.inert.map((i) => `${i.extensionName}: ${i.points.join('/')}`).join(' | '),
  );

  const draculaKey = catalog.themes.find((t) => t.extensionId === THEME_ID).key;
  const loadedTheme = await contributions.loadContributedTheme(draculaKey, null);
  check(
    'a contributed theme loads and converts from disk',
    loadedTheme !== null && loadedTheme.rules.length > 0,
    loadedTheme ? `${loadedTheme.label}: ${Object.keys(loadedTheme.tokens).length} tokens, ${loadedTheme.rules.length} rules` : 'null',
  );
  check(
    'the loaded theme is complete',
    AXIOM_TOKENS.every((token) => typeof loadedTheme.tokens[token] === 'string'),
  );
  check(
    'the loaded theme carries an accent and an editor surface for Monaco',
    /^#[0-9a-f]{6}$/i.test(loadedTheme.accent.accent) &&
      typeof loadedTheme.editorColors['editor.background'] === 'string',
    `${loadedTheme.accent.accent} / ${loadedTheme.editorColors['editor.background']}`,
  );
  check(
    'text on the accent is chosen for legibility, not by theme kind',
    /^#[0-9a-fA-F]{6}$/.test(loadedTheme.accent.onAccent),
    loadedTheme.accent.onAccent,
  );
  check('an unknown theme key resolves to nothing', (await contributions.loadContributedTheme('no.such::key', null)) === null);

  const iconKey = catalog.iconThemes.find((t) => t.extensionId === 'vscode-icons-team.vscode-icons').key;
  const iconTheme = await contributions.loadIconTheme(iconKey, null);
  const iconValues = Object.values(iconTheme.iconDefinitions);
  check(
    'an icon theme loads with its icons inlined',
    iconValues.length > 0 && iconValues.some((d) => typeof d.dataUrl === 'string'),
    `${iconValues.length} definitions, ${iconValues.filter((d) => d.dataUrl).length} inlined`,
  );
  check(
    'inlined icons are only ever image data URLs',
    iconValues.every(
      (d) => !d.dataUrl || /^data:image\/(png|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(d.dataUrl),
    ),
  );
  check(
    'every filename mapping resolves to a definition that exists',
    Object.values(iconTheme.fileExtensions)
      .concat(Object.values(iconTheme.fileNames))
      .filter((name) => iconTheme.iconDefinitions[name] === undefined).length === 0,
    `${Object.keys(iconTheme.iconDefinitions).length} definitions`,
  );
  check(
    'the icon theme exposes its file and folder mappings',
    Object.keys(iconTheme.fileExtensions).length > 0 || Object.keys(iconTheme.fileNames).length > 0,
    `${Object.keys(iconTheme.fileExtensions).length} extensions, ${Object.keys(iconTheme.fileNames).length} names`,
  );

  // A disabled extension must vanish from the catalog, not be offered and then fail.
  await market.setExtensionEnablement(THEME_ID, false, 'global', null);
  catalog = await contributions.buildContributionCatalog(null);
  check(
    'a disabled extension contributes nothing',
    !catalog.themes.some((t) => t.extensionId === THEME_ID),
    catalog.themes.map((t) => t.extensionId).join(', '),
  );
  await market.setExtensionEnablement(THEME_ID, true, 'global', null);

  // JSONC and containment, via a package built for the purpose.
  const jsoncVsix = buildZip([
    {
      name: 'extension/package.json',
      data: manifestJson({
        publisher: 'jsonc',
        name: 'sample',
        contributes: {
          themes: [
            { label: 'Commented', uiTheme: 'vs-dark', path: './themes/commented.json' },
            { label: 'Escaping', uiTheme: 'vs-dark', path: '../../../etc/passwd' },
          ],
          snippets: [{ language: 'plaintext', path: './snippets/p.json' }],
          languages: [{ id: 'plaintext', extensions: ['.txt'], configuration: './lang.json' }],
          grammars: [
            { language: 'plaintext', scopeName: 'source.sample', path: './syntaxes/sample.tmLanguage.json' },
            { scopeName: 'source.sample.embedded', path: './syntaxes/embedded.tmLanguage' },
            { language: 'plaintext', scopeName: 'source.escape', path: '../../../etc/shadow' },
          ],
        },
      }),
    },
    {
      name: 'extension/syntaxes/sample.tmLanguage.json',
      data: Buffer.from(
        `{
  "scopeName": "source.sample",
  "patterns": [{ "match": "\\\\b(sample|keyword)\\\\b", "name": "keyword.control.sample" }]
}`,
        'utf8',
      ),
    },
    {
      name: 'extension/syntaxes/embedded.tmLanguage',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>scopeName</key>
  <string>source.sample.embedded</string>
  <key>patterns</key>
  <array>
    <dict>
      <key>match</key>
      <string>[0-9]+</string>
      <key>name</key>
      <string>constant.numeric.sample</string>
    </dict>
  </array>
</dict>
</plist>`,
        'utf8',
      ),
    },
    {
      name: 'extension/themes/commented.json',
      data: Buffer.from(
        `{
  // a line comment, which JSON.parse would reject
  "name": "Commented",
  "colors": {
    "editor.background": "#0a0a14",
    "editor.foreground": "#e8e8f4", // trailing comment
  },
  /* a block comment */
  "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#88aaff" } },]
}`,
        'utf8',
      ),
    },
    {
      name: 'extension/snippets/p.json',
      data: Buffer.from(
        `{
  // snippets are JSONC too
  "Greeting": { "prefix": "greet", "body": ["Hello", "World"], "description": "Say hello" },
  "Single": { "prefix": "one", "body": "just one line" }
}`,
        'utf8',
      ),
    },
    {
      name: 'extension/lang.json',
      data: Buffer.from(
        `{
  "comments": { "lineComment": "#", "blockComment": ["<!--", "-->"] },
  "brackets": [["{", "}"], ["[", "]"]],
  "autoClosingPairs": [{ "open": "{", "close": "}" }, ["(", ")"]],
}`,
        'utf8',
      ),
    },
  ]);
  const jsoncPath = path.join(os.tmpdir(), `axiom-jsonc-${Date.now()}.vsix`);
  fs.writeFileSync(jsoncPath, jsoncVsix);
  try {
    await market.installExtensionFromFile(jsoncPath);
    catalog = await contributions.buildContributionCatalog(null);
    const commented = catalog.themes.find((t) => t.extensionId === 'jsonc.sample' && t.label === 'Commented');
    check('a theme contribution with a traversal path is never offered', catalog.themes.filter((t) => t.extensionId === 'jsonc.sample').length === 1,
      catalog.themes.filter((t) => t.extensionId === 'jsonc.sample').map((t) => t.label).join(', '));
    const commentedTheme = await contributions.loadContributedTheme(commented.key, null);
    check(
      'a JSONC theme with comments and trailing commas loads',
      commentedTheme !== null && commentedTheme.tokens['--bg-editor'] === '#0a0a14',
      commentedTheme ? commentedTheme.tokens['--bg-editor'] : 'null',
    );
    check(
      'its token rules survive the trailing comma',
      commentedTheme.rules.some((r) => r.token === 'keyword' && r.foreground === '88aaff'),
    );
    const snippets = await contributions.loadSnippets('plaintext', null);
    check(
      'JSONC snippets load with array bodies joined',
      snippets.some((s) => s.prefix === 'greet' && s.body === 'Hello\nWorld') &&
        snippets.some((s) => s.prefix === 'one' && s.body === 'just one line'),
      `${snippets.length} snippets`,
    );
    check(
      'snippet languages are counted in the catalog',
      catalog.snippetLanguages.some((s) => s.language === 'plaintext'),
    );
    const language = catalog.languages.find((l) => l.extensionId === 'jsonc.sample');
    check(
      'a language configuration loads its comment markers and brackets',
      language.configuration.lineComment === '#' &&
        language.configuration.blockComment[0] === '<!--' &&
        language.configuration.brackets.length === 2,
      JSON.stringify(language.configuration.blockComment),
    );
    check(
      'auto-closing pairs accept both object and tuple forms',
      language.configuration.autoClosingPairs.length === 2 &&
        language.configuration.autoClosingPairs[1].open === '(',
    );

    // --- TextMate grammars -------------------------------------------------
    const sampleGrammars = catalog.grammars.filter((g) => g.extensionId === 'jsonc.sample');
    check(
      'a grammar path that escapes the extension is never listed',
      sampleGrammars.length === 2 &&
        !sampleGrammars.some((g) => g.scopeName === 'source.escape'),
      sampleGrammars.map((g) => g.scopeName).join(', '),
    );
    check(
      'a grammar with no language is still catalogued for embedding',
      sampleGrammars.some((g) => g.scopeName === 'source.sample.embedded' && g.language === null),
    );
    const jsonGrammar = await contributions.loadGrammar('source.sample', null);
    check(
      'a JSON grammar loads with its format reported',
      jsonGrammar !== null &&
        jsonGrammar.format === 'json' &&
        JSON.parse(jsonGrammar.content).scopeName === 'source.sample',
      jsonGrammar ? jsonGrammar.format : 'null',
    );
    const plistGrammar = await contributions.loadGrammar('source.sample.embedded', null);
    check(
      'a plist grammar loads and is reported as plist, not JSON',
      plistGrammar !== null &&
        plistGrammar.format === 'plist' &&
        plistGrammar.content.includes('<key>scopeName</key>'),
      plistGrammar ? plistGrammar.format : 'null',
    );
    check(
      'an unknown scope name loads nothing',
      (await contributions.loadGrammar('source.nonexistent', null)) === null,
    );
    check(
      'a grammar behind an escaping path cannot be loaded by scope name either',
      (await contributions.loadGrammar('source.escape', null)) === null,
    );
    const tmParsed = require('vscode-textmate').parseRawGrammar(
      plistGrammar.content,
      'grammar.plist',
    );
    check(
      'the shipped TextMate parser accepts the plist exactly as delivered',
      tmParsed !== null && tmParsed.scopeName === 'source.sample.embedded',
      tmParsed ? String(tmParsed.scopeName) : 'null',
    );

    await market.uninstallExtension('jsonc.sample');
  } finally {
    fs.rmSync(jsoncPath, { force: true });
  }
  await market.uninstallExtension('vscode-icons-team.vscode-icons');
  await market.uninstallExtension(THEME_ID);

  // =========================================================================
  lines.push('', '--- AI capability awareness ---');
  const capabilities = loadTs('src/main/services/capabilityContext.ts');
  const emptyBlock = capabilities.renderCapabilities({
    extensions: [],
    languageServers: [],
    formatters: [],
    toolchains: [],
    contributedCommands: [],
    invocableCommands: [],
    hasInertExtensions: false,
  });
  check('nothing detected produces no block at all', emptyBlock === '', JSON.stringify(emptyBlock));
  const fullBlock = capabilities.renderCapabilities({
    extensions: [
      { id: 'a.themes', displayName: 'Nice Themes', works: ['themes'], canRunCode: true },
      { id: 'b.linter', displayName: 'Some Linter', works: ['configuration'], canRunCode: false },
    ],
    languageServers: [
      { id: 'typescript', displayName: 'TypeScript / JavaScript', languageIds: ['typescript', 'typescriptreact'] },
    ],
    formatters: [{ id: 'prettier', displayName: 'Prettier', languageIds: ['typescript'] }],
    toolchains: [
      { id: 'node', displayName: 'Node.js', version: 'v24.16.0' },
      { id: 'python', displayName: 'Python', version: null },
    ],
    contributedCommands: ['someLinter.fixAll', 'someLinter.showOutput', 'nice.applyTheme'],
    invocableCommands: ['nice.applyTheme'],
    hasInertExtensions: true,
  });
  check(
    'running language servers are stated',
    /Language servers running: TypeScript \/ JavaScript \(typescript\/typescriptreact\)/.test(fullBlock),
  );
  check(
    'an available formatter is stated with an instruction not to rebuild it',
    /Formatting already available[^\n]*do not write a formatter[^\n]*Prettier/.test(fullBlock),
    fullBlock.split('\n').find((line) => line.startsWith('Formatting')),
  );
  check(
    'toolchains are listed with versions when known',
    /Toolchains installed: Node\.js v24\.16\.0, Python/.test(fullBlock),
  );
  check(
    'contributing extensions are listed with what works',
    /Nice Themes \[themes\]/.test(fullBlock) && /Some Linter \[configuration\]/.test(fullBlock),
  );
  check(
    'commands backed by a running host are stated as usable',
    /Extension commands running now and safe to plan around: nice\.applyTheme/.test(fullBlock),
    fullBlock.split('\n').find((line) => line.startsWith('Extension commands running')),
  );
  check(
    'commands with no running host are listed separately and marked unusable',
    /whose host is not running \(do not plan a step that invokes one\): someLinter\.fixAll/.test(
      fullBlock,
    ) && !/Extension commands running now[^\n]*someLinter/.test(fullBlock),
    fullBlock.split('\n').find((line) => line.includes('host is not running')),
  );
  check(
    'extensions whose code is not running are called out explicitly',
    /ship executable code that is not running/.test(fullBlock),
  );
  const longBlock = capabilities.renderCapabilities({
    extensions: Array.from({ length: 400 }, (_, index) => ({
      id: `pub.ext${index}`,
      displayName: `Extension Number ${index} With A Long Name`,
      works: ['themes', 'snippets', 'languages'],
      canRunCode: true,
    })),
    languageServers: [],
    formatters: [],
    toolchains: [],
    contributedCommands: [],
    invocableCommands: [],
    hasInertExtensions: false,
  });
  check(
    'the block is bounded so it cannot crowd out the code being discussed',
    longBlock.length <= 1_500,
    `${longBlock.length} chars`,
  );
  check(
    'over-long lists are truncated with a count rather than silently cut',
    /\+\d+ more/.test(longBlock),
  );

  // The block is useless unless it actually reaches both model paths.
  const contextBuilderSource = read('src/main/services/contextBuilder.ts');
  check(
    'the chat context builder attaches the capability block',
    contextBuilderSource.includes('buildCapabilityBlock(root)') &&
      /capabilityBlock[\s\S]{0,400}pinned: true/.test(contextBuilderSource),
  );
  const agentSource = read('src/main/services/agent.ts');
  check(
    'the agent receives capabilities as untrusted data, not as system policy',
    agentSource.includes("buildAgentUntrustedMessage('environment capabilities'"),
  );
  check(
    'the agent is told to prefer what already exists',
    agentSource.includes('Prefer what already exists over writing a replacement for it.'),
  );
  check(
    'the agent is told which extension commands it may plan around',
    agentSource.includes('usable only when the inventory lists them as running now') &&
      agentSource.includes('never plan a step that invokes one'),
  );
  const lspSource = read('src/main/services/lsp.ts');
  check(
    'formatter availability is read from live negotiation, not guessed from the catalog',
    lspSource.includes('export function lspFormattingProviders(') &&
      /negotiated\.formatting !== true && negotiated\.rangeFormatting !== true/.test(lspSource),
  );

  // =========================================================================
  lines.push('', '--- VSIX reader: real packages from Open VSX ---');
  const samples = [
    ['dracula-theme', 'theme-dracula', 'themes'],
    ['vscode-icons-team', 'vscode-icons', 'iconThemes'],
    ['redhat', 'vscode-yaml', 'grammars'],
  ];
  for (const [namespace, name, expectedPoint] of samples) {
    const metadata = await (await getFile(`https://open-vsx.org/api/${namespace}/${name}`, 'application/json')).json();
    const digestText = await (await getFile(metadata.files.sha256, 'text/plain')).text();
    const expectedDigest = /\b([0-9a-f]{64})\b/i.exec(digestText.trim())[1].toLowerCase();
    const bytes = Buffer.from(await (await getFile(metadata.files.download, 'application/octet-stream')).arrayBuffer());
    const pkg = await vsix.inspectVsix(bytes);
    check(
      `${namespace}.${name} is read from the real registry package`,
      pkg.manifest.id === `${namespace}.${name}`.toLowerCase(),
      `${pkg.manifest.id}@${pkg.manifest.version}, ${pkg.entryCount} entries`,
    );
    check(`${namespace}.${name} digest matches what the registry published`, pkg.sha256 === expectedDigest);
    const capabilities = manifestModule.reportCapabilities(pkg.manifest);
    check(
      `${namespace}.${name} contributes ${expectedPoint}`,
      capabilities.supported.some((s) => s.point === expectedPoint),
      `supported: ${capabilities.supported.map((s) => `${s.point}=${s.count}`).join(', ') || 'none'}`,
    );
    note(
      `activation=${capabilities.activation} inert=${capabilities.inert.map((s) => s.point).join(',') || 'none'} engine=${
        manifestModule.reportCompatibility(pkg.manifest).engineSatisfied
      }`,
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-vsix-'));
    try {
      await vsix.extractVsix(bytes, root);
      check(
        `${namespace}.${name} extracts with its manifest at the root`,
        fs.existsSync(path.join(root, 'package.json')),
      );
      // Every contributed file the manifest points at must exist after extraction,
      // which is what makes the contribution actually applicable.
      const referenced = [
        ...pkg.manifest.contributes.themes.map((t) => t.path),
        ...pkg.manifest.contributes.iconThemes.map((t) => t.path),
        ...pkg.manifest.contributes.snippets.map((s) => s.path),
        ...pkg.manifest.contributes.grammars.map((g) => g.path),
        ...pkg.manifest.contributes.languages.flatMap((l) => (l.configuration ? [l.configuration] : [])),
      ];
      const missing = referenced.filter((relative) => !fs.existsSync(path.join(root, ...relative.split('/'))));
      check(
        `${namespace}.${name} ships every file its contributions reference`,
        missing.length === 0,
        missing.length > 0 ? missing.join(', ') : `${referenced.length} files present`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // Everything above proves Main can read a contribution. None of it proves the
  // renderer ever applies one, and a contribution that is loaded and then ignored is
  // indistinguishable from one that was never supported. These are source-level wiring
  // assertions for the paths that need a live Monaco and a DOM to execute.
  lines.push('', '--- renderer wiring ---');
  const themeController = read('src/renderer/src/settings/ThemeController.tsx');
  check(
    'the theme controller loads the selected extension colour theme',
    themeController.includes("values['workbench.extensionColorTheme']") &&
      themeController.includes('market\n        .loadTheme(contributedKey, rootPath ?? null)'),
  );
  check(
    'it applies a contributed theme to both the workbench and Monaco',
    themeController.includes('applyContributedAppearance(root, contributed, cornerStyle)') &&
      themeController.includes('setMonacoContributedTheme(contributedKey, contributed)'),
  );
  check(
    'it repaints the native title bar for a contributed theme too',
    themeController.includes('titleBarOverlayForContributed(contributed)'),
  );
  check(
    'a theme whose extension disappeared falls back instead of leaving the workbench unpainted',
    /no longer available\. Using the built-in theme/.test(themeController),
  );
  check(
    'it reloads the selection when the installed set changes',
    /market\.onChanged\(\(\) => load\(\)\)/.test(themeController),
  );
  check(
    'the selected icon theme is published to the icon store',
    themeController.includes("loadIconTheme(iconThemeKey, rootPath ?? null)") &&
      themeController.includes('setActiveIconTheme(theme)'),
  );

  const themes = read('src/renderer/src/settings/themes.ts');
  check(
    'a contributed theme is overlaid on a complete built-in theme of the same kind',
    themes.includes('export function applyContributedAppearance(') &&
      /const base = contributed\.kind === 'light' \? AXIOM_ROYAL_LIGHT : AXIOM_ROYAL/.test(themes),
  );

  const schema = read('src/renderer/src/settings/schema.ts');
  check(
    'both extension appearance choices are real settings, so they persist per profile',
    schema.includes("key: 'workbench.extensionColorTheme'") &&
      schema.includes("key: 'workbench.extensionIconTheme'"),
  );

  const picker = read('src/renderer/src/workbench/ContributedAppearance.tsx');
  check(
    'the Extensions view offers the contributed themes and a way back to built-in',
    picker.includes("set('workbench.extensionColorTheme', theme.key, 'user')") &&
      picker.includes("set('workbench.extensionColorTheme', '', 'user')") &&
      picker.includes("set('workbench.extensionIconTheme', theme.key, 'user')"),
  );
  check(
    'the picker is mounted in the Extensions view',
    read('src/renderer/src/workbench/ExtensionsView.tsx').includes('<ContributedAppearance />'),
  );

  const iconStore = read('src/renderer/src/workbench/iconTheme.ts');
  check(
    'icon resolution follows filename, then compound extension, then language',
    iconStore.includes('active.fileNames[lower]') &&
      iconStore.includes('extensionCandidates(lower)') &&
      iconStore.includes('active.languageIds[languageId.toLowerCase()]'),
  );
  const treeIcons = read('src/renderer/src/workbench/treeIcons.tsx');
  check(
    'file and folder icons consult the active icon theme',
    /export function FileIcon[\s\S]{0,240}resolveFileIcon\(name\)/.test(treeIcons) &&
      /export function FolderIcon[\s\S]{0,200}resolveFolderIcon\(open\)/.test(treeIcons),
  );
  check(
    'a themed icon is only ever an image source, never injected markup',
    treeIcons.includes('<ThemedIcon src={themed.definition.dataUrl}') &&
      !/dangerouslySetInnerHTML/.test(treeIcons),
  );
  check(
    'an icon the theme does not cover falls back to the built-in glyph',
    treeIcons.includes('themed?.definition.dataUrl !== undefined'),
  );

  const controller = read('src/renderer/src/editor/ContributionsController.tsx');
  check(
    'contributed languages, snippets and grammars are all applied',
    controller.includes('applyContributedLanguages(catalog, root)') &&
      controller.includes('applyContributedGrammars(catalog.grammars, root)'),
  );
  check(
    'the grammar engine follows the active theme',
    controller.includes('setTextMateTheme(currentThemeRules(), applyEncodedTokensColors)') &&
      controller.includes('APPEARANCE_CHANGED_EVENT'),
  );
  check(
    'the controller is mounted once for the window',
    read('src/renderer/src/App.tsx').includes('<ContributionsController />'),
  );

  const languages = read('src/renderer/src/editor/contributedLanguages.ts');
  check(
    'contributed languages register with their file associations and configuration',
    languages.includes('monaco.languages.register({') &&
      languages.includes('monaco.languages.setLanguageConfiguration(language.id, languageConfiguration)'),
  );
  check(
    'snippets become real completion items, inserted as snippets',
    languages.includes('monaco.languages.registerCompletionItemProvider(language,') &&
      languages.includes('CompletionItemInsertTextRule.InsertAsSnippet'),
  );
  check(
    'snippet bodies are fetched on first use rather than all at once',
    /cache \?\?= window\.axiom\.market\s*\n?\s*\.snippets\(language, workspaceRoot\)/.test(languages),
  );
  check(
    'previous registrations are disposed before new ones are made',
    languages.includes('function disposeAll()') && languages.includes('disposeAll();'),
  );

  const textmateSource = read('src/renderer/src/editor/textmate.ts');
  check(
    'the grammar engine is the same pair VS Code uses, both loaded on demand',
    textmateSource.includes("import('vscode-textmate')") &&
      textmateSource.includes("import('vscode-oniguruma')") &&
      !/^import \{?[^\n]*from 'vscode-(textmate|oniguruma)'/m.test(textmateSource),
  );
  check(
    'the WebAssembly matcher is loaded from the bundled asset, not the network',
    textmateSource.includes("import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'") &&
      textmateSource.includes('await oniguruma.loadWASM(await response.arrayBuffer())'),
  );
  check(
    'grammars are requested by scope name, never by path',
    textmateSource.includes('window.axiom.market.loadGrammar(scopeName, grammarWorkspaceRoot)') &&
      !/loadGrammar\([^)]*path/.test(textmateSource),
  );
  check(
    'an unknown scope is refused before it reaches Main',
    textmateSource.includes('if (!knownScopes.has(scopeName)) return null;'),
  );
  check(
    'the plist and JSON formats are both parsed, chosen by what Main reported',
    textmateSource.includes("source.format === 'json' ? 'grammar.json' : 'grammar.plist'"),
  );
  check(
    'grammars are compiled lazily, per language, on first use',
    textmateSource.includes('monaco.languages.registerTokensProviderFactory(languageId'),
  );
  check(
    'tokenization is encoded, so grammar colours come from the theme colour map',
    textmateSource.includes('grammar.tokenizeLine2(') && textmateSource.includes('tokenizeEncoded:'),
  );

  const monacoEnvSource = read('src/renderer/src/editor/monacoEnv.ts');
  check(
    'the colour map reaches Monaco through the theme, not the editor-wide override',
    monacoEnvSource.includes('encodedTokensColors: [...colors]') &&
      !monacoEnvSource.includes('setColorMap('),
  );
  check(
    'semantic token colours for a contributed theme are derived from that theme',
    monacoEnvSource.includes('export function setMonacoContributedTheme(') &&
      /scopeColor\(rules, \['keyword\.control', 'keyword', 'storage\.type'\], foreground\)/.test(monacoEnvSource),
  );

  // =========================================================================
  lines.push('', '--- extension host policy (pure) ---');
  const hostPolicy = loadTs('src/common/vscodeHost.ts');

  const activationCases = [
    ['*', { kind: 'startup' }, true],
    ['*', { kind: 'language', value: 'python' }, false],
    ['onStartupFinished', { kind: 'startup' }, true],
    ['onLanguage:python', { kind: 'language', value: 'python' }, true],
    ['onLanguage:python', { kind: 'language', value: 'rust' }, false],
    ['onLanguage:python', { kind: 'startup' }, false],
    ['onCommand:x.y', { kind: 'command', value: 'x.y' }, true],
    ['onCommand:x.y', { kind: 'command', value: 'x.z' }, false],
    ['workspaceContains:Cargo.toml', { kind: 'workspaceContains', value: 'Cargo.toml' }, true],
    ['onSomethingUnknown:x', { kind: 'startup' }, false],
    ['onLanguage:', { kind: 'language', value: '' }, false],
    ['', { kind: 'startup' }, false],
  ];
  const activationWrong = activationCases.filter(
    ([event, trigger, expected]) => hostPolicy.activationMatches(event, trigger) !== expected,
  );
  check(
    'every activation event resolves as specified',
    activationWrong.length === 0,
    activationWrong.map(([event]) => event).join(', ') || `${activationCases.length} cases`,
  );
  check(
    'an unknown activation event never makes an extension eager',
    hostPolicy.activatesEagerly(['onSomethingUnknown:x', 'onLanguage:go']) === false &&
      hostPolicy.activatesEagerly(['onStartupFinished']) === true,
  );
  check(
    'the languages an extension waits for are extracted and deduplicated',
    hostPolicy
      .activationLanguages(['onLanguage:go', 'onLanguage:go', 'onCommand:a.b', 'onLanguage:rust'])
      .sort()
      .join(',') === 'go,rust',
  );

  const crashNow = 1_000_000;
  const firstCrash = hostPolicy.decideCrashResponse([], crashNow);
  check(
    'a first crash restarts after a short backoff',
    firstCrash.restart === true && firstCrash.delayMs === 500 && firstCrash.offerDisable === false,
    JSON.stringify(firstCrash),
  );
  const secondCrash = hostPolicy.decideCrashResponse([crashNow - 1_000], crashNow);
  check(
    'a second crash backs off further and still restarts',
    secondCrash.restart === true && secondCrash.delayMs === 2_000,
    JSON.stringify(secondCrash),
  );
  const thirdCrash = hostPolicy.decideCrashResponse([crashNow - 2_000, crashNow - 1_000], crashNow);
  check(
    'a third crash inside the window stops restarting and offers to disable',
    thirdCrash.restart === false && thirdCrash.offerDisable === true && thirdCrash.recentCrashes === 3,
    JSON.stringify(thirdCrash),
  );
  const agedOut = hostPolicy.decideCrashResponse(
    [crashNow - 10 * 60 * 1000, crashNow - 20 * 60 * 1000],
    crashNow,
  );
  check(
    'crashes age out, so an old failure cannot disable a healthy extension',
    agedOut.restart === true && agedOut.recentCrashes === 1,
    JSON.stringify(agedOut),
  );
  check(
    'pruning drops only the records outside the window',
    hostPolicy.pruneCrashTimes([crashNow - 1_000, crashNow - 10 * 60 * 1000], crashNow).length === 1,
  );

  check(
    'the request set is closed',
    hostPolicy.isHostRequestKind('workspace.readFile') === true &&
      hostPolicy.isHostRequestKind('workspace.spawn') === false &&
      hostPolicy.isHostRequestKind('__proto__') === false,
  );
  const badRequests = [
    ['window.showMessage', {}],
    ['window.showMessage', { message: 'hi', severity: 'critical' }],
    ['window.showQuickPick', { items: [] }],
    ['workspace.readFile', { path: '' }],
    ['workspace.writeFile', { path: 'a.txt' }],
    ['languages.setDiagnostics', { owner: 'x' }],
    ['commands.execute', {}],
    ['env.openExternal', {}],
  ];
  const wronglyAcceptedRequests = badRequests.filter(
    ([kind, payload]) => hostPolicy.validateHostRequest(kind, payload).ok === true,
  );
  check(
    'a malformed request is refused with a reason rather than handled',
    wronglyAcceptedRequests.length === 0,
    wronglyAcceptedRequests.map(([kind]) => kind).join(', ') || `${badRequests.length} shapes`,
  );
  const oversizedWrite = hostPolicy.validateHostRequest('workspace.writeFile', {
    path: 'a.txt',
    content: 'A'.repeat(Math.ceil((hostPolicy.MAX_HOST_FILE_BYTES * 4) / 3) + 64),
  });
  check('an oversized write is refused before any I/O', oversizedWrite.ok === false);
  const clampedFind = hostPolicy.validateHostRequest('workspace.findFiles', {
    include: '**/*.ts',
    maxResults: 1_000_000,
  });
  check(
    'paging and limits are clamped rather than trusted',
    clampedFind.ok === true && clampedFind.payload.maxResults === 2_000,
    clampedFind.ok ? String(clampedFind.payload.maxResults) : 'refused',
  );

  const parsedRequest = hostPolicy.parseWorkerMessage({
    t: 'request',
    id: 7,
    kind: 'workspace.readFile',
    payload: { path: 'a.txt' },
  });
  check('a well-formed worker message parses', parsedRequest !== null && parsedRequest.id === 7);
  const rejectedMessages = [
    null,
    'nonsense',
    { t: 'request', id: 'x', kind: 'workspace.readFile' },
    { t: 'request', id: 1, kind: 'workspace.spawn' },
    { t: 'unknown' },
    { t: 'result' },
  ];
  check(
    'a malformed worker message is dropped rather than acted on',
    rejectedMessages.every((message) => hostPolicy.parseWorkerMessage(message) === null),
  );
  const clampedLog = hostPolicy.parseWorkerMessage({
    t: 'log',
    level: 'made-up',
    message: 'x'.repeat(10_000),
  });
  check(
    'worker log output is clamped and its level normalized',
    clampedLog.level === 'info' && clampedLog.message.length === 2_000,
    `${clampedLog.level}/${clampedLog.message.length}`,
  );

  const diagnostics = hostPolicy.normalizeHostDiagnostics([
    { path: 'a.ts', message: 'bad', startLine: -5, startColumn: -2, endLine: -9, endColumn: 3, severity: 'warning' },
    { path: 'b.ts', message: '' },
    { message: 'no path' },
    { path: 'c.ts', message: 'inverted', startLine: 9, endLine: 2 },
  ]);
  check(
    'diagnostics are clamped, ordered, and dropped when unusable',
    diagnostics.length === 2 &&
      diagnostics[0].startLine === 0 &&
      diagnostics[0].startColumn === 0 &&
      diagnostics[0].severity === 'warning' &&
      diagnostics[1].endLine >= diagnostics[1].startLine,
    JSON.stringify(diagnostics.map((d) => `${d.path}:${d.startLine}-${d.endLine}`)),
  );
  check(
    'the diagnostics per publish are bounded',
    hostPolicy.normalizeHostDiagnostics(
      Array.from({ length: 5_000 }, () => ({ path: 'a.ts', message: 'x' })),
    ).length === hostPolicy.MAX_HOST_DIAGNOSTICS,
  );

  // =========================================================================
  lines.push('', '--- extension host wiring ---');
  const supervisor = read('src/main/services/marketplaceHost.ts');
  check(
    'the host is a utility process, and the only launcher',
    supervisor.includes('utilityProcess.fork(') &&
      !/ELECTRON_RUN_AS_NODE|process\.execPath|child_process|\bspawn\(/.test(supervisor),
  );
  check(
    'consent is read before a process starts and a refusal is remembered',
    supervisor.includes('await readHostConsent(record.extensionId)') &&
      supervisor.includes("consent === 'denied'") &&
      supervisor.includes("writeHostConsent(record.extensionId, answer === 'Never allow' ? 'denied' : 'unset')"),
  );
  check(
    'the consent prompt states the privilege in plain terms',
    /full privileges/.test(supervisor) && /read and write your files/.test(supervisor),
  );
  check(
    'every request is validated before a handler sees it',
    supervisor.includes('validateHostRequest(message.kind, message.payload)') &&
      supervisor.includes('if (!validated.ok)'),
  );
  check(
    'file access goes through the same authorization as the renderer',
    supervisor.includes('assertAuthorizedPath(raw, options)') &&
      /case 'workspace\.readFile': \{\n\s+const target = await authorizedPath/.test(supervisor),
  );
  check(
    'diagnostic paths are authorized before they reach the UI',
    /authorizedPath\(entry\.path, \{ allowMissing: true \}\)/.test(supervisor),
  );
  check(
    'writes and deletions are audited',
    supervisor.includes("appendAudit(\n        'extension.host.write'") ||
      supervisor.includes("'extension.host.write'"),
  );
  check(
    'a crash loop stops and reaches the user',
    supervisor.includes('decideCrashResponse(') &&
      supervisor.includes("'disabled-after-crashes'") &&
      supervisor.includes('IPC.hostCrashLoop'),
  );
  check(
    'only the crashed extension is restarted',
    /record\.restartTimer = setTimeout\(/.test(supervisor) &&
      supervisor.includes('spawnHost(record,') &&
      !/stopAllExtensionHosts\(\)[\s\S]{0,200}onExit/.test(supervisor),
  );
  check(
    'activation is lazy: startup, language and command paths are separate',
    supervisor.includes('export async function activateEagerExtensions(') &&
      supervisor.includes('export async function activateForLanguage(') &&
      supervisor.includes('export async function runExtensionCommand('),
  );
  check(
    'an entry point outside its own package is refused',
    /rel\.startsWith\('\.\.'\) \|\| isAbsolute\(rel\)/.test(supervisor),
  );
  check(
    'an extension reads only its own settings plus a shared editor set',
    supervisor.includes('SHARED_CONFIGURATION_KEYS') &&
      /key\.startsWith\(prefix\)/.test(supervisor),
  );

  const worker = read('src/main/extensionHostWorker.ts');
  // Comments are stripped first. The file's own documentation names the APIs it deliberately
  // does not use, and an assertion that cannot tell prose from code would be satisfied by
  // deleting the explanation — exactly backwards.
  const workerCode = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check(
    'the worker cannot reach Electron, a window, or the renderer',
    !/require\((['"])electron\1\)|from ['"]electron['"]/.test(workerCode) &&
      !/ipcRenderer|BrowserWindow|webContents/.test(workerCode),
  );
  check(
    'the shim is installed by intercepting exactly one module specifier',
    worker.includes("specifier === 'vscode' ? vscodeApi") &&
      worker.includes('original.call(moduleApi, specifier, parent, isMain)'),
  );
  check(
    'unimplemented API members throw with their own name instead of returning undefined',
    worker.includes('is not implemented by AXIOM') &&
      worker.includes('function strictNamespace') &&
      /notImplemented\(`\$\{name\}\.\$\{String\(property\)\}`\)/.test(worker),
  );
  check(
    'secrets and settings writes are refused rather than emulated',
    worker.includes("notImplemented('ExtensionContext.secrets')") &&
      /AXIOM does not let extensions write settings/.test(worker),
  );
  check(
    'the API surface covers the contribution points extensions actually use',
    ['commands:', 'window:', 'workspace:', 'languages:', 'env:', 'extensions:'].every((entry) =>
      worker.includes(entry),
    ) &&
      ['registerCommand', 'createStatusBarItem', 'createOutputChannel', 'createDiagnosticCollection', 'showQuickPick', 'showInputBox', 'withProgress'].every(
        (member) => worker.includes(member),
      ),
  );

  const hostBridge = read('src/renderer/src/workbench/ExtensionHostBridge.tsx');
  check(
    'the window reports the active editor so language activation can happen',
    hostBridge.includes('reportActiveEditor(activePath ?? null, languageForPath(activePath ?? null)'),
  );
  check(
    'extension prompts are answered by the user, one at a time',
    hostBridge.includes('window.axiom.host.onPrompt(') &&
      hostBridge.includes('answerPrompt(current.id, value)') &&
      /setQueue\(\(pending\) => \[\.\.\.pending, request\]\)/.test(hostBridge),
  );
  check(
    'a dismissed prompt answers null rather than inventing a choice',
    hostBridge.includes('onClose={() => answer(null)}'),
  );
  check(
    'invocable extension commands are registered in the palette',
    hostBridge.includes('if (!command.invocable) continue;') &&
      hostBridge.includes('window.axiom.host.runCommand(command.command, [], rootPath ?? null)'),
  );
  check(
    'a crash loop is reported to the user with what to do next',
    /crashed \$\{info\.crashes\} times and was stopped/.test(hostBridge),
  );
  check(
    'the bridge is mounted once for the window',
    read('src/renderer/src/App.tsx').includes('<ExtensionHostBridge />'),
  );

  const hostPanel = read('src/renderer/src/workbench/ExtensionHostPanel.tsx');
  check(
    'the user can allow, refuse, stop, restart and inspect every extension that runs code',
    ['setConsent(host.extensionId, true', 'setConsent(host.extensionId, false', 'host.stop(', 'host.restart(', 'host.output('].every(
      (fragment) => hostPanel.includes(fragment),
    ),
  );
  check(
    'every host state is named for the user rather than collapsed to on/off',
    ['inactive', 'starting', 'active', 'failed', 'crashed', 'disabled-after-crashes'].every((state) =>
      hostPanel.includes(state),
    ),
  );
  check(
    'the panel repeats the privilege warning where the user acts on it',
    /full\s*\n?\s*privileges/.test(hostPanel),
  );

  const fuses = fs.readFileSync(path.join('apps', 'desktop', 'scripts', 'after-pack-fuses.cjs'), 'utf8');
  check(
    'the packaged extension host is a mandatory, inspected graph root',
    fuses.includes("PACKAGED_EXTENSION_HOST_ENTRY = 'out/main/extensionHostWorker.js'") &&
      fuses.includes('PACKAGED_EXTENSION_HOST_ENTRY,') &&
      fuses.includes("throw new Error('Packaged Main lost the out-of-process extension host launcher.')"),
  );
  check(
    'the extension host is built as its own bundle',
    read('electron.vite.config.ts').includes(
      "extensionHostWorker: resolve(__dirname, 'src/main/extensionHostWorker.ts')",
    ),
  );
  check(
    'the extension host threat model is written down',
    (() => {
      const doc = fs.readFileSync(path.join('docs', 'security-architecture.md'), 'utf8');
      return (
        doc.includes('executable extension entry points are rejected') &&
        doc.includes('`utilityProcess.fork` is the only launcher') &&
        doc.includes('One process per extension') &&
        doc.includes('Consent is per extension and precedes the first process')
      );
    })(),
  );

  const csp = read('src/main/runtimeSecurity.ts');
  check(
    'the production CSP grants WebAssembly compilation and nothing else new',
    csp.includes("'script-src': [\"'self'\", \"'wasm-unsafe-eval'\"]") &&
      !/'unsafe-eval'[^\n]*script-src/.test(csp),
  );
  check(
    'the WebAssembly grant is documented in the security architecture',
    fs.readFileSync(path.join('docs', 'security-architecture.md'), 'utf8').includes(
      "`script-src` is `'self' 'wasm-unsafe-eval'`",
    ),
  );

  flush();
}

main().catch((error) => {
  const cause = error instanceof Error && error.cause ? ` cause=${String(error.cause)}` : '';
  check('the probe ran to completion', false, `${error instanceof Error ? error.message : String(error)}${cause}`);
  if (error instanceof Error && error.stack) note(error.stack.split('\n').slice(1, 5).join(' | '));
  flush();
});
