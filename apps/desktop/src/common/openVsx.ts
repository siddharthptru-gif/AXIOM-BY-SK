/**
 * Open VSX registry protocol: URL policy and response normalization.
 *
 * Pure by design — no fetch, no filesystem — so every rule below is unit-testable and
 * the Main service is left with nothing but transport.
 *
 * Two things here are load-bearing and were established by probing the live registry
 * rather than by reading documentation:
 *
 *   1. `open-vsx.org` serves the JSON API, but every *file* request (the VSIX, its
 *      published digest, readme, icon) answers `302` to Eclipse's content CDN at
 *      `openvsx.eclipsecontent.org`. Refusing redirects outright would break every
 *      install; following them blindly would let a redirect send AXIOM anywhere. So
 *      exactly one hop is allowed, and the hop target is re-validated against a fixed
 *      host allowlist.
 *
 *   2. The registry publishes a `.sha256` file alongside each package, and the
 *      signature archive independently restates the same digest and size. Those are the
 *      integrity checks AXIOM enforces. The `.sigzip` also carries an ed25519 signature
 *      whose envelope format is not publicly specified; probing could not verify it
 *      against any candidate payload, so a signature is reported as *present* and never
 *      as *verified*. Claiming a check that was not performed would be worse than
 *      omitting it.
 */
import { isTargetPlatform } from './extensionVersionSelect';

/** The registry API origin. Also the only host allowed to issue a redirect. */
export const OPEN_VSX_ORIGIN = 'https://open-vsx.org';

/**
 * Hosts a registry response may come from. `open-vsx.org` serves the API and redirects
 * file requests to the Eclipse CDN, which serves package bytes.
 */
export const OPEN_VSX_HOSTS: readonly string[] = [
  'open-vsx.org',
  'openvsx.eclipsecontent.org',
  'openvsxcontent.blob.core.windows.net',
  'openvsxcontent.azureedge.net',
  'vsassets.io',
  'gallerycdn.vsassets.io',
  'raw.githubusercontent.com',
  'github.com',
  'githubassets.com',
  'gitlab.com',
  'unpkg.com',
  'cdn.jsdelivr.net',
];

/** Only the API host may serve JSON; the CDN serves bytes. */
const API_HOSTS: readonly string[] = ['open-vsx.org'];

/** One hop, and only into the allowlist. */
export const MAX_REGISTRY_REDIRECTS = 1;
/** Largest package AXIOM will pull from the registry. */
export const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
/** Largest JSON document. Search pages and manifests are kilobytes; this is slack. */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Largest readme/changelog rendered in the details pane. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** Largest extension icon accepted for display. */
export const MAX_ICON_BYTES = 5 * 1024 * 1024;
export const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
export const PACKAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Registry page size. The API caps `size` at 1000; 24 fills the grid without waste. */
export const REGISTRY_PAGE_SIZE = 24;

export type RegistrySortBy = 'relevance' | 'timestamp' | 'rating' | 'downloadCount';
export type RegistrySortOrder = 'asc' | 'desc';

export const SORT_BY_VALUES: readonly RegistrySortBy[] = [
  'relevance',
  'timestamp',
  'rating',
  'downloadCount',
];

export const REGISTRY_SORT_BY = ['relevance', 'timestamp', 'downloadCount', 'rating'] as const;

export const REGISTRY_SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * Categories as the registry spells them. Sent verbatim as the `category` filter, so
 * this list is the contract with the API rather than a display convenience.
 */
export const REGISTRY_CATEGORIES: readonly string[] = [
  'Programming Languages',
  'Snippets',
  'Linters',
  'Themes',
  'Formatters',
  'Debuggers',
  'Other',
  'Extension Packs',
  'Keymaps',
  'SCM Providers',
  'Language Packs',
  'Testing',
  'Data Science',
  'Machine Learning',
  'Visualization',
  'Notebooks',
  'Education',
  'Chat',
  'AI',
];

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------
function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const lowerHost = host.toLowerCase();
  return allowedHosts.some((allowed) => {
    const lowerAllowed = allowed.toLowerCase();
    return lowerHost === lowerAllowed || lowerHost.endsWith(`.${lowerAllowed}`);
  });
}

function canonicalize(rawUrl: string, allowedHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hash !== '') return null;
  if (!isHostAllowed(url.host, allowedHosts)) return null;
  return url.href;
}

/** Canonicalize a URL that must serve registry JSON. */
export function validateRegistryApiUrl(rawUrl: string): string | null {
  return canonicalize(rawUrl, API_HOSTS);
}

/**
 * Canonicalize a URL that may serve registry file bytes.
 *
 * Accepts the CDN as well as the API host, because that is where the registry sends
 * file requests. Used both for the initial URL and for re-validating a redirect target,
 * which is what keeps a hostile `Location` header from escaping the allowlist.
 */
export function validateRegistryFileUrl(rawUrl: string): string | null {
  return canonicalize(rawUrl, OPEN_VSX_HOSTS);
}

/** Build an API URL from a path and query, with the origin fixed. */
export function registryApiUrl(path: string, query: Record<string, string | number> = {}): string {
  if (!path.startsWith('/')) throw new Error('A registry API path must be absolute.');
  const url = new URL(`${OPEN_VSX_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const canonical = validateRegistryApiUrl(url.href);
  if (canonical === null) throw new Error('The registry API URL is not permitted.');
  return canonical;
}

export interface SearchQuery {
  query?: string;
  category?: string;
  size?: number;
  offset?: number;
  sortBy?: RegistrySortBy;
  sortOrder?: RegistrySortOrder;
}

/**
 * Build the search URL.
 *
 * Bounds are clamped rather than rejected: a caller asking for page 10,000 gets the
 * last page the registry will serve instead of an error, which is the behaviour the
 * grid wants when a user holds the scroll key down.
 */
export function registrySearchUrl(search: SearchQuery): string {
  const query: Record<string, string | number> = {
    size: clamp(search.size ?? REGISTRY_PAGE_SIZE, 1, 1000),
    offset: clamp(search.offset ?? 0, 0, 100_000),
  };
  const text = typeof search.query === 'string' ? search.query.trim().slice(0, 200) : '';
  if (text !== '') query.query = text;
  const category = typeof search.category === 'string' ? search.category.trim().slice(0, 80) : '';
  if (category !== '') query.category = category;
  if (search.sortBy !== undefined && SORT_BY_VALUES.includes(search.sortBy)) {
    query.sortBy = search.sortBy;
  }
  if (search.sortOrder === 'asc' || search.sortOrder === 'desc') query.sortOrder = search.sortOrder;
  return registryApiUrl('/api/-/search', query);
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

/** `publisher.name` split into its registry path segments, or null if malformed. */
export function splitExtensionId(id: unknown): { namespace: string; name: string } | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const namespace = trimmed.slice(0, dot);
  const name = trimmed.slice(dot + 1);
  // Path segments, so anything that could alter the URL shape is refused.
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!segment.test(namespace) || !segment.test(name)) return null;
  if (name.includes('.') && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return { namespace, name };
}

/** A registry version string safe to place in a URL path segment. */
export function isSafeVersionSegment(version: unknown): version is string {
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(version);
}

/**
 * Address one published build.
 *
 * A platform-specific build lives at `/{namespace}/{name}/{target}/{version}` — the same
 * `{namespace}/{name}/{version}` path answers with *some* platform's build, whichever the
 * registry happens to list first, so omitting the target when the extension publishes per
 * platform is how an editor ends up installing an alpine-arm64 binary on Windows.
 *
 * `universal` is not a path segment the registry serves; a build with no target of its own
 * is addressed without one.
 */
export function extensionMetadataUrl(
  namespace: string,
  name: string,
  version?: string,
  targetPlatform?: string,
): string {
  const target =
    targetPlatform !== undefined &&
    targetPlatform !== 'universal' &&
    isTargetPlatform(targetPlatform)
      ? `/${targetPlatform}`
      : '';
  const tail = version !== undefined && isSafeVersionSegment(version) ? `/${version}` : '';
  return registryApiUrl(`/api/${namespace}/${name}${target}${tail}`);
}

export function versionHistoryUrl(namespace: string, name: string, size: number, offset: number): string {
  return registryApiUrl(`/api/${namespace}/${name}/version-references`, {
    size: clamp(size, 1, 100),
    offset: clamp(offset, 0, 100_000),
  });
}

export function reviewsUrl(namespace: string, name: string): string {
  return registryApiUrl(`/api/${namespace}/${name}/reviews`);
}

export function publisherUrl(namespace: string): string {
  return registryApiUrl(`/api/${namespace}/details`);
}

export function registryVersionUrl(): string {
  return registryApiUrl('/api/version');
}

/**
 * Parse a published digest file.
 *
 * The registry serves a bare lowercase hex digest as `application/octet-stream`. Only a
 * single well-formed 64-hex token is accepted; a file containing anything else is
 * treated as no digest at all rather than being scavenged for something hash-shaped.
 */
export function parsePublishedDigest(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > 200) return null;
  const match = /^([0-9a-f]{64})(?:\s|$)/i.exec(trimmed);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** Honour `Retry-After` on a 429, clamped so a hostile header cannot stall the UI. */
export function retryAfterMs(header: string | null): number {
  if (header === null) return 1_000;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return clamp(seconds * 1000, 0, 30_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return clamp(date - Date.now(), 0, 30_000);
  return 1_000;
}

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------
export interface RegistryFileLinks {
  download: string | null;
  sha256: string | null;
  signature: string | null;
  publicKey: string | null;
  manifest: string | null;
  readme: string | null;
  changelog: string | null;
  license: string | null;
  icon: string | null;
}

export interface RegistryPublisher {
  loginName: string;
  fullName: string | null;
  avatarUrl: string | null;
  homepage: string | null;
  provider: string | null;
}

export interface RegistryExtensionSummary {
  /** `publisher.name`, lowercased, matching how installed extensions are keyed. */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string | null;
  version: string;
  publishedAt: string | null;
  downloadCount: number;
  averageRating: number | null;
  reviewCount: number;
  verified: boolean;
  deprecated: boolean;
  iconUrl: string | null;
}

export interface RegistryExtensionDetail extends RegistryExtensionSummary {
  namespaceDisplayName: string | null;
  categories: string[];
  tags: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  bugs: string | null;
  sponsor: string | null;
  engines: Record<string, string>;
  preview: boolean;
  preRelease: boolean;
  targetPlatform: string | null;
  publisher: RegistryPublisher | null;
  /** `publisher.name` ids this extension requires. */
  dependencies: string[];
  /** `publisher.name` ids bundled by this extension pack. */
  bundledExtensions: string[];
  replacementId: string | null;
  downloadable: boolean;
  files: RegistryFileLinks;
}

export interface RegistrySearchPage {
  offset: number;
  totalSize: number;
  extensions: RegistryExtensionSummary[];
}

export interface RegistryVersionRef {
  version: string;
  targetPlatform: string | null;
  engines: Record<string, string>;
  downloadUrl: string | null;
}

export interface RegistryVersionPage {
  offset: number;
  totalSize: number;
  versions: RegistryVersionRef[];
}

export interface RegistryReview {
  author: string;
  avatarUrl: string | null;
  rating: number;
  comment: string | null;
  postedAt: string | null;
}

export interface RegistryPublisherDetail {
  namespace: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  website: string | null;
  supportLink: string | null;
  verified: boolean;
  extensions: RegistryExtensionSummary[];
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------
const MAX_TEXT = 4_000;
const MAX_ITEMS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function asRating(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(5, Math.max(0, value));
}

/**
 * A URL from a registry payload, kept only when it points into the allowlist.
 *
 * The registry populates these itself, but they arrive over the network, so an icon or
 * download link pointing somewhere else is dropped rather than trusted.
 */
function asRegistryUrl(value: unknown): string | null {
  const raw = asText(value, 2_048);
  return raw === null ? null : validateRegistryFileUrl(raw);
}

/** An external link (homepage, repository) — informational, opened in the browser. */
function asExternalUrl(value: unknown): string | null {
  const raw = asText(value, 2_048);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

function asStringList(value: unknown, max = 60): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const entry = asText(item, 120);
    if (entry !== null) out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

function parseFileLinks(value: unknown): RegistryFileLinks {
  const files = asRecord(value) ?? {};
  return {
    download: asRegistryUrl(files.download),
    sha256: asRegistryUrl(files.sha256),
    signature: asRegistryUrl(files.signature),
    publicKey: asRegistryUrl(files.publicKey),
    manifest: asRegistryUrl(files.manifest),
    readme: asRegistryUrl(files.readme),
    changelog: asRegistryUrl(files.changelog),
    license: asRegistryUrl(files.license),
    icon: asRegistryUrl(files.icon),
  };
}

/** An `ExtensionReference` from the registry, reduced to its `publisher.name` id. */
function referenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value.slice(0, MAX_ITEMS)) {
    const entry = asRecord(item);
    const namespace = asText(entry?.namespace, 128);
    const name = asText(entry?.extension, 128);
    if (namespace !== null && name !== null) out.push(`${namespace}.${name}`.toLowerCase());
  }
  return out;
}

function parseSummary(value: unknown): RegistryExtensionSummary | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const namespace = asText(entry.namespace, 128);
  const name = asText(entry.name, 128);
  const version = asText(entry.version, 64);
  if (namespace === null || name === null || version === null) return null;
  if (splitExtensionId(`${namespace}.${name}`) === null) return null;
  const files = parseFileLinks(entry.files);
  return {
    id: `${namespace}.${name}`.toLowerCase(),
    namespace,
    name,
    displayName: asText(entry.displayName, 200) ?? name,
    description: asText(entry.description, 1_000),
    version,
    publishedAt: asText(entry.timestamp, 64),
    downloadCount: asCount(entry.downloadCount),
    averageRating: asRating(entry.averageRating),
    reviewCount: asCount(entry.reviewCount),
    verified: entry.verified === true,
    deprecated: entry.deprecated === true,
    iconUrl: files.icon,
  };
}

export function parseSearchPage(value: unknown): RegistrySearchPage {
  const body = asRecord(value);
  const rawExtensions = Array.isArray(body?.extensions) ? body.extensions : [];
  const extensions: RegistryExtensionSummary[] = [];
  for (const item of rawExtensions.slice(0, MAX_ITEMS)) {
    const summary = parseSummary(item);
    if (summary) extensions.push(summary);
  }
  return {
    offset: asCount(body?.offset),
    totalSize: asCount(body?.totalSize),
    extensions,
  };
}

export function parseExtensionDetail(value: unknown): RegistryExtensionDetail | null {
  const summary = parseSummary(value);
  const entry = asRecord(value);
  if (!summary || !entry) return null;
  const engines: Record<string, string> = {};
  const rawEngines = asRecord(entry.engines);
  if (rawEngines) {
    for (const [engine, range] of Object.entries(rawEngines).slice(0, 20)) {
      const key = asText(engine, 40);
      const value_ = asText(range, 120);
      if (key !== null && value_ !== null) engines[key] = value_;
    }
  }
  const publisherRecord = asRecord(entry.publishedBy);
  const loginName = asText(publisherRecord?.loginName, 128);
  const replacement = asRecord(entry.replacement);
  return {
    ...summary,
    namespaceDisplayName: asText(entry.namespaceDisplayName, 200),
    categories: asStringList(entry.categories),
    tags: asStringList(entry.tags, 100),
    license: asText(entry.license, 120),
    homepage: asExternalUrl(entry.homepage),
    repository: asExternalUrl(entry.repository),
    bugs: asExternalUrl(entry.bugs),
    sponsor: asExternalUrl(entry.sponsorLink),
    engines,
    preview: entry.preview === true,
    preRelease: entry.preRelease === true,
    targetPlatform: asText(entry.targetPlatform, 40),
    publisher:
      loginName === null
        ? null
        : {
            loginName,
            fullName: asText(publisherRecord?.fullName, 200),
            avatarUrl: asExternalUrl(publisherRecord?.avatarUrl),
            homepage: asExternalUrl(publisherRecord?.homepage),
            provider: asText(publisherRecord?.provider, 40),
          },
    dependencies: referenceIds(entry.dependencies),
    bundledExtensions: referenceIds(entry.bundledExtensions),
    replacementId: asText(replacement?.displayName, 200),
    // The registry says explicitly when a package must not be offered for download.
    downloadable: entry.downloadable !== false,
    files: parseFileLinks(entry.files),
  };
}

export function parseVersionPage(value: unknown): RegistryVersionPage {
  const body = asRecord(value);
  const raw = Array.isArray(body?.versions) ? body.versions : [];
  const versions: RegistryVersionRef[] = [];
  for (const item of raw.slice(0, 200)) {
    const entry = asRecord(item);
    const version = asText(entry?.version, 64);
    if (version === null || !isSafeVersionSegment(version)) continue;
    const engines: Record<string, string> = {};
    const rawEngines = asRecord(entry?.engines);
    if (rawEngines) {
      for (const [engine, range] of Object.entries(rawEngines).slice(0, 20)) {
        const key = asText(engine, 40);
        const value_ = asText(range, 120);
        if (key !== null && value_ !== null) engines[key] = value_;
      }
    }
    versions.push({
      version,
      targetPlatform: asText(entry?.targetPlatform, 40),
      engines,
      downloadUrl: parseFileLinks(entry?.files).download,
    });
  }
  return {
    offset: asCount(body?.offset),
    totalSize: asCount(body?.totalSize),
    versions,
  };
}

export function parseReviews(value: unknown): RegistryReview[] {
  const body = asRecord(value);
  const raw = Array.isArray(body?.reviews) ? body.reviews : [];
  const reviews: RegistryReview[] = [];
  for (const item of raw.slice(0, 200)) {
    const entry = asRecord(item);
    if (!entry) continue;
    const user = asRecord(entry.user);
    const author = asText(user?.loginName, 128);
    const rating = asRating(entry.rating);
    if (author === null || rating === null) continue;
    reviews.push({
      author,
      avatarUrl: asExternalUrl(user?.avatarUrl),
      rating,
      comment: asText(entry.comment, 4_000),
      postedAt: asText(entry.timestamp, 64),
    });
  }
  return reviews;
}

export function parsePublisherDetail(value: unknown): RegistryPublisherDetail | null {
  const entry = asRecord(value);
  const namespace = asText(entry?.name, 128);
  if (!entry || namespace === null) return null;
  const extensions: RegistryExtensionSummary[] = [];
  if (Array.isArray(entry.extensions)) {
    for (const item of entry.extensions.slice(0, MAX_ITEMS)) {
      const summary = parseSummary(item);
      if (summary) extensions.push(summary);
    }
  }
  return {
    namespace,
    displayName: asText(entry.displayName, 200) ?? namespace,
    description: asText(entry.description, 2_000),
    logoUrl: asRegistryUrl(entry.logo),
    website: asExternalUrl(entry.website),
    supportLink: asExternalUrl(entry.supportLink),
    verified: entry.verified === true,
    extensions,
  };
}

// ---------------------------------------------------------------------------
// Integrity reporting
// ---------------------------------------------------------------------------
export type SignatureState = 'absent' | 'present-unverified';

export interface PackageIntegrity {
  /** SHA-256 of the bytes AXIOM actually received. */
  sha256: string;
  /** The digest the registry published, when it served one. */
  publishedSha256: string | null;
  /** True when a published digest existed and matched. */
  digestVerified: boolean;
  /** True when the signature archive restated the same digest and size. */
  signatureManifestVerified: boolean;
  /**
   * Never `verified`: the registry's ed25519 envelope format is not published, so its
   * presence is reported without asserting that AXIOM checked it.
   */
  signature: SignatureState;
}

/** A one-line, honest summary of what was actually checked. */
export function describeIntegrity(integrity: PackageIntegrity): string {
  if (!integrity.digestVerified && !integrity.signatureManifestVerified) {
    return 'The registry published no checksum for this package; only its structure was validated.';
  }
  const checks: string[] = [];
  if (integrity.digestVerified) checks.push('published checksum');
  if (integrity.signatureManifestVerified) checks.push('signature manifest');
  const signature =
    integrity.signature === 'present-unverified'
      ? ' A publisher signature is present; AXIOM does not verify its envelope.'
      : '';
  return `Verified against the ${checks.join(' and ')}.${signature}`;
}
