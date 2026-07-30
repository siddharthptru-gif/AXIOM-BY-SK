/**
 * UX polish — states checklist (Phase 264 — UX Polish Pass).
 *
 * PURE module (no I/O, no Electron). Audits whether each view handles the standard
 * UX states — empty, loading, error, success, offline — so no screen is left in an
 * unpolished state. A view declares which states it handles (and which apply); this
 * computes per-view + overall coverage and the prioritized list of missing states.
 * The renderer collects the declarations; this adjudicates. Deterministic.
 */

export type UxState = 'empty' | 'loading' | 'error' | 'success' | 'offline';

export const UX_STATES: readonly UxState[] = ['empty', 'loading', 'error', 'success', 'offline'];

export interface ViewStates {
  view: string;
  /** States this view implements (true = handled). */
  handled: Partial<Record<UxState, boolean>>;
  /** Which states apply to this view (default: all five). */
  applicable?: UxState[];
}

export interface ViewAudit {
  view: string;
  handled: UxState[];
  missing: UxState[];
  /** handled / applicable, 0..1. */
  coverage: number;
  ok: boolean;
}

export interface UxAudit {
  views: ViewAudit[];
  /** Handled / applicable across all views, 0..1. */
  overallCoverage: number;
  totalMissing: number;
  /** Views with gaps, worst coverage first. */
  gaps: ViewAudit[];
  summary: string;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Audit a set of view state declarations for UX-state coverage. */
export function auditUxStates(views: readonly ViewStates[]): UxAudit {
  let totalApplicable = 0;
  let totalHandled = 0;
  const audited: ViewAudit[] = views.map((v) => {
    const applicable = (v.applicable && v.applicable.length > 0 ? v.applicable : UX_STATES).filter(
      (s, i, a) => a.indexOf(s) === i,
    );
    const handled = applicable.filter((s) => v.handled[s] === true);
    const missing = applicable.filter((s) => v.handled[s] !== true);
    totalApplicable += applicable.length;
    totalHandled += handled.length;
    return {
      view: v.view,
      handled,
      missing,
      coverage: applicable.length > 0 ? round(handled.length / applicable.length) : 1,
      ok: missing.length === 0,
    };
  });

  const overallCoverage = totalApplicable > 0 ? round(totalHandled / totalApplicable) : 1;
  const totalMissing = totalApplicable - totalHandled;
  const gaps = audited
    .filter((a) => !a.ok)
    .sort((a, b) => a.coverage - b.coverage || a.view.localeCompare(b.view));

  const summary =
    views.length === 0
      ? 'UX states: no views to audit.'
      : `UX states: ${Math.round(overallCoverage * 100)}% coverage across ${views.length} view(s) · ` +
        `${totalMissing} missing state(s) in ${gaps.length} view(s).`;

  return { views: audited, overallCoverage, totalMissing, gaps, summary };
}
