/**
 * i18n infrastructure (PRD Epoch I §95 / Phase 250). Pure localization core: a
 * message catalog (key → template), ICU-subset interpolation ({var} + {n, plural,
 * one {…} other {…}}), a `t()` lookup with fallback, and a lint that flags
 * user-facing hard-coded strings. No I/O — the renderer selects a locale + calls t.
 * Smoke-tested. (More locales + full ICU are future; this is the pipeline + gate.)
 */
export type MessageCatalog = Record<string, string>;

export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES: readonly string[] = ['en', 'es'];

/** Coerce input to a supported locale code (default 'en'). */
export function parseLocale(value: unknown): string {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

export type MessageVars = Record<string, string | number>;

/** Parse plural branches (`one {…} other {…}` / `=0 {…}`) with balanced braces. */
function parseBranches(body: string): Record<string, string> {
  const branches: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    const km = /^(=\d+|zero|one|two|few|many|other)/.exec(body.slice(i));
    if (!km || km[0] === undefined) break;
    const key = km[0];
    i += key.length;
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    if (body[i] !== '{') break;
    let depth = 0;
    let content = '';
    for (; i < body.length; i++) {
      const c = body[i] ?? '';
      if (c === '{') {
        depth++;
        if (depth === 1) continue;
        content += c;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
        content += c;
      } else {
        content += c;
      }
    }
    branches[key] = content;
  }
  return branches;
}

/**
 * Interpolate a message template: resolve `{n, plural, …}` blocks (# → the number),
 * and substitute simple `{var}` placeholders. Uses a brace-balanced scanner so a
 * plural branch may itself contain `{var}` placeholders. Unknown vars are kept as-is.
 */
export function interpolate(message: string, vars: MessageVars = {}): string {
  let result = '';
  let i = 0;
  while (i < message.length) {
    if (message[i] !== '{') {
      result += message[i];
      i++;
      continue;
    }
    // Find the matching close brace by balance.
    let depth = 0;
    let end = -1;
    for (let j = i; j < message.length; j++) {
      if (message[j] === '{') depth++;
      else if (message[j] === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      result += message.slice(i);
      break;
    }
    const inner = message.slice(i + 1, end);
    const pm = /^\s*(\w+)\s*,\s*plural\s*,\s*([\s\S]*)$/.exec(inner);
    if (pm && pm[1] !== undefined && pm[2] !== undefined) {
      const name = pm[1];
      const n = Number(vars[name]);
      const branches = parseBranches(pm[2]);
      let key: string;
      if (!Number.isFinite(n)) key = 'other';
      else if (branches[`=${n}`] !== undefined) key = `=${n}`;
      else key = n === 1 ? 'one' : 'other';
      const chosen = (branches[key] ?? branches.other ?? '').replace(
        /#/g,
        Number.isFinite(n) ? String(n) : '',
      );
      result += interpolate(chosen, vars);
    } else {
      const key = inner.trim();
      result += Object.prototype.hasOwnProperty.call(vars, key)
        ? String(vars[key])
        : message.slice(i, end + 1);
    }
    i = end + 1;
  }
  return result;
}

/**
 * Look up a key in the catalog and interpolate. Missing keys FALL BACK to the key
 * itself (so a missing translation is visible, never a crash).
 */
export function t(catalog: MessageCatalog, key: string, vars?: MessageVars): string {
  const message = catalog[key];
  if (message === undefined) return key;
  return interpolate(message, vars ?? {});
}

export interface HardCodedFinding {
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute';
}

const JSX_TEXT_RE = />\s*([A-Za-z][A-Za-z0-9 ,.!?'’-]{4,})\s*</;
const ATTR_RE = /\b(?:placeholder|title|aria-label|label|alt)\s*=\s*(["'])([A-Za-z][^"']{4,})\1/;

/**
 * Lint for user-facing hard-coded strings (the i18n gate). Heuristic: JSX text with
 * 2+ words, and title/placeholder/aria-label/alt string attributes — reported when
 * not already wrapped by a `t(` call on that line. Meant to catch un-externalized UI
 * copy in review/CI; import/comment lines are ignored.
 */
export function detectHardCodedStrings(source: string): HardCodedFinding[] {
  const lines = source.split(/\r?\n/);
  const findings: HardCodedFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import '))
      continue;
    if (line.includes('t(')) continue; // already localized on this line
    const jsx = JSX_TEXT_RE.exec(line);
    if (jsx && jsx[1] && /\S\s+\S/.test(jsx[1])) {
      findings.push({ line: i + 1, text: jsx[1].trim(), kind: 'jsx-text' });
      continue;
    }
    const attr = ATTR_RE.exec(line);
    if (attr && attr[2] && /\S\s+\S/.test(attr[2])) {
      findings.push({ line: i + 1, text: attr[2].trim(), kind: 'attribute' });
    }
  }
  return findings;
}
