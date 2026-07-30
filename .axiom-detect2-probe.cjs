/**
 * Verifies the NEW resolver (main/services/executables.ts) against this machine.
 *
 * The previous PATH-only scan reported a Microsoft Store Python as missing. This
 * must now find it, and must also still find `.cmd` shims like npm.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const probe = path.join(root, '.axiom-detect2-probe.mts');

const executables = fs
  .readFileSync(path.join(root, 'apps', 'desktop', 'src', 'main', 'services', 'executables.ts'), 'utf8')
  // Inline the env helper so the probe needs no module resolution.
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/processEnvironment';\s*$/m, '');

const source = `${executables}

const ALLOWED = [
  'SystemRoot','WINDIR','windir','PATH','Path','PATHEXT','ComSpec','COMSPEC','TEMP','TMP',
  'USERPROFILE','HOME','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)',
  'ProgramW6432','PROGRAMDATA','ALLUSERSPROFILE','PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','OS','SHELL','LANG','LC_ALL','LC_CTYPE','TZ','TERM',
];
function buildChildProcessEnvironment(_o?: unknown): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED) {
    const value = process.env[key];
    if (typeof value === 'string') environment[key] = value;
  }
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  return environment;
}

const CASES: Array<{ id: string; commands: string[]; versionArgs: string[] }> = [
  { id: 'python', commands: ['python', 'python3', 'py'], versionArgs: ['--version'] },
  { id: 'node',   commands: ['node'],                    versionArgs: ['--version'] },
  { id: 'npm',    commands: ['npm'],                     versionArgs: ['--version'] },
  { id: 'git',    commands: ['git'],                     versionArgs: ['--version'] },
  { id: 'pip',    commands: ['pip', 'pip3'],             versionArgs: ['--version'] },
  { id: 'rust',   commands: ['rustc'],                   versionArgs: ['--version'] },
  { id: 'go',     commands: ['go'],                      versionArgs: ['version'] },
  { id: 'jdk',    commands: ['javac'],                   versionArgs: ['-version'] },
  { id: 'nope',   commands: ['definitely-not-installed-xyz'], versionArgs: ['--version'] },
];

let failures = 0;
console.log('tool    | resolved | via          | path / version');
console.log('--------+----------+--------------+------------------------------------------');
for (const c of CASES) {
  const resolved = await resolveExecutable(c.commands, c.versionArgs);
  const version = resolved ? await readVersion(resolved.path, c.versionArgs) : null;
  const detail = resolved ? (version ?? resolved.path).slice(0, 42) : '-';
  console.log(
    c.id.padEnd(7) + ' | ' + (resolved ? 'yes' : 'no ').padEnd(8) + ' | ' +
    (resolved?.via ?? '-').padEnd(12) + ' | ' + detail,
  );
  // python and node are known-present on this machine; the fake one must be absent.
  if (c.id === 'python' && !resolved) { failures += 1; console.log('  FAIL python must resolve'); }
  if (c.id === 'node' && !resolved) { failures += 1; console.log('  FAIL node must resolve'); }
  if (c.id === 'npm' && !resolved) { failures += 1; console.log('  FAIL npm must resolve'); }
  if (c.id === 'nope' && resolved) { failures += 1; console.log('  FAIL absent tool must not resolve'); }
}
console.log('');
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
`;

fs.writeFileSync(probe, source, 'utf8');
const run = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '.axiom-detect2-probe.mts'],
  { cwd: root, encoding: 'utf8' },
);
fs.rmSync(probe, { force: true });
console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`);
