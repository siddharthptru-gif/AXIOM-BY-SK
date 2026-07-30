import os from 'node:os';
import { app } from 'electron';
import {
  evaluateCompatibility,
  type Arch,
  type CompatReport,
  type EnvProfile,
  type GpuStatus,
  type OsName,
  type Shell,
} from '../../common/compatMatrix';

/**
 * Compatibility probe (Main, PRD Epoch J §224 / Phase 276). Reads real environment
 * facts (platform + build, arch, CPU/RAM, GPU feature status, default shell, locale,
 * proxy/CA) into an EnvProfile, then defers to the pure `common/compatMatrix`
 * evaluator for the support verdict + fallbacks. No logic lives here — only probing.
 */

function detectOs(): { os?: OsName; osVersion: string } {
  const osVersion = os.release();
  switch (process.platform) {
    case 'win32':
      // Leave os undefined so classifyOs() splits Win10/Win11 from the build number.
      return { osVersion };
    case 'darwin':
      return { os: 'macos', osVersion };
    case 'linux':
      return { os: 'linux', osVersion };
    default:
      return { os: 'unknown', osVersion };
  }
}

function detectArch(): Arch {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  return 'unknown';
}

function detectGpu(): GpuStatus {
  try {
    const c = app.getGPUFeatureStatus().gpu_compositing;
    if (!c || c.startsWith('enabled')) return 'hardware';
    if (c.includes('software')) return 'software';
    if (c.includes('disabled')) return 'disabled';
    return 'hardware';
  } catch {
    return 'hardware';
  }
}

function detectShell(): Shell {
  if (process.platform === 'win32') return 'cmd';
  const sh = (process.env.SHELL ?? '').toLowerCase();
  if (sh.includes('zsh')) return 'zsh';
  if (sh.includes('bash')) return 'bash';
  return 'unknown';
}

const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi']);

function detectLocale(): { locale: string; rtl: boolean } {
  let locale = 'en-US';
  try {
    locale = app.getLocale() || 'en-US';
  } catch {
    /* app not ready — fall back to en-US */
  }
  const lang = locale.split('-')[0]?.toLowerCase() ?? 'en';
  return { locale, rtl: RTL_LANGS.has(lang) };
}

/** Build an EnvProfile from live process/Electron facts. */
export function probeEnvironment(): EnvProfile {
  const { os: osName, osVersion } = detectOs();
  const { locale, rtl } = detectLocale();
  const hasProxy = Boolean(
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy,
  );
  return {
    ...(osName !== undefined ? { os: osName } : {}),
    osVersion,
    arch: detectArch(),
    cpuCores: os.cpus().length,
    memoryGB: os.totalmem() / (1024 * 1024 * 1024),
    gpu: detectGpu(),
    shell: detectShell(),
    encoding: 'utf-8',
    locale,
    rtl,
    proxy: hasProxy,
    customCa: Boolean(process.env.NODE_EXTRA_CA_CERTS),
  };
}

/** The compatibility report for the current environment. */
export function getCompatReport(): CompatReport {
  return evaluateCompatibility(probeEnvironment());
}
