/**
 * AI safety layer (Phase 170 — AI Safety & Guardrails).
 *
 * PURE module (no I/O, no Electron). Two defensive jobs for the AI pipeline:
 *
 *   1. INBOUND (untrusted context): detect prompt-injection / jailbreak attempts
 *      hidden in retrieved code, tool output, web-fetch results, or MCP responses
 *      — the classic "indirect prompt injection" vector — so the caller can flag
 *      or quarantine that context before it reaches the model.
 *
 *   2. OUTBOUND (egress): detect + optionally REDACT secrets (API keys, private
 *      keys, tokens) and PII (emails, phones, SSNs, card numbers) so they don't
 *      leak to a third-party model provider or into logs. Raw secret values are
 *      NEVER echoed back in findings — only a masked preview.
 *
 * It is heuristic (regex + rules), so it complements, but does not replace, the
 * repo-wide secret scanner (Epoch J) and provider-side moderation. The design is
 * deliberately non-destructive: detection is always available; redaction is opt-in
 * (a policy flag) so a user's own code that they *want* to send is never silently
 * mangled.
 */

export type SafetySeverity = 'low' | 'medium' | 'high';
export type ReportSeverity = 'none' | SafetySeverity;
export type SafetyCategory = 'prompt-injection' | 'jailbreak' | 'secret' | 'pii';

export interface SafetyFinding {
  category: SafetyCategory;
  severity: SafetySeverity;
  ruleId: string;
  message: string;
  /** Character offset of the match start in the scanned text. */
  index: number;
  /** A SAFE preview of the match — secrets/PII are masked, never echoed raw. */
  preview: string;
}

export interface SafetyReport {
  findings: SafetyFinding[];
  severity: ReportSeverity;
  counts: Record<SafetyCategory, number>;
  summary: string;
}

export type SafetyAction = 'allow' | 'sanitize' | 'block';

export interface SafetyDecision {
  action: SafetyAction;
  /** The text to actually send (redacted when action === 'sanitize'). */
  text: string;
  findings: SafetyFinding[];
  /** How many spans were redacted (0 unless sanitized). */
  redactions: number;
  summary: string;
}

interface Rule {
  ruleId: string;
  category: SafetyCategory;
  severity: SafetySeverity;
  pattern: RegExp;
  message: string;
}

// ---- rule packs -------------------------------------------------------------

/** Prompt-injection / jailbreak heuristics (case-insensitive). */
export const INJECTION_RULES: readonly Rule[] = [
  {
    ruleId: 'ignore-previous',
    category: 'prompt-injection',
    severity: 'high',
    pattern:
      /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|instructions|prompt|prompts|context|rules|message)/i,
    message: 'Attempt to override prior instructions.',
  },
  {
    ruleId: 'reveal-system-prompt',
    category: 'prompt-injection',
    severity: 'high',
    pattern:
      /\b(reveal|show|print|repeat|output|leak)\b[^.\n]{0,30}\b(system|initial|hidden|developer)\b[^.\n]{0,15}\b(prompt|message|instruction|instructions)/i,
    message: 'Attempt to exfiltrate the system prompt.',
  },
  {
    ruleId: 'role-override',
    category: 'jailbreak',
    severity: 'high',
    pattern:
      /\byou are now\b[^.\n]{0,40}\b(dan|do anything now|unrestricted|jailbroken|unbound|no longer bound|a different (ai|assistant|model))/i,
    message: 'Role-override / persona-hijack attempt.',
  },
  {
    ruleId: 'jailbreak-keyword',
    category: 'jailbreak',
    severity: 'medium',
    pattern: /\b(jailbreak|do anything now|developer mode enabled|dan mode)\b/i,
    message: 'Known jailbreak phrasing.',
  },
  {
    ruleId: 'bypass-guardrails',
    category: 'jailbreak',
    severity: 'high',
    pattern:
      /\b(bypass|override|disable|turn off|remove)\b[^.\n]{0,25}\b(safety|guardrail|guardrails|filter|filters|restriction|restrictions|content policy|policies)/i,
    message: 'Attempt to disable safety guardrails.',
  },
  {
    ruleId: 'ignore-guidelines',
    category: 'jailbreak',
    severity: 'medium',
    pattern:
      /\b(do not|don't|never)\b[^.\n]{0,20}\b(follow|obey|adhere to)\b[^.\n]{0,25}\b(guideline|guidelines|policy|policies|rules|safety)/i,
    message: 'Instruction to ignore guidelines.',
  },
  {
    ruleId: 'smuggled-directive',
    category: 'prompt-injection',
    severity: 'medium',
    pattern:
      /(?:^|\n)\s*(?:\[{1,2}\/?system\]{1,2}|<\|?(?:system|im_start)\|?>|###\s*(?:system|instruction))/i,
    message: 'Smuggled role/instruction delimiter in content.',
  },
];

/** Secret / credential patterns. */
export const SECRET_RULES: readonly Rule[] = [
  {
    ruleId: 'private-key',
    category: 'secret',
    severity: 'high',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    message: 'Private key block.',
  },
  {
    ruleId: 'aws-access-key',
    category: 'secret',
    severity: 'high',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    message: 'AWS access key id.',
  },
  {
    ruleId: 'openai-key',
    category: 'secret',
    severity: 'high',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    message: 'OpenAI-style secret key.',
  },
  {
    ruleId: 'github-token',
    category: 'secret',
    severity: 'high',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    message: 'GitHub token.',
  },
  {
    ruleId: 'slack-token',
    category: 'secret',
    severity: 'high',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: 'Slack token.',
  },
  {
    ruleId: 'google-api-key',
    category: 'secret',
    severity: 'high',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: 'Google API key.',
  },
  {
    ruleId: 'jwt',
    category: 'secret',
    severity: 'medium',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    message: 'JSON Web Token.',
  },
  {
    ruleId: 'generic-secret-assignment',
    category: 'secret',
    severity: 'medium',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}["']?/i,
    message: 'Hard-coded credential assignment.',
  },
];

/** PII patterns. `credit-card` is Luhn-validated to cut false positives. */
export const PII_RULES: readonly Rule[] = [
  {
    ruleId: 'email',
    category: 'pii',
    severity: 'low',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    message: 'Email address.',
  },
  {
    ruleId: 'ssn',
    category: 'pii',
    severity: 'high',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    message: 'US Social Security number.',
  },
  {
    ruleId: 'phone',
    category: 'pii',
    severity: 'low',
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    message: 'Phone number.',
  },
  {
    ruleId: 'credit-card',
    category: 'pii',
    severity: 'medium',
    pattern: /\b(?:\d[ -]?){13,19}\b/,
    message: 'Payment card number.',
  },
];

// ---- helpers ----------------------------------------------------------------

const SEVERITY_RANK: Record<SafetySeverity, number> = { low: 1, medium: 2, high: 3 };

/** Luhn checksum — used to validate candidate card numbers. */
export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Mask a matched span so a raw secret / PII value is never echoed. */
function maskPreview(raw: string, category: SafetyCategory): string {
  if (category === 'secret' || category === 'pii') {
    const head = raw.slice(0, 2);
    const stars = '*'.repeat(Math.max(3, Math.min(8, raw.length - 2)));
    return `${head}${stars}`;
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}\u2026` : collapsed;
}

interface Span {
  rule: Rule;
  start: number;
  end: number;
  raw: string;
}

/** Find every rule match in `text` (with Luhn gating for card numbers). */
function findSpans(text: string, rules: readonly Rule[]): Span[] {
  const spans: Span[] = [];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const re = new RegExp(rule.pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      if (raw.length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (rule.ruleId === 'credit-card' && !luhnValid(raw)) continue;
      spans.push({ rule, start: m.index, end: m.index + raw.length, raw });
    }
  }
  return spans;
}

function spanToFinding(span: Span): SafetyFinding {
  return {
    category: span.rule.category,
    severity: span.rule.severity,
    ruleId: span.rule.ruleId,
    message: span.rule.message,
    index: span.start,
    preview: maskPreview(span.raw, span.rule.category),
  };
}

function scanWith(text: string, rules: readonly Rule[]): SafetyFinding[] {
  return findSpans(text, rules)
    .map(spanToFinding)
    .sort((a, b) => a.index - b.index || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

// ---- detectors --------------------------------------------------------------

/** Detect prompt-injection / jailbreak attempts (for untrusted context). */
export function detectInjection(text: string): SafetyFinding[] {
  return scanWith(text, INJECTION_RULES);
}

/** Detect secrets / credentials. */
export function detectSecrets(text: string): SafetyFinding[] {
  return scanWith(text, SECRET_RULES);
}

/** Detect PII. */
export function detectPii(text: string): SafetyFinding[] {
  return scanWith(text, PII_RULES);
}

// ---- redaction --------------------------------------------------------------

export interface RedactionResult {
  text: string;
  findings: SafetyFinding[];
  redactions: number;
}

/**
 * Redact every match of `rules` from `text`, replacing each with
 * `[REDACTED:<category>]`. Overlapping matches are resolved by keeping the
 * earliest-starting, longest span. Non-destructive to non-matching text.
 */
export function redact(text: string, rules: readonly Rule[]): RedactionResult {
  const spans = findSpans(text, rules).sort((a, b) => a.start - b.start || b.end - a.end);
  // Keep non-overlapping spans (earliest start wins; longer wins on tie).
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      kept.push(s);
      lastEnd = s.end;
    }
  }
  // Replace from the end so earlier indices stay valid.
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const s = kept[i]!;
    out = `${out.slice(0, s.start)}[REDACTED:${s.rule.category}]${out.slice(s.end)}`;
  }
  const findings = kept
    .map(spanToFinding)
    .sort((a, b) => a.index - b.index || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { text: out, findings, redactions: kept.length };
}

/** Redact secrets + PII from text bound for a third-party model / logs. */
export function sanitizeForEgress(text: string): RedactionResult {
  return redact(text, [...SECRET_RULES, ...PII_RULES]);
}

// ---- reports + decisions ----------------------------------------------------

function emptyCounts(): Record<SafetyCategory, number> {
  return { 'prompt-injection': 0, jailbreak: 0, secret: 0, pii: 0 };
}

function report(findings: SafetyFinding[]): SafetyReport {
  const counts = emptyCounts();
  let worst = 0;
  for (const f of findings) {
    counts[f.category] += 1;
    worst = Math.max(worst, SEVERITY_RANK[f.severity]);
  }
  const severity: ReportSeverity =
    worst === 3 ? 'high' : worst === 2 ? 'medium' : worst === 1 ? 'low' : 'none';
  const parts = (Object.keys(counts) as SafetyCategory[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`);
  const summary =
    findings.length === 0
      ? 'No safety issues detected.'
      : `${findings.length} finding${findings.length === 1 ? '' : 's'} (${severity}): ${parts.join(', ')}.`;
  return { findings, severity, counts, summary };
}

/**
 * Scan UNTRUSTED context (retrieved code, tool/web/MCP output) for injection +
 * leaked secrets. Callers flag/quarantine — this never mutates.
 */
export function scanUntrusted(text: string): SafetyReport {
  return report([...detectInjection(text), ...detectSecrets(text)]);
}

/** Scan OUTBOUND text for secrets + PII before it leaves the machine. */
export function scanEgress(text: string): SafetyReport {
  return report([...detectSecrets(text), ...detectPii(text)]);
}

export interface EgressOptions {
  /** Redact detected secrets/PII (opt-in policy). Default false = detect only. */
  redact?: boolean;
  /** Block outright when a high-severity secret is present. Default false. */
  blockOnHighSeverity?: boolean;
}

/**
 * Decide what to do with outbound text: allow (detect only), sanitize (redact),
 * or block. Never blocks unless explicitly asked, and only redacts when opted in,
 * so a user's intentional code sharing is preserved by default.
 */
export function evaluateEgress(text: string, options: EgressOptions = {}): SafetyDecision {
  const secretsPii = [...detectSecrets(text), ...detectPii(text)];
  const rep = report(secretsPii);

  if (options.blockOnHighSeverity && rep.severity === 'high') {
    return {
      action: 'block',
      text: '',
      findings: rep.findings,
      redactions: 0,
      summary: `Blocked egress: ${rep.summary}`,
    };
  }

  if (options.redact && secretsPii.length > 0) {
    const r = sanitizeForEgress(text);
    return {
      action: 'sanitize',
      text: r.text,
      findings: r.findings,
      redactions: r.redactions,
      summary: `Sanitized egress: redacted ${r.redactions} span${r.redactions === 1 ? '' : 's'}.`,
    };
  }

  return {
    action: 'allow',
    text,
    findings: rep.findings,
    redactions: 0,
    summary: rep.summary,
  };
}

/** Highest severity across findings (or 'none'). Exposed for readouts. */
export function worstSeverity(findings: readonly SafetyFinding[]): ReportSeverity {
  let worst = 0;
  for (const f of findings) worst = Math.max(worst, SEVERITY_RANK[f.severity]);
  return worst === 3 ? 'high' : worst === 2 ? 'medium' : worst === 1 ? 'low' : 'none';
}

// ---- active egress policy (Phase 170 — AI Safety & Guardrails) --------------

/**
 * Egress safety MODE — how the outbound-AI path treats detected secrets / PII:
 *   - 'off'      : no scanning at all (the user opts out entirely).
 *   - 'audit'    : detect + report (so leaks are logged) but send the text
 *                  UNCHANGED. This is the default — non-mutating, so a user's
 *                  intentional code sharing is never silently altered.
 *   - 'sanitize' : REDACT detected secrets + PII from the text before it is sent.
 *   - 'block'    : REFUSE to send when a finding at/above `blockSeverity` exists.
 *
 * 'audit' preserves the historical detect-only behavior; 'sanitize' and 'block'
 * are the active guardrail this phase adds.
 */
export type EgressMode = 'off' | 'audit' | 'sanitize' | 'block';

export interface EgressPolicy {
  mode: EgressMode;
  /** Inclusive block threshold used only when `mode === 'block'`. */
  blockSeverity: SafetySeverity;
}

/** Safe default: detect + log, never mutate (matches pre-policy behavior). */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = { mode: 'audit', blockSeverity: 'high' };

const EGRESS_MODES: readonly EgressMode[] = ['off', 'audit', 'sanitize', 'block'];
const SEVERITIES: readonly SafetySeverity[] = ['low', 'medium', 'high'];

/**
 * Parse untrusted setting values into a valid `EgressPolicy` (never throws).
 * Unknown / missing values fall back to the safe default, so a corrupt settings
 * file can never disable the guardrail into an unexpected state.
 */
export function parseEgressPolicy(mode: unknown, blockSeverity?: unknown): EgressPolicy {
  const m = (EGRESS_MODES as readonly string[]).includes(mode as string)
    ? (mode as EgressMode)
    : DEFAULT_EGRESS_POLICY.mode;
  const b = (SEVERITIES as readonly string[]).includes(blockSeverity as string)
    ? (blockSeverity as SafetySeverity)
    : DEFAULT_EGRESS_POLICY.blockSeverity;
  return { mode: m, blockSeverity: b };
}

/**
 * Apply an egress `policy` to outbound `text`, returning the action plus the text
 * to ACTUALLY send. This is the active guardrail (Phase 170): unlike the
 * detect-only helpers, `'sanitize'` rewrites the text and `'block'` withholds it
 * entirely. Callers send `decision.text` (and must honor `action === 'block'`).
 */
export function resolveEgress(text: string, policy: EgressPolicy): SafetyDecision {
  if (policy.mode === 'off') {
    return {
      action: 'allow',
      text,
      findings: [],
      redactions: 0,
      summary: 'AI egress safety is off.',
    };
  }

  const findings = [...detectSecrets(text), ...detectPii(text)].sort(
    (a, b) => a.index - b.index || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const rep = report(findings);

  if (policy.mode === 'block') {
    const worst = worstSeverity(findings);
    const trips = worst !== 'none' && SEVERITY_RANK[worst] >= SEVERITY_RANK[policy.blockSeverity];
    if (trips) {
      return {
        action: 'block',
        text: '',
        findings: rep.findings,
        redactions: 0,
        summary: `Blocked egress (${policy.blockSeverity}+ policy): ${rep.summary}`,
      };
    }
    return { action: 'allow', text, findings: rep.findings, redactions: 0, summary: rep.summary };
  }

  if (policy.mode === 'sanitize') {
    if (findings.length === 0) {
      return { action: 'allow', text, findings: [], redactions: 0, summary: rep.summary };
    }
    const r = sanitizeForEgress(text);
    return {
      action: 'sanitize',
      text: r.text,
      findings: r.findings,
      redactions: r.redactions,
      summary: `Sanitized egress: redacted ${r.redactions} span${r.redactions === 1 ? '' : 's'}.`,
    };
  }

  // 'audit' — detect + report, send unchanged.
  return { action: 'allow', text, findings: rep.findings, redactions: 0, summary: rep.summary };
}
