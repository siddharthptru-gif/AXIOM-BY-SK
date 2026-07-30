/**
 * Reproduces AXIOM's toolchain detection against THIS machine, to find out why a
 * genuinely installed Python was reported as missing.
 *
 * Compares the two strategies in the codebase:
 *   A) the PATH + PATHEXT existsSync scan used by main/services/runtimes.ts
 *   B) spawning the tool by base name, which is what debugDiscovery.ts does and
 *      which reported "Python found (python)" on this machine
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED = [
  'SystemRoot', 'WINDIR', 'windir', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS',
  'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
];

function buildChildProcessEnvironment() {
  const environment = {};
  for (const key of ALLOWED) {
    const value = process.env[key];
    if (typeof value === 'string') environment[key] = value;
  }
  environment.NO_COLOR = '1';
  environment.FORCE_COLOR = '0';
  return environment;
}

const env = buildChildProcessEnvironment();
const raw = env.PATH ?? env.Path ?? '';
const dirs = raw.split(path.delimiter).filter((e) => e.length > 0);
const exts =
  process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
    : [''];

console.log('platform           :', process.platform);
console.log('PATH present       :', raw.length > 0 ? `yes (${dirs.length} dirs)` : 'NO  <-- problem');
console.log('PATHEXT            :', env.PATHEXT ?? '(unset)');
console.log('');

function resolveOnPath(commands) {
  for (const command of commands) {
    for (const dir of dirs) {
      for (const extension of exts) {
        const candidate = path.join(dir, `${command}${extension}`);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          /* unreadable dir */
        }
      }
    }
  }
  return null;
}

function spawnProbe(command, args) {
  const run = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (run.error) return { ok: false, detail: run.error.code ?? String(run.error.message) };
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? '';
  return { ok: true, detail: out.slice(0, 70) };
}

const CASES = [
  { id: 'python', commands: ['python', 'python3', 'py'], versionArgs: ['--version'] },
  { id: 'node', commands: ['node'], versionArgs: ['--version'] },
  { id: 'git', commands: ['git'], versionArgs: ['--version'] },
  { id: 'npm', commands: ['npm'], versionArgs: ['--version'] },
  { id: 'pip', commands: ['pip', 'pip3'], versionArgs: ['--version'] },
];

console.log('tool    | A: PATH scan                          | B: spawn by name');
console.log('--------+---------------------------------------+---------------------------');
for (const c of CASES) {
  const found = resolveOnPath(c.commands);
  const spawned = spawnProbe(c.commands[0], c.versionArgs);
  const a = found ? found.slice(-37) : 'NOT FOUND';
  const b = spawned.ok ? spawned.detail : `FAILED (${spawned.detail})`;
  console.log(`${c.id.padEnd(7)} | ${a.padEnd(37)} | ${b}`);
}

console.log('');
const where = spawnSync('where', ['python'], { env, encoding: 'utf8', shell: true });
console.log('where python       :', (`${where.stdout ?? ''}${where.stderr ?? ''}`).trim() || '(nothing)');

const aliasDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')
  : null;
if (aliasDir) {
  console.log('WindowsApps on PATH:', dirs.some((d) => d.toLowerCase() === aliasDir.toLowerCase()));
  try {
    const entries = fs.readdirSync(aliasDir).filter((n) => /^python/i.test(n));
    console.log('WindowsApps python :', entries.join(', ') || '(none)');
    for (const entry of entries) {
      const full = path.join(aliasDir, entry);
      const stat = fs.statSync(full);
      console.log(`  ${entry}: size=${stat.size} existsSync=${fs.existsSync(full)}`);
    }
  } catch (error) {
    console.log('WindowsApps read   : failed', error.code ?? error.message);
  }
}

// Which PATH dirs actually contain a python executable, to see whether the scan
// order or a per-directory read failure is at fault.
console.log('');
console.log('dirs containing python*:');
let hits = 0;
for (const dir of dirs) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^python(3)?\.(exe|bat|cmd)$/i.test(name)) {
        console.log(`  ${path.join(dir, name)}`);
        hits += 1;
      }
    }
  } catch {
    /* unreadable */
  }
}
if (hits === 0) console.log('  (none found by directory listing either)');
