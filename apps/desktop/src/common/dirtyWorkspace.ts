export interface DirtyWorkspaceSnapshot {
  ownerId: number;
  root: string | null;
  dirty: boolean;
  generation: number;
}

export interface DirtyWorkspaceTransition extends DirtyWorkspaceSnapshot {
  becameDirty: boolean;
}

function rootKey(root: string): string {
  const slashNormalized = root
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  return /^[a-zA-Z]:\//.test(slashNormalized) || root.startsWith('\\\\')
    ? slashNormalized.toLowerCase()
    : slashNormalized;
}

function sameRoot(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return rootKey(left) === rootKey(right);
}

/** Main-owned state keyed by renderer owner and canonical workspace root. */
export class DirtyWorkspaceRegistry {
  readonly #states = new Map<number, DirtyWorkspaceSnapshot>();

  set(ownerId: number, root: string | null, dirty: boolean): DirtyWorkspaceTransition {
    const previous = this.#states.get(ownerId);
    const next: DirtyWorkspaceSnapshot = {
      ownerId,
      root,
      dirty,
      generation: (previous?.generation ?? 0) + 1,
    };
    this.#states.set(ownerId, next);
    return {
      ...next,
      becameDirty: dirty && (!previous?.dirty || !sameRoot(previous.root, root)),
    };
  }

  /**
   * Canonicalize a provisional renderer update only if it is still the newest
   * update for that owner. Async root resolution from an older request therefore
   * cannot overwrite a newer dirty/clean or workspace transition.
   */
  reconcile(
    ownerId: number,
    generation: number,
    canonicalRoot: string | null,
  ): DirtyWorkspaceTransition | null {
    const current = this.#states.get(ownerId);
    if (!current || current.generation !== generation) return null;
    const rootChanged = !sameRoot(current.root, canonicalRoot);
    const next: DirtyWorkspaceSnapshot = { ...current, root: canonicalRoot };
    this.#states.set(ownerId, next);
    return {
      ...next,
      becameDirty: current.dirty && rootChanged,
    };
  }

  snapshot(ownerId: number): DirtyWorkspaceSnapshot | null {
    const state = this.#states.get(ownerId);
    return state ? { ...state } : null;
  }

  hasDirty(ownerId: number): boolean {
    return this.#states.get(ownerId)?.dirty === true;
  }

  isDirty(ownerId: number, root: string): boolean {
    const state = this.#states.get(ownerId);
    return state?.dirty === true && sameRoot(state.root, root);
  }

  assertClean(ownerId: number, root: string): void {
    if (this.isDirty(ownerId, root)) {
      throw new Error('Agent mutation blocked because this workspace has unsaved editor changes.');
    }
  }

  clear(ownerId: number): void {
    this.#states.delete(ownerId);
  }
}
