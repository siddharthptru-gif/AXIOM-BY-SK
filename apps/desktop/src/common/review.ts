/**
 * Code-Review agent core (PRD Epoch H §135 / Phase 222). Pure helpers: build the
 * review prompt (line-numbered code + a strict JSON output contract) and parse the
 * model's reply into sanitized, severity-tagged findings. Tolerant of fenced/prose
 * output; never throws (bad output → no findings). No I/O — unit-tested.
 */

import { runDebate, type Verdict } from './debate';

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'major', 'minor', 'nit'];

export interface ReviewFinding {
  severity: ReviewSeverity;
  category: string;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  raw: string;
  /** Debate/critic verdict (Phase 257): accept / revise / reject. */
  verdict?: Verdict;
  /** One-line verdict summary. */
  verdictSummary?: string;
}

const REVIEW_SYSTEM = [
  'You are a senior code reviewer. Review the code for bugs, security issues,',
  'performance problems, missing tests, and style — most important first.',
  'Respond with EXACTLY ONE JSON object and NOTHING else:',
  '{"findings":[{"severity":"blocker|major|minor|nit","category":"bug|security|performance|style|test|other",',
  '"line":<number or null>,"title":"short title","detail":"why it matters","suggestion":"a fix, or null"}]}',
  'Cite real line numbers from the numbered code. If there are no issues, return {"findings":[]}.',
].join('\n');

/** Build the review chat messages: strict system contract + line-numbered code. */
export function buildReviewMessages(label: string, code: string): { system: string; user: string } {
  const numbered = code
    .split(/\r?\n/)
    .map((l, i) => `${i + 1}: ${l}`)
    .join('\n');
  return { system: REVIEW_SYSTEM, user: `Review ${label}:\n\n${numbered}` };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Extract the first JSON object from model text (handles ``` fences + prose). */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      return asRecord(JSON.parse(s.trim()));
    } catch {
      return null;
    }
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}

function clamp(s: unknown, max: number): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

function sanitizeFinding(input: unknown): ReviewFinding | null {
  const o = asRecord(input);
  if (!o) return null;
  const title = clamp(o.title, 200);
  if (title.length === 0) return null;
  const severity = (REVIEW_SEVERITIES as readonly string[]).includes(o.severity as string)
    ? (o.severity as ReviewSeverity)
    : 'minor';
  const category = clamp(o.category, 24) || 'other';
  const lineNum =
    typeof o.line === 'number' && Number.isFinite(o.line) && o.line > 0 ? Math.floor(o.line) : null;
  const suggestion =
    typeof o.suggestion === 'string' && o.suggestion.trim().length > 0
      ? o.suggestion.trim().slice(0, 4000)
      : null;
  return { severity, category, line: lineNum, title, detail: clamp(o.detail, 2000), suggestion };
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

/** Parse a review reply into sanitized findings, sorted by severity (pure). */
export function parseReviewFindings(text: string): ReviewFinding[] {
  const obj = extractJson(text);
  const arr = obj && Array.isArray(obj.findings) ? obj.findings : [];
  const findings = arr.map((f) => sanitizeFinding(f)).filter((f): f is ReviewFinding => f !== null);
  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Adjudicate a review's findings into a verdict (Phase 257 — Multi-Model Debate /
 * Critic): treat the review as a single critic and run the debate protocol — any
 * blocker → reject, any major → revise, else accept.
 */
export function adjudicateReview(
  findings: readonly ReviewFinding[],
  model = 'reviewer',
): { verdict: Verdict; summary: string } {
  const result = runDebate({
    proposal: { id: 'review', model, content: '' },
    reviews: [
      { model, findings: findings.map((f) => ({ severity: f.severity, message: f.title })) },
    ],
  });
  return { verdict: result.verdict, summary: result.summary };
}
