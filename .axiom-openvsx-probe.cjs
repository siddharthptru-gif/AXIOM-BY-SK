#!/usr/bin/env node
/**
 * Live probe of the Open VSX registry, run BEFORE writing the client.
 *
 * The point is to replace assumptions with observations: what the search and metadata
 * responses actually contain, whether a VSIX download redirects off the registry host,
 * what the published `.sha256` file literally looks like, and how a real VSIX is laid
 * out inside its zip. Every one of those decides a line of the client, and getting any
 * of them wrong is a bug that only shows up on a user's machine.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

const BASE = 'https://open-vsx.org';
const SAMPLE = { namespace: 'vscode-icons-team', name: 'vscode-icons' };
const out = [];
let failures = 0;

function check(name, ok, detail) {
  out.push(`${ok ? 'PASS ' : 'FAIL '} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function note(text) {
  out.push(`       ${text}`);
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, {
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'application/json' },
  });
  const limit = response.headers.get('x-ratelimit-remaining');
  return { status: response.status, body: await response.json(), rateRemaining: limit };
}

/**
 * Hosts a package download is allowed to reach. The registry itself redirects file
 * requests to Eclipse's content CDN, so refusing every redirect would refuse every
 * install; following redirects blindly would let a redirect walk us anywhere.
 */
const ALLOWED_HOSTS = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org']);

/** Fetch a registry file, following at most one redirect into an allowlisted host. */
async function getFile(rawUrl, accept) {
  const hops = [];
  let url = rawUrl;
  for (let hop = 0; hop <= 1; hop += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error(`Not HTTPS: ${url}`);
    if (!ALLOWED_HOSTS.has(parsed.host)) throw new Error(`Host not allowed: ${parsed.host}`);
    hops.push(parsed.host);
    const response = await fetch(url, {
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept },
    });
    if (response.status === 301 || response.status === 302 || response.status === 307) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without a location.');
      url = new URL(location, url).href;
      continue;
    }
    return { response, hops, finalUrl: url };
  }
  throw new Error('Too many redirects.');
}

/** Minimal end-of-central-directory zip reader: enough to list entries and sizes. */
function readZipEntries(buffer) {
  const MAX_COMMENT = 0xffff;
  const start = Math.max(0, buffer.length - MAX_COMMENT - 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('No end-of-central-directory record.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Bad central directory header.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The allowlist has to actually refuse something, or it is decoration. */
async function refusesForeignRedirect() {
  try {
    await getFile('https://example.com/evil.vsix', 'application/octet-stream');
    return false;
  } catch (error) {
    return error instanceof Error && error.message.startsWith('Host not allowed');
  }
}

function inflateEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('Bad local header.');
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  return entry.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
}

async function main() {
  // --- 1. Reachability + rate limits -------------------------------------
  const version = await getJson('/api/version');
  check('the registry answers /api/version', version.status === 200, JSON.stringify(version.body));
  note(`rate limit remaining: ${version.rateRemaining ?? 'not reported'}`);

  // --- 2. Search ---------------------------------------------------------
  const search = await getJson(
    '/api/-/search?query=theme&size=3&offset=0&sortBy=downloadCount&sortOrder=desc',
  );
  check('search returns results', search.status === 200 && Array.isArray(search.body.extensions));
  check(
    'search reports paging totals',
    typeof search.body.offset === 'number' && typeof search.body.totalSize === 'number',
    `offset=${search.body.offset} totalSize=${search.body.totalSize}`,
  );
  const first = search.body.extensions?.[0];
  check('a search entry carries the fields the list needs', Boolean(first));
  if (first) {
    note(`entry keys: ${Object.keys(first).sort().join(', ')}`);
    note(`file keys: ${Object.keys(first.files ?? {}).sort().join(', ')}`);
    check('a search entry has a namespace-qualified identity', Boolean(first.namespace && first.name));
    check('a search entry has a download count', typeof first.downloadCount === 'number');
    check('a search entry has an icon url or is explicitly without one', 'files' in first);
  }

  const byCategory = await getJson(
    '/api/-/search?category=Programming%20Languages&size=2&sortBy=relevance',
  );
  check('search filters by category', byCategory.status === 200 && byCategory.body.extensions?.length > 0);

  // --- 3. Extension metadata --------------------------------------------
  const meta = await getJson(`/api/${SAMPLE.namespace}/${SAMPLE.name}`);
  check('extension metadata resolves', meta.status === 200 && meta.body.version);
  const files = meta.body.files ?? {};
  note(`metadata file keys: ${Object.keys(files).sort().join(', ')}`);
  check('metadata exposes a download url', typeof files.download === 'string');
  check('metadata exposes a published sha256 url', typeof files.sha256 === 'string');
  check('metadata exposes the manifest url', typeof files.manifest === 'string');
  check('metadata exposes readme and changelog urls', Boolean(files.readme && files.changelog));
  check('metadata reports engines', Boolean(meta.body.engines?.vscode), JSON.stringify(meta.body.engines));
  check('metadata reports categories', Array.isArray(meta.body.categories));
  check('metadata reports publisher identity', Boolean(meta.body.publishedBy?.loginName));
  check('metadata reports ratings', typeof meta.body.averageRating === 'number');
  check('metadata reports dependencies and bundled extensions as arrays',
    Array.isArray(meta.body.dependencies) && Array.isArray(meta.body.bundledExtensions));
  check('metadata says whether the publisher is verified', typeof meta.body.verified === 'boolean');
  check('metadata says whether the extension is deprecated', typeof meta.body.deprecated === 'boolean');

  const downloadHost = new URL(files.download).host;
  check('the download stays on the registry host', downloadHost === 'open-vsx.org', downloadHost);

  // --- 4. Version history + reviews + namespace -------------------------
  const versions = await getJson(`/api/${SAMPLE.namespace}/${SAMPLE.name}/versions?size=5&offset=0`);
  check(
    'version history is paginated',
    versions.status === 200 && typeof versions.body.totalSize === 'number',
    `totalSize=${versions.body.totalSize} returned=${Object.keys(versions.body.versions ?? {}).length}`,
  );
  const references = await getJson(
    `/api/${SAMPLE.namespace}/${SAMPLE.name}/version-references?size=3&offset=0`,
  );
  check(
    'version references carry per-version engines',
    references.status === 200 && Array.isArray(references.body.versions),
    references.body.versions?.[0] ? JSON.stringify(references.body.versions[0].engines) : '',
  );
  const reviews = await getJson(`/api/${SAMPLE.namespace}/${SAMPLE.name}/reviews`);
  check('reviews resolve', reviews.status === 200 && Array.isArray(reviews.body.reviews));
  if (reviews.body.reviews?.[0]) {
    note(`review keys: ${Object.keys(reviews.body.reviews[0]).sort().join(', ')}`);
  }
  const details = await getJson(`/api/${SAMPLE.namespace}/details`);
  check('publisher (namespace) details resolve', details.status === 200 && details.body.name === SAMPLE.namespace);

  // --- 5. The published digest ------------------------------------------
  const digest = await getFile(files.sha256, 'text/plain');
  check('the published digest downloads', digest.response.status === 200, `hops: ${digest.hops.join(' -> ')}`);
  note(`digest content type: ${digest.response.headers.get('content-type')}`);
  const digestText = (await digest.response.text()).trim();
  note(`digest literal: ${JSON.stringify(digestText.slice(0, 120))}`);
  const digestHex = /\b([0-9a-f]{64})\b/i.exec(digestText)?.[1]?.toLowerCase() ?? null;
  check('a 64-hex digest can be parsed from it', digestHex !== null, digestHex ?? '');

  // --- 6. The package itself --------------------------------------------
  const pkg = await getFile(files.download, 'application/octet-stream');
  check('the package downloads through the allowlist', pkg.response.status === 200, `hops: ${pkg.hops.join(' -> ')}`);
  note(`package content type: ${pkg.response.headers.get('content-type')}`);
  const declared = Number(pkg.response.headers.get('content-length'));
  const bytes = Buffer.from(await pkg.response.arrayBuffer());
  check('the declared length matches the transferred bytes', declared === bytes.length, `${declared} vs ${bytes.length}`);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  check('the package matches the published digest', actual === digestHex, actual);
  check('a redirect off the allowlist would be refused', await refusesForeignRedirect());
  const entries = readZipEntries(bytes);

  // --- 6b. What the signature chain actually offers ----------------------
  const keyUrl = new URL(files.publicKey);
  check(
    'the publisher key is served by the registry, not the CDN',
    keyUrl.host === 'open-vsx.org',
    keyUrl.host,
  );
  const key = await getFile(files.publicKey, 'text/plain');
  const keyText = await key.response.text();
  note(`public key first line: ${JSON.stringify(keyText.split('\n')[0])}`);
  let keyType = 'unparseable';
  try {
    keyType = crypto.createPublicKey(keyText).asymmetricKeyType ?? 'unknown';
  } catch (error) {
    keyType = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  note(`public key type: ${keyType}`);
  const signature = await getFile(files.signature, 'application/octet-stream');
  const signatureBytes = Buffer.from(await signature.response.arrayBuffer());
  note(`signature archive bytes: ${signatureBytes.length}`);
  try {
    const signatureEntries = readZipEntries(signatureBytes);
    note(`signature archive entries: ${signatureEntries.map((entry) => entry.name).join(', ')}`);
    const manifestEntry = signatureEntries.find((entry) => entry.name === '.signature.manifest');
    const sigEntry = signatureEntries.find((entry) => entry.name === '.signature.sig');
    if (manifestEntry && sigEntry) {
      const manifestBytes = inflateEntry(signatureBytes, manifestEntry);
      const sigBytes = inflateEntry(signatureBytes, sigEntry);
      note(`signature manifest bytes: ${manifestBytes.length}, sig bytes: ${sigBytes.length}`);
      note(`signature manifest head: ${JSON.stringify(manifestBytes.toString('utf8').slice(0, 260))}`);
      let parsed = null;
      try {
        parsed = JSON.parse(manifestBytes.toString('utf8'));
      } catch {
        parsed = null;
      }
      if (parsed) {
        note(`signature manifest keys: ${Object.keys(parsed).sort().join(', ')}`);
        const entryMap = parsed.entries ?? parsed.Entries ?? null;
        if (entryMap && typeof entryMap === 'object') {
          const sample = Object.entries(entryMap).slice(0, 2);
          note(`manifest entry sample: ${JSON.stringify(sample)}`);
          note(`manifest entry count: ${Object.keys(entryMap).length}`);
        }
      }
      // The signature manifest states the package digest independently of the
      // `.sha256` file. That agreement is verifiable right now and is what AXIOM
      // will enforce.
      const statedPackageDigest = parsed?.package?.digests?.sha256 ?? null;
      const statedHex = statedPackageDigest
        ? Buffer.from(statedPackageDigest, 'base64').toString('hex')
        : null;
      check(
        'the signature manifest states the same package digest',
        statedHex === digestHex,
        `${statedHex} vs ${digestHex}`,
      );
      check(
        'the signature manifest states the same package size',
        parsed?.package?.size === bytes.length,
        `${parsed?.package?.size} vs ${bytes.length}`,
      );
      // Per-entry digests are usable too: names are base64, digests are base64 sha256.
      const entryMap = parsed?.entries ?? {};
      const manifestName = Buffer.from('extension/package.json', 'utf8').toString('base64');
      const statedEntry = entryMap[manifestName];
      const packagedManifestBytes = inflateEntry(
        bytes,
        entries.find((entry) => entry.name === 'extension/package.json'),
      );
      check(
        'a per-entry digest from the signature manifest matches the packaged file',
        Boolean(statedEntry) &&
          Buffer.from(statedEntry.digests.sha256, 'base64').toString('hex') ===
            crypto.createHash('sha256').update(packagedManifestBytes).digest('hex'),
        statedEntry ? `size ${statedEntry.size} vs ${packagedManifestBytes.length}` : 'entry absent',
      );
      // Which envelope, if any, the 64-byte ed25519 signature covers. Recorded rather
      // than asserted: shipping a verifier that silently accepts everything would be
      // worse than admitting the envelope is not yet understood.
      const publicKey = crypto.createPublicKey(keyText);
      const manifestText = manifestBytes.toString('utf8');
      const candidates = {
        'raw manifest bytes': manifestBytes,
        'manifest utf8 re-encoded': Buffer.from(manifestText, 'utf8'),
        'manifest without trailing newline': Buffer.from(manifestText.replace(/\n$/, ''), 'utf8'),
        'sha256(manifest) raw': crypto.createHash('sha256').update(manifestBytes).digest(),
        'sha256(manifest) hex': Buffer.from(
          crypto.createHash('sha256').update(manifestBytes).digest('hex'),
          'utf8',
        ),
        'sha256(manifest) base64': Buffer.from(
          crypto.createHash('sha256').update(manifestBytes).digest('base64'),
          'utf8',
        ),
        'package digest base64': Buffer.from(statedPackageDigest ?? '', 'utf8'),
      };
      const matched = Object.entries(candidates)
        .filter(([, payload]) => {
          try {
            return crypto.verify(null, payload, publicKey, sigBytes);
          } catch {
            return false;
          }
        })
        .map(([label]) => label);
      note(
        matched.length > 0
          ? `ed25519 envelope verified over: ${matched.join(', ')}`
          : 'ed25519 envelope: none of the 7 candidate payloads verified — envelope format is not public, so AXIOM will report the signature as present-but-unverified rather than claim a check it did not perform',
      );
    }
  } catch (error) {
    note(`signature archive is not a readable zip: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --- 7. VSIX layout ---------------------------------------------------
  check('the VSIX is a readable zip', entries.length > 0, `${entries.length} entries`);
  const names = entries.map((entry) => entry.name);
  check(
    'the manifest lives at extension/package.json',
    names.includes('extension/package.json'),
    names.slice(0, 6).join(', '),
  );
  check('the VSIX carries its OPC manifest', names.includes('extension.vsixmanifest'));
  check(
    'no entry escapes the archive root',
    names.every((name) => !name.includes('..') && !name.startsWith('/') && !/^[a-zA-Z]:/.test(name)),
  );
  const methods = [...new Set(entries.map((entry) => entry.method))].sort();
  check('entries use store or deflate only', methods.every((m) => m === 0 || m === 8), `methods ${methods.join(',')}`);
  const manifestEntry = entries.find((entry) => entry.name === 'extension/package.json');
  const manifest = JSON.parse(inflateEntry(bytes, manifestEntry).toString('utf8'));
  check('the packaged manifest parses', typeof manifest.name === 'string');
  check(
    'the packaged manifest identifies publisher + name + version',
    Boolean(manifest.publisher && manifest.name && manifest.version),
    `${manifest.publisher}.${manifest.name}@${manifest.version}`,
  );
  check('the packaged manifest declares contributes', Boolean(manifest.contributes));
  note(`contribution points: ${Object.keys(manifest.contributes ?? {}).sort().join(', ')}`);
  note(`activation events: ${JSON.stringify(manifest.activationEvents ?? [])}`);
  note(`main entry: ${manifest.main ?? 'none'}`);
  const iconThemes = manifest.contributes?.iconThemes;
  check('this sample really does contribute icon themes', Array.isArray(iconThemes) && iconThemes.length > 0,
    `${iconThemes?.length ?? 0} themes`);

  // --- 8. A colour theme extension, since themes are the first target ---
  const themeMeta = await getJson('/api/dracula-theme/theme-dracula');
  check('a colour-theme extension resolves', themeMeta.status === 200);
  const themePackage = await getFile(themeMeta.body.files.download, 'application/octet-stream');
  const themeBytes = Buffer.from(await themePackage.response.arrayBuffer());
  const themeEntries = readZipEntries(themeBytes);
  const themeManifest = JSON.parse(
    inflateEntry(themeBytes, themeEntries.find((entry) => entry.name === 'extension/package.json')).toString('utf8'),
  );
  const themes = themeManifest.contributes?.themes ?? [];
  check('it contributes colour themes', themes.length > 0, JSON.stringify(themes[0] ?? {}));
  const themePath = themes[0]?.path?.replace(/^\.\//, '');
  const themeFile = themeEntries.find((entry) => entry.name === `extension/${themePath}`);
  check('the referenced theme file is inside the package', Boolean(themeFile), `extension/${themePath}`);
  if (themeFile) {
    const themeJson = JSON.parse(inflateEntry(themeBytes, themeFile).toString('utf8').replace(/^\uFEFF/, ''));
    check('the theme file exposes colors and tokenColors',
      Boolean(themeJson.colors) && Array.isArray(themeJson.tokenColors),
      `${Object.keys(themeJson.colors ?? {}).length} colors, ${themeJson.tokenColors?.length ?? 0} token rules`);
    note(`theme type: ${themeJson.type}`);
    note(`sample colors: ${Object.keys(themeJson.colors ?? {}).slice(0, 6).join(', ')}`);
  }

  out.push('', failures === 0 ? 'ALL PASS' : `FAILURES ${failures}`);
  fs.writeFileSync('openvsx-probe.txt', `${out.join('\n')}\n`, 'utf8');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  const cause = error instanceof Error && error.cause ? ` cause=${String(error.cause)}` : '';
  out.push(
    `FAIL  the probe itself threw  ${error instanceof Error ? error.message : String(error)}${cause}`,
  );
  if (error instanceof Error && error.stack) out.push(error.stack.split('\n').slice(0, 5).join('\n'));
  out.push('', 'FAILURES 1');
  fs.writeFileSync('openvsx-probe.txt', `${out.join('\n')}\n`, 'utf8');
  process.exitCode = 1;
});
