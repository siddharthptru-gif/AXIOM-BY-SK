import { useRef, useState } from 'react';
import { ChevronIcon } from './treeIcons';
import {
  auditComponents,
  formatA11ySummary,
  type A11yAuditResult,
  type ComponentDescriptor,
} from '../../../common/a11yAudit';
import {
  auditTree,
  summarizeAudit,
  type A11yNode,
  type A11yTreeFinding,
  type A11yAuditSummary,
} from '../../../common/a11yRules';
import { nextFocusIndex, rovingTabIndex } from '../../../common/focusNav';
import { auditUxStates, type UxAudit, type ViewStates } from '../../../common/uxStates';

/**
 * A11y Audit panel (PRD Epoch I / Phase 253 — Component A11y Audit & Fixes). On
 * demand it scans the live workbench DOM, builds component descriptors, and runs
 * the pure `auditComponents` pass, listing ARIA / keyboard findings with a fix
 * and an overall score. Collapsed by default; nothing runs until requested.
 *
 * This is a static descriptor-level self-check — only rules that a DOM scan can
 * infer reliably are surfaced (name, role, positive tabindex, hidden-focusable).
 * A full runtime axe scan + manual screen-reader testing remain the out-of-app
 * part of 253/254.
 */

const INTERACTIVE_TAGS = new Set(['button', 'select', 'textarea', 'input']);
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

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim().length > 0) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby !== null) {
    const ref = document.getElementById(labelledby);
    const t = ref?.textContent?.trim();
    if (t !== undefined && t.length > 0) return t;
  }
  const title = el.getAttribute('title');
  if (title !== null && title.trim().length > 0) return title.trim();
  const text = (el.textContent ?? '').trim();
  if (text.length > 0) return text;
  const alt = el.getAttribute('alt');
  return alt !== null ? alt.trim() : '';
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : undefined;
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  return undefined;
}

function scanDom(): ComponentDescriptor[] {
  const sel = 'button, a[href], input, select, textarea, [role], [tabindex]';
  const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 500);
  return nodes.map((el, i) => {
    const explicit = el.getAttribute('role');
    const role = explicit !== null && explicit.length > 0 ? explicit : implicitRole(el);
    const tag = el.tagName.toLowerCase();
    const tabAttr = el.getAttribute('tabindex');
    const tabIndex = tabAttr !== null ? Number.parseInt(tabAttr, 10) : undefined;
    const interactive =
      INTERACTIVE_TAGS.has(tag) ||
      (tag === 'a' && el.hasAttribute('href')) ||
      (role !== undefined && INTERACTIVE_ROLES.has(role));
    const ariaHidden = el.getAttribute('aria-hidden') === 'true';
    const name = accessibleName(el);
    const id = el.id.length > 0 ? el.id : `${tag}[${i}]`;
    return {
      id,
      ...(role !== undefined ? { role } : {}),
      ...(name.length > 0 ? { name } : {}),
      ...(tabIndex !== undefined && !Number.isNaN(tabIndex) ? { tabIndex } : {}),
      interactive,
      ariaHidden,
    };
  });
}

// --- Phase 253 depth: tree-based audit over a sampled component descriptor tree ---

const TREE_MAX_DEPTH = 12;
const TREE_MAX_CHILDREN = 40;
const TREE_MAX_NODES = 800;
const TREE_ATTRS = [
  'id',
  'alt',
  'href',
  'type',
  'tabindex',
  'aria-label',
  'aria-labelledby',
  'title',
];

/** This element's own text (excluding descendants), whitespace-collapsed. */
function ownText(el: Element): string {
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3 /* Node.TEXT_NODE */) s += n.textContent ?? '';
  });
  return s.replace(/\s+/g, ' ').trim();
}

/** Convert a DOM subtree into a serializable A11yNode (bounded in depth/size). */
function domToNode(el: Element, depth: number, budget: { n: number }): A11yNode {
  const attrs: Record<string, string | boolean> = {};
  for (const name of TREE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null) attrs[name] = v;
  }
  const roleAttr = el.getAttribute('role');
  const text = ownText(el);
  const children: A11yNode[] = [];
  if (depth < TREE_MAX_DEPTH) {
    const kids = Array.from(el.children);
    for (let i = 0; i < kids.length && children.length < TREE_MAX_CHILDREN; i++) {
      if (budget.n >= TREE_MAX_NODES) break;
      const k = kids[i];
      if (!k) continue;
      budget.n += 1;
      children.push(domToNode(k, depth + 1, budget));
    }
  }
  return {
    tag: el.tagName.toLowerCase(),
    ...(roleAttr !== null && roleAttr.length > 0 ? { role: roleAttr } : {}),
    attrs,
    ...(text.length > 0 ? { text } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/** Sample the live workbench subtree as an A11yNode tree for the rule pack. */
function scanTree(): A11yNode {
  const root = (document.querySelector('.workbench') as Element | null) ?? document.body;
  return domToNode(root, 0, { n: 0 });
}

/**
 * The app's main views + which UX states each handles (Phase 264 self-audit). An
 * honest declaration used to surface state-coverage gaps (e.g. a view missing an
 * offline or loading state).
 */
const APP_VIEW_STATES: ViewStates[] = [
  {
    view: 'ChatPanel',
    handled: { empty: true, loading: true, error: true, success: true, offline: true },
  },
  { view: 'AgentPanel', handled: { empty: true, loading: true, error: true, success: true } },
  { view: 'SearchView', handled: { empty: true, loading: true, error: true, success: true } },
  { view: 'SecurityView', handled: { empty: true, error: true, success: true } },
  { view: 'DependenciesView', handled: { empty: true, loading: true, error: true } },
  { view: 'TasksView', handled: { empty: true, loading: true, success: true } },
  { view: 'ReviewView', handled: { empty: true, loading: true, error: true, success: true } },
  { view: 'PerformanceView', handled: { empty: true, loading: true, success: true } },
];

export function A11yAuditView() {
  const [collapsed, setCollapsed] = useState(true);
  const [result, setResult] = useState<A11yAuditResult | null>(null);
  // Phase 253 depth — tree-based rule pack over a sampled component tree.
  const [treeFindings, setTreeFindings] = useState<A11yTreeFinding[] | null>(null);
  const [treeSummary, setTreeSummary] = useState<A11yAuditSummary | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Phase 264 — UX-states self-audit.
  const [ux, setUx] = useState<UxAudit | null>(null);

  const run = (): void => {
    setResult(auditComponents(scanDom()));
    // The static DOM sample can't observe React event handlers, so the
    // 'keyboard-handler' rule (needs a real handler) is filtered out here — the
    // rule still ships + is unit-tested; the live view surfaces the rules a DOM
    // scan can verify reliably. A full axe scan + SR pass stay out of the sandbox.
    const findings = auditTree(scanTree()).filter((f) => f.ruleId !== 'keyboard-handler');
    setTreeFindings(findings);
    setTreeSummary(summarizeAudit(findings));
    setUx(auditUxStates(APP_VIEW_STATES));
    setFocusIndex(0);
  };

  return (
    <div className="deps-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">A11y Audit</span>
        {result ? (
          <span className="oe-count" title="Errors + warnings">
            {result.errors + result.warnings}
          </span>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="deps-body">
          <button type="button" className="btn" onClick={run}>
            Run audit
          </button>
          {result === null ? (
            <div className="outline-empty">
              Run an audit to check the live UI for ARIA / keyboard issues.
            </div>
          ) : (
            <>
              <div className={`deps-impact${result.errors > 0 ? ' status-warn' : ''}`}>
                {formatA11ySummary(result)} · {result.total} components
              </div>
              {result.findings.length === 0 ? (
                <div className="outline-empty">No issues found.</div>
              ) : (
                result.findings.slice(0, 100).map((f, i) => (
                  <div
                    key={`${f.id}:${f.rule}:${i}`}
                    className={`dep-row${f.severity === 'error' ? ' status-warn' : ''}`}
                    title={f.fix}
                  >
                    <span className="dep-name">
                      {f.severity.toUpperCase()} — {f.message}
                    </span>
                    <span className="dep-dir">{f.fix}</span>
                  </div>
                ))
              )}
            </>
          )}

          {treeFindings !== null ? (
            <>
              <div
                className={`deps-impact${treeSummary && treeSummary.errors > 0 ? ' status-warn' : ''}`}
              >
                Structure &amp; ARIA: {treeSummary?.summary}
              </div>
              {treeFindings.length === 0 ? (
                <div className="outline-empty">No structural / ARIA issues found.</div>
              ) : (
                <div role="listbox" aria-label="Structure and ARIA findings">
                  {treeFindings.slice(0, 100).map((f, i) => (
                    <div
                      key={`${f.path}:${f.ruleId}:${i}`}
                      role="option"
                      aria-selected={i === focusIndex}
                      tabIndex={rovingTabIndex(i, focusIndex)}
                      ref={(el) => {
                        rowRefs.current[i] = el;
                      }}
                      className={`dep-row${f.severity === 'error' ? ' status-warn' : ''}`}
                      title={f.node}
                      onClick={() => setFocusIndex(i)}
                      onKeyDown={(e) => {
                        const count = Math.min(treeFindings.length, 100);
                        const next = nextFocusIndex(focusIndex, count, e.key);
                        if (next >= 0) {
                          e.preventDefault();
                          setFocusIndex(next);
                          rowRefs.current[next]?.focus();
                        }
                      }}
                    >
                      <span className="dep-name">
                        {f.severity.toUpperCase()} [{f.ruleId}] — {f.message}
                      </span>
                      <span className="dep-dir">{f.node}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
          {ux ? (
            <>
              <div className="deps-impact" title="UX states coverage (PRD Phase 264)">
                UX states: {ux.summary}
              </div>
              {ux.gaps.slice(0, 20).map((g) => (
                <div key={`ux-${g.view}`} className="dep-row" title={g.missing.join(', ')}>
                  <span className="dep-name">
                    {g.view} — missing: {g.missing.join(', ')}
                  </span>
                  <span className="dep-dir">{Math.round(g.coverage * 100)}%</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
