'use strict';
/**
 * Probe runner. Same reason as .axiom-check.cjs: spawnSync + a written result file is the
 * only reliable way to read a verdict in this shell.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const probes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
const lines = [];
let failed = 0;

for (const probe of probes) {
  const run = spawnSync(process.execPath, [probe], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Some probes report only into their own file (css-check writes css-check.txt and prints
  // nothing). Reading the report as well as stdout means a silent-but-passing probe is not
  // mistaken for one with no verdict.
  const reports = {
    '.axiom-css-check.cjs': 'css-check.txt',
    '.axiom-openvsx-probe.cjs': 'openvsx-probe.txt',
  };
  const report = reports[probe];
  const reported =
    report !== undefined && fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}${reported}`;
  const failures = /FAILURES\s+(\d+)/.exec(text);
  const verdict = failures
    ? `FAILURES ${failures[1]}`
    : /ALL PASS/.test(text)
      ? 'ALL PASS'
      : `NO VERDICT (exit ${run.status})`;
  if (verdict !== 'ALL PASS') failed += 1;
  const counted = /checks (\d+)/.exec(text);
  lines.push(`${probe}: ${verdict}${counted ? ` (${counted[1]} checks)` : ''}`);
  for (const line of text.split('\n').filter((l) => l.startsWith('FAIL'))) {
    lines.push(`    ${line.trim()}`);
  }
}

lines.push('', failed === 0 ? 'PROBES ALL PASS' : `PROBES FAILED ${failed}`);
const body = `${lines.join('\n')}\n`;
fs.writeFileSync(outArg ? outArg.slice('--out='.length) : 'probe-run.txt', body, 'utf8');
process.stdout.write(body);
process.exitCode = failed === 0 ? 0 : 1;
