/**
 * Cross-platform & remote-development groundwork (Phase 289).
 *
 * PURE module (no I/O, no Electron). The platform-abstraction primitives a
 * cross-platform + remote build needs: an OS/arch target matrix, path-separator /
 * end-of-line / default-shell normalization, and a remote-workspace descriptor.
 * Keeping these pure + centralized means the rest of the app stops hard-coding
 * `\\` vs `/`, `\r\n` vs `\n`, or PowerShell vs bash. Deterministic; the Main
 * process supplies the real `process.platform`/`arch`, the renderer just formats.
 */

export type OsFamily = 'windows' | 'macos' | 'linux';
export type Arch = 'x64' | 'arm64';

export interface PlatformTarget {
  os: OsFamily;
  arch: Arch;
}

/** Map Node's `process.platform` to an OS family. */
export function osFromPlatform(platform: string): OsFamily {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

/** Map Node's `process.arch` to a supported arch (defaults to x64). */
export function normalizeArch(arch: string): Arch {
  return arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64';
}

/** Path separator for an OS. */
export function pathSep(os: OsFamily): '\\' | '/' {
  return os === 'windows' ? '\\' : '/';
}

/** End-of-line sequence for an OS. */
export function eol(os: OsFamily): '\r\n' | '\n' {
  return os === 'windows' ? '\r\n' : '\n';
}

/** Default shell for an OS. */
export function defaultShell(os: OsFamily): string {
  return os === 'windows' ? 'powershell.exe' : os === 'macos' ? 'zsh' : 'bash';
}

/** Convert a path to POSIX separators (for storage / cross-platform display). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Convert a path to the given OS's native separators (collapses mixed separators). */
export function toNative(p: string, os: OsFamily): string {
  const posix = toPosix(p);
  return os === 'windows' ? posix.replace(/\//g, '\\') : posix;
}

/** Normalize a file's line endings to the OS convention. */
export function normalizeEol(text: string, os: OsFamily): string {
  const lf = text.replace(/\r\n/g, '\n');
  return os === 'windows' ? lf.replace(/\n/g, '\r\n') : lf;
}

const SUPPORTED_OS: readonly OsFamily[] = ['windows', 'macos', 'linux'];
const SUPPORTED_ARCH: readonly Arch[] = ['x64', 'arm64'];

/** Build the cartesian OS × arch target matrix (deterministic order). */
export function buildTargetMatrix(
  oses: readonly OsFamily[] = SUPPORTED_OS,
  arches: readonly Arch[] = SUPPORTED_ARCH,
): PlatformTarget[] {
  const out: PlatformTarget[] = [];
  for (const os of oses) for (const arch of arches) out.push({ os, arch });
  return out;
}

/** Is this target officially supported? */
export function isSupportedTarget(t: PlatformTarget): boolean {
  return SUPPORTED_OS.includes(t.os) && SUPPORTED_ARCH.includes(t.arch);
}

export function targetLabel(t: PlatformTarget): string {
  return `${t.os}-${t.arch}`;
}

export interface RemoteWorkspace {
  host: string;
  /** Absolute path on the remote host. */
  path: string;
  os: OsFamily;
  /** SSH user, if any. */
  user?: string;
}

/** A stable descriptor string for a remote workspace (like a VS Code remote URI). */
export function describeRemote(rw: RemoteWorkspace): string {
  const authority = rw.user !== undefined && rw.user.length > 0 ? `${rw.user}@${rw.host}` : rw.host;
  return `remote://${authority}${toPosix(rw.path).startsWith('/') ? '' : '/'}${toPosix(rw.path)}`;
}
