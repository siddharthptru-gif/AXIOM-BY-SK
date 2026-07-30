import { matchesGlob } from './workflows';

/**
 * Workspace rules & coding standards core (PRD Epoch H §145 / Phase 233). Team/user
 * rules that shape AI generation and review: parse `.axiom/rules/*.md` (+ global),
 * scope them by glob + priority, and compose them into an injectable prompt section
 * where GUARDRAIL rules are non-overridable (always included, marked as such). Pure
 * logic only — the Main service loads files, the renderer manages them. Smoke-tested.
 */
export interface Rule {
  id: string;
  name: string;
  /** Optional glob (relative path) restricting where the rule applies. */
  scope?: string;
  /** Higher = more important; ties break by name. */
  priority: number;
  /** The rule text injected into generation/review prompts. */
  body: string;
  /** Non-overridable guardrail — always included regardless of scope. */
  guardrail?: boolean;
  /** Where the rule came from (for display + precedence). */
  source: 'workspace' | 'global';
}

const MAX_BODY = 8000;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'rule'
  );
}

/** Parse a lightweight frontmatter block (`--- key: value --- `) from the top. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv && kv[1]) meta[kv[1].toLowerCase()] = (kv[2] ?? '').trim();
  }
  return { meta, body: (m[2] ?? '').trim() };
}

/**
 * Parse a rule markdown file into a Rule. Frontmatter keys: `name`, `scope` (glob),
 * `priority` (number), `guardrail` (true/false). Missing name falls back to the
 * file name; missing body yields null (nothing to inject).
 */
export function parseRuleFile(
  text: string,
  opts: { fileName: string; source: 'workspace' | 'global' },
): Rule | null {
  const { meta, body } = parseFrontmatter(text);
  const cleanBody = body.trim().slice(0, MAX_BODY);
  if (cleanBody.length === 0) return null;
  const baseName = opts.fileName.replace(/\.[^.]+$/, '');
  const name = (meta.name && meta.name.length > 0 ? meta.name : baseName).slice(0, 80);
  const priorityRaw = Number(meta.priority);
  const priority = Number.isFinite(priorityRaw)
    ? priorityRaw
    : opts.source === 'workspace'
      ? 100
      : 50;
  const rule: Rule = {
    id: `${opts.source}:${slug(name)}`,
    name,
    priority,
    body: cleanBody,
    source: opts.source,
  };
  if (meta.scope && meta.scope.length > 0) rule.scope = meta.scope;
  if (meta.guardrail === 'true') rule.guardrail = true;
  return rule;
}

interface RuleMatchPath {
  value: string;
  caseInsensitive: boolean;
}

function normalizeRulePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]:)\//.exec(slashed);
  const prefix = drive
    ? `${drive[1]}/`
    : slashed.startsWith('//')
      ? '//'
      : slashed.startsWith('/')
        ? '/'
        : '';
  const rest = drive
    ? slashed.slice(drive[0].length)
    : prefix
      ? slashed.slice(prefix.length)
      : slashed;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!prefix) segments.push(segment);
    } else {
      segments.push(segment);
    }
  }
  return `${prefix}${segments.join('/')}`;
}

function isAbsoluteRulePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function isWindowsRulePath(path: string): boolean {
  return path.startsWith('//') || /^[A-Za-z]:\//.test(path);
}

/** Resolve an active file to a safe workspace-relative, forward-slash path. */
function ruleMatchPath(activePath: string, workspaceRoot?: string): RuleMatchPath | null {
  const active = normalizeRulePath(activePath);
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    return { value: active, caseInsensitive: false };
  }

  const root = normalizeRulePath(workspaceRoot);
  const caseInsensitive = isWindowsRulePath(root);
  if (!isAbsoluteRulePath(active)) {
    if (active === '..' || active.startsWith('../')) return null;
    return { value: active, caseInsensitive };
  }

  const comparedActive = caseInsensitive ? active.toLowerCase() : active;
  const comparedRoot = caseInsensitive ? root.toLowerCase() : root;
  if (comparedActive === comparedRoot) return { value: '', caseInsensitive };
  const boundary = comparedRoot.endsWith('/') ? comparedRoot : `${comparedRoot}/`;
  if (!comparedActive.startsWith(boundary)) return null;
  return { value: active.slice(boundary.length), caseInsensitive };
}

/**
 * Select the rules that apply for the active file: every guardrail, every unscoped
 * rule, and any scoped rule whose glob matches. When a workspace root is supplied,
 * an absolute active path must be inside that root at a separator boundary and is
 * matched as a relative forward-slash path. Windows drive/UNC paths are compared
 * case-insensitively. The optional root preserves existing two-argument callers.
 * Results are sorted guardrails-first, then by priority (desc), then name.
 */
export function selectRules(
  rules: readonly Rule[],
  activePath?: string,
  workspaceRoot?: string,
): Rule[] {
  const matchPath = activePath === undefined ? null : ruleMatchPath(activePath, workspaceRoot);
  const applies = (r: Rule): boolean => {
    if (r.guardrail || !r.scope) return true;
    if (!matchPath) return false;
    const scope = matchPath.caseInsensitive ? r.scope.toLowerCase() : r.scope;
    const path = matchPath.caseInsensitive ? matchPath.value.toLowerCase() : matchPath.value;
    return matchesGlob(scope, path);
  };
  return rules.filter(applies).sort((a, b) => {
    const ag = a.guardrail ? 1 : 0;
    const bg = b.guardrail ? 1 : 0;
    if (ag !== bg) return bg - ag;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Compose selected rules into a system-prompt section. Guardrail rules are marked
 * NON-OVERRIDABLE so the model treats them as hard constraints (§145). Returns an
 * empty string when there are no rules.
 */
export function composeRulesPrompt(selected: readonly Rule[]): string {
  if (selected.length === 0) return '';
  const lines: string[] = [
    'The user has configured these workspace rules and coding standards. Follow them.',
  ];
  for (const r of selected) {
    const tag = r.guardrail ? ' (NON-OVERRIDABLE guardrail)' : '';
    lines.push(`\n## ${r.name}${tag}\n${r.body}`);
  }
  return lines.join('\n');
}

/** Convert an imported AGENTS.md / .cursorrules file into a Rule (workspace scope). */
export function ruleFromImport(fileName: string, text: string): Rule | null {
  const body = text.trim().slice(0, MAX_BODY);
  if (body.length === 0) return null;
  const name = `Imported: ${fileName}`.slice(0, 80);
  return { id: `workspace:${slug(name)}`, name, priority: 90, body, source: 'workspace' };
}

/** Sanitize an arbitrary object into a Rule (for the store), or null if unusable. */
export function validateRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = (typeof o.name === 'string' ? o.name : '').trim().slice(0, 80);
  const body = (typeof o.body === 'string' ? o.body : '').trim().slice(0, MAX_BODY);
  if (name.length === 0 || body.length === 0) return null;
  const source: 'workspace' | 'global' = o.source === 'workspace' ? 'workspace' : 'global';
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : `${source}:${slug(name)}`;
  const priorityRaw = Number(o.priority);
  const priority = Number.isFinite(priorityRaw) ? priorityRaw : source === 'workspace' ? 100 : 50;
  const rule: Rule = { id, name, priority, body, source };
  if (typeof o.scope === 'string' && o.scope.trim().length > 0) rule.scope = o.scope.trim();
  if (o.guardrail === true) rule.guardrail = true;
  return rule;
}
