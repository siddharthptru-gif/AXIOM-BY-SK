import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

interface ContextMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

/** Viewport-clamped context menu with arrow navigation and focus restoration. */
export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  const enabledIndices = entries.flatMap((entry, index) =>
    isSeparator(entry) || entry.disabled ? [] : [index],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - rect.width - 6);
    const ny = Math.min(y, window.innerHeight - rect.height - 6);
    setPos({ x: Math.max(6, nx), y: Math.max(6, ny) });
  }, [x, y]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => {
      const first = enabledIndices[0];
      if (first !== undefined) itemRefs.current[first]?.focus();
      else ref.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
    // Entries are immutable for the lifetime of an open menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const moveFocus = (direction: 1 | -1): void => {
    if (enabledIndices.length === 0) return;
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    const position = Math.max(0, enabledIndices.indexOf(current));
    const next =
      enabledIndices[(position + direction + enabledIndices.length) % enabledIndices.length];
    if (next !== undefined) itemRefs.current[next]?.focus();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-orientation="vertical"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          const first = enabledIndices[0];
          if (first !== undefined) itemRefs.current[first]?.focus();
        } else if (e.key === 'End') {
          e.preventDefault();
          const last = enabledIndices[enabledIndices.length - 1];
          if (last !== undefined) itemRefs.current[last]?.focus();
        }
      }}
    >
      {entries.map((entry, i) =>
        isSeparator(entry) ? (
          <div key={`sep-${i}`} className="context-menu-sep" role="separator" />
        ) : (
          <button
            key={`item-${i}`}
            ref={(element) => {
              itemRefs.current[i] = element;
            }}
            type="button"
            role="menuitem"
            className={`context-menu-item ${entry.danger ? 'danger' : ''}`}
            disabled={entry.disabled}
            tabIndex={-1}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}
