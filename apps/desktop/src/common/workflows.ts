/**
 * Workflow task core (PRD Epoch H §148 / Phase 236). Pure helpers validate and
 * sanitize an ordered, approval-gated agent task, resolve its steps and human
 * gates, and estimate cost before a manual run. Legacy automatic trigger schemas
 * and matching remain readable for persisted definitions, but newly created
 * workflows are manual-only. No I/O — Main persists tasks and the renderer manages
 * them. SAFETY: workflows default to DISABLED and every workspace-mutating step
 * defaults to a human gate. Unit-smoke-tested.
 */
export type TriggerKind =
  'manual' | 'onSave' | 'onCreate' | 'onDelete' | 'preCommit' | 'postCheckout' | 'schedule';

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'manual',
  'onSave',
  'onCreate',
  'onDelete',
  'preCommit',
  'postCheckout',
  'schedule',
];

export type StepKind = 'plan' | 'implement' | 'test' | 'review' | 'doc' | 'command';

export const STEP_KINDS: readonly StepKind[] = [
  'plan',
  'implement',
  'test',
  'review',
  'doc',
  'command',
];

export const STEP_LABELS: Record<StepKind, string> = {
  plan: 'Plan',
  implement: 'Implement',
  test: 'Test',
  review: 'Review',
  doc: 'Document',
  command: 'Run command',
};

export interface Trigger {
  kind: TriggerKind;
  /** Optional glob retained for a persisted automatic trigger definition. */
  glob?: string;
}

export interface PipelineStep {
  id: string;
  kind: StepKind;
  /** Natural-language instruction for an ordered agent-task step. */
  instruction?: string;
  /** Shell command for a `command` step. */
  command?: string;
  /** Require explicit human approval before this step runs. */
  humanGate?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  steps: PipelineStep[];
}

/** Legacy automatic-trigger event retained for persisted-definition compatibility. */
export interface WorkflowEvent {
  kind: TriggerKind;
  path?: string;
}

const MAX_STEPS = 20;
const MAX_NAME = 80;

/** Only planning and review are guaranteed not to mutate the workspace. */
const READ_ONLY_STEPS: ReadonlySet<StepKind> = new Set<StepKind>(['plan', 'review']);

/** Whether a step kind mutates the workspace (and so defaults to a human gate). */
export function isMutatingStep(kind: StepKind): boolean {
  return !READ_ONLY_STEPS.has(kind);
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.length > 0 ? s : 'workflow';
}

function coerceTriggerKind(v: unknown): TriggerKind {
  return typeof v === 'string' && (TRIGGER_KINDS as readonly string[]).includes(v)
    ? (v as TriggerKind)
    : 'manual';
}

function coerceStepKind(v: unknown): StepKind | null {
  return typeof v === 'string' && (STEP_KINDS as readonly string[]).includes(v)
    ? (v as StepKind)
    : null;
}

/**
 * Sanitize arbitrary input into a safe Workflow, or null if unusable. Defaults to
 * DISABLED; drops invalid steps; caps counts; workspace-mutating steps default to
 * a human gate unless the caller explicitly set `humanGate: false`. Legacy trigger
 * fields are preserved so existing definitions can be shown and run manually.
 */
export function validateWorkflow(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = (typeof o.name === 'string' ? o.name : '').trim().slice(0, MAX_NAME);
  if (name.length === 0) return null;
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : slugify(name);

  const trg = (o.trigger ?? {}) as Record<string, unknown>;
  const trigger: Trigger = { kind: coerceTriggerKind(trg.kind) };
  if (typeof trg.glob === 'string' && trg.glob.trim().length > 0) {
    trigger.glob = trg.glob.trim();
  }

  const rawSteps = Array.isArray(o.steps) ? o.steps : [];
  const steps: PipelineStep[] = [];
  for (let i = 0; i < rawSteps.length && steps.length < MAX_STEPS; i++) {
    const s = (rawSteps[i] ?? {}) as Record<string, unknown>;
    const kind = coerceStepKind(s.kind);
    if (!kind) continue;
    const stepId = typeof s.id === 'string' && s.id.length > 0 ? s.id : `step-${i + 1}`;
    const gate = typeof s.humanGate === 'boolean' ? s.humanGate : isMutatingStep(kind);
    const step: PipelineStep = { id: stepId, kind, humanGate: gate };
    if (typeof s.instruction === 'string' && s.instruction.trim().length > 0) {
      step.instruction = s.instruction.trim();
    }
    if (kind === 'command' && typeof s.command === 'string' && s.command.trim().length > 0) {
      step.command = s.command.trim();
    }
    steps.push(step);
  }

  return { id, name, enabled: o.enabled === true, trigger, steps };
}

/** Convert a simple glob (`**`, `*`, `?`) to an anchored, forward-slash RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // consume the slash after **
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c && '.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a workspace-relative path (forward slashes) matches a glob. */
export function matchesGlob(glob: string, path: string): boolean {
  const norm = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  try {
    return globToRegExp(glob).test(norm);
  } catch {
    return false;
  }
}

/**
 * Legacy helper for enabled persisted definitions whose automatic trigger matches
 * an event. Manual triggers never match an automatic event.
 */
export function matchTriggers(workflows: readonly Workflow[], event: WorkflowEvent): Workflow[] {
  if (event.kind === 'manual') return [];
  return workflows.filter((w) => {
    if (!w.enabled || w.trigger.kind !== event.kind) return false;
    if (!w.trigger.glob) return true;
    return event.path !== undefined && matchesGlob(w.trigger.glob, event.path);
  });
}

/** Ordered task steps with each effective human gate resolved. */
export function resolvePipeline(steps: readonly PipelineStep[]): PipelineStep[] {
  return steps.map((s) => ({
    ...s,
    humanGate: typeof s.humanGate === 'boolean' ? s.humanGate : isMutatingStep(s.kind),
  }));
}

/** Rough per-step token estimate for the pre-run cost estimate. */
const STEP_TOKENS: Record<StepKind, number> = {
  plan: 2000,
  implement: 8000,
  test: 3000,
  review: 4000,
  doc: 2000,
  command: 0,
};

export interface CostEstimate {
  steps: number;
  gatedSteps: number;
  estimatedTokens: number;
  estimatedUsd: number;
}

/** Heuristic cost estimate for an ordered task (rough — for pre-run confirmation). */
export function estimateCost(steps: readonly PipelineStep[]): CostEstimate {
  const resolved = resolvePipeline(steps);
  const estimatedTokens = resolved.reduce((sum, s) => sum + STEP_TOKENS[s.kind], 0);
  // Very rough blended $/1K-token rate for a mid-tier model.
  const estimatedUsd = Math.round((estimatedTokens / 1000) * 0.006 * 1000) / 1000;
  return {
    steps: resolved.length,
    gatedSteps: resolved.filter((s) => s.humanGate).length,
    estimatedTokens,
    estimatedUsd,
  };
}

const TRIGGER_LABELS: Record<TriggerKind, string> = {
  manual: 'Manual',
  onSave: 'On save',
  onCreate: 'On file create',
  onDelete: 'On file delete',
  preCommit: 'Pre-commit',
  postCheckout: 'Post-checkout',
  schedule: 'Scheduled',
};

/** Human-readable persisted trigger description, including any glob scope. */
export function describeTrigger(trigger: Trigger): string {
  const base = TRIGGER_LABELS[trigger.kind];
  return trigger.glob ? `${base} \u00B7 ${trigger.glob}` : base;
}

const DEFAULT_STEP_INSTRUCTION: Record<StepKind, string> = {
  plan: 'Draft a short, ordered plan for the change.',
  implement: 'Implement the change.',
  test: 'Run the project tests and report the results.',
  review: 'Review the changes for bugs, edge cases, and quality.',
  doc: 'Update the relevant documentation and code comments.',
  command: 'Run the specified command.',
};

/**
 * Compose workflow steps into one ordered, approval-gated agent task. A marked
 * step tells the agent to pause for approval; the agent loop separately enforces
 * approval when it invokes mutating tools.
 */
export function composePipelineTask(workflow: Workflow): string {
  const steps = resolvePipeline(workflow.steps);
  const lines = steps.map((s, i) => {
    const detail =
      s.kind === 'command'
        ? `run the command \`${s.command ?? '(none specified)'}\``
        : (s.instruction ?? DEFAULT_STEP_INSTRUCTION[s.kind]);
    const gate = s.humanGate ? ' [requires approval]' : '';
    return `${i + 1}. ${STEP_LABELS[s.kind]}${gate}: ${detail}`;
  });
  return (
    `Complete the "${workflow.name}" workflow as an ordered, approval-gated agent task. ` +
    `Work through each step in sequence, and stop for approval before any step marked ` +
    `[requires approval].\n\n` +
    lines.join('\n')
  );
}
