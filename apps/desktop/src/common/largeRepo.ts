/**
 * Large-repository hardening (PRD Epoch J §197 / Phase 267 — "survive 1M+ file
 * repos"). Pure, I/O-free policy that turns a repository's coarse scale (file
 * count, FS-event rate) into concrete decisions: which scale tier it is, how to
 * index it (full / partial / scoped / on-demand), how to tame a watcher storm
 * (native → debounced → polling → suspended), and which features to gracefully
 * degrade at scale. Complements the file-level `largeFile.ts` (editor modes +
 * `planRepoIndex`) with repo-scale hardening. Smoke-tested; the walker / indexer /
 * watcher / workbench consume these decisions.
 */

export type RepoScale = 'small' | 'medium' | 'large' | 'huge' | 'extreme';

// File-count tier ceilings (inclusive).
export const SMALL_MAX = 5_000;
export const MEDIUM_MAX = 50_000;
export const LARGE_MAX = 200_000;
export const HUGE_MAX = 1_000_000;

/** Hard cap on files indexed eagerly even for a "full" index. */
export const FULL_INDEX_CAP = 60_000;

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Classify a repository by its file count. */
export function classifyRepoScale(fileCount: number): RepoScale {
  const n = count(fileCount);
  if (n <= SMALL_MAX) return 'small';
  if (n <= MEDIUM_MAX) return 'medium';
  if (n <= LARGE_MAX) return 'large';
  if (n <= HUGE_MAX) return 'huge';
  return 'extreme';
}

export type IndexMode = 'full' | 'partial' | 'scoped' | 'on-demand';

export interface RepoIndexStrategy {
  scale: RepoScale;
  mode: IndexMode;
  /** Max files indexed eagerly under this plan. */
  maxIndexedFiles: number;
  /** Index only opened/active subtrees first, expanding lazily. */
  lazy: boolean;
  reason: string;
}

/**
 * Decide how to index the repo: a small/medium repo indexes fully (still capped),
 * a large repo indexes a partial budget, a huge repo indexes scoped + lazily, and
 * an extreme (1M+) repo indexes on-demand only (open a subtree to index it).
 */
export function planScopedIndex(fileCount: number): RepoIndexStrategy {
  const n = count(fileCount);
  const scale = classifyRepoScale(n);
  switch (scale) {
    case 'small':
    case 'medium':
      return {
        scale,
        mode: 'full',
        maxIndexedFiles: Math.min(n, FULL_INDEX_CAP),
        lazy: false,
        reason: `${scale} repo (${n.toLocaleString()} files) — full index.`,
      };
    case 'large':
      return {
        scale,
        mode: 'partial',
        maxIndexedFiles: 50_000,
        lazy: false,
        reason: `Large repo (${n.toLocaleString()} files) — partial index (first 50,000).`,
      };
    case 'huge':
      return {
        scale,
        mode: 'scoped',
        maxIndexedFiles: 25_000,
        lazy: true,
        reason: `Huge repo (${n.toLocaleString()} files) — scoped, lazy index of active subtrees.`,
      };
    default:
      return {
        scale,
        mode: 'on-demand',
        maxIndexedFiles: 10_000,
        lazy: true,
        reason: `Extreme repo (${n.toLocaleString()} files) — on-demand indexing only.`,
      };
  }
}

export type WatchMode = 'native' | 'debounced' | 'polling' | 'suspended';

// FS-event rate ceilings (events/second).
export const CALM_RATE = 50;
export const BUSY_RATE = 500;
export const STORM_RATE = 5_000;

export interface WatcherPolicy {
  mode: WatchMode;
  /** Debounce/coalesce window (ms) for batching FS events. */
  debounceMs: number;
  /** Collapse duplicate events for the same path within the window. */
  coalesce: boolean;
  reason: string;
}

/**
 * Tame a watcher storm by the observed FS-event rate: a calm repo uses native
 * events with a light debounce; a busy one debounces harder; a storm drops to
 * periodic polling; a pathological flood suspends watching (manual refresh) so the
 * event loop is never saturated.
 */
export function watcherStormPolicy(eventsPerSec: number): WatcherPolicy {
  const r = Number.isFinite(eventsPerSec) && eventsPerSec > 0 ? eventsPerSec : 0;
  if (r <= CALM_RATE) {
    return { mode: 'native', debounceMs: 50, coalesce: true, reason: 'Calm — native watching.' };
  }
  if (r <= BUSY_RATE) {
    return {
      mode: 'debounced',
      debounceMs: 250,
      coalesce: true,
      reason: `Busy (${Math.round(r)}/s) — debounced watching.`,
    };
  }
  if (r <= STORM_RATE) {
    return {
      mode: 'polling',
      debounceMs: 1_000,
      coalesce: true,
      reason: `Storm (${Math.round(r)}/s) — polling instead of native events.`,
    };
  }
  return {
    mode: 'suspended',
    debounceMs: 5_000,
    coalesce: true,
    reason: `Flood (${Math.round(r)}/s) — watching suspended; refresh manually.`,
  };
}

export interface DegradationPlan {
  scale: RepoScale;
  /** Tree rendering must be virtualized. */
  virtualizeTree: boolean;
  /** Search-as-you-type (vs explicit submit only). */
  liveSearch: boolean;
  /** Build the knowledge graph automatically (vs on request). */
  autoGraphBuild: boolean;
  /** Git status refresh cadence (ms) — longer at scale. */
  gitStatusIntervalMs: number;
  reason: string;
}

/**
 * Which features to gracefully degrade at scale: large repos stop auto-building the
 * knowledge graph, huge/extreme repos also disable search-as-you-type, and Git
 * status polls less often — so the workbench stays responsive rather than stalling.
 */
export function degradationPlan(fileCount: number): DegradationPlan {
  const scale = classifyRepoScale(fileCount);
  switch (scale) {
    case 'small':
      return {
        scale,
        virtualizeTree: true,
        liveSearch: true,
        autoGraphBuild: true,
        gitStatusIntervalMs: 3_000,
        reason: 'Small repo — all features on.',
      };
    case 'medium':
      return {
        scale,
        virtualizeTree: true,
        liveSearch: true,
        autoGraphBuild: true,
        gitStatusIntervalMs: 8_000,
        reason: 'Medium repo — all features on, slower Git polling.',
      };
    case 'large':
      return {
        scale,
        virtualizeTree: true,
        liveSearch: true,
        autoGraphBuild: false,
        gitStatusIntervalMs: 20_000,
        reason: 'Large repo — auto graph build off (build on request).',
      };
    case 'huge':
      return {
        scale,
        virtualizeTree: true,
        liveSearch: false,
        autoGraphBuild: false,
        gitStatusIntervalMs: 45_000,
        reason: 'Huge repo — live search + auto graph off.',
      };
    default:
      return {
        scale,
        virtualizeTree: true,
        liveSearch: false,
        autoGraphBuild: false,
        gitStatusIntervalMs: 90_000,
        reason: 'Extreme repo — minimal background work; index on demand.',
      };
  }
}

/** A compact one-line hardening summary for a repo of the given size. */
export function summarizeRepoHardening(fileCount: number): string {
  const n = count(fileCount);
  const idx = planScopedIndex(n);
  const deg = degradationPlan(n);
  const off: string[] = [];
  if (!deg.liveSearch) off.push('live search');
  if (!deg.autoGraphBuild) off.push('auto graph');
  const offNote = off.length > 0 ? `; ${off.join(' + ')} off` : '';
  return `${idx.scale} · ${n.toLocaleString()} files · ${idx.mode} index${offNote}`;
}

// ---- scoped incremental indexer scheduler (Phase 267 depth) -----------------

/** A file the walker offers up for indexing, with prioritization signals. */
export interface IndexCandidate {
  path: string;
  /** Last-modified epoch ms (larger = more recent). */
  mtime?: number;
  /** Currently open in an editor tab. */
  open?: boolean;
  /** Currently the active editor. */
  active?: boolean;
  /** File size in bytes (used to pack batches by cost). */
  bytes?: number;
}

export interface IndexBatch {
  index: number;
  paths: string[];
  /** Total bytes in this batch (bounded by the byte budget). */
  bytes: number;
}

export interface IndexSchedule {
  scale: RepoScale;
  mode: IndexMode;
  /** Files selected to index (highest priority first, up to the budget). */
  selected: string[];
  /** Files beyond the index budget (indexed later / on demand). */
  deferred: string[];
  batches: IndexBatch[];
  totalBatches: number;
  summary: string;
}

export interface ScheduleOptions {
  /** Max bytes per batch (default 2 MB of source). */
  batchBytes?: number;
  /** Max files per batch (default 500). */
  batchFiles?: number;
  /** Override the index budget (default from planScopedIndex). */
  maxFiles?: number;
}

export const DEFAULT_BATCH_BYTES = 2_000_000;
export const DEFAULT_BATCH_FILES = 500;
/** Assumed size (bytes) for a candidate with no known size. */
const ASSUMED_FILE_BYTES = 4_000;

const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mts',
  'cts',
  'rs',
  'py',
  'go',
  'java',
  'rb',
  'php',
  'cs',
  'c',
  'cpp',
  'h',
  'hpp',
  'css',
  'scss',
  'less',
  'html',
  'json',
  'md',
  'yaml',
  'yml',
  'toml',
]);

function isCodeFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 && CODE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Priority score for an index candidate (higher = index sooner): the active editor
 * ranks highest, then open tabs, then recently-modified files (decaying with age),
 * then source files over other file types.
 */
export function indexPriority(c: IndexCandidate, now: number): number {
  let score = 0;
  if (c.active === true) score += 1000;
  if (c.open === true) score += 500;
  if (typeof c.mtime === 'number' && c.mtime > 0) {
    const ageDays = Math.max(0, (now - c.mtime) / 86_400_000);
    score += Math.max(0, 300 - ageDays * 3);
  }
  if (isCodeFile(c.path)) score += 40;
  return score;
}

/**
 * Plan a scoped, incremental index: rank candidates by priority, select up to the
 * scale-appropriate budget (recency + open files first), and shard the selection
 * into budget-bounded batches so the indexer never does an unbounded chunk of work
 * at once. Deterministic (ties break by path). Pure — the walker/indexer executes it.
 */
export function planIndexSchedule(
  candidates: readonly IndexCandidate[],
  fileCount: number,
  options: ScheduleOptions = {},
  now: number = Date.now(),
): IndexSchedule {
  const strategy = planScopedIndex(fileCount);
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? strategy.maxIndexedFiles));
  const batchBytes =
    options.batchBytes && options.batchBytes > 0 ? options.batchBytes : DEFAULT_BATCH_BYTES;
  const batchFiles =
    options.batchFiles && options.batchFiles > 0
      ? Math.floor(options.batchFiles)
      : DEFAULT_BATCH_FILES;

  const ranked = candidates
    .map((c) => ({ c, score: indexPriority(c, now) }))
    .sort((a, b) => b.score - a.score || (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0));

  const selectedRecs = ranked.slice(0, maxFiles);
  const selected = selectedRecs.map((r) => r.c.path);
  const deferred = ranked.slice(maxFiles).map((r) => r.c.path);

  const batches: IndexBatch[] = [];
  let cur: IndexBatch = { index: 0, paths: [], bytes: 0 };
  for (const r of selectedRecs) {
    const b =
      typeof r.c.bytes === 'number' && r.c.bytes > 0 ? Math.floor(r.c.bytes) : ASSUMED_FILE_BYTES;
    if (cur.paths.length > 0 && (cur.bytes + b > batchBytes || cur.paths.length >= batchFiles)) {
      batches.push(cur);
      cur = { index: batches.length, paths: [], bytes: 0 };
    }
    cur.paths.push(r.c.path);
    cur.bytes += b;
  }
  if (cur.paths.length > 0) batches.push(cur);

  const summary =
    `${strategy.mode} index: ${selected.length}/${candidates.length} file(s) in ` +
    `${batches.length} batch(es)` +
    (deferred.length > 0 ? `, ${deferred.length} deferred` : '');

  return {
    scale: strategy.scale,
    mode: strategy.mode,
    selected,
    deferred,
    batches,
    totalBatches: batches.length,
    summary,
  };
}

/** The next batch to process given how many have completed, or null when done. */
export function nextIndexBatch(schedule: IndexSchedule, completed: number): IndexBatch | null {
  return schedule.batches[completed] ?? null;
}
