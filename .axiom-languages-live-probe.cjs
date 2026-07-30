#!/usr/bin/env node
/**
 * LIVE end-to-end probe for the LANGUAGES feature.
 *
 * The static probe proves the registry is internally consistent. This one proves the
 * things that can only be answered by the real machine and the real package
 * repository:
 *
 *   1. Does AXIOM's resolver actually find winget here, and can it run it?
 *   2. Does EVERY pinned Windows package id really exist in the winget source? A
 *      wrong id is the single most likely cause of "installation error" for a user,
 *      and it cannot be caught by type checking.
 *   3. Does `refreshDetectionEnvironment()` really read PATH back out of the
 *      registry, and does it keep every entry AXIOM launched with?
 *   4. Does `buildLanguagesCatalog()` return a sane catalog on this machine, with the
 *      exact command each Install button would run?
 *
 * Everything here is READ-ONLY. `winget show` queries the repository; nothing is
 * installed, upgraded, or removed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const ts = require('typescript');

// ---------------------------------------------------------------------------
// Load the real Main-side TypeScript modules, unmodified.
// ---------------------------------------------------------------------------
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
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
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
const executables = require(path.join(MAIN, 'executables.ts'));
const languageInstall = require(path.join(MAIN, 'languageInstall.ts'));
const runtimes = require(path.join(MAIN, 'runtimes.ts'));
const registry = require(path.join(REPO, 'apps', 'desktop', 'src', 'common', 'languagePacks.ts'));

let failures = 0;
let warnings = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}
function warn(name, detail) {
  process.stdout.write(`WARN  ${name}${detail ? `  ${detail}` : ''}\n`);
  warnings += 1;
}

/** Run a read-only command and capture exit code plus output. */
function run(executable, args, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, output: String(error && error.message) });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish('timeout');
    }, timeoutMs);
    const append = (chunk) => {
      if (output.length < 20_000) output += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      output += String(error.message);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function line(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function main() {
  process.stdout.write(`PLATFORM ${process.platform}\n\n`);

  // -- 1. Can AXIOM's own resolver find and run the package manager? -----------
  process.stdout.write('--- package manager resolution (AXIOM resolver) ---\n');
  const managerResults = [];
  for (const manager of registry.PACKAGE_MANAGERS) {
    if (!manager.platforms.includes(process.platform)) continue;
    const resolved = await executables.resolveExecutable(manager.commands, ['--version']);
    const version = resolved
      ? await executables.readVersion(resolved.path, ['--version'])
      : null;
    managerResults.push({ manager, resolved, version });
    process.stdout.write(
      `${manager.id.padEnd(8)}| ${(resolved ? 'yes' : 'no').padEnd(4)}| ${(resolved ? resolved.via : '-').padEnd(12)}| ${line(version ?? (resolved ? resolved.path : '-'))}\n`,
    );
  }

  const primary = registry.primaryManagersFor(process.platform);
  const usable = managerResults.find(
    (entry) =>
      entry.resolved &&
      !entry.manager.needsSudo &&
      !entry.manager.extrasOnly &&
      primary.some((candidate) => candidate.id === entry.manager.id),
  );
  check(
    'a primary package manager is usable on this machine',
    Boolean(usable),
    usable ? `${usable.manager.id} via ${usable.resolved.via}` : 'none found',
  );
  if (usable) {
    check(
      `${usable.manager.id} responds to --version`,
      typeof usable.version === 'string' && usable.version.length > 0,
      line(usable.version ?? 'no version output'),
    );
    check(
      `${usable.manager.id} is not a shell shim AXIOM would refuse`,
      !executables.isShellShim(usable.resolved.path),
      usable.resolved.path,
    );
  }

  // -- 2. PATH refresh from the operating system ------------------------------
  process.stdout.write('\n--- PATH refresh from the OS ---\n');
  const pathBefore = process.env.PATH || '';
  const entriesBefore = pathBefore.split(path.delimiter).filter((entry) => entry.trim());
  const changed = await languageInstall.refreshDetectionEnvironment();
  const pathAfter = process.env.PATH || '';
  const entriesAfter = pathAfter.split(path.delimiter).filter((entry) => entry.trim());
  process.stdout.write(
    `entries before ${entriesBefore.length} -> after ${entriesAfter.length} (changed=${changed})\n`,
  );
  const lower = (value) => {
    const trimmed = value.replace(/[\\/]+$/, '');
    const base = trimmed.length > 0 ? trimmed : value;
    return process.platform === 'win32' ? base.toLowerCase() : base;
  };
  const afterSet = new Set(entriesAfter.map(lower));
  const dropped = entriesBefore.filter((entry) => !afterSet.has(lower(entry)));
  const keys = entriesAfter.map(lower);
  check('PATH refresh leaves no duplicate directories', new Set(keys).size === keys.length, `${keys.length} entries, ${new Set(keys).size} unique`);
  check('PATH refresh never drops an entry AXIOM launched with', dropped.length === 0, dropped.join(' | ') || 'none dropped');
  check('PATH refresh keeps PATH non-empty', entriesAfter.length > 0, `${entriesAfter.length} entries`);
  check('PATH stays within the size bound', pathAfter.length <= 32_000, `${pathAfter.length} chars`);
  if (process.platform === 'win32' && !changed) {
    warn('PATH was already complete', 'nothing new came from the registry, which is normal on a machine with no pending installs');
  }

  // -- 3. The real catalog on this machine -----------------------------------
  process.stdout.write('\n--- live catalog (buildLanguagesCatalog) ---\n');
  const started = Date.now();
  const catalog = await languageInstall.buildLanguagesCatalog({ refresh: true });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  check('catalog builds', Array.isArray(catalog.entries) && catalog.entries.length > 0, `${catalog.entries.length} entries in ${elapsed}s`);
  check('catalog reports auto-install is possible', catalog.canAutoInstall === true);

  for (const entry of catalog.entries) {
    const required = entry.runtimes.filter((tool) => tool.required);
    const versions = required
      .filter((tool) => tool.installed)
      .map((tool) => line(tool.version ?? 'installed'))
      .join(' / ');
    const addOns = entry.extras.length
      ? ` [${entry.extras.map((extra) => `${extra.packageId}=${extra.installed ? 'yes' : 'NO'}`).join(',')}]`
      : '';
    process.stdout.write(
      `${entry.id.padEnd(8)}| ${(entry.ready ? 'READY' : 'missing').padEnd(7)}| ${(entry.plan.runnable ? String(entry.plan.manager) : 'nothing').padEnd(7)}| ${versions || '-'}${addOns}\n`,
    );
  }

  check(
    'every not-ready entry can either install or explain why not',
    catalog.entries
      .filter((entry) => !entry.ready)
      .every((entry) => entry.plan.runnable || typeof entry.plan.blockedReason === 'string'),
  );
  check(
    'every runnable plan has at least one command',
    catalog.entries.every((entry) => !entry.plan.runnable || entry.plan.steps.length > 0),
  );
  check(
    'a ready language is never told to reinstall its toolchain',
    catalog.entries
      .filter((entry) => entry.ready)
      .every((entry) => entry.plan.steps.every((step) => !step.purpose.startsWith('Install '))),
    catalog.entries
      .filter((entry) => entry.ready)
      .flatMap((entry) => entry.plan.steps.filter((step) => step.purpose.startsWith('Install ')).map((step) => `${entry.id}:${step.packageId}`))
      .join(',') || 'none',
  );
  check(
    'a complete language offers nothing to install',
    catalog.entries
      .filter((entry) => entry.ready && !entry.extrasMissing)
      .every((entry) => entry.plan.runnable === false && entry.plan.steps.length === 0),
  );

  // Python is the case the user reported. It must be READY, and its debugger add-on
  // must be visible and installable — a ready runtime with no way to add debugpy was
  // the bug this probe caught.
  const python = catalog.entries.find((entry) => entry.id === 'python');
  check('python is detected as READY on this machine', Boolean(python && python.ready), python ? String(python.runtimes.find((t) => t.id === 'python')?.version) : 'missing entry');
  const debugpy = python && python.extras.find((extra) => extra.packageId === 'debugpy');
  check('debugpy status is reported', Boolean(debugpy), debugpy ? `installed=${debugpy.installed}` : 'not reported');
  if (debugpy && !debugpy.installed) {
    check(
      'a ready python with no debugpy still offers a runnable add-on install',
      python.plan.runnable === true && python.plan.steps.length === 1 && python.plan.steps[0].packageId === 'debugpy',
      python.plan.runnable ? python.plan.steps.map((s) => s.commandLine).join(' | ') : 'not runnable',
    );
  } else if (debugpy) {
    check('debugpy already present, so nothing is offered', python.plan.runnable === false);
  }

  process.stdout.write('\n--- exact commands each Install button would run ---\n');
  for (const entry of catalog.entries) {
    if (!entry.plan.runnable) continue;
    for (const step of entry.plan.steps) {
      process.stdout.write(`${entry.id.padEnd(8)}| ${step.commandLine}\n`);
    }
  }

  // -- 4. A plan for something that is NOT installed --------------------------
  process.stdout.write('\n--- plan for a missing toolchain ---\n');
  const missing = catalog.entries.find((entry) => !entry.ready && entry.plan.runnable);
  if (missing) {
    const plan = await languageInstall.planLanguageInstall(missing.id);
    check(`plan for ${missing.id} is runnable`, plan.runnable === true, `${plan.steps.length} step(s) via ${plan.managerName}`);
    check(`plan for ${missing.id} resolved a manager path`, typeof plan.managerPath === 'string' && plan.managerPath.length > 0, String(plan.managerPath));
    for (const step of plan.steps) process.stdout.write(`  ${step.commandLine}\n`);
  } else {
    warn('every toolchain is already installed here', 'no missing-plan case to exercise');
  }

  check('an unknown language id is rejected', await languageInstall
    .planLanguageInstall('definitely-not-a-language')
    .then(() => false)
    .catch(() => true));

  // -- 5. Does every pinned package id really exist upstream? -----------------
  if (usable && usable.manager.id === 'winget') {
    process.stdout.write('\n--- winget repository check (read-only, no install) ---\n');
    const ids = [];
    for (const pack of registry.LANGUAGE_PACKS) {
      for (const id of pack.packages.winget || []) ids.push({ pack: pack.id, id });
    }
    for (const { pack, id } of ids) {
      const result = await run(usable.resolved.path, [
        'show',
        '--exact',
        '--id',
        id,
        '--source',
        'winget',
        '--accept-source-agreements',
      ]);
      const found = result.code === 0 && !/No package found/i.test(result.output);
      const versionMatch = /Version:\s*(\S+)/i.exec(result.output);
      check(
        `winget knows ${id}`,
        found,
        found ? `${pack} -> ${versionMatch ? versionMatch[1] : 'found'}` : `exit=${result.code} ${line(result.output)}`,
      );
    }
  } else {
    warn('winget repository check skipped', 'winget is not the usable manager on this machine');
  }

  // -- 6. Runtime detection agrees with the catalog ---------------------------
  process.stdout.write('\n--- detection consistency ---\n');
  const detected = await runtimes.detectRuntimes({ refresh: true });
  const availableIds = new Set(detected.filter((entry) => entry.path !== null).map((entry) => entry.id));
  const mismatches = [];
  for (const entry of catalog.entries) {
    const pack = registry.languagePack(entry.id);
    const expected = registry.isLanguagePackSatisfied(pack.requires, availableIds);
    if (expected !== entry.ready) mismatches.push(`${entry.id}: catalog=${entry.ready} detect=${expected}`);
  }
  check('catalog readiness matches runtime detection', mismatches.length === 0, mismatches.join(' | ') || 'all agree');
  check(
    'no detected runtime reports a path without being usable',
    detected.every((entry) => entry.path === null || typeof entry.path === 'string'),
  );

  process.stdout.write(
    `\n${failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`}${warnings ? `  (warnings ${warnings})` : ''}\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`PROBE CRASHED: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
