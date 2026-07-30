/**
 * Repo Q&A onboarding tour (Phase 263 — Repo Q&A Onboarding).
 *
 * PURE module (no I/O, no Electron). Turns the project-understanding profile
 * (frameworks / languages / entry points / scripts / config) + knowledge-graph
 * hotspots (high fan-in files = the architectural core) into an ordered, guided
 * TOUR a newcomer can walk: an overview, the entry points, key config, and the
 * most-depended-on core files. Graph-grounded so the tour reflects the real code,
 * not a guess. The renderer renders the stops; the caller supplies the inputs from
 * project understanding + graph metrics.
 */

export interface RepoHotspot {
  path: string;
  fanIn: number;
  fanOut: number;
}

export interface RepoTourInput {
  frameworks?: string[];
  languages?: string[];
  entryPoints?: string[];
  scripts?: string[];
  configFiles?: string[];
  hotspots?: RepoHotspot[];
}

export type TourKind = 'overview' | 'entrypoint' | 'config' | 'hotspot';

export interface TourStop {
  order: number;
  kind: TourKind;
  title: string;
  path?: string;
  description: string;
}

export interface RepoTour {
  stops: TourStop[];
  summary: string;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function list(items: readonly string[] | undefined, max: number): string[] {
  return (items ?? []).filter((s) => s.trim().length > 0).slice(0, max);
}

export interface TourOptions {
  maxEntryPoints?: number;
  maxConfig?: number;
  maxHotspots?: number;
}

/**
 * Build a guided architecture tour. Stops are ordered: overview → entry points →
 * config → core hotspots (highest fan-in first). Deterministic.
 */
export function buildRepoTour(input: RepoTourInput, options: TourOptions = {}): RepoTour {
  const stops: TourStop[] = [];
  let order = 0;
  const add = (kind: TourKind, title: string, description: string, path?: string): void => {
    stops.push({
      order: order++,
      kind,
      title,
      description,
      ...(path !== undefined ? { path } : {}),
    });
  };

  // 1) Overview.
  const frameworks = list(input.frameworks, 6);
  const languages = list(input.languages, 6);
  const scripts = list(input.scripts, 8);
  const overviewParts: string[] = [];
  if (languages.length > 0) overviewParts.push(`Languages: ${languages.join(', ')}`);
  if (frameworks.length > 0) overviewParts.push(`Frameworks: ${frameworks.join(', ')}`);
  if (scripts.length > 0) overviewParts.push(`Scripts: ${scripts.join(', ')}`);
  add(
    'overview',
    'Project overview',
    overviewParts.length > 0 ? overviewParts.join(' · ') : 'A code workspace.',
  );

  // 2) Entry points.
  for (const ep of list(input.entryPoints, options.maxEntryPoints ?? 4)) {
    add(
      'entrypoint',
      `Entry point: ${baseName(ep)}`,
      `Execution starts here — trace the app's startup from ${ep}.`,
      ep,
    );
  }

  // 3) Key config.
  for (const cf of list(input.configFiles, options.maxConfig ?? 4)) {
    add('config', `Config: ${baseName(cf)}`, `Project configuration in ${cf}.`, cf);
  }

  // 4) Core hotspots (highest fan-in = most depended on).
  const hotspots = [...(input.hotspots ?? [])]
    .filter((h) => h.path.trim().length > 0)
    .sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path))
    .slice(0, options.maxHotspots ?? 5);
  for (const h of hotspots) {
    add(
      'hotspot',
      `Core module: ${baseName(h.path)}`,
      `Depended on by ${h.fanIn} file(s) (imports ${h.fanOut}) — a central piece; understand it early.`,
      h.path,
    );
  }

  const summary = `${stops.length} stop(s): overview + ${
    stops.filter((s) => s.kind === 'entrypoint').length
  } entry point(s), ${stops.filter((s) => s.kind === 'config').length} config, ${
    stops.filter((s) => s.kind === 'hotspot').length
  } core module(s).`;

  return { stops, summary };
}
