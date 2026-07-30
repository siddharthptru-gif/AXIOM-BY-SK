/**
 * RLS & Edge security audit — RLS linter (Phase 273 — RLS & Edge Functions Security
 * Audit).
 *
 * PURE module (no I/O, no Electron). A static linter over a Postgres schema
 * DESCRIPTOR (tables + their row-level-security policies): flags tables with RLS
 * disabled (wide open), RLS enabled but no policies (locked out), and policies whose
 * USING/CHECK expression lacks a user-scoping predicate (e.g. `auth.uid()` or a
 * `user_id` column) — i.e. rows not scoped to the requesting user. Complements the
 * live backend audit (which needs a real Supabase project — out of the sandbox) with
 * a schema-level lint. Deterministic.
 */

export type RlsCommand = 'select' | 'insert' | 'update' | 'delete' | 'all';

export interface RlsPolicy {
  name: string;
  command: RlsCommand;
  /** USING expression (row visibility). */
  using?: string;
  /** WITH CHECK expression (row writability). */
  check?: string;
  roles?: string[];
}

export interface RlsTable {
  name: string;
  rlsEnabled: boolean;
  policies: RlsPolicy[];
}

export type RlsSeverity = 'high' | 'medium' | 'low';

export interface RlsFinding {
  table: string;
  policy?: string;
  severity: RlsSeverity;
  issue: string;
}

export interface RlsAuditResult {
  findings: RlsFinding[];
  tablesAudited: number;
  high: number;
  ok: boolean;
  summary: string;
}

/**
 * Parse a Postgres/Supabase SQL schema into RLS table descriptors.
 *
 * PURE + bounded. Recognizes `CREATE TABLE`, `ALTER TABLE ... ENABLE ROW LEVEL
 * SECURITY`, and `CREATE POLICY ... ON ... [FOR cmd] [USING (...)] [WITH CHECK
 * (...)]`. Comments are stripped first. This lets the audit run over the schema
 * files actually present in the selected workspace instead of a hard-coded fixture.
 */
export function parseRlsSchema(sql: string): RlsTable[] {
  const text = String(sql ?? '')
    .slice(0, 500_000)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

  const stripName = (raw: string): string =>
    raw
      .trim()
      .replace(/"/g, '')
      .replace(/^[a-z0-9_]+\./i, '')
      .toLowerCase();

  const tables = new Map<string, RlsTable>();
  const ensure = (name: string): RlsTable => {
    const key = stripName(name);
    let table = tables.get(key);
    if (!table) {
      table = { name: key, rlsEnabled: false, policies: [] };
      tables.set(key, table);
    }
    return table;
  };

  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?("?[a-z0-9_.]+"?)/gi;
  for (let m = createTable.exec(text); m; m = createTable.exec(text)) ensure(m[1]!);

  const enableRls =
    /alter\s+table\s+(?:only\s+)?("?[a-z0-9_.]+"?)\s+enable\s+row\s+level\s+security/gi;
  for (let m = enableRls.exec(text); m; m = enableRls.exec(text)) ensure(m[1]!).rlsEnabled = true;

  const forceRls =
    /alter\s+table\s+(?:only\s+)?("?[a-z0-9_.]+"?)\s+force\s+row\s+level\s+security/gi;
  for (let m = forceRls.exec(text); m; m = forceRls.exec(text)) ensure(m[1]!).rlsEnabled = true;

  const commandOf = (raw: string | undefined): RlsCommand => {
    const c = (raw ?? 'all').trim().toLowerCase();
    return c === 'select' || c === 'insert' || c === 'update' || c === 'delete' ? c : 'all';
  };
  const balancedExpr = (source: string, open: number): string | undefined => {
    if (source[open] !== '(') return undefined;
    let depth = 0;
    for (let i = open; i < source.length && i < open + 4_000; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0)
          return source
            .slice(open + 1, i)
            .replace(/\s+/g, ' ')
            .trim();
      }
    }
    return undefined;
  };

  const policy =
    /create\s+policy\s+("?[^"\s]+"?|'[^']+')\s+on\s+(?:only\s+)?("?[a-z0-9_.]+"?)([\s\S]{0,1200}?)(?=;|create\s+policy|create\s+table|alter\s+table|$)/gi;
  for (let m = policy.exec(text); m; m = policy.exec(text)) {
    const policyName = m[1]!.replace(/["']/g, '').trim();
    const table = ensure(m[2]!);
    const body = m[3] ?? '';
    const forMatch = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(body);
    const usingIdx = body.search(/\busing\s*\(/i);
    const checkIdx = body.search(/\bwith\s+check\s*\(/i);
    const entry: RlsPolicy = { name: policyName, command: commandOf(forMatch?.[1]) };
    if (usingIdx >= 0) {
      const paren = body.indexOf('(', usingIdx);
      const expr = balancedExpr(body, paren);
      if (expr !== undefined) entry.using = expr;
    }
    if (checkIdx >= 0) {
      const paren = body.indexOf('(', checkIdx);
      const expr = balancedExpr(body, paren);
      if (expr !== undefined) entry.check = expr;
    }
    // A table with a policy has RLS in effect even if the ENABLE statement lives elsewhere.
    table.rlsEnabled = true;
    table.policies.push(entry);
  }

  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Does an expression scope rows to the requesting user? */
function isUserScoped(expr: string | undefined): boolean {
  if (expr === undefined) return false;
  const e = expr.toLowerCase();
  if (e.trim() === 'true' || e.trim() === '') return false;
  return (
    e.includes('auth.uid()') ||
    e.includes('auth.jwt()') ||
    /\buser_?id\b/.test(e) ||
    /\bowner_?id\b/.test(e) ||
    e.includes('auth.role()')
  );
}

const SEV_RANK: Record<RlsSeverity, number> = { high: 2, medium: 1, low: 0 };

/** Lint a schema's RLS configuration. */
export function auditRls(tables: readonly RlsTable[]): RlsAuditResult {
  const findings: RlsFinding[] = [];
  for (const t of tables) {
    if (!t.rlsEnabled) {
      findings.push({
        table: t.name,
        severity: 'high',
        issue: 'RLS is disabled — the table is readable/writable by anyone with the anon key.',
      });
      continue; // policies don't apply while RLS is off
    }
    if (t.policies.length === 0) {
      findings.push({
        table: t.name,
        severity: 'medium',
        issue: 'RLS enabled but no policies — denies all access (likely misconfigured).',
      });
      continue;
    }
    for (const p of t.policies) {
      // A read/all policy whose USING isn't user-scoped may expose every row.
      if ((p.command === 'select' || p.command === 'all') && !isUserScoped(p.using)) {
        findings.push({
          table: t.name,
          policy: p.name,
          severity: 'high',
          issue: `Policy "${p.name}" (${p.command}) USING is not user-scoped — may expose all rows.`,
        });
      }
      // A write policy without a WITH CHECK (or an unscoped one) may allow writing others' rows.
      if (
        (p.command === 'insert' || p.command === 'update' || p.command === 'all') &&
        !isUserScoped(p.check)
      ) {
        findings.push({
          table: t.name,
          policy: p.name,
          severity: 'high',
          issue: `Policy "${p.name}" (${p.command}) WITH CHECK is not user-scoped — may allow writing others' rows.`,
        });
      }
    }
  }
  findings.sort(
    (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.table.localeCompare(b.table),
  );
  const high = findings.filter((f) => f.severity === 'high').length;
  const ok = findings.length === 0;
  const summary =
    tables.length === 0
      ? 'RLS audit: no tables to audit.'
      : `RLS audit: ${ok ? 'PASS' : 'FAIL'} — ${tables.length} table(s), ${findings.length} finding(s)` +
        (high > 0 ? ` (${high} high)` : '') +
        '.';
  return { findings, tablesAudited: tables.length, high, ok, summary };
}
