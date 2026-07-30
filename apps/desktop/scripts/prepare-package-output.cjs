'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.resolve(desktop, '..', '..', 'AXIOM EXE', 'dist');
const STALE_GENERIC_METADATA = Object.freeze(['latest.yml', 'latest.yml.sha256']);

async function removeIfRegularFile(target) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Refusing to replace non-regular stale package metadata: ${path.basename(target)}`,
    );
  }
  await fs.unlink(target);
  return true;
}

async function preparePackageOutput(outputDir = DEFAULT_OUTPUT, expectedOutput = DEFAULT_OUTPUT) {
  const output = path.resolve(outputDir);
  if (output !== path.resolve(expectedOutput)) {
    throw new Error('Package output cleanup escaped its exact approved directory.');
  }
  await fs.mkdir(output, { recursive: true });
  let removed = 0;
  for (const basename of STALE_GENERIC_METADATA) {
    const target = path.join(output, basename);
    if (path.dirname(target) !== output) throw new Error('Unsafe package metadata path.');
    if (await removeIfRegularFile(target)) removed += 1;
  }
  if (removed > 0) {
    console.log(`[release-hardening] Removed ${removed} stale generic update metadata file(s).`);
  }
  return removed;
}

if (require.main === module) {
  preparePackageOutput().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_OUTPUT, STALE_GENERIC_METADATA, preparePackageOutput };
