import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ContainerSnapshot,
  ViewSummary,
  WorkbenchSnapshot,
} from '../../../common/vscodeViews';
import { TreeViewPane } from './TreeView';
import { Codicon } from './codicons';

/**
 * Contributed view containers (PRD Phase 5 §1, §2, §9).
 *
 * `contributes.viewsContainers` asks for an activity bar entry with a sidebar behind it, and
 * `contributes.views` fills that sidebar. AXIOM's own activity bar is a fixed list of
 * `PrimaryViewId`s, so a contributed container is drawn *beside* that list rather than added to it:
 * the layout contract keeps enumerating the panes this build ships, and third-party ids live in
 * this file's state and in the workbench service's own persistence file.
 *
 * A view whose container is one of upstream's built-ins (`explorer`, `scm`, `debug`, …) is not a
 * new entry at all — it is a section appended to the matching AXIOM sidebar, which is what
 * `ContributedSections` draws.
 */
export interface ContributedWorkbench {
  /** Activity-bar containers, in contribution order. */
  containers: ContainerSnapshot[];
  /** Panel-location containers. Drawn in the bottom panel host, not the activity bar. */
  panels: ContainerSnapshot[];
  /** Views that belong in one of AXIOM's own sidebars, keyed by that sidebar's id. */
  builtIn: Record<string, ViewSummary[]>;
  /** The contributed container on screen, or null when an AXIOM pane is. */
  active: string | null;
  select: (containerId: string | null) => void;
  snapshot: WorkbenchSnapshot | null;
}

const EMPTY: ContainerSnapshot[] = [];

/**
 * Read the workbench model and keep it live.
 *
 * One snapshot for the whole activity bar, refreshed on the service's `onChanged` push — the same
 * shape Phase 4 used for webviews. `sidebarVisible` is threaded in because two context keys the
 * workbench owns (`sideBarVisible`, `activeViewlet`) are facts only the window knows, and
 * extensions gate menu items on them.
 */
export function useContributedWorkbench(sidebarVisible: boolean): ContributedWorkbench {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSnapshot(await window.axiom.views.workbench());
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void reload();
    return window.axiom.views.onChanged(() => void reload());
  }, [reload]);

  // Which container was showing at quit, restored once. A container whose extension has since been
  // uninstalled simply is not in the snapshot, and the built-in sidebar stays.
  useEffect(() => {
    if (restored || snapshot === null) return;
    setRestored(true);
    const wanted = snapshot.activeContainer;
    if (wanted !== null && snapshot.containers.some((container) => container.id === wanted)) {
      setActive(wanted);
    }
  }, [restored, snapshot]);

  const select = useCallback((containerId: string | null) => {
    setActive(containerId);
    void window.axiom.views.layout({ activeContainer: containerId }).catch(() => undefined);
  }, []);

  // A contributed container that disappears — uninstalled, disabled — must not leave the sidebar
  // pointing at nothing.
  useEffect(() => {
    if (snapshot === null || active === null) return;
    if (!snapshot.containers.some((container) => container.id === active)) setActive(null);
  }, [snapshot, active]);

  useEffect(() => {
    void window.axiom.views
      .context({ sideBarVisible: sidebarVisible, activeViewlet: active ?? '' })
      .catch(() => undefined);
  }, [sidebarVisible, active]);

  return useMemo(
    () => ({
      containers: snapshot?.containers ?? EMPTY,
      panels: snapshot?.panels ?? EMPTY,
      builtIn: snapshot?.builtIn ?? {},
      active,
      select,
      snapshot,
    }),
    [snapshot, active, select],
  );
}

/** The activity bar button for one contributed container. */
export function ContainerButton({
  container,
  active,
  onSelect,
}: {
  container: ContainerSnapshot;
  active: boolean;
  onSelect: () => void;
}) {
  const label = `${container.title} (${container.extensionName})`;
  return (
    <button
      type="button"
      className={`activity-item activity-contributed ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onSelect}
    >
      {container.icon === null ? (
        <Codicon id="extensions" size={20} />
      ) : (
        <img className="activity-contributed-icon" src={container.icon} alt="" aria-hidden="true" />
      )}
      {container.badge === null ? null : (
        <span className="activity-badge" title={container.badge.tooltip}>
          {container.badge.value > 99 ? '99+' : container.badge.value}
        </span>
      )}
    </button>
  );
}

/**
 * The sidebar behind a contributed container.
 *
 * Sized like AXIOM's own sidebar and drawn in its place, so the editor never shifts. Each view in
 * the container is a pane; a webview-backed view is not drawn here, because a webview is a guest
 * document with its own origin and Phase 4 gave it a host of its own — the pane offers to open it
 * there rather than silently showing nothing.
 */
export function ContributedContainerSidebar({
  container,
  width,
  bodyHeight,
}: {
  container: ContainerSnapshot;
  width?: number;
  bodyHeight?: number;
}) {
  const views = container.views;
  const trees = views.filter((view) => view.type === 'tree');
  // Panes share the sidebar: with three trees open each gets a third of it, as upstream does.
  const perPane = Math.max(
    120,
    Math.floor(((bodyHeight ?? 640) - 28 * views.length) / Math.max(1, trees.length)),
  );
  return (
    <aside
      className="sidebar sidebar-contributed"
      aria-label={`${container.title} (${container.extensionName})`}
      style={width === undefined ? undefined : { width }}
    >
      <div className="sidebar-header">
        <span>{container.title}</span>
        <span className="sidebar-header-source">{container.extensionName}</span>
      </div>
      <div className="sidebar-body">
        {views.length === 0 ? (
          <p className="tree-pane-empty">This container has no views.</p>
        ) : (
          views.map((view) =>
            view.type === 'tree' ? (
              <TreeViewPane key={view.id} view={view} bodyHeight={perPane} />
            ) : (
              <WebviewViewPane key={view.id} view={view} />
            ),
          )
        )}
      </div>
    </aside>
  );
}

/**
 * A `WebviewViewProvider`-backed view.
 *
 * Phase 4 draws webviews in their own layer, on their own origin. Rather than embed one inside the
 * sidebar — which would mean an extension document sharing the workbench's layout — the pane names
 * it and opens it there. `resolveView` is what runs the provider, so nothing starts until asked.
 */
function WebviewViewPane({ view }: { view: ViewSummary }) {
  const [opening, setOpening] = useState(false);
  return (
    <section className="tree-pane" aria-label={view.name}>
      <div className="tree-pane-header">
        <span className="tree-pane-title">{view.name}</span>
      </div>
      <div className="tree-pane-webview">
        <p className="tree-pane-empty">{view.extensionName} provides this view as a webview.</p>
        <button
          type="button"
          className="btn"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            void window.axiom.webview
              .resolveView(view.id)
              .catch(() => undefined)
              .finally(() => setOpening(false));
          }}
        >
          {opening ? 'Opening…' : 'Open'}
        </button>
      </div>
    </section>
  );
}

/**
 * Contributed views inside one of AXIOM's own sidebars (PRD Phase 5 §2).
 *
 * `contributes.views` into `explorer`, `scm`, `debug`, `search` or `extensions` is an extension
 * asking to appear inside a surface the workbench already owns. The answer is a section under the
 * existing content: nothing above it moves, and a sidebar nobody contributed to renders nothing.
 *
 * It reads the workbench snapshot itself so the surrounding sidebar keeps the signature it has —
 * dropping this component in is the whole change on that side.
 */
export function ContributedSections({ sidebar }: { sidebar: string }) {
  const [views, setViews] = useState<ViewSummary[]>([]);

  useEffect(() => {
    let live = true;
    const load = (): void => {
      void window.axiom.views
        .workbench()
        .then((snapshot) => {
          if (live) setViews(snapshot.builtIn[sidebar] ?? []);
        })
        .catch(() => undefined);
    };
    load();
    const stop = window.axiom.views.onChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [sidebar]);

  if (views.length === 0) return null;
  return (
    <div className="contributed-sections" data-sidebar={sidebar}>
      {views.map((view) =>
        view.type === 'tree' ? (
          <TreeViewPane key={view.id} view={view} bodyHeight={220} />
        ) : (
          <WebviewViewPane key={view.id} view={view} />
        ),
      )}
    </div>
  );
}
