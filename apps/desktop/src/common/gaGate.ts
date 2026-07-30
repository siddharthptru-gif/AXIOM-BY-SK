/**
 * GA readiness gate (Phase 274 — Penetration Test & Remediation / GA Gate).
 *
 * PURE module (no I/O, no Electron). Aggregates release-readiness CHECKS across
 * categories (tests, security, performance, accessibility, stability, docs) into a
 * single GA verdict: any failing BLOCKER → no-go; any non-blocking fail/warn →
 * conditional; otherwise go. The real pen-test + CI runs feed the check statuses
 * (out of the sandbox); this is the honest go/no-go adjudicator + report.
 * Deterministic.
 */

export type GaCategory =
  'tests' | 'security' | 'performance' | 'accessibility' | 'stability' | 'docs';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export type GaVerdict = 'go' | 'conditional' | 'no-go';

export interface GaCheck {
  category: GaCategory;
  label: string;
  status: CheckStatus;
  /** A failing blocker forces no-go (default true for security/tests, else false). */
  blocker?: boolean;
  detail?: string;
}

export interface GaGateResult {
  verdict: GaVerdict;
  blockers: GaCheck[];
  warnings: GaCheck[];
  /** Blocker-category checks that were skipped — they prevent a clean "go". */
  skippedBlockers: GaCheck[];
  passed: number;
  /** Checks with a real status (not 'skip'). */
  evaluated: number;
  skipped: number;
  total: number;
  byCategory: Record<GaCategory, { pass: number; fail: number; warn: number; skip: number }>;
  summary: string;
}

const DEFAULT_BLOCKER: Record<GaCategory, boolean> = {
  tests: true,
  security: true,
  performance: false,
  accessibility: false,
  stability: true,
  docs: false,
};

function isBlocker(c: GaCheck): boolean {
  return c.blocker ?? DEFAULT_BLOCKER[c.category];
}

function emptyByCategory(): GaGateResult['byCategory'] {
  const mk = (): { pass: number; fail: number; warn: number; skip: number } => ({
    pass: 0,
    fail: 0,
    warn: 0,
    skip: 0,
  });
  return {
    tests: mk(),
    security: mk(),
    performance: mk(),
    accessibility: mk(),
    stability: mk(),
    docs: mk(),
  };
}

/** Adjudicate a set of GA-readiness checks into a go / conditional / no-go verdict. */
export function evaluateGaGate(checks: readonly GaCheck[]): GaGateResult {
  const byCategory = emptyByCategory();
  const blockers: GaCheck[] = [];
  const warnings: GaCheck[] = [];
  const skippedBlockers: GaCheck[] = [];
  let passed = 0;
  let skipped = 0;
  for (const c of checks) {
    byCategory[c.category][c.status] += 1;
    if (c.status === 'skip') {
      skipped += 1;
      // An unevaluated blocker cannot be silently treated as ready.
      if (isBlocker(c)) skippedBlockers.push(c);
      continue;
    }
    if (c.status === 'pass') {
      passed += 1;
      continue;
    }
    // fail or warn
    if (c.status === 'fail' && isBlocker(c)) blockers.push(c);
    else warnings.push(c);
  }
  const total = checks.length;
  const evaluated = total - skipped;

  // Zero evaluated checks cannot certify readiness; a failing blocker forces no-go.
  // An unevaluated blocker or any non-blocking fail/warn can be at most conditional.
  const verdict: GaVerdict =
    evaluated === 0 || blockers.length > 0
      ? 'no-go'
      : warnings.length > 0 || skippedBlockers.length > 0
        ? 'conditional'
        : 'go';

  const summary =
    total === 0
      ? 'GA gate: no checks — cannot assess readiness.'
      : evaluated === 0
        ? `GA gate: NO-GO — 0/${total} checks evaluated (all skipped); run the audits first.`
        : `GA gate: ${verdict.toUpperCase()} — ${passed}/${evaluated} evaluated passed` +
          (blockers.length > 0 ? `, ${blockers.length} blocker(s)` : '') +
          (skippedBlockers.length > 0 ? `, ${skippedBlockers.length} blocker(s) unevaluated` : '') +
          (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '') +
          '.';
  return {
    verdict,
    blockers,
    warnings,
    skippedBlockers,
    passed,
    evaluated,
    skipped,
    total,
    byCategory,
    summary,
  };
}

/** True when the release is clear to ship (verdict === 'go'). */
export function isReleaseReady(result: GaGateResult): boolean {
  return result.verdict === 'go';
}
