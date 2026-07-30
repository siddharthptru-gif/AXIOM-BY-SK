#!/usr/bin/env node
/**
 * Verification probe for the LANGUAGES registry.
 *
 * The registry is what AXIOM actually spawns, so the properties worth proving are:
 * every pack can be installed on every supported platform, every token of every
 * generated command survives the safety check, and the manager preference order is
 * what the UI claims. Pure module, so this needs no Electron and no machine state.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const SOURCE = path.join('apps', 'desktop', 'src', 'common', 'languagePacks.ts');

function loadPureModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const wrapper = new Module(file, null);
  wrapper.filename = file;
  wrapper.paths = Module._nodeModulePaths(path.dirname(file));
  wrapper._compile(js, file);
  return wrapper.exports;
}

let failures = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

const api = loadPureModule(SOURCE);
const {
  LANGUAGE_PACKS,
  PACKAGE_MANAGERS,
  buildInstallArgv,
  formatCommandLine,
  isSafeCommandToken,
  isLanguagePackSatisfied,
  languagePack,
  packRuntimeIds,
  packageManagerDefinition,
  primaryManagersFor,
} = api;

check('registry loads', Array.isArray(LANGUAGE_PACKS) && LANGUAGE_PACKS.length > 0, `${LANGUAGE_PACKS.length} packs`);

// Every primary manager on every supported platform must be able to install every
// pack: a missing package id would show the user an Install button that cannot work.
const PLATFORMS = ['win32', 'darwin', 'linux'];
for (const platform of PLATFORMS) {
  const managers = primaryManagersFor(platform);
  check(
    `platform ${platform} has primary managers`,
    managers.length > 0,
    managers.map((m) => m.id).join(' > '),
  );
  for (const pack of LANGUAGE_PACKS) {
    const covered = managers.filter((m) => (pack.packages[m.id] ?? []).length > 0);
    check(
      `${pack.id} installable on ${platform}`,
      covered.length > 0,
      covered.map((m) => m.id).join(','),
    );
  }
}

check(
  'winget is preferred on Windows',
  primaryManagersFor('win32')[0]?.id === 'winget',
  primaryManagersFor('win32')
    .map((m) => m.id)
    .join(' > '),
);
check(
  'extras-only managers are never primary',
  primaryManagersFor('win32').every((m) => !m.extrasOnly) &&
    primaryManagersFor('linux').every((m) => !m.extrasOnly),
);

// Every token of every command AXIOM could ever build must pass the safety check.
let argvCount = 0;
let unsafe = [];
for (const manager of PACKAGE_MANAGERS) {
  for (const pack of LANGUAGE_PACKS) {
    for (const packageId of pack.packages[manager.id] ?? []) {
      const argv = buildInstallArgv(manager, packageId);
      argvCount += 1;
      if (!argv) unsafe.push(`${manager.id}:${packageId}`);
    }
  }
  for (const extra of LANGUAGE_PACKS.flatMap((pack) => pack.extras)) {
    if (extra.manager !== manager.id) continue;
    const argv = buildInstallArgv(manager, extra.packageId);
    argvCount += 1;
    if (!argv) unsafe.push(`${manager.id}:${extra.packageId}`);
  }
}
check('every install argv is safe', unsafe.length === 0, `${argvCount} vectors, ${unsafe.join(',') || 'none rejected'}`);

// Shell metacharacters must be rejected, or the safety check is decoration.
const HOSTILE = ['a b', 'a&b', 'a|b', 'a;b', 'a$b', 'a`b', 'a>b', 'a<b', 'a(b', 'a"b', "a'b", 'a%b', 'a^b', 'a!b', 'a*b', ''];
check(
  'hostile tokens are rejected',
  HOSTILE.every((token) => !isSafeCommandToken(token)),
  HOSTILE.filter((token) => isSafeCommandToken(token)).join(',') || 'all rejected',
);
check(
  'real package ids are accepted',
  ['Python.Python.3.13', 'Microsoft.OpenJDK.21', 'dotnet-sdk-8.0', 'gcc-c++', 'rustup.install', '--accept-package-agreements'].every(
    isSafeCommandToken,
  ),
);

// The Python pack is the one the user hit: it must require python and offer debugpy.
const python = languagePack('python');
check('python pack exists', Boolean(python));
check(
  'python requires the python runtime',
  Boolean(python) && python.requires.some((group) => group.includes('python')),
);
check(
  'python installs debugpy as an extra',
  Boolean(python) && python.extras.some((extra) => extra.packageId === 'debugpy' && extra.manager === 'pip'),
);
check(
  'debugpy uses a per-user pip install',
  formatCommandLine('pip', buildInstallArgv(packageManagerDefinition('pip'), 'debugpy') ?? []) ===
    'pip install --user debugpy',
  formatCommandLine('pip', buildInstallArgv(packageManagerDefinition('pip'), 'debugpy') ?? []),
);
check(
  'winget python command is exact and non-interactive',
  formatCommandLine('winget', buildInstallArgv(packageManagerDefinition('winget'), 'Python.Python.3.13') ?? []) ===
    'winget install --exact --id Python.Python.3.13 --source winget --accept-package-agreements --accept-source-agreements',
  formatCommandLine('winget', buildInstallArgv(packageManagerDefinition('winget'), 'Python.Python.3.13') ?? []),
);

// Satisfaction is an AND of ORs: C/C++ is ready with clang OR gcc, not both.
const cpp = languagePack('cpp');
check('cpp ready with clang only', isLanguagePackSatisfied(cpp.requires, new Set(['clang'])));
check('cpp ready with gcc only', isLanguagePackSatisfied(cpp.requires, new Set(['gcc'])));
check('cpp not ready with neither', !isLanguagePackSatisfied(cpp.requires, new Set(['python'])));
check(
  'python not ready without python',
  !isLanguagePackSatisfied(python.requires, new Set(['pip'])),
);

// Optional tools are reported but never block readiness.
check(
  'optional tools do not block readiness',
  isLanguagePackSatisfied(python.requires, new Set(['python'])) &&
    packRuntimeIds(python).includes('pip'),
);

// Sudo managers must never be spawnable candidates, or an invisible password prompt
// would hang the install forever.
check(
  'linux sudo managers are marked needsSudo',
  ['apt', 'dnf', 'pacman'].every((id) => packageManagerDefinition(id).needsSudo === true),
);
check(
  'winget, choco, brew and pip need no sudo',
  ['winget', 'choco', 'brew', 'pip'].every((id) => packageManagerDefinition(id).needsSudo === false),
);

// Unique ids, or lookups silently pick the wrong entry.
const packIds = new Set(LANGUAGE_PACKS.map((pack) => pack.id));
check('pack ids are unique', packIds.size === LANGUAGE_PACKS.length);
const managerIds = new Set(PACKAGE_MANAGERS.map((manager) => manager.id));
check('manager ids are unique', managerIds.size === PACKAGE_MANAGERS.length);
check(
  'every pack has a docs url over https',
  LANGUAGE_PACKS.every((pack) => pack.docsUrl.startsWith('https://')),
);

process.stdout.write(failures === 0 ? 'ALL PASS\n' : `FAILURES ${failures}\n`);
process.exitCode = failures === 0 ? 0 : 1;
