import { useEffect, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { useSettings } from '../settings/store';
import { getAiSettings, getCustomProvider, parseHeaders } from '../settings/schema';
import { notifyInfo, notifyError } from '../notifications/bus';
import { ChevronIcon } from './treeIcons';
import {
  STEP_KINDS,
  STEP_LABELS,
  describeTrigger,
  estimateCost,
  composePipelineTask,
  type StepKind,
  type PipelineStep,
  type Workflow,
} from '../../../common/workflows';

/**
 * Workflows panel (PRD Epoch H §148 / Phase 236). Manage ordered, approval-gated
 * agent tasks: create manual workflows, enable/disable them, and run them into
 * Agent Tasks (where they inherit approval gating, snapshots, and audit). Legacy
 * automatic definitions remain visible and manually runnable, but their unsupported
 * triggers are clearly labeled and cannot be created here.
 */
function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function WorkflowsView() {
  const ws = useWorkspace();
  const { values } = useSettings();
  const [collapsed, setCollapsed] = useState(true);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [creating, setCreating] = useState(false);
  const [pendingRun, setPendingRun] = useState<{ id: string; summary: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // New-workflow form state. New definitions are intentionally manual-only.
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [stepKind, setStepKind] = useState<StepKind>('plan');
  const [stepText, setStepText] = useState('');

  const load = (): void => {
    setLoadError(null);
    void window.axiom.workflows
      .list()
      .then((list) => {
        setWorkflows(list);
        setLoadError(null);
      })
      .catch((e) => setLoadError(detailOf(e)));
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = (): void => {
    setName('');
    setSteps([]);
    setStepText('');
    setStepKind('plan');
    setCreating(false);
  };

  const addStep = (): void => {
    const text = stepText.trim();
    const step: PipelineStep = {
      id: `step-${steps.length + 1}`,
      kind: stepKind,
      ...(stepKind === 'command'
        ? text
          ? { command: text }
          : {}
        : text
          ? { instruction: text }
          : {}),
    };
    setSteps((cur) => [...cur, step]);
    setStepText('');
  };

  const saveWorkflow = (): void => {
    if (name.trim().length === 0) return;
    void window.axiom.workflows
      .save({
        name: name.trim(),
        enabled: false,
        trigger: { kind: 'manual' },
        steps,
      })
      .then((list) => {
        setWorkflows(list);
        resetForm();
        notifyInfo('Workflow saved. Enable it when you are ready to run it manually.', {
          source: 'Workflows',
        });
      })
      .catch((e) =>
        notifyError('Could not save workflow', { source: 'Workflows', detail: detailOf(e) }),
      );
  };

  const toggleEnabled = (w: Workflow): void => {
    const enabled = !w.enabled;
    void window.axiom.workflows
      .setEnabled(w.id, enabled)
      .then((list) => {
        setWorkflows(list);
        if (!enabled) setPendingRun((current) => (current?.id === w.id ? null : current));
      })
      .catch((e) =>
        notifyError('Could not update workflow', { source: 'Workflows', detail: detailOf(e) }),
      );
  };

  const removeWorkflow = (w: Workflow): void => {
    void window.axiom.workflows
      .remove(w.id)
      .then((list) => {
        setWorkflows(list);
        setPendingRun((current) => (current?.id === w.id ? null : current));
      })
      .catch((e) =>
        notifyError('Could not delete workflow', { source: 'Workflows', detail: detailOf(e) }),
      );
  };

  const requestRun = (w: Workflow): void => {
    if (!w.enabled) return;
    const est = estimateCost(w.steps);
    setPendingRun({
      id: w.id,
      summary: `${est.steps} steps${est.gatedSteps ? `, ${est.gatedSteps} gated` : ''} \u00B7 ~${est.estimatedTokens.toLocaleString()} tokens (~$${est.estimatedUsd})`,
    });
  };

  const confirmRun = (w: Workflow): void => {
    setPendingRun(null);
    if (!w.enabled) {
      notifyInfo(`Enable workflow "${w.name}" before running it.`, { source: 'Workflows' });
      return;
    }
    const root = ws.rootPath;
    if (!root) {
      notifyInfo('Open a folder to run a workflow.', { source: 'Workflows' });
      return;
    }
    const ai = getAiSettings(values);
    const headers = ai.provider === 'custom' ? parseHeaders(getCustomProvider(values).headers) : {};
    void window.axiom.agent
      .run({
        id: crypto.randomUUID(),
        provider: ai.provider,
        model: ai.model,
        baseUrl: ai.baseUrl,
        headers,
        root,
        task: composePipelineTask(w),
        preset: 'coder',
      })
      .then(() =>
        notifyInfo(`Workflow "${w.name}" started \u2014 see Agent Tasks.`, { source: 'Workflows' }),
      )
      .catch((e) =>
        notifyError('Could not start workflow', { source: 'Workflows', detail: detailOf(e) }),
      );
  };

  return (
    <div className="workflows-view">
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
        <span className="oe-title">Workflows</span>
        {!collapsed ? <span className="oe-count">{workflows.length}</span> : null}
      </div>

      {collapsed ? null : (
        <div className="workflows-body">
          {loadError ? (
            <div className="outline-empty" role="alert">
              Could not load workflows: {loadError}
            </div>
          ) : null}
          {workflows.length === 0 ? (
            <div className="outline-empty">No workflows yet.</div>
          ) : (
            workflows.map((w) => (
              <div key={w.id} className="wf-row">
                <div className="wf-main">
                  <label className="wf-enable" title={w.enabled ? 'Enabled' : 'Disabled'}>
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      aria-label={`${w.enabled ? 'Disable' : 'Enable'} workflow ${w.name}`}
                      onChange={() => toggleEnabled(w)}
                    />
                  </label>
                  <div className="wf-info">
                    <div className="wf-name">{w.name}</div>
                    <div className="wf-meta">
                      {w.trigger.kind === 'manual'
                        ? 'Manual run'
                        : `${describeTrigger(w.trigger)} \u00B7 Automatic trigger unavailable \u00B7 manual run only`}{' '}
                      {'\u00B7'} {w.steps.length} steps
                    </div>
                  </div>
                  <button
                    type="button"
                    className="wf-act"
                    disabled={!w.enabled}
                    aria-label={`Run workflow ${w.name}`}
                    title={
                      w.enabled
                        ? 'Run now as an ordered, approval-gated agent task'
                        : 'Enable this workflow to run it'
                    }
                    onClick={() => requestRun(w)}
                  >
                    {'\u25B6'}
                  </button>
                  <button
                    type="button"
                    className="wf-act is-danger"
                    aria-label={`Delete workflow ${w.name}`}
                    title="Delete workflow"
                    onClick={() => removeWorkflow(w)}
                  >
                    {'\u00D7'}
                  </button>
                </div>
                {pendingRun && pendingRun.id === w.id ? (
                  <div className="wf-confirm">
                    <span className="wf-confirm-text">Run workflow? {pendingRun.summary}</span>
                    <div className="wf-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-primary wf-confirm-btn"
                        disabled={!w.enabled}
                        onClick={() => confirmRun(w)}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost wf-confirm-btn"
                        onClick={() => setPendingRun(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}

          {creating ? (
            <div className="wf-form">
              <input
                className="wf-input"
                aria-label="Workflow name"
                placeholder="Workflow name"
                value={name}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="wf-steps">
                {steps.map((s, i) => (
                  <div key={s.id} className="wf-step">
                    <span className="wf-step-kind">{STEP_LABELS[s.kind]}</span>
                    <span className="wf-step-text">{s.command ?? s.instruction ?? ''}</span>
                    <button
                      type="button"
                      className="wf-act"
                      aria-label={`Remove ${STEP_LABELS[s.kind]} step ${i + 1}`}
                      title="Remove step"
                      onClick={() => setSteps((cur) => cur.filter((_, j) => j !== i))}
                    >
                      {'\u00D7'}
                    </button>
                  </div>
                ))}
              </div>
              <div className="wf-form-row">
                <select
                  className="wf-select"
                  aria-label="Step type"
                  value={stepKind}
                  onChange={(e) => setStepKind(e.target.value as StepKind)}
                >
                  {STEP_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {STEP_LABELS[k]}
                    </option>
                  ))}
                </select>
                <input
                  className="wf-input"
                  aria-label={stepKind === 'command' ? 'Step command' : 'Step instruction'}
                  placeholder={stepKind === 'command' ? 'command' : 'instruction (optional)'}
                  value={stepText}
                  spellCheck={false}
                  onChange={(e) => setStepText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addStep();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Add workflow step"
                  onClick={addStep}
                >
                  Add step
                </button>
              </div>
              <div className="wf-form-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={name.trim().length === 0 || steps.length === 0}
                  onClick={saveWorkflow}
                >
                  Save workflow
                </button>
                <button type="button" className="btn btn-ghost" onClick={resetForm}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost wf-new"
              onClick={() => setCreating(true)}
            >
              {'\uFF0B'} New workflow
            </button>
          )}
        </div>
      )}
    </div>
  );
}
