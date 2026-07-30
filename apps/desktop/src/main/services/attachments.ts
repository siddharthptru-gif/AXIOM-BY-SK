import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type { AiImageInput, AttachmentDescriptor, AttachmentTextInput } from '../../common/ipc';
import { assertAuthorizedPath, assertAuthorizedWorkspaceRoot } from './pathAuthorization';
import { resolveWithinWorkspaceRoot } from './workspaceContainment';

const MAX_ATTACHMENTS_PER_OWNER = 16;
const ATTACHMENT_TTL_MS = 60 * 60_000;
const MAX_INLINE_TEXT_CHARS = 120_000;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_TEXT_CHARS = 160_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_FOLDER_FILES = 120;
const MAX_FOLDER_CONTENT_FILES = 16;
const MAX_FOLDER_DIRS = 60;
const MAX_FOLDER_DEPTH = 5;

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.less',
  '.md',
  '.mdx',
  '.mjs',
  '.php',
  '.properties',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);
const TEXT_BASENAMES = new Set([
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'procfile',
  'readme',
]);
const ENV_FILE = /^\.env(?:\..*)?$/i;
const DENIED_CREDENTIAL_FILE =
  /^(?:\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?\.json|auth-store\.enc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;

type FileIdentity = { dev: number | bigint; ino: number | bigint };

type AttachmentRecord =
  | {
      id: string;
      ownerId: number;
      createdAt: number;
      lastUsedAt: number;
      descriptor: AttachmentDescriptor;
      source: 'path';
      path: string;
      identity: FileIdentity;
      pathKind: 'file' | 'folder';
    }
  | {
      id: string;
      ownerId: number;
      createdAt: number;
      lastUsedAt: number;
      descriptor: AttachmentDescriptor;
      source: 'inline';
      text: string;
    };

export interface MaterializedAttachments {
  text: string;
  images: AiImageInput[];
}

const recordsByOwner = new Map<number, Map<string, AttachmentRecord>>();

function fileIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>, identity: FileIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function safeFileSize(stat: Awaited<ReturnType<typeof fs.lstat>>): number {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Attachment size is invalid.');
  return size;
}

function cleanName(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 120);
  return normalized || fallback;
}

function ownerRecords(ownerId: number): Map<string, AttachmentRecord> {
  let records = recordsByOwner.get(ownerId);
  if (!records) {
    records = new Map();
    recordsByOwner.set(ownerId, records);
  }
  return records;
}

function pruneOwner(ownerId: number, now = Date.now()): void {
  const records = recordsByOwner.get(ownerId);
  if (!records) return;
  for (const [id, record] of records) {
    if (now - record.lastUsedAt > ATTACHMENT_TTL_MS) records.delete(id);
  }
  if (records.size === 0) recordsByOwner.delete(ownerId);
}

function storeRecord(ownerId: number, record: AttachmentRecord): AttachmentDescriptor {
  pruneOwner(ownerId);
  const records = ownerRecords(ownerId);
  if (records.size >= MAX_ATTACHMENTS_PER_OWNER) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_OWNER} chat attachments may be active.`);
  }
  records.set(record.id, record);
  return record.descriptor;
}

function kindForFile(name: string): AttachmentDescriptor['kind'] {
  if (ENV_FILE.test(name)) return 'environment';
  if (DENIED_CREDENTIAL_FILE.test(name)) {
    throw new Error(
      `${name} is a credential-bearing file and cannot be attached. Paste only the non-secret text you intend to share.`,
    );
  }
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? 'image' : 'text';
}

async function canonicalSelectedPath(path: string): Promise<{
  path: string;
  stat: Awaited<ReturnType<typeof fs.lstat>>;
}> {
  const lexical = await fs.lstat(path);
  if (lexical.isSymbolicLink()) throw new Error('Symbolic-link attachments are not allowed.');
  const canonical = await fs.realpath(path);
  const stat = await fs.lstat(canonical);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Only regular files and directories can be attached.');
  }
  return { path: canonical, stat };
}

async function registerPath(
  ownerId: number,
  path: string,
  detail?: string,
): Promise<AttachmentDescriptor> {
  const selected = await canonicalSelectedPath(path);
  const name = cleanName(basename(selected.path), 'attachment');
  const pathKind = selected.stat.isDirectory() ? 'folder' : 'file';
  const kind: AttachmentDescriptor['kind'] = pathKind === 'folder' ? 'folder' : kindForFile(name);
  const size = selected.stat.isFile() ? safeFileSize(selected.stat) : null;
  if (size !== null && size > MAX_IMAGE_BYTES && kind === 'image') {
    throw new Error(`${name} exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB image limit.`);
  }
  const id = randomUUID();
  const now = Date.now();
  const descriptor: AttachmentDescriptor = {
    id,
    name,
    detail: cleanName(detail ?? name, name),
    kind,
    size,
    redacted: kind === 'environment',
  };
  return storeRecord(ownerId, {
    id,
    ownerId,
    createdAt: now,
    lastUsedAt: now,
    descriptor,
    source: 'path',
    path: selected.path,
    identity: fileIdentity(selected.stat),
    pathKind,
  });
}

async function registerPathBatch(
  ownerId: number,
  entries: readonly { path: string; detail?: string }[],
): Promise<AttachmentDescriptor[]> {
  const created: AttachmentDescriptor[] = [];
  try {
    for (const entry of entries) {
      created.push(await registerPath(ownerId, entry.path, entry.detail));
    }
    return created;
  } catch (error) {
    releaseAttachments(
      ownerId,
      created.map((descriptor) => descriptor.id),
    );
    throw error;
  }
}

export async function pickAttachmentFiles(
  owner: BrowserWindow,
  ownerId: number,
): Promise<AttachmentDescriptor[]> {
  if (owner.isDestroyed()) {
    clearAttachmentsForOwner(ownerId);
    return [];
  }
  const result = await dialog.showOpenDialog(owner, {
    properties: ['openFile', 'multiSelections'],
  });
  if (owner.isDestroyed()) {
    clearAttachmentsForOwner(ownerId);
    return [];
  }
  if (result.canceled) return [];
  if (result.filePaths.length + ownerRecords(ownerId).size > MAX_ATTACHMENTS_PER_OWNER) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_OWNER} chat attachments may be active.`);
  }
  try {
    const descriptors = await registerPathBatch(
      ownerId,
      result.filePaths.map((path) => ({ path })),
    );
    if (owner.isDestroyed()) {
      clearAttachmentsForOwner(ownerId);
      return [];
    }
    return descriptors;
  } catch (error) {
    if (owner.isDestroyed()) clearAttachmentsForOwner(ownerId);
    throw error;
  }
}

export async function pickAttachmentFolder(
  owner: BrowserWindow,
  ownerId: number,
): Promise<AttachmentDescriptor | null> {
  if (owner.isDestroyed()) {
    clearAttachmentsForOwner(ownerId);
    return null;
  }
  const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory'] });
  if (owner.isDestroyed()) {
    clearAttachmentsForOwner(ownerId);
    return null;
  }
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  if (!selected) return null;
  try {
    const [descriptor] = await registerPathBatch(ownerId, [{ path: selected }]);
    if (owner.isDestroyed()) {
      clearAttachmentsForOwner(ownerId);
      return null;
    }
    return descriptor ?? null;
  } catch (error) {
    if (owner.isDestroyed()) clearAttachmentsForOwner(ownerId);
    throw error;
  }
}

export async function addDroppedAttachment(
  ownerId: number,
  path: string,
): Promise<AttachmentDescriptor> {
  return registerPath(ownerId, path);
}

export async function addWorkspaceAttachments(
  ownerId: number,
  rootValue: string,
  paths: readonly string[],
): Promise<AttachmentDescriptor[]> {
  if (paths.length === 0 || paths.length > MAX_ATTACHMENTS_PER_OWNER) {
    throw new Error('Choose between 1 and 16 workspace files to attach.');
  }
  const root = await assertAuthorizedWorkspaceRoot(rootValue);
  if (paths.length + ownerRecords(ownerId).size > MAX_ATTACHMENTS_PER_OWNER) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_OWNER} chat attachments may be active.`);
  }
  const entries: Array<{ path: string; detail: string }> = [];
  for (const value of paths) {
    const lexical = resolveWithinWorkspaceRoot(root, value);
    if (!lexical) throw new Error('A requested attachment is outside the selected workspace.');
    const canonical = await assertAuthorizedPath(lexical);
    if (!resolveWithinWorkspaceRoot(root, canonical)) {
      throw new Error('A requested attachment resolves outside the selected workspace.');
    }
    const detail = relative(root, canonical).replace(/\\/g, '/') || basename(canonical);
    entries.push({ path: canonical, detail });
  }
  return registerPathBatch(ownerId, entries);
}

export function addTextAttachment(
  ownerId: number,
  input: AttachmentTextInput,
): AttachmentDescriptor {
  if (!input || typeof input !== 'object') throw new Error('Text attachment input is required.');
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new Error('Paste non-empty text to create an attachment.');
  }
  if (input.text.length > MAX_INLINE_TEXT_CHARS) {
    throw new Error(
      `Pasted text exceeds the ${MAX_INLINE_TEXT_CHARS.toLocaleString()} character limit.`,
    );
  }
  const name = cleanName(input.name, 'Pasted text');
  const id = randomUUID();
  const now = Date.now();
  const descriptor: AttachmentDescriptor = {
    id,
    name,
    detail: 'Explicitly pasted text',
    kind: 'text',
    size: input.text.length,
    redacted: false,
  };
  return storeRecord(ownerId, {
    id,
    ownerId,
    createdAt: now,
    lastUsedAt: now,
    descriptor,
    source: 'inline',
    text: input.text,
  });
}

export function releaseAttachments(ownerId: number, ids: readonly string[]): void {
  const records = recordsByOwner.get(ownerId);
  if (!records) return;
  for (const id of ids.slice(0, MAX_ATTACHMENTS_PER_OWNER)) records.delete(id);
  if (records.size === 0) recordsByOwner.delete(ownerId);
}

export function clearAttachmentsForOwner(ownerId: number): void {
  recordsByOwner.delete(ownerId);
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes} byte limit.`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('Binary files cannot be attached as text.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('The attachment is not valid UTF-8 text.');
  }
}

function redactEnvironment(text: string): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.length > 0
    ? keys.map((key) => `${key}=<redacted>`).join('\n')
    : '(No parseable environment variable names; all contents withheld.)';
}

function imageMediaType(buffer: Buffer): AiImageInput['mediaType'] | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function shouldReadFolderFile(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = extname(lower);
  return TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(lower.replace(/\..*$/, ''));
}

async function materializeFolder(
  record: Extract<AttachmentRecord, { source: 'path' }>,
  signal?: AbortSignal,
): Promise<string> {
  const root = record.path;
  const files: string[] = [];
  const contentBlocks: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visitedDirs = 0;
  let omittedSensitive = 0;
  let truncated = false;
  let contentChars = 0;

  while (queue.length > 0 && files.length < MAX_FOLDER_FILES) {
    signal?.throwIfAborted();
    const current = queue.shift();
    if (!current) break;
    if (visitedDirs >= MAX_FOLDER_DIRS) {
      truncated = true;
      break;
    }
    visitedDirs++;
    const currentStat = await fs.lstat(current.path);
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) continue;
    const currentReal = await fs.realpath(current.path);
    if (!resolveWithinWorkspaceRoot(root, currentReal)) continue;
    let entries;
    try {
      entries = await fs.readdir(currentReal, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const candidate = join(currentReal, entry.name);
      if (entry.isDirectory()) {
        if (
          current.depth < MAX_FOLDER_DEPTH &&
          !IGNORED_DIRS.has(entry.name) &&
          queue.length + visitedDirs < MAX_FOLDER_DIRS
        ) {
          queue.push({ path: candidate, depth: current.depth + 1 });
        } else if (!IGNORED_DIRS.has(entry.name)) {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, candidate).replace(/\\/g, '/');
      if (ENV_FILE.test(entry.name) || DENIED_CREDENTIAL_FILE.test(entry.name)) {
        omittedSensitive++;
        continue;
      }
      files.push(rel);
      if (
        contentBlocks.length >= MAX_FOLDER_CONTENT_FILES ||
        !shouldReadFolderFile(entry.name) ||
        contentChars >= MAX_TOTAL_TEXT_CHARS
      ) {
        continue;
      }
      try {
        const fileStat = await fs.lstat(candidate);
        if (
          fileStat.isSymbolicLink() ||
          !fileStat.isFile() ||
          safeFileSize(fileStat) > MAX_TEXT_FILE_BYTES
        ) {
          continue;
        }
        const real = await fs.realpath(candidate);
        if (!resolveWithinWorkspaceRoot(root, real)) continue;
        const text = decodeUtf8(await readBounded(real, MAX_TEXT_FILE_BYTES));
        const remaining = MAX_TOTAL_TEXT_CHARS - contentChars;
        const bounded = text.slice(0, remaining);
        contentBlocks.push(`File: ${rel}\n${bounded}`);
        contentChars += bounded.length;
      } catch {
        // A single binary, raced, or unreadable file does not invalidate the folder manifest.
      }
      if (files.length >= MAX_FOLDER_FILES) {
        truncated = true;
        break;
      }
    }
  }
  if (queue.length > 0 || files.length >= MAX_FOLDER_FILES) truncated = true;
  const manifest = [
    `Folder: ${record.descriptor.name}`,
    `Bounded inventory (${files.length}${truncated ? '+' : ''} files):`,
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- (empty folder)']),
    ...(omittedSensitive > 0
      ? [`${omittedSensitive} environment/credential file(s) were omitted.`]
      : []),
  ].join('\n');
  return contentBlocks.length > 0 ? `${manifest}\n\n${contentBlocks.join('\n\n')}` : manifest;
}

async function revalidatePathRecord(
  record: Extract<AttachmentRecord, { source: 'path' }>,
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(record.path);
  const kindMatches = record.pathKind === 'folder' ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !kindMatches || !sameIdentity(stat, record.identity)) {
    throw new Error(`${record.descriptor.name} changed after it was attached. Attach it again.`);
  }
  return stat;
}

export async function materializeAttachments(
  ownerId: number,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<MaterializedAttachments> {
  if (ids.length > MAX_ATTACHMENTS_PER_OWNER) {
    throw new Error(`At most ${MAX_ATTACHMENTS_PER_OWNER} attachments can be sent.`);
  }
  pruneOwner(ownerId);
  const records = recordsByOwner.get(ownerId);
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new Error('Duplicate attachment ids are not allowed.');

  const textBlocks: string[] = [];
  const images: AiImageInput[] = [];
  let totalTextChars = 0;
  let totalImageBytes = 0;
  for (const id of unique) {
    signal?.throwIfAborted();
    const record = records?.get(id);
    if (!record || record.ownerId !== ownerId) {
      throw new Error('A chat attachment expired or belongs to another window. Attach it again.');
    }
    record.lastUsedAt = Date.now();
    if (record.source === 'inline') {
      const remaining = MAX_TOTAL_TEXT_CHARS - totalTextChars;
      if (remaining <= 0) throw new Error('Combined text attachments exceed the context limit.');
      const text = record.text.slice(0, remaining);
      textBlocks.push(`Text attachment: ${record.descriptor.name}\n${text}`);
      totalTextChars += text.length;
      continue;
    }

    const stat = await revalidatePathRecord(record);
    if (record.pathKind === 'folder') {
      const folder = await materializeFolder(record, signal);
      const remaining = MAX_TOTAL_TEXT_CHARS - totalTextChars;
      if (folder.length > remaining)
        throw new Error('Combined folder attachments exceed the context limit.');
      textBlocks.push(folder);
      totalTextChars += folder.length;
      continue;
    }

    if (record.descriptor.kind === 'image') {
      if (images.length >= MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images can be sent.`);
      const imageSize = safeFileSize(stat);
      if (imageSize > MAX_IMAGE_BYTES || totalImageBytes + imageSize > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error('Combined images exceed the safe upload limit.');
      }
      const buffer = await readBounded(record.path, MAX_IMAGE_BYTES);
      const mediaType = imageMediaType(buffer);
      if (!mediaType) {
        throw new Error(
          `${record.descriptor.name} is not a supported PNG, JPEG, GIF, or WebP image.`,
        );
      }
      images.push({
        name: record.descriptor.name,
        mediaType,
        data: buffer.toString('base64'),
        sha256: createHash('sha256').update(buffer).digest('hex'),
      });
      totalImageBytes += buffer.length;
      continue;
    }

    const buffer = await readBounded(record.path, MAX_TEXT_FILE_BYTES);
    const decoded = decodeUtf8(buffer);
    const text = record.descriptor.kind === 'environment' ? redactEnvironment(decoded) : decoded;
    const remaining = MAX_TOTAL_TEXT_CHARS - totalTextChars;
    if (text.length > remaining)
      throw new Error('Combined text attachments exceed the context limit.');
    const label =
      record.descriptor.kind === 'environment'
        ? `Environment attachment (values redacted): ${record.descriptor.name}`
        : `File attachment: ${record.descriptor.detail}`;
    textBlocks.push(`${label}\n${text}`);
    totalTextChars += text.length;
  }
  return { text: textBlocks.join('\n\n'), images };
}
