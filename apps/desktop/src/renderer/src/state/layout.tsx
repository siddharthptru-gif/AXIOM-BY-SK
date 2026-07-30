import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LayoutState } from '../../../common/ipc';
import { parseZoom, UI_ZOOM_CHANGED_EVENT } from '../../../common/uiPrefs';

export const PRIMARY_VIEW_IDS = [
  'explorer',
  'search',
  'semantic',
  'scm',
  'run',
  'languages',
  'extensions',
  'intelligence',
  'godmode',
] as const;
export type PrimaryViewId = (typeof PRIMARY_VIEW_IDS)[number];

const DEFAULT_VIEW: PrimaryViewId = 'explorer';
const DEFAULT_WIDTH = 280;
const DEFAULT_AI_WIDTH = 420;
const EDITOR_FLOOR = 520;
const ACTIVITY_WIDTH = 48;
const COMPACT_BREAKPOINT = 1024;
const CONSTRAINED_BREAKPOINT = 1280;

export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 560;
export const MIN_AI_WIDTH = 320;
export const MAX_AI_WIDTH = 760;

function isPrimaryView(value: unknown): value is PrimaryViewId {
  return PRIMARY_VIEW_IDS.some((id) => id === value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function effectiveViewportWidth(): number {
  const rawZoom = document.documentElement.style.getPropertyValue('--ui-zoom').trim();
  const zoom = rawZoom.length > 0 ? parseZoom(rawZoom) : 1;
  return window.innerWidth / zoom;
}

interface LayoutValue {
  activeView: PrimaryViewId;
  sidebarVisible: boolean;
  sidebarWidth: number;
  zenMode: boolean;
  centeredLayout: boolean;
  activityBarVisible: boolean;
  statusBarVisible: boolean;
  aiPanelVisible: boolean;
  aiPanelWidth: number;
  viewportWidth: number;
  isCompact: boolean;
  isConstrained: boolean;
  toggleAiPanel: () => void;
  showAiPanel: () => void;
  setAiPanelWidth: (px: number) => void;
  showView: (id: PrimaryViewId) => void;
  toggleView: (id: PrimaryViewId) => void;
  toggleSidebar: () => void;
  dismissAuxiliary: () => void;
  toggleZenMode: () => void;
  toggleCenteredLayout: () => void;
  toggleActivityBar: () => void;
  toggleStatusBar: () => void;
  setSidebarWidth: (px: number) => void;
}

const LayoutContext = createContext<LayoutValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [activeView, setActiveView] = useState<PrimaryViewId>(DEFAULT_VIEW);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidthState] = useState(DEFAULT_WIDTH);
  const [zenMode, setZenMode] = useState(false);
  const [centeredLayout, setCenteredLayout] = useState(false);
  const [activityBarVisible, setActivityBarVisible] = useState(true);
  const [statusBarVisible, setStatusBarVisible] = useState(true);
  const [aiPanelVisible, setAiPanelVisible] = useState(true);
  const [aiPanelWidth, setAiPanelWidthState] = useState(DEFAULT_AI_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(effectiveViewportWidth);
  const [loaded, setLoaded] = useState(false);
  const layoutHydratedRef = useRef(false);
  const pendingLayoutTransformsRef = useRef<Array<(current: LayoutState) => LayoutState>>([]);
  const rememberPreHydrationTransform = useCallback(
    (transform: (current: LayoutState) => LayoutState): void => {
      if (!layoutHydratedRef.current) pendingLayoutTransformsRef.current.push(transform);
    },
    [],
  );

  const isCompact = viewportWidth < COMPACT_BREAKPOINT;
  const isConstrained = viewportWidth < CONSTRAINED_BREAKPOINT;
  const activeViewRef = useRef(activeView);
  const sidebarVisibleRef = useRef(sidebarVisible);
  const sidebarWidthRef = useRef(sidebarWidth);
  const aiPanelVisibleRef = useRef(aiPanelVisible);
  const aiPanelWidthRef = useRef(aiPanelWidth);
  const viewportWidthRef = useRef(viewportWidth);
  const lastAuxiliaryRef = useRef<'sidebar' | 'ai'>('sidebar');

  activeViewRef.current = activeView;
  sidebarVisibleRef.current = sidebarVisible;
  sidebarWidthRef.current = sidebarWidth;
  aiPanelVisibleRef.current = aiPanelVisible;
  aiPanelWidthRef.current = aiPanelWidth;
  viewportWidthRef.current = viewportWidth;

  const maxSidebarForViewport = useCallback((): number => {
    const width = viewportWidthRef.current;
    if (width < COMPACT_BREAKPOINT) return Math.min(MAX_SIDEBAR_WIDTH, width - 64);
    const ai = aiPanelVisibleRef.current ? aiPanelWidthRef.current : 0;
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(MAX_SIDEBAR_WIDTH, width - ACTIVITY_WIDTH - ai - EDITOR_FLOOR),
    );
  }, []);

  const maxAiForViewport = useCallback((): number => {
    const width = viewportWidthRef.current;
    if (width < COMPACT_BREAKPOINT) return Math.min(MAX_AI_WIDTH, width - 64);
    const sidebar = sidebarVisibleRef.current ? sidebarWidthRef.current : 0;
    return Math.max(
      MIN_AI_WIDTH,
      Math.min(MAX_AI_WIDTH, width - ACTIVITY_WIDTH - sidebar - EDITOR_FLOOR),
    );
  }, []);

  useEffect(() => {
    const updateViewport = (): void => setViewportWidth(effectiveViewportWidth());
    window.addEventListener('resize', updateViewport, { passive: true });
    window.addEventListener(UI_ZOOM_CHANGED_EVENT, updateViewport);
    updateViewport();
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener(UI_ZOOM_CHANGED_EVENT, updateViewport);
    };
  }, []);

  useEffect(() => {
    if (viewportWidth >= CONSTRAINED_BREAKPOINT || !sidebarVisible || !aiPanelVisible) return;
    if (lastAuxiliaryRef.current === 'ai') setSidebarVisible(false);
    else setAiPanelVisible(false);
  }, [viewportWidth, sidebarVisible, aiPanelVisible]);

  useEffect(() => {
    setSidebarWidthState((width) => clamp(width, MIN_SIDEBAR_WIDTH, maxSidebarForViewport()));
    setAiPanelWidthState((width) => clamp(width, MIN_AI_WIDTH, maxAiForViewport()));
  }, [
    loaded,
    viewportWidth,
    sidebarVisible,
    aiPanelVisible,
    maxSidebarForViewport,
    maxAiForViewport,
  ]);

  useEffect(() => {
    let cancelled = false;
    void window.axiom.layout
      .read()
      .then((stored) => {
        if (cancelled) return;
        let next: LayoutState = {
          version: 1,
          activeView: isPrimaryView(stored.activeView) ? stored.activeView : DEFAULT_VIEW,
          sidebarVisible: typeof stored.sidebarVisible === 'boolean' ? stored.sidebarVisible : true,
          sidebarWidth:
            typeof stored.sidebarWidth === 'number'
              ? clamp(stored.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
              : DEFAULT_WIDTH,
          aiPanelVisible: typeof stored.aiPanelVisible === 'boolean' ? stored.aiPanelVisible : true,
          aiPanelWidth:
            typeof stored.aiPanelWidth === 'number'
              ? clamp(stored.aiPanelWidth, MIN_AI_WIDTH, MAX_AI_WIDTH)
              : DEFAULT_AI_WIDTH,
          activityBarVisible:
            typeof stored.activityBarVisible === 'boolean' ? stored.activityBarVisible : true,
          statusBarVisible:
            typeof stored.statusBarVisible === 'boolean' ? stored.statusBarVisible : true,
          centeredLayout:
            typeof stored.centeredLayout === 'boolean' ? stored.centeredLayout : false,
        };
        for (const transform of pendingLayoutTransformsRef.current) next = transform(next);
        pendingLayoutTransformsRef.current = [];
        layoutHydratedRef.current = true;

        setActiveView(isPrimaryView(next.activeView) ? next.activeView : DEFAULT_VIEW);
        setSidebarVisible(next.sidebarVisible);
        setSidebarWidthState(next.sidebarWidth);
        setAiPanelVisible(next.aiPanelVisible);
        setAiPanelWidthState(next.aiPanelWidth);
        setActivityBarVisible(next.activityBarVisible);
        setStatusBarVisible(next.statusBarVisible);
        setCenteredLayout(next.centeredLayout);
      })
      .catch(() => {
        if (cancelled) return;
        // Optimistic state already contains every queued interaction; on a read
        // failure it becomes the session baseline rather than being discarded.
        pendingLayoutTransformsRef.current = [];
        layoutHydratedRef.current = true;
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const state: LayoutState = {
        version: 1,
        activeView,
        sidebarVisible,
        sidebarWidth,
        aiPanelVisible,
        aiPanelWidth,
        activityBarVisible,
        statusBarVisible,
        centeredLayout,
      };
      void window.axiom.layout.write(state);
    }, 300);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [
    loaded,
    activeView,
    sidebarVisible,
    sidebarWidth,
    aiPanelVisible,
    aiPanelWidth,
    activityBarVisible,
    statusBarVisible,
    centeredLayout,
  ]);

  const showView = useCallback(
    (id: PrimaryViewId) => {
      const constrained = viewportWidthRef.current < CONSTRAINED_BREAKPOINT;
      rememberPreHydrationTransform((current) => ({
        ...current,
        activeView: id,
        sidebarVisible: true,
        aiPanelVisible: constrained ? false : current.aiPanelVisible,
      }));
      lastAuxiliaryRef.current = 'sidebar';
      if (constrained) setAiPanelVisible(false);
      setActiveView(id);
      setSidebarVisible(true);
    },
    [rememberPreHydrationTransform],
  );

  const toggleView = useCallback(
    (id: PrimaryViewId) => {
      const constrained = viewportWidthRef.current < CONSTRAINED_BREAKPOINT;
      rememberPreHydrationTransform((current) => {
        if (current.sidebarVisible && current.activeView === id) {
          return { ...current, sidebarVisible: false };
        }
        return {
          ...current,
          activeView: id,
          sidebarVisible: true,
          aiPanelVisible: constrained ? false : current.aiPanelVisible,
        };
      });
      if (sidebarVisibleRef.current && activeViewRef.current === id) {
        setSidebarVisible(false);
        return;
      }
      lastAuxiliaryRef.current = 'sidebar';
      if (constrained) setAiPanelVisible(false);
      setActiveView(id);
      setSidebarVisible(true);
    },
    [rememberPreHydrationTransform],
  );

  const toggleSidebar = useCallback(() => {
    const constrained = viewportWidthRef.current < CONSTRAINED_BREAKPOINT;
    rememberPreHydrationTransform((current) => {
      const nextVisible = !current.sidebarVisible;
      return {
        ...current,
        sidebarVisible: nextVisible,
        aiPanelVisible: nextVisible && constrained ? false : current.aiPanelVisible,
      };
    });
    setSidebarVisible((visible) => {
      const next = !visible;
      if (next) {
        lastAuxiliaryRef.current = 'sidebar';
        if (constrained) setAiPanelVisible(false);
      }
      return next;
    });
  }, [rememberPreHydrationTransform]);

  const toggleAiPanel = useCallback(() => {
    const constrained = viewportWidthRef.current < CONSTRAINED_BREAKPOINT;
    rememberPreHydrationTransform((current) => {
      const nextVisible = !current.aiPanelVisible;
      return {
        ...current,
        aiPanelVisible: nextVisible,
        sidebarVisible: nextVisible && constrained ? false : current.sidebarVisible,
      };
    });
    setAiPanelVisible((visible) => {
      const next = !visible;
      if (next) {
        lastAuxiliaryRef.current = 'ai';
        if (constrained) setSidebarVisible(false);
      }
      return next;
    });
  }, [rememberPreHydrationTransform]);

  const showAiPanel = useCallback(() => {
    const constrained = viewportWidthRef.current < CONSTRAINED_BREAKPOINT;
    rememberPreHydrationTransform((current) => ({
      ...current,
      aiPanelVisible: true,
      sidebarVisible: constrained ? false : current.sidebarVisible,
    }));
    lastAuxiliaryRef.current = 'ai';
    if (constrained) setSidebarVisible(false);
    setAiPanelVisible(true);
  }, [rememberPreHydrationTransform]);

  const dismissAuxiliary = useCallback(() => {
    rememberPreHydrationTransform((current) => ({
      ...current,
      sidebarVisible: false,
      aiPanelVisible: false,
    }));
    setSidebarVisible(false);
    setAiPanelVisible(false);
  }, [rememberPreHydrationTransform]);

  const setSidebarWidth = useCallback(
    (px: number) => {
      const next = clamp(px, MIN_SIDEBAR_WIDTH, maxSidebarForViewport());
      rememberPreHydrationTransform((current) => ({ ...current, sidebarWidth: next }));
      setSidebarWidthState(next);
    },
    [maxSidebarForViewport, rememberPreHydrationTransform],
  );
  const setAiPanelWidth = useCallback(
    (px: number) => {
      const next = clamp(px, MIN_AI_WIDTH, maxAiForViewport());
      rememberPreHydrationTransform((current) => ({ ...current, aiPanelWidth: next }));
      setAiPanelWidthState(next);
    },
    [maxAiForViewport, rememberPreHydrationTransform],
  );

  const toggleZenMode = useCallback(() => setZenMode((value) => !value), []);
  const toggleCenteredLayout = useCallback(() => {
    rememberPreHydrationTransform((current) => ({
      ...current,
      centeredLayout: !current.centeredLayout,
    }));
    setCenteredLayout((value) => !value);
  }, [rememberPreHydrationTransform]);
  const toggleActivityBar = useCallback(() => {
    rememberPreHydrationTransform((current) => ({
      ...current,
      activityBarVisible: !current.activityBarVisible,
    }));
    setActivityBarVisible((value) => !value);
  }, [rememberPreHydrationTransform]);
  const toggleStatusBar = useCallback(() => {
    rememberPreHydrationTransform((current) => ({
      ...current,
      statusBarVisible: !current.statusBarVisible,
    }));
    setStatusBarVisible((value) => !value);
  }, [rememberPreHydrationTransform]);

  const value = useMemo<LayoutValue>(
    () => ({
      activeView,
      sidebarVisible,
      sidebarWidth,
      zenMode,
      centeredLayout,
      activityBarVisible,
      statusBarVisible,
      aiPanelVisible,
      aiPanelWidth,
      viewportWidth,
      isCompact,
      isConstrained,
      toggleAiPanel,
      showAiPanel,
      setAiPanelWidth,
      showView,
      toggleView,
      toggleSidebar,
      dismissAuxiliary,
      toggleZenMode,
      toggleCenteredLayout,
      toggleActivityBar,
      toggleStatusBar,
      setSidebarWidth,
    }),
    [
      activeView,
      sidebarVisible,
      sidebarWidth,
      zenMode,
      centeredLayout,
      activityBarVisible,
      statusBarVisible,
      aiPanelVisible,
      aiPanelWidth,
      viewportWidth,
      isCompact,
      isConstrained,
      toggleAiPanel,
      showAiPanel,
      setAiPanelWidth,
      showView,
      toggleView,
      toggleSidebar,
      dismissAuxiliary,
      toggleZenMode,
      toggleCenteredLayout,
      toggleActivityBar,
      toggleStatusBar,
      setSidebarWidth,
    ],
  );

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}
