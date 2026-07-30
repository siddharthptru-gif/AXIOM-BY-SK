import type { MessageCatalog } from './i18n';

/**
 * Localization coverage + MT/human-review workflow (PRD Epoch I §95 / Phase 252).
 * Pure tooling over message catalogs: measure a target locale's coverage against
 * the English source, list missing / extra keys, build a human-review queue (each
 * untranslated key carries the source string as an MT-suggested placeholder to
 * review), and MERGE a target over English so untranslated keys fall back to
 * English rather than showing a raw key. No I/O — the renderer merges catalogs at
 * locale select; CI/dev tools consume the coverage. Smoke-tested. This is the
 * localization pipeline scaffold; shipping fully-translated locales is ongoing.
 */

export interface CoverageResult {
  locale: string;
  totalKeys: number;
  translatedKeys: number;
  /** Base keys absent or empty in the target. */
  missingKeys: string[];
  /** Target keys not present in the base (likely stale / typos). */
  extraKeys: string[];
  /** 0..1 fraction of base keys with a non-empty target string. */
  coverage: number;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Measure a target locale's coverage against the English base catalog. */
export function computeCoverage(
  base: MessageCatalog,
  target: MessageCatalog,
  locale = 'target',
): CoverageResult {
  const baseKeys = Object.keys(base);
  const missingKeys: string[] = [];
  let translatedKeys = 0;
  for (const k of baseKeys) {
    if (nonEmpty(target[k])) translatedKeys++;
    else missingKeys.push(k);
  }
  const extraKeys = Object.keys(target).filter((k) => !(k in base));
  const totalKeys = baseKeys.length;
  return {
    locale,
    totalKeys,
    translatedKeys,
    missingKeys: missingKeys.sort(),
    extraKeys: extraKeys.sort(),
    coverage: totalKeys === 0 ? 1 : translatedKeys / totalKeys,
  };
}

/**
 * Merge a target locale over the English base so untranslated (missing/empty) keys
 * fall back to English. Non-empty target strings win; the base's keys are always
 * present, and any extra target keys are carried through too.
 */
export function mergeCatalog(base: MessageCatalog, target: MessageCatalog): MessageCatalog {
  const out: MessageCatalog = { ...base };
  for (const [k, v] of Object.entries(target)) {
    if (nonEmpty(v)) out[k] = v;
  }
  return out;
}

export type ReviewStatus = 'missing' | 'untranslated-copy';

export interface ReviewItem {
  key: string;
  /** The English source string. */
  source: string;
  /** MT-suggested placeholder to review (the source, until a real MT step runs). */
  suggestion: string;
  status: ReviewStatus;
}

/**
 * Build the human-review queue for a target locale: every base key that is missing
 * from the target, plus keys whose target value is an identical copy of the source
 * (likely untranslated). Each item carries an MT-suggested placeholder to review.
 */
export function buildReviewQueue(base: MessageCatalog, target: MessageCatalog): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const [key, source] of Object.entries(base)) {
    const tv = target[key];
    if (!nonEmpty(tv)) {
      items.push({ key, source, suggestion: source, status: 'missing' });
    } else if (tv.trim() === source.trim()) {
      items.push({ key, source, suggestion: source, status: 'untranslated-copy' });
    }
  }
  return items.sort((a, b) => a.key.localeCompare(b.key));
}

/** A compact coverage summary for a locale (e.g. a locale picker or CI log). */
export function formatCoverage(c: CoverageResult): string {
  const pct = Math.round(c.coverage * 100);
  const miss = c.missingKeys.length > 0 ? `, ${c.missingKeys.length} missing` : '';
  return `${c.locale}: ${pct}% (${c.translatedKeys}/${c.totalKeys} keys${miss})`;
}
