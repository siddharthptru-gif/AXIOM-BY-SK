/**
 * Dependency / SCA scanner (PRD Epoch J §184/§190 / Phase 271). Pure analysis of a
 * package.json dependency map: flag unpinned/wildcard versions, insecure install
 * protocols (git/http/file), deprecation markers, and likely TYPOSQUATS of popular
 * packages (edit-distance ≤ 1, not an exact match). Returns severity-tagged findings.
 * No I/O — the Security panel reads package.json + renders these. Smoke-tested.
 * (Full SBOM + live vuln-DB lookups + fuzzing are out of the in-app scope.)
 */
export type DepSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DepFinding {
  name: string;
  version: string;
  severity: DepSeverity;
  reason: string;
}

/** A small allow-list of very popular packages typosquats are measured against. */
export const POPULAR_PACKAGES: readonly string[] = [
  'react',
  'react-dom',
  'express',
  'lodash',
  'axios',
  'chalk',
  'commander',
  'debug',
  'moment',
  'request',
  'vue',
  'webpack',
  'typescript',
  'eslint',
  'prettier',
  'jest',
  'next',
  'dotenv',
  'uuid',
  'classnames',
  'redux',
  'rxjs',
  'zod',
  'vite',
];

/** Levenshtein edit distance (bounded use — small package names). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3; // early out: too far to matter
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

/** Whether a package name looks like a typosquat of a popular package (≤1 edit, not exact). */
export function typosquatOf(name: string): string | null {
  const lc = name.toLowerCase();
  if ((POPULAR_PACKAGES as readonly string[]).includes(lc)) return null;
  for (const p of POPULAR_PACKAGES) {
    if (Math.abs(p.length - lc.length) <= 1 && editDistance(lc, p) <= 1) return p;
  }
  return null;
}

/** Classify a single dependency's version spec + name into findings. */
export function checkDependency(
  name: string,
  version: string,
  opts: { deprecated?: boolean } = {},
): DepFinding[] {
  const findings: DepFinding[] = [];
  const v = version.trim();

  if (v === '*' || v === 'latest' || v === '' || v === 'x') {
    findings.push({
      name,
      version,
      severity: 'high',
      reason: 'Unpinned version (wildcard/latest) — non-reproducible + supply-chain risk.',
    });
  }
  if (/^(git\+|git:|https?:)/i.test(v)) {
    findings.push({
      name,
      version,
      severity: 'high',
      reason: 'Installs from a git/http URL rather than the registry.',
    });
  }
  if (/^(file:|link:)/i.test(v)) {
    findings.push({ name, version, severity: 'medium', reason: 'Local file/link dependency.' });
  }
  if (opts.deprecated) {
    findings.push({ name, version, severity: 'medium', reason: 'Marked deprecated.' });
  }
  const squat = typosquatOf(name);
  if (squat) {
    findings.push({
      name,
      version,
      severity: 'critical',
      reason: `Possible typosquat of "${squat}" — verify the package name.`,
    });
  }
  return findings;
}

export interface DepScanInput {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  /** Optional set of names known to be deprecated (from a lockfile/registry). */
  deprecated?: readonly string[];
}

const SEV_RANK: Record<DepSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Scan a parsed package.json for risky dependencies. */
export function scanDependencies(pkg: DepScanInput): DepFinding[] {
  const deprecated = new Set((pkg.deprecated ?? []).map((s) => s.toLowerCase()));
  const findings: DepFinding[] = [];
  const scan = (map: Record<string, unknown> | undefined): void => {
    if (!map) return;
    for (const [name, ver] of Object.entries(map)) {
      const version = typeof ver === 'string' ? ver : '';
      findings.push(
        ...checkDependency(name, version, { deprecated: deprecated.has(name.toLowerCase()) }),
      );
    }
  };
  scan(pkg.dependencies);
  scan(pkg.devDependencies);
  return findings.sort(
    (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.name.localeCompare(b.name),
  );
}

export interface DepSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export function summarizeDeps(findings: readonly DepFinding[]): DepSummary {
  const s: DepSummary = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) s[f.severity]++;
  return s;
}
