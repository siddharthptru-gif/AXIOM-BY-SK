/**
 * Secret scanner (PRD Epoch J §184/§190 / Phase 271). Pure detection of secret-
 * shaped strings and a few risky code patterns, line-scoped, with REDACTED previews
 * (a finding never echoes the full secret). The renderer/command surfaces findings.
 * No I/O. NOTE: this is a lightweight local scanner — full SAST/SCA/fuzzing gates in
 * CI are out of scope. Smoke-tested.
 */
export type Severity = 'critical' | 'high' | 'medium';

export interface SecretPattern {
  id: string;
  label: string;
  re: RegExp;
  severity: Severity;
}

/** Known credential shapes. Patterns are global+multiline-safe (used per line). */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'aws-access-key',
    label: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    severity: 'critical',
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    re: /\bghp_[A-Za-z0-9]{36}\b/,
    severity: 'critical',
  },
  {
    id: 'openai-key',
    label: 'OpenAI API key',
    re: /\bsk-[A-Za-z0-9]{20,}\b/,
    severity: 'critical',
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: 'high',
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    severity: 'high',
  },
  {
    id: 'private-key',
    label: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    severity: 'critical',
  },
  {
    id: 'generic-assignment',
    label: 'Hard-coded secret assignment',
    // e.g. api_key = "abcdefghijklmnop..." / password: 'longvalue'
    re: /\b(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    severity: 'high',
  },
];

/** A few risky code patterns worth flagging (not secrets, but security-relevant). */
export const RISKY_PATTERNS: readonly SecretPattern[] = [
  { id: 'eval', label: 'Use of eval()', re: /\beval\s*\(/, severity: 'medium' },
  {
    id: 'exec-interp',
    label: 'Shell exec with interpolation',
    re: /\bexec(?:Sync)?\s*\(\s*[`'"][^`'"]*\$\{/,
    severity: 'medium',
  },
];

export interface SecretFinding {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  patternId: string;
  label: string;
  severity: Severity;
  /** The matched text, redacted (never the full secret). */
  preview: string;
}

/** Redact a matched secret: keep a few edge chars, mask the middle. */
export function redactSecret(match: string): string {
  const s = match.trim();
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

const SEVERITY_RANK: Record<Severity, number> = { medium: 0, high: 1, critical: 2 };

/**
 * Scan text for secrets (and, when `includeRisky`, risky code patterns). Returns
 * findings sorted by line then severity. Only the FIRST match per pattern per line
 * is reported (avoids noise), with a redacted preview.
 */
export function scanForSecrets(text: string, includeRisky = true): SecretFinding[] {
  const patterns = includeRisky ? [...SECRET_PATTERNS, ...RISKY_PATTERNS] : SECRET_PATTERNS;
  const lines = text.split(/\r?\n/);
  const findings: SecretFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m) {
        findings.push({
          line: i + 1,
          column: (m.index ?? 0) + 1,
          patternId: p.id,
          label: p.label,
          severity: p.severity,
          preview: redactSecret(m[0]),
        });
      }
    }
  }
  return findings.sort(
    (a, b) => a.line - b.line || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

/** Count findings by severity for a summary. */
export function summarizeFindings(findings: readonly SecretFinding[]): {
  total: number;
  critical: number;
  high: number;
  medium: number;
} {
  let critical = 0;
  let high = 0;
  let medium = 0;
  for (const f of findings) {
    if (f.severity === 'critical') critical++;
    else if (f.severity === 'high') high++;
    else medium++;
  }
  return { total: findings.length, critical, high, medium };
}
