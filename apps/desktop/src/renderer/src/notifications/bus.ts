/**
 * Notification bus (PRD Part VII §112 / Part IX §160). A tiny decoupled pub/sub
 * so any module — stores, editor, file ops — can surface user-facing messages
 * without depending on React context. The NotificationsProvider bridges this to
 * component state (Output log + toasts).
 */
export type NotificationLevel = 'info' | 'warn' | 'error';

export interface Notification {
  id: string;
  level: NotificationLevel;
  message: string;
  detail?: string;
  source?: string;
  time: number;
  /** Whether to surface as a transient toast (in addition to the Output log). */
  toast: boolean;
}

export interface NotifyOptions {
  detail?: string;
  source?: string;
  /** Set false to log to Output without a toast (e.g., routine saves). */
  toast?: boolean;
}

type Listener = (notification: Notification) => void;

const listeners = new Set<Listener>();
let counter = 0;

export function onNotification(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(level: NotificationLevel, message: string, opts?: NotifyOptions): void {
  const notification: Notification = {
    id: `n${Date.now().toString(36)}-${counter++}`,
    level,
    message,
    time: Date.now(),
    toast: opts?.toast !== false,
    ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
  };
  for (const listener of listeners) listener(notification);
}

export function notifyInfo(message: string, opts?: NotifyOptions): void {
  emit('info', message, opts);
}

export function notifyWarn(message: string, opts?: NotifyOptions): void {
  emit('warn', message, opts);
}

export function notifyError(message: string, opts?: NotifyOptions): void {
  emit('error', message, opts);
}
