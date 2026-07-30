/* eslint-disable no-console */
'use strict';

/**
 * Copy the newest AXIOM installer out of the desktop build output into
 * `public/downloads`, and print the exact values `src/lib/release.ts` must contain.
 *
 * The site is static, so the download is a plain file link. That means the file has to
 * physically exist under `public/`, and the size and hash shown on the page have to be
 * the real ones. Computing them here rather than typing them by hand is the only way
 * they cannot drift apart.
 *
 * Usage (from this folder):  node scripts/sync-installer.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SITE = path.resolve(__dirname, '..');
const DIST = path.resolve(SITE, '..', 'AXIOM EXE', 'dist');
const TARGET_DIR = path.join(SITE, 'public', 'downloads');

function fail(message) {
  console.error(`\n  sync-installer: ${message}\n`);
  process.exitCode = 1;
}

function newestInstaller(dir) {
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => /^AXIOM-Setup-.*-x64\.exe$/i.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      return { name, full, stat: fs.statSync(full) };
    })
    .filter((entry) => entry.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates[0] ?? null;
}

function main() {
  if (!fs.existsSync(DIST)) {
    fail(`build output not found: ${DIST}\n  Build the desktop app first.`);
    return;
  }

  const installer = newestInstaller(DIST);
  if (!installer) {
    fail(`no AXIOM-Setup-*-x64.exe in ${DIST}`);
    return;
  }

  const bytes = fs.readFileSync(installer.full);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  // If electron-builder wrote a checksum sidecar, trust nothing until it agrees.
  const sidecarPath = `${installer.full}.sha256`;
  if (fs.existsSync(sidecarPath)) {
    const sidecar = fs.readFileSync(sidecarPath, 'utf-8').trim().split(/\s+/)[0];
    if (sidecar && sidecar.toLowerCase() !== sha256.toLowerCase()) {
      fail(
        `checksum mismatch. The file on disk does not match its own .sha256 sidecar.\n` +
          `  file:    ${sha256}\n  sidecar: ${sidecar}\n  Refusing to publish it.`,
      );
      return;
    }
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });

  // Drop any older installer so the folder never serves two versions at once.
  for (const stale of fs.readdirSync(TARGET_DIR)) {
    if (/\.exe$/i.test(stale) && stale !== installer.name) {
      fs.rmSync(path.join(TARGET_DIR, stale), { force: true });
      console.log(`  removed stale ${stale}`);
    }
  }

  const target = path.join(TARGET_DIR, installer.name);
  fs.writeFileSync(target, bytes);

  const verify = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (verify !== sha256) {
    fail('the copy in public/downloads does not match the source. Copy failed.');
    return;
  }

  const version = /AXIOM-Setup-(.+)-x64\.exe$/i.exec(installer.name)?.[1] ?? 'unknown';

  console.log(`\n  Copied ${installer.name} -> public/downloads (verified)\n`);
  console.log('  Paste into src/lib/release.ts:\n');
  console.log(`    version: '${version}',`);
  console.log(`    fileName: '${installer.name}',`);
  console.log(`    downloadPath: '/downloads/${installer.name}',`);
  console.log(`    bytes: ${installer.stat.size},`);
  console.log(`    sha256: '${sha256}',\n`);
}

main();
