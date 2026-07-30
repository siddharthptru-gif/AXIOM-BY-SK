/**
 * Recovery, resilience & chaos (PRD Epoch J §225 / Phase 277). Pure decision core
 * for startup recovery: per-store corruption handling (restore-backup / rebuild /
 * reset / quarantine), a SAFE-MODE decision (repeated unclean exits or a critical
 * store corrupt with no backup), bad-update rollback, and interrupted-agent resume.
 * No I/O — the Main startup path feeds it signals (unclean-exit count from the crash
 * journal, per-store integrity, the last update's health, interrupted run count) and
 * applies the plan. Complements crashJournal (unclean-exit detection), safeEdit
 * (atomic writes), and runJournal (agent runs). Smoke-tested.
 */

export type StoreStatus = 'ok' | 'corrupt' | 'missing';

export interface StoreSignal {
  /** e.g. 'settings', 'catalog.db', 'snapshots/index.json'. */
  name: string;
  status: StoreStatus;
  /** A critical store (settings/auth) vs. rebuildable derived data (index/cache). */
  critical?: boolean;
}

export type RecoveryAction = 'keep' | 'restore-backup' | 'rebuild' | 'reset' | 'quarantine';

export interface StoreRecovery {
  name: string;
  action: RecoveryAction;
  reason: string;
}

/**
 * Decide how to recover a single store. Healthy → keep. Missing → reset (critical)
 * or rebuild (derived). Corrupt → restore a backup if one exists, else quarantine
 * the bad copy (critical, keep it for diagnostics + start fresh) or rebuild (derived).
 */
export function planStoreRecovery(signal: StoreSignal, hasBackup: boolean): StoreRecovery {
  const critical = signal.critical === true;
  if (signal.status === 'ok') {
    return { name: signal.name, action: 'keep', reason: 'Healthy.' };
  }
  if (signal.status === 'missing') {
    return critical
      ? { name: signal.name, action: 'reset', reason: 'Missing \u2014 reset to defaults.' }
      : { name: signal.name, action: 'rebuild', reason: 'Missing \u2014 will be rebuilt.' };
  }
  // corrupt
  if (hasBackup) {
    return {
      name: signal.name,
      action: 'restore-backup',
      reason: 'Corrupt \u2014 restoring the last good backup.',
    };
  }
  return critical
    ? {
        name: signal.name,
        action: 'quarantine',
        reason: 'Corrupt, no backup \u2014 quarantined for diagnostics; starting fresh.',
      }
    : { name: signal.name, action: 'rebuild', reason: 'Corrupt \u2014 rebuilding derived data.' };
}

export interface RecoveryInputs {
  /** Consecutive unclean exits (from the crash journal). */
  uncleanExits: number;
  stores: StoreSignal[];
  /** Store name → whether a backup exists. */
  backups: Record<string, boolean>;
  /** Did we just apply an app update this launch? */
  lastUpdateApplied?: boolean;
  /** After the update, did the app reach a healthy state? (false = bad update) */
  lastUpdateHealthy?: boolean;
  /** Agent runs left mid-flight by the previous session. */
  interruptedAgentRuns?: number;
}

/** Consecutive unclean exits at/after which we start in safe mode. */
export const SAFE_MODE_CRASH_THRESHOLD = 3;

export interface RecoveryPlan {
  safeMode: boolean;
  safeModeReason: string;
  stores: StoreRecovery[];
  rollbackUpdate: boolean;
  /** Runs the user may resume (0 in safe mode). */
  resumableAgentRuns: number;
  summary: string;
}

function nonNegInt(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Build the full startup recovery plan from the collected signals. Enters safe mode
 * on repeated unclean exits or an unrecoverable critical store; rolls back a bad
 * update; and reports how many interrupted agent runs can be resumed.
 */
export function planRecovery(inputs: RecoveryInputs): RecoveryPlan {
  const stores = inputs.stores.map((s) => planStoreRecovery(s, inputs.backups[s.name] === true));
  const crashes = nonNegInt(inputs.uncleanExits);
  const criticalUnrecoverable = inputs.stores.some(
    (s) => s.critical === true && s.status === 'corrupt' && inputs.backups[s.name] !== true,
  );

  let safeMode = false;
  let safeModeReason = 'Normal startup.';
  if (crashes >= SAFE_MODE_CRASH_THRESHOLD) {
    safeMode = true;
    safeModeReason = `${crashes} consecutive unclean exits \u2014 starting in safe mode.`;
  } else if (criticalUnrecoverable) {
    safeMode = true;
    safeModeReason = 'A critical store was corrupt with no backup \u2014 safe mode.';
  }

  const rollbackUpdate = inputs.lastUpdateApplied === true && inputs.lastUpdateHealthy === false;
  const resumableAgentRuns = safeMode ? 0 : nonNegInt(inputs.interruptedAgentRuns);

  const bits: string[] = [];
  const recovered = stores.filter((s) => s.action !== 'keep');
  if (recovered.length > 0) bits.push(`${recovered.length} store(s) recovered`);
  if (rollbackUpdate) bits.push('rolling back a bad update');
  if (resumableAgentRuns > 0) bits.push(`${resumableAgentRuns} agent run(s) resumable`);
  const summary = safeMode
    ? `Safe mode: ${safeModeReason}`
    : bits.length > 0
      ? `Recovered on startup: ${bits.join(', ')}.`
      : 'Clean startup \u2014 nothing to recover.';

  return { safeMode, safeModeReason, stores, rollbackUpdate, resumableAgentRuns, summary };
}
