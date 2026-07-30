/**
 * Build execution consent — shared wire shape (pure).
 *
 * Lives in `common` so preload and the renderer can describe the value without
 * importing anything from Main. The consent itself is resolved and stored only by
 * `main/services/executionConsent.ts`.
 */

/** Where the grant came from, so the UI can explain it accurately. */
export type ExecutionConsentSource = 'installer' | 'in-app' | 'none';

export interface ExecutionConsentState {
  granted: boolean;
  source: ExecutionConsentSource;
  /** When the grant was recorded, or null when it never was. */
  at: number | null;
}
