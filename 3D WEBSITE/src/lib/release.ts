/**
 * The single source of truth for the shipped installer.
 *
 * Every place that names, sizes, or hashes the download reads from here, so a new
 * release changes exactly one file. `bytes` and `sha256` are the real values of the
 * real file in `public/downloads` — a download page that misreports a hash is worse
 * than one that omits it, because it teaches the reader that verifying is pointless.
 *
 * Regenerate with `node scripts/sync-installer.cjs`, which copies the installer out
 * of the desktop build output and prints the values to paste back here.
 */
export const RELEASE = {
  version: '2.1.0',
  fileName: 'AXIOM-Setup-2.1.0-x64.exe',
  /** Served straight from `public/`, so no backend is involved in the download. */
  downloadPath: '/downloads/AXIOM-Setup-2.1.0-x64.exe',
  bytes: 111_770_121,
  sha256: 'ca835287171e1f8d0ab16e05cdcb1c6f6f4f78226aaa575208c5f852e5bd627a',
  platform: 'Windows 10/11 · x64',
  /** Unsigned on purpose; the page says so rather than letting SmartScreen surprise anyone. */
  signed: false,
} as const;

/** Human size, always derived from `bytes` so the two can never disagree. */
export function prettySize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const RELEASE_SIZE = prettySize(RELEASE.bytes);

export const VERIFY_COMMAND = `certutil -hashfile ${RELEASE.fileName} SHA256`;
