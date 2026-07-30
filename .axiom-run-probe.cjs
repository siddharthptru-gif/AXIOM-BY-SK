/**
 * Verifies the pure Run-configuration inference: the right command per language,
 * project shape beating single-file commands, missing toolchains reported instead of
 * offered, and placeholder substitution / shell quoting.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const probe = path.join(root, '.axiom-run-probe.mts');
const src = fs.readFileSync(
  path.join(root, 'apps', 'desktop', 'src', 'common', 'runConfig.ts'),
  'utf8',
);

const source = `${src}
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}
function ctx(over: Partial<RunContext>): RunContext {
  return {
    relPath: 'main.py',
    languageId: 'python',
    rootFiles: [],
    available: new Set<string>(),
    ...over,
  } as RunContext;
}

// Python with python installed.
const py = resolveRun(ctx({ available: new Set(['python']) }));
check('python resolves', py?.command === 'python main.py', py?.command);

// Python with nothing installed -> nothing runs, but the gap is reported.
const pyNone = resolveRun(ctx({}));
check('python without runtime does not run', pyNone === null);
check('missing runtime reported', missingRuntimesFor(ctx({})).some((c) => c.requires === 'python'));

// Rust inside a Cargo project must prefer cargo over rustc.
const rust = resolveRun(
  ctx({ relPath: 'src/main.rs', languageId: 'rust', rootFiles: ['Cargo.toml'],
        available: new Set(['cargo', 'rust']) }),
);
check('cargo beats rustc in a Cargo project', rust?.command === 'cargo run', rust?.command);

// Rust standalone file falls back to rustc.
const rustBare = resolveRun(
  ctx({ relPath: 'scratch.rs', languageId: 'rust', available: new Set(['rust']) }),
);
check('standalone rust compiles', rustBare?.command.startsWith('rustc scratch.rs'), rustBare?.command);

// A Next-style project prefers the dev script, with the right package manager.
const web = resolveRun(
  ctx({ relPath: 'app/page.tsx', languageId: 'typescriptreact',
        rootFiles: ['package.json', 'pnpm-lock.yaml'], packageScripts: ['dev', 'build'],
        available: new Set(['pnpm', 'node']) }),
);
check('dev server preferred with pnpm', web?.command === 'pnpm run dev', web?.command);

// Without a dev script it should just run the file on node.
const plainJs = resolveRun(
  ctx({ relPath: 'index.js', languageId: 'javascript', rootFiles: ['package.json'],
        packageScripts: [], available: new Set(['node']) }),
);
check('plain js runs on node', plainJs?.command === 'node index.js', plainJs?.command);

// Java needs the JDK, not just the java runtime.
const javaNoJdk = resolveRun(
  ctx({ relPath: 'Main.java', languageId: 'java', available: new Set(['java']) }),
);
check('java without JDK does not run', javaNoJdk === null);
const java = resolveRun(
  ctx({ relPath: 'Main.java', languageId: 'java', available: new Set(['jdk']) }),
);
check('java compiles then runs', java?.command === 'javac Main.java && java Main', java?.command);

// C++ compile & run.
const cpp = resolveRun(
  ctx({ relPath: 'main.cpp', languageId: 'cpp', available: new Set(['gcc']) }),
);
check('c++ compiles and runs', cpp?.command === 'g++ main.cpp -o main && ./main', cpp?.command);

// Go module.
const go = resolveRun(
  ctx({ relPath: 'main.go', languageId: 'go', rootFiles: ['go.mod'], available: new Set(['go']) }),
);
check('go runs the file', go?.command === 'go run main.go', go?.command);

// A shell script needs no detected toolchain: the terminal provides bash.
const sh = resolveRun(ctx({ relPath: 'deploy.sh', languageId: 'shell' }));
check('shell runs without detection', sh?.command === 'bash deploy.sh', sh?.command);

// Paths with spaces must be quoted.
const spaced = resolveRunCommand('python \${file}', 'my scripts/run me.py');
check('spaced path quoted', spaced === 'python "my scripts/run me.py"', spaced);

// An unknown language offers nothing rather than guessing.
check('unknown language yields nothing', resolveRun(ctx({ languageId: 'plaintext' })) === null);

console.log(failures === 0 ? '\\nALL PASS' : '\\n' + failures + ' FAILURE(S)');
`;

fs.writeFileSync(probe, source, 'utf8');
const run = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', '.axiom-run-probe.mts'],
  { cwd: root, encoding: 'utf8' },
);
fs.rmSync(probe, { force: true });
console.log(`${run.stdout ?? ''}${run.stderr ?? ''}`);
