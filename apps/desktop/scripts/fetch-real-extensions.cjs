'use strict';

/**
 * Populate the real-extension corpus from the live registry.
 *
 * The packages this writes are chosen by AXIOM's own negotiation — `resolveInstallCandidate`,
 * the same call `installOneFromRegistry` makes — rather than by asking for `latest`. That
 * matters for two reasons:
 *
 *  - `latest` is frequently a build no editor at AXIOM's API level can run, so a corpus of
 *    `latest` packages measures the registry's release cadence rather than AXIOM's
 *    compatibility;
 *  - `latest` on an untargeted URL returns an arbitrary target platform (the registry sorts
 *    them alphabetically, so a Windows host is handed `alpine-arm64`), which no host can run.
 *
 * Downloads go through `downloadPackage`, so a package whose bytes disagree with the
 * published digest never reaches the corpus.
 *
 * Usage:
 *   node scripts/fetch-real-extensions.cjs
 *   node scripts/fetch-real-extensions.cjs anthropic.claude-code esbenp.prettier-vscode
 *   AXIOM_VSIX_DIR=/path/to/vsix node scripts/fetch-real-extensions.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ts = require(path.join(repoRoot, 'node_modules', 'typescript'));

const VSIX_DIR = process.env['AXIOM_VSIX_DIR'] ?? path.join(os.tmpdir(), 'axiom-ext', 'vsix');
const SCRATCH = path.join(os.tmpdir(), 'axiom-ext', 'fetch-userData');

/** The acceptance set from the brief: one extension per capability family that matters. */
const DEFAULT_IDS = [
  'anthropic.claude-code',
  'continue.continue',
  'saoudrizwan.claude-dev',
  'ms-python.python',
  'esbenp.prettier-vscode',
  'dbaeumer.vscode-eslint',
  'usernamehw.errorlens',
];

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

/** The registry layer only reaches for `app` paths and the log sink's Electron members. */
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
      throw new Error('The fetch harness does not spawn extension host processes.');
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

const registry = load('apps/desktop/src/main/services/openVsxRegistry.ts');

async function fetchOne(id) {
  const candidate = await registry.resolveInstallCandidate(id);
  const downloaded = await registry.downloadPackage(candidate.detail);
  const file = path.join(VSIX_DIR, `${id}.vsix`);
  fs.writeFileSync(file, downloaded.bytes);
  return {
    id,
    version: candidate.detail.version,
    targetPlatform: candidate.targetPlatform,
    negotiated: candidate.negotiated,
    considered: candidate.considered,
    bytes: downloaded.bytes.length,
    integrity: downloaded.integritySummary,
  };
}

async function main() {
  const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;
  fs.mkdirSync(VSIX_DIR, { recursive: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  console.log(`host target platform: ${registry.hostTargetPlatform() ?? 'unknown'}`);
  console.log(`corpus: ${VSIX_DIR}`);
  console.log('');

  let failed = 0;
  for (const id of ids) {
    const started = Date.now();
    try {
      const result = await fetchOne(id);
      console.log(
        `ok      ${id} ${result.version} [${result.targetPlatform ?? 'universal'}] ` +
          `${Math.round(result.bytes / 1024)} KiB, ${result.considered} builds considered, ` +
          `${Date.now() - started} ms`,
      );
    } catch (error) {
      failed += 1;
      console.log(`FAILED  ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
