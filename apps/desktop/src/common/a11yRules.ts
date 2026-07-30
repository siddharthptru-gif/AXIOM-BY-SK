/**
 * Component accessibility RULE PACK (Phase 253 — Component A11y Audit & Fixes,
 * DEPTH). Complements the flat descriptor pass in a11yAudit.ts with a TREE-based
 * audit: it walks a light, serializable descriptor of a rendered component subtree
 * and applies a pack of WCAG / ARIA rules that need structure (heading order,
 * duplicate ids) or per-node context (icon-only controls, unlabeled inputs,
 * keyboard operability, colour contrast).
 *
 * PURE — no DOM, no I/O — so it runs in Main or the renderer and unit-tests
 * cleanly. The renderer builds an A11yNode tree from the live DOM and feeds it in.
 * This is still a static, descriptor-level check: it complements, but does not
 * replace, a real runtime axe scan + manual screen-reader testing (the
 * out-of-sandbox part of Phase 253/254).
 *
 * Rule pack (ruleId → severity):
 *   control-name       error  icon-only button/link with no accessible name
 *   img-alt            error  img (or role=img) with no alt / aria-label
 *   control-label      error  form control with no associated label
 *   positive-tabindex  warn   tabindex > 0 (breaks the natural tab order)
 *   keyboard-focusable warn   custom interactive role not keyboard-focusable
 *   keyboard-handler   warn   custom interactive role with no keyboard handler
 *   duplicate-id       error  an id used by more than one node
 *   heading-order      warn   a heading level skips (e.g. h1 → h3)
 *   low-contrast       warn   text colour vs background below WCAG AA (theme linter)
 */

import { contrastRatio, meetsAA } from './theme';

export type A11yAttrValue = string | boolean;

/** A light, serializable descriptor of a rendered component node (NOT real DOM). */
export interface A11yNode {
  /** Lowercase tag name, e.g. 'button', 'img', 'input', 'h2', 'div'. */
  tag: string;
  /** Explicit ARIA role (overrides the implicit role of the tag). */
  role?: string;
  /** Flat attribute map. String values, or `true` for boolean attributes. */
  attrs?: Record<string, A11yAttrValue>;
  /** This node's own visible text (not its descendants'). */
  text?: string;
  children?: A11yNode[];
}

export type A11ySeverity = 'error' | 'warn';

export interface A11yTreeFinding {
  ruleId: string;
  severity: A11ySeverity;
  /** Positional path of the offending node in the tree (e.g. "0/2/1"). */
  path: string;
  /** Short node label, e.g. "<button#save role=button>". */
  node: string;
  message: string;
}

export interface A11yAuditSummary {
  errors: number;
  warnings: number;
  total: number;
  /** Count of findings per ruleId. */
  byRule: Record<string, number>;
  summary: string;
}

/** All ruleIds this pack can emit (for documentation / filters). */
export const A11Y_RULE_IDS: readonly string[] = [
  'control-name',
  'img-alt',
  'control-label',
  'positive-tabindex',
  'keyboard-focusable',
  'keyboard-handler',
  'duplicate-id',
  'heading-order',
  'low-contrast',
];

const NATIVE_INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'textbox',
  'combobox',
  'switch',
  'slider',
  'spinbutton',
]);
const FORM_CONTROL_ROLES = new Set([
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
  'searchbox',
]);
const NON_CONTROL_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image']);

// ---- node helpers -----------------------------------------------------------

function attrVal(node: A11yNode, name: string): A11yAttrValue | undefined {
  return node.attrs ? node.attrs[name] : undefined;
}

function attrStr(node: A11yNode, name: string): string {
  const v = attrVal(node, name);
  if (typeof v === 'string') return v;
  return v === true ? 'true' : '';
}

/** Attribute is present and meaningful (a non-empty string or a `true` boolean). */
function attrPresent(node: A11yNode, name: string): boolean {
  const v = attrVal(node, name);
  return v === true || (typeof v === 'string' && v.trim().length > 0);
}

/** Attribute key exists at all (so alt="" counts as present/decorative). */
function attrHas(node: A11yNode, name: string): boolean {
  return node.attrs ? Object.prototype.hasOwnProperty.call(node.attrs, name) : false;
}

function tabIndexOf(node: A11yNode): number | undefined {
  const raw = attrVal(node, 'tabindex') ?? attrVal(node, 'tabIndex');
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function implicitRole(node: A11yNode): string | undefined {
  switch (node.tag) {
    case 'button':
      return 'button';
    case 'a':
      return attrPresent(node, 'href') ? 'link' : undefined;
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'img':
      return 'img';
    case 'input': {
      const t = (attrStr(node, 'type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    default:
      return undefined;
  }
}

function effectiveRole(node: A11yNode): string | undefined {
  return node.role !== undefined && node.role.length > 0 ? node.role : implicitRole(node);
}

function accessibleName(node: A11yNode): string {
  const aria = attrStr(node, 'aria-label').trim();
  if (aria.length > 0) return aria;
  // Can't resolve the referenced element here, but its presence implies a name.
  if (attrPresent(node, 'aria-labelledby')) return attrStr(node, 'aria-labelledby').trim();
  const title = attrStr(node, 'title').trim();
  if (title.length > 0) return title;
  const text = (node.text ?? '').trim();
  if (text.length > 0) return text;
  return attrStr(node, 'alt').trim();
}

function isInteractive(node: A11yNode, role: string | undefined): boolean {
  if (node.tag === 'a') return attrPresent(node, 'href');
  if (NATIVE_INTERACTIVE_TAGS.has(node.tag)) return true;
  return role !== undefined && INTERACTIVE_ROLES.has(role);
}

function isFormControl(node: A11yNode, role: string | undefined): boolean {
  if (node.tag === 'select' || node.tag === 'textarea') return true;
  if (node.tag === 'input') {
    const t = (attrStr(node, 'type') || 'text').toLowerCase();
    return !NON_CONTROL_INPUT_TYPES.has(t);
  }
  return role !== undefined && FORM_CONTROL_ROLES.has(role);
}

function hasFormLabel(node: A11yNode): boolean {
  return (
    attrPresent(node, 'aria-label') ||
    attrPresent(node, 'aria-labelledby') ||
    attrPresent(node, 'title') ||
    attrPresent(node, 'label')
  );
}

function hasKeyboardHandler(node: A11yNode): boolean {
  return (
    attrPresent(node, 'onkeydown') ||
    attrPresent(node, 'onKeyDown') ||
    attrPresent(node, 'onkeypress') ||
    attrPresent(node, 'onKeyPress') ||
    attrPresent(node, 'data-keyboard')
  );
}

function headingLevel(tag: string): number {
  return /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : 0;
}

function nodeLabel(node: A11yNode): string {
  const id = attrStr(node, 'id').trim();
  const role = effectiveRole(node);
  return `<${node.tag}${id.length > 0 ? `#${id}` : ''}${role !== undefined ? ` role=${role}` : ''}>`;
}

interface Located {
  node: A11yNode;
  path: string;
}

/** Pre-order DFS (= document order) collection of every node with its path. */
function collect(root: A11yNode): Located[] {
  const out: Located[] = [];
  const walk = (n: A11yNode, path: string): void => {
    out.push({ node: n, path });
    const kids = n.children ?? [];
    kids.forEach((c, i) => walk(c, `${path}/${i}`));
  };
  walk(root, '0');
  return out;
}

// ---- the audit --------------------------------------------------------------

/**
 * Run the full rule pack over a component tree. Findings are emitted in document
 * (pre-order) order, deterministically.
 */
export function auditTree(root: A11yNode): A11yTreeFinding[] {
  const located = collect(root);
  const findings: A11yTreeFinding[] = [];
  const add = (loc: Located, ruleId: string, severity: A11ySeverity, message: string): void => {
    findings.push({ ruleId, severity, path: loc.path, node: nodeLabel(loc.node), message });
  };

  // Tree-wide: id frequency for the duplicate-id rule.
  const idCounts = new Map<string, number>();
  for (const { node } of located) {
    const id = attrStr(node, 'id').trim();
    if (id.length > 0) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  let prevHeading = 0;

  for (const loc of located) {
    const { node } = loc;
    const role = effectiveRole(node);
    const label = nodeLabel(node);

    // control-name: icon-only button/link with no accessible name.
    if ((role === 'button' || role === 'link') && accessibleName(node).length === 0) {
      add(
        loc,
        'control-name',
        'error',
        `${label} is icon-only / has no accessible name — add an aria-label or visible text.`,
      );
    }

    // img-alt: image with no alt attribute at all (alt="" is valid/decorative).
    if (
      (node.tag === 'img' || role === 'img') &&
      !attrHas(node, 'alt') &&
      !attrPresent(node, 'aria-label')
    ) {
      add(
        loc,
        'img-alt',
        'error',
        `${label} has no alt text — add a descriptive alt (or alt="" if decorative).`,
      );
    }

    // control-label: form control with no associated label.
    if (isFormControl(node, role) && !hasFormLabel(node)) {
      add(
        loc,
        'control-label',
        'error',
        `${label} form control has no label — associate a <label>, aria-label, or aria-labelledby.`,
      );
    }

    // positive-tabindex: tabindex > 0 breaks the natural tab order.
    const ti = tabIndexOf(node);
    if (ti !== undefined && ti > 0) {
      add(
        loc,
        'positive-tabindex',
        'warn',
        `${label} uses a positive tabindex (${ti}) — use 0 or -1 and rely on DOM order.`,
      );
    }

    // keyboard-focusable / keyboard-handler: custom (non-native) interactive control.
    if (
      role !== undefined &&
      INTERACTIVE_ROLES.has(role) &&
      !NATIVE_INTERACTIVE_TAGS.has(node.tag) &&
      isInteractive(node, role)
    ) {
      const focusable = ti !== undefined && ti >= 0;
      if (!focusable) {
        add(
          loc,
          'keyboard-focusable',
          'warn',
          `${label} has an interactive role but is not keyboard-focusable — add tabindex="0".`,
        );
      } else if (!hasKeyboardHandler(node)) {
        add(
          loc,
          'keyboard-handler',
          'warn',
          `${label} has role=${role} but no keyboard handler — handle Enter/Space via onKeyDown.`,
        );
      }
    }

    // duplicate-id: this id is used by more than one node.
    const id = attrStr(node, 'id').trim();
    if (id.length > 0 && (idCounts.get(id) ?? 0) > 1) {
      add(loc, 'duplicate-id', 'error', `${label} duplicate id "${id}" — ids must be unique.`);
    }

    // heading-order: a heading level that skips (e.g. h1 → h3).
    const lvl = headingLevel(node.tag);
    if (lvl > 0) {
      if (prevHeading > 0 && lvl - prevHeading > 1) {
        add(
          loc,
          'heading-order',
          'warn',
          `${label} heading level h${lvl} skips from h${prevHeading} — don't skip heading levels.`,
        );
      }
      prevHeading = lvl;
    }

    // low-contrast: text colour vs background below WCAG AA (theme contrast linter).
    const fg = attrStr(node, 'color').trim();
    const bg = (attrStr(node, 'backgroundColor') || attrStr(node, 'background-color')).trim();
    if (fg.length > 0 && bg.length > 0 && (node.text ?? '').trim().length > 0) {
      if (!meetsAA(fg, bg)) {
        const ratio = contrastRatio(fg, bg);
        add(
          loc,
          'low-contrast',
          'warn',
          `${label} text contrast ${ratio}:1 is below WCAG AA 4.5:1 (${fg} on ${bg}).`,
        );
      }
    }
  }

  return findings;
}

/** Roll findings up into severity + per-rule counts and a one-line summary. */
export function summarizeAudit(findings: readonly A11yTreeFinding[]): A11yAuditSummary {
  let errors = 0;
  let warnings = 0;
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    if (f.severity === 'error') errors += 1;
    else warnings += 1;
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }
  const total = findings.length;
  const rules = Object.keys(byRule).length;
  const summary =
    total === 0
      ? 'No accessibility issues found.'
      : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} ` +
        `across ${rules} rule${rules === 1 ? '' : 's'}.`;
  return { errors, warnings, total, byRule, summary };
}
