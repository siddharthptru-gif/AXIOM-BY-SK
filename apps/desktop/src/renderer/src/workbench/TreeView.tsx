import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedMenuGroup } from '../../../common/vscodeMenus';
import type {
  TreeRowSnapshot,
  TreeViewSnapshot,
  ViewSummary,
  WelcomeBlock,
} from '../../../common/vscodeViews';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { TreeItemRow } from './TreeItem';
import { Codicon } from './codicons';
import { ChevronIcon } from './treeIcons';

/**
 * A contributed tree view (PRD Phase 5 §3, §9, §12, §13).
 *
 * The window half of `TreeDataProvider`. Main owns the provider, the node handles, the expansion
 * and the flattened row list; this draws the slice Main says is on screen and reports what the
 * user did. That split is what makes a 10,000-node tree cheap: the snapshot for a 400 px pane
 * carries about 30 rows no matter how large the tree is, and scrolling asks for a different 30.
 *
 * The pane is deliberately not a `PrimaryViewId`. AXIOM's layout contract enumerates the panes
 * this build ships; a contributed view is a section inside a sidebar instead, so nothing in the
 * existing layout state has to learn third-party ids.
 */
const KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageDown',
  'PageUp',
  'Enter',
  ' ',
]);

/** Scroll pushes are coalesced: Main recomputes the window, so one per frame is plenty. */
const SCROLL_THROTTLE_MS = 40;

interface TreeViewPaneProps {
  view: ViewSummary;
  /** Height in pixels the body is allowed. Drives how many rows Main returns. */
  bodyHeight?: number;
  onToggleCollapsed?: (viewId: string, collapsed: boolean) => void;
}

export function TreeViewPane({ view, bodyHeight = 320, onToggleCollapsed }: TreeViewPaneProps) {
  const [snapshot, setSnapshot] = useState<TreeViewSnapshot | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollPushedAt = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(new Set<string>());
  const viewId = view.id;
  const collapsed = snapshot?.collapsed ?? view.collapsed;
  const height = collapsed ? 0 : bodyHeight;

  const reload = useCallback(async () => {
    try {
      setSnapshot(await window.axiom.views.tree(viewId, height));
    } catch {
      setSnapshot(null);
    }
  }, [viewId, height]);

  useEffect(() => {
    void reload();
    return window.axiom.views.onChanged(() => void reload());
  }, [reload]);

  // Visibility is what makes a provider run: a collapsed or unmounted pane costs nothing, and the
  // extension's `TreeView.visible` / `onDidChangeVisibility` follow from exactly this.
  useEffect(() => {
    void window.axiom.views.visibility(viewId, !collapsed).catch(() => undefined);
    return () => {
      void window.axiom.views.visibility(viewId, false).catch(() => undefined);
    };
  }, [viewId, collapsed]);

  const pushScroll = useCallback(
    (scrollTop: number) => {
      const send = (): void => {
        scrollPushedAt.current = Date.now();
        void window.axiom.views
          .layout({ viewId, scrollTop })
          .then(() => reload())
          .catch(() => undefined);
      };
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
      const since = Date.now() - scrollPushedAt.current;
      if (since >= SCROLL_THROTTLE_MS) send();
      else scrollTimer.current = setTimeout(send, SCROLL_THROTTLE_MS - since);
    },
    [viewId, reload],
  );

  useEffect(
    () => () => {
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    },
    [],
  );

  // Keyboard focus follows Main's `focused` handle, so the browser's scroll anchoring cannot
  // disagree with the model about which row is current.
  useEffect(() => {
    if (snapshot === null || snapshot.focused === null) return;
    const body = bodyRef.current;
    if (body === null) return;
    const row = snapshot.rows.find((entry) => entry.handle === snapshot.focused);
    if (row === undefined) return;
    const top = row.index * snapshot.rowHeight;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + snapshot.rowHeight > body.scrollTop + body.clientHeight) {
      body.scrollTop = top + snapshot.rowHeight - body.clientHeight;
    }
  }, [snapshot]);

  const rows = snapshot?.rows ?? [];
  const rowHeight = snapshot?.rowHeight ?? 22;

  // The view title menu is resolved rather than assumed: its items are `when`-gated, so the set
  // changes as context keys change. Re-read it with every snapshot and draw the button only if an
  // extension actually contributed something that is currently visible.
  const [titleGroups, setTitleGroups] = useState<ResolvedMenuGroup[]>([]);
  const titleVersion = snapshot?.version ?? -1;
  useEffect(() => {
    let live = true;
    void window.axiom.views
      .menu('view/title', { viewId })
      .then((groups) => {
        if (live) setTitleGroups(groups);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [viewId, titleVersion]);

  const openContextMenu = useCallback(
    async (row: TreeRowSnapshot, x: number, y: number) => {
      const groups = await window.axiom.views
        .menu('view/item/context', { viewId, handle: row.handle })
        .catch<ResolvedMenuGroup[]>(() => []);
      const entries = menuEntries(groups, (command) => {
        void window.axiom.views
          .runMenuCommand('view/item/context', command, { viewId, handle: row.handle })
          .catch(() => undefined);
      });
      if (entries.length === 0) return;
      setMenu({ x, y, entries });
    },
    [viewId],
  );

  const openTitleMenu = useCallback(
    (x: number, y: number) => {
      const entries = menuEntries(titleGroups, (command) => {
        void window.axiom.views
          .runMenuCommand('view/title', command, { viewId })
          .catch(() => undefined);
      });
      if (entries.length === 0) return;
      setMenu({ x, y, entries });
    },
    [titleGroups, viewId],
  );

  const title = snapshot?.title ?? view.contextualTitle ?? view.name;
  const badge = snapshot?.badge ?? view.badge;

  return (
    <section className={`tree-pane${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      <div className="tree-pane-header">
        <button
          type="button"
          className="tree-pane-twisty"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          onClick={() => {
            const next = !collapsed;
            void window.axiom.views.layout({ viewId, collapsed: next }).catch(() => undefined);
            onToggleCollapsed?.(viewId, next);
          }}
        >
          <ChevronIcon open={!collapsed} size={14} />
        </button>
        <span className="tree-pane-title">{title}</span>
        {snapshot?.description === null || snapshot === null ? null : (
          <span className="tree-pane-description">{snapshot.description}</span>
        )}
        {badge === null || badge === undefined ? null : (
          <span className="tree-pane-badge" title={badge.tooltip}>
            {badge.value}
          </span>
        )}
        <span className="tree-pane-actions">
          {snapshot?.showCollapseAll === true ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Collapse all in ${title}`}
              onClick={() => {
                void window.axiom.views.expand(viewId, null, false).catch(() => undefined);
              }}
            >
              <Codicon id="collapse-all" size={14} />
            </button>
          ) : null}
          {titleGroups.length === 0 ? null : (
            <button
              type="button"
              className="icon-btn"
              aria-label={`More actions for ${title}`}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openTitleMenu(rect.left, rect.bottom);
              }}
            >
              <Codicon id="ellipsis" size={14} />
            </button>
          )}
        </span>
      </div>
      {collapsed ? null : (
        <div
          ref={bodyRef}
          className="tree-pane-body"
          style={{ height: bodyHeight }}
          role="tree"
          aria-label={title}
          aria-multiselectable={snapshot?.canSelectMany === true}
          aria-busy={snapshot?.loading === true || undefined}
          tabIndex={0}
          onScroll={(event) => pushScroll(event.currentTarget.scrollTop)}
          onKeyDown={(event) => {
            if (!KEYS.has(event.key)) return;
            event.preventDefault();
            void window.axiom.views
              .key(viewId, event.key)
              .then(() => reload())
              .catch(() => undefined);
          }}
        >
          {snapshot === null ? (
            <p className="tree-pane-empty">Loading…</p>
          ) : rows.length === 0 ? (
            <TreeEmpty snapshot={snapshot} />
          ) : (
            <div className="tree-rows" style={{ height: snapshot.totalHeight }}>
              <div style={{ height: snapshot.topPadding }} aria-hidden="true" />
              {rows.map((row) => (
                <TreeItemRow
                  key={row.handle}
                  row={row}
                  rowHeight={rowHeight}
                  total={snapshot.total}
                  canSelectMany={snapshot.canSelectMany}
                  onToggle={(target) => {
                    void window.axiom.views
                      .expand(viewId, target.handle, !target.expanded)
                      .catch(() => undefined);
                  }}
                  onActivate={(target) => {
                    void window.axiom.views.activate(viewId, target.handle).catch(() => undefined);
                  }}
                  onSelect={(target, additive, range) => {
                    const current = snapshot.selection;
                    const next = additive
                      ? current.includes(target.handle)
                        ? current.filter((handle) => handle !== target.handle)
                        : [...current, target.handle]
                      : range
                        ? rangeSelection(rows, current, target)
                        : [target.handle];
                    void window.axiom.views.select(viewId, next).catch(() => undefined);
                  }}
                  onCheckbox={(target) => {
                    void window.axiom.views.checkbox(viewId, target.handle).catch(() => undefined);
                  }}
                  onContext={(target, x, y) => void openContextMenu(target, x, y)}
                  onHover={(target) => {
                    // `resolveTreeItem` is at-most-once per node in Main; this is the hover that
                    // upstream uses to fill in a tooltip lazily.
                    if (hovered.current.has(target.handle)) return;
                    hovered.current.add(target.handle);
                    void window.axiom.views
                      .resolveItem(viewId, target.handle)
                      .catch(() => undefined);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {menu === null ? null : (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      )}
    </section>
  );
}

/** Shift-click: everything between the last selected row and this one, in visible order. */
function rangeSelection(
  rows: readonly TreeRowSnapshot[],
  selection: readonly string[],
  target: TreeRowSnapshot,
): string[] {
  const anchorHandle = selection[selection.length - 1];
  const anchor = rows.find((row) => row.handle === anchorHandle);
  if (anchor === undefined) return [target.handle];
  const from = Math.min(anchor.index, target.index);
  const to = Math.max(anchor.index, target.index);
  return rows.filter((row) => row.index >= from && row.index <= to).map((row) => row.handle);
}

/** `contributes.menus` groups → the workbench's own menu model, separators included. */
function menuEntries(groups: ResolvedMenuGroup[], run: (command: string) => void): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    if (entries.length > 0) entries.push({ separator: true });
    for (const item of group.items) {
      const command = item.command;
      if (command === null) {
        // A submenu with no flattening target is drawn disabled rather than silently dropped, so
        // an extension's contribution is visible even where AXIOM cannot open a nested menu yet.
        entries.push({ label: item.title, disabled: true, onSelect: () => undefined });
        continue;
      }
      entries.push({
        label: item.title,
        disabled: !item.enabled,
        onSelect: () => run(command),
      });
    }
  }
  return entries;
}

/**
 * What an empty tree shows (PRD Phase 5 §8).
 *
 * `viewsWelcome` content, when an extension contributed some and its `when` clause holds — this is
 * how GitHub Pull Requests offers "Sign in" before it has anything to list. Links and buttons are
 * restricted to `command:` and `https:` targets by the parser, so nothing here can navigate the
 * workbench somewhere a `file:` or `javascript:` target would.
 */
function TreeEmpty({ snapshot }: { snapshot: TreeViewSnapshot }) {
  const welcome = useMemo(() => snapshot.welcome.filter((entry) => entry.enabled), [snapshot]);
  if (snapshot.error !== null) {
    return (
      <p className="tree-pane-empty tree-pane-error" role="status">
        {snapshot.error}
      </p>
    );
  }
  if (snapshot.loading) return <p className="tree-pane-empty">Loading…</p>;
  if (!snapshot.registered) {
    return <p className="tree-pane-empty">This view&apos;s extension has not activated yet.</p>;
  }
  if (welcome.length === 0) {
    return <p className="tree-pane-empty">{snapshot.message ?? 'No items.'}</p>;
  }
  return (
    <div className="tree-welcome">
      {welcome.flatMap((entry) =>
        entry.blocks.map((block, index) => (
          <WelcomeBlockView key={`${entry.extensionId}:${index}`} block={block} />
        )),
      )}
    </div>
  );
}

function runWelcomeCommand(command: string): void {
  // The same path the command palette uses for a contributed command: Main resolves the owning
  // extension, activates it if needed, and refuses ids no extension registered.
  void window.axiom.host.runCommand(command, [], null).catch(() => undefined);
}

function WelcomeBlockView({ block }: { block: WelcomeBlock }) {
  if (block.kind === 'button') {
    const command = block.command;
    if (command !== null) {
      return (
        <button
          type="button"
          className="btn btn-primary tree-welcome-button"
          onClick={() => runWelcomeCommand(command)}
        >
          {block.label}
        </button>
      );
    }
    if (block.href !== null) {
      return (
        <a className="btn tree-welcome-button" href={block.href} rel="noreferrer noopener">
          {block.label}
        </a>
      );
    }
    return <span className="tree-welcome-text">{block.label}</span>;
  }
  return (
    <p className="tree-welcome-text">
      {block.spans.map((span, index) =>
        span.kind === 'plain' ? (
          <span key={index}>{span.text}</span>
        ) : span.command !== null ? (
          <button
            key={index}
            type="button"
            className="link-button"
            onClick={() => runWelcomeCommand(span.command ?? '')}
          >
            {span.text}
          </button>
        ) : (
          <a key={index} href={span.href ?? '#'} rel="noreferrer noopener">
            {span.text}
          </a>
        ),
      )}
    </p>
  );
}
