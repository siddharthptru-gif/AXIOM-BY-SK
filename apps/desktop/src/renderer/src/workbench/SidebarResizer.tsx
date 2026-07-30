import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

interface SidebarResizerProps {
  width: number;
  min: number;
  max: number;
  onResize: (next: number) => void;
  /** Which side the panel sits on. 'right' inverts the drag direction. */
  side?: 'left' | 'right';
  label?: string;
}

/** Pointer- and keyboard-operable workbench column divider. */
export function SidebarResizer({
  width,
  min,
  max,
  onResize,
  side = 'left',
  label,
}: SidebarResizerProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.focus();
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const onMove = (ev: PointerEvent): void => {
        const delta = ev.clientX - startXRef.current;
        const signed = side === 'right' ? -delta : delta;
        onResize(Math.min(max, Math.max(min, startWidthRef.current + signed)));
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing-col');
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.body.classList.add('resizing-col');
    },
    [width, min, max, onResize, side],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    if (e.key === 'Home') onResize(min);
    else if (e.key === 'End') onResize(max);
    else {
      const visualDirection = e.key === 'ArrowRight' ? 1 : -1;
      const direction = side === 'right' ? -visualDirection : visualDirection;
      onResize(Math.min(max, Math.max(min, width + direction * (e.shiftKey ? 32 : 8))));
    }
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label ?? 'Resize primary sidebar'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
