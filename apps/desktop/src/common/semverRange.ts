/**
 * Semver range satisfaction for the subset that VS Code extension manifests use.
 *
 * Every extension declares `engines.vscode`, almost always as `^1.80.0`, sometimes
 * `>=1.75.0`, occasionally `*`. AXIOM has to answer one question from that string:
 * would this extension consider our API level acceptable? Answering it wrongly in the
 * permissive direction installs extensions that will misbehave; answering it wrongly
 * in the strict direction hides extensions that would have worked.
 *
 * This is a deliberately small evaluator rather than a dependency, because the input
 * space is small and closed: comparator sets joined by `||`, where each comparator is
 * `^`, `~`, `>`, `>=`, `<`, `<=`, `=` or a bare/partial version. Anything outside that
 * grammar is reported as unparseable so the caller can decide, instead of being
 * silently treated as "satisfied".
 *
 * Pure: no I/O, fully unit-testable.
 */
import { compareVersions, parseSemver } from './extensionRegistryIndex';

export type RangeOperator = '^' | '~' | '>' | '>=' | '<' | '<=' | '=';

export interface Comparator {
  operator: RangeOperator;
  version: string;
}

/** A parsed range: satisfied when ANY clause is satisfied (`||` semantics). */
export interface ParsedRange {
  /** Each clause is a set of comparators that must ALL hold. */
  clauses: Comparator[][];
  /** True for `*` / `x` / an empty range, which accept anything. */
  wildcard: boolean;
}

const COMPARATOR_RE =
  /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+]([0-9A-Za-z.-]+))?$/;
/** Ranges longer than this are pathological rather than real manifests. */
const MAX_RANGE_LENGTH = 256;

function isWildcardPart(part: string | undefined): boolean {
  return part === undefined || part === 'x' || part === 'X' || part === '*';
}

/**
 * Normalize a partial version to a full one.
 *
 * `1` becomes `1.0.0` and `1.2` becomes `1.2.0`, matching how npm treats partials as
 * the lower bound of the omitted range.
 */
function normalize(major: string, minor?: string, patch?: string, prerelease?: string): string {
  const core = [
    isWildcardPart(major) ? '0' : major,
    isWildcardPart(minor) ? '0' : (minor ?? '0'),
    isWildcardPart(patch) ? '0' : (patch ?? '0'),
  ].join('.');
  return prerelease ? `${core}-${prerelease}` : core;
}

/**
 * Parse a range string, or return null when it uses grammar this evaluator does not
 * implement. Null means "unknown", never "matches".
 */
export function parseRange(raw: string): ParsedRange | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length > MAX_RANGE_LENGTH) return null;
  if (text === '' || text === '*' || text === 'x' || text === 'X') {
    return { clauses: [], wildcard: true };
  }
  const clauses: Comparator[][] = [];
  for (const rawClause of text.split('||')) {
    const clause = rawClause.trim();
    if (clause === '') return null;
    // Hyphen ranges (`1.2.3 - 2.0.0`) expand to a lower and an upper bound.
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause);
    if (hyphen) {
      const lower = parseComparator(`>=${hyphen[1]}`);
      const upper = parseComparator(`<=${hyphen[2]}`);
      if (!lower || !upper) return null;
      clauses.push([...lower, ...upper]);
      continue;
    }
    const comparators: Comparator[] = [];
    let sawWildcard = false;
    for (const token of clause.split(/\s+/)) {
      if (token === '*' || token === 'x' || token === 'X') {
        sawWildcard = true;
        continue;
      }
      const comparator = parseComparator(token);
      if (!comparator) return null;
      comparators.push(...comparator);
    }
    if (comparators.length === 0) {
      if (!sawWildcard) return null;
      return { clauses: [], wildcard: true };
    }
    clauses.push(comparators);
  }
  return clauses.length === 0 ? null : { clauses, wildcard: false };
}

/**
 * Parse one comparator token into the comparators it means.
 *
 * A single token can imply two bounds, which is why this returns a list. Partial
 * versions are the reason: `1.x` is not `^1.0.0` and not `~1.0.0` — it is
 * `>=1.0.0 <2.0.0`, and the difference matters for `0.x`, where caret semantics would
 * collapse to a single patch release. Expanding partials into explicit bounds keeps each
 * case correct instead of approximating it with the nearest sugar operator.
 */
function parseComparator(token: string): Comparator[] | null {
  const match = COMPARATOR_RE.exec(token.trim());
  if (!match) return null;
  const [, operator, major, minor, patch, prerelease] = match;
  if (major === undefined) return null;
  if (isWildcardPart(major)) return [];

  const majorNumber = Number.parseInt(major, 10);
  if (!Number.isFinite(majorNumber)) return null;
  const minorWildcard = isWildcardPart(minor);
  const patchWildcard = isWildcardPart(patch);
  const version = normalize(major, minor, patch, prerelease);

  // Partial versions describe a span, whatever sugar precedes them.
  if (minorWildcard || patchWildcard) {
    if (operator === '>' || operator === '>=' || operator === '<' || operator === '<=') {
      return [{ operator, version }];
    }
    const ceiling = minorWildcard
      ? `${majorNumber + 1}.0.0`
      : `${majorNumber}.${Number.parseInt(minor ?? '0', 10) + 1}.0`;
    return [
      { operator: '>=', version },
      { operator: '<', version: ceiling },
    ];
  }

  const resolved: RangeOperator = operator === undefined ? '=' : (operator as RangeOperator);
  return [{ operator: resolved, version }];
}

/** Upper bound (exclusive) implied by `^`: the next version that may break API. */
function caretCeiling(version: string): string {
  const { parts } = parseSemver(version);
  const [major = 0, minor = 0] = parts;
  if (major > 0) return `${major + 1}.0.0`;
  if (minor > 0) return `0.${minor + 1}.0`;
  // `^0.0.z` allows only that patch, matching npm.
  return `0.0.${(parts[2] ?? 0) + 1}`;
}

/** Upper bound (exclusive) implied by `~`: the next minor. */
function tildeCeiling(version: string): string {
  const { parts } = parseSemver(version);
  const [major = 0, minor = 0] = parts;
  return `${major}.${minor + 1}.0`;
}

function satisfiesComparator(version: string, comparator: Comparator): boolean {
  const compared = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '=':
      return compared === 0;
    case '>':
      return compared > 0;
    case '>=':
      return compared >= 0;
    case '<':
      return compared < 0;
    case '<=':
      return compared <= 0;
    case '^':
      return compared >= 0 && compareVersions(version, caretCeiling(comparator.version)) < 0;
    case '~':
      return compared >= 0 && compareVersions(version, tildeCeiling(comparator.version)) < 0;
    default:
      return false;
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * Returns null when the range could not be parsed, so callers must decide explicitly
 * what an unknown range means for them rather than inheriting a default.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseRange(range);
  if (!parsed) return null;
  if (parsed.wildcard) return true;
  return parsed.clauses.some((clause) =>
    clause.every((comparator) => satisfiesComparator(version, comparator)),
  );
}

/**
 * The lowest version a range would accept, used to explain compatibility in the UI
 * ("needs VS Code 1.84 or newer"). Null when there is no lower bound to report.
 */
export function minimumForRange(range: string): string | null {
  const parsed = parseRange(range);
  if (!parsed || parsed.wildcard) return null;
  let lowest: string | null = null;
  for (const clause of parsed.clauses) {
    let clauseLowest: string | null = null;
    for (const comparator of clause) {
      if (comparator.operator === '<' || comparator.operator === '<=') continue;
      if (clauseLowest === null || compareVersions(comparator.version, clauseLowest) < 0) {
        clauseLowest = comparator.version;
      }
    }
    if (clauseLowest === null) return null;
    if (lowest === null || compareVersions(clauseLowest, lowest) < 0) lowest = clauseLowest;
  }
  return lowest;
}
