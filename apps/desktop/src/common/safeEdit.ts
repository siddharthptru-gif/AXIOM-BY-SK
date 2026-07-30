/**
 * Safe Edit Engine core (PRD Epoch G §142.4 / Phase 172). Pure validation + batch
 * planning for staged, atomic, corruption-proof edits: an edit carries the hash of
 * the content it was generated against, so a file that changed underneath is
 * rejected as stale (conflict) rather than silently clobbered. A batch is
 * all-or-nothing — if any edit is invalid the whole batch is rejected with
 * reasons, so files never end up half-written. No I/O; the Main service reads
 * current file states, calls these, then applies atomically after snapshotting.
 */

export type EditKind = 'create' | 'modify' | 'delete';

export type StagedEdit =
  | {
      path: string;
      kind: 'create';
      /** Full new content. */
      newText: string;
      /** Creates have no current content to hash. */
      baseHash?: never;
    }
  | {
      path: string;
      kind: 'modify';
      /** Full replacement content. */
      newText: string;
      /** SHA-256 of the exact current content the replacement was generated from. */
      baseHash: string;
    }
  | {
      path: string;
      kind: 'delete';
      /** SHA-256 of the exact current content being deleted. */
      baseHash: string;
      newText?: never;
    };

export interface FileState {
  exists: boolean;
  /** sha256 of current content, or '' if absent. */
  hash: string;
}

export type EditValidation = { ok: true } | { ok: false; reason: string };

export interface EditPlanItem {
  edit: StagedEdit;
  validation: EditValidation;
}

export interface BatchPlan {
  /** True only if every edit validated. */
  ok: boolean;
  items: EditPlanItem[];
  rejected: { path: string; reason: string }[];
}

export interface ApplyResult {
  ok: boolean;
  applied: string[];
  runId?: string;
  rejected?: { path: string; reason: string }[];
  error?: string;
  /** True when unresolved committed paths require this run's checkpoint to be retained. */
  recoveryRequired?: boolean;
  /** Non-fatal snapshot housekeeping issue; the file outcome is unchanged. */
  warning?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** True only for a complete SHA-256 hex digest. */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** Validate a single edit against the current on-disk state (pure). */
export function validateEdit(edit: StagedEdit, state: FileState): EditValidation {
  switch (edit.kind) {
    case 'create':
      if (typeof edit.newText !== 'string') return { ok: false, reason: 'create requires newText' };
      if (Object.prototype.hasOwnProperty.call(edit, 'baseHash')) {
        return { ok: false, reason: 'create must not include baseHash' };
      }
      if (state.exists) return { ok: false, reason: 'file already exists' };
      return { ok: true };
    case 'modify':
      if (typeof edit.newText !== 'string') return { ok: false, reason: 'modify requires newText' };
      if (!isSha256(edit.baseHash)) {
        return { ok: false, reason: 'modify requires a valid SHA-256 baseHash' };
      }
      if (!state.exists) return { ok: false, reason: 'file does not exist' };
      if (edit.baseHash.toLowerCase() !== state.hash.toLowerCase()) {
        return { ok: false, reason: 'file changed since the edit was generated (stale)' };
      }
      return { ok: true };
    case 'delete':
      if (Object.prototype.hasOwnProperty.call(edit, 'newText')) {
        return { ok: false, reason: 'delete must not include newText' };
      }
      if (!isSha256(edit.baseHash)) {
        return { ok: false, reason: 'delete requires a valid SHA-256 baseHash' };
      }
      if (!state.exists) return { ok: false, reason: 'file does not exist' };
      if (edit.baseHash.toLowerCase() !== state.hash.toLowerCase()) {
        return { ok: false, reason: 'file changed since the edit was generated (stale)' };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        reason: `unknown edit kind: ${String((edit as { kind?: unknown }).kind)}`,
      };
  }
}

/**
 * Plan a batch: validate every edit against its file state (all-or-nothing). A path
 * targeted by more than one edit in the same batch is ambiguous and rejected.
 */
export function planBatch(
  edits: readonly StagedEdit[],
  states: ReadonlyMap<string, FileState>,
): BatchPlan {
  const counts = new Map<string, number>();
  for (const e of edits) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);

  const items: EditPlanItem[] = edits.map((edit) => {
    if ((counts.get(edit.path) ?? 0) > 1) {
      return { edit, validation: { ok: false, reason: 'duplicate path in batch' } };
    }
    const state = states.get(edit.path) ?? { exists: false, hash: '' };
    return { edit, validation: validateEdit(edit, state) };
  });

  const rejected = items
    .filter(
      (i): i is EditPlanItem & { validation: { ok: false; reason: string } } => !i.validation.ok,
    )
    .map((i) => ({ path: i.edit.path, reason: i.validation.reason }));

  return { ok: rejected.length === 0, items, rejected };
}

/** Short human summary of a plan (for logs / UI). */
export function summarizePlan(plan: BatchPlan): string {
  if (!plan.ok) {
    return `Rejected: ${plan.rejected.map((r) => `${r.path} (${r.reason})`).join('; ')}`;
  }
  const by: Record<EditKind, number> = { create: 0, modify: 0, delete: 0 };
  for (const i of plan.items) by[i.edit.kind]++;
  const parts: string[] = [];
  if (by.create) parts.push(`${by.create} create`);
  if (by.modify) parts.push(`${by.modify} modify`);
  if (by.delete) parts.push(`${by.delete} delete`);
  return parts.length > 0 ? parts.join(', ') : 'no edits';
}
