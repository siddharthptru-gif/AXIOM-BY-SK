/**
 * Mid-conversation switching, pinning & overrides (Phase 166).
 *
 * PURE module (no I/O, no Electron). Models a conversation's active provider/model,
 * whether it is PINNED (locked for the thread), and how a per-MESSAGE override
 * resolves against it. Precedence: a pin wins (locks the thread to one model so a
 * stray override can't change it), else an explicit message override wins, else the
 * conversation's current model. Deterministic — the chat UI holds the state, this
 * decides the effective model for each turn.
 */

export interface ConversationModel {
  provider: string;
  model: string;
  /** When true, the thread is locked to this model (overrides are ignored). */
  pinned: boolean;
}

export interface ModelOverride {
  provider?: string;
  model?: string;
}

export type ModelSource = 'pinned' | 'override' | 'conversation';

export interface ResolvedModel {
  provider: string;
  model: string;
  source: ModelSource;
}

/** Create the initial conversation model state (unpinned by default). */
export function createConversationModel(
  provider: string,
  model: string,
  pinned = false,
): ConversationModel {
  return { provider, model, pinned };
}

/** True when an override actually specifies a provider or model. */
function hasOverride(o: ModelOverride | undefined): o is ModelOverride {
  return (
    o !== undefined &&
    ((typeof o.provider === 'string' && o.provider.length > 0) ||
      (typeof o.model === 'string' && o.model.length > 0))
  );
}

/**
 * Resolve the effective model for a turn. A pin locks the thread; otherwise a
 * message override (partial — provider and/or model) applies over the conversation
 * default; otherwise the conversation model is used.
 */
export function resolveModel(conv: ConversationModel, override?: ModelOverride): ResolvedModel {
  if (conv.pinned) {
    return { provider: conv.provider, model: conv.model, source: 'pinned' };
  }
  if (hasOverride(override)) {
    return {
      provider:
        override.provider && override.provider.length > 0 ? override.provider : conv.provider,
      model: override.model && override.model.length > 0 ? override.model : conv.model,
      source: 'override',
    };
  }
  return { provider: conv.provider, model: conv.model, source: 'conversation' };
}

export interface SwitchOptions {
  /** Also pin the thread to the new model. */
  pin?: boolean;
}

/** Switch the conversation's active provider/model mid-thread. */
export function switchModel(
  conv: ConversationModel,
  next: { provider?: string; model?: string },
  options: SwitchOptions = {},
): ConversationModel {
  return {
    provider: next.provider && next.provider.length > 0 ? next.provider : conv.provider,
    model: next.model && next.model.length > 0 ? next.model : conv.model,
    pinned: options.pin ?? conv.pinned,
  };
}

/** Pin or unpin the thread to its current model. */
export function setPinned(conv: ConversationModel, pinned: boolean): ConversationModel {
  return { ...conv, pinned };
}

/** A short label for the current model + pin state. */
export function modelLabel(conv: ConversationModel): string {
  return `${conv.provider}/${conv.model}${conv.pinned ? ' (pinned)' : ''}`;
}
