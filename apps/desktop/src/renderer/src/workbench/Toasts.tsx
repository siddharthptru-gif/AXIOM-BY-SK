import { useEffect } from 'react';
import type { Notification } from '../notifications/bus';
import { useNotifications } from '../notifications/store';

const AUTO_DISMISS_MS = 4500;

function ToastCard({
  toast,
  dismiss,
  onOpen,
}: {
  toast: Notification;
  dismiss: (id: string) => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    if (toast.level === 'error') return; // errors persist until dismissed
    const timer = setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, toast.level, dismiss]);

  return (
    <div
      className={`toast toast-${toast.level}`}
      role={toast.level === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-dot" aria-hidden="true" />
      <button
        type="button"
        className="toast-body"
        aria-label={`Open Output: ${toast.message}`}
        onClick={onOpen}
      >
        <span className="toast-message">{toast.message}</span>
        {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
      </button>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/** Transient notification stack, bottom-right (PRD Part IX §160). */
export function Toasts() {
  const { toasts, dismissToast, setPanelOpen, setPanelTab } = useNotifications();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          dismiss={dismissToast}
          onOpen={() => {
            dismissToast(toast.id);
            setPanelTab('output');
            setPanelOpen(true);
          }}
        />
      ))}
    </div>
  );
}
