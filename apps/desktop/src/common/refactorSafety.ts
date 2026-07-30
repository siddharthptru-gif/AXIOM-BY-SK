/**
 * KG-aware refactor safety core (PRD Epoch H §138/§151 / Phase 238). Before an edit,
 * predict the blast radius from the knowledge graph (direct dependents + transitive
 * impact) and rate the risk; after an edit, verify the refactor touched every file
 * the impact analysis expected (flagging any missed call sites). Pure logic — the
 * agent's graph_impact tool + the composer use it. Smoke-tested.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.map(norm).filter((p) => p.length > 0))];
}

export interface BlastRadius {
  /** Files that directly import/depend on the target. */
  directFiles: string[];
  /** Additional files transitively affected (beyond the direct set). */
  transitiveFiles: string[];
  totalFiles: number;
  risk: RiskLevel;
  summary: string;
}

/**
 * Predict the blast radius of changing a file from its graph dependents (direct)
 * and transitive impact. Risk scales with the affected-file count.
 */
export function predictBlastRadius(
  dependents: readonly string[],
  impact: readonly string[],
): BlastRadius {
  const directFiles = unique(dependents);
  const directSet = new Set(directFiles);
  const transitiveFiles = unique(impact).filter((p) => !directSet.has(p));
  const totalFiles = directFiles.length + transitiveFiles.length;
  const risk: RiskLevel = totalFiles <= 3 ? 'low' : totalFiles <= 12 ? 'medium' : 'high';
  const summary =
    totalFiles === 0
      ? 'No known dependents — changing this file appears self-contained (low risk).'
      : `Affects ${totalFiles} file(s): ${directFiles.length} direct dependent(s), ${transitiveFiles.length} transitive. ${risk.toUpperCase()} risk — update all call sites and verify with tests.`;
  return { directFiles, transitiveFiles, totalFiles, risk, summary };
}

export interface CompletenessResult {
  complete: boolean;
  /** Expected-impact files that WERE edited. */
  covered: string[];
  /** Expected-impact files that were NOT edited (possible missed call sites). */
  missed: string[];
  /** Fraction of expected files covered (0..1). */
  coverage: number;
  summary: string;
}

/**
 * Verify a refactor is complete: of the files the impact analysis expected to
 * change, which were actually edited, and which were missed.
 */
export function verifyCompleteness(
  expectedImpact: readonly string[],
  editedPaths: readonly string[],
): CompletenessResult {
  const expected = unique(expectedImpact);
  const edited = new Set(unique(editedPaths));
  const covered = expected.filter((p) => edited.has(p));
  const missed = expected.filter((p) => !edited.has(p));
  const coverage = expected.length === 0 ? 1 : covered.length / expected.length;
  const complete = missed.length === 0;
  const summary = complete
    ? `Refactor complete: all ${expected.length} expected file(s) were updated.`
    : `Possibly incomplete: ${missed.length} of ${expected.length} expected file(s) were NOT updated (${missed
        .slice(0, 5)
        .join(', ')}${missed.length > 5 ? ', …' : ''}).`;
  return { complete, covered, missed, coverage: Math.round(coverage * 100) / 100, summary };
}
