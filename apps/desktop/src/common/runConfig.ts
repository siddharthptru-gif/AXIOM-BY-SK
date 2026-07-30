/**
 * Universal Run configuration (pure).
 *
 * Decides what "Run ▶" should do for the file the user is looking at. The goal is
 * that a standard project never needs a hand-written command: open `main.py`, press
 * Run, and Python executes it in AXIOM's terminal.
 *
 * Two inputs decide the answer:
 *   • the file's language, and
 *   • which toolchains were actually DETECTED on this machine.
 *
 * The second half matters. Offering "▶ Run Java" on a machine with no JDK produces a
 * confusing shell error; instead the button explains what to install. So every
 * candidate names the runtime id it needs, and a candidate whose runtime is missing
 * is reported as unavailable rather than run.
 *
 * Project shape refines the choice: a Rust file inside a Cargo project runs
 * `cargo run`, not `rustc`; a `.ts` file in a project with a `dev` script offers that
 * script too. Nothing here writes or executes — Main owns that, behind the same
 * command approval as any other execution.
 *
 * Pure: no I/O, no Electron.
 */

/** A single executable action offered for the current file or project. */
export interface RunCandidate {
  id: string;
  /** Button/menu label, e.g. "Run Python" or "Cargo run". */
  label: string;
  /**
   * The shell command line. `${file}` and `${fileBase}` are substituted by
   * {@link resolveRunCommand} against the active file so this stays data.
   */
  command: string;
  /** Toolchain id from `common/runtimes.ts` this command needs. */
  requires: string;
  /** True when the command runs the whole project rather than the open file. */
  project?: boolean;
  /** Shown when `requires` is not installed. */
  install?: string;
}

/** What the run system knows about the workspace, supplied by the caller. */
export interface RunContext {
  /** Workspace-relative path of the active file, POSIX separators. */
  relPath: string;
  /** Monaco/LSP language id of the active file. */
  languageId: string;
  /** Marker files present at the workspace root, e.g. `package.json`. */
  rootFiles: readonly string[];
  /** Scripts declared in package.json, when there is one. */
  packageScripts?: readonly string[];
  /** Toolchain ids detected on this machine. */
  available: ReadonlySet<string>;
}

function has(context: RunContext, file: string): boolean {
  return context.rootFiles.includes(file);
}

/** Quote a path for a shell command line. */
export function quoteForShell(value: string): string {
  return /^[A-Za-z0-9_./\\:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** Substitute the file placeholders in a candidate's command. */
export function resolveRunCommand(command: string, relPath: string): string {
  const base = relPath.replace(/\.[^./\\]+$/, '');
  const name = relPath.split('/').pop() ?? relPath;
  const nameBase = name.replace(/\.[^.]+$/, '');
  return command
    .replaceAll('${file}', quoteForShell(relPath))
    .replaceAll('${fileBase}', quoteForShell(base))
    .replaceAll('${fileName}', quoteForShell(name))
    .replaceAll('${fileNameBase}', quoteForShell(nameBase));
}

/** Node-family project candidates, shared by JS and TS. */
function nodeProjectCandidates(context: RunContext): RunCandidate[] {
  const out: RunCandidate[] = [];
  const scripts = context.packageScripts ?? [];
  // A dev server is what the user usually wants in a framework project, so it leads.
  for (const script of ['dev', 'start', 'serve']) {
    if (!scripts.includes(script)) continue;
    const manager = has(context, 'pnpm-lock.yaml')
      ? 'pnpm'
      : has(context, 'yarn.lock')
        ? 'yarn'
        : has(context, 'bun.lockb')
          ? 'bun'
          : 'npm';
    out.push({
      id: `script:${script}`,
      label: `${script === 'dev' ? 'Start dev server' : `Run ${script}`} (${manager})`,
      command: manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`,
      requires: manager,
      project: true,
    });
  }
  return out;
}

/**
 * Everything that could be run for this context, best first.
 *
 * Project-level commands precede single-file ones when the project clearly defines
 * them, because that is what the user means by "run" in a framework project.
 */
export function runCandidates(context: RunContext): RunCandidate[] {
  const out: RunCandidate[] = [];
  const language = context.languageId;

  if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].includes(language)) {
    if (has(context, 'package.json')) out.push(...nodeProjectCandidates(context));
    if (language === 'javascript' || language === 'javascriptreact') {
      out.push({ id: 'node', label: 'Run JavaScript', command: 'node ${file}', requires: 'node' });
      out.push({ id: 'bun', label: 'Run with Bun', command: 'bun run ${file}', requires: 'bun' });
    } else {
      // TypeScript needs a runtime that can execute it directly.
      out.push({
        id: 'tsx',
        label: 'Run TypeScript (node)',
        command: 'node ${file}',
        requires: 'node',
      });
      out.push({
        id: 'deno',
        label: 'Run with Deno',
        command: 'deno run -A ${file}',
        requires: 'deno',
      });
      out.push({ id: 'bun', label: 'Run with Bun', command: 'bun run ${file}', requires: 'bun' });
    }
  }

  if (language === 'python') {
    if (has(context, 'pyproject.toml') && context.available.has('poetry')) {
      out.push({
        id: 'poetry',
        label: 'Run with Poetry',
        command: 'poetry run python ${file}',
        requires: 'poetry',
      });
    }
    out.push({ id: 'python', label: 'Run Python', command: 'python ${file}', requires: 'python' });
  }

  if (language === 'go') {
    out.push({ id: 'go', label: 'Run Go', command: 'go run ${file}', requires: 'go' });
    if (has(context, 'go.mod')) {
      out.push({
        id: 'go-project',
        label: 'Run Go module',
        command: 'go run .',
        requires: 'go',
        project: true,
      });
    }
  }

  if (language === 'rust') {
    // Inside a Cargo project, rustc is almost never the right call.
    if (has(context, 'Cargo.toml')) {
      out.push({
        id: 'cargo',
        label: 'Cargo run',
        command: 'cargo run',
        requires: 'cargo',
        project: true,
      });
    }
    out.push({
      id: 'rustc',
      label: 'Compile & run',
      command: 'rustc ${file} -o ${fileNameBase} && ./${fileNameBase}',
      requires: 'rust',
    });
  }

  if (language === 'java') {
    out.push({
      id: 'java',
      label: 'Compile & run Java',
      command: 'javac ${file} && java ${fileNameBase}',
      requires: 'jdk',
    });
    if (has(context, 'pom.xml')) {
      out.push({
        id: 'maven',
        label: 'Maven exec',
        command: 'mvn -q exec:java',
        requires: 'maven',
        project: true,
      });
    }
    if (has(context, 'build.gradle') || has(context, 'build.gradle.kts')) {
      out.push({
        id: 'gradle',
        label: 'Gradle run',
        command: 'gradle run',
        requires: 'gradle',
        project: true,
      });
    }
  }

  if (language === 'c') {
    out.push({
      id: 'gcc',
      label: 'Compile & run',
      command: 'gcc ${file} -o ${fileNameBase} && ./${fileNameBase}',
      requires: 'gcc',
    });
    out.push({
      id: 'clang',
      label: 'Compile & run (clang)',
      command: 'clang ${file} -o ${fileNameBase} && ./${fileNameBase}',
      requires: 'clang',
    });
  }

  if (language === 'cpp') {
    out.push({
      id: 'gpp',
      label: 'Compile & run',
      command: 'g++ ${file} -o ${fileNameBase} && ./${fileNameBase}',
      requires: 'gcc',
    });
    out.push({
      id: 'clangpp',
      label: 'Compile & run (clang++)',
      command: 'clang++ ${file} -o ${fileNameBase} && ./${fileNameBase}',
      requires: 'clang',
    });
  }

  if (language === 'csharp') {
    out.push({
      id: 'dotnet',
      label: 'Run .NET',
      command: 'dotnet run',
      requires: 'dotnet',
      project: true,
    });
  }

  if (language === 'dart') {
    if (has(context, 'pubspec.yaml') && context.available.has('flutter')) {
      out.push({
        id: 'flutter',
        label: 'Run Flutter',
        command: 'flutter run',
        requires: 'flutter',
        project: true,
      });
    }
    out.push({ id: 'dart', label: 'Run Dart', command: 'dart run ${file}', requires: 'dart' });
  }

  if (language === 'php')
    out.push({ id: 'php', label: 'Run PHP', command: 'php ${file}', requires: 'php' });
  if (language === 'ruby')
    out.push({ id: 'ruby', label: 'Run Ruby', command: 'ruby ${file}', requires: 'ruby' });
  if (language === 'perl')
    out.push({ id: 'perl', label: 'Run Perl', command: 'perl ${file}', requires: 'perl' });
  if (language === 'lua')
    out.push({ id: 'lua', label: 'Run Lua', command: 'lua ${file}', requires: 'lua' });
  if (language === 'r')
    out.push({ id: 'r', label: 'Run R', command: 'Rscript ${file}', requires: 'r' });
  if (language === 'julia') {
    out.push({ id: 'julia', label: 'Run Julia', command: 'julia ${file}', requires: 'julia' });
  }
  if (language === 'elixir') {
    out.push({ id: 'elixir', label: 'Run Elixir', command: 'elixir ${file}', requires: 'elixir' });
  }
  if (language === 'haskell') {
    out.push({ id: 'ghc', label: 'Run Haskell', command: 'runghc ${file}', requires: 'ghc' });
  }
  if (language === 'ocaml') {
    out.push({ id: 'ocaml', label: 'Run OCaml', command: 'ocaml ${file}', requires: 'ocaml' });
  }
  if (language === 'zig') {
    out.push({ id: 'zig', label: 'Run Zig', command: 'zig run ${file}', requires: 'zig' });
  }
  if (language === 'kotlin') {
    out.push({
      id: 'kotlin',
      label: 'Compile & run Kotlin',
      command:
        'kotlinc ${file} -include-runtime -d ${fileNameBase}.jar && java -jar ${fileNameBase}.jar',
      requires: 'kotlin',
    });
  }
  if (language === 'scala') {
    out.push({ id: 'scala', label: 'Run Scala', command: 'scala ${file}', requires: 'scala' });
  }
  if (language === 'swift') {
    out.push({ id: 'swift', label: 'Run Swift', command: 'swift ${file}', requires: 'swift' });
  }
  if (language === 'shell') {
    out.push({ id: 'bash', label: 'Run shell script', command: 'bash ${file}', requires: 'bash' });
  }
  if (language === 'powershell') {
    out.push({
      id: 'pwsh',
      label: 'Run PowerShell',
      command: 'powershell -ExecutionPolicy Bypass -File ${file}',
      requires: 'powershell',
    });
  }

  // Universal fallback for any file extension not explicitly matched above.
  if (out.length === 0) {
    const ext = context.relPath.split('.').pop()?.toLowerCase() ?? '';
    if (['cjs', 'mjs', 'js', 'jsx'].includes(ext)) {
      out.push({
        id: 'node',
        label: 'Run JavaScript (node)',
        command: 'node ${file}',
        requires: 'node',
      });
      out.push({ id: 'bun', label: 'Run with Bun', command: 'bun run ${file}', requires: 'bun' });
    } else if (['ts', 'tsx', 'cts', 'mts'].includes(ext)) {
      out.push({
        id: 'tsx',
        label: 'Run TypeScript (node)',
        command: 'node ${file}',
        requires: 'node',
      });
      out.push({ id: 'bun', label: 'Run with Bun', command: 'bun run ${file}', requires: 'bun' });
    } else if (['sh', 'bash', 'zsh'].includes(ext)) {
      out.push({
        id: 'bash',
        label: 'Run shell script',
        command: 'bash ${file}',
        requires: 'bash',
      });
    } else if (['ps1', 'psm1', 'psd1'].includes(ext)) {
      out.push({
        id: 'pwsh',
        label: 'Run PowerShell',
        command: 'powershell -ExecutionPolicy Bypass -File ${file}',
        requires: 'powershell',
      });
    } else if (['bat', 'cmd'].includes(ext)) {
      out.push({
        id: 'cmd',
        label: 'Run command script',
        command: '${file}',
        requires: 'powershell',
      });
    } else {
      // General universal fallback: node or python or powershell
      out.push({
        id: 'node-universal',
        label: 'Run script (node)',
        command: 'node ${file}',
        requires: 'node',
      });
      out.push({
        id: 'pwsh-universal',
        label: 'Run script (powershell)',
        command: 'powershell -ExecutionPolicy Bypass -File ${file}',
        requires: 'powershell',
      });
    }
  }

  return out;
}

export interface ResolvedRun {
  candidate: RunCandidate;
  /** Ready-to-run command line with placeholders substituted. */
  command: string;
}

/**
 * The command Run ▶ should execute, or null when nothing applies.
 *
 * Only a candidate whose toolchain was detected is returned. `bash` and
 * `powershell` are treated as always present because the integrated terminal
 * provides them.
 */
export function resolveRun(context: RunContext): ResolvedRun | null {
  for (const candidate of runCandidates(context)) {
    if (!isRuntimeSatisfied(candidate.requires, context.available)) continue;
    return { candidate, command: resolveRunCommand(candidate.command, context.relPath) };
  }
  return null;
}

/** Shells the integrated terminal always provides. */
const BUILTIN_SHELLS = new Set(['bash', 'powershell']);

export function isRuntimeSatisfied(requires: string, available: ReadonlySet<string>): boolean {
  return BUILTIN_SHELLS.has(requires) || available.has(requires);
}

/**
 * Candidates whose toolchain is missing, so the UI can say WHAT to install instead
 * of silently offering nothing.
 */
export function missingRuntimesFor(context: RunContext): RunCandidate[] {
  return runCandidates(context).filter(
    (candidate) => !isRuntimeSatisfied(candidate.requires, context.available),
  );
}
