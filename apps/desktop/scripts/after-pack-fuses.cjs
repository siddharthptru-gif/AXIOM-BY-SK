'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;

const FUSE_POLICY = Object.freeze({
  RunAsNode: true,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
});

function packagedExecutablePath(context) {
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (
    typeof productFilename !== 'string' ||
    !/^[A-Za-z0-9 ._-]{1,100}$/.test(productFilename) ||
    productFilename === '.' ||
    productFilename === '..'
  ) {
    throw new Error('Cannot determine a safe packaged product executable name.');
  }
  if (context.electronPlatformName === 'win32') {
    return path.join(context.appOutDir, `${productFilename}.exe`);
  }
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${productFilename}.app`);
  }
  return path.join(context.appOutDir, productFilename);
}

function assertFuseWire(actual, api) {
  if (actual.version !== api.FuseVersion.V1) {
    throw new Error(`Unexpected Electron fuse wire version: ${String(actual.version)}`);
  }
  for (const [name, enabled] of Object.entries(FUSE_POLICY)) {
    const option = api.FuseV1Options[name];
    if (typeof option !== 'number') throw new Error(`Unknown Electron fuse option: ${name}`);
    const expected = enabled ? api.FuseState.ENABLE : api.FuseState.DISABLE;
    if (actual[option] !== expected) {
      throw new Error(`Packaged Electron fuse verification failed for ${name}.`);
    }
  }
}

async function readExact(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error('Unexpected end of ASAR header.');
    offset += bytesRead;
  }
}

/** Hash the JSON header string exactly as Electron's official packaging tooling does. */
async function hashAsarHeader(asarPath) {
  const handle = await fs.open(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    await readExact(handle, prefix, 0);
    const sizePickleBytes = prefix.readUInt32LE(0);
    const headerBytes = prefix.readUInt32LE(4);
    const headerPicklePayloadBytes = prefix.readUInt32LE(8);
    const headerStringBytes = prefix.readUInt32LE(12);
    if (
      sizePickleBytes !== 4 ||
      headerBytes < 8 ||
      headerBytes > MAX_ASAR_HEADER_BYTES ||
      headerPicklePayloadBytes !== headerBytes - 4 ||
      headerStringBytes === 0 ||
      headerStringBytes > headerBytes - 8
    ) {
      throw new Error('Packaged app.asar has an invalid or oversized header.');
    }
    const header = Buffer.alloc(headerStringBytes);
    await readExact(handle, header, 16);
    const parsed = JSON.parse(header.toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.files ||
      typeof parsed.files !== 'object'
    ) {
      throw new Error('Packaged app.asar header does not contain a file table.');
    }
    return createHash('sha256').update(header).digest('hex');
  } finally {
    await handle.close();
  }
}

function windowsIntegrityPayload(headerHash) {
  if (!/^[0-9a-f]{64}$/.test(headerHash)) throw new Error('Invalid ASAR header hash.');
  return Buffer.from(
    JSON.stringify([
      {
        file: 'resources\\app.asar',
        alg: 'SHA256',
        value: headerHash,
      },
    ]),
    'utf8',
  );
}

async function updateWindowsIntegrityResource(executable, payload, mode) {
  if (process.platform !== 'win32') {
    throw new Error('Windows ASAR integrity resource embedding requires a Windows release host.');
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error('Cannot resolve the trusted Windows PowerShell runtime.');
  }
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = path.join(__dirname, 'set-windows-asar-integrity.ps1');
  const [powershellStat, scriptStat] = await Promise.all([fs.lstat(powershell), fs.lstat(script)]);
  if (!powershellStat.isFile() || !scriptStat.isFile() || scriptStat.isSymbolicLink()) {
    throw new Error('Windows ASAR integrity tooling is unavailable or unsafe.');
  }
  await execFileAsync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ExecutablePath',
      executable,
      '-PayloadBase64',
      payload.toString('base64'),
      '-Mode',
      mode,
    ],
    {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: {
        SystemRoot: systemRoot,
        WINDIR: process.env.WINDIR || systemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  );
}

const EXPECTED_NODE_PTY_RUNTIME_FILES = Object.freeze(
  [
    'node_modules/node-pty/build/Release/conpty/conpty.dll',
    'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
    'node_modules/node-pty/build/Release/conpty_console_list.node',
    'node_modules/node-pty/build/Release/conpty.node',
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/node-pty/build/Release/winpty-agent.exe',
    'node_modules/node-pty/build/Release/winpty.dll',
  ].sort(),
);

function normalizeAsarEntry(entry) {
  return String(entry).replaceAll('\\', '/').replace(/^\/+/, '');
}

const PACKAGED_MAIN_ENTRY = 'out/main/index.js';
const PACKAGED_EXTENSION_SANDBOX_ENTRY = 'out/main/extensionSandboxWorker.js';
/**
 * The extension host, forked as its own process.
 *
 * A third root rather than a chunk of Main, because that is exactly what it is: `utilityProcess.fork`
 * loads this file as an independent program. Listing it here means the packaged bundle is
 * inspected — and required to exist — with the same strictness as Main itself, and it keeps the
 * reachability rule below meaningful: every JavaScript file in the package must be reachable
 * from one of the three declared entry points, so a stray bundle is still a failure.
 */
const PACKAGED_EXTENSION_HOST_ENTRY = 'out/main/extensionHostWorker.js';
const MAX_REACHABLE_MAIN_BUNDLES = 256;
const MAX_REACHABLE_MAIN_BYTES = 64 * 1024 * 1024;

function resolveAsarJavaScriptDependency(entries, importer, specifier) {
  if (
    typeof specifier !== 'string' ||
    (!specifier.startsWith('./') && !specifier.startsWith('../')) ||
    specifier.includes('\\') ||
    specifier.includes('\0') ||
    specifier.includes('?') ||
    specifier.includes('#')
  ) {
    throw new Error(`Packaged Main contains an unsafe relative module reference: ${specifier}.`);
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (!base.startsWith('out/main/') || base === 'out/main') {
    throw new Error(`Packaged Main module reference escapes its bundle root: ${specifier}.`);
  }
  const candidates = path.posix.extname(base)
    ? [base]
    : [`${base}.js`, path.posix.join(base, 'index.js')];
  const matches = candidates.filter((candidate) => entries.has(candidate));
  if (matches.length !== 1 || !matches[0].endsWith('.js')) {
    throw new Error(`Packaged Main module reference could not be resolved safely: ${specifier}.`);
  }
  return matches[0];
}

function collectAsarJavaScriptGraph(asar, asarPath, rawEntries, roots) {
  const entries = new Set(rawEntries.map(normalizeAsarEntry));
  const queue = roots.map(normalizeAsarEntry);
  const graph = new Map();
  let totalBytes = 0;
  while (queue.length > 0) {
    const entry = queue.shift();
    if (graph.has(entry)) continue;
    if (!entries.has(entry) || !entry.startsWith('out/main/') || !entry.endsWith('.js')) {
      throw new Error(`Required packaged Main JavaScript entry missing: ${entry}`);
    }
    if (graph.size >= MAX_REACHABLE_MAIN_BUNDLES) {
      throw new Error('Packaged Main JavaScript graph exceeds the bundle-count limit.');
    }
    const bundle = asar.extractFile(asarPath, path.join(...entry.split('/')));
    if (!Buffer.isBuffer(bundle)) {
      throw new Error(`Packaged Main JavaScript entry could not be inspected: ${entry}`);
    }
    totalBytes += bundle.length;
    if (totalBytes > MAX_REACHABLE_MAIN_BYTES) {
      throw new Error('Packaged Main JavaScript graph exceeds the inspection size limit.');
    }
    graph.set(entry, bundle);
    const source = bundle.toString('utf8');
    for (const match of source.matchAll(/\b(?:require|import)\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g)) {
      const dependency = resolveAsarJavaScriptDependency(entries, entry, match[2]);
      if (!graph.has(dependency)) queue.push(dependency);
    }
  }
  return graph;
}

function collectReachableMainBundles(asar, asarPath, rawEntries) {
  const normalizedEntries = rawEntries.map(normalizeAsarEntry);
  const application = collectAsarJavaScriptGraph(asar, asarPath, rawEntries, [PACKAGED_MAIN_ENTRY]);
  const extensionSandbox = collectAsarJavaScriptGraph(asar, asarPath, rawEntries, [
    PACKAGED_EXTENSION_SANDBOX_ENTRY,
  ]);
  const extensionHost = collectAsarJavaScriptGraph(asar, asarPath, rawEntries, [
    PACKAGED_EXTENSION_HOST_ENTRY,
  ]);
  const inspectedBundles = new Map([...application, ...extensionSandbox, ...extensionHost]);
  const unreachable = normalizedEntries.filter(
    (entry) =>
      entry.startsWith('out/main/') && entry.endsWith('.js') && !inspectedBundles.has(entry),
  );
  if (unreachable.length > 0) {
    throw new Error(`Packaged Main contains unreachable JavaScript: ${unreachable.join(', ')}`);
  }
  return [...inspectedBundles.values()];
}

function assertAsarEntryPolicy(rawEntries, mainBundle) {
  if (!Array.isArray(rawEntries)) throw new Error('Cannot inspect packaged ASAR entries.');
  const entries = rawEntries.map(normalizeAsarEntry);
  const forbidden = [
    /^node_modules\/node-addon-api(?:\/|$)/i,
    /^node_modules\/node-pty\/(?:bin|src|typings|scripts|deps|node-addon-api|third_party|prebuilds)(?:\/|$)/i,
    /\.(?:map|pdb|ts|tsx)$/i,
    /(?:^|\/)process\.env\.GITHUB_CLIENT_SECRET$/i,
  ];
  const allowedNodePtyBuildEntries = new Set([
    'node_modules/node-pty/build',
    'node_modules/node-pty/build/Release',
    'node_modules/node-pty/build/Release/conpty',
    ...EXPECTED_NODE_PTY_RUNTIME_FILES,
  ]);
  for (const entry of entries) {
    if (
      forbidden.some((pattern) => pattern.test(entry)) ||
      (entry.startsWith('node_modules/node-pty/build/') && !allowedNodePtyBuildEntries.has(entry))
    ) {
      throw new Error(`Forbidden packaged ASAR entry: ${entry}`);
    }
  }
  for (const required of [
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/lib/index.js',
    PACKAGED_MAIN_ENTRY,
    PACKAGED_EXTENSION_SANDBOX_ENTRY,
    PACKAGED_EXTENSION_HOST_ENTRY,
  ]) {
    if (!entries.includes(required))
      throw new Error(`Required packaged ASAR entry missing: ${required}`);
  }
  const bundles = Array.isArray(mainBundle) ? mainBundle : [mainBundle];
  if (bundles.length === 0) throw new Error('Cannot inspect reachable packaged Main bundles.');
  const source = bundles
    .map((bundle) => (Buffer.isBuffer(bundle) ? bundle.toString('utf8') : String(bundle ?? '')))
    .join('\n');
  const runAsNodeCount = source.match(/ELECTRON_RUN_AS_NODE/g)?.length ?? 0;
  if (runAsNodeCount !== 2) {
    throw new Error(
      `Packaged Main must contain exactly two reachable RunAsNode consumers; found ${runAsNodeCount}.`,
    );
  }
  if (!source.includes('Executable extensions are disabled until')) {
    throw new Error('Packaged Main does not retain executable-extension rejection.');
  }
  if (source.includes('bootstrap.cjs') || source.includes('Extension host activated')) {
    throw new Error('Dormant executable extension-host activation code entered packaged Main.');
  }
  /**
   * The extension host runs out of process, and only that way.
   *
   * `utilityProcess.fork` is the one primitive allowed to start it: it gives a Node process
   * without `ELECTRON_RUN_AS_NODE`, without re-launching `process.execPath`, and without a
   * window. If a future change reaches for `child_process` or the RunAsNode environment
   * variable instead, the fuse policy asserted above stops describing what actually happens —
   * so that substitution has to fail here rather than ship.
   */
  if (!source.includes('utilityProcess.fork')) {
    throw new Error('Packaged Main lost the out-of-process extension host launcher.');
  }
  return entries;
}

function assertUnpackedInventory(rawRecords) {
  if (!Array.isArray(rawRecords)) throw new Error('Cannot inspect ASAR unpacked inventory.');
  const records = rawRecords
    .map((record) => ({ ...record, relative: normalizeAsarEntry(record.relative) }))
    .sort((left, right) =>
      left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
    );
  const names = records.map((record) => record.relative);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_NODE_PTY_RUNTIME_FILES)) {
    throw new Error(`Unexpected ASAR unpacked inventory: ${names.join(', ')}`);
  }
  for (const record of records) {
    if (record.isSymbolicLink || !record.isFile) {
      throw new Error(`ASAR unpacked entry is not a regular non-reparse file: ${record.relative}`);
    }
    if (record.machine !== 0x8664) {
      throw new Error(`ASAR unpacked entry is not Windows x64 PE: ${record.relative}`);
    }
  }
}

async function readPortableExecutableMachine(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    await readExact(handle, dos, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d)
      throw new Error(`Unpacked native file is not PE: ${path.basename(filename)}`);
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 4 * 1024 * 1024)
      throw new Error('Unpacked PE header offset is unsafe.');
    const pe = Buffer.alloc(6);
    await readExact(handle, pe, peOffset);
    if (pe.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Unpacked native file has no PE signature: ${path.basename(filename)}`);
    }
    return pe.readUInt16LE(4);
  } finally {
    await handle.close();
  }
}

async function collectUnpackedRecords(root, relative = '') {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const normalized = childRelative.replaceAll('\\', '/');
    const absolute = path.join(root, childRelative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      records.push({ relative: normalized, isFile: false, isSymbolicLink: true, machine: null });
      continue;
    }
    if (stat.isDirectory()) {
      records.push(...(await collectUnpackedRecords(root, childRelative)));
      continue;
    }
    records.push({
      relative: normalized,
      isFile: stat.isFile(),
      isSymbolicLink: false,
      machine: stat.isFile() ? await readPortableExecutableMachine(absolute) : null,
    });
  }
  return records;
}

async function assertPackagedAsarPolicy(asarPath, unpackedRoot) {
  const asar = require('@electron/asar');
  const rawEntries = asar.listPackage(asarPath);
  const entries = assertAsarEntryPolicy(
    rawEntries,
    collectReachableMainBundles(asar, asarPath, rawEntries),
  );
  assertUnpackedInventory(await collectUnpackedRecords(unpackedRoot));
  for (const relative of EXPECTED_NODE_PTY_RUNTIME_FILES) {
    if (!entries.includes(relative))
      throw new Error(`Unpacked ASAR placeholder missing: ${relative}`);
  }
}

async function afterPack(context) {
  const api = await import('@electron/fuses');
  const executable = packagedExecutablePath(context);
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  const [executableStat, asarStat] = await Promise.all([fs.lstat(executable), fs.lstat(asarPath)]);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new Error('Packaged Electron executable is not a regular file.');
  }
  if (!asarStat.isFile() || asarStat.isSymbolicLink()) {
    throw new Error('OnlyLoadAppFromAsar requires a regular resources/app.asar file.');
  }
  await assertPackagedAsarPolicy(asarPath, `${asarPath}.unpacked`);

  let windowsPayload = null;
  if (context.electronPlatformName === 'win32') {
    windowsPayload = windowsIntegrityPayload(await hashAsarHeader(asarPath));
    await updateWindowsIntegrityResource(executable, windowsPayload, 'set');
  }

  const config = {
    version: api.FuseVersion.V1,
    strictlyRequireAllFuses: true,
  };
  for (const [name, enabled] of Object.entries(FUSE_POLICY)) {
    config[api.FuseV1Options[name]] = enabled;
  }

  await api.flipFuses(executable, config);
  const actual = await api.getCurrentFuseWire(executable);
  assertFuseWire(actual, api);
  if (windowsPayload) {
    await updateWindowsIntegrityResource(executable, windowsPayload, 'verify');
    console.log(
      '[release-hardening] Windows ElectronAsar resource and Electron fuses applied and verified before signing.',
    );
  } else {
    console.log('[release-hardening] Electron fuses applied and verified before signing.');
  }
}

module.exports = afterPack;
module.exports.FUSE_POLICY = FUSE_POLICY;
module.exports.EXPECTED_NODE_PTY_RUNTIME_FILES = EXPECTED_NODE_PTY_RUNTIME_FILES;
module.exports.assertAsarEntryPolicy = assertAsarEntryPolicy;
module.exports.collectReachableMainBundles = collectReachableMainBundles;
module.exports.assertUnpackedInventory = assertUnpackedInventory;
module.exports.assertPackagedAsarPolicy = assertPackagedAsarPolicy;
module.exports.assertFuseWire = assertFuseWire;
module.exports.hashAsarHeader = hashAsarHeader;
module.exports.packagedExecutablePath = packagedExecutablePath;
module.exports.updateWindowsIntegrityResource = updateWindowsIntegrityResource;
module.exports.windowsIntegrityPayload = windowsIntegrityPayload;
