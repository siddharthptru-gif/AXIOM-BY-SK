import { useEffect, useState } from 'react';
import { summarizeEditPlan, type PlannedEdit } from '../../../common/editPlan';
import { buildRefinementPrompt } from '../../../common/refine';
import { selectImpactContext } from '../../../common/impactContext';
import { buildAiReviewFromTexts } from '../../../common/aiEditReview';
import type { StagedEdit } from '../../../common/safeEdit';
import { publishAiReview } from '../editor/aiEditReviewBus';
import {
  buildMultiReview,
  defaultAccepted,
  applyMultiReview,
  countAcceptedFiles,
  DELETE_HUNK_ID,
  type MultiReviewFile,
} from '../../../common/multiReview';
import { useWorkspace } from '../state/workspace';
import { CheckIcon, ShieldIcon, SparkIcon, StopIcon, TrashIcon, WarningIcon } from './icons';

/**
 * Multi-file Composer (PRD Epoch G §130/§142.1 / Phases 193 + 195). Describe a
 * change; the model returns a coordinated multi-file edit plan, which is shown as a
 * per-file, per-hunk review. Accept/reject hunks, then apply the selection as ONE
 * all-or-nothing Safe-Edit batch (a single snapshot). Best-effort workspace context
 * is attached to the prompt.
 */
function actionClass(a: MultiReviewFile['action']): string {
  return a === 'create' ? 'is-create' : a === 'delete' ? 'is-delete' : 'is-modify';
}

function relTo(root: string, p: string): string {
  return p.startsWith(root)
    ? p
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/')
    : p;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Dependency-aware context (PRD Phase 194): pull the active file's importers +
 * transitive impact from the knowledge graph and include their content so the
 * Composer updates call sites / imports consistently. Best-effort, budgeted.
 */
async function gatherImpactContext(root: string, activePath: string): Promise<string> {
  try {
    const [dep, imp] = await Promise.all([
      window.axiom.core.graph.dependents(root, activePath),
      window.axiom.core.graph.impact(root, activePath),
    ]);
    const paths = selectImpactContext(relTo(root, activePath), dep.dependents, imp.impacted, 4);
    if (paths.length === 0) return '';
    const blocks = await Promise.all(
      paths.map(async (rel) => {
        try {
          const f = await window.axiom.fs.readFile(`${root}/${rel}`);
          return `File: ${rel}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``;
        } catch {
          return '';
        }
      }),
    );
    const nonEmpty = blocks.filter((b) => b.length > 0);
    return nonEmpty.length > 0
      ? `Dependency-impacted files (keep call sites / imports consistent):\n\n${nonEmpty.join('\n\n')}`
      : '';
  } catch {
    return '';
  }
}

type ComposerOperation = 'compose' | 'refine' | 'apply' | null;

type ReviewMetadata = {
  existed: boolean;
  baseHash: string;
};

export function ComposerPanel({
  provider,
  model,
  baseUrl,
  headers,
  onActivityChange,
}: {
  provider: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  onActivityChange: (active: boolean) => void;
}) {
  const ws = useWorkspace();
  const [instruction, setInstruction] = useState('');
  const [lastInstruction, setLastInstruction] = useState('');
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<MultiReviewFile[] | null>(null);
  const [accepted, setAccepted] = useState<Record<string, Set<string>>>({});
  const [reviewMetadata, setReviewMetadata] = useState<ReadonlyMap<string, ReviewMetadata> | null>(
    null,
  );
  const [reviewRoot, setReviewRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<ComposerOperation>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onActivityChange(busy);
    return () => onActivityChange(false);
  }, [busy, onActivityChange]);

  const doCompose = (promptText: string, nextOperation: 'compose' | 'refine'): void => {
    if (!promptText.trim() || busy) return;
    setBusy(true);
    setOperation(nextOperation);
    setError(null);
    setStatus(null);
    void (async () => {
      try {
        const root = ws.rootPath;
        let context = '';
        if (root) {
          try {
            const ctx = await window.axiom.ai.buildContext({ root, query: promptText });
            if (ctx.text) context = ctx.text;
          } catch {
            /* best-effort */
          }
          if (ws.activePath) {
            const impactBlock = await gatherImpactContext(root, ws.activePath);
            if (impactBlock) context = context ? `${context}\n\n${impactBlock}` : impactBlock;
          }
        }
        const res = await window.axiom.ai.compose({
          provider,
          model,
          baseUrl,
          headers,
          instruction: promptText,
          ...(context.length > 0 ? { context } : {}),
        });
        if (res.edits.length === 0) {
          setStatus('The model proposed no changes.');
          setFiles([]);
          setAccepted({});
          setReviewMetadata(new Map());
          setReviewRoot(root);
          return;
        }
        const reviewed = await Promise.all(
          res.edits.map(async (e) => {
            let oldText = '';
            let existed = false;
            if (root) {
              try {
                oldText = (await window.axiom.fs.readFile(`${root}/${e.path}`)).content;
                existed = true;
              } catch {
                oldText = '';
              }
            }
            return {
              item: { path: e.path, action: e.action, oldText, newText: e.content ?? '' },
              metadata: { existed, baseHash: await sha256Hex(oldText) },
            };
          }),
        );
        const review = buildMultiReview(reviewed.map(({ item }) => item));
        const metadata = new Map<string, ReviewMetadata>();
        for (const entry of reviewed) metadata.set(entry.item.path, entry.metadata);
        setFiles(review);
        setAccepted(defaultAccepted(review));
        setReviewMetadata(metadata);
        setReviewRoot(root);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setOperation(null);
      }
    })();
  };

  const compose = (): void => {
    const text = instruction.trim();
    if (!text) return;
    setLastInstruction(text);
    setFiles(null);
    setReviewMetadata(null);
    setReviewRoot(null);
    doCompose(text, 'compose');
  };

  const refine = (): void => {
    const fb = feedback.trim();
    if (!fb || !files) return;
    if (!reviewRoot || ws.rootPath !== reviewRoot) {
      setStatus(
        'Refine refused: this review belongs to a different workspace. Return to the original workspace or compose a new plan.',
      );
      return;
    }
    const prior = files as PlannedEdit[];
    setFeedback('');
    doCompose(buildRefinementPrompt(lastInstruction, prior, fb), 'refine');
  };

  const toggleHunk = (path: string, id: string): void => {
    setAccepted((prev) => {
      const next = { ...prev };
      const set = new Set(next[path] ?? []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      next[path] = set;
      return next;
    });
  };

  const selectAll = (): void => {
    if (!files || busy) return;
    setAccepted(defaultAccepted(files));
  };

  /**
   * Discard the whole staged changeset. Nothing was written during review, so this
   * only drops renderer state — there is no disk change to undo.
   */
  const discardPlan = (): void => {
    if (busy) return;
    setFiles(null);
    setReviewMetadata(null);
    setReviewRoot(null);
    setAccepted({});
    setFeedback('');
    setError(null);
    setStatus('Plan discarded. Nothing was written — review never touches your files.');
  };

  /** Open a planned file at its first change so the user can read it in context. */
  const openPlannedFile = (file: MultiReviewFile): void => {
    const root = reviewRoot ?? ws.rootPath;
    if (!root) return;
    const absolute = `${root}/${file.path}`.replace(/\/{2,}/g, '/');
    const name = file.path.split('/').pop() ?? file.path;
    const line = file.hunks[0]?.newStart ?? 1;
    ws.openFileAt(absolute, name, line, 1);
  };

  const clearSelection = (): void => {
    if (!files || busy) return;
    setAccepted((prev) => {
      const next = { ...prev };
      for (const file of files) next[file.path] = new Set();
      return next;
    });
  };

  const applyPlan = (): void => {
    if (!files || busy) return;
    const root = ws.rootPath;
    if (!root) {
      setStatus('Open a folder to apply changes.');
      return;
    }
    if (!reviewRoot) {
      setStatus(
        'Apply refused: this plan was created without an open workspace. Compose it again.',
      );
      return;
    }
    if (root !== reviewRoot) {
      setStatus(
        'Apply refused: the workspace changed after this plan was generated. Return to the original workspace or compose a new plan.',
      );
      return;
    }
    setBusy(true);
    setOperation('apply');
    setError(null);
    setStatus(null);
    void (async () => {
      try {
        const resolvedEdits = applyMultiReview(files, accepted);
        if (resolvedEdits.length === 0) {
          setStatus('Nothing selected to apply.');
          return;
        }
        const edits: StagedEdit[] = [];
        for (const r of resolvedEdits) {
          const metadata = reviewMetadata?.get(r.path);
          if (!metadata) {
            setStatus(
              `Apply refused: review metadata is missing for ${r.path}. Compose or refine the plan again.`,
            );
            return;
          }
          const path = `${root}/${r.path}`;
          if (r.kind === 'delete') {
            edits.push({ path, kind: 'delete', baseHash: metadata.baseHash });
          } else if (metadata.existed) {
            edits.push({
              path,
              kind: 'modify',
              newText: r.newText ?? '',
              baseHash: metadata.baseHash,
            });
          } else {
            edits.push({ path, kind: 'create', newText: r.newText ?? '' });
          }
        }
        const res = await window.axiom.safeEdit.apply(root, edits);
        setStatus(
          res.ok
            ? `Applied ${edits.length} file(s) as one atomic batch. Snapshot taken — every change is now reviewable inline in the editor and revertible per hunk.`
            : `Apply failed: ${res.error ?? 'batch rejected'}`,
        );
        if (res.ok) {
          // Hand the applied changeset to the inline editor review so the user can
          // walk it file by file and revert individual hunks in place.
          const appliedAt = Date.now();
          for (const applied of resolvedEdits) {
            const file = files.find((candidate) => candidate.path === applied.path);
            if (!file || applied.kind === 'delete') continue;
            publishAiReview(
              buildAiReviewFromTexts(
                file.oldText,
                applied.newText ?? '',
                `${root}/${applied.path}`.replace(/\/{2,}/g, '/'),
                applied.path,
                applied.kind === 'create' ? 'create' : 'modify',
                appliedAt,
              ),
            );
          }
          setFiles(null);
          setReviewMetadata(null);
          setReviewRoot(null);
          setAccepted({});
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setOperation(null);
      }
    })();
  };

  const selectedCount = files ? countAcceptedFiles(files, accepted) : 0;
  const workspaceChanged = files !== null && reviewRoot !== null && ws.rootPath !== reviewRoot;
  const busyMessage =
    operation === 'compose'
      ? 'Composing a review plan.'
      : operation === 'refine'
        ? 'Refining the review plan.'
        : operation === 'apply'
          ? 'Applying the reviewed selection as one atomic batch.'
          : null;

  return (
    <div className="composer-panel" aria-labelledby="composer-panel-title">
      <header className="composer-trust-header">
        <span className="composer-trust-icon" aria-hidden="true">
          <ShieldIcon size={16} />
        </span>
        <div>
          <h2 id="composer-panel-title" className="composer-title">
            Review first, snapshot on apply
          </h2>
          <p className="composer-trust-copy">
            Compose and refine are review-only. Apply sends only your selection in one atomic,
            snapshotted batch.
          </p>
        </div>
      </header>

      <section
        className="composer-request"
        aria-labelledby="composer-request-heading"
        aria-busy={operation === 'compose'}
      >
        <h3 id="composer-request-heading" className="composer-section-title">
          1. Describe the coordinated change
        </h3>
        <div className="composer-input">
          <label className="composer-input-label" htmlFor="composer-instruction">
            Change request
          </label>
          <textarea
            id="composer-instruction"
            className="composer-textarea"
            placeholder={
              'Describe a multi-file change... (e.g. "add a Logger class and use it in main")'
            }
            value={instruction}
            rows={3}
            spellCheck={false}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                compose();
              }
            }}
          />
          <div className="composer-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!instruction.trim() || busy}
              onClick={compose}
            >
              <SparkIcon size={14} />
              {operation === 'compose' ? 'Composing...' : 'Compose review plan'}
            </button>
          </div>
        </div>
      </section>

      <div className="composer-live" aria-live="polite" aria-atomic="true">
        {error ? (
          <div className="composer-error" role="alert">
            <WarningIcon size={14} />
            {error}
          </div>
        ) : null}
        {busyMessage ? (
          <div className="composer-status" role="status">
            <SparkIcon size={14} />
            {busyMessage}
          </div>
        ) : status ? (
          <div className="composer-status" role="status">
            {status}
          </div>
        ) : null}
      </div>

      {files && files.length > 0 ? (
        <section
          className="composer-plan"
          aria-labelledby="composer-plan-title"
          aria-describedby="composer-atomic-checkpoint"
          aria-busy={operation === 'refine' || operation === 'apply'}
        >
          <div className="composer-plan-head">
            <div className="composer-plan-overview">
              <h3 id="composer-plan-title" className="composer-section-title">
                2. Review the proposed plan
              </h3>
              <span
                className="composer-plan-summary"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {summarizeEditPlan(files)}; {selectedCount} file(s) selected
              </span>
            </div>
            <div
              className="composer-selection-actions"
              role="group"
              aria-label="Plan selection controls"
            >
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                aria-controls="composer-file-review-list"
                onClick={selectAll}
              >
                <CheckIcon size={14} />
                Select all
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || selectedCount === 0}
                aria-controls="composer-file-review-list"
                onClick={clearSelection}
              >
                <StopIcon size={14} />
                Clear selection
              </button>
              <button
                type="button"
                className="btn btn-ghost composer-discard-btn"
                disabled={busy}
                aria-controls="composer-file-review-list"
                title="Drop this staged changeset. Nothing was written, so there is nothing to undo."
                onClick={discardPlan}
              >
                <TrashIcon size={14} />
                Discard plan
              </button>
            </div>
          </div>

          <div id="composer-atomic-checkpoint" className="composer-atomic-checkpoint" role="note">
            <ShieldIcon size={16} />
            <div>
              <strong>Atomic apply checkpoint</strong>
              <div>
                Nothing changes during review. Apply selected creates one snapshot and submits only
                the selected hunks as one all-or-nothing batch.
              </div>
            </div>
          </div>

          {workspaceChanged ? (
            <div className="composer-error" role="alert">
              <WarningIcon size={14} />
              Workspace changed after this review was generated. Apply is disabled; compose a new
              plan for the current workspace.
            </div>
          ) : null}

          <div className="composer-apply-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || selectedCount === 0 || workspaceChanged}
              aria-describedby="composer-atomic-checkpoint"
              onClick={applyPlan}
            >
              <ShieldIcon size={14} />
              {operation === 'apply' ? 'Applying...' : 'Apply selected (snapshotted)'}
            </button>
          </div>

          <section className="composer-refine" aria-labelledby="composer-refine-heading">
            <label
              id="composer-refine-heading"
              className="composer-refine-label"
              htmlFor="composer-refine-input"
            >
              Refine this plan
            </label>
            <input
              id="composer-refine-input"
              className="composer-refine-input"
              type="text"
              placeholder="Describe what to change about this plan..."
              value={feedback}
              disabled={busy || workspaceChanged}
              spellCheck={false}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  refine();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !feedback.trim() || workspaceChanged}
              onClick={refine}
            >
              <SparkIcon size={14} />
              {operation === 'refine' ? 'Refining...' : 'Refine'}
            </button>
          </section>

          <div id="composer-file-review-list" className="composer-file-list" role="list">
            {files.map((f, fileIndex) => {
              const fileTitleId = `composer-file-${fileIndex}-title`;
              return (
                <article
                  key={f.path}
                  className="composer-file-open"
                  role="listitem"
                  aria-labelledby={fileTitleId}
                >
                  <header className="composer-file-head">
                    <span className={`composer-badge ${actionClass(f.action)}`}>{f.action}</span>
                    <span id={fileTitleId} className="composer-path" role="heading" aria-level={4}>
                      {f.path}
                    </span>
                    {f.action === 'create' ? null : (
                      <button
                        type="button"
                        className="composer-open-file"
                        title={`Open ${f.path} at the first change`}
                        onClick={() => openPlannedFile(f)}
                      >
                        Open file
                      </button>
                    )}
                  </header>
                  {f.action === 'delete' ? (
                    <section
                      className="composer-hunk composer-delete-review"
                      aria-labelledby={`composer-file-${fileIndex}-delete`}
                    >
                      <label className="composer-hunk-head">
                        <input
                          type="checkbox"
                          checked={(accepted[f.path] ?? new Set()).has(DELETE_HUNK_ID)}
                          disabled={busy}
                          onChange={() => toggleHunk(f.path, DELETE_HUNK_ID)}
                        />
                        <span
                          id={`composer-file-${fileIndex}-delete`}
                          className="composer-hunk-title"
                        >
                          Include deletion of this file
                        </span>
                      </label>
                      <div className="composer-review-note">
                        File deletion is excluded unless this checkpoint remains selected.
                      </div>
                    </section>
                  ) : f.hunks.length === 0 ? (
                    <div className="composer-status" role="status">
                      No textual change to review.
                    </div>
                  ) : (
                    f.hunks.map((h, hunkIndex) => {
                      const hunkTitleId = `composer-file-${fileIndex}-hunk-${hunkIndex}`;
                      return (
                        <section key={h.id} className="composer-hunk" aria-labelledby={hunkTitleId}>
                          <label className="composer-hunk-head">
                            <input
                              type="checkbox"
                              checked={(accepted[f.path] ?? new Set()).has(h.id)}
                              disabled={busy}
                              onChange={() => toggleHunk(f.path, h.id)}
                            />
                            <span id={hunkTitleId} className="composer-hunk-title">
                              Hunk {hunkIndex + 1}: line {h.newStart}, +{h.added} / -{h.removed}
                            </span>
                          </label>
                          <pre
                            className="composer-hunk-diff"
                            aria-label={`Diff for ${f.path}, hunk ${hunkIndex + 1}`}
                          >
                            {h.ops.map((op, i) => (
                              <span
                                key={i}
                                className={
                                  op.op === 'add'
                                    ? 'cp-line-add'
                                    : op.op === 'del'
                                      ? 'cp-line-del'
                                      : ''
                                }
                              >
                                {op.op === 'add' ? '+ ' : op.op === 'del' ? '- ' : '  '}
                                {op.line}
                                {i < h.ops.length - 1 ? '\n' : ''}
                              </span>
                            ))}
                          </pre>
                        </section>
                      );
                    })
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
