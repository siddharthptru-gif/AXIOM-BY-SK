import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Checkpoint, SnapshotEntry } from '../../../common/snapshot';
import { buildReviewHunks } from '../../../common/reviewSession';
import { useWorkspace } from '../state/workspace';
import { notifyError, notifyInfo } from '../notifications/bus';
import { onTimelineOpen } from './timelineBus';
import { DialogFrame } from './Modal';
import { ShieldIcon, WarningIcon } from './icons';

/**
 * Timeline / time travel (T2.9).
 *
 * Every AI edit snapshots the files it is about to touch, so the history already
 * exists — what was missing was a way to *see* it and to move through it safely.
 * This dialog lays the checkpoints out chronologically (grouped by day, newest
 * first) and, for the selected one, shows exactly how each captured file differs
 * from what is on disk right now.
 *
 * Restoring overwrites working files, so it is deliberately two-step: the button
 * arms a confirmation that names every file that will be rewritten and every file
 * that will be deleted (a checkpoint entry captured as "absent" restores to absent).
 * Nothing is restored on a single click.
 */
const MAX_DETAIL_FILES = 200;

interface EntryDelta {
  /**
   * 'missing' = the file was deleted after the checkpoint; 'error' = the comparison
   * could not be made, which is reported rather than shown as "unchanged".
   */
  state: 'loading' | 'same' | 'changed' | 'missing' | 'error';
  added: number;
  removed: number;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function relTo(root: string | null, path: string): string {
  if (!root || !path.startsWith(root)) return path;
  return path
    .slice(root.length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
}

/** Human "time ago", so a timeline reads as a timeline rather than timestamps. */
export function timeAgo(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Day bucket label for grouping ('Today' / 'Yesterday' / a date). */
export function dayLabel(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(day, today)) return 'Today';
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (sameDay(day, yesterday)) return 'Yesterday';
  try {
    return day.toLocaleDateString();
  } catch {
    return String(at);
  }
}

function fmtTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return String(at);
  }
}

/** Order-preserving day grouping of an already newest-first checkpoint list. */
function groupByDay(
  checkpoints: readonly Checkpoint[],
  now: number,
): Array<{
  label: string;
  items: Checkpoint[];
}> {
  const groups: Array<{ label: string; items: Checkpoint[] }> = [];
  for (const checkpoint of checkpoints) {
    const label = dayLabel(checkpoint.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(checkpoint);
    else groups.push({ label, items: [checkpoint] });
  }
  return groups;
}

export function TimelineView() {
  const { rootPath, openFileAt } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Record<string, EntryDelta>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    void window.axiom.snapshots
      .list()
      .then((list) => {
        setCheckpoints(list);
        setNow(Date.now());
        setSelected((current) =>
          current !== null && list.some((item) => item.runId === current)
            ? current
            : (list[0]?.runId ?? null),
        );
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(
    () =>
      onTimelineOpen(() => {
        setOpen(true);
        setArmed(null);
        setDeltas({});
        load();
      }),
    [load],
  );

  const active = useMemo(
    () => checkpoints.find((checkpoint) => checkpoint.runId === selected) ?? null,
    [checkpoints, selected],
  );

  // Compare each captured file against what is on disk now. Read-only and
  // best-effort: a file that cannot be read reports 'error', never a false "same".
  useEffect(() => {
    if (!open || !active) return;
    let alive = true;
    const entries = active.entries.slice(0, MAX_DETAIL_FILES);
    setDeltas(
      Object.fromEntries(
        entries.map((entry) => [entry.id, { state: 'loading', added: 0, removed: 0 }]),
      ),
    );
    void (async () => {
      for (const entry of entries) {
        if (!alive) return;
        let next: EntryDelta = { state: 'error', added: 0, removed: 0 };
        try {
          const [captured, current] = await Promise.all([
            window.axiom.snapshots.readEntry(entry.id),
            window.axiom.fs
              .readFile(entry.path)
              .then((file) => file.content)
              .catch(() => null),
          ]);
          if (!entry.existed) {
            next =
              current === null
                ? { state: 'same', added: 0, removed: 0 }
                : { state: 'changed', added: current.split('\n').length, removed: 0 };
          } else if (captured === null) {
            next = { state: 'error', added: 0, removed: 0 };
          } else if (current === null) {
            next = { state: 'missing', added: 0, removed: 0 };
          } else if (captured === current) {
            next = { state: 'same', added: 0, removed: 0 };
          } else {
            const session = buildReviewHunks(captured, current);
            next = { state: 'changed', added: session.added, removed: session.removed };
          }
        } catch {
          next = { state: 'error', added: 0, removed: 0 };
        }
        if (!alive) return;
        setDeltas((prev) => ({ ...prev, [entry.id]: next }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, active]);

  const close = useCallback((): void => {
    setOpen(false);
    setArmed(null);
  }, []);

  const restoreCheckpoint = useCallback(
    (runId: string): void => {
      setBusy(true);
      setError(null);
      void window.axiom.snapshots
        .restore(runId)
        .then((result) => {
          notifyInfo(
            `Restored ${result.restored} file(s) from this checkpoint. Reopen affected tabs to see the change.`,
            { source: 'Timeline' },
          );
          setArmed(null);
          load();
        })
        .catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          setError(detail);
          notifyError('Could not restore this checkpoint', { source: 'Timeline', detail });
        })
        .finally(() => setBusy(false));
    },
    [load],
  );

  const restoreEntry = useCallback((entry: SnapshotEntry): void => {
    setBusy(true);
    setError(null);
    void window.axiom.snapshots
      .restoreEntry(entry.id)
      .then((result) => {
        notifyInfo(
          result ? `Restored ${baseName(result.path)}.` : 'That snapshot is no longer available.',
          { source: 'Timeline' },
        );
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(detail);
        notifyError('Could not restore that file', { source: 'Timeline', detail });
      })
      .finally(() => setBusy(false));
  }, []);

  if (!open) return null;

  const groups = groupByDay(checkpoints, now);
  const willDelete = active?.entries.filter((entry) => !entry.existed) ?? [];
  const willRewrite = active?.entries.filter((entry) => entry.existed) ?? [];

  return (
    <DialogFrame
      onClose={close}
      overlayClassName="timeline-overlay"
      cardClassName="timeline-card"
      ariaLabelledBy="timeline-title"
    >
      <header className="timeline-header">
        <div>
          <h2 id="timeline-title" className="timeline-title">
            Timeline
          </h2>
          <p className="timeline-lead">
            Every AI edit snapshots the files it touches first. Step back to any point — restore a
            whole checkpoint or a single file.
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={load} disabled={loading || busy}>
          {loading ? 'Loading\u2026' : 'Refresh'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={close}>
          Close
        </button>
      </header>

      {error ? (
        <div className="timeline-error" role="alert">
          <WarningIcon size={14} />
          {error}
        </div>
      ) : null}

      <div className="timeline-body">
        <nav className="timeline-rail" aria-label="Checkpoints, newest first">
          {loading && checkpoints.length === 0 ? (
            <p className="timeline-empty">{'Loading checkpoints\u2026'}</p>
          ) : checkpoints.length === 0 ? (
            <p className="timeline-empty">
              No checkpoints yet. One is captured automatically before any AI edit, and you can take
              one manually from the Checkpoints panel.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="timeline-day">
                <div className="timeline-day-label">{group.label}</div>
                {group.items.map((checkpoint) => {
                  const isActive = checkpoint.runId === selected;
                  return (
                    <button
                      key={checkpoint.runId}
                      type="button"
                      className={`timeline-node${isActive ? ' is-active' : ''}`}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => {
                        setSelected(checkpoint.runId);
                        setArmed(null);
                      }}
                    >
                      <span className="timeline-node-dot" aria-hidden="true" />
                      <span className="timeline-node-body">
                        <span className="timeline-node-label">
                          {checkpoint.label ?? 'Checkpoint'}
                        </span>
                        <span className="timeline-node-meta">
                          {timeAgo(checkpoint.createdAt, now)} · {fmtTime(checkpoint.createdAt)} ·{' '}
                          {checkpoint.entries.length} file
                          {checkpoint.entries.length === 1 ? '' : 's'}
                          {checkpoint.model ? ` · ${checkpoint.model}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </nav>

        <section className="timeline-detail" aria-label="Checkpoint contents">
          {active === null ? (
            <p className="timeline-empty">Select a checkpoint to see what it captured.</p>
          ) : (
            <>
              <div className="timeline-detail-head">
                <strong>{active.label ?? 'Checkpoint'}</strong>
                <span className="timeline-node-meta">
                  {timeAgo(active.createdAt, now)} · {active.entries.length} file
                  {active.entries.length === 1 ? '' : 's'}
                </span>
              </div>

              {armed === active.runId ? (
                <div className="timeline-confirm" role="alert">
                  <WarningIcon size={14} />
                  <div>
                    <strong>Restore this checkpoint?</strong>
                    <p>
                      {willRewrite.length} file{willRewrite.length === 1 ? '' : 's'} will be
                      overwritten with the captured version
                      {willDelete.length > 0
                        ? `, and ${willDelete.length} file${
                            willDelete.length === 1 ? '' : 's'
                          } created after this point will be deleted`
                        : ''}
                      . Unsaved editor changes to those files are not part of this operation.
                    </p>
                    <div className="timeline-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={() => restoreCheckpoint(active.runId)}
                      >
                        {busy ? 'Restoring\u2026' : 'Restore, overwriting these files'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => setArmed(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="timeline-detail-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || active.entries.length === 0}
                    onClick={() => setArmed(active.runId)}
                  >
                    Restore this checkpoint
                  </button>
                </div>
              )}

              <ul className="timeline-files">
                {active.entries.slice(0, MAX_DETAIL_FILES).map((entry) => {
                  const delta = deltas[entry.id];
                  const rel = relTo(rootPath, entry.path);
                  return (
                    <li key={entry.id} className="timeline-file">
                      <button
                        type="button"
                        className="timeline-file-open"
                        title={entry.path}
                        onClick={() => openFileAt(entry.path, baseName(entry.path), 1, 1)}
                      >
                        {rel}
                      </button>
                      <span className="timeline-file-delta">
                        {!entry.existed
                          ? delta?.state === 'same'
                            ? 'did not exist · still absent'
                            : 'did not exist · restoring deletes it'
                          : delta === undefined || delta.state === 'loading'
                            ? 'comparing\u2026'
                            : delta.state === 'same'
                              ? 'unchanged since'
                              : delta.state === 'missing'
                                ? 'deleted since'
                                : delta.state === 'error'
                                  ? 'could not compare'
                                  : `+${delta.added} / -${delta.removed} since`}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost timeline-file-restore"
                        disabled={busy}
                        onClick={() => restoreEntry(entry)}
                      >
                        Restore file
                      </button>
                    </li>
                  );
                })}
              </ul>
              {active.entries.length > MAX_DETAIL_FILES ? (
                <p className="timeline-empty">
                  Showing the first {MAX_DETAIL_FILES} of {active.entries.length} files.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>

      <p className="timeline-foot">
        <ShieldIcon size={13} />
        Checkpoints are stored locally, content-addressed, and pruned automatically. Nothing here
        leaves your machine.
      </p>
    </DialogFrame>
  );
}
