/**
 * Convention learner (Phase 260 — Convention Learner).
 *
 * PURE module (no I/O, no Electron). It observes the workspace's own code (and,
 * optionally, which AI edits the user accepted/rejected) to INFER the project's de
 * facto conventions — indentation, quote style, semicolons, identifier casing — and
 * PROPOSES them as workspace rules (Phase 233) for the user to approve. It never
 * auto-applies: wrong inferences are cheap because they are only suggestions.
 *
 * Each convention is inferred as the dominant choice across samples, with a
 * confidence = dominance ratio; a convention is only proposed when it clears a
 * minimum evidence count and confidence. Optional edit feedback nudges confidence
 * (accepted edits that follow a convention reinforce it; rejections weaken it), and
 * can push a weak convention below the threshold so it is dropped.
 */

import type { Rule } from './rules';

export interface CodeSample {
  path: string;
  text: string;
}

export type ConventionCategory = 'formatting' | 'style' | 'naming';

export interface ProposedRule {
  /** Stable id, e.g. 'indent' / 'quotes' / 'semicolons' / 'naming'. */
  id: string;
  category: ConventionCategory;
  title: string;
  /** The rule text (becomes a Rule body). */
  statement: string;
  /** 0..1 dominance-based confidence (after any feedback adjustment). */
  confidence: number;
  /** Human-readable evidence, e.g. "42/50 (84%) samples". */
  evidence: string;
}

/** Optional signal from accepted/rejected AI edits, keyed by convention id. */
export interface EditFeedback {
  ruleId: string;
  accepted: boolean;
}

const MIN_EVIDENCE = 4;
const MIN_CONFIDENCE = 0.6;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function evidenceStr(dominant: number, total: number): string {
  const pct = total > 0 ? Math.round((dominant / total) * 100) : 0;
  return `${dominant}/${total} (${pct}%) samples`;
}

interface Tally {
  a: number;
  b: number;
}

/** Split every sample into lines once (shared by the detectors). */
function allLines(samples: readonly CodeSample[]): string[] {
  const out: string[] = [];
  for (const s of samples) for (const line of s.text.split(/\r?\n/)) out.push(line);
  return out;
}

// ---- detectors --------------------------------------------------------------

interface IndentResult {
  kind: 'tabs' | 'spaces';
  width: number;
  dominant: number;
  total: number;
}

/** Detect indentation: tabs vs spaces (and the space unit = min positive indent). */
export function detectIndent(samples: readonly CodeSample[]): IndentResult | null {
  let tabs = 0;
  let spaces = 0;
  let minSpace = Infinity;
  for (const line of allLines(samples)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    const ws = m[1] ?? '';
    if (ws.startsWith('\t')) tabs += 1;
    else {
      spaces += 1;
      if (ws.length < minSpace) minSpace = ws.length;
    }
  }
  const total = tabs + spaces;
  if (total === 0) return null;
  if (tabs >= spaces) return { kind: 'tabs', width: 1, dominant: tabs, total };
  const width = Number.isFinite(minSpace) && minSpace > 0 ? minSpace : 2;
  return { kind: 'spaces', width, dominant: spaces, total };
}

/** Detect string-literal quote style: single vs double. */
export function detectQuotes(
  samples: readonly CodeSample[],
): { style: 'single' | 'double'; tally: Tally } | null {
  let single = 0;
  let dbl = 0;
  for (const s of samples) {
    single += (s.text.match(/'[^'\n]*'/g) ?? []).length;
    dbl += (s.text.match(/"[^"\n]*"/g) ?? []).length;
  }
  if (single + dbl === 0) return null;
  return { style: single >= dbl ? 'single' : 'double', tally: { a: single, b: dbl } };
}

/** Detect statement-terminating semicolons: required vs omitted. */
export function detectSemicolons(
  samples: readonly CodeSample[],
): { style: 'required' | 'omitted'; tally: Tally } | null {
  let semi = 0;
  let noSemi = 0;
  for (const line of allLines(samples)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (t.endsWith(';')) semi += 1;
    else if (/[\w)\]'"`]$/.test(t)) noSemi += 1; // a statement-ish line with no semicolon
  }
  if (semi + noSemi < 1) return null;
  return { style: semi >= noSemi ? 'required' : 'omitted', tally: { a: semi, b: noSemi } };
}

/** Detect identifier casing for declared names: camelCase vs snake_case. */
export function detectNaming(
  samples: readonly CodeSample[],
): { style: 'camelCase' | 'snake_case'; tally: Tally } | null {
  let camel = 0;
  let snake = 0;
  const re = /\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const s of samples) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(s.text)) !== null) {
      const name = m[1] ?? '';
      if (name.includes('_') && name === name.toLowerCase()) snake += 1;
      else if (/[a-z][A-Z]/.test(name)) camel += 1;
    }
  }
  if (camel + snake === 0) return null;
  return { style: camel >= snake ? 'camelCase' : 'snake_case', tally: { a: camel, b: snake } };
}

// ---- learner ----------------------------------------------------------------

function propose(
  id: string,
  category: ConventionCategory,
  title: string,
  statement: string,
  dominant: number,
  total: number,
): ProposedRule | null {
  if (total < MIN_EVIDENCE) return null;
  const confidence = clamp01(dominant / total);
  return { id, category, title, statement, confidence, evidence: evidenceStr(dominant, total) };
}

/**
 * Infer conventions from code samples (+ optional edit feedback) and return the
 * ones worth proposing as workspace rules, highest-confidence first. Feedback
 * nudges a convention's confidence and can drop a borderline one.
 */
export function learnConventions(
  samples: readonly CodeSample[],
  feedback: readonly EditFeedback[] = [],
): ProposedRule[] {
  const raw: (ProposedRule | null)[] = [];

  const indent = detectIndent(samples);
  if (indent) {
    const statement =
      indent.kind === 'tabs'
        ? 'Indent with tabs.'
        : `Indent with ${indent.width} space${indent.width === 1 ? '' : 's'} (no tabs).`;
    raw.push(
      propose('indent', 'formatting', 'Indentation', statement, indent.dominant, indent.total),
    );
  }

  const quotes = detectQuotes(samples);
  if (quotes) {
    const dominant = Math.max(quotes.tally.a, quotes.tally.b);
    const total = quotes.tally.a + quotes.tally.b;
    raw.push(
      propose(
        'quotes',
        'style',
        'String quotes',
        `Use ${quotes.style} quotes for strings.`,
        dominant,
        total,
      ),
    );
  }

  const semis = detectSemicolons(samples);
  if (semis) {
    const dominant = Math.max(semis.tally.a, semis.tally.b);
    const total = semis.tally.a + semis.tally.b;
    const statement =
      semis.style === 'required'
        ? 'Terminate statements with semicolons.'
        : 'Omit statement-terminating semicolons (rely on ASI).';
    raw.push(propose('semicolons', 'formatting', 'Semicolons', statement, dominant, total));
  }

  const naming = detectNaming(samples);
  if (naming) {
    const dominant = Math.max(naming.tally.a, naming.tally.b);
    const total = naming.tally.a + naming.tally.b;
    raw.push(
      propose(
        'naming',
        'naming',
        'Identifier casing',
        `Use ${naming.style} for function and variable names.`,
        dominant,
        total,
      ),
    );
  }

  // Apply edit feedback: reinforce/weaken by net accepts−rejects per convention id.
  const net = new Map<string, number>();
  for (const f of feedback) net.set(f.ruleId, (net.get(f.ruleId) ?? 0) + (f.accepted ? 1 : -1));

  const adjusted: ProposedRule[] = [];
  for (const p of raw) {
    if (!p) continue;
    const n = net.get(p.id) ?? 0;
    const confidence = clamp01(p.confidence + (n > 0 ? 0.1 : n < 0 ? -0.15 : 0));
    if (confidence >= MIN_CONFIDENCE)
      adjusted.push({ ...p, confidence: Math.round(confidence * 100) / 100 });
  }

  adjusted.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  return adjusted;
}

/** Convert a proposed convention into a workspace Rule (source 'workspace'). */
export function proposedToRule(p: ProposedRule): Rule {
  return {
    id: `workspace:conv-${p.id}`,
    name: p.title,
    priority: Math.round(50 + p.confidence * 50),
    body: `${p.statement} (Inferred from ${p.evidence}.)`,
    source: 'workspace',
  };
}

/** One-line summary of a proposal set. */
export function summarizeProposals(proposals: readonly ProposedRule[]): string {
  if (proposals.length === 0) return 'No conventions confidently inferred.';
  return (
    `${proposals.length} convention${proposals.length === 1 ? '' : 's'} proposed: ` +
    proposals.map((p) => `${p.title} (${Math.round(p.confidence * 100)}%)`).join(', ')
  );
}
