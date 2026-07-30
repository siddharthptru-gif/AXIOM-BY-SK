// Component accessibility audit (PRD Epoch I / Phase 253 — Component A11y Audit &
// Fixes). Pure — no I/O, no DOM — so it runs in Main or the renderer and is easy
// to unit-test. It inspects *descriptors* of UI components (role, accessible
// name, tabindex, focus order, live-region intent) and reports ARIA / keyboard
// issues with a severity, a concrete fix, and an overall score.
//
// This is a static, descriptor-level pass — it complements, but does not replace,
// a full runtime axe scan + manual screen-reader testing (which remain the
// out-of-sandbox part of Phase 253/254).

export type Severity = 'error' | 'warn' | 'info';

/** A description of one UI component to audit. All fields but `id` optional. */
export interface ComponentDescriptor {
  id: string;
  /** ARIA (or implicit) role, e.g. 'button', 'listbox', 'option'. */
  role?: string;
  /** Accessible name (aria-label / labelled text). */
  name?: string;
  /** tabindex value, if set. */
  tabIndex?: number;
  /** Is it an interactive control (clickable / operable)? */
  interactive?: boolean;
  /** Intended position in the focus order (for duplicate detection). */
  focusOrder?: number;
  /** Is it meant to announce dynamic updates? */
  liveRegion?: boolean;
  /** Is aria-hidden set? */
  ariaHidden?: boolean;
}

export interface A11yFinding {
  /** The offending component's id. */
  id: string;
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
}

export interface A11yAuditResult {
  findings: A11yFinding[];
  errors: number;
  warnings: number;
  infos: number;
  /**
   * 100 minus weighted penalties, clamped to [0, 100]. `null` when nothing was
   * assessed (no components) — an empty scan is "not assessed", never a perfect score.
   */
  score: number | null;
  /** True when at least one component was inspected. */
  assessed: boolean;
  /** Components audited. */
  total: number;
}

const NAME_REQUIRED_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'option',
  'textbox',
  'combobox',
  'switch',
]);
const LIVE_ROLES = new Set(['status', 'alert', 'log']);

function hasName(c: ComponentDescriptor): boolean {
  return typeof c.name === 'string' && c.name.trim().length > 0;
}

function needsName(c: ComponentDescriptor): boolean {
  if (c.interactive === true) return true;
  return c.role !== undefined && NAME_REQUIRED_ROLES.has(c.role);
}

function isFocusable(c: ComponentDescriptor): boolean {
  if (c.interactive === true) return true;
  return c.tabIndex !== undefined && c.tabIndex >= 0;
}

function isLiveRole(role: string | undefined): boolean {
  return role !== undefined && LIVE_ROLES.has(role);
}

function label(c: ComponentDescriptor): string {
  const r = c.role !== undefined && c.role.length > 0 ? c.role : 'element';
  return `<${r} #${c.id}>`;
}

/**
 * Audit a set of component descriptors. Findings are grouped by component (input
 * order) with a fixed rule order, so the result is deterministic.
 */
export function auditComponents(components: ComponentDescriptor[]): A11yAuditResult {
  const findings: A11yFinding[] = [];

  // Pre-count focus-order positions to detect ambiguous/duplicate ordering.
  const focusCounts = new Map<number, number>();
  for (const c of components) {
    if (c.focusOrder !== undefined) {
      focusCounts.set(c.focusOrder, (focusCounts.get(c.focusOrder) ?? 0) + 1);
    }
  }

  for (const c of components) {
    if (needsName(c) && !hasName(c)) {
      findings.push({
        id: c.id,
        rule: 'missing-name',
        severity: 'error',
        message: `${label(c)} has no accessible name.`,
        fix: 'Add an aria-label or visible, associated text content.',
      });
    }
    if (c.interactive === true && (c.role === undefined || c.role.trim().length === 0)) {
      findings.push({
        id: c.id,
        rule: 'missing-role',
        severity: 'warn',
        message: `${label(c)} is interactive but has no role.`,
        fix: 'Assign an ARIA role (e.g. role="button") or use a native control.',
      });
    }
    if (c.tabIndex !== undefined && c.tabIndex > 0) {
      findings.push({
        id: c.id,
        rule: 'positive-tabindex',
        severity: 'warn',
        message: `${label(c)} uses a positive tabindex (${c.tabIndex}).`,
        fix: 'Use tabindex 0 or -1 and rely on DOM order for the tab sequence.',
      });
    }
    if (c.ariaHidden === true && isFocusable(c)) {
      findings.push({
        id: c.id,
        rule: 'hidden-focusable',
        severity: 'error',
        message: `${label(c)} is focusable but aria-hidden (a focus trap for AT users).`,
        fix: 'Remove aria-hidden, or make the element non-focusable.',
      });
    }
    if (c.liveRegion === true && !isLiveRole(c.role)) {
      findings.push({
        id: c.id,
        rule: 'missing-live-region',
        severity: 'warn',
        message: `${label(c)} announces updates but is not marked as a live region.`,
        fix: 'Add role="status"/"alert" or an aria-live attribute.',
      });
    }
    if (c.focusOrder !== undefined && (focusCounts.get(c.focusOrder) ?? 0) > 1) {
      findings.push({
        id: c.id,
        rule: 'duplicate-focus-order',
        severity: 'warn',
        message: `${label(c)} shares focus order ${c.focusOrder} with another component.`,
        fix: 'Give each focusable component a unique focus-order position.',
      });
    }
  }

  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors += 1;
    else if (f.severity === 'warn') warnings += 1;
    else infos += 1;
  }
  const penalty = errors * 10 + warnings * 4 + infos * 1;
  const assessed = components.length > 0;
  const score = assessed ? Math.max(0, Math.min(100, 100 - penalty)) : null;
  return { findings, errors, warnings, infos, score, assessed, total: components.length };
}

/** One-line summary for a status bar / panel header. */
export function formatA11ySummary(r: A11yAuditResult): string {
  if (!r.assessed || r.score === null) {
    return 'Not assessed — no components were found to audit.';
  }
  return (
    `Score ${r.score}/100 — ${r.errors} error${r.errors === 1 ? '' : 's'}, ` +
    `${r.warnings} warning${r.warnings === 1 ? '' : 's'}`
  );
}
