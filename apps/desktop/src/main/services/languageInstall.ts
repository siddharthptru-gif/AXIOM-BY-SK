import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { rootLogger } from '@axiom/shared';
import { buildChildProcessEnvironment } from './processEnvironment';
import { isShellShim, readVersion, resolveExecutable } from './executables';
import { detectRuntimes } from './runtimes';
import { runtimeDefinition } from '../../common/runtimes';
import {
  LANGUAGE_PACKS,
  PACKAGE_MANAGERS,
  buildInstallArgv,
  formatCommandLine,
  isLanguagePackSatisfied,
  isSafeCommandToken,
  languagePack,
  packRuntimeIds,
  packageManagerDefinition,
  primaryManagersFor,
  type LanguageCatalogEntry,
  type LanguageExtraStatus,
  type LanguageInstallEvent,
  type LanguageInstallPlan,
  type LanguageInstallStarted,
  type LanguageInstallStepPlan,
  type LanguageManagerStatus,
  type LanguagePackDefinition,
  type LanguageRuntimeStatus,
  type LanguagesCatalog,
  type PackageManagerDefinition,
} from '../../common/languagePacks';

/**
 * Language toolchain installation.
 *
 * The LANGUAGES view lets a user click once and end up able to run a program. Three
 * separate problems have to be solved for that to actually be true, and each one is
 * a place where a naive implementation silently fails:
 *
 * 1. WHAT TO INSTALL. Delegated entirely to the operating system's package manager,
 *    driven from the pinned registry in `common/languagePacks.ts`. AXIOM never
 *    downloads or executes an installer binary itself, so it never has to vouch for
 *    a payload it did not build. Argument vectors are assembled from that registry
 *    only — no renderer value, model output, or workspace file reaches an argv slot.
 *
 * 2. RUNNING IT HONESTLY. Installs take minutes and print a lot. Each command is
 *    spawned WITHOUT a shell, with the same narrow allowlisted child environment
 *    every other AXIOM child process gets, bounded by a wall-clock cap, with output
 *    streamed to the view under a size cap so a chatty installer cannot grow Main's
 *    memory. Elevation-requiring managers (apt/dnf/pacman) are never spawned: they
 *    would block forever on an invisible sudo password prompt, so those commands are
 *    surfaced for the user to run instead.
 *
 * 3. BEING ABLE TO SEE IT AFTERWARDS. This is the part that looks like a bug when it
 *    is missing. A Windows installer writes the new PATH into the registry and
 *    broadcasts a change message; it does NOT rewrite the environment of a process
 *    that is already running. AXIOM captured its PATH at launch, so a freshly
 *    installed Python stays invisible — the install "succeeds" and Run still says the
 *    language is missing. `refreshDetectionEnvironment` fixes that by re-reading PATH
 *    from the registry (the same source the OS itself uses) and updating Main's own
 *    PATH, after which detection, the terminal, and the language servers all see the
 *    new tool. When even that is not enough, the install reports
 *    `restartRequired` so the UI can say so plainly rather than leaving the user
 *    staring at a tool they just installed.
 */
const log = rootLogger.child('languages');

/** How long resolved package managers are reused before re-probing. */
const MANAGER_CACHE_TTL_MS = 60 * 1000;
/** Wall-clock cap for one install command. Generous: downloads can be large. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
/** Total streamed output per install, so a verbose installer cannot grow memory. */
const MAX_INSTALL_OUTPUT_CHARS = 200_000;
/** Upper bound on the merged PATH, guarding against pathological growth. */
const MAX_PATH_CHARS = 32_000;
/** Bound for the short read-only probes this module runs (`reg`, `--version`). */
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_OUTPUT_CAP = 16_000;

const WINDOWS_MACHINE_ENVIRONMENT_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const WINDOWS_USER_ENVIRONMENT_KEY = 'HKCU\\Environment';

function childEnv(): NodeJS.ProcessEnv {
  return buildChildProcessEnvironment({ color: false });
}

/**
 * Run a short, read-only command and capture its output.
 *
 * Spawned by absolute path with an argument array and no shell, so nothing in
 * `args` is ever interpreted as a command line.
 */
function runCapture(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    let settled = false;
    let failed = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      resolve(failed ? null : output);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish();
    }, PROBE_TIMEOUT_MS);
    const append = (chunk: Buffer): void => {
      if (output.length < PROBE_OUTPUT_CAP) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', () => {
      failed = true;
      finish();
    });
    child.on('close', finish);
  });
}

// ---------------------------------------------------------------------------
// PATH refresh
// ---------------------------------------------------------------------------

/** Pull the `Path` value out of `reg.exe query` output. */
function parseRegistryPath(output: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(raw);
    if (match) {
      const value = (match[1] ?? '').trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

/** Expand `%NAME%` references the way the OS would, case-insensitively. */
function expandWindowsVariables(value: string, source: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole: string, name: string) => {
    for (const key of Object.keys(source)) {
      if (key.toLowerCase() !== name.toLowerCase()) continue;
      const replacement = source[key];
      if (typeof replacement === 'string') return replacement;
    }
    return whole;
  });
}

async function readWindowsRegistryPath(
  reg: string,
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // The key is a literal constant from this module, passed as a single argv entry,
  // so the spaces in "Session Manager" need no quoting of our own.
  const output = await runCapture(reg, ['query', key, '/v', 'Path'], env);
  if (output === null) return null;
  const raw = parseRegistryPath(output);
  return raw === null ? null : expandWindowsVariables(raw, process.env);
}

/**
 * The identity of a PATH entry for de-duplication.
 *
 * A trailing separator is stripped because the registry and the inherited
 * environment disagree about it constantly — `C:\Program Files\nodejs` and
 * `C:\Program Files\nodejs\` are the same directory, and treating them as two
 * entries would slowly fill the length budget with duplicates.
 */
function pathEntryKey(entry: string): string {
  const trimmed = entry.replace(/[\\/]+$/, '');
  const base = trimmed.length > 0 ? trimmed : entry;
  return process.platform === 'win32' ? base.toLowerCase() : base;
}

/** Union of PATH lists, first occurrence wins, bounded in total length. */
function mergePathEntries(lists: readonly string[]): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  let length = 0;
  for (const list of lists) {
    for (const raw of list.split(delimiter)) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      const key = pathEntryKey(entry);
      if (seen.has(key)) continue;
      const projected = length === 0 ? entry.length : length + 1 + entry.length;
      if (projected > MAX_PATH_CHARS) continue;
      seen.add(key);
      entries.push(entry);
      length = projected;
    }
  }
  return entries.join(delimiter);
}

/** Directories a POSIX package manager commonly installs into. */
function posixCandidateDirectories(): string[] {
  const home = homedir();
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/local/go/bin',
    '/usr/bin',
    '/bin',
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin'),
  ];
}

/**
 * Re-read PATH from the operating system into Main's own environment.
 *
 * Returns true when PATH actually changed. Everything AXIOM spawns derives its
 * environment from `process.env` at call time, so a single update here is what makes
 * a newly installed toolchain visible to detection, the terminal, the Run system, and
 * the language servers without a restart.
 *
 * The only value written is PATH, and only from sources the OS already trusts to
 * decide what the user's own shell would run: the machine and user `Environment`
 * registry keys on Windows, and a fixed list of standard install directories
 * elsewhere. No privilege is gained, because nothing new becomes reachable that the
 * OS would not already have reached.
 */
export async function refreshDetectionEnvironment(): Promise<boolean> {
  const before = process.env.PATH ?? process.env.Path ?? '';
  let merged = before;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? process.env.windir;
    const reg = systemRoot ? join(systemRoot, 'System32', 'reg.exe') : null;
    if (reg && existsSync(reg)) {
      const env = childEnv();
      const machine = await readWindowsRegistryPath(reg, WINDOWS_MACHINE_ENVIRONMENT_KEY, env);
      const user = await readWindowsRegistryPath(reg, WINDOWS_USER_ENVIRONMENT_KEY, env);
      // Machine first, then user, then whatever this process already had: an entry
      // AXIOM was launched with is never dropped.
      merged = mergePathEntries([machine ?? '', user ?? '', before]);
    }
  } else {
    const existing = posixCandidateDirectories().filter((directory) => {
      try {
        return existsSync(directory);
      } catch {
        return false;
      }
    });
    merged = mergePathEntries([before, existing.join(delimiter)]);
  }
  if (merged.length === 0 || merged === before) return false;
  process.env.PATH = merged;
  if (typeof process.env.Path === 'string') process.env.Path = merged;
  log.info('Detection PATH refreshed from the operating system', {
    entriesBefore: before.split(delimiter).filter((entry) => entry.trim().length > 0).length,
    entriesAfter: merged.split(delimiter).filter((entry) => entry.trim().length > 0).length,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

interface ResolvedManager {
  definition: PackageManagerDefinition;
  /** Absolute path (or bare command) when present, null when not installed. */
  executable: string | null;
  version: string | null;
}

let managerCache: { at: number; managers: ResolvedManager[] } | null = null;

async function resolveManagers(refresh: boolean): Promise<ResolvedManager[]> {
  const now = Date.now();
  if (!refresh && managerCache && now - managerCache.at < MANAGER_CACHE_TTL_MS) {
    return managerCache.managers;
  }
  const env = childEnv();
  const managers: ResolvedManager[] = [];
  for (const definition of PACKAGE_MANAGERS) {
    if (!definition.platforms.includes(process.platform)) {
      managers.push({ definition, executable: null, version: null });
      continue;
    }
    const resolved = await resolveExecutable(definition.commands, ['--version'], env).catch(
      () => null,
    );
    if (!resolved) {
      managers.push({ definition, executable: null, version: null });
      continue;
    }
    const version = await readVersion(resolved.path, ['--version'], env).catch(() => null);
    managers.push({ definition, executable: resolved.path, version });
  }
  managerCache = { at: Date.now(), managers };
  return managers;
}

function findManager(managers: readonly ResolvedManager[], id: string): ResolvedManager | undefined {
  return managers.find((entry) => entry.definition.id === id);
}

// ---------------------------------------------------------------------------
// Install planning
// ---------------------------------------------------------------------------

function stepFor(
  definition: PackageManagerDefinition,
  command: string,
  packageId: string,
  purpose: string,
): LanguageInstallStepPlan | null {
  const argv = buildInstallArgv(definition, packageId);
  if (!argv) return null;
  return {
    manager: definition.id,
    managerName: definition.displayName,
    packageId,
    purpose,
    commandLine: formatCommandLine(command, argv),
  };
}

/**
 * Detect a pack's add-ons.
 *
 * Add-ons are packages inside a language's own ecosystem (debugpy for Python), not
 * executables on PATH, so the toolchain registry cannot see them. Without this, a
 * machine where Python is installed but debugpy is not looks completely healthy while
 * the debugger stays unavailable — which is exactly the state a user reported.
 *
 * `pip show` is read-only and exits non-zero when the package is absent, so the
 * presence of a `Name:` header is what decides, not the exit code.
 */
async function probeExtras(
  pack: LanguagePackDefinition,
  managers: readonly ResolvedManager[],
  env: NodeJS.ProcessEnv,
): Promise<LanguageExtraStatus[]> {
  const statuses: LanguageExtraStatus[] = [];
  for (const extra of pack.extras) {
    const definition = packageManagerDefinition(extra.manager);
    if (!definition || !definition.platforms.includes(process.platform)) continue;
    let installed = false;
    const resolved = findManager(managers, definition.id);
    if (
      resolved?.executable &&
      !isShellShim(resolved.executable) &&
      definition.id === 'pip' &&
      isSafeCommandToken(extra.packageId)
    ) {
      const output = await runCapture(resolved.executable, ['show', extra.packageId], env);
      installed = output !== null && /^Name:\s/im.test(output);
    }
    statuses.push({
      manager: extra.manager,
      packageId: extra.packageId,
      purpose: extra.purpose,
      installed,
    });
  }
  return statuses;
}

/**
 * Decide how a pack would be installed on this machine.
 *
 * Pure with respect to the machine: it only consults already-resolved managers and
 * already-probed state, so building the whole catalog does not re-probe per language.
 *
 * Two distinct jobs are planned here, and conflating them was a bug: installing the
 * TOOLCHAIN when the language is missing, and installing only the ADD-ONS when the
 * language is present but incomplete. A ready language with a missing debugger still
 * needs one runnable command.
 */
function planFor(
  pack: LanguagePackDefinition,
  managers: readonly ResolvedManager[],
  state: { satisfied: boolean; extras: readonly LanguageExtraStatus[] },
): LanguageInstallPlan {
  const empty: LanguageInstallPlan = {
    languageId: pack.id,
    displayName: pack.displayName,
    manager: null,
    managerName: null,
    managerPath: null,
    runnable: false,
    blockedReason: null,
    steps: [],
    manualCommands: [],
  };

  const steps: LanguageInstallStepPlan[] = [];
  let chosen: PackageManagerDefinition | null = null;
  let chosenPath: string | null = null;

  if (!state.satisfied) {
    const platformManagers = primaryManagersFor(process.platform);
    const withPackages = platformManagers.filter((definition) => {
      const ids = pack.packages[definition.id];
      return ids !== undefined && ids.length > 0;
    });

    if (withPackages.length === 0) {
      return {
        ...empty,
        blockedReason: `AXIOM has no packaged installer for ${pack.displayName} on this platform. Install it from the official download page, then use Re-scan.`,
      };
    }

    const usable = withPackages.find((definition) => {
      if (definition.needsSudo) return false;
      const resolved = findManager(managers, definition.id);
      return (
        resolved?.executable !== null &&
        resolved?.executable !== undefined &&
        !isShellShim(resolved.executable)
      );
    });

    if (!usable) {
      // No manager AXIOM can drive. Offer the exact command instead of pretending.
      const fallback = withPackages[0];
      const manualCommands: string[] = [];
      if (fallback) {
        for (const packageId of pack.packages[fallback.id] ?? []) {
          const argv = buildInstallArgv(fallback, packageId);
          if (!argv) continue;
          const command = fallback.commands[0] ?? fallback.id;
          const line = formatCommandLine(command, argv);
          manualCommands.push(fallback.needsSudo ? `sudo ${line}` : line);
        }
      }
      const installedSudoManager = withPackages.find((definition) => {
        if (!definition.needsSudo) return false;
        const resolved = findManager(managers, definition.id);
        return resolved?.executable !== null && resolved?.executable !== undefined;
      });
      const reason = installedSudoManager
        ? `Installing ${pack.displayName} here needs administrator rights, and a hidden password prompt would hang. Run the command below in a terminal, then use Re-scan.`
        : `No supported package manager was found on this machine. Install ${pack.displayName} from its official download page, then use Re-scan.`;
      return { ...empty, blockedReason: reason, manualCommands };
    }

    const resolved = findManager(managers, usable.id);
    const command = resolved?.executable ?? usable.commands[0] ?? usable.id;
    for (const packageId of pack.packages[usable.id] ?? []) {
      const step = stepFor(usable, command, packageId, `Install ${pack.displayName}`);
      if (step) steps.push(step);
    }
    chosen = usable;
    chosenPath = resolved?.executable ?? null;
  }

  for (const extra of state.extras) {
    if (extra.installed) continue;
    const definition = packageManagerDefinition(extra.manager);
    if (!definition || !definition.platforms.includes(process.platform)) continue;
    const extraResolved = findManager(managers, definition.id);
    // When the toolchain itself is missing, the add-on's manager usually arrives WITH
    // it, so the step is planned optimistically and the runner skips it if it never
    // appears. When the toolchain is already present, an absent manager means the
    // step genuinely cannot run, so it is not offered.
    if (state.satisfied && (!extraResolved?.executable || isShellShim(extraResolved.executable))) {
      continue;
    }
    const extraCommand = extraResolved?.executable ?? definition.commands[0] ?? definition.id;
    const step = stepFor(definition, extraCommand, extra.packageId, extra.purpose);
    if (!step) continue;
    steps.push(step);
    if (!chosen) {
      chosen = definition;
      chosenPath = extraResolved?.executable ?? null;
    }
  }

  // Nothing left to do is not an error, and must not be reported as one.
  if (steps.length === 0 || !chosen) return empty;

  return {
    languageId: pack.id,
    displayName: pack.displayName,
    manager: chosen.id,
    managerName: chosen.displayName,
    managerPath: chosenPath,
    runnable: true,
    blockedReason: null,
    steps,
    manualCommands: [],
  };
}

/** The install plan for one pack, probing the machine as needed. */
export async function planLanguageInstall(languageId: string): Promise<LanguageInstallPlan> {
  const pack = languagePack(languageId);
  if (!pack) throw new Error('Unknown language pack.');
  const env = childEnv();
  const managers = await resolveManagers(false);
  const detected = await detectRuntimes();
  const availableIds = new Set(
    detected.filter((entry) => entry.path !== null).map((entry) => entry.id),
  );
  const extras = await probeExtras(pack, managers, env);
  return planFor(pack, managers, {
    satisfied: isLanguagePackSatisfied(pack.requires, availableIds),
    extras,
  });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Everything the LANGUAGES view renders: what is installed, what each language
 * needs, and how it would be installed. All of the policy lives here so the
 * renderer cannot choose a package manager or compose a command.
 */
export async function buildLanguagesCatalog(
  options: { refresh?: boolean } = {},
): Promise<LanguagesCatalog> {
  const refresh = options.refresh === true;
  const env = childEnv();
  const runtimes = await detectRuntimes(refresh ? { refresh: true } : {});
  const managers = await resolveManagers(refresh);

  const detectedById = new Map(runtimes.map((entry) => [entry.id, entry]));
  const availableIds = new Set(
    runtimes.filter((entry) => entry.path !== null).map((entry) => entry.id),
  );

  const entries: LanguageCatalogEntry[] = [];
  for (const pack of LANGUAGE_PACKS) {
    const requiredIds = new Set<string>();
    for (const group of pack.requires) for (const id of group) requiredIds.add(id);
    const statuses: LanguageRuntimeStatus[] = packRuntimeIds(pack).map((id) => {
      const detected = detectedById.get(id);
      const definition = runtimeDefinition(id);
      return {
        id,
        displayName: detected?.displayName ?? definition?.displayName ?? id,
        installed: detected?.path !== null && detected?.path !== undefined,
        version: detected?.version ?? null,
        required: requiredIds.has(id),
      };
    });
    const ready = isLanguagePackSatisfied(pack.requires, availableIds);
    // Add-ons are only worth probing once the language itself is present; before
    // that they are missing by definition, and `pip show` would just be a slow no.
    const extras = ready
      ? await probeExtras(pack, managers, env)
      : pack.extras.map((extra) => ({
          manager: extra.manager,
          packageId: extra.packageId,
          purpose: extra.purpose,
          installed: false,
        }));
    entries.push({
      id: pack.id,
      displayName: pack.displayName,
      blurb: pack.blurb,
      docsUrl: pack.docsUrl,
      languageIds: pack.languageIds,
      ready,
      runtimes: statuses,
      extras,
      extrasMissing: extras.some((extra) => !extra.installed),
      plan: planFor(pack, managers, { satisfied: ready, extras }),
    });
  }

  const managerStatuses: LanguageManagerStatus[] = managers
    .filter((entry) => entry.definition.platforms.includes(process.platform))
    .map((entry) => ({
      id: entry.definition.id,
      displayName: entry.definition.displayName,
      available: entry.executable !== null,
      version: entry.version,
      needsSudo: entry.definition.needsSudo,
      extrasOnly: entry.definition.extrasOnly,
      docsUrl: entry.definition.docsUrl,
    }));

  return {
    platform: process.platform,
    managers: managerStatuses,
    entries,
    canAutoInstall: entries.some((entry) => entry.plan.runnable),
  };
}

// ---------------------------------------------------------------------------
// Install execution
// ---------------------------------------------------------------------------

type EventSink = (event: LanguageInstallEvent) => void;

let sink: EventSink = () => undefined;

export function setLanguageInstallEventSink(fn: EventSink): void {
  sink = fn;
}

interface ActiveInstall {
  id: string;
  languageId: string;
  plan: LanguageInstallPlan;
  child: ChildProcess | null;
  cancelled: boolean;
  emittedChars: number;
}

/**
 * One install at a time, process-wide. Package managers take machine-wide locks, so
 * a second concurrent install would fail confusingly rather than go faster.
 */
let active: ActiveInstall | null = null;

export function isLanguageInstallRunning(): boolean {
  return active !== null;
}

function emit(event: LanguageInstallEvent): void {
  try {
    sink(event);
  } catch {
    // A failing sink must never abort an install that is already underway.
  }
}

function emitOutput(record: ActiveInstall, text: string): void {
  if (text.length === 0 || record.emittedChars >= MAX_INSTALL_OUTPUT_CHARS) return;
  const remaining = MAX_INSTALL_OUTPUT_CHARS - record.emittedChars;
  const clipped =
    text.length > remaining ? `${text.slice(0, remaining)}\n[output truncated]\n` : text;
  record.emittedChars += clipped.length;
  emit({ installId: record.id, kind: 'output', text: clipped });
}

/**
 * Stop a child and, on Windows, the process tree under it. An installer usually
 * spawns helpers, and killing only the parent would leave those running.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  if (process.platform !== 'win32' || typeof pid !== 'number') return;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? process.env.windir;
  if (!systemRoot) return;
  const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
  if (!existsSync(taskkill)) return;
  try {
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: childEnv(),
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => undefined);
    killer.unref();
  } catch {
    // Best effort: the primary kill above has already been attempted.
  }
}

/** Run one install command to completion, streaming its output. */
function runStep(
  record: ActiveInstall,
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null;
    try {
      child = spawn(executable, [...args], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      emitOutput(record, `Could not start the package manager: ${describe(error)}\n`);
      resolve(null);
      return;
    }
    const process_ = child;
    record.child = process_;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (record.child === process_) record.child = null;
      process_.removeAllListeners();
      resolve(code);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      emitOutput(record, '\nThis command exceeded 20 minutes and was stopped.\n');
      killTree(process_);
      finish(null);
    }, STEP_TIMEOUT_MS);
    const append = (chunk: Buffer): void => emitOutput(record, chunk.toString('utf8'));
    process_.stdout?.on('data', append);
    process_.stderr?.on('data', append);
    process_.on('error', (error) => {
      emitOutput(record, `\nThe package manager failed to run: ${error.message}\n`);
      finish(null);
    });
    process_.on('close', (code) => finish(code));
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runInstall(record: ActiveInstall): Promise<void> {
  const env = childEnv();
  const total = record.plan.steps.length;
  let ok = true;
  let failure: string | null = null;

  for (let index = 0; index < total; index += 1) {
    const step = record.plan.steps[index];
    if (!step) continue;
    if (record.cancelled) {
      ok = false;
      failure = 'Install cancelled.';
      break;
    }
    emit({
      installId: record.id,
      kind: 'step',
      index: index + 1,
      total,
      text: step.commandLine,
    });

    const definition = packageManagerDefinition(step.manager);
    if (!definition) {
      ok = false;
      failure = 'The planned package manager is no longer known.';
      break;
    }

    // Resolved fresh per step: pip only exists after Python has been installed.
    const resolved = await resolveExecutable(definition.commands, ['--version'], env).catch(
      () => null,
    );
    if (!resolved || isShellShim(resolved.path)) {
      if (definition.extrasOnly) {
        emitOutput(record, `Skipped: ${definition.displayName} is not available yet.\n`);
        continue;
      }
      ok = false;
      failure = `${definition.displayName} could not be started.`;
      break;
    }

    const argv = buildInstallArgv(definition, step.packageId);
    if (!argv) {
      ok = false;
      failure = 'Refused to run an install command that failed the safety check.';
      break;
    }

    const code = await runStep(record, resolved.path, argv, env);
    if (record.cancelled) {
      ok = false;
      failure = 'Install cancelled.';
      break;
    }
    if (code !== 0) {
      if (definition.extrasOnly) {
        emitOutput(record, `\nOptional step did not succeed (exit ${String(code)}); continuing.\n`);
        continue;
      }
      ok = false;
      failure = `${definition.displayName} exited with code ${String(code)}.`;
      break;
    }
  }

  // Re-read the machine whatever happened: even a failed run can have installed
  // part of a toolchain, and reporting stale state would be worse than slow.
  let detected = false;
  let pathChanged = false;
  try {
    pathChanged = await refreshDetectionEnvironment();
    const runtimes = await detectRuntimes({ refresh: true });
    const availableIds = new Set(
      runtimes.filter((entry) => entry.path !== null).map((entry) => entry.id),
    );
    const pack = languagePack(record.languageId);
    detected = pack ? isLanguagePackSatisfied(pack.requires, availableIds) : false;
  } catch (error) {
    log.warn('Post-install detection failed', { reason: describe(error) });
  }

  const restartRequired = ok && !detected;
  const text = !ok
    ? (failure ?? 'The install did not complete.')
    : detected
      ? `${record.plan.displayName} is installed and AXIOM can see it. You can run programs now.`
      : `${record.plan.displayName} was installed, but this AXIOM session still cannot see it. Restart AXIOM and it will be detected.`;

  log.info('Language install finished', {
    languageId: record.languageId,
    ok,
    detected,
    restartRequired,
    pathChanged,
  });

  emit({ installId: record.id, kind: 'done', ok, detected, restartRequired, text });
  if (active === record) active = null;
}

/**
 * Begin an approved install.
 *
 * The caller is responsible for having obtained native approval for exactly this
 * plan. The returned id is created synchronously and the run is deferred to the next
 * tick, so the caller can bind its event listener before the first event is emitted.
 */
export function startLanguageInstall(plan: LanguageInstallPlan): LanguageInstallStarted {
  if (active) throw new Error('Another toolchain install is already running.');
  if (!plan.runnable || plan.steps.length === 0) {
    throw new Error(plan.blockedReason ?? 'This toolchain cannot be installed automatically.');
  }
  const record: ActiveInstall = {
    id: randomUUID(),
    languageId: plan.languageId,
    plan,
    child: null,
    cancelled: false,
    emittedChars: 0,
  };
  active = record;
  setImmediate(() => {
    void runInstall(record).catch((error: unknown) => {
      log.warn('Language install crashed', { reason: describe(error) });
      emit({
        installId: record.id,
        kind: 'done',
        ok: false,
        detected: false,
        restartRequired: false,
        text: 'The install stopped unexpectedly.',
      });
      if (active === record) active = null;
    });
  });
  return { installId: record.id, plan };
}

export function cancelLanguageInstall(installId: string): void {
  if (!active || active.id !== installId) return;
  active.cancelled = true;
  if (active.child) killTree(active.child);
}

/** Stop any running install, for shutdown and owner-window teardown. */
export function cancelAllLanguageInstalls(): void {
  if (!active) return;
  cancelLanguageInstall(active.id);
}
