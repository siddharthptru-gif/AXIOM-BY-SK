/**
 * Knowledge-graph metrics (PRD Epoch C §127). Pure coupling/stability analysis over
 * the file-level import graph: afferent coupling (fan-in, Ca), efferent coupling
 * (fan-out, Ce), instability I = Ce/(Ca+Ce), a stability category, and a hotspot
 * flag from coupling + transitive impact. No I/O — the Dependencies panel feeds it
 * the active file's dependents/dependencies/impact; `rankHotspots` ranks a whole set
 * for a future workspace view. Smoke-tested.
 */

export type StabilityCategory = 'isolated' | 'stable' | 'balanced' | 'unstable';

export interface FileMetrics {
  /** Afferent coupling — files that import this one. */
  fanIn: number;
  /** Efferent coupling — files this one imports. */
  fanOut: number;
  /** fanIn + fanOut. */
  coupling: number;
  /** Instability Ce/(Ca+Ce), 0 (stable) .. 1 (unstable); 0 when isolated. */
  instability: number;
  /** Transitive blast radius (files affected by a change). */
  impact: number;
  category: StabilityCategory;
  hotspot: boolean;
  label: string;
}

/** Total coupling at/above which a file is a hotspot. */
export const HOTSPOT_COUPLING = 12;
/** Transitive impact at/above which a file is a hotspot. */
export const HOTSPOT_IMPACT = 20;

function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function categoryFor(coupling: number, instability: number): StabilityCategory {
  if (coupling === 0) return 'isolated';
  if (instability < 0.3) return 'stable';
  if (instability > 0.7) return 'unstable';
  return 'balanced';
}

function labelFor(category: StabilityCategory, hotspot: boolean): string {
  const base =
    category === 'isolated'
      ? 'Isolated'
      : category === 'stable'
        ? 'Stable — widely depended on'
        : category === 'unstable'
          ? 'Unstable — depends on many'
          : 'Balanced';
  return hotspot ? `Hotspot \u00B7 ${base}` : base;
}

/** Compute coupling/stability metrics for one file from its graph neighborhood. */
export function computeFileMetrics(input: {
  fanIn: number;
  fanOut: number;
  impact?: number;
}): FileMetrics {
  const fanIn = Math.max(0, Math.floor(num(input.fanIn)));
  const fanOut = Math.max(0, Math.floor(num(input.fanOut)));
  const impact = Math.max(0, Math.floor(num(input.impact ?? 0)));
  const coupling = fanIn + fanOut;
  const instability = coupling === 0 ? 0 : round2(fanOut / coupling);
  const category = categoryFor(coupling, instability);
  const hotspot = coupling >= HOTSPOT_COUPLING || impact >= HOTSPOT_IMPACT;
  return {
    fanIn,
    fanOut,
    coupling,
    instability,
    impact,
    category,
    hotspot,
    label: labelFor(category, hotspot),
  };
}

export interface HotspotEntry extends FileMetrics {
  file: string;
}

/**
 * Rank files by total coupling (then impact, then fan-in), returning the top `limit`
 * with full metrics — the most entangled files to review first. Stable ordering.
 */
export function rankHotspots(
  files: ReadonlyArray<{ file: string; fanIn: number; fanOut: number; impact?: number }>,
  limit = 10,
): HotspotEntry[] {
  return files
    .map((f) => ({ file: f.file, ...computeFileMetrics(f) }))
    .sort(
      (a, b) =>
        b.coupling - a.coupling ||
        b.impact - a.impact ||
        b.fanIn - a.fanIn ||
        a.file.localeCompare(b.file),
    )
    .slice(0, Math.max(0, limit));
}
