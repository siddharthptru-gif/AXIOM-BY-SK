/**
 * Multi-file Composer edit-plan (PRD Epoch G §130 / Phase 193). Pure helpers: build
 * the "produce a multi-file edit plan" prompt, and parse the model's reply into a
 * sanitized list of planned edits (create/modify/delete with full new contents).
 * Tolerant of fenced/prose output; never throws. Paths are validated workspace-
 * relative (reusing codeBlocks.isSafeRelPath); the runner resolves them to absolute
 * and applies through the all-or-nothing Safe Edit Engine. No I/O — unit-tested.
 */
import { isSafeRelPath } from './codeBlocks';

export type PlanAction = 'create' | 'modify' | 'delete';

export interface PlannedEdit {
  path: string;
  action: PlanAction;
  /** Full new file contents (required for create/modify; omitted for delete). */
  content?: string;
}

export interface EditPlan {
  edits: PlannedEdit[];
  raw: string;
}

const MAX_CONTENT = 200_000;

const COMPOSE_SYSTEM = [
  'You are a senior engineer making a coordinated, multi-file change.',
  'Return EXACTLY ONE JSON object and NOTHING else:',
  '{"edits":[{"path":"relative/path.ext","action":"create|modify|delete",',
  '"content":"FULL new file contents for create/modify; omit for delete"}]}',
  'Rules: paths are workspace-relative (no absolute paths, no ".."); for modify,',
  'return the COMPLETE new file (not a diff); keep the change coherent across files;',
  'only include files you actually change. If nothing needs changing, return',
  '{"edits":[]}.',
].join('\n');

/** Build the compose chat messages: strict JSON contract + instruction + context. */
export function buildComposeMessages(
  instruction: string,
  context?: string,
): { system: string; user: string } {
  const ctx =
    context !== undefined && context.trim().length > 0
      ? `\n\nRelevant workspace context:\n${context}`
      : '';
  return { system: COMPOSE_SYSTEM, user: `Change request:\n${instruction}${ctx}` };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Extract the first JSON object from model text (handles ``` fences + prose). */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      return asRecord(JSON.parse(s.trim()));
    } catch {
      return null;
    }
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}

const ACTIONS: readonly PlanAction[] = ['create', 'modify', 'delete'];

function sanitizeEdit(input: unknown): PlannedEdit | null {
  const o = asRecord(input);
  if (!o) return null;
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  if (!isSafeRelPath(path)) return null;
  const action = (ACTIONS as readonly string[]).includes(o.action as string)
    ? (o.action as PlanAction)
    : null;
  if (!action) return null;
  if (action === 'delete') return { path, action };
  if (typeof o.content !== 'string') return null; // create/modify need contents
  return { path, action, content: o.content.slice(0, MAX_CONTENT) };
}

/** Parse a compose reply into sanitized planned edits (dedup by path, first wins). */
export function parseEditPlan(text: string): PlannedEdit[] {
  const obj = extractJson(text);
  const arr = obj && Array.isArray(obj.edits) ? obj.edits : [];
  const seen = new Set<string>();
  const out: PlannedEdit[] = [];
  for (const raw of arr) {
    const edit = sanitizeEdit(raw);
    if (edit && !seen.has(edit.path)) {
      seen.add(edit.path);
      out.push(edit);
    }
  }
  return out;
}

/** Short human summary of a plan (e.g. "2 create, 1 modify"). */
export function summarizeEditPlan(edits: readonly PlannedEdit[]): string {
  const by: Record<PlanAction, number> = { create: 0, modify: 0, delete: 0 };
  for (const e of edits) by[e.action]++;
  const parts: string[] = [];
  if (by.create) parts.push(`${by.create} create`);
  if (by.modify) parts.push(`${by.modify} modify`);
  if (by.delete) parts.push(`${by.delete} delete`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}
