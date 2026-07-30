import { useLayoutEffect, useRef, useState } from 'react';
import { usePalette } from '../commands/palette';
import { useWorkspace } from '../state/workspace';

/**
 * Go to Line/Column (PRD Part VII §106). A minimal prompt hosted in the palette
 * overlay. Accepts `line`, `line:col`, or `line,col`; navigation is delegated to
 * the workspace reveal mechanism, which clamps to the model's bounds.
 */
function parseTarget(input: string): { line: number; column: number } | null {
  const match = input.trim().match(/^(\d+)(?:[:,](\d+))?$/);
  if (!match) return null;
  const line = Number(match[1]);
  if (!Number.isFinite(line) || line < 1) return null;
  const column = match[2] ? Math.max(1, Number(match[2])) : 1;
  return { line, column };
}

export function GotoLineInput() {
  const { close, initialQuery } = usePalette();
  const { gotoLine } = useWorkspace();
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const target = parseTarget(value);
  const invalid = value.trim().length > 0 && target === null;

  const submit = (): void => {
    if (!target) return;
    gotoLine(target.line, target.column);
    close();
  };

  return (
    <div className="palette-overlay" onMouseDown={close}>
      <div
        className="palette goto-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Go to Line"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Go to line (e.g. 42 or 42:8)"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="goto-hint">
          {invalid ? 'Enter a line number, optionally line:column.' : 'Press Enter to jump.'}
        </div>
      </div>
    </div>
  );
}
