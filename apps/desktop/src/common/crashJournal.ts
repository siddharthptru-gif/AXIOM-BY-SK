/**
 * Crash-recovery journal core (PRD Epoch A / Part VI §88.6). Pure state for a small
 * breadcrumb journal: record the last N phases the app moved through, mark a clean
 * exit, and — on the next startup — detect whether the previous session ended
 * uncleanly (journal exists but was never marked clean) so the app can surface a
 * recovery notice. No I/O — the Main service persists it. Smoke-tested.
 */
export interface Breadcrumb {
  phase: string;
  at: number;
}

export interface JournalState {
  startedAt: number;
  breadcrumbs: Breadcrumb[];
  cleanExit: boolean;
  /** App version that wrote the journal (for cross-version awareness). */
  version?: string;
}

const MAX_BREADCRUMBS = 50;

/** Start a fresh journal for a session (cleanExit = false until marked). */
export function newJournal(now: number, version?: string): JournalState {
  return {
    startedAt: now,
    breadcrumbs: [{ phase: 'startup', at: now }],
    cleanExit: false,
    ...(version !== undefined ? { version } : {}),
  };
}

/** Append a phase breadcrumb (ring buffer capped at MAX_BREADCRUMBS). */
export function markPhase(journal: JournalState, phase: string, now: number): JournalState {
  const breadcrumbs = [...journal.breadcrumbs, { phase, at: now }];
  if (breadcrumbs.length > MAX_BREADCRUMBS)
    breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
  return { ...journal, breadcrumbs };
}

/** Mark the session as having exited cleanly. */
export function markCleanExit(journal: JournalState): JournalState {
  return { ...journal, cleanExit: true };
}

/** Sanitize an arbitrary parsed journal object (defensive read from disk). */
export function parseJournal(raw: unknown): JournalState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.startedAt !== 'number') return null;
  const breadcrumbs = Array.isArray(o.breadcrumbs)
    ? o.breadcrumbs
        .filter(
          (b): b is Breadcrumb =>
            !!b &&
            typeof b === 'object' &&
            typeof (b as Breadcrumb).phase === 'string' &&
            typeof (b as Breadcrumb).at === 'number',
        )
        .slice(-MAX_BREADCRUMBS)
    : [];
  return {
    startedAt: o.startedAt,
    breadcrumbs,
    cleanExit: o.cleanExit === true,
    ...(typeof o.version === 'string' ? { version: o.version } : {}),
  };
}

/** A previous session ended uncleanly if its journal exists and was never marked clean. */
export function detectUncleanShutdown(prev: JournalState | null): boolean {
  return prev !== null && prev.cleanExit === false;
}

/** The last phase recorded before an unclean exit (or null). */
export function lastPhase(journal: JournalState | null): Breadcrumb | null {
  if (!journal || journal.breadcrumbs.length === 0) return null;
  return journal.breadcrumbs[journal.breadcrumbs.length - 1] ?? null;
}

/** A human-readable recovery summary for the previous (unclean) session. */
export function recoverySummary(prev: JournalState | null, now: number = Date.now()): string {
  if (!detectUncleanShutdown(prev) || !prev) return '';
  const last = lastPhase(prev);
  const agoMin = Math.max(0, Math.round((now - (last?.at ?? prev.startedAt)) / 60000));
  const when =
    agoMin < 1 ? 'moments ago' : agoMin < 60 ? `${agoMin}m ago` : `${Math.round(agoMin / 60)}h ago`;
  const phase = last ? last.phase : 'unknown';
  return `Axiom didn't shut down cleanly last time (last phase: "${phase}", ${when}). Review reopened files: tabs restore from disk, but unsaved editor contents are not crash-recovered.`;
}

export interface RecoveryNotice {
  unclean: boolean;
  summary: string;
}

/** The recovery notice to show on startup, computed from the prior journal. */
export function buildRecoveryNotice(
  prev: JournalState | null,
  now: number = Date.now(),
): RecoveryNotice {
  const unclean = detectUncleanShutdown(prev);
  return { unclean, summary: unclean ? recoverySummary(prev, now) : '' };
}
