import { useEffect, useRef, useState } from 'react';
import type { Checkpoint, SnapshotEntry } from '../../../common/snapshot';
import {
  applySelectedHunks,
  buildReviewHunks,
  type ReviewHunk,
} from '../../../common/reviewSession';
import { useWorkspace } from '../state/workspace';
import { openTimeline } from './timelineBus';
import { ChevronIcon } from './treeIcons';

/**
 * Checkpoints panel (PRD Epoch G §143 / Phase 171). Surfaces the local snapshot
 * timeline — each checkpoint is the set of files captured before an edit — with
 * one-click restore of a whole checkpoint or a single file, plus a manual
 * "capture" of the active file. Collapsed by default (loads on demand). Local +
 * reversible; the content is content-addressed and pruned by TTL + count.
 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function CheckpointsView() {
  const { activePath, rootPath, openFileAt } = useWorkspace();
  const [collapsed, setCollapsed] = useState(true);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = (): void => {
    const id = ++reqRef.current;
    setLoading(true);
    window.axiom.snapshots
      .list()
      .then((list) => {
        if (reqRef.current !== id) return;
        setCheckpoints(list);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (reqRef.current !== id) return;
        setStatus(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    if (!collapsed) load();
  }, [collapsed]);

  const capture = (): void => {
    if (!activePath) return;
    setStatus(null);
    window.axiom.snapshots
      .capture([activePath], 'Manual checkpoint')
      .then(() => {
        setStatus('Checkpoint captured.');
        load();
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  const restoreCheckpoint = (runId: string): void => {
    setStatus(null);
    window.axiom.snapshots
      .restore(runId)
      .then((r) =>
        setStatus(`Restored ${r.restored} file(s). Reopen affected tabs to see changes.`),
      )
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  const restoreEntry = (entryId: string): void => {
    setStatus(null);
    window.axiom.snapshots
      .restoreEntry(entryId)
      .then((r) => setStatus(r ? `Restored ${baseName(r.path)}.` : 'Snapshot not found.'))
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  const clearAll = (): void => {
    window.axiom.snapshots
      .clear()
      .then(() => {
        setStatus('Cleared all snapshots.');
        load();
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="checkpoints-view">
      <div
        className="oe-header"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((c) => !c);
          }
        }}
      >
        <span className="oe-chevron">
          <ChevronIcon open={!collapsed} />
        </span>
        <span className="oe-title">Checkpoints</span>
        {!collapsed && checkpoints.length > 0 ? (
          <span className="oe-count">{checkpoints.length}</span>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="checkpoints-body">
          <div className="checkpoints-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!activePath}
              onClick={capture}
            >
              Capture active file
            </button>
            <button type="button" className="btn btn-ghost" onClick={load}>
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="See the full checkpoint timeline and step back safely (Ctrl+Alt+T)"
              onClick={openTimeline}
            >
              Timeline
            </button>
            {checkpoints.length > 0 ? (
              <button type="button" className="btn btn-ghost" onClick={clearAll}>
                Clear
              </button>
            ) : null}
          </div>
          {status ? <div className="checkpoints-status">{status}</div> : null}
          {loading ? (
            <div className="outline-empty">{'Loading\u2026'}</div>
          ) : checkpoints.length === 0 ? (
            <div className="outline-empty">No checkpoints yet.</div>
          ) : (
            checkpoints.map((cp) => (
              <div key={cp.runId} className="checkpoint">
                <div className="checkpoint-head">
                  <span className="checkpoint-label">{cp.label ?? 'Checkpoint'}</span>
                  <span className="checkpoint-time">{fmtTime(cp.createdAt)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost checkpoint-restore"
                    onClick={() => restoreCheckpoint(cp.runId)}
                    title="Restore all files in this checkpoint"
                  >
                    Restore all
                  </button>
                </div>
                {cp.entries.map((e) => (
                  <div key={e.id} className="checkpoint-entry-wrap">
                    <div className="checkpoint-entry">
                      <span
                        className="checkpoint-file"
                        role="button"
                        tabIndex={0}
                        title={e.path}
                        onClick={() => openFileAt(e.path, baseName(e.path), 1, 1)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            openFileAt(e.path, baseName(e.path), 1, 1);
                          }
                        }}
                      >
                        {baseName(e.path)}
                        {e.existed ? '' : ' (new)'}
                      </span>
                      {e.existed ? (
                        <button
                          type="button"
                          className="btn btn-ghost checkpoint-restore-one"
                          onClick={() => setReviewId((id) => (id === e.id ? null : e.id))}
                        >
                          {reviewId === e.id ? 'Close' : 'Review'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost checkpoint-restore-one"
                        onClick={() => restoreEntry(e.id)}
                      >
                        Restore
                      </button>
                    </div>
                    {reviewId === e.id ? (
                      <CheckpointEntryReview
                        root={rootPath}
                        entry={e}
                        onApplied={(msg) => {
                          setStatus(msg);
                          setReviewId(null);
                        }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inline review of one snapshot entry: diffs the checkpoint content (old) against
 * the current file (new), listing each change since the checkpoint as a hunk. A
 * checked hunk keeps the current version; unchecking reverts it to the checkpoint.
 * Applying writes the reconstructed text through the Safe Edit Engine (which
 * snapshots first), tying Phases 171 + 172 + 173 together.
 */
function CheckpointEntryReview({
  root,
  entry,
  onApplied,
}: {
  root: string | null;
  entry: SnapshotEntry;
  onApplied: (msg: string) => void;
}) {
  const [data, setData] = useState<{ old: string; cur: string; hunks: ReviewHunk[] } | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      window.axiom.snapshots.readEntry(entry.id),
      window.axiom.fs
        .readFile(entry.path)
        .then((f) => f.content)
        .catch(() => null),
    ])
      .then(([snap, cur]) => {
        if (!alive) return;
        if (snap === null || cur === null) {
          setError('Snapshot or current file is unavailable.');
          return;
        }
        const session = buildReviewHunks(snap, cur);
        setData({ old: snap, cur, hunks: session.hunks });
        setAccepted(new Set(session.hunks.map((h) => h.id))); // default: keep all current changes
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [entry.id, entry.path]);

  const toggle = (id: string): void =>
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = (): void => {
    if (!data) return;
    if (!root) {
      setError('Open the checkpoint workspace before applying reviewed changes.');
      return;
    }
    setBusy(true);
    setError(null);
    const source = data.cur;
    const result = applySelectedHunks(data.old, source, [...accepted]);
    void (async () => {
      try {
        const baseHash = await sha256Hex(source);
        const response = await window.axiom.safeEdit.apply(root, [
          { path: entry.path, kind: 'modify', newText: result, baseHash },
        ]);
        onApplied(
          response.ok
            ? 'Applied reviewed changes (snapshot taken).'
            : `Apply failed: ${response.error ?? ''}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (error) return <div className="cp-review-error">{error}</div>;
  if (!data) return <div className="outline-empty">{'Loading review\u2026'}</div>;
  if (data.hunks.length === 0)
    return <div className="outline-empty">No changes since this checkpoint.</div>;

  return (
    <div className="cp-review">
      {data.hunks.map((h) => (
        <div key={h.id} className="cp-hunk">
          <label className="cp-hunk-head">
            <input type="checkbox" checked={accepted.has(h.id)} onChange={() => toggle(h.id)} />
            <span className="cp-hunk-title">
              {`@ line ${h.newStart} · +${h.added} -${h.removed}`}
            </span>
          </label>
          <pre className="cp-hunk-diff">
            {h.ops.map((op, i) => (
              <div
                key={i}
                className={op.op === 'add' ? 'cp-line-add' : op.op === 'del' ? 'cp-line-del' : ''}
              >
                {op.op === 'add' ? '+ ' : op.op === 'del' ? '- ' : '  '}
                {op.line}
              </div>
            ))}
          </pre>
        </div>
      ))}
      <div className="cp-review-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={apply}>
          {busy ? 'Applying\u2026' : 'Apply (keep checked, revert unchecked)'}
        </button>
      </div>
    </div>
  );
}
