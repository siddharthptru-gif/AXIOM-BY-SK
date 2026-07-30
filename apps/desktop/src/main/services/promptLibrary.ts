import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validatePrompt, type PromptTemplate } from '../../common/promptLibrary';

/**
 * Prompt library store (Main, PRD Epoch H §146 / Phase 234). Persists reusable
 * prompts to userData/prompts.json (atomic), sanitized via the pure validator, with
 * a usage counter. Search + interpolation are the pure `common/promptLibrary`
 * module; the renderer inserts prompts into the composer. Content only — no secrets.
 */
function filePath(): string {
  return join(app.getPath('userData'), 'prompts.json');
}

export async function listPrompts(): Promise<PromptTemplate[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PromptTemplate[] = [];
    for (const p of parsed) {
      const v = validatePrompt(p);
      if (v) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeAll(list: PromptTemplate[]): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-prompts-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list.slice(0, 200), null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function savePrompt(raw: unknown): Promise<PromptTemplate[]> {
  const validated = validatePrompt(raw);
  if (!validated) throw new Error('A prompt needs a name and a body.');
  const list = await listPrompts();
  const existing = list.find((p) => p.id === validated.id);
  // Preserve the usage count on update.
  const merged = existing ? { ...validated, uses: existing.uses } : validated;
  const next = [merged, ...list.filter((p) => p.id !== validated.id)];
  await writeAll(next);
  return next;
}

export async function deletePrompt(id: string): Promise<PromptTemplate[]> {
  const list = await listPrompts();
  const next = list.filter((p) => p.id !== id);
  await writeAll(next);
  return next;
}

/** Increment a prompt's usage counter (best-effort; used for ranking). */
export async function recordPromptUse(id: string): Promise<PromptTemplate[]> {
  const list = await listPrompts();
  const next = list.map((p) => (p.id === id ? { ...p, uses: p.uses + 1 } : p));
  await writeAll(next);
  return next;
}
