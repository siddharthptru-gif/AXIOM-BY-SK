import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onNotification, type Notification } from './bus';

/**
 * Notifications + panel store. Subscribes to the notification bus, keeps a capped
 * Output log and the live toast list, and owns bottom-panel visibility/tab state
 * (PRD Part VII §102/§112).
 */
export type PanelTab = 'output' | 'problems' | 'terminal' | 'debug';
export type PanelPosition = 'bottom' | 'right';

const PANEL_STORAGE_KEY = 'axiom.workbench.panel.v1';
const DEFAULT_PANEL_HEIGHT = 280;
const DEFAULT_PANEL_WIDTH = 420;
const MAX_OUTPUT_ENTRIES = 5000;

export const PANEL_SIZE_BOUNDS = {
  bottom: { min: 160, max: 640 },
  right: { min: 240, max: 760 },
} as const;

interface PanelPreferences {
  open: boolean;
  tab: PanelTab;
  maximized: boolean;
  position: PanelPosition;
  height: number;
  width: number;
}

function clampPanelSize(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function readPanelPreferences(): PanelPreferences {
  const fallback: PanelPreferences = {
    open: false,
    tab: 'output',
    maximized: false,
    position: 'bottom',
    height: DEFAULT_PANEL_HEIGHT,
    width: DEFAULT_PANEL_WIDTH,
  };
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PANEL_STORAGE_KEY) ?? '',
    ) as Partial<PanelPreferences>;
    const tab: PanelTab = ['output', 'problems', 'terminal'].includes(parsed.tab ?? '')
      ? (parsed.tab as PanelTab)
      : fallback.tab;
    return {
      open: parsed.open === true,
      tab,
      maximized: parsed.maximized === true,
      position: parsed.position === 'right' ? 'right' : 'bottom',
      height: clampPanelSize(
        parsed.height,
        fallback.height,
        PANEL_SIZE_BOUNDS.bottom.min,
        PANEL_SIZE_BOUNDS.bottom.max,
      ),
      width: clampPanelSize(
        parsed.width,
        fallback.width,
        PANEL_SIZE_BOUNDS.right.min,
        PANEL_SIZE_BOUNDS.right.max,
      ),
    };
  } catch {
    return fallback;
  }
}

const MAX_TOASTS = 4;

interface NotificationsValue {
  entries: Notification[];
  toasts: Notification[];
  dismissToast: (id: string) => void;
  clear: () => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  /** Panel fills the editor column (hiding the editor) when true. */
  panelMaximized: boolean;
  toggleMaximizePanel: () => void;
  /** Where the panel docks: below the editor or to its right. */
  panelPosition: PanelPosition;
  togglePanelPosition: () => void;
  panelHeight: number;
  panelWidth: number;
  setPanelSize: (position: PanelPosition, pixels: number) => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Notification[]>([]);
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [preferences] = useState(readPanelPreferences);
  const [panelOpen, setPanelOpenState] = useState(preferences.open);
  const [panelTab, setPanelTab] = useState<PanelTab>(preferences.tab);
  const [panelMaximized, setPanelMaximized] = useState(preferences.maximized);
  const [panelPosition, setPanelPosition] = useState<PanelPosition>(preferences.position);
  const [panelHeight, setPanelHeight] = useState(preferences.height);
  const [panelWidth, setPanelWidth] = useState(preferences.width);

  useEffect(() => {
    return onNotification((notification) => {
      setEntries((previous) => {
        const next = [...previous, notification];
        return next.length > MAX_OUTPUT_ENTRIES
          ? next.slice(next.length - MAX_OUTPUT_ENTRIES)
          : next;
      });
      if (notification.toast) {
        setToasts((previous) => {
          const next = [...previous, notification];
          return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
        });
      }
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        PANEL_STORAGE_KEY,
        JSON.stringify({
          open: panelOpen,
          tab: panelTab,
          maximized: panelMaximized,
          position: panelPosition,
          height: panelHeight,
          width: panelWidth,
        } satisfies PanelPreferences),
      );
    } catch {
      // Persistence is best-effort; panel behavior remains fully functional.
    }
  }, [panelHeight, panelMaximized, panelOpen, panelPosition, panelTab, panelWidth]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clear = useCallback(() => setEntries([]), []);
  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    if (!open) setPanelMaximized(false);
  }, []);
  const togglePanel = useCallback(() => {
    setPanelOpenState((v) => !v);
    setPanelMaximized(false); // a fresh open/close is never maximized
  }, []);

  const toggleMaximizePanel = useCallback(() => {
    setPanelMaximized((m) => !m);
    setPanelOpenState(true); // maximizing (or restoring) always leaves the panel open
  }, []);

  const setPanelSize = useCallback((position: PanelPosition, pixels: number) => {
    const bounds = PANEL_SIZE_BOUNDS[position];
    if (position === 'bottom') {
      setPanelHeight(clampPanelSize(pixels, DEFAULT_PANEL_HEIGHT, bounds.min, bounds.max));
    } else {
      setPanelWidth(clampPanelSize(pixels, DEFAULT_PANEL_WIDTH, bounds.min, bounds.max));
    }
  }, []);

  const togglePanelPosition = useCallback(() => {
    setPanelPosition((p) => (p === 'bottom' ? 'right' : 'bottom'));
  }, []);

  const value = useMemo<NotificationsValue>(
    () => ({
      entries,
      toasts,
      dismissToast,
      clear,
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelTab,
      setPanelTab,
      panelMaximized,
      toggleMaximizePanel,
      panelPosition,
      togglePanelPosition,
      panelHeight,
      panelWidth,
      setPanelSize,
    }),
    [
      entries,
      toasts,
      dismissToast,
      clear,
      panelOpen,
      setPanelOpen,
      togglePanel,
      panelTab,
      panelMaximized,
      toggleMaximizePanel,
      panelPosition,
      togglePanelPosition,
      panelHeight,
      panelWidth,
      setPanelSize,
    ],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationsProvider');
  return ctx;
}
