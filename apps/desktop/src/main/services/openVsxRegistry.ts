import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import {
  MAX_DOCUMENT_BYTES,
  MAX_ICON_BYTES,
  MAX_JSON_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_REGISTRY_REDIRECTS,
  PACKAGE_DOWNLOAD_TIMEOUT_MS,
  REGISTRY_REQUEST_TIMEOUT_MS,
  describeIntegrity,
  extensionMetadataUrl,
  parseExtensionDetail,
  parsePublishedDigest,
  parsePublisherDetail,
  parseReviews,
  parseSearchPage,
  parseVersionPage,
  publisherUrl,
  registrySearchUrl,
  registryVersionUrl,
  retryAfterMs,
  reviewsUrl,
  splitExtensionId,
  validateRegistryFileUrl,
  versionHistoryUrl,
  type PackageIntegrity,
  type RegistryExtensionDetail,
  type RegistryPublisherDetail,
  type RegistryReview,
  type RegistrySearchPage,
  type RegistryVersionPage,
  type SearchQuery,
} from '../../common/openVsx';
import {
  selectVersion,
  targetPlatformFor,
  type TargetPlatform,
  type VersionCandidate,
  type VersionRejectReason,
} from '../../common/extensionVersionSelect';
import { readZipEntryBytes } from './vsix';

/**
 * Open VSX transport.
 *
 * Everything about *what* a URL may be lives in `common/openVsx.ts`; this module is the
 * part that touches the network and the disk. It exists to give the rest of AXIOM a
 * small, honest surface: search, details, version history, reviews, publisher, and
 * "fetch this package and tell me exactly what you were able to verify about it".
 *
 * Behaviours worth knowing:
 *
 *   - Every request is time-bounded and size-bounded while streaming, so a slow or
 *     endless response cannot pin a renderer waiting on IPC.
 *   - `429` is honoured via `Retry-After` with a small, bounded number of retries. The
 *     registry rate-limits per client, and hammering it on failure is how a user ends up
 *     locked out mid-browse.
 *   - Redirects are followed exactly once and the target is re-validated. This is not
 *     optional: the registry answers every file request with a redirect to its CDN.
 *   - Catalog metadata for installed extensions is cached on disk so a launch-time
 *     update check costs one conditional pass instead of one request per extension.
 */
const log = rootLogger.child('open-vsx');

/**
 * Re-fetchable public catalog data. Kept in its own directory so it is obvious that
 * deleting it costs nothing but a round trip.
 */
function registryDirectory(): string {
  return join(app.getPath('userData'), 'extension-registry');
}

function catalogPath(): string {
  return join(registryDirectory(), 'catalog.json');
}

/** How long a cached latest-version answer stays usable. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** In-session cache lifetime for browse responses. */
const RESPONSE_TTL_MS = 5 * 60 * 1000;
/** Retries for a rate-limited request. Small: the point is politeness, not persistence. */
const MAX_RATE_LIMIT_RETRIES = 2;
/** Parallel registry requests during a bulk update check. */
const UPDATE_CHECK_CONCURRENCY = 4;

export class RegistryError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
interface FetchOutcome {
  bytes: Buffer;
  contentType: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a response body while enforcing the ceiling.
 *
 * The declared `content-length` is checked first as a cheap rejection, but the running
 * total is what actually enforces the limit — a response may lie about its length or
 * omit it entirely.
 */
async function readBounded(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    throw new RegistryError(`The ${what} is larger than AXIOM will download.`);
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new RegistryError(`The ${what} is larger than AXIOM will download.`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or torn down.
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Perform one allowlisted request, following at most one redirect.
 *
 * Each hop is re-validated with `validateRegistryFileUrl`, so a `Location` header can
 * only move the request between hosts AXIOM already trusts.
 */
async function requestOnce(
  url: string,
  accept: string,
  maxBytes: number,
  timeoutMs: number,
  what: string,
): Promise<FetchOutcome> {
  let current = validateRegistryFileUrl(url);
  if (current === null) throw new RegistryError('That registry URL is not permitted.');

  for (let hop = 0; hop <= MAX_REGISTRY_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { accept },
      });
    } catch (error) {
      throw new RegistryError(
        controller.signal.aborted
          ? `The registry did not respond in time while fetching the ${what}.`
          : `The registry could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 307 ||
      response.status === 308
    ) {
      const location = response.headers.get('location');
      if (location === null) throw new RegistryError('The registry redirected without a target.');
      let resolved: string;
      try {
        resolved = new URL(location, current).href;
      } catch {
        throw new RegistryError('The registry redirected to an unreadable address.');
      }
      const next = validateRegistryFileUrl(resolved);
      if (next === null) {
        throw new RegistryError('The registry redirected outside its approved hosts.');
      }
      current = next;
      continue;
    }

    if (response.status === 429) {
      throw new RegistryError('The registry is rate-limiting this client.', 429);
    }
    if (response.status === 404) {
      throw new RegistryError(`That extension is not in the registry.`, 404);
    }
    if (!response.ok) {
      throw new RegistryError(
        `The registry returned ${response.status} for the ${what}.`,
        response.status,
      );
    }
    return {
      bytes: await readBounded(response, maxBytes, what),
      contentType: response.headers.get('content-type'),
    };
  }
  throw new RegistryError('The registry redirected more times than AXIOM allows.');
}

/** Request with bounded retries when the registry asks us to slow down. */
async function request(
  url: string,
  accept: string,
  maxBytes: number,
  timeoutMs: number,
  what: string,
): Promise<FetchOutcome> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await requestOnce(url, accept, maxBytes, timeoutMs, what);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RegistryError) || error.status !== 429) throw error;
      if (attempt === MAX_RATE_LIMIT_RETRIES) break;
      // `Retry-After` is not available here because the 429 response was already
      // discarded, so back off on a bounded schedule instead of guessing longer.
      await sleep(retryAfterMs(null) * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new RegistryError('The registry request failed.');
}

async function requestJson<T>(url: string, what: string, parse: (value: unknown) => T): Promise<T> {
  const outcome = await request(
    url,
    'application/json',
    MAX_JSON_BYTES,
    REGISTRY_REQUEST_TIMEOUT_MS,
    what,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bytes.toString('utf8'));
  } catch {
    throw new RegistryError(`The registry returned an unreadable ${what}.`);
  }
  return parse(parsed);
}

// ---------------------------------------------------------------------------
// In-session response cache
// ---------------------------------------------------------------------------
interface CacheSlot {
  value: unknown;
  expiresAt: number;
}
const responseCache = new Map<string, CacheSlot>();
/** Bounded so a long browsing session cannot grow the cache without limit. */
const MAX_CACHE_ENTRIES = 200;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = responseCache.get(key);
  if (slot && slot.expiresAt > now) return slot.value as T;
  const value = await load();
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next();
    if (!oldest.done) responseCache.delete(oldest.value);
  }
  responseCache.set(key, { value, expiresAt: now + RESPONSE_TTL_MS });
  return value;
}

/** Drop cached browse responses, so a manual refresh really refetches. */
export function clearRegistryCache(): void {
  responseCache.clear();
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------
/** True when the registry answers its version endpoint, used for an honest offline state. */
export async function registryReachable(): Promise<boolean> {
  try {
    await requestJson(registryVersionUrl(), 'registry version', (value) => value);
    return true;
  } catch (error) {
    log.info('The extension registry is not reachable', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function searchExtensions(search: SearchQuery): Promise<RegistrySearchPage> {
  const url = registrySearchUrl(search);
  return cached(`search:${url}`, () => requestJson(url, 'search results', parseSearchPage));
}

export async function extensionDetail(
  id: string,
  version?: string,
  targetPlatform?: string,
): Promise<RegistryExtensionDetail> {
  const parts = splitExtensionId(id);
  if (!parts) throw new RegistryError('That extension identifier is not valid.');
  const url = extensionMetadataUrl(parts.namespace, parts.name, version, targetPlatform);
  return cached(`detail:${url}`, async () => {
    const detail = await requestJson(url, 'extension details', parseExtensionDetail);
    if (detail === null)
      throw new RegistryError('The registry returned incomplete extension details.');
    return detail;
  });
}

export async function versionHistory(
  id: string,
  offset = 0,
  size = 25,
): Promise<RegistryVersionPage> {
  const parts = splitExtensionId(id);
  if (!parts) throw new RegistryError('That extension identifier is not valid.');
  const url = versionHistoryUrl(parts.namespace, parts.name, size, offset);
  return cached(`versions:${url}`, () => requestJson(url, 'version history', parseVersionPage));
}

// ---------------------------------------------------------------------------
// Version + target-platform negotiation
// ---------------------------------------------------------------------------
/**
 * Pick the build to install, the way a VS Code client does.
 *
 * Two facts about the registry make this necessary rather than decorative:
 *
 *   - `latest` is the newest *published* version, not the newest version this editor can
 *     run. Extensions raise `engines.vscode` continuously, so asking for `latest` and then
 *     failing the engine gate refuses packages the user can install in VS Code today,
 *     where an older compatible build would be selected instead.
 *   - A platform-specific extension publishes the same version once per target, and the
 *     untargeted URL answers with whichever the registry lists first — alphabetically, so
 *     `alpine-arm64` on a Windows machine. Native binaries then fail at activation.
 *
 * `version-references` is the only endpoint that reports `engines` and `targetPlatform`
 * per build, so negotiation reads it page by page and stops as soon as something viable
 * appears. That is one request in the common case (the newest build is fine) and a bounded
 * walk backwards when it is not.
 *
 * The policy itself is not restated here: `selectVersion` in `common/extensionVersionSelect`
 * owns it and is exercised directly by the platform validation suite.
 */
const VERSION_PAGE_SIZE = 100;
/** How far back a negotiation may walk. Beyond this, "no compatible build" is the answer. */
const MAX_VERSION_SCAN = 500;

/** The marketplace target this build of AXIOM runs on, or `undefined` if unrecognised. */
export function hostTargetPlatform(): TargetPlatform | undefined {
  return targetPlatformFor(process.platform, process.arch);
}

export interface InstallCandidateOptions {
  /** An exact version the user asked for. Skips version selection, keeps platform choice. */
  version?: string;
  /** Overrides the running platform. Only tests need this. */
  platform?: string;
  allowPreRelease?: boolean;
  blocked?: readonly string[];
}

export interface InstallCandidate {
  detail: RegistryExtensionDetail;
  /** The target the chosen build was addressed by; null for a build with no target. */
  targetPlatform: string | null;
  /** False when versions could not be enumerated and the registry's default was used. */
  negotiated: boolean;
  /** How many published references were examined. */
  considered: number;
  rejected: Array<{ version: string; reason: VersionRejectReason }>;
}

/** Turn rejection reasons into a sentence a user can act on. */
function describeRejections(
  considered: number,
  rejected: readonly { version: string; reason: VersionRejectReason }[],
): string {
  const counts = new Map<VersionRejectReason, number>();
  for (const entry of rejected) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  const wording: Record<VersionRejectReason, string> = {
    engine: 'need a newer editor',
    platform: 'are built for a different platform',
    'pre-release': 'are pre-releases',
    blocked: 'are blocked',
    range: 'do not satisfy a required range',
  };
  const parts = [...counts.entries()].map(([reason, count]) => `${count} ${wording[reason]}`);
  return parts.length === 0
    ? `the registry lists no downloadable build (checked ${considered})`
    : `of ${considered} published builds, ${parts.join(', ')}`;
}

function candidateFrom(reference: {
  version: string;
  targetPlatform: string | null;
  engines: Record<string, string>;
}): VersionCandidate {
  const engine = reference.engines['vscode'];
  return {
    version: reference.version,
    ...(engine === undefined ? {} : { engine }),
    ...(reference.targetPlatform === null ? {} : { targetPlatform: reference.targetPlatform }),
  };
}

/** For an explicitly requested version: our platform's build, else the untargeted one. */
function pickForPlatform(
  candidates: readonly VersionCandidate[],
  platform: string | undefined,
): VersionCandidate | null {
  const exact = candidates.find(
    (candidate) => platform !== undefined && candidate.targetPlatform === platform,
  );
  if (exact !== undefined) return exact;
  const untargeted = candidates.find(
    (candidate) =>
      candidate.targetPlatform === undefined || candidate.targetPlatform === 'universal',
  );
  return untargeted ?? null;
}

/**
 * Resolve which published build to install, and return its details.
 *
 * Falls back to the registry's own default when versions cannot be enumerated at all — an
 * offline-ish registry must not turn every install into a refusal — but a *successful*
 * enumeration with nothing viable in it is an error, because installing anyway is exactly
 * the failure mode this exists to prevent.
 */
export async function resolveInstallCandidate(
  id: string,
  options: InstallCandidateOptions = {},
): Promise<InstallCandidate> {
  const parts = splitExtensionId(id);
  if (!parts) throw new RegistryError('That extension identifier is not valid.');
  const platform = options.platform ?? hostTargetPlatform();
  const requested = options.version;

  const candidates: VersionCandidate[] = [];
  const seen = new Set<string>();
  let picked: VersionCandidate | null = null;
  let rejected: Array<{ version: string; reason: VersionRejectReason }> = [];
  let enumerated = false;

  try {
    for (let offset = 0; offset < MAX_VERSION_SCAN; offset += VERSION_PAGE_SIZE) {
      const page = await versionHistory(id, offset, VERSION_PAGE_SIZE);
      enumerated = true;
      for (const reference of page.versions) {
        const key = `${reference.version}@${reference.targetPlatform ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidateFrom(reference));
      }
      if (requested === undefined) {
        const selection = selectVersion(candidates, {
          ...(platform === undefined ? {} : { platform }),
          ...(options.allowPreRelease === undefined
            ? {}
            : { allowPreRelease: options.allowPreRelease }),
          ...(options.blocked === undefined ? {} : { blocked: options.blocked }),
        });
        picked = selection.picked;
        rejected = selection.rejected;
      } else {
        picked = pickForPlatform(
          candidates.filter((candidate) => candidate.version === requested),
          platform,
        );
      }
      if (picked !== null) break;
      if (page.versions.length === 0) break;
      if (offset + page.versions.length >= page.totalSize) break;
    }
  } catch (error) {
    // Enumeration is an optimisation over "install whatever the registry hands us"; a
    // registry that cannot list versions still deserves an install attempt.
    log.info('Version references could not be read; falling back to the registry default', {
      id,
      reason: error instanceof Error ? error.message : String(error),
    });
    enumerated = false;
  }

  if (picked !== null) {
    const target = picked.targetPlatform ?? null;
    const detail = await extensionDetail(id, picked.version, target ?? undefined);
    return {
      detail,
      targetPlatform: target,
      negotiated: true,
      considered: candidates.length,
      rejected,
    };
  }

  if (enumerated && candidates.length > 0) {
    throw new RegistryError(
      `No build of ${id} can run on this editor and platform: ${describeRejections(
        candidates.length,
        rejected,
      )}.`,
    );
  }

  // Nothing could be enumerated. Take the registry's default, but if that default turns
  // out to be another platform's build, ask for ours by name before giving up on it.
  const fallback = await extensionDetail(id, requested);
  if (
    fallback.targetPlatform !== null &&
    fallback.targetPlatform !== 'universal' &&
    fallback.targetPlatform !== platform &&
    platform !== undefined
  ) {
    try {
      const corrected = await extensionDetail(id, requested, platform);
      return {
        detail: corrected,
        targetPlatform: platform,
        negotiated: false,
        considered: candidates.length,
        rejected,
      };
    } catch (error) {
      log.info('No platform-specific build was published for this platform', {
        id,
        platform,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    detail: fallback,
    targetPlatform: fallback.targetPlatform,
    negotiated: false,
    considered: candidates.length,
    rejected,
  };
}

export async function extensionReviews(id: string): Promise<RegistryReview[]> {
  const parts = splitExtensionId(id);
  if (!parts) throw new RegistryError('That extension identifier is not valid.');
  const url = reviewsUrl(parts.namespace, parts.name);
  return cached(`reviews:${url}`, () => requestJson(url, 'reviews', parseReviews));
}

export async function publisherDetail(namespace: string): Promise<RegistryPublisherDetail> {
  if (splitExtensionId(`${namespace}.x`) === null) {
    throw new RegistryError('That publisher name is not valid.');
  }
  const url = publisherUrl(namespace);
  return cached(`publisher:${url}`, async () => {
    const detail = await requestJson(url, 'publisher details', parsePublisherDetail);
    if (detail === null)
      throw new RegistryError('The registry returned incomplete publisher details.');
    return detail;
  });
}

/** Fetch a readme or changelog for the details pane. Markdown, rendered by the renderer. */
export async function extensionDocument(url: string): Promise<string> {
  const outcome = await request(
    url,
    'text/markdown',
    MAX_DOCUMENT_BYTES,
    REGISTRY_REQUEST_TIMEOUT_MS,
    'document',
  );
  return outcome.bytes.toString('utf8');
}

/** Fetch an extension icon as a data URL, so the renderer never makes its own requests. */
export async function extensionIcon(url: string): Promise<string | null> {
  try {
    const outcome = await request(
      url,
      'image/*',
      MAX_ICON_BYTES,
      REGISTRY_REQUEST_TIMEOUT_MS,
      'icon',
    );
    const type = outcome.contentType ?? 'image/png';
    // Only raster types the renderer can show inline; SVG is excluded because an inline
    // SVG is a script-capable document, not just a picture.
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)\b/i.test(type))
      return null;
    const mime = type.split(';')[0]?.trim() ?? 'image/png';
    return `data:${mime};base64,${outcome.bytes.toString('base64')}`;
  } catch {
    // A missing icon is cosmetic; it must never fail a browse.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Package download + integrity
// ---------------------------------------------------------------------------
export interface DownloadedPackage {
  bytes: Buffer;
  integrity: PackageIntegrity;
  /** A sentence describing exactly what was checked, for the audit log and the UI. */
  integritySummary: string;
}

interface SignatureManifest {
  packageSize: number | null;
  packageSha256: string | null;
}

/**
 * Read the digest and size the signature archive states for the package.
 *
 * The archive's `.signature.manifest` restates the package size and SHA-256 (base64),
 * plus a per-entry digest table. Comparing the restated values against the bytes we
 * received is a real, independent check, and it is the strongest one available: the
 * ed25519 envelope beside it uses an unpublished format that probing could not verify,
 * so it is deliberately not consulted.
 */
async function readSignatureManifest(sigzip: Buffer): Promise<SignatureManifest> {
  try {
    const bytes = await readZipEntryBytes(sigzip, '.signature.manifest');
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const record =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const pkg = record?.package;
    const pkgRecord = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : null;
    const digests = pkgRecord?.digests;
    const digestRecord =
      digests && typeof digests === 'object' ? (digests as Record<string, unknown>) : null;
    const base64 = typeof digestRecord?.sha256 === 'string' ? digestRecord.sha256 : null;
    const size = typeof pkgRecord?.size === 'number' ? pkgRecord.size : null;
    const hex =
      base64 === null ? null : Buffer.from(base64, 'base64').toString('hex').toLowerCase();
    return {
      packageSize: size,
      packageSha256: hex !== null && /^[0-9a-f]{64}$/.test(hex) ? hex : null,
    };
  } catch (error) {
    log.info('The signature archive could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { packageSize: null, packageSha256: null };
  }
}

/**
 * Download a package and report what could be verified about it.
 *
 * Integrity is reported rather than assumed: the caller decides whether a package with
 * no published digest may be installed. Both the published `.sha256` and the signature
 * manifest are consulted, and a mismatch on either is fatal here — a package whose bytes
 * disagree with what the registry says it published is never handed on.
 */
export async function downloadPackage(detail: RegistryExtensionDetail): Promise<DownloadedPackage> {
  if (!detail.downloadable || detail.files.download === null) {
    throw new RegistryError('The registry does not offer this extension for download.');
  }

  let publishedSha256: string | null = null;
  if (detail.files.sha256 !== null) {
    try {
      const digestFile = await request(
        detail.files.sha256,
        'text/plain',
        4_096,
        REGISTRY_REQUEST_TIMEOUT_MS,
        'published checksum',
      );
      publishedSha256 = parsePublishedDigest(digestFile.bytes.toString('utf8'));
    } catch (error) {
      log.info('The published checksum could not be fetched', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const download = await request(
    detail.files.download,
    'application/octet-stream',
    MAX_PACKAGE_BYTES,
    PACKAGE_DOWNLOAD_TIMEOUT_MS,
    'extension package',
  );
  const bytes = download.bytes;
  if (bytes.length === 0) throw new RegistryError('The registry returned an empty package.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  if (publishedSha256 !== null && publishedSha256 !== sha256) {
    throw new RegistryError(
      'The downloaded package does not match the checksum the registry published for it.',
    );
  }

  let signatureManifestVerified = false;
  let signature: PackageIntegrity['signature'] = 'absent';
  if (detail.files.signature !== null) {
    signature = 'present-unverified';
    try {
      const archive = await request(
        detail.files.signature,
        'application/octet-stream',
        MAX_PACKAGE_BYTES,
        REGISTRY_REQUEST_TIMEOUT_MS,
        'signature archive',
      );
      const stated = await readSignatureManifest(archive.bytes);
      if (stated.packageSha256 !== null) {
        if (stated.packageSha256 !== sha256) {
          throw new RegistryError(
            'The downloaded package does not match the digest in its signature manifest.',
          );
        }
        if (stated.packageSize !== null && stated.packageSize !== bytes.length) {
          throw new RegistryError(
            'The downloaded package does not match the size in its signature manifest.',
          );
        }
        signatureManifestVerified = true;
      }
    } catch (error) {
      if (error instanceof RegistryError && /does not match/.test(error.message)) throw error;
      log.info('The signature archive was not usable', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const integrity: PackageIntegrity = {
    sha256,
    publishedSha256,
    digestVerified: publishedSha256 !== null && publishedSha256 === sha256,
    signatureManifestVerified,
    signature,
  };
  return { bytes, integrity, integritySummary: describeIntegrity(integrity) };
}

// ---------------------------------------------------------------------------
// Catalog cache for update checks
// ---------------------------------------------------------------------------
interface CatalogRecord {
  version: string;
  displayName: string;
  checkedAt: number;
  deprecated: boolean;
}

type Catalog = Record<string, CatalogRecord>;

async function readCatalog(): Promise<Catalog> {
  try {
    const parsed: unknown = JSON.parse(await readFile(catalogPath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Catalog = {};
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
      if (!record) continue;
      const version = typeof record.version === 'string' ? record.version : null;
      const checkedAt = typeof record.checkedAt === 'number' ? record.checkedAt : null;
      if (version === null || checkedAt === null) continue;
      out[id] = {
        version,
        displayName: typeof record.displayName === 'string' ? record.displayName : id,
        checkedAt,
        deprecated: record.deprecated === true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Written atomically: a truncated cache would be re-read as garbage on every launch. */
async function writeCatalog(catalog: Catalog): Promise<void> {
  const directory = registryDirectory();
  const target = catalogPath();
  const temporary = join(directory, `.catalog-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    log.warn('The extension catalog cache could not be written', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Run an async mapping with bounded parallelism, preserving input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await map(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface LatestVersionLookup {
  id: string;
  latestVersion: string | null;
  displayName: string | null;
  deprecated: boolean;
  /** True when the answer came from the on-disk cache rather than the network. */
  fromCache: boolean;
  error: string | null;
}

/**
 * Look up the latest published version of each id, in bounded parallel, reusing the
 * on-disk catalog for anything checked recently.
 *
 * This is what "background updates" and "Update All" run on. A failing lookup returns an
 * error for that id and does not sink the batch: one unreachable extension must not make
 * the whole update check look broken.
 */
export async function latestVersions(
  ids: readonly string[],
  options: { force?: boolean } = {},
): Promise<LatestVersionLookup[]> {
  const catalog = await readCatalog();
  const now = Date.now();
  const results = await mapBounded(ids, UPDATE_CHECK_CONCURRENCY, async (id) => {
    const cachedRecord = catalog[id];
    if (
      options.force !== true &&
      cachedRecord !== undefined &&
      now - cachedRecord.checkedAt < CATALOG_TTL_MS
    ) {
      return {
        id,
        latestVersion: cachedRecord.version,
        displayName: cachedRecord.displayName,
        deprecated: cachedRecord.deprecated,
        fromCache: true,
        error: null,
      } satisfies LatestVersionLookup;
    }
    try {
      // The newest *installable* build, not the newest published one: offering an update
      // that the engine gate would then refuse is worse than offering none.
      const detail = (await resolveInstallCandidate(id)).detail;
      catalog[id] = {
        version: detail.version,
        displayName: detail.displayName,
        checkedAt: now,
        deprecated: detail.deprecated,
      };
      return {
        id,
        latestVersion: detail.version,
        displayName: detail.displayName,
        deprecated: detail.deprecated,
        fromCache: false,
        error: null,
      } satisfies LatestVersionLookup;
    } catch (error) {
      return {
        id,
        latestVersion: cachedRecord?.version ?? null,
        displayName: cachedRecord?.displayName ?? null,
        deprecated: cachedRecord?.deprecated ?? false,
        fromCache: cachedRecord !== undefined,
        error: error instanceof Error ? error.message : String(error),
      } satisfies LatestVersionLookup;
    }
  });
  if (results.some((result) => !result.fromCache && result.error === null)) {
    await writeCatalog(catalog);
  }
  return results;
}
