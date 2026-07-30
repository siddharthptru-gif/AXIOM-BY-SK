/**
 * Language pack registry (pure).
 *
 * AXIOM detects the toolchains a machine already has (see `common/runtimes.ts`).
 * This module answers the next question: when a toolchain is MISSING, what exactly
 * should be installed, and with which command?
 *
 * Two rules shape everything here:
 *
 * 1. AXIOM never downloads or executes an installer binary itself. It delegates to
 *    the operating system's own package manager, which already verifies signatures
 *    and hashes. That keeps the supply chain auditable: the only thing AXIOM
 *    contributes is a package NAME.
 * 2. Every token of every command is pinned in this file. Nothing a renderer, a
 *    model, or a workspace can influence ever reaches an argument vector. The
 *    renderer may only name a language pack id, which is looked up here.
 *
 * Pure: no I/O, no Electron, no `process` access beyond a platform string passed in
 * by the caller. Main performs the detection and spawning
 * (see `main/services/languageInstall.ts`).
 */

/** Package managers AXIOM knows how to drive. */
export type PackageManagerId = 'winget' | 'choco' | 'brew' | 'apt' | 'dnf' | 'pacman' | 'pip';

export interface PackageManagerDefinition {
  id: PackageManagerId;
  displayName: string;
  /** Executable base names to resolve, in preference order. */
  commands: readonly string[];
  /** `process.platform` values where this manager is offered. */
  platforms: readonly string[];
  /** Fixed argument vector placed BEFORE the package id. */
  installArgs: readonly string[];
  /** Fixed argument vector placed AFTER the package id. */
  installTrailingArgs: readonly string[];
  /**
   * True when the install must run as root. Those commands need a TTY for the
   * password prompt, so AXIOM shows them for the user to run instead of spawning
   * them blind — a hidden process waiting forever on an invisible prompt is worse
   * than an honest instruction.
   */
  needsSudo: boolean;
  /** Preference order within a platform; lower wins. */
  rank: number;
  /**
   * True for managers that only install ADD-ONS to an already-present toolchain
   * (pip packages, for instance). They are never chosen as a language's primary
   * installer.
   */
  extrasOnly: boolean;
  docsUrl: string;
}

/**
 * The managers, with their exact non-interactive install vectors.
 *
 * winget is ranked first on Windows because it ships with the OS, installs
 * per-user without administrator rights for most packages, and validates
 * publisher hashes itself.
 */
export const PACKAGE_MANAGERS: readonly PackageManagerDefinition[] = [
  {
    id: 'winget',
    displayName: 'Windows Package Manager (winget)',
    commands: ['winget'],
    platforms: ['win32'],
    installArgs: ['install', '--exact', '--id'],
    installTrailingArgs: [
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
    needsSudo: false,
    rank: 1,
    extrasOnly: false,
    docsUrl: 'https://learn.microsoft.com/windows/package-manager/winget/',
  },
  {
    id: 'choco',
    displayName: 'Chocolatey',
    commands: ['choco'],
    platforms: ['win32'],
    installArgs: ['install'],
    installTrailingArgs: ['-y', '--no-progress'],
    needsSudo: false,
    rank: 2,
    extrasOnly: false,
    docsUrl: 'https://chocolatey.org/install',
  },
  {
    id: 'brew',
    displayName: 'Homebrew',
    commands: ['brew'],
    platforms: ['darwin', 'linux'],
    installArgs: ['install'],
    installTrailingArgs: [],
    needsSudo: false,
    rank: 1,
    extrasOnly: false,
    docsUrl: 'https://brew.sh',
  },
  {
    id: 'apt',
    displayName: 'APT',
    commands: ['apt-get'],
    platforms: ['linux'],
    installArgs: ['install', '-y'],
    installTrailingArgs: [],
    needsSudo: true,
    rank: 2,
    extrasOnly: false,
    docsUrl: 'https://wiki.debian.org/Apt',
  },
  {
    id: 'dnf',
    displayName: 'DNF',
    commands: ['dnf'],
    platforms: ['linux'],
    installArgs: ['install', '-y'],
    installTrailingArgs: [],
    needsSudo: true,
    rank: 3,
    extrasOnly: false,
    docsUrl: 'https://dnf.readthedocs.io',
  },
  {
    id: 'pacman',
    displayName: 'pacman',
    commands: ['pacman'],
    platforms: ['linux'],
    installArgs: ['-S', '--needed', '--noconfirm'],
    installTrailingArgs: [],
    needsSudo: true,
    rank: 4,
    extrasOnly: false,
    docsUrl: 'https://wiki.archlinux.org/title/Pacman',
  },
  {
    id: 'pip',
    displayName: 'pip',
    commands: ['pip', 'pip3'],
    platforms: ['win32', 'darwin', 'linux'],
    // `--user` keeps the install inside the user's own site-packages, so no
    // elevation is needed and a system Python is never modified.
    installArgs: ['install', '--user'],
    installTrailingArgs: [],
    needsSudo: false,
    rank: 9,
    extrasOnly: true,
    docsUrl: 'https://pip.pypa.io',
  },
] as const;

/** An add-on installed with the language's own package manager after the toolchain. */
export interface LanguagePackExtra {
  manager: PackageManagerId;
  packageId: string;
  /** Shown in the approval dialog so the user knows why it is being installed. */
  purpose: string;
}

export interface LanguagePackDefinition {
  id: string;
  displayName: string;
  /** One line describing what installing this unlocks in AXIOM. */
  blurb: string;
  /**
   * Runtime-id requirements, as an AND of ORs: every group must be satisfied, and a
   * group is satisfied by ANY id in it. That expresses "C and C++ need clang OR gcc"
   * without a special case.
   */
  requires: readonly (readonly string[])[];
  /** Nice-to-have tools reported alongside, but never blocking. */
  optionalRuntimeIds: readonly string[];
  /** Editor language ids this pack lights up. */
  languageIds: readonly string[];
  /** Official download page, for the manual path. */
  docsUrl: string;
  /** Package ids per manager, installed in listed order. */
  packages: Partial<Record<PackageManagerId, readonly string[]>>;
  extras: readonly LanguagePackExtra[];
}

/**
 * The language packs offered in the LANGUAGES view.
 *
 * Package ids are pinned to a specific major version where the manager offers a
 * versioned id (`Python.Python.3.13`, `Microsoft.OpenJDK.21`). A floating "latest"
 * id would silently change what AXIOM installs between releases.
 */
export const LANGUAGE_PACKS: readonly LanguagePackDefinition[] = [
  {
    id: 'python',
    displayName: 'Python',
    blurb: 'Run .py files, use the Python language server, and debug with debugpy.',
    requires: [['python']],
    optionalRuntimeIds: ['pip'],
    languageIds: ['python'],
    docsUrl: 'https://www.python.org/downloads/',
    packages: {
      winget: ['Python.Python.3.13'],
      choco: ['python'],
      brew: ['python'],
      apt: ['python3', 'python3-pip'],
      dnf: ['python3', 'python3-pip'],
      pacman: ['python', 'python-pip'],
    },
    extras: [
      { manager: 'pip', packageId: 'debugpy', purpose: 'Python breakpoint debugging in AXIOM' },
    ],
  },
  {
    id: 'node',
    displayName: 'Node.js and npm',
    blurb: 'Run JavaScript and TypeScript, npm scripts, and the TS language server.',
    requires: [['node']],
    optionalRuntimeIds: ['npm'],
    languageIds: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    docsUrl: 'https://nodejs.org/en/download',
    packages: {
      winget: ['OpenJS.NodeJS.LTS'],
      choco: ['nodejs-lts'],
      brew: ['node'],
      apt: ['nodejs', 'npm'],
      dnf: ['nodejs', 'npm'],
      pacman: ['nodejs', 'npm'],
    },
    extras: [],
  },
  {
    id: 'java',
    displayName: 'Java (JDK)',
    blurb: 'Compile and run .java files with javac and java.',
    requires: [['jdk']],
    optionalRuntimeIds: ['java', 'maven', 'gradle'],
    languageIds: ['java'],
    docsUrl: 'https://adoptium.net/temurin/releases/',
    packages: {
      winget: ['Microsoft.OpenJDK.21'],
      choco: ['openjdk'],
      brew: ['openjdk'],
      apt: ['default-jdk'],
      dnf: ['java-21-openjdk-devel'],
      pacman: ['jdk-openjdk'],
    },
    extras: [],
  },
  {
    id: 'go',
    displayName: 'Go',
    blurb: 'Build and run Go programs with the go toolchain.',
    requires: [['go']],
    optionalRuntimeIds: [],
    languageIds: ['go'],
    docsUrl: 'https://go.dev/dl/',
    packages: {
      winget: ['GoLang.Go'],
      choco: ['golang'],
      brew: ['go'],
      apt: ['golang-go'],
      dnf: ['golang'],
      pacman: ['go'],
    },
    extras: [],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    blurb: 'Compile Rust with rustc and manage crates with Cargo.',
    requires: [['rust']],
    optionalRuntimeIds: ['cargo'],
    languageIds: ['rust'],
    docsUrl: 'https://www.rust-lang.org/tools/install',
    packages: {
      winget: ['Rustlang.Rustup'],
      choco: ['rustup.install'],
      brew: ['rust'],
      apt: ['rustc', 'cargo'],
      dnf: ['rust', 'cargo'],
      pacman: ['rust'],
    },
    extras: [],
  },
  {
    id: 'cpp',
    displayName: 'C and C++',
    blurb: 'Compile .c and .cpp files with clang or gcc.',
    requires: [['clang', 'gcc', 'msvc']],
    optionalRuntimeIds: ['cmake', 'make'],
    languageIds: ['c', 'cpp'],
    docsUrl: 'https://releases.llvm.org/',
    packages: {
      winget: ['WinLibs.MinGW.GCC', 'LLVM.LLVM'],
      choco: ['llvm', 'mingw'],
      brew: ['llvm', 'gcc'],
      apt: ['build-essential', 'g++', 'gdb'],
      dnf: ['gcc', 'gcc-c++'],
      pacman: ['gcc'],
    },
    extras: [],
  },
  {
    id: 'dotnet',
    displayName: 'C# (.NET SDK)',
    blurb: 'Build and run C# and F# projects with the dotnet CLI.',
    requires: [['dotnet']],
    optionalRuntimeIds: [],
    languageIds: ['csharp', 'fsharp'],
    docsUrl: 'https://dotnet.microsoft.com/download',
    packages: {
      winget: ['Microsoft.DotNet.SDK.8'],
      choco: ['dotnet-8.0-sdk'],
      brew: ['dotnet'],
      apt: ['dotnet-sdk-8.0'],
      dnf: ['dotnet-sdk-8.0'],
      pacman: ['dotnet-sdk'],
    },
    extras: [],
  },
  {
    id: 'php',
    displayName: 'PHP',
    blurb: 'Run PHP scripts from the editor.',
    requires: [['php']],
    optionalRuntimeIds: ['composer'],
    languageIds: ['php'],
    docsUrl: 'https://www.php.net/downloads',
    packages: {
      winget: ['PHP.PHP.8.3'],
      choco: ['php'],
      brew: ['php'],
      apt: ['php-cli'],
      dnf: ['php-cli'],
      pacman: ['php'],
    },
    extras: [],
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    blurb: 'Run Ruby scripts and Bundler projects.',
    requires: [['ruby']],
    optionalRuntimeIds: ['bundler'],
    languageIds: ['ruby'],
    docsUrl: 'https://www.ruby-lang.org/en/documentation/installation/',
    packages: {
      winget: ['RubyInstallerTeam.Ruby.3.3'],
      choco: ['ruby'],
      brew: ['ruby'],
      apt: ['ruby-full'],
      dnf: ['ruby'],
      pacman: ['ruby'],
    },
    extras: [],
  },
  {
    id: 'git',
    displayName: 'Git',
    blurb: 'Required by Source Control, diffs, and the Build agent history tools.',
    requires: [['git']],
    optionalRuntimeIds: [],
    languageIds: [],
    docsUrl: 'https://git-scm.com/downloads',
    packages: {
      winget: ['Git.Git'],
      choco: ['git'],
      brew: ['git'],
      apt: ['git'],
      dnf: ['git'],
      pacman: ['git'],
    },
    extras: [],
  },
] as const;

/**
 * Characters allowed in a command token.
 *
 * Every token AXIOM spawns is pinned in this file, so this is a defence in depth
 * check rather than input validation: it guarantees that no shell metacharacter can
 * ever appear in an argument vector even if this registry is edited carelessly.
 * Notably absent: whitespace, quotes, and `& | ; < > % $ ^ ! ( ) * ?` and backtick.
 */
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._@:+/\\-]+$/;

export function isSafeCommandToken(token: string): boolean {
  return token.length > 0 && token.length <= 200 && SAFE_COMMAND_TOKEN.test(token);
}

export function packageManagerDefinition(
  id: PackageManagerId | string,
): PackageManagerDefinition | undefined {
  return PACKAGE_MANAGERS.find((entry) => entry.id === id);
}

export function languagePack(id: string): LanguagePackDefinition | undefined {
  return LANGUAGE_PACKS.find((entry) => entry.id === id);
}

/** Find the language pack that satisfies a specific runtime id requirement. */
export function languagePackForRuntime(runtimeId: string): LanguagePackDefinition | undefined {
  return LANGUAGE_PACKS.find(
    (pack) =>
      pack.requires.some((group) => group.includes(runtimeId)) ||
      pack.optionalRuntimeIds.includes(runtimeId),
  );
}

/** Primary managers for a platform, best first. Extras-only managers are excluded. */
export function primaryManagersFor(platform: string): PackageManagerDefinition[] {
  return PACKAGE_MANAGERS.filter(
    (entry) => !entry.extrasOnly && entry.platforms.includes(platform),
  ).sort((a, b) => a.rank - b.rank);
}

/**
 * The exact argument vector for one install, or null when any token fails the
 * safety check. A null result must be treated as "do not run this".
 */
export function buildInstallArgv(
  manager: PackageManagerDefinition,
  packageId: string,
): string[] | null {
  const argv = [...manager.installArgs, packageId, ...manager.installTrailingArgs];
  return argv.every(isSafeCommandToken) ? argv : null;
}

/** A human-readable rendering of a command, for approval dialogs and the UI. */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

/** True when every requirement group has at least one available runtime id. */
export function isLanguagePackSatisfied(
  requires: readonly (readonly string[])[],
  availableRuntimeIds: ReadonlySet<string>,
): boolean {
  return requires.every((group) => group.some((id) => availableRuntimeIds.has(id)));
}

/** Every runtime id a pack mentions, required or optional, without duplicates. */
export function packRuntimeIds(pack: LanguagePackDefinition): string[] {
  const seen = new Set<string>();
  for (const group of pack.requires) for (const id of group) seen.add(id);
  for (const id of pack.optionalRuntimeIds) seen.add(id);
  return [...seen];
}

// ---------------------------------------------------------------------------
// Wire shapes for the LANGUAGES view.
//
// Main computes all of this, so the renderer holds no policy: it cannot choose a
// package manager, compose a command, or decide that something is installed.
// ---------------------------------------------------------------------------

/** One toolchain a pack depends on, with its detected state. */
export interface LanguageRuntimeStatus {
  id: string;
  displayName: string;
  installed: boolean;
  version: string | null;
  /** False for the nice-to-have tools, which never block "ready". */
  required: boolean;
}

/** One command AXIOM will run for an install, already rendered for display. */
export interface LanguageInstallStepPlan {
  manager: PackageManagerId;
  managerName: string;
  packageId: string;
  purpose: string;
  commandLine: string;
}

export interface LanguageInstallPlan {
  languageId: string;
  displayName: string;
  /** The chosen primary manager, or null when none is usable on this machine. */
  manager: PackageManagerId | null;
  managerName: string | null;
  /** Where that manager resolved to, shown in the approval dialog. */
  managerPath: string | null;
  /** True when AXIOM can run the install itself. */
  runnable: boolean;
  /** Why it cannot, when `runnable` is false. */
  blockedReason: string | null;
  steps: LanguageInstallStepPlan[];
  /** Copyable commands for the manual path (elevation required, or no manager). */
  manualCommands: string[];
}

/**
 * An add-on's detected state.
 *
 * Reported separately from the required toolchains because an add-on must never
 * decide whether a language is "ready" — Python runs perfectly well without debugpy.
 * It does need its own state though: without it, a language that is ready but missing
 * its debugger has no way to offer the one command that fixes that.
 */
export interface LanguageExtraStatus {
  manager: PackageManagerId;
  packageId: string;
  purpose: string;
  installed: boolean;
}

export interface LanguageCatalogEntry {
  id: string;
  displayName: string;
  blurb: string;
  docsUrl: string;
  languageIds: readonly string[];
  /** True when every required toolchain is present, so programs can run now. */
  ready: boolean;
  runtimes: LanguageRuntimeStatus[];
  extras: LanguageExtraStatus[];
  /** True when the language is ready but an add-on is still missing. */
  extrasMissing: boolean;
  plan: LanguageInstallPlan;
}

export interface LanguageManagerStatus {
  id: PackageManagerId;
  displayName: string;
  available: boolean;
  version: string | null;
  needsSudo: boolean;
  extrasOnly: boolean;
  docsUrl: string;
}

export interface LanguagesCatalog {
  platform: string;
  managers: LanguageManagerStatus[];
  entries: LanguageCatalogEntry[];
  /** True when at least one primary manager can be driven by AXIOM. */
  canAutoInstall: boolean;
}

export type LanguageInstallEvent =
  | {
      installId: string;
      kind: 'step';
      index: number;
      total: number;
      text: string;
    }
  | { installId: string; kind: 'output'; text: string }
  | {
      installId: string;
      kind: 'done';
      /** Every planned command exited zero. */
      ok: boolean;
      /** The toolchain is visible to AXIOM right now. */
      detected: boolean;
      /**
       * The install succeeded but the toolchain is still invisible, which on Windows
       * normally means the new PATH only reaches processes started after the
       * installer ran. A restart makes it visible.
       */
      restartRequired: boolean;
      text: string;
    };

export interface LanguageInstallStarted {
  installId: string;
  plan: LanguageInstallPlan;
}
