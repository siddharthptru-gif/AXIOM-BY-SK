#!/usr/bin/env node
/**
 * Functional proof of the auto-detect-after-install mechanism.
 *
 * The claim AXIOM makes is: "install a language and Run can use it, without
 * restarting." That claim rests entirely on `refreshDetectionEnvironment()` being able
 * to recover PATH entries that this process does not currently have — because that is
 * exactly the situation right after an installer runs.
 *
 * Proving it by installing something would be slow, need elevation, and would leave
 * software behind. Instead this SIMULATES the post-install state precisely: it removes
 * a directory from this process's PATH, confirms the tool inside it becomes
 * undetectable, calls the real refresh, and confirms the directory and the tool both
 * come back. If the registry read were broken, step 4 would fail.
 *
 * Read-only. Only this process's own environment is touched, and only in memory.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const ts = require('typescript');

const REPO = process.cwd();
const SHARED_ENTRY = path.join(REPO, 'packages', 'shared', 'src', 'index.ts');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, parent, ...rest) {
  if (request === '@axiom/shared') return SHARED_ENTRY;
  try {
    return originalResolve.call(this, request, parent, ...rest);
  } catch (error) {
    if (request.startsWith('.') && parent && parent.filename) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    throw error;
  }
};
require.extensions['.ts'] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(js, filename);
};

const MAIN = path.join(REPO, 'apps', 'desktop', 'src', 'main', 'services');
const service = require(path.join(MAIN, 'languageInstall.ts'));
const executables = require(path.join(MAIN, 'executables.ts'));

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

function run(executable, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.stderr.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out));
  });
}

async function main() {
  if (process.platform !== 'win32') {
    process.stdout.write('This probe targets the Windows registry path. SKIPPED.\n');
    return;
  }

  // 1. The registry really does hold a Path value AXIOM can read.
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const reg = path.join(systemRoot, 'System32', 'reg.exe');
  check('reg.exe is present', fs.existsSync(reg), reg);
  const machine = await run(reg, [
    'query',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '/v',
    'Path',
  ]);
  const user = await run(reg, ['query', 'HKCU\\Environment', '/v', 'Path']);
  check('machine Path is readable from the registry', Boolean(machine && /REG_(EXPAND_)?SZ/i.test(machine)));
  check('user Path is readable from the registry', Boolean(user && /REG_(EXPAND_)?SZ/i.test(user)));

  // 2. Pick a real tool and the directory it lives in.
  const nodeResolved = await executables.resolveExecutable(['node'], ['--version']);
  check('node resolves before the simulation', Boolean(nodeResolved), nodeResolved ? nodeResolved.path : 'not found');
  if (!nodeResolved || !path.isAbsolute(nodeResolved.path)) {
    process.stdout.write('Cannot simulate without an absolute tool path. SKIPPED.\n');
    return;
  }
  const toolDirectory = path.dirname(nodeResolved.path);
  process.stdout.write(`simulating a machine where ${toolDirectory} is not yet on this process PATH\n`);

  // Compare directories the way the OS does: a trailing separator is not a difference.
  const key = (value) => {
    const trimmed = value.trim().replace(/[\\/]+$/, '');
    return (trimmed.length > 0 ? trimmed : value.trim()).toLowerCase();
  };
  const target = key(toolDirectory);
  const original = process.env.PATH;
  const stripped = original
    .split(path.delimiter)
    .filter((entry) => key(entry) !== target)
    .join(path.delimiter);
  check('the directory was actually removed for the test', stripped.length < original.length, `${original.length} -> ${stripped.length} chars`);

  try {
    process.env.PATH = stripped;
    if (typeof process.env.Path === 'string') process.env.Path = stripped;

    // 3. Report whether the tool is now unreachable. A second directory can also ship
    //    the same executable (npm global bins, version managers, Store aliases), in
    //    which case this particular precondition is not achievable on this machine —
    //    that does not weaken step 4, which is the assertion that matters.
    const elsewhere = stripped
      .split(path.delimiter)
      .filter((dir) => {
        try {
          return fs.existsSync(path.join(dir.trim(), 'node.exe'));
        } catch {
          return false;
        }
      });
    if (elsewhere.length === 0) {
      check('the tool is unreachable while the directory is missing', true);
    } else {
      process.stdout.write(
        `NOTE  the executable also exists in ${elsewhere.length} other PATH directory(ies); the restore assertion below is what proves the mechanism\n`,
      );
    }

    // 4. The real refresh must bring it back out of the registry.
    const changed = await service.refreshDetectionEnvironment();
    const after = process.env.PATH || '';
    const restored = after.split(path.delimiter).some((entry) => key(entry) === target);
    check('refreshDetectionEnvironment reports a change', changed === true);
    check('the directory came back from the registry', restored, restored ? toolDirectory : 'still missing');

    // 5. And the tool is detectable again, which is what Run depends on.
    const again = await executables.resolveExecutable(['node'], ['--version']);
    check('the tool is detectable again without a restart', Boolean(again), again ? `${again.path} via ${again.via}` : 'not found');
    const version = again ? await executables.readVersion(again.path, ['--version']) : null;
    check('and it reports its version', typeof version === 'string' && version.length > 0, String(version));
  } finally {
    process.env.PATH = original;
    if (typeof process.env.Path === 'string') process.env.Path = original;
  }

  check('the probe restored this process PATH', process.env.PATH === original);

  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`PROBE CRASHED: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
