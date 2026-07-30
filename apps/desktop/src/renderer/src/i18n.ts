import {
  t as translate,
  parseLocale,
  type MessageCatalog,
  type MessageVars,
} from '../../common/i18n';
import { en } from '../../common/locales/en';
import { es } from '../../common/locales/es';
import { mergeCatalog, computeCoverage, type CoverageResult } from '../../common/i18nCoverage';
import { pseudoLocalize } from '../../common/rtl';

/**
 * Renderer i18n binding (PRD Epoch I §95 / Phases 250/251/252). Holds the active
 * locale's catalog and exposes `t(key, vars)` for UI strings; a pseudo-localization
 * dev mode accents + expands every string to smoke-test layout robustness. A
 * non-English locale is MERGED over English so any untranslated key falls back to
 * English (never a raw key); `localeCoverage` reports how complete a locale is.
 */
const CATALOGS: Record<string, MessageCatalog> = { en, es };

let active: MessageCatalog = en;
let pseudo = false;

export function setLocale(code: unknown): void {
  const target = CATALOGS[parseLocale(code)] ?? en;
  active = mergeCatalog(en, target);
}

/** Enable/disable pseudo-localization (a dev/testing aid, off in production). */
export function setPseudoLocale(on: boolean): void {
  pseudo = on;
}

/** Translation coverage of a locale against the English source (for pickers/CI). */
export function localeCoverage(code: unknown): CoverageResult {
  const locale = parseLocale(code);
  return computeCoverage(en, CATALOGS[locale] ?? {}, locale);
}

/** Translate a key (with optional vars) using the active locale catalog. */
export function t(key: string, vars?: MessageVars): string {
  const s = translate(active, key, vars);
  return pseudo ? pseudoLocalize(s) : s;
}
