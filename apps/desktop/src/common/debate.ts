/**
 * Multi-model debate / critic (Phase 257 — Multi-Model Debate / Critic).
 *
 * PURE module (no I/O, no Electron). The protocol + decision core for cross-checking
 * high-stakes changes: one model PROPOSES, one or more models CRITIQUE, and this
 * turns the critique into a structured VERDICT (accept / revise / reject),
 * surfaces the substantive DISAGREEMENTS, and — for self-consistency — computes a
 * CONSENSUS across several independent proposals (majority vote). The Main service
 * runs the actual proposer/critic passes (reusing the chat + sub-agent infra) and
 * feeds the text here; parsing + adjudication live here so they are unit-testable.
 */

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type Verdict = 'accept' | 'revise' | 'reject';

const SEVERITY_RANK: Record<Severity, number> = { blocker: 3, major: 2, minor: 1, nit: 0 };
const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];

export interface CriticFinding {
  severity: Severity;
  message: string;
}

export interface Proposal {
  id: string;
  model: string;
  /** The proposed answer / change. */
  content: string;
}

export interface CriticReview {
  model: string;
  findings: CriticFinding[];
}

/**
 * Parse a critic's free-text review into findings. Recognizes a severity keyword
 * (blocker / major / minor / nit) per line (e.g. "BLOCKER: …", "[major] …",
 * "- nit: …"); lines with no severity marker are ignored (prose, not a finding).
 */
export function parseFindings(text: string): CriticFinding[] {
  const out: CriticFinding[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /\b(blocker|major|minor|nit)\b/i.exec(line);
    if (!m) continue;
    const severity = m[1]!.toLowerCase() as Severity;
    const message =
      line.replace(/^[\s\-*[\]]*\b(blocker|major|minor|nit)\b[:\]\s.-]*/i, '').trim() || line;
    out.push({ severity, message });
  }
  return out;
}

/** Count findings by severity. */
export function countBySeverity(findings: readonly CriticFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * The verdict implied by a set of findings: any blocker → reject; else any major →
 * revise; else accept.
 */
export function verdictOf(findings: readonly CriticFinding[]): Verdict {
  const c = countBySeverity(findings);
  if (c.blocker > 0) return 'reject';
  if (c.major > 0) return 'revise';
  return 'accept';
}

/** Merge findings from several reviews: dedupe by severity+message, worst-first. */
export function mergeFindings(reviews: readonly CriticReview[]): CriticFinding[] {
  const seen = new Set<string>();
  const merged: CriticFinding[] = [];
  for (const r of reviews) {
    for (const f of r.findings) {
      const key = `${f.severity}::${f.message.replace(/\s+/g, ' ').trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
  }
  merged.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.message.localeCompare(b.message),
  );
  return merged;
}

export interface DebateInput {
  proposal: Proposal;
  reviews: CriticReview[];
}

export interface DebateResult {
  verdict: Verdict;
  /** Merged, deduped findings across all critics (worst-first). */
  findings: CriticFinding[];
  /** The substantive disagreements — blocker + major findings. */
  disagreements: CriticFinding[];
  bySeverity: Record<Severity, number>;
  /** True when the proposer should revise (verdict revise / reject). */
  needsRevision: boolean;
  summary: string;
}

/** Adjudicate a proposer's proposal against its critic reviews. */
export function runDebate(input: DebateInput): DebateResult {
  const findings = mergeFindings(input.reviews);
  const verdict = verdictOf(findings);
  const bySeverity = countBySeverity(findings);
  const disagreements = findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
  const parts = SEVERITIES.filter((s) => bySeverity[s] > 0).map((s) => `${bySeverity[s]} ${s}`);
  const summary =
    findings.length === 0
      ? `Verdict: accept — no findings from ${input.reviews.length} critic(s).`
      : `Verdict: ${verdict} — ${parts.join(', ')} (${input.reviews.length} critic(s)).`;
  return {
    verdict,
    findings,
    disagreements,
    bySeverity,
    needsRevision: verdict !== 'accept',
    summary,
  };
}

export interface ConsensusGroup {
  content: string;
  count: number;
  models: string[];
}

export interface ConsensusResult {
  /** The most-agreed proposal content (null when there are no proposals). */
  winner: string | null;
  /** How many proposals matched the winner. */
  agree: number;
  total: number;
  /** True when a strict majority (> half) agreed. */
  majority: boolean;
  /** Distinct answer groups (by normalized content), largest first. */
  groups: ConsensusGroup[];
  summary: string;
}

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Self-consistency across independent proposals: group by normalized content and
 * pick the most-agreed answer (majority vote). Ties break by first-seen order.
 */
export function consensus(proposals: readonly Proposal[]): ConsensusResult {
  const total = proposals.length;
  const map = new Map<string, ConsensusGroup>();
  const order: string[] = [];
  for (const p of proposals) {
    const key = normalizeContent(p.content);
    const g = map.get(key);
    if (g) {
      g.count += 1;
      g.models.push(p.model);
    } else {
      map.set(key, { content: p.content, count: 1, models: [p.model] });
      order.push(key);
    }
  }
  const groups = order.map((k) => map.get(k)!).sort((a, b) => b.count - a.count); // stable: ties keep first-seen order
  const top = groups[0] ?? null;
  const agree = top?.count ?? 0;
  return {
    winner: top?.content ?? null,
    agree,
    total,
    majority: total > 0 && agree > total / 2,
    groups,
    summary:
      total === 0
        ? 'No proposals.'
        : `${agree}/${total} agree${top && top.count === total ? ' (unanimous)' : groups.length > 1 ? ` (${groups.length} distinct)` : ''}.`,
  };
}
