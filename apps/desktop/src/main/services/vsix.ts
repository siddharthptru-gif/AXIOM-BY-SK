import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fromBufferPromise, validateFileName, type Entry, type ZipFile } from 'yauzl';
import { rootLogger } from '@axiom/shared';
import {
  parseVsCodeManifest,
  type VsCodeManifest,
} from '../../common/vscodeManifest';

/**
 * VSIX package reading.
 *
 * A VSIX is an OPC zip: `extension/package.json` is the manifest, `extension/**` is the
 * payload, and `extension.vsixmanifest` plus `[Content_Types].xml` are packaging
 * metadata. This module is the only place that opens one, so every bound that protects
 * the install pipeline lives here rather than being re-derived by each caller.
 *
 * The threat model is a hostile archive, because at the moment a VSIX is opened its
 * publisher is still unproven. Guarded against:
 *
 *   - path traversal and absolute entry names (`../../.ssh/authorized_keys`)
 *   - symlink entries, which would let an archive write anywhere the link points
 *   - decompression bombs, via per-entry, total, and ratio ceilings
 *   - encrypted or exotically-compressed entries, which are refused rather than skipped
 *   - a central directory that lies about entry sizes, which yauzl rejects for us
 *
 * Ceilings are enforced while reading, not after: a bomb is only dangerous if you
 * finish inflating it.
 */
const log = rootLogger.child('vsix');

/** Where the manifest lives inside every VSIX. */
const MANIFEST_ENTRY = 'extension/package.json';
/** Payload prefix that is stripped when extracting, so the target dir is the ext root. */
const PAYLOAD_PREFIX = 'extension/';

/** Largest package AXIOM will open. Real extensions top out in the low hundreds of MB. */
export const MAX_VSIX_BYTES = 1000 * 1024 * 1024;
/** Largest single file inside a package (allows large language servers, binaries & bundles). */
const MAX_ENTRY_BYTES = 500 * 1024 * 1024;
/** Largest total inflated payload. */
const MAX_TOTAL_BYTES = 3000 * 1024 * 1024;
/** Largest number of entries. */
const MAX_ENTRIES = 100_000;
/**
 * Compression-ratio ceiling, applied only above a size floor. Small files legitimately
 * compress enormously (a 1 KB file of zeroes), so a bare ratio check would reject valid
 * packages; a bomb needs both a high ratio and real inflated size to matter.
 */
const MAX_RATIO = 200;
const RATIO_FLOOR_BYTES = 1024 * 1024;
/** Stored (0) and deflate (8) only; a real VSIX uses deflate throughout. */
const SUPPORTED_METHODS = new Set([0, 8]);

const UNIX_MADE_BY = 3;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

export interface VsixEntry {
  /** Name inside the archive, with the `extension/` prefix intact. */
  name: string;
  bytes: number;
  directory: boolean;
}

export interface VsixPackage {
  manifest: VsCodeManifest;
  /** SHA-256 of the package bytes, for the install record. */
  sha256: string;
  packageBytes: number;
  /** Total inflated size of the payload, for the install record and disk accounting. */
  payloadBytes: number;
  entryCount: number;
}

export class VsixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VsixError';
  }
}

/**
 * Reject an entry that must not be read or written.
 *
 * Returns null when the entry is acceptable, otherwise the reason. yauzl already
 * validates names while decoding them, but this repeats the check: relying on a
 * dependency's internal behaviour for a containment guarantee is exactly the kind of
 * assumption that breaks silently on upgrade.
 */
function rejectEntry(entry: Entry): string | null {
  const nameProblem = validateFileName(entry.fileName);
  if (nameProblem !== null) return nameProblem;
  if (entry.fileName.includes('\0')) return `entry name contains a null byte`;
  if (entry.fileName.length > 1024) return `entry name is too long`;
  if (entry.isEncrypted()) return `encrypted entries are not supported`;
  if (!entry.canDecodeFileData()) return `entry uses an unsupported zip feature`;
  if (!SUPPORTED_METHODS.has(entry.compressionMethod)) {
    return `unsupported compression method ${entry.compressionMethod}`;
  }
  if (entry.versionMadeBy >> 8 === UNIX_MADE_BY) {
    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    if (mode === S_IFLNK) return `symbolic links are not allowed in a package`;
  }
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    return `entry is larger than the ${MAX_ENTRY_BYTES} byte limit`;
  }
  if (
    entry.uncompressedSize > RATIO_FLOOR_BYTES &&
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_RATIO
  ) {
    return `entry compression ratio exceeds the ${MAX_RATIO}:1 limit`;
  }
  return null;
}

function isDirectoryEntry(entry: Entry): boolean {
  return entry.fileName.endsWith('/');
}

/**
 * Walk every central-directory record once, applying the bounds.
 *
 * `lazyEntries` keeps this a pull loop, so the ceilings are checked before the next
 * record is even decoded.
 */
async function collectEntries(zip: ZipFile): Promise<VsixEntry[]> {
  if (zip.entryCount > MAX_ENTRIES) {
    throw new VsixError(`The package declares ${zip.entryCount} entries, above the supported limit.`);
  }
  return new Promise<VsixEntry[]>((resolve, reject) => {
    const entries: VsixEntry[] = [];
    let total = 0;
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new VsixError(message));
    };
    zip.on('entry', (entry) => {
      if (settled) return;
      const problem = rejectEntry(entry);
      if (problem !== null) {
        fail(`The package contains an entry AXIOM refuses to read: ${problem}.`);
        return;
      }
      const directory = isDirectoryEntry(entry);
      if (!directory) {
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL_BYTES) {
          fail('The package inflates to more than the supported total size.');
          return;
        }
      }
      entries.push({ name: entry.fileName, bytes: entry.uncompressedSize, directory });
      zip.readEntry();
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zip.on('error', (error) => fail(error.message));
    zip.readEntry();
  });
}

/** Read one entry's bytes, bounded by the ceiling already validated for it. */
async function readEntryBytes(zip: ZipFile, target: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let found = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new VsixError(message));
    };
    zip.on('entry', (entry) => {
      if (settled) return;
      if (entry.fileName !== target) {
        zip.readEntry();
        return;
      }
      const problem = rejectEntry(entry);
      if (problem !== null) {
        fail(`${target} cannot be read: ${problem}.`);
        return;
      }
      found = true;
      void zip
        .openReadStreamPromise(entry)
        .then(async (stream) => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            const buffer = chunk as Buffer;
            size += buffer.length;
            if (size > MAX_ENTRY_BYTES) {
              fail(`${target} is larger than the supported limit.`);
              stream.destroy();
              return;
            }
            chunks.push(buffer);
          }
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        })
        .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    });
    zip.on('end', () => {
      if (settled || found) return;
      fail(`The package does not contain ${target}.`);
    });
    zip.on('error', (error) => fail(error.message));
    zip.readEntry();
  });
}

async function openVsix(bytes: Buffer): Promise<ZipFile> {
  if (bytes.length === 0) throw new VsixError('The package is empty.');
  if (bytes.length > MAX_VSIX_BYTES) {
    throw new VsixError('The package is larger than the supported size.');
  }
  try {
    // `decodeStrings` and `validateEntrySizes` stay on: they are the two options that
    // make yauzl reject a lying or hostile central directory for us.
    return await fromBufferPromise(bytes, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
  } catch (error) {
    throw new VsixError(
      `The package is not a readable VSIX archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Inspect a package without extracting it: validate the archive, parse the manifest,
 * and report what it weighs. Used both before installing from the registry and to
 * preview a local "Install from VSIX" choice.
 */
export async function inspectVsix(bytes: Buffer): Promise<VsixPackage> {
  const inventory = await withVsix(bytes, (zip) => collectEntries(zip));
  const hasManifest = inventory.some((entry) => entry.name === MANIFEST_ENTRY);
  if (!hasManifest) {
    throw new VsixError('The package does not contain extension/package.json.');
  }
  const manifestBytes = await withVsix(bytes, (zip) => readEntryBytes(zip, MANIFEST_ENTRY));
  let parsed: unknown;
  try {
    // A BOM at the start of package.json is common enough to be worth stripping.
    parsed = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new VsixError(
      `extension/package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parseVsCodeManifest(parsed);
  if (!result.ok) throw new VsixError(result.errors.join(' '));
  const payloadBytes = inventory
    .filter((entry) => !entry.directory && entry.name.startsWith(PAYLOAD_PREFIX))
    .reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    manifest: result.manifest,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    packageBytes: bytes.length,
    payloadBytes,
    entryCount: inventory.length,
  };
}

/** Open, use, and always close a package. */
async function withVsix<T>(bytes: Buffer, use: (zip: ZipFile) => Promise<T>): Promise<T> {
  const zip = await openVsix(bytes);
  try {
    return await use(zip);
  } finally {
    try {
      zip.close();
    } catch {
      // A close failure cannot invalidate a value that was already read.
    }
  }
}

/**
 * Resolve a payload entry to an absolute path inside `root`, or null if it does not
 * belong there.
 *
 * The containment check compares the resolved path against the root prefix rather than
 * trusting the entry name, so a name that survived validation but still resolves outside
 * (through a case or separator quirk) is caught here.
 */
function payloadTarget(root: string, entryName: string): string | null {
  if (!entryName.startsWith(PAYLOAD_PREFIX)) return null;
  const relative = entryName.slice(PAYLOAD_PREFIX.length);
  if (relative.length === 0) return null;
  const target = join(root, ...relative.split('/'));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix) ? target : null;
}

/**
 * Extract a package's payload into `root`, stripping the `extension/` prefix so `root`
 * becomes the extension directory.
 *
 * The caller is expected to hand over a fresh directory (the install pipeline extracts
 * into a temporary path and renames it into place), so a failure here leaves a partial
 * directory that the caller discards rather than something a user can see.
 */
export async function extractVsix(bytes: Buffer, root: string): Promise<number> {
  await mkdir(root, { recursive: true });
  return withVsix(bytes, async (zip) => {
    const files: Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let total = 0;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        reject(new VsixError(message));
      };
      zip.on('entry', (entry) => {
        if (settled) return;
        const problem = rejectEntry(entry);
        if (problem !== null) {
          fail(`The package contains an entry AXIOM refuses to extract: ${problem}.`);
          return;
        }
        if (!isDirectoryEntry(entry) && entry.fileName.startsWith(PAYLOAD_PREFIX)) {
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) {
            fail('The package inflates to more than the supported total size.');
            return;
          }
          files.push(entry);
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('error', (error) => fail(error.message));
      zip.readEntry();
    });

    let written = 0;
    for (const entry of files) {
      const target = payloadTarget(root, entry.fileName);
      if (target === null) {
        throw new VsixError(`The package entry ${entry.fileName} escapes the extension directory.`);
      }
      await mkdir(dirname(target), { recursive: true });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, createWriteStream(target, { mode: 0o600 }));
      written += 1;
    }
    log.info('Extension package extracted', { files: written });
    return written;
  });
}

/**
 * Read one named entry out of any registry zip, under the same bounds a VSIX gets.
 *
 * Exists for the signature archive (`.sigzip`), which is a separate zip carrying the
 * signed manifest. It is read through this module rather than a second zip reader so
 * there is exactly one place where archive bounds are defined, and a hostile signature
 * archive is no more dangerous than a hostile package.
 */
export async function readZipEntryBytes(bytes: Buffer, entryName: string): Promise<Buffer> {
  return withVsix(bytes, (zip) => readEntryBytes(zip, entryName));
}

/**
 * Read a `.vsix` from disk, for "Install from VSIX".
 *
 * The size is checked from the buffer length rather than a prior `stat`, so a file that
 * grows between the check and the read cannot slip past the ceiling.
 */
export async function readVsixFile(path: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new VsixError(
      `The package could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.length > MAX_VSIX_BYTES) {
    throw new VsixError('The package is larger than the supported size.');
  }
  return bytes;
}

/** Remove a partially-extracted directory, ignoring a cleanup failure. */
export async function discardExtraction(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    log.warn('Could not remove a partial extension extraction', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
