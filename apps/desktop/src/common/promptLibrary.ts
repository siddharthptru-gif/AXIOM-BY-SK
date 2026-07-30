/**
 * Prompt library & history core (PRD Epoch H §146 / Phase 234). Reusable prompts
 * with variables, tags, and scope. Pure logic: extract `{{variables}}`, validate a
 * saved prompt, interpolate variables in a SINGLE pass (no recursive template
 * injection), and rank a search. The Main store persists; the renderer inserts.
 * Smoke-tested.
 */
export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
  tags: string[];
  /** Variable names discovered in the body (`{{name}}`). */
  variables: string[];
  scope: 'global' | 'workspace';
  /** Usage count (for surfacing frequently-used prompts). */
  uses: number;
}

const MAX_BODY = 8000;
const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'prompt'
  );
}

/** Unique variable names referenced in a prompt body, in first-seen order. */
export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(VAR_RE)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Sanitize an arbitrary object into a PromptTemplate, or null if unusable. */
export function validatePrompt(raw: unknown): PromptTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = (typeof o.name === 'string' ? o.name : '').trim().slice(0, 80);
  const body = (typeof o.body === 'string' ? o.body : '').trim().slice(0, MAX_BODY);
  if (name.length === 0 || body.length === 0) return null;
  const scope: 'global' | 'workspace' = o.scope === 'workspace' ? 'workspace' : 'global';
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : `${scope}:${slug(name)}`;
  const tags = Array.isArray(o.tags)
    ? Array.from(
        new Set(
          o.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0),
        ),
      ).slice(0, 12)
    : [];
  const usesRaw = Number(o.uses);
  const uses = Number.isFinite(usesRaw) && usesRaw > 0 ? Math.floor(usesRaw) : 0;
  return { id, name, body, tags, variables: extractVariables(body), scope, uses };
}

/**
 * Interpolate `{{var}}` occurrences with provided values in a SINGLE pass, so a
 * value that itself contains `{{...}}` is never re-expanded (injection-safe).
 * Unknown variables are left as-is so the user notices a missing value.
 */
export function interpolatePrompt(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : whole,
  );
}

/**
 * Rank prompts against a query: name-prefix > name-substring > tag > body match.
 * An empty query returns all prompts ordered by usage (desc) then name.
 */
export function searchPrompts(list: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...list].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  }
  const scored: Array<{ p: PromptTemplate; score: number }> = [];
  for (const p of list) {
    const name = p.name.toLowerCase();
    let score = 0;
    if (name.startsWith(q)) score = 100;
    else if (name.includes(q)) score = 60;
    else if (p.tags.some((t) => t.includes(q))) score = 40;
    else if (p.body.toLowerCase().includes(q)) score = 20;
    if (score > 0) scored.push({ p, score: score + Math.min(p.uses, 20) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .map((s) => s.p);
}
