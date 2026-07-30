/**
 * Self-verification core (PRD Epoch H §131.4 / Phase 217). Pure interpretation of
 * verification command output: classify a command (typecheck / build / test / lint),
 * read its output into a pass/fail result with extracted failures, and decide
 * whether the agent may claim done or must iterate — with an HONEST summary (never a
 * false "done"). No I/O — the agent runs the command; this reads the result.
 * Smoke-tested.
 */
export type VerifyKind = 'typecheck' | 'build' | 'test' | 'lint' | 'command';

export interface VerifyResult {
  kind: VerifyKind;
  passed: boolean;
  summary: string;
  /** A few extracted failure lines (capped), for the honest report. */
  failures: string[];
}

/** Classify a shell command as a known verification kind, or a plain command. */
export function classifyCommand(command: string): VerifyKind {
  const c = command.toLowerCase();
  if (/\b(tsc|typecheck|type-check|tsc --noemit)\b/.test(c)) return 'typecheck';
  if (/\b(test|vitest|jest|mocha|pytest|cargo test|go test)\b/.test(c)) return 'test';
  if (/\b(lint|eslint|clippy|prettier)\b/.test(c)) return 'lint';
  if (/\b(build|compile|tsc -b|vite build|webpack|cargo build)\b/.test(c)) return 'build';
  return 'command';
}

function cap(lines: string[], n = 8): string[] {
  return lines
    .slice(0, n)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function parseTypecheckOutput(output: string): VerifyResult {
  const matches = output.match(/error TS\d+/g) ?? [];
  const count = matches.length;
  const failures = cap(output.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)));
  return {
    kind: 'typecheck',
    passed: count === 0,
    summary: count === 0 ? 'Typecheck passed (0 errors).' : `Typecheck FAILED — ${count} error(s).`,
    failures,
  };
}

export function parseBuildOutput(output: string): VerifyResult {
  const lower = output.toLowerCase();
  const hardFail =
    /\b(error|failed|cannot find|not assignable)\b/.test(lower) && !/0 errors?/.test(lower);
  const built = /built in|build complete|compiled successfully|✓/.test(lower);
  const passed = built && !hardFail;
  const failures = cap(output.split(/\r?\n/).filter((l) => /error|failed|cannot find/i.test(l)));
  return {
    kind: 'build',
    passed,
    summary: passed
      ? 'Build passed.'
      : hardFail
        ? 'Build FAILED — errors present.'
        : 'Build result unclear (no success marker).',
    failures,
  };
}

export function parseTestOutput(output: string): VerifyResult {
  // Common shapes: "N passed, M failed" | "Tests: M failed, N passed" | "N passing / M failing"
  const failedMatch =
    /(\d+)\s+fail(?:ed|ing|ures?)?/i.exec(output) ?? /fail(?:ed|ures?)?[:\s]+(\d+)/i.exec(output);
  const passedMatch =
    /(\d+)\s+pass(?:ed|ing)?/i.exec(output) ?? /pass(?:ed|ing)?[:\s]+(\d+)/i.exec(output);
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  const passedCount = passedMatch ? Number(passedMatch[1]) : 0;
  const hasFailWord = /\bFAIL\b|✕|✗|not ok/.test(output);
  const passed =
    failed === 0 && !hasFailWord && (passedCount > 0 || /\bPASS\b|✓|all tests/i.test(output));
  const failures = cap(output.split(/\r?\n/).filter((l) => /fail|✕|✗|not ok|Error/i.test(l)));
  return {
    kind: 'test',
    passed,
    summary: passed
      ? `Tests passed${passedCount > 0 ? ` (${passedCount})` : ''}.`
      : `Tests FAILED${failed > 0 ? ` (${failed} failing)` : ''}.`,
    failures,
  };
}

export function parseLintOutput(output: string): VerifyResult {
  const lower = output.toLowerCase();
  // A nonzero count of errors/problems/warnings means a failure.
  const problems = /[1-9]\d*\s+(?:errors?|problems?|warnings?)/.test(lower);
  const passed = !problems;
  return {
    kind: 'lint',
    passed,
    summary: passed ? 'Lint passed.' : 'Lint FAILED — problems reported.',
    failures: cap(output.split(/\r?\n/).filter((l) => /error|problem|warning/i.test(l))),
  };
}

/**
 * Interpret a verification command's output. Falls back to the exit code for plain
 * commands. NEVER reports a pass it cannot see (typecheck/test parse the output).
 */
export function interpretVerification(
  command: string,
  output: string,
  exitCode?: number,
): VerifyResult {
  const kind = classifyCommand(command);
  if (exitCode !== undefined && exitCode !== 0) {
    const label =
      kind === 'typecheck'
        ? 'Typecheck'
        : kind === 'build'
          ? 'Build'
          : kind === 'test'
            ? 'Tests'
            : kind === 'lint'
              ? 'Lint'
              : 'Command';
    return {
      kind,
      passed: false,
      summary: `${label} FAILED — command exited with code ${exitCode}.`,
      failures: cap(output.split(/\r?\n/).filter((line) => /error|fail|not ok/i.test(line))),
    };
  }
  switch (kind) {
    case 'typecheck':
      return parseTypecheckOutput(output);
    case 'build':
      return parseBuildOutput(output);
    case 'test':
      return parseTestOutput(output);
    case 'lint':
      return parseLintOutput(output);
    default: {
      const passed = exitCode === undefined ? !/\berror\b/i.test(output) : exitCode === 0;
      return {
        kind: 'command',
        passed,
        summary: passed
          ? 'Command succeeded.'
          : `Command failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}.`,
        failures: cap(output.split(/\r?\n/).filter((l) => /error|failed/i.test(l))),
      };
    }
  }
}

export interface IterateDecision {
  done: boolean;
  reason: string;
}

/**
 * Decide whether the agent may claim done: only when EVERY verification passed.
 * Otherwise it must iterate, and the reason names what failed (honest reporting).
 */
export function decideIterate(results: readonly VerifyResult[]): IterateDecision {
  if (results.length === 0) {
    return {
      done: false,
      reason: 'Nothing was verified — run tests/build/typecheck before claiming done.',
    };
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    return { done: true, reason: `All ${results.length} verification(s) passed.` };
  }
  return {
    done: false,
    reason: `Not done — ${failed.map((f) => f.kind).join(', ')} failed; iterate.`,
  };
}

/** An honest, human-readable verification report for the agent's final answer. */
export function buildVerifySummary(results: readonly VerifyResult[]): string {
  if (results.length === 0) return 'No verification was run.';
  const lines = results.map((r) => `${r.passed ? '✓' : '✗'} ${r.summary}`);
  const decision = decideIterate(results);
  return `Verification:\n${lines.join('\n')}\n${decision.done ? 'Verified.' : 'NOT fully verified — ' + decision.reason}`;
}
