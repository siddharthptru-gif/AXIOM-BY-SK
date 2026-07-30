/**
 * RTL & layout-robustness core (PRD Epoch I §95/§172 / Phase 251). Pure helpers:
 * detect a right-to-left locale, resolve the document direction, and pseudo-localize
 * text (accent + ~40% expansion) to smoke-test that layouts tolerate longer strings
 * and non-Latin glyphs. No I/O — the renderer sets `dir` + applies pseudo-loc in a
 * dev setting. Smoke-tested.
 */
export type Direction = 'ltr' | 'rtl';

/** Base language subtags that are written right-to-left. */
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv']);

/** The base language subtag of a BCP-47 locale (e.g. `ar-EG` → `ar`). */
export function baseLanguage(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Whether a locale is right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return RTL_LANGS.has(baseLanguage(locale));
}

/** Resolve the document direction for a locale. */
export function resolveDirection(locale: string): Direction {
  return isRtlLocale(locale) ? 'rtl' : 'ltr';
}

// Pseudo-localization: map ASCII letters to accented look-alikes so untranslated
// (or clipped) UI stands out, and pad to force ~40% text expansion.
const ACCENT_MAP: Record<string, string> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  c: 'ç',
  n: 'ñ',
  y: 'ý',
  s: 'š',
  z: 'ž',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  C: 'Ç',
  N: 'Ñ',
  Y: 'Ý',
  S: 'Š',
  Z: 'Ž',
};

const PAD = '·';

/**
 * Pseudo-localize a string: accent letters (leaving `{placeholders}` intact) and pad
 * to ~`expansion` fraction longer, wrapped in brackets so truncation is visible.
 */
export function pseudoLocalize(text: string, expansion = 0.4): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i);
      if (end >= 0) {
        out += text.slice(i, end + 1); // keep placeholder verbatim
        i = end + 1;
        continue;
      }
    }
    const ch = text[i] ?? '';
    out += ACCENT_MAP[ch] ?? ch;
    i++;
  }
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const padCount = Math.ceil(letters * expansion);
  const pad = padCount > 0 ? ` ${PAD.repeat(padCount)}` : '';
  return `⟦${out}${pad}⟧`;
}

/** The attributes a root element should carry for a locale (dir + lang). */
export function dirAttributes(locale: string): { dir: Direction; lang: string } {
  return { dir: resolveDirection(locale), lang: baseLanguage(locale) || 'en' };
}
