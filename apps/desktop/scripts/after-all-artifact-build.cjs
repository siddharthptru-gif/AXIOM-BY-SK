'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function isHashableArtifact(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 1024) return false;
  const name = path.basename(filePath);
  if (name.length === 0 || name.length > 200 || name.endsWith('.sha256')) return false;
  if (/\.(?:exe|msi|msix)$/i.test(name)) return true;
  if (/\.blockmap$/i.test(name)) return true;
  return /^latest(?:-[A-Za-z0-9._-]+)?\.(?:yml|yaml|json)$/i.test(name);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function atomicWriteSidecar(sidecarPath, content) {
  const tempPath = `${sidecarPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, sidecarPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createSha256Sidecars(outDir, artifactPaths) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length > MAX_ARTIFACTS) {
    throw new Error('Unexpected release artifact count.');
  }
  const outputRoot = await fs.realpath(path.resolve(outDir));
  const selected = [...new Set(artifactPaths.filter(isHashableArtifact))];
  const sidecars = [];

  for (const artifactPath of selected) {
    if (typeof artifactPath !== 'string' || artifactPath.length > 1024) {
      throw new Error('Invalid release artifact path.');
    }
    const resolved = path.resolve(artifactPath);
    if (!inside(path.resolve(outDir), resolved)) {
      throw new Error('Release artifact path escapes the configured output directory.');
    }
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Release artifact must be a regular non-symlink file.');
    }
    const realArtifact = await fs.realpath(resolved);
    if (!inside(outputRoot, realArtifact)) {
      throw new Error('Release artifact resolves outside the configured output directory.');
    }
    const metadata = /\.(?:blockmap|ya?ml|json)$/i.test(resolved);
    const limit = metadata ? MAX_METADATA_BYTES : MAX_ARTIFACT_BYTES;
    if (stat.size <= 0 || stat.size > limit) {
      throw new Error('Release artifact size is outside the allowed bounds.');
    }

    const digest = await sha256File(realArtifact);
    const sidecar = `${resolved}.sha256`;
    await atomicWriteSidecar(sidecar, `${digest}  ${path.basename(resolved)}\n`);
    sidecars.push(sidecar);
  }
  return sidecars;
}

async function afterAllArtifactBuild(context) {
  const sidecars = await createSha256Sidecars(context.outDir, context.artifactPaths);
  if (sidecars.length > 0) {
    console.log(`[release-hardening] Wrote ${sidecars.length} SHA-256 sidecar(s).`);
  }
  return sidecars;
}

module.exports = afterAllArtifactBuild;
module.exports.createSha256Sidecars = createSha256Sidecars;
module.exports.isHashableArtifact = isHashableArtifact;
module.exports.sha256File = sha256File;
