/**
 * Compatibility-matrix model (PRD Epoch J §224 / Phase 276 — "Compatibility Matrix
 * Testing"). Pure, I/O-free capability/tier model that turns a concrete runtime
 * environment (OS × arch × hardware tier × GPU × shell × encoding × locale ×
 * proxy/CA) into an honest support verdict plus the graceful-fallback actions that
 * keep Axiom usable on that environment. Also builds the cartesian test matrix so a
 * runner can count green / degraded / unsupported cells ("green across the matrix,
 * or documented degradations"). Smoke-tested; a main-side probe fills an EnvProfile
 * from process/GPU/shell facts and the workbench surfaces the report + fallbacks.
 */

export type OsName = 'win10' | 'win11' | 'macos' | 'linux' | 'unknown';
export type Arch = 'x64' | 'arm64' | 'unknown';
export type HardwareTier = 'low' | 'mid' | 'high';
/** GPU acceleration status as reported by the compositor (ANGLE/WebGL). */
export type GpuStatus = 'hardware' | 'software' | 'disabled';
export type Shell = 'cmd' | 'pwsh' | 'gitbash' | 'wsl' | 'bash' | 'zsh' | 'unknown';
export type SupportLevel = 'supported' | 'degraded' | 'unsupported';
export type CompatDimension =
  'os' | 'arch' | 'hardware' | 'gpu' | 'shell' | 'encoding' | 'locale' | 'network';

/** A raw environment snapshot (all optional — the probe fills what it can). */
export interface EnvProfile {
  os?: OsName;
  /** OS version string, e.g. "10.0.22631" — used to split Win10 vs Win11. */
  osVersion?: string;
  arch?: Arch;
  /** True when an ARM64 build is actually running under x64 emulation. */
  emulated?: boolean;
  cpuCores?: number;
  memoryGB?: number;
  gpu?: GpuStatus;
  shell?: Shell;
  /** Text encoding of the active file / console, e.g. "utf-8", "utf-16le", "cp1252". */
  encoding?: string;
  /** BCP-47 locale, e.g. "en-US", "ar-EG". */
  locale?: string;
  /** Right-to-left script (Arabic/Hebrew/Farsi). */
  rtl?: boolean;
  /** A proxy is configured for outbound requests. */
  proxy?: boolean;
  /** A custom/enterprise root CA must be trusted. */
  customCa?: boolean;
}

/** Classify a hardware tier from CPU cores + RAM (worst of the two dimensions). */
export function classifyHardwareTier(cpuCores?: number, memoryGB?: number): HardwareTier {
  const cores =
    Number.isFinite(cpuCores) && (cpuCores as number) > 0 ? Math.floor(cpuCores as number) : 2;
  const ram = Number.isFinite(memoryGB) && (memoryGB as number) > 0 ? (memoryGB as number) : 4;
  if (cores <= 2 || ram < 4) return 'low';
  if (cores >= 8 && ram >= 16) return 'high';
  return 'mid';
}

/** Normalize a platform + version into a specific OS name. */
export function classifyOs(os?: OsName, osVersion?: string): OsName {
  if (os === 'win10' || os === 'win11') return os;
  if (os === 'macos' || os === 'linux') return os;
  // Windows build 22000+ is Windows 11; below that is Windows 10.
  const build = parseWindowsBuild(osVersion);
  if (build !== undefined) return build >= 22000 ? 'win11' : 'win10';
  return 'unknown';
}

function parseWindowsBuild(version?: string): number | undefined {
  if (!version) return undefined;
  const m = /^10\.0\.(\d+)/.exec(version.trim());
  if (!m) return undefined;
  const build = Number(m[1]);
  return Number.isFinite(build) ? build : undefined;
}

// ---- per-dimension support verdicts (used by both the report and the matrix) ----

/** Windows 10/11 are the primary 1.0 target; mac/Linux are documented Epoch-K work. */
export function osSupport(os: OsName): SupportLevel {
  if (os === 'win10' || os === 'win11') return 'supported';
  if (os === 'macos' || os === 'linux') return 'degraded';
  return 'unsupported';
}

export function archSupport(arch: Arch, emulated = false): SupportLevel {
  if (arch === 'x64') return 'supported';
  if (arch === 'arm64') return emulated ? 'degraded' : 'supported';
  return 'unsupported';
}

export function tierSupport(tier: HardwareTier): SupportLevel {
  return tier === 'low' ? 'degraded' : 'supported';
}

export function gpuSupport(gpu: GpuStatus): SupportLevel {
  return gpu === 'hardware' ? 'supported' : 'degraded';
}

const KNOWN_SHELLS: readonly Shell[] = ['cmd', 'pwsh', 'gitbash', 'wsl', 'bash', 'zsh'];

export function shellSupport(shell: Shell): SupportLevel {
  return KNOWN_SHELLS.includes(shell) ? 'supported' : 'degraded';
}

const UTF_ENCODINGS = new Set([
  'utf-8',
  'utf8',
  'utf-16le',
  'utf16le',
  'utf-16be',
  'ascii',
  'us-ascii',
]);

/** Normalize an encoding label and decide whether it needs transcoding. */
export function encodingSupport(encoding?: string): {
  level: SupportLevel;
  needsTranscode: boolean;
} {
  const enc = (encoding ?? 'utf-8').trim().toLowerCase();
  if (enc === 'utf-8' || enc === 'utf8' || enc === 'ascii' || enc === 'us-ascii') {
    return { level: 'supported', needsTranscode: false };
  }
  if (UTF_ENCODINGS.has(enc)) {
    // UTF-16 is handled but re-encoded to UTF-8 on save.
    return { level: 'supported', needsTranscode: true };
  }
  return { level: 'degraded', needsTranscode: true };
}

/** The worst (most severe) support level in a list; empty ⇒ supported. */
export function worstLevel(levels: readonly SupportLevel[]): SupportLevel {
  let worst: SupportLevel = 'supported';
  for (const l of levels) {
    if (l === 'unsupported') return 'unsupported';
    if (l === 'degraded') worst = 'degraded';
  }
  return worst;
}

export interface CompatCheck {
  dimension: CompatDimension;
  level: SupportLevel;
  detail: string;
  /** A concrete adaptive/fallback action taken to keep this dimension working. */
  fallback?: string;
}

export interface CompatReport {
  os: OsName;
  arch: Arch;
  tier: HardwareTier;
  overall: SupportLevel;
  checks: CompatCheck[];
  /** Active graceful-fallback / adaptive actions (deduped, in dimension order). */
  fallbacks: string[];
  /** Reasons the environment is unsupported (empty unless overall === 'unsupported'). */
  blockers: string[];
  summary: string;
}

/**
 * Evaluate a single environment into a full compatibility report: one check per
 * dimension (each with a support level and, where relevant, the fallback action),
 * an overall verdict (worst dimension), the deduped list of active fallbacks, and
 * any hard blockers.
 */
export function evaluateCompatibility(env: EnvProfile): CompatReport {
  const os = classifyOs(env.os, env.osVersion);
  const arch = env.arch ?? 'unknown';
  const tier = classifyHardwareTier(env.cpuCores, env.memoryGB);
  const gpu = env.gpu ?? 'hardware';
  const shell = env.shell ?? 'unknown';
  const emulated = env.emulated === true;

  const checks: CompatCheck[] = [];

  // OS
  checks.push(osCheck(os));
  // Arch
  checks.push(archCheck(arch, emulated));
  // Hardware tier
  checks.push(hardwareCheck(tier));
  // GPU
  checks.push(gpuCheck(gpu));
  // Shell
  checks.push(shellCheck(shell));
  // Encoding
  checks.push(encodingCheck(env.encoding));
  // Locale / RTL
  checks.push(localeCheck(env.locale, env.rtl === true));
  // Network (proxy + custom CA)
  checks.push(networkCheck(env.proxy === true, env.customCa === true));

  const overall = worstLevel(checks.map((c) => c.level));
  const fallbacks: string[] = [];
  const blockers: string[] = [];
  for (const c of checks) {
    if (c.fallback && !fallbacks.includes(c.fallback)) fallbacks.push(c.fallback);
    if (c.level === 'unsupported') blockers.push(`${c.dimension}: ${c.detail}`);
  }

  const base: Omit<CompatReport, 'summary'> = {
    os,
    arch,
    tier,
    overall,
    checks,
    fallbacks,
    blockers,
  };
  return { ...base, summary: summarize(base) };
}

function osCheck(os: OsName): CompatCheck {
  const level = osSupport(os);
  if (os === 'win10' || os === 'win11') {
    return {
      dimension: 'os',
      level,
      detail: `${os === 'win11' ? 'Windows 11' : 'Windows 10'} — primary target.`,
    };
  }
  if (os === 'macos' || os === 'linux') {
    return {
      dimension: 'os',
      level,
      detail: `${os} — cross-platform target (Epoch K, post-1.0).`,
      fallback: `${os}: documented degradation — not a 1.0 GA target.`,
    };
  }
  return { dimension: 'os', level, detail: 'Unknown OS — not validated.' };
}

function archCheck(arch: Arch, emulated: boolean): CompatCheck {
  const level = archSupport(arch, emulated);
  if (arch === 'x64') return { dimension: 'arch', level, detail: 'x64 — native.' };
  if (arch === 'arm64') {
    if (emulated) {
      return {
        dimension: 'arch',
        level,
        detail: 'ARM64 running under x64 emulation.',
        fallback: 'Ship ARM64 native builds of node-pty / better-sqlite3 to avoid emulation.',
      };
    }
    return {
      dimension: 'arch',
      level,
      detail: 'ARM64 — native (requires arm64 binaries for native modules).',
    };
  }
  return { dimension: 'arch', level, detail: 'Unknown architecture — not validated.' };
}

function hardwareCheck(tier: HardwareTier): CompatCheck {
  const level = tierSupport(tier);
  if (tier === 'low') {
    return {
      dimension: 'hardware',
      level,
      detail: 'Low-end tier (≤2 cores or <4 GB RAM).',
      fallback: 'Reduce worker pool; disable auto graph build + live search on large repos.',
    };
  }
  return { dimension: 'hardware', level, detail: `${tier}-tier hardware — full features.` };
}

function gpuCheck(gpu: GpuStatus): CompatCheck {
  const level = gpuSupport(gpu);
  if (gpu === 'hardware')
    return { dimension: 'gpu', level, detail: 'Hardware-accelerated compositing.' };
  if (gpu === 'software') {
    return {
      dimension: 'gpu',
      level,
      detail: 'Software (SwiftShader) rendering — driver/GPU unavailable.',
      fallback: 'Use software compositing; disable smooth-scroll + minimap animations.',
    };
  }
  return {
    dimension: 'gpu',
    level,
    detail: 'GPU disabled.',
    fallback: 'Force software rendering (--disable-gpu); reduce animation.',
  };
}

function shellCheck(shell: Shell): CompatCheck {
  const level = shellSupport(shell);
  if (level === 'supported')
    return { dimension: 'shell', level, detail: `${shell} — integrated terminal supported.` };
  return {
    dimension: 'shell',
    level,
    detail: 'Unknown shell.',
    fallback: 'Fall back to the OS default shell (cmd.exe on Windows).',
  };
}

function encodingCheck(encoding?: string): CompatCheck {
  const { level, needsTranscode } = encodingSupport(encoding);
  const label = (encoding ?? 'utf-8').trim().toLowerCase();
  if (level === 'supported' && !needsTranscode) {
    return { dimension: 'encoding', level, detail: `${label} — native.` };
  }
  if (level === 'supported') {
    return {
      dimension: 'encoding',
      level,
      detail: `${label} — transcoded to/from UTF-8.`,
      fallback: 'Transcode on read/write; save as UTF-8 by default.',
    };
  }
  return {
    dimension: 'encoding',
    level,
    detail: `${label} — non-Unicode encoding.`,
    fallback: 'Transcode on read/write; warn before lossy conversion; save UTF-8.',
  };
}

function localeCheck(locale?: string, rtl = false): CompatCheck {
  const loc = (locale ?? 'en-US').trim();
  if (rtl) {
    return {
      dimension: 'locale',
      level: 'supported',
      detail: `${loc} — right-to-left script.`,
      fallback: 'Enable logical CSS + dir=rtl mirroring; allow ~30% text expansion.',
    };
  }
  return { dimension: 'locale', level: 'supported', detail: `${loc} — left-to-right.` };
}

function networkCheck(proxy: boolean, customCa: boolean): CompatCheck {
  if (!proxy && !customCa) {
    return {
      dimension: 'network',
      level: 'supported',
      detail: 'Direct connection; system trust store.',
    };
  }
  const parts: string[] = [];
  if (proxy) parts.push('proxy');
  if (customCa) parts.push('custom CA');
  const actions: string[] = [];
  if (proxy) actions.push('route egress through the system proxy');
  if (customCa) actions.push('load the enterprise CA into the TLS trust store');
  return {
    dimension: 'network',
    level: 'supported',
    detail: `Enterprise network (${parts.join(' + ')}).`,
    fallback: `${actions.join('; ')}.`,
  };
}

function summarize(r: Omit<CompatReport, 'summary'>): string {
  const verdict =
    r.overall === 'supported'
      ? 'Supported'
      : r.overall === 'degraded'
        ? 'Supported (degraded)'
        : 'Unsupported';
  const env = `${r.os}/${r.arch}/${r.tier}`;
  const degraded = r.checks.filter((c) => c.level === 'degraded').map((c) => c.dimension);
  const note =
    r.overall === 'unsupported'
      ? ` — blockers: ${r.blockers.length}`
      : degraded.length > 0
        ? ` — degraded: ${degraded.join(', ')}`
        : '';
  return `${verdict} · ${env}${note}`;
}

// ---------------------------------------------------------------------------
// Cartesian test matrix (the "runner" side)
// ---------------------------------------------------------------------------

export interface CompatMatrixAxes {
  os: readonly OsName[];
  arch: readonly Arch[];
  hardware: readonly HardwareTier[];
  gpu: readonly GpuStatus[];
  shell: readonly Shell[];
}

export interface MatrixCell {
  os: OsName;
  arch: Arch;
  hardware: HardwareTier;
  gpu: GpuStatus;
  shell: Shell;
  level: SupportLevel;
}

/** The canonical Windows-first matrix axes we validate against. */
export const DEFAULT_MATRIX_AXES: CompatMatrixAxes = {
  os: ['win10', 'win11'],
  arch: ['x64', 'arm64'],
  hardware: ['low', 'mid', 'high'],
  gpu: ['hardware', 'software', 'disabled'],
  shell: ['cmd', 'pwsh', 'gitbash', 'wsl'],
};

/** Compute the support level of a single matrix cell (5 core axes only). */
export function cellLevel(cell: Omit<MatrixCell, 'level'>): SupportLevel {
  return worstLevel([
    osSupport(cell.os),
    archSupport(cell.arch),
    tierSupport(cell.hardware),
    gpuSupport(cell.gpu),
    shellSupport(cell.shell),
  ]);
}

/** Expand the axes into every environment combination, each with its support level. */
export function buildCompatibilityMatrix(
  axes: CompatMatrixAxes = DEFAULT_MATRIX_AXES,
): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const os of axes.os) {
    for (const arch of axes.arch) {
      for (const hardware of axes.hardware) {
        for (const gpu of axes.gpu) {
          for (const shell of axes.shell) {
            const partial = { os, arch, hardware, gpu, shell };
            cells.push({ ...partial, level: cellLevel(partial) });
          }
        }
      }
    }
  }
  return cells;
}

export interface MatrixSummary {
  total: number;
  supported: number;
  degraded: number;
  unsupported: number;
  /** Fraction of cells that are supported or (documented) degraded — not blocked. */
  coverage: number;
  summary: string;
}

/** Roll a matrix up into counts + a coverage fraction (green + documented-degraded). */
export function summarizeMatrix(cells: readonly MatrixCell[]): MatrixSummary {
  const total = cells.length;
  let supported = 0;
  let degraded = 0;
  let unsupported = 0;
  for (const c of cells) {
    if (c.level === 'supported') supported += 1;
    else if (c.level === 'degraded') degraded += 1;
    else unsupported += 1;
  }
  const coverage = total > 0 ? (supported + degraded) / total : 1;
  const summary = `${total} cells · ${supported} green · ${degraded} degraded · ${unsupported} blocked · ${Math.round(
    coverage * 100,
  )}% covered`;
  return { total, supported, degraded, unsupported, coverage, summary };
}
