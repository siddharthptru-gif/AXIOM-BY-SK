import { useCallback, useEffect, useRef, useState } from 'react';
import { monaco, ensureAxiomTheme, currentMonacoTheme } from '../editor/monacoEnv';
import { languageForPath } from '../editor/language';
import { setDiffOpener, type DiffTarget } from '../editor/diffBus';
import { CloseIcon } from './icons';
import { DialogFrame } from './Modal';

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Diff overlay (PRD Epoch D). A full-window, read-only Monaco diff editor for
 * either HEAD ↔ index or index ↔ working tree. Opened from Source Control via
 * the diff bus; dismissed with the header close button or Escape.
 */
export function DiffHost() {
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const closeDiff = useCallback((): void => {
    setTarget(null);
    setError(null);
  }, []);

  // Register as the diff opener for the lifetime of the host.
  useEffect(
    () =>
      setDiffOpener((nextTarget) => {
        setError(null);
        setTarget(nextTarget);
      }),
    [],
  );

  // Build the diff editor whenever a target is set; tear it down on close.
  useEffect(() => {
    const host = hostRef.current;
    if (!target || !host) return;
    ensureAxiomTheme();
    let cancelled = false;
    const diffEditor = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      theme: currentMonacoTheme(),
      scrollBeyondLastLine: false,
      renderSideBySide: true,
    });
    let originalModel: monaco.editor.ITextModel | null = null;
    let modifiedModel: monaco.editor.ITextModel | null = null;

    void window.axiom.git
      .diff(target.root, target.rel, target.mode)
      .then((res) => {
        if (cancelled) return;
        const lang = languageForPath(target.rel);
        originalModel = monaco.editor.createModel(res.original, lang);
        modifiedModel = monaco.editor.createModel(res.modified, lang);
        diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        diffEditor.dispose();
        originalModel?.dispose();
        modifiedModel?.dispose();
        originalModel = null;
        modifiedModel = null;
        setError(detailOf(loadError));
      });

    return () => {
      cancelled = true;
      diffEditor.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [target]);

  if (!target) return null;

  const comparison = target.mode === 'staged' ? 'HEAD ↔ Index' : 'Index ↔ Working Tree';

  return (
    <DialogFrame
      onClose={closeDiff}
      overlayClassName="diff-overlay"
      cardClassName="diff-dialog"
      ariaLabel={`Diff of ${target.name}, ${comparison}`}
      closeOnBackdrop={false}
    >
      <div className="diff-header">
        <span className="diff-title">
          {target.name}
          <span className="diff-sub"> {comparison}</span>
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Close Diff (Esc)"
          aria-label="Close Diff"
          onClick={closeDiff}
        >
          <CloseIcon />
        </button>
      </div>
      {error ? (
        <div className="diff-host diff-error" role="alert" aria-live="assertive">
          <div>
            <strong>Could not load diff.</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : (
        <div className="diff-host" ref={hostRef} />
      )}
    </DialogFrame>
  );
}
