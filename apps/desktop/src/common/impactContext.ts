/**
 * Dependency-aware edit targeting (PRD Epoch G §130 / Phase 194). Pure selector that
 * turns the knowledge graph's dependents (direct importers / call sites) and impacted
 * (transitive blast radius) into an ordered, de-duplicated, budgeted set of context
 * files for the Composer — so a cross-cutting change also updates the sites that
 * depend on it. Dependents come first (most likely to need edits), then the wider
 * impact; the active file itself is excluded. No I/O — unit-tested.
 */

/**
 * Select up to `budgetFiles` workspace-relative paths to include as dependency
 * context, dependents first then impacted, excluding the active file, de-duplicated.
 */
export function selectImpactContext(
  activeRel: string,
  dependents: readonly string[],
  impacted: readonly string[],
  budgetFiles: number,
): string[] {
  if (budgetFiles <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>([activeRel]);
  const add = (p: string): void => {
    const path = p.trim();
    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  };
  for (const d of dependents) add(d);
  for (const i of impacted) add(i);
  return out.slice(0, budgetFiles);
}
