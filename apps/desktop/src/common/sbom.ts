/**
 * SBOM (Software Bill of Materials) generator — PRD Epoch J §184/§190 / Phase 271.
 * Pure logic that turns a parsed package.json (plus an optional package-lock's
 * resolved versions) into a CycloneDX-ish JSON document: a metadata component for
 * the app + one `library` component per dependency, each with a package URL (purl)
 * and a bom-ref. No I/O — a Main/renderer caller reads the files and writes the
 * export; this only builds/serializes, so it is fully unit-testable.
 *
 * Scope (honest): this lists the direct dependencies from package.json and, when a
 * lockfile is supplied, the full resolved set. It is NOT a signed/attested SBOM and
 * does no vuln-DB lookup — those (and fuzzing/CI attestation) stay out of the sandbox.
 */

export type ComponentScope = 'required' | 'optional';

export interface SbomComponent {
  type: 'library';
  name: string;
  version: string;
  /** 'required' = production dependency; 'optional' = dev-only dependency. */
  scope: ComponentScope;
  /** Package URL, e.g. pkg:npm/react@18.3.1 (scoped names percent-encode the '@'). */
  purl: string;
  'bom-ref': string;
}

export interface Sbom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  metadata: {
    timestamp: string;
    tool: string;
    component: { type: 'application'; name: string; version: string };
  };
  components: SbomComponent[];
}

export interface SbomInput {
  name?: string;
  version?: string;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  /** Resolved exact versions by name (from a lockfile); overrides the range spec. */
  resolved?: Record<string, string>;
  /** Timestamp override (for deterministic output/tests). */
  timestamp?: string;
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Strip a semver range spec down to a bare version for the purl (best-effort). */
export function cleanVersion(spec: string): string {
  const s = spec.trim();
  // URL/git/file/workspace specs have no clean semver — keep them verbatim.
  if (/^(git|https?|file|link|npm|workspace):/i.test(s)) return s;
  const m = s.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  if (m) return m[1]!;
  const stripped = s.replace(/^[\^~>=<v\s]+/, '');
  return stripped.length > 0 ? stripped : s;
}

/** Build a package URL (purl) for an npm package (scoped names percent-encode '@'). */
export function npmPurl(name: string, version: string): string {
  const encName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return version.length > 0 ? `pkg:npm/${encName}@${version}` : `pkg:npm/${encName}`;
}

/**
 * Parse an npm lockfile into a name -> resolved-version map. Supports the v2/v3
 * `packages` map (keys like "node_modules/<name>") and the legacy v1 `dependencies`
 * tree. The root package (key "") is skipped.
 */
export function parseLockResolved(lock: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!lock || typeof lock !== 'object') return out;

  const pkgs = (lock as { packages?: Record<string, unknown> }).packages;
  if (pkgs && typeof pkgs === 'object') {
    const marker = 'node_modules/';
    for (const [path, meta] of Object.entries(pkgs)) {
      const idx = path.lastIndexOf(marker);
      if (idx < 0) continue; // skip the root package ("")
      const name = path.slice(idx + marker.length);
      if (name.length === 0) continue;
      const version =
        meta && typeof meta === 'object' ? (meta as { version?: unknown }).version : undefined;
      if (typeof version === 'string' && version.length > 0) out[name] = version;
    }
    return out;
  }

  const deps = (lock as { dependencies?: Record<string, unknown> }).dependencies;
  if (deps && typeof deps === 'object') {
    for (const [name, meta] of Object.entries(deps)) {
      const version =
        meta && typeof meta === 'object' ? (meta as { version?: unknown }).version : undefined;
      if (typeof version === 'string' && version.length > 0) out[name] = version;
    }
  }
  return out;
}

/** Build a CycloneDX-ish SBOM from a package.json (+ optional resolved versions). */
export function buildSbom(input: SbomInput): Sbom {
  const resolved = input.resolved ?? {};
  const prod = input.dependencies ?? {};
  const dev = input.devDependencies ?? {};
  const directDev = new Set(Object.keys(dev));
  const directProd = new Set(Object.keys(prod));

  const seen = new Set<string>();
  const components: SbomComponent[] = [];
  const addComponent = (name: string, version: string, scope: ComponentScope): void => {
    if (name.length === 0 || seen.has(name)) return;
    seen.add(name);
    const purl = npmPurl(name, version);
    components.push({ type: 'library', name, version, scope, purl, 'bom-ref': purl });
  };

  // 1) Direct production dependencies (required).
  for (const [name, spec] of Object.entries(prod)) {
    addComponent(name, resolved[name] ?? cleanVersion(strOf(spec)), 'required');
  }
  // 2) Direct dev dependencies (optional).
  for (const [name, spec] of Object.entries(dev)) {
    addComponent(name, resolved[name] ?? cleanVersion(strOf(spec)), 'optional');
  }
  // 3) Remaining resolved (transitive) packages from the lockfile.
  for (const [name, version] of Object.entries(resolved)) {
    const scope: ComponentScope =
      directDev.has(name) && !directProd.has(name) ? 'optional' : 'required';
    addComponent(name, version, scope);
  }

  components.sort((a, b) => a.name.localeCompare(b.name));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      timestamp: input.timestamp ?? new Date().toISOString(),
      tool: 'Axiom SBOM',
      component: {
        type: 'application',
        name: input.name && input.name.length > 0 ? input.name : 'application',
        version: input.version && input.version.length > 0 ? input.version : '0.0.0',
      },
    },
    components,
  };
}

export interface SbomSummary {
  total: number;
  required: number;
  optional: number;
}

/** Count components by scope. */
export function summarizeSbom(sbom: Sbom): SbomSummary {
  let required = 0;
  let optional = 0;
  for (const c of sbom.components) {
    if (c.scope === 'required') required++;
    else optional++;
  }
  return { total: sbom.components.length, required, optional };
}

/** Serialize the SBOM to pretty JSON for export. */
export function serializeSbom(sbom: Sbom): string {
  return JSON.stringify(sbom, null, 2);
}
