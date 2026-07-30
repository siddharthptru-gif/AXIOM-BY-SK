/**
 * Planning mode core (PRD Epoch H §132 / Phase 214). A pure, editable/trackable plan
 * model: ordered steps each with a status, plus ops to advance (check off) as the
 * agent executes, edit/add/remove steps, and compute progress. No I/O — the agent
 * panel renders + tracks it. Smoke-tested.
 */
export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
}

export interface Plan {
  steps: PlanStep[];
}

/** Build a plan from ordered step texts (whitespace-trimmed, empties dropped). */
export function createPlan(texts: readonly string[]): Plan {
  const steps: PlanStep[] = [];
  texts.forEach((t, i) => {
    const text = t.trim();
    if (text.length > 0) steps.push({ id: `step-${i + 1}`, text, status: 'pending' });
  });
  return { steps };
}

function mapSteps(plan: Plan, fn: (s: PlanStep) => PlanStep): Plan {
  return { steps: plan.steps.map(fn) };
}

/** Set a step's status (non-mutating). */
export function setStepStatus(plan: Plan, id: string, status: PlanStepStatus): Plan {
  return mapSteps(plan, (s) => (s.id === id ? { ...s, status } : s));
}

/** Edit a step's text (non-mutating; empty text ignored). */
export function editStep(plan: Plan, id: string, text: string): Plan {
  const clean = text.trim();
  return clean.length === 0
    ? plan
    : mapSteps(plan, (s) => (s.id === id ? { ...s, text: clean } : s));
}

/** Append a new pending step. */
export function addStep(plan: Plan, text: string): Plan {
  const clean = text.trim();
  if (clean.length === 0) return plan;
  const id = `step-${plan.steps.length + 1}-${Date.now()}`;
  return { steps: [...plan.steps, { id, text: clean, status: 'pending' }] };
}

/** Remove a step. */
export function removeStep(plan: Plan, id: string): Plan {
  return { steps: plan.steps.filter((s) => s.id !== id) };
}

/**
 * Advance the plan by one step: mark the current `active` step `done`, then the
 * next `pending` step `active`. If nothing is active yet, activate the first
 * pending step. Idempotent once every step is done/skipped.
 */
export function advancePlan(plan: Plan): Plan {
  const activeIdx = plan.steps.findIndex((s) => s.status === 'active');
  const steps = plan.steps.map((s) => ({ ...s }));
  if (activeIdx >= 0) {
    steps[activeIdx]!.status = 'done';
  }
  const nextPending = steps.findIndex((s) => s.status === 'pending');
  if (nextPending >= 0) steps[nextPending]!.status = 'active';
  return { steps };
}

/** Start the plan: activate the first pending step (no-op if one is already active). */
export function startPlan(plan: Plan): Plan {
  if (plan.steps.some((s) => s.status === 'active')) return plan;
  const idx = plan.steps.findIndex((s) => s.status === 'pending');
  if (idx < 0) return plan;
  const steps = plan.steps.map((s, i) => (i === idx ? { ...s, status: 'active' as const } : s));
  return { steps };
}

export interface PlanProgress {
  done: number;
  total: number;
  pct: number;
}

/** Progress over the plan (done + skipped count as complete). */
export function planProgress(plan: Plan): PlanProgress {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

/** Whether every step is done or skipped. */
export function isPlanComplete(plan: Plan): boolean {
  return (
    plan.steps.length > 0 && plan.steps.every((s) => s.status === 'done' || s.status === 'skipped')
  );
}
