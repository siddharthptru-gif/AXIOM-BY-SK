/**
 * Reproduces the user's exact failing model reply and checks the parser now
 * recognises the action. Run: node .axiom-parse-probe.cjs
 *
 * The two pure modules are concatenated into one file so Node's ESM resolver does
 * not need the extensionless specifier the bundler normally handles.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const probe = path.join(root, '.axiom-parse-probe.mts');
const commonDir = path.join(root, 'apps', 'desktop', 'src', 'common');

const modelText = fs.readFileSync(path.join(commonDir, 'modelText.ts'), 'utf8');
const agentAction = fs
  .readFileSync(path.join(commonDir, 'agentAction.ts'), 'utf8')
  // Drop the cross-module import; both sources live in one file below.
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/modelText';\s*$/m, '');

const failingReply = [
  '<think>Need to send the action JSON. We already used write_file calls. ' +
    'So we must again send one tool call. We will issue: {"tool":"write_file","args":{…}}.\n' +
    "Let's produce content with basic html.</think>",
  '',
  '{"tool":"write_file","args":{"path":"index.html","content":"<!DOCTYPE html>\\n' +
    '<html>\\n<head>\\n<style>\\n  body { margin:0; }\\n  h1 { text-align:center; }\\n' +
    '</style>\\n</head>\\n<body>\\n<h1>Mario Game</h1>\\n<script>\\n' +
    "  console.log('loaded');\\n</script>\\n</body>\\n</html>\"} }",
].join('\n');

const listDirReply =
  '<think>We need to just list_dir to confirm workspace. ' +
  'Use {"tool":"list_dir","args":{"path":"."}}</think>\n\n' +
  '{"tool":"list_dir","args":{"path":"."}}';

const fencedReply =
  'I will first look around.\n\n```bash\nnpm install phaser\n```\n\n' +
  'Now the action:\n\n```json\n{"tool":"read_file","args":{"path":"package.json"}}\n```';

const proseOnly = 'Here is how you could build a Mario game yourself: use Phaser and a tilemap.';

const cases = [
  { name: 'write_file after <think> rehearsal', reply: failingReply, expect: 'write_file' },
  { name: 'list_dir after <think> rehearsal', reply: listDirReply, expect: 'list_dir' },
  { name: 'action after an unrelated bash fence', reply: fencedReply, expect: 'read_file' },
  { name: 'prose with no action stays none', reply: proseOnly, expect: null },
];

const source = `${modelText}\n${agentAction}\n
const tools = ['read_file','list_dir','search_text','write_file','replace_in_file','run_command'];
const cases = ${JSON.stringify(cases)};
let failed = 0;
for (const c of cases) {
  const action = parseModelAction(c.reply, tools);
  const got = action.kind === 'tool' ? action.tool : null;
  const ok = got === c.expect;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name + ' -> kind=' + action.kind + ' tool=' + (got ?? '-'));
  if (ok && c.expect === 'write_file') {
    const content = String(action.args.content ?? '');
    const kept = content.includes('body { margin:0; }');
    console.log('      payload braces preserved: ' + (kept ? 'yes' : 'NO'));
    if (!kept) failed += 1;
  }
  const shown = presentAssistantText(c.reply);
  const leaks = /<think|"tool"\\s*:/.test(shown.text);
  console.log('      transcript leaks protocol: ' + (leaks ? 'YES' : 'no') +
    ' (visible ' + shown.text.length + ' chars, reasoning ' + shown.reasoning.length + ' chars)');
  if (leaks) failed += 1;
}
console.log(failed === 0 ? '\\nALL PASS' : '\\n' + failed + ' FAILURE(S)');
`;

fs.writeFileSync(probe, source, 'utf8');
const run = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '.axiom-parse-probe.mts'],
  { cwd: root, encoding: 'utf8' },
);
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
fs.writeFileSync(path.join(root, 'parse-probe-out.txt'), `status=${run.status}\n${out}`, 'utf8');
fs.rmSync(probe, { force: true });
console.log(out);
