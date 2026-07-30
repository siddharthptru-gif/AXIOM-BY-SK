/**
 * Dependency license audit (Phase 271 depth — SAST/SCA gates: license compliance).
 *
 * PURE module (no I/O, no Electron). Classifies each dependency's SPDX license into
 * a risk CATEGORY, applies an allow / flag / deny POLICY, and rolls a dependency set
 * up into a compliance report. Complements the vulnerability/typosquat scanner
 * (common/depScan.ts) + SBOM (common/sbom.ts) with the license half of SCA.
 *
 * Handles SPDX expressions: `(MIT OR Apache-2.0)` resolves to the LEAST restrictive
 * operand (you may pick it), `(MIT AND GPL-3.0)` to the MOST restrictive (both bind).
 * Unknown/absent licenses are flagged, never silently allowed.
 */

export type LicenseCategory =
  | 'public-domain'
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'proprietary'
  | 'unknown';

export type LicenseAction = 'allow' | 'flag' | 'deny';

export interface DependencyLicense {
  name: string;
  version?: string;
  /** SPDX id or expression (e.g. 'MIT', '(MIT OR Apache-2.0)'), or '' when absent. */
  license: string;
}

export type LicensePolicy = Record<LicenseCategory, LicenseAction>;

/** Default policy: permissive/public-domain OK, copyleft flagged/denied, unknown flagged. */
export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  'public-domain': 'allow',
  permissive: 'allow',
  'weak-copyleft': 'flag',
  'strong-copyleft': 'deny',
  'network-copyleft': 'deny',
  proprietary: 'deny',
  unknown: 'flag',
};

/** Restrictiveness rank for resolving SPDX OR/AND expressions (higher = stricter). */
const RANK: Record<LicenseCategory, number> = {
  'public-domain': 0,
  permissive: 1,
  'weak-copyleft': 2,
  'strong-copyleft': 3,
  'network-copyleft': 4,
  proprietary: 5,
  unknown: 6,
};

const ALL_CATEGORIES: readonly LicenseCategory[] = [
  'public-domain',
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'proprietary',
  'unknown',
];

/** SPDX id (normalized upper-case, trailing `+` stripped) → category. */
const LICENSE_CATEGORY: Record<string, LicenseCategory> = {
  // Public domain / no-attribution.
  UNLICENSE: 'public-domain',
  'CC0-1.0': 'public-domain',
  '0BSD': 'public-domain',
  WTFPL: 'public-domain',
  // Permissive.
  MIT: 'permissive',
  'MIT-0': 'permissive',
  ISC: 'permissive',
  'APACHE-2.0': 'permissive',
  'BSD-2-CLAUSE': 'permissive',
  'BSD-3-CLAUSE': 'permissive',
  ZLIB: 'permissive',
  'PYTHON-2.0': 'permissive',
  'BSD-3-CLAUSE-CLEAR': 'permissive',
  'APACHE-1.1': 'permissive',
  // Weak copyleft (file/library-scoped).
  'LGPL-2.1': 'weak-copyleft',
  'LGPL-2.1-ONLY': 'weak-copyleft',
  'LGPL-3.0': 'weak-copyleft',
  'LGPL-3.0-ONLY': 'weak-copyleft',
  'MPL-2.0': 'weak-copyleft',
  'EPL-2.0': 'weak-copyleft',
  'EPL-1.0': 'weak-copyleft',
  'CDDL-1.0': 'weak-copyleft',
  // Strong copyleft.
  'GPL-2.0': 'strong-copyleft',
  'GPL-2.0-ONLY': 'strong-copyleft',
  'GPL-2.0-OR-LATER': 'strong-copyleft',
  'GPL-3.0': 'strong-copyleft',
  'GPL-3.0-ONLY': 'strong-copyleft',
  'GPL-3.0-OR-LATER': 'strong-copyleft',
  // Network copyleft.
  'AGPL-3.0': 'network-copyleft',
  'AGPL-3.0-ONLY': 'network-copyleft',
  'AGPL-3.0-OR-LATER': 'network-copyleft',
  // Proprietary / no OSS grant.
  UNLICENSED: 'proprietary',
  PROPRIETARY: 'proprietary',
  COMMERCIAL: 'proprietary',
};

function normalizeId(id: string): string {
  return id.trim().replace(/\+$/, '').toUpperCase();
}

function leastRestrictive(cats: readonly LicenseCategory[]): LicenseCategory {
  return cats.reduce((best, c) => (RANK[c] < RANK[best] ? c : best), cats[0] ?? 'unknown');
}

function mostRestrictive(cats: readonly LicenseCategory[]): LicenseCategory {
  return cats.reduce((worst, c) => (RANK[c] > RANK[worst] ? c : worst), cats[0] ?? 'unknown');
}

/**
 * Classify an SPDX license id or expression into a risk category. OR picks the
 * least-restrictive operand; AND picks the most-restrictive. Unknown ids → 'unknown'.
 */
export function classifyLicense(expr: string): LicenseCategory {
  const s = expr.trim();
  if (s.length === 0) return 'unknown';
  const cleaned = s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bOR\b/i.test(cleaned)) {
    return leastRestrictive(cleaned.split(/\bOR\b/i).map((t) => classifyLicense(t)));
  }
  if (/\bAND\b/i.test(cleaned)) {
    return mostRestrictive(cleaned.split(/\bAND\b/i).map((t) => classifyLicense(t)));
  }
  return LICENSE_CATEGORY[normalizeId(cleaned)] ?? 'unknown';
}

export interface LicenseFinding extends DependencyLicense {
  category: LicenseCategory;
  action: LicenseAction;
}

export interface LicenseReport {
  results: LicenseFinding[];
  allowed: number;
  flagged: LicenseFinding[];
  denied: LicenseFinding[];
  unknownCount: number;
  byCategory: Record<LicenseCategory, number>;
  /** True when nothing is denied (policy-compliant). */
  ok: boolean;
  summary: string;
}

/** Evaluate one dependency's license against the policy. */
export function evaluateLicense(
  dep: DependencyLicense,
  policy: LicensePolicy = DEFAULT_LICENSE_POLICY,
): LicenseFinding {
  const category = classifyLicense(dep.license);
  return { ...dep, category, action: policy[category] };
}

/** Evaluate a set of dependency licenses into a compliance report. */
export function evaluateLicenses(
  deps: readonly DependencyLicense[],
  policy: LicensePolicy = DEFAULT_LICENSE_POLICY,
): LicenseReport {
  const results = deps.map((d) => evaluateLicense(d, policy));
  const byCategory: Record<LicenseCategory, number> = {
    'public-domain': 0,
    permissive: 0,
    'weak-copyleft': 0,
    'strong-copyleft': 0,
    'network-copyleft': 0,
    proprietary: 0,
    unknown: 0,
  };
  let allowed = 0;
  const flagged: LicenseFinding[] = [];
  const denied: LicenseFinding[] = [];
  for (const r of results) {
    byCategory[r.category] += 1;
    if (r.action === 'allow') allowed += 1;
    else if (r.action === 'flag') flagged.push(r);
    else denied.push(r);
  }
  const unknownCount = byCategory.unknown;
  const ok = denied.length === 0;
  const summary =
    results.length === 0
      ? 'No dependencies to audit.'
      : `${results.length} dep(s): ${allowed} allowed, ${flagged.length} flagged, ` +
        `${denied.length} denied${unknownCount > 0 ? `, ${unknownCount} unknown-license` : ''}.`;
  return { results, allowed, flagged, denied, unknownCount, byCategory, ok, summary };
}

/** Distinct categories present, most-restrictive first (for a compact readout). */
export function categoriesPresent(report: LicenseReport): LicenseCategory[] {
  return [...ALL_CATEGORIES]
    .filter((c) => report.byCategory[c] > 0)
    .sort((a, b) => RANK[b] - RANK[a]);
}
