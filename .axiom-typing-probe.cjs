/**
 * Verifies the pure reveal planner: every frontier advances, the sweep always
 * finishes at the exact end of the block (nothing may stay hidden), and a large
 * block degrades to a line sweep instead of thousands of ticks.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const probe = path.join(root, '.axiom-typing-probe.mts');
const src = fs.readFileSync(
  path.join(root, 'apps', 'desktop', 'src', 'common', 'agentTyping.ts'),
  'utf8',
);

const source = `${src}
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : ''));
}
let failures = 0;

// A small multi-line block: typical "create index.html".
const small = { startLine: 1, lineLengths: [15, 6, 22, 0, 41, 8] };
const s = planReveal(small, { ticks: 20 });
check('small block produces steps', s.length > 0, 'steps=' + s.length);
const sEnd = s[s.length - 1];
check(
  'small block ends at exact end',
  sEnd.line === 6 && sEnd.column === 9,
  'end=' + sEnd.line + ':' + sEnd.column,
);
let monotonic = true;
for (let i = 1; i < s.length; i += 1) {
  const a = s[i - 1];
  const b = s[i];
  if (b.line < a.line || (b.line === a.line && b.column < a.column)) monotonic = false;
}
check('frontier never moves backwards', monotonic);
check('respects tick budget', s.length <= 24, 'steps=' + s.length);

// A single line.
const one = planReveal({ startLine: 7, lineLengths: [30] }, { ticks: 10 });
const oneEnd = one[one.length - 1];
check('single line ends at end', oneEnd.line === 7 && oneEnd.column === 31,
  'end=' + oneEnd.line + ':' + oneEnd.column);

// Empty lines only — must still terminate and finish.
const blanks = planReveal({ startLine: 3, lineLengths: [0, 0, 0] }, { ticks: 5 });
const blankEnd = blanks[blanks.length - 1];
check('blank lines terminate', blankEnd.line === 5 && blankEnd.column === 1,
  'end=' + blankEnd.line + ':' + blankEnd.column);

// Empty block yields nothing.
check('empty block yields no steps', planReveal({ startLine: 1, lineLengths: [] }).length === 0);

// A very large block must switch to the line sweep.
const bigLines = [];
for (let i = 0; i < 3000; i += 1) bigLines.push(40);
const big = { startLine: 1, lineLengths: bigLines };
check('large block exceeds sweep cap', blockCharCount(big) > MAX_CHARACTER_SWEEP_CHARS);
const bigPlan = planRevealForBlock(big);
check('large block uses line sweep', bigPlan.length === 3000, 'steps=' + bigPlan.length);

// A moderate block stays a character sweep and honours the tick budget.
const midPlan = planRevealForBlock({ startLine: 1, lineLengths: [80, 80, 80, 80, 80] }, { ticks: 30 });
check('mid block stays bounded', midPlan.length > 0 && midPlan.length <= 34,
  'steps=' + midPlan.length);

console.log(failures === 0 ? '\\nALL PASS' : '\\n' + failures + ' FAILURE(S)');
`;

fs.writeFileSync(probe, source, 'utf8');
const run = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '.axiom-typing-probe.mts'],
  { cwd: root, encoding: 'utf8' },
);
fs.rmSync(probe, { force: true });
console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`);
