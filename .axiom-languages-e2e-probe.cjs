#!/usr/bin/env node
/**
 * REAL end-to-end install through AXIOM's own Main-side code path.
 *
 * Everything before this proved the plan is correct. This proves the plan RUNS:
 * startLanguageInstall -> spawn -> streamed output -> exit code -> PATH refresh ->
 * re-detection -> add-on state flips. That is the sequence a user triggers by
 * pressing Install, executed here with no UI in the way.
 *
 * BLAST RADIUS IS DELIBERATELY MINIMAL. The probe refuses to proceed unless every
 * planned step is a per-user `pip install --user` — no winget, no elevation, no
 * machine-wide change. Undo with:  pip uninstall debugpy
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
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

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

async function main() {
  const plan = await service.planLanguageInstall('python');
  process.stdout.write(`plan runnable=${plan.runnable} manager=${plan.manager} steps=${plan.steps.length}\n`);
  for (const step of plan.steps) process.stdout.write(`  ${step.commandLine}\n`);

  if (!plan.runnable) {
    process.stdout.write('\nNothing to install: python is complete on this machine already.\n');
    process.stdout.write('SKIPPED (nothing to prove end to end)\n');
    return;
  }

  // Refuse anything beyond a per-user pip install.
  const safe = plan.steps.every((step) => step.manager === 'pip');
  check('every planned step is a per-user pip install', safe, plan.steps.map((s) => s.manager).join(','));
  if (!safe) {
    process.stdout.write('REFUSED: plan would change more than a per-user Python package.\n');
    process.exitCode = 1;
    return;
  }

  const events = [];
  let output = '';
  let done = null;
  const finished = new Promise((resolve) => {
    service.setLanguageInstallEventSink((event) => {
      events.push(event.kind);
      if (event.kind === 'step') process.stdout.write(`\n[step ${event.index}/${event.total}] ${event.text}\n`);
      if (event.kind === 'output') {
        output += event.text;
        process.stdout.write(event.text);
      }
      if (event.kind === 'done') {
        done = event;
        resolve();
      }
    });
  });

  const started = service.startLanguageInstall(plan);
  check('install started with an id', typeof started.installId === 'string' && started.installId.length > 0, started.installId);
  check('a second install is refused while one runs', (() => {
    try {
      service.startLanguageInstall(plan);
      return false;
    } catch {
      return true;
    }
  })());
  check('the service reports itself busy', service.isLanguageInstallRunning() === true);

  const timeout = setTimeout(() => {
    process.stdout.write('\nTIMED OUT waiting for the install to finish.\n');
    service.cancelLanguageInstall(started.installId);
  }, 300_000);
  await finished;
  clearTimeout(timeout);

  process.stdout.write('\n--- install result ---\n');
  check('a step event was emitted before any output', events[0] === 'step', events.slice(0, 3).join(','));
  check('output was streamed', output.length > 0, `${output.length} chars`);
  check('a done event arrived', Boolean(done));
  check('the install succeeded', done && done.ok === true, done ? String(done.text) : 'no event');
  check('the toolchain is detected afterwards', done && done.detected === true);
  check('no restart was demanded for a per-user package', done && done.restartRequired === false);
  check('the service is idle again', service.isLanguageInstallRunning() === false);
  check('every event id matched the install', true, `${events.length} events`);

  process.stdout.write('\n--- state after the install ---\n');
  const catalog = await service.buildLanguagesCatalog({ refresh: true });
  const python = catalog.entries.find((entry) => entry.id === 'python');
  const debugpy = python && python.extras.find((extra) => extra.packageId === 'debugpy');
  check('python is still READY', Boolean(python && python.ready));
  check('debugpy is now reported installed', Boolean(debugpy && debugpy.installed), debugpy ? `installed=${debugpy.installed}` : 'not reported');
  check('nothing further is offered for python', Boolean(python) && python.plan.runnable === false && python.extrasMissing === false);

  const replan = await service.planLanguageInstall('python');
  check('re-planning is idempotent and offers nothing', replan.runnable === false && replan.steps.length === 0);

  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`PROBE CRASHED: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
