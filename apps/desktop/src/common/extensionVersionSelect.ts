/**
 * Version compatibility and version selection (PRD Ch. 43).
 *
 * The engine gate decides whether an extension may install at all, and the selection
 * policy decides *which* published build gets installed. Both are pure filters over a
 * candidate list so the same code runs at install time, at update-check time, and again
 * after an Axiom upgrade revalidates everything.
 *
 * The compat version is read from `AXIOM_VSCODE_API_VERSION` rather than re-declared
 * here. The PRD's table quotes 1.95.0, but the shipped platform already advertises 1.96.0
 * to extensions (`HOST_VSCODE_VERSION`), and answering `engines.vscode` with a different
 * number than the one the shim reports would let an extension install and then find a
 * newer API surface than it gated on — the two must be the same string.
 *
 * Pure: no I/O. Existing `semverRange` and `compareVersions` helpers do the semver work;
 * this module only layers the policy on top.
 */
import { compareVersions, parseSemver } from './extensionRegistryIndex';
import { satisfiesRange } from './semverRange';
import { AXIOM_VSCODE_API_VERSION } from './vscodeManifest';

/** The version `engines.vscode` is tested against. */
export const AXIOM_COMPAT_VERSION = AXIOM_VSCODE_API_VERSION;

/**
 * Is an extension compatible with this editor build?
 *
 * A range that cannot be parsed is *not* treated as compatible: `satisfiesRange` returns
 * null there, and defaulting an unreadable engine constraint to "yes" would install
 * extensions whose authors explicitly tried to exclude this build.
 */
export function isEngineCompatible(
  engineRange: string | undefined,
  compatVersion: string = AXIOM_COMPAT_VERSION,
): boolean {
  if (engineRange === undefined || engineRange.trim().length === 0) return false;
  // Pre-release identifiers on the compat version are ignored for matching (43.1), so an
  // insider build of Axiom does not fail every `^1.96.0` range.
  const { parts } = parseSemver(compatVersion);
  const base = `${parts[0] ?? 0}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
  return satisfiesRange(base, engineRange) === true;
}

/** The message shown when the gate rejects an install (43.1). */
export function incompatibleMessage(engineRange: string | undefined): string {
  const range = (engineRange ?? '').trim();
  return range.length === 0
    ? 'This extension does not declare a supported editor version.'
    : `Requires editor version ${range} or newer`;
}

/**
 * The target platforms a published build may declare.
 *
 * This is the marketplace's own vocabulary, not Node's: a package is built for
 * `<os>-<arch>` and the registry serves it under exactly that string. `universal` means the
 * publisher shipped one build for everything, and `web` is a browser-only build a desktop
 * editor must never install.
 */
export const TARGET_PLATFORMS = [
  'win32-x64',
  'win32-arm64',
  'win32-ia32',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
  'alpine-x64',
  'alpine-arm64',
  'web',
  'universal',
] as const;

export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

export function isTargetPlatform(value: unknown): value is TargetPlatform {
  return typeof value === 'string' && (TARGET_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Translate the running process's platform and architecture into the marketplace's target.
 *
 * `undefined` for anything unrecognised, and that is deliberate: an unknown host must fall
 * through to "no platform-specific build matches" rather than guess at one, because
 * installing a native binary built for a different ABI fails at activation with an error no
 * user can act on.
 *
 * Alpine is not derivable from `process.platform` (it reports `linux`), so a musl host is
 * passed in explicitly by the caller that knows.
 */
export function targetPlatformFor(
  platform: string,
  arch: string,
  libc: 'glibc' | 'musl' = 'glibc',
): TargetPlatform | undefined {
  if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64';
    if (arch === 'arm64') return 'win32-arm64';
    if (arch === 'ia32') return 'win32-ia32';
    return undefined;
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'darwin-x64';
    if (arch === 'arm64') return 'darwin-arm64';
    return undefined;
  }
  if (platform === 'linux') {
    if (libc === 'musl') {
      if (arch === 'x64') return 'alpine-x64';
      if (arch === 'arm64') return 'alpine-arm64';
      return undefined;
    }
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
    if (arch === 'arm') return 'linux-armhf';
    return undefined;
  }
  return undefined;
}

export interface VersionCandidate {
  version: string;
  /** The candidate's own `engines.vscode`. */
  engine?: string;
  /** `undefined` or `'universal'` means "runs anywhere". */
  targetPlatform?: string;
  preRelease?: boolean;
}

export interface VersionSelectOptions {
  compatVersion?: string;
  /** The running platform, e.g. `win32-x64`. */
  platform?: string;
  /** Per-extension, persisted pre-release opt-in. */
  allowPreRelease?: boolean;
  /** Versions blocked for this app version by the Ch. 34 kill switch. */
  blocked?: readonly string[];
  /**
   * Extra ranges every candidate must also satisfy — the intersection used when two
   * dependents disagree about a shared dependency (42.4).
   */
  requiredRanges?: readonly string[];
}

export type VersionRejectReason = 'engine' | 'platform' | 'pre-release' | 'blocked' | 'range';

export interface VersionSelection {
  /** The chosen build, or null when every candidate was filtered out. */
  picked: VersionCandidate | null;
  /** Why each rejected candidate lost, for the "Show Compatible Versions" list. */
  rejected: Array<{ version: string; reason: VersionRejectReason }>;
}

function platformMatches(candidate: VersionCandidate, platform: string | undefined): boolean {
  const target = candidate.targetPlatform;
  if (target === undefined || target === 'universal' || target === 'undefined') return true;
  return platform !== undefined && target === platform;
}

/**
 * Apply the 43.2 selection policy: filter, sort descending, take the first.
 *
 * Rejections are reported alongside the pick rather than dropped, because "no compatible
 * version" and "only pre-release versions are compatible" need different UI.
 */
export function selectVersion(
  candidates: readonly VersionCandidate[],
  options: VersionSelectOptions = {},
): VersionSelection {
  const compatVersion = options.compatVersion ?? AXIOM_COMPAT_VERSION;
  const blocked = new Set(options.blocked ?? []);
  const rejected: Array<{ version: string; reason: VersionRejectReason }> = [];
  const viable: VersionCandidate[] = [];

  for (const candidate of candidates) {
    if (typeof candidate?.version !== 'string' || candidate.version.trim().length === 0) continue;
    if (blocked.has(candidate.version)) {
      rejected.push({ version: candidate.version, reason: 'blocked' });
      continue;
    }
    if (!isEngineCompatible(candidate.engine, compatVersion)) {
      rejected.push({ version: candidate.version, reason: 'engine' });
      continue;
    }
    if (!platformMatches(candidate, options.platform)) {
      rejected.push({ version: candidate.version, reason: 'platform' });
      continue;
    }
    if (candidate.preRelease === true && options.allowPreRelease !== true) {
      rejected.push({ version: candidate.version, reason: 'pre-release' });
      continue;
    }
    const ranges = options.requiredRanges ?? [];
    if (ranges.some((range) => satisfiesRange(candidate.version, range) !== true)) {
      rejected.push({ version: candidate.version, reason: 'range' });
      continue;
    }
    viable.push(candidate);
  }

  viable.sort((a, b) => compareVersions(b.version, a.version));
  return { picked: viable[0] ?? null, rejected };
}

/**
 * Versions to offer under "Show Compatible Versions" — engine-compatible builds only,
 * newest first, including pre-releases so the user can opt in explicitly.
 */
export function compatibleVersions(
  candidates: readonly VersionCandidate[],
  options: VersionSelectOptions = {},
): VersionCandidate[] {
  const compatVersion = options.compatVersion ?? AXIOM_COMPAT_VERSION;
  const blocked = new Set(options.blocked ?? []);
  return candidates
    .filter(
      (candidate) =>
        typeof candidate?.version === 'string' &&
        !blocked.has(candidate.version) &&
        isEngineCompatible(candidate.engine, compatVersion) &&
        platformMatches(candidate, options.platform),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** What an Axiom version change forces (43.3). */
export type CompatChangeEffect = 'none' | 'revalidate' | 'full-revalidate';

/**
 * Classify an Axiom upgrade.
 *
 * A patch bump cannot change compatibility, so nothing is revalidated — that matters
 * because revalidation re-queries the gallery for every installed extension.
 */
export function classifyAxiomUpgrade(previous: string, next: string): CompatChangeEffect {
  const before = parseSemver(previous).parts;
  const after = parseSemver(next).parts;
  if ((after[0] ?? 0) !== (before[0] ?? 0)) return 'full-revalidate';
  if ((after[1] ?? 0) !== (before[1] ?? 0)) return 'revalidate';
  return 'none';
}

/** Caches a major upgrade must purge before extensions load again (43.3). */
export const MAJOR_UPGRADE_PURGE = ['v8-code-cache', 'gallery', 'compatibility'] as const;

export interface UpdateDecision {
  /** True when the newer build may be installed. */
  apply: boolean;
  /** Set when the update exists but is held back. */
  withheldMessage?: string;
}

/**
 * Decide whether an available update may be taken (43.3, last row).
 *
 * An update that raises `engines.vscode` past this build is withheld rather than failed:
 * the extension keeps working on its current version and the UI explains why it is stuck,
 * which is far less alarming than an install error the user cannot act on.
 */
export function decideUpdate(
  candidate: VersionCandidate,
  options: VersionSelectOptions = {},
): UpdateDecision {
  const compatVersion = options.compatVersion ?? AXIOM_COMPAT_VERSION;
  if (isEngineCompatible(candidate.engine, compatVersion)) return { apply: true };
  return {
    apply: false,
    withheldMessage: `Update available but requires a newer editor (needs ${candidate.engine ?? 'unknown'}, this build reports ${compatVersion}).`,
  };
}
