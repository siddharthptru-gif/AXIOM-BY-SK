/**
 * Verification driver. `execute_pwsh` mangles long command lines in this
 * environment, so each check is run with spawnSync and its result written to a
 * JSON file that can be read back reliably.
 *
 * Usage: node .axiom-check.cjs [name ...]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const CHECKS = {
  'tsc-node': [tsc, '--noEmit', '-p', 'apps/desktop/tsconfig.node.json', '--pretty', 'false'],
  'tsc-web': [tsc, '--noEmit', '-p', 'apps/desktop/tsconfig.web.json', '--pretty', 'false'],
  // The real production bundle. A typecheck can pass while the bundler fails on
  // an unresolvable import or a worker it cannot inline, so this is checked too.
  // No --outDir: vite resolves a relative outDir against each target's `root`, and the
  // renderer's root is src/renderer, so passing one wrote the renderer bundle to
  // apps/desktop/src/renderer/out while apps/desktop/out/renderer kept a stale copy. Letting
  // electron-vite use its own default puts all three bundles exactly where packaging reads
  // them, which is the only output worth checking.
  build: [
    path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    'build',
  ],
  'agentic-chat': ['apps/desktop/scripts/validate-agentic-chat.cjs'],
  'github-scm': ['apps/desktop/scripts/validate-github-scm.cjs'],
  'security-hardening': ['apps/desktop/scripts/validate-security-hardening.cjs'],
  'god-mode': ['apps/desktop/scripts/validate-god-mode.cjs'],
};

const argv = process.argv.slice(2);
// The caller names the output file so it can read exactly the run it started,
// rather than guessing which of several result files is current.
const outArg = argv.find((a) => a.startsWith('--out='));
const names = argv.filter((a) => !a.startsWith('--'));
const selected = names.length > 0 ? names : Object.keys(CHECKS);
const results = [];

for (const name of selected) {
  const args = CHECKS[name];
  if (!args) {
    results.push({ name, status: 'unknown-check' });
    continue;
  }
  const started = Date.now();
  // electron-vite resolves its config relative to the app package, not the repo.
  const cwd = name === 'build' ? path.join(root, 'apps', 'desktop') : root;
  const run = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  results.push({
    name,
    status: run.status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    output: out.length > 24_000 ? `${out.slice(0, 24_000)}\n…[truncated]` : out,
  });
}

// The caller-named output file is written and nothing else is touched: two runs
// overlapping must not be able to delete each other's results.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(
  root,
  outArg ? outArg.slice('--out='.length) : `.axiom-check-${stamp}.json`,
);
const failed = results.filter((r) => r.status !== 0);
const summary = [
  `STAMP ${stamp}`,
  `CHECKS ${results.length}  FAILED ${failed.length}`,
  ...results.map((r) => `${r.name}: status=${r.status} (${r.seconds}s)`),
  ...failed.map((r) => `\n===== ${r.name} =====\n${r.output}`),
].join('\n');
// Plain text alongside the JSON: easier to read back through a tool that may
// truncate or reformat structured output.
fs.writeFileSync(outFile, `${summary}\n\n${JSON.stringify({ stamp, results }, null, 2)}`, 'utf8');
console.log(summary);
