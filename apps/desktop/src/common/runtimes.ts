/**
 * Developer toolchain registry (pure).
 *
 * AXIOM does not bundle SDKs — a 106 MB installer cannot ship a JDK, the .NET SDK
 * and the Android toolchain. Instead it DETECTS what the user already has and
 * lights those languages up. This module is the data behind that: which executables
 * identify each toolchain, how to ask one for its version, and which language ids it
 * serves.
 *
 * Adding a toolchain is a data-only change here. No detection code, no run code, and
 * no UI has to know about it.
 *
 * Pure: no I/O, no Electron. Main performs the probing (see main/services/runtimes.ts).
 */

/** What a detected tool is for, so the settings UI can group the list. */
export type RuntimeCategory =
  'language' | 'compiler' | 'packageManager' | 'buildTool' | 'container' | 'vcs' | 'mobile';

export interface RuntimeDefinition {
  id: string;
  displayName: string;
  category: RuntimeCategory;
  /**
   * Executable base names to look for on PATH, in preference order. The first one
   * found identifies the toolchain.
   */
  commands: readonly string[];
  /**
   * Arguments that make the tool print its version. Chosen to be side-effect free
   * and fast; anything that could build, install, or write is never used here.
   */
  versionArgs: readonly string[];
  /** LSP/editor language ids this toolchain can run or build. */
  languageIds?: readonly string[];
}

/**
 * The toolchains AXIOM probes for.
 *
 * `versionArgs` is deliberately restricted to informational flags. Detection runs
 * automatically at startup, so a probe must never be able to mutate the machine.
 */
export const RUNTIMES: readonly RuntimeDefinition[] = [
  // ---- Language runtimes -----------------------------------------------------
  {
    id: 'node',
    displayName: 'Node.js',
    category: 'language',
    commands: ['node'],
    versionArgs: ['--version'],
    languageIds: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
  },
  {
    id: 'deno',
    displayName: 'Deno',
    category: 'language',
    commands: ['deno'],
    versionArgs: ['--version'],
    languageIds: ['typescript', 'javascript'],
  },
  {
    id: 'bun',
    displayName: 'Bun',
    category: 'language',
    commands: ['bun'],
    versionArgs: ['--version'],
    languageIds: ['typescript', 'javascript'],
  },
  {
    id: 'python',
    displayName: 'Python',
    category: 'language',
    // `py` is the Windows launcher; `python3` the common POSIX name.
    commands: ['python', 'python3', 'py'],
    versionArgs: ['--version'],
    languageIds: ['python'],
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    category: 'language',
    commands: ['ruby'],
    versionArgs: ['--version'],
    languageIds: ['ruby'],
  },
  {
    id: 'php',
    displayName: 'PHP',
    category: 'language',
    commands: ['php'],
    versionArgs: ['--version'],
    languageIds: ['php'],
  },
  {
    id: 'perl',
    displayName: 'Perl',
    category: 'language',
    commands: ['perl'],
    versionArgs: ['--version'],
    languageIds: ['perl'],
  },
  {
    id: 'lua',
    displayName: 'Lua',
    category: 'language',
    commands: ['lua', 'luajit'],
    versionArgs: ['-v'],
    languageIds: ['lua'],
  },
  {
    id: 'r',
    displayName: 'R',
    category: 'language',
    commands: ['Rscript'],
    versionArgs: ['--version'],
    languageIds: ['r'],
  },
  {
    id: 'julia',
    displayName: 'Julia',
    category: 'language',
    commands: ['julia'],
    versionArgs: ['--version'],
    languageIds: ['julia'],
  },
  {
    id: 'elixir',
    displayName: 'Elixir',
    category: 'language',
    commands: ['elixir'],
    versionArgs: ['--version'],
    languageIds: ['elixir'],
  },
  {
    id: 'erlang',
    displayName: 'Erlang',
    category: 'language',
    commands: ['escript'],
    versionArgs: ['-v'],
    languageIds: ['erlang'],
  },

  // ---- Compilers / SDKs ------------------------------------------------------
  {
    id: 'jdk',
    displayName: 'Java JDK',
    category: 'compiler',
    commands: ['javac'],
    versionArgs: ['-version'],
    languageIds: ['java'],
  },
  {
    id: 'java',
    displayName: 'Java runtime',
    category: 'language',
    commands: ['java'],
    versionArgs: ['-version'],
    languageIds: ['java'],
  },
  {
    id: 'kotlin',
    displayName: 'Kotlin',
    category: 'compiler',
    commands: ['kotlinc'],
    versionArgs: ['-version'],
    languageIds: ['kotlin'],
  },
  {
    id: 'scala',
    displayName: 'Scala',
    category: 'compiler',
    commands: ['scala'],
    versionArgs: ['-version'],
    languageIds: ['scala'],
  },
  {
    id: 'gcc',
    displayName: 'GCC',
    category: 'compiler',
    commands: ['g++', 'gcc'],
    versionArgs: ['--version'],
    languageIds: ['c', 'cpp'],
  },
  {
    id: 'clang',
    displayName: 'Clang',
    category: 'compiler',
    commands: ['clang++', 'clang'],
    versionArgs: ['--version'],
    languageIds: ['c', 'cpp', 'objective-c'],
  },
  {
    id: 'msvc',
    displayName: 'MSVC',
    category: 'compiler',
    commands: ['cl'],
    // `cl` has no version flag; invoking it bare prints the banner.
    versionArgs: [],
    languageIds: ['c', 'cpp'],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    category: 'compiler',
    commands: ['rustc'],
    versionArgs: ['--version'],
    languageIds: ['rust'],
  },
  {
    id: 'go',
    displayName: 'Go',
    category: 'compiler',
    commands: ['go'],
    versionArgs: ['version'],
    languageIds: ['go'],
  },
  {
    id: 'dotnet',
    displayName: '.NET SDK',
    category: 'compiler',
    commands: ['dotnet'],
    versionArgs: ['--version'],
    languageIds: ['csharp', 'fsharp'],
  },
  {
    id: 'swift',
    displayName: 'Swift',
    category: 'compiler',
    commands: ['swift'],
    versionArgs: ['--version'],
    languageIds: ['swift'],
  },
  {
    id: 'zig',
    displayName: 'Zig',
    category: 'compiler',
    commands: ['zig'],
    versionArgs: ['version'],
    languageIds: ['zig'],
  },
  {
    id: 'ghc',
    displayName: 'Haskell (GHC)',
    category: 'compiler',
    commands: ['runghc', 'ghc'],
    versionArgs: ['--version'],
    languageIds: ['haskell'],
  },
  {
    id: 'ocaml',
    displayName: 'OCaml',
    category: 'compiler',
    commands: ['ocaml'],
    versionArgs: ['-version'],
    languageIds: ['ocaml'],
  },

  // ---- Package managers ------------------------------------------------------
  {
    id: 'npm',
    displayName: 'npm',
    category: 'packageManager',
    commands: ['npm'],
    versionArgs: ['--version'],
  },
  {
    id: 'pnpm',
    displayName: 'pnpm',
    category: 'packageManager',
    commands: ['pnpm'],
    versionArgs: ['--version'],
  },
  {
    id: 'yarn',
    displayName: 'Yarn',
    category: 'packageManager',
    commands: ['yarn'],
    versionArgs: ['--version'],
  },
  {
    id: 'pip',
    displayName: 'pip',
    category: 'packageManager',
    commands: ['pip', 'pip3'],
    versionArgs: ['--version'],
  },
  {
    id: 'poetry',
    displayName: 'Poetry',
    category: 'packageManager',
    commands: ['poetry'],
    versionArgs: ['--version'],
  },
  {
    id: 'uv',
    displayName: 'uv',
    category: 'packageManager',
    commands: ['uv'],
    versionArgs: ['--version'],
  },
  {
    id: 'cargo',
    displayName: 'Cargo',
    category: 'packageManager',
    commands: ['cargo'],
    versionArgs: ['--version'],
  },
  {
    id: 'composer',
    displayName: 'Composer',
    category: 'packageManager',
    commands: ['composer'],
    versionArgs: ['--version'],
  },
  {
    id: 'bundler',
    displayName: 'Bundler',
    category: 'packageManager',
    commands: ['bundle'],
    versionArgs: ['--version'],
  },
  {
    id: 'cocoapods',
    displayName: 'CocoaPods',
    category: 'packageManager',
    commands: ['pod'],
    versionArgs: ['--version'],
  },
  {
    id: 'homebrew',
    displayName: 'Homebrew',
    category: 'packageManager',
    commands: ['brew'],
    versionArgs: ['--version'],
  },
  {
    id: 'chocolatey',
    displayName: 'Chocolatey',
    category: 'packageManager',
    commands: ['choco'],
    versionArgs: ['--version'],
  },
  {
    id: 'scoop',
    displayName: 'Scoop',
    category: 'packageManager',
    commands: ['scoop'],
    versionArgs: ['--version'],
  },

  // ---- Build tools -----------------------------------------------------------
  {
    id: 'cmake',
    displayName: 'CMake',
    category: 'buildTool',
    commands: ['cmake'],
    versionArgs: ['--version'],
  },
  {
    id: 'make',
    displayName: 'Make',
    category: 'buildTool',
    commands: ['make'],
    versionArgs: ['--version'],
  },
  {
    id: 'maven',
    displayName: 'Maven',
    category: 'buildTool',
    commands: ['mvn'],
    versionArgs: ['--version'],
  },
  {
    id: 'gradle',
    displayName: 'Gradle',
    category: 'buildTool',
    commands: ['gradle'],
    versionArgs: ['--version'],
  },

  // ---- Platform tools --------------------------------------------------------
  {
    id: 'dart',
    displayName: 'Dart SDK',
    category: 'mobile',
    commands: ['dart'],
    versionArgs: ['--version'],
    languageIds: ['dart'],
  },
  {
    id: 'flutter',
    displayName: 'Flutter SDK',
    category: 'mobile',
    commands: ['flutter'],
    versionArgs: ['--version'],
    languageIds: ['dart'],
  },
  {
    id: 'adb',
    displayName: 'Android SDK (adb)',
    category: 'mobile',
    commands: ['adb'],
    versionArgs: ['version'],
  },
  { id: 'git', displayName: 'Git', category: 'vcs', commands: ['git'], versionArgs: ['--version'] },
  {
    id: 'docker',
    displayName: 'Docker',
    category: 'container',
    commands: ['docker'],
    versionArgs: ['--version'],
  },
  {
    id: 'wsl',
    displayName: 'WSL',
    category: 'container',
    commands: ['wsl'],
    versionArgs: ['--status'],
  },
] as const;

/** One probed toolchain. Absent tools are reported too, so the UI can say so. */
export interface DetectedRuntime {
  id: string;
  displayName: string;
  category: RuntimeCategory;
  /** Absolute path to the executable, or null when it is not installed. */
  path: string | null;
  /** First line of the version output, or null when unknown. */
  version: string | null;
}

export function runtimeDefinition(id: string): RuntimeDefinition | undefined {
  return RUNTIMES.find((entry) => entry.id === id);
}

/** Reduce version output to one short, displayable line. */
export function firstVersionLine(output: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line.slice(0, 160);
  }
  return null;
}

/** Detected tools grouped by category, each group sorted by name. */
export function groupRuntimes(
  runtimes: readonly DetectedRuntime[],
): Array<{ category: RuntimeCategory; items: DetectedRuntime[] }> {
  const order: RuntimeCategory[] = [
    'language',
    'compiler',
    'packageManager',
    'buildTool',
    'mobile',
    'container',
    'vcs',
  ];
  return order
    .map((category) => ({
      category,
      items: runtimes
        .filter((entry) => entry.category === category)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .filter((group) => group.items.length > 0);
}
