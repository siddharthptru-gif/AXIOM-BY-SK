import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createDialogId, isTopDialog, registerDialog } from './dialogStack';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

interface DialogFrameProps {
  children: ReactNode;
  onClose?: () => void;
  /** Override Escape behavior (for example, cancel keybinding capture first). */
  onEscape?: () => void;
  overlayClassName: string;
  cardClassName: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  closeOnBackdrop?: boolean;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Shared accessible dialog frame. It owns focus containment/restoration, Escape,
 * backdrop dismissal, and nested-dialog ordering while allowing each product
 * surface to retain its established visual classes.
 */
export function DialogFrame({
  children,
  onClose,
  onEscape,
  overlayClassName,
  cardClassName,
  ariaLabel,
  ariaLabelledBy,
  closeOnBackdrop = true,
}: DialogFrameProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Capture the opener during render, before React applies descendant autoFocus
  // in the commit phase. A passive effect is too late and would capture a field
  // inside the dialog instead of the control that opened it.
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const restoreFrameRef = useRef<number | null>(null);
  const dialogIdRef = useRef<number | null>(null);
  if (dialogIdRef.current === null) dialogIdRef.current = createDialogId();

  useEffect(() => {
    const dialogId = dialogIdRef.current;
    if (dialogId === null) return;
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    const unregister = registerDialog(dialogId);
    const frame = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card || card.contains(document.activeElement)) return;
      const first = card.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? card).focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      unregister();
      const restore = restoreFocusRef.current;
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        // StrictMode's simulated cleanup leaves the frame connected. Restore
        // focus only after an actual close/unmount.
        if (!cardRef.current?.isConnected && restore?.isConnected) {
          restore.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const dialogId = dialogIdRef.current;
      if (dialogId === null || !isTopDialog(dialogId)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        (onEscape ?? onClose)?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) =>
          !element.hidden &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.getClientRects().length > 0,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, onEscape]);

  return (
    <div
      className={overlayClassName}
      role="presentation"
      onMouseDown={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        ref={cardRef}
        className={cardClassName}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Accessible centered modal shell with focus containment and restoration. */
export function Modal({ title, onClose, children, footer }: ModalProps) {
  const titleId = useId();

  return (
    <DialogFrame
      onClose={onClose}
      overlayClassName="modal-overlay"
      cardClassName="modal-card"
      ariaLabelledBy={titleId}
    >
      <div id={titleId} className="modal-title">
        {title}
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-footer">{footer}</div> : null}
    </DialogFrame>
  );
}

interface PromptModalProps {
  title: string;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** Placeholder shown when the field is empty. */
  placeholder?: string;
  /** Render a masked (password) input for secrets like API keys. */
  password?: boolean;
  /** Optional synchronous validator; return an error string to block submit. */
  validate?: (value: string) => string | null;
  /** May be async; if it throws, the message is shown inline and the modal stays open. */
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}

/** Single-line text prompt (New File / New Folder / Rename / API key). */
export function PromptModal({
  title,
  label,
  initialValue = '',
  confirmLabel = 'OK',
  placeholder,
  password,
  validate,
  onSubmit,
  onClose,
}: PromptModalProps) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initialValue.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialValue]);

  const submit = (): void => {
    if (submitting) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError('Name cannot be empty.');
      return;
    }
    const validationError = validate?.(trimmed) ?? null;
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    void Promise.resolve(onSubmit(trimmed))
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e);
        const marker = raw.lastIndexOf('Error: ');
        setError(marker >= 0 ? raw.slice(marker + 7) : raw);
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {label ? (
        <label className="modal-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        ref={inputRef}
        className="modal-input"
        type={password ? 'password' : 'text'}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error ? (
        <div id={errorId} className="modal-error" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

interface ConfirmModalProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Yes/No confirmation. */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="modal-message">{message}</div>
    </Modal>
  );
}
