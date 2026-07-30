/**
 * Large-file & large-repo hardening (PRD Epoch J §198 / Phases 267–269). Pure
 * thresholds + policy decisions with no I/O, so they are fully unit-testable and
 * shared by the editor (which perf features to disable when opening a big file),
 * the AI context builder / indexer (whether a file is worth pulling in), and the
 * workspace file walker (the large-repo file budget). The heavy lifting —
 * virtualized huge-file editing and incremental large-repo reindex — lives in the
 * editor + Rust core; this module owns the *policy*.
 */

// Byte thresholds.
export const LARGE_FILE_BYTES = 500_000; // 500 KB → large mode
export const HUGE_FILE_BYTES = 2_000_000; // 2 MB → huge mode (plaintext, no tokenization)
// Line-count thresholds.
export const LARGE_FILE_LINES = 5_000;
export const HUGE_FILE_LINES = 20_000;
// Longest single line (a proxy for minified/generated content).
export const LARGE_LINE_LENGTH = 2_000;
export const HUGE_LINE_LENGTH = 10_000;
// Files bigger than this are not indexed / pulled into AI context.
export const INDEX_MAX_BYTES = 2_000_000;
// Upper bound on files walked for Quick Open / indexing on very large repos.
export const LARGE_REPO_MAX_FILES = 20_000;
// A repo with more files than this is indexed partially (budget-capped).
export const REPO_PARTIAL_FILES = 50_000;
// A pathologically huge working set is skipped entirely.
export const REPO_SKIP_BYTES = 5_000_000_000; // 5 GB

function num(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function fmtBytes(b: number): string {
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b >= 1000) return `${Math.round(b / 1000)} KB`;
  return `${b} B`;
}

export type EditorFileMode = 'normal' | 'large' | 'huge';

export interface EditorFileMetrics {
  bytes: number;
  lineCount: number;
  maxLineLength: number;
  /** True when the reader hit its cap and only returned a prefix. */
  truncated?: boolean;
}

export interface EditorFileClass {
  mode: EditorFileMode;
  /** Keep syntax highlighting (tokenization)? Off for huge files. */
  syntaxHighlight: boolean;
  /** Allow the minimap? Off for large + huge. */
  minimap: boolean;
  /** Allow the user's word-wrap? Forced off for large + huge. */
  wordWrap: boolean;
  /** Allow bracket-pair colorization? Off for large + huge. */
  bracketColorization: boolean;
  reason: string;
}

function reasonFor(
  mode: EditorFileMode,
  bytes: number,
  lines: number,
  maxLine: number,
  truncated: boolean,
): string {
  const bits: string[] = [];
  if (truncated) bits.push('truncated at the read cap');
  else if (bytes > 0) bits.push(fmtBytes(bytes));
  if (lines > 0) bits.push(`${lines.toLocaleString()} lines`);
  if (maxLine >= LARGE_LINE_LENGTH) bits.push('very long lines (minified?)');
  const detail = bits.join(', ');
  return mode === 'huge'
    ? `Huge file (${detail}) \u2014 syntax highlighting, minimap, and wrapping disabled for performance.`
    : `Large file (${detail}) \u2014 minimap, wrapping, and bracket colorization disabled for performance.`;
}

/**
 * Classify a file for the editor: which performance features to keep vs disable.
 * `huge` skips tokenization + minimap + wrapping; `large` keeps highlighting but
 * drops the minimap + wrapping + bracket colorization; `normal` keeps everything.
 */
export function classifyFileForEditor(m: EditorFileMetrics): EditorFileClass {
  const bytes = num(m.bytes);
  const lines = num(m.lineCount);
  const maxLine = num(m.maxLineLength);
  const truncated = m.truncated === true;

  const huge =
    truncated ||
    bytes >= HUGE_FILE_BYTES ||
    lines >= HUGE_FILE_LINES ||
    maxLine >= HUGE_LINE_LENGTH;
  const large =
    bytes >= LARGE_FILE_BYTES || lines >= LARGE_FILE_LINES || maxLine >= LARGE_LINE_LENGTH;

  if (huge) {
    return {
      mode: 'huge',
      syntaxHighlight: false,
      minimap: false,
      wordWrap: false,
      bracketColorization: false,
      reason: reasonFor('huge', bytes, lines, maxLine, truncated),
    };
  }
  if (large) {
    return {
      mode: 'large',
      syntaxHighlight: true,
      minimap: false,
      wordWrap: false,
      bracketColorization: false,
      reason: reasonFor('large', bytes, lines, maxLine, truncated),
    };
  }
  return {
    mode: 'normal',
    syntaxHighlight: true,
    minimap: true,
    wordWrap: true,
    bracketColorization: true,
    reason: 'Normal file.',
  };
}

/** The all-features-on class for normal / untitled buffers. */
export const NORMAL_FILE_CLASS: EditorFileClass = {
  mode: 'normal',
  syntaxHighlight: true,
  minimap: true,
  wordWrap: true,
  bracketColorization: true,
  reason: 'Normal file.',
};

export interface IndexFileInput {
  path: string;
  bytes: number;
  maxLineLength?: number;
}

export interface IndexDecision {
  index: boolean;
  reason: string;
}

/** Lockfiles (exact names) that are never worth indexing / grounding on. */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'bun.lockb',
  'gemfile.lock',
]);

/** Generated / minified / map artifacts (by name suffix). */
const GENERATED_RE = /(\.min\.(js|css|mjs)|\.map|\.bundle\.js|\.chunk\.js)$/i;

/**
 * Decide whether a file should be indexed / pulled into AI context. Skips files
 * that are too large, lockfiles, generated/minified artifacts, or minified by the
 * very-long-line heuristic. Pure — the context builder + indexer consult it.
 */
export function shouldIndexFile(input: IndexFileInput): IndexDecision {
  const bytes = num(input.bytes);
  const name = (input.path.split(/[\\/]/).pop() ?? input.path).toLowerCase();
  if (bytes > INDEX_MAX_BYTES) {
    return { index: false, reason: `Too large (${fmtBytes(bytes)}) to index.` };
  }
  if (LOCKFILE_NAMES.has(name)) return { index: false, reason: 'Lockfile \u2014 skipped.' };
  if (GENERATED_RE.test(name)) {
    return { index: false, reason: 'Generated/minified artifact \u2014 skipped.' };
  }
  if ((input.maxLineLength ?? 0) >= HUGE_LINE_LENGTH) {
    return { index: false, reason: 'Minified (very long lines) \u2014 skipped.' };
  }
  return { index: true, reason: 'Indexable.' };
}

export type RepoIndexScope = 'full' | 'partial' | 'skip';

export interface RepoStats {
  fileCount: number;
  totalBytes: number;
}

export interface RepoIndexPlan {
  scope: RepoIndexScope;
  /** Maximum number of files to walk / index under this plan. */
  maxFiles: number;
  reason: string;
}

/**
 * Plan a large-repo index budget from coarse workspace stats. A pathological
 * working set is skipped; a very large one is indexed partially (file-capped);
 * otherwise a full (still-capped) index is fine.
 */
export function planRepoIndex(stats: RepoStats): RepoIndexPlan {
  const files = num(stats.fileCount);
  const bytes = num(stats.totalBytes);
  if (bytes >= REPO_SKIP_BYTES) {
    return {
      scope: 'skip',
      maxFiles: 0,
      reason: `Working set too large (${fmtBytes(bytes)}) \u2014 background indexing skipped.`,
    };
  }
  if (files > REPO_PARTIAL_FILES) {
    return {
      scope: 'partial',
      maxFiles: LARGE_REPO_MAX_FILES,
      reason: `Large repository (${files.toLocaleString()} files) \u2014 indexing the first ${LARGE_REPO_MAX_FILES.toLocaleString()}.`,
    };
  }
  return {
    scope: 'full',
    maxFiles: LARGE_REPO_MAX_FILES,
    reason: 'Repository within budget \u2014 full index.',
  };
}
