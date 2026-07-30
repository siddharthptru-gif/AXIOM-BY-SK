/**
 * Code-block actions & citations (PRD Epoch G §128.6/§128.7 / Phase 178). Pure
 * helpers to turn an assistant's answer into safe actions: detect the target file
 * a code block declares (a `// path` / `# path` marker on its first line) so it can
 * be created/updated through the Safe Edit Engine, and parse `file:line` citations
 * out of prose so they can be rendered as clickable links. No I/O — unit-tested.
 * Paths are validated to be workspace-relative (no absolute paths, no `..`).
 */

// A relative path segment/word: letters, digits, dot, dash, underscore.
const REL_PATH = /^[\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z][\w]{0,7}$/;

/** True for a safe, workspace-relative path with an extension (no traversal/absolute). */
export function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || p.length > 300) return false;
  if (p.includes('..') || p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false; // windows drive
  return REL_PATH.test(p);
}

/**
 * Detect a target file path declared on the first line of a code block, e.g.
 * `// src/app.ts`, `# scripts/build.py`, `<!-- index.html -->`, or `// file: x.ts`.
 * Returns a safe relative path or null.
 */
export function detectBlockPath(code: string): string | null {
  const firstLine = code.split(/\r?\n/, 1)[0] ?? '';
  const m =
    /^\s*(?:\/\/|#|--|;|<!--)\s*(?:file:\s*)?([\w.\-/]+\.[A-Za-z][\w]{0,7})\s*(?:-->)?\s*$/.exec(
      firstLine,
    );
  if (!m) return null;
  const path = m[1]!;
  return isSafeRelPath(path) ? path : null;
}

/** Drop a leading `// path` / `# path` marker line so it isn't written into the file. */
export function stripPathMarker(code: string): string {
  if (detectBlockPath(code) === null) return code;
  const nl = code.indexOf('\n');
  return nl >= 0 ? code.slice(nl + 1) : '';
}

export interface Citation {
  raw: string;
  file: string;
  line: number;
}

/**
 * Parse `path.ext:line` citations from text (optionally wrapped in backticks). Only
 * matches safe relative paths with a positive line number, so URLs and stray colons
 * do not produce false links. Positions are the match index in the input.
 */
export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const re = /`?([\w.\-]+(?:\/[\w.\-]+)*\.[A-Za-z][\w]{0,7}):(\d+)`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Skip matches that are part of a URL (e.g. http://host:port).
    if (m.index > 0 && text[m.index - 1] === '/') continue;
    const file = m[1]!;
    const line = Number.parseInt(m[2]!, 10);
    if (isSafeRelPath(file) && line > 0 && line < 1_000_000) {
      out.push({ raw: m[0], file, line });
    }
  }
  return out;
}
