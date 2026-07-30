/**
 * SAST rule pack (PRD Epoch J §190 / Phase 271). A pure, regex-based static-analysis
 * pass over source text for common code-security smells — SQL/command injection,
 * dynamic code execution, weak crypto, DOM XSS sinks, and disabled TLS verification.
 * It complements the Electron/config hardening in common/securityFitness (which
 * covers eval / dangerouslySetInnerHTML / egress) without duplicating it. No I/O —
 * the Security panel runs it over the active file. Heuristic (line-scoped regex), so
 * it flags candidates for review, not proven vulnerabilities. Smoke-tested.
 */

export type SastSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SastCategory = 'injection' | 'code-exec' | 'crypto' | 'xss' | 'tls';

export interface SastRule {
  id: string;
  label: string;
  category: SastCategory;
  severity: SastSeverity;
  re: RegExp;
  recommendation: string;
}

export const SAST_RULES: readonly SastRule[] = [
  {
    id: 'sql-concat',
    label: 'SQL built with string concatenation',
    category: 'injection',
    severity: 'high',
    re: /\b(?:query|execute|raw)\s*\(\s*['"`][^'"`]*['"`]\s*\+/,
    recommendation: 'Use parameterized queries / prepared statements instead of concatenation.',
  },
  {
    id: 'sql-template',
    label: 'SQL built with template interpolation',
    category: 'injection',
    severity: 'high',
    re: /\b(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/,
    recommendation: 'Use parameter placeholders; never interpolate untrusted values into SQL.',
  },
  {
    id: 'command-injection',
    label: 'Shell command built from a variable',
    category: 'code-exec',
    severity: 'critical',
    re: /\b(?:exec|execSync|spawn|spawnSync)\s*\([^)]*(?:\+|\$\{)/,
    recommendation: 'Avoid shell string building; pass args as an array and validate input.',
  },
  {
    id: 'new-function',
    label: 'Dynamic code via new Function()',
    category: 'code-exec',
    severity: 'high',
    re: /\bnew\s+Function\s*\(/,
    recommendation: 'Avoid constructing code at runtime from strings.',
  },
  {
    id: 'settimeout-string',
    label: 'String argument to setTimeout/setInterval',
    category: 'code-exec',
    severity: 'medium',
    re: /\bset(?:Timeout|Interval)\s*\(\s*['"]/,
    recommendation: 'Pass a function, not a string (a string is eval-like).',
  },
  {
    id: 'weak-hash',
    label: 'Weak hash algorithm (MD5/SHA-1)',
    category: 'crypto',
    severity: 'medium',
    re: /createHash\s*\(\s*['"](?:md5|sha1)['"]/i,
    recommendation: 'Use SHA-256+ for integrity; use bcrypt/scrypt/argon2 for passwords.',
  },
  {
    id: 'insecure-random',
    label: 'Math.random() (not cryptographically secure)',
    category: 'crypto',
    severity: 'low',
    re: /Math\.random\s*\(/,
    recommendation: 'For tokens/secrets use crypto.randomBytes / crypto.getRandomValues.',
  },
  {
    id: 'tls-reject-disabled',
    label: 'TLS certificate verification disabled',
    category: 'tls',
    severity: 'high',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
    recommendation: 'Never disable TLS verification; fix the certificate chain instead.',
  },
  {
    id: 'inner-html-assign',
    label: 'Direct innerHTML assignment (DOM XSS sink)',
    category: 'xss',
    severity: 'high',
    re: /\.innerHTML\s*=(?!=)/,
    recommendation: 'Set textContent, or sanitize HTML before assigning.',
  },
  {
    id: 'document-write',
    label: 'document.write()',
    category: 'xss',
    severity: 'medium',
    re: /document\.write(?:ln)?\s*\(/,
    recommendation: 'Avoid document.write; build DOM nodes or use safe templating.',
  },
];

export interface SastFinding {
  id: string;
  label: string;
  category: SastCategory;
  severity: SastSeverity;
  line: number;
  column: number;
  snippet: string;
  recommendation: string;
}

const SEV_RANK: Record<SastSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Scan source text with the SAST rule pack; returns line-scoped findings (sorted). */
export function scanSast(source: string, rules: readonly SastRule[] = SAST_RULES): SastFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: SastFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) {
        findings.push({
          id: rule.id,
          label: rule.label,
          category: rule.category,
          severity: rule.severity,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          snippet: line.trim().slice(0, 120),
          recommendation: rule.recommendation,
        });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

export interface SastSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  byCategory: Record<SastCategory, number>;
  pass: boolean;
}

/** Summarize a SAST run (pass = zero findings). */
export function summarizeSast(findings: readonly SastFinding[]): SastSummary {
  const byCategory: Record<SastCategory, number> = {
    injection: 0,
    'code-exec': 0,
    crypto: 0,
    xss: 0,
    tls: 0,
  };
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    byCategory[f.category] += 1;
    if (f.severity === 'critical') critical += 1;
    else if (f.severity === 'high') high += 1;
    else if (f.severity === 'medium') medium += 1;
    else low += 1;
  }
  return {
    total: findings.length,
    critical,
    high,
    medium,
    low,
    byCategory,
    pass: findings.length === 0,
  };
}
