/**
 * Security fitness functions (PRD Epoch J §190 / Phase 270). Pure invariant checks
 * over source/config text — the renderer must not import secrets, hardening flags
 * must stay on (contextIsolation/sandbox, no nodeIntegration), no `dangerouslySet
 * InnerHTML`/`eval`, no plain-HTTP egress to non-loopback hosts. Returns line-scoped
 * violations. The Security panel runs these in-app; a CI gate would run the same
 * checks over the tree (out of the in-app scope → 270 partial). Smoke-tested.
 */
export type FitnessSeverity = 'critical' | 'high' | 'medium';

export interface FitnessCheck {
  id: string;
  label: string;
  severity: FitnessSeverity;
  re: RegExp;
}

export const FITNESS_CHECKS: readonly FitnessCheck[] = [
  {
    id: 'renderer-imports-secret',
    label: 'Renderer imports the secret store',
    severity: 'critical',
    re: /\bfrom\s+['"][^'"]*(?:secrets|authStore|secretsService)['"]/,
  },
  {
    id: 'electron-remote',
    label: 'Uses @electron/remote',
    severity: 'high',
    re: /@electron\/remote|\bremote\s*:\s*require/,
  },
  {
    id: 'node-integration-on',
    label: 'nodeIntegration: true',
    severity: 'critical',
    re: /nodeIntegration\s*:\s*true/,
  },
  {
    id: 'context-isolation-off',
    label: 'contextIsolation: false',
    severity: 'critical',
    re: /contextIsolation\s*:\s*false/,
  },
  {
    id: 'sandbox-off',
    label: 'sandbox: false',
    severity: 'high',
    re: /sandbox\s*:\s*false/,
  },
  {
    id: 'dangerous-html',
    label: 'dangerouslySetInnerHTML',
    severity: 'high',
    re: /dangerouslySetInnerHTML/,
  },
  { id: 'eval', label: 'Use of eval()', severity: 'medium', re: /\beval\s*\(/ },
  {
    id: 'insecure-egress',
    label: 'Plain-HTTP egress to a non-loopback host',
    severity: 'high',
    re: /\bhttp:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/i,
  },
];

export interface FitnessFinding {
  id: string;
  label: string;
  severity: FitnessSeverity;
  line: number;
  snippet: string;
}

const SEV_RANK: Record<FitnessSeverity, number> = { medium: 0, high: 1, critical: 2 };

/** Run the fitness checks over source text; returns line-scoped violations (sorted). */
export function runFitnessChecks(source: string): FitnessFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: FitnessFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const check of FITNESS_CHECKS) {
      if (check.re.test(line)) {
        findings.push({
          id: check.id,
          label: check.label,
          severity: check.severity,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

export interface FitnessSummary {
  checks: number;
  violations: number;
  critical: number;
  high: number;
  medium: number;
  pass: boolean;
}

/** Summarize a fitness run (pass = zero violations). */
export function summarizeFitness(findings: readonly FitnessFinding[]): FitnessSummary {
  let critical = 0;
  let high = 0;
  let medium = 0;
  for (const f of findings) {
    if (f.severity === 'critical') critical++;
    else if (f.severity === 'high') high++;
    else medium++;
  }
  return {
    checks: FITNESS_CHECKS.length,
    violations: findings.length,
    critical,
    high,
    medium,
    pass: findings.length === 0,
  };
}
