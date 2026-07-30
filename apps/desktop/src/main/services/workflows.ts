import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateWorkflow, type Workflow } from '../../common/workflows';
import { appendAudit } from './audit';

/**
 * Workflow store (Main, PRD Epoch H §148 / Phase 236). Persists user-defined
 * workflows to userData/workflows.json (atomic temp+rename), sanitized through the
 * pure validator (which defaults them DISABLED and gates mutating steps). Actual
 * execution reuses the agent run path (approval-gated + snapshotted + audited);
 * this module only stores + audits definitions. No secrets or code recorded.
 */
function filePath(): string {
  return join(app.getPath('userData'), 'workflows.json');
}

export async function listWorkflows(): Promise<Workflow[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Workflow[] = [];
    for (const w of parsed) {
      const v = validateWorkflow(w);
      if (v) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeAll(list: Workflow[]): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-workflows-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list.slice(0, 100), null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Create or update a manual workflow (sanitized). Returns the saved list. */
export async function saveWorkflow(raw: unknown): Promise<Workflow[]> {
  const validated = validateWorkflow(raw);
  if (!validated) throw new Error('A workflow needs a name and at least a trigger.');
  if (validated.trigger.kind !== 'manual') {
    throw new Error(
      'Automatic workflow triggers are unavailable. Create a manual workflow and run it explicitly.',
    );
  }
  const list = await listWorkflows();
  const next = [validated, ...list.filter((w) => w.id !== validated.id)];
  await writeAll(next);
  void appendAudit(
    'workflow.save',
    `Workflow saved: ${validated.name} (${validated.trigger.kind}, ${validated.steps.length} steps, ${
      validated.enabled ? 'enabled' : 'disabled'
    })`,
  );
  return next;
}

/** Delete a workflow by id. Returns the remaining list. */
export async function deleteWorkflow(id: string): Promise<Workflow[]> {
  const list = await listWorkflows();
  const target = list.find((w) => w.id === id);
  const next = list.filter((w) => w.id !== id);
  await writeAll(next);
  if (target) void appendAudit('workflow.delete', `Workflow deleted: ${target.name}`);
  return next;
}

/** Enable or disable whether a stored workflow may be run manually. */
export async function setWorkflowEnabled(id: string, enabled: boolean): Promise<Workflow[]> {
  const list = await listWorkflows();
  const next = list.map((w) => (w.id === id ? { ...w, enabled } : w));
  await writeAll(next);
  const target = next.find((w) => w.id === id);
  if (target) {
    void appendAudit(
      'workflow.enable',
      `Workflow ${enabled ? 'enabled' : 'disabled'}: ${target.name}`,
    );
  }
  return next;
}
