/**
 * Code Explanation (PRD Epoch G §141 / Phase 191). Pure builder for a depth-leveled
 * explanation prompt (brief / normal / deep) with a citation instruction, reusing
 * the versioned `explain` prompt template. Kept in `common/` so the editor action
 * bus and any runner share one implementation; unit-tested. Explanations stream
 * back through the normal grounded chat path.
 */
import { renderTemplate } from './prompts';

export type ExplainDepth = 'brief' | 'normal' | 'deep';
export const EXPLAIN_DEPTHS: readonly ExplainDepth[] = ['brief', 'normal', 'deep'];

export function parseExplainDepth(value: unknown): ExplainDepth {
  return typeof value === 'string' && (EXPLAIN_DEPTHS as readonly string[]).includes(value)
    ? (value as ExplainDepth)
    : 'normal';
}

const DEPTH_GUIDANCE: Record<ExplainDepth, string> = {
  brief: 'Keep it to a 1–2 sentence high-level summary.',
  normal: 'Explain what it does and how, in a short paragraph or a few bullet points.',
  deep: 'Give a thorough explanation: control flow, key lines, edge cases, complexity, and intent.',
};

export interface ExplainOptions {
  lang?: string;
  depth?: ExplainDepth;
  /** Source label (e.g. file name) for the citation line. */
  label?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Build the explanation prompt for a piece of code (pure). Combines the versioned
 * `explain` template (which embeds the depth) with depth-specific guidance and a
 * citation instruction that references the source lines when provided.
 */
export function buildExplainRequest(code: string, opts: ExplainOptions = {}): string {
  const depth = parseExplainDepth(opts.depth);
  const lang = opts.lang ?? '';
  const base = renderTemplate('explain', { lang, depth, code });
  const guidance = DEPTH_GUIDANCE[depth];
  const where =
    opts.label !== undefined && opts.label.length > 0
      ? `Source: ${opts.label}${
          opts.startLine !== undefined
            ? ` (lines ${opts.startLine}\u2013${opts.endLine ?? opts.startLine})`
            : ''
        }. Cite specific line numbers where relevant.`
      : 'Cite specific line numbers where relevant.';
  return `${base}\n\n${guidance}\n\n${where}`;
}
