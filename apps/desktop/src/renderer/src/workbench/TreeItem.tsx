import type { CSSProperties, MouseEvent } from 'react';
import type { TreeRowSnapshot } from '../../../common/vscodeViews';
import { Codicon } from './codicons';
import { ChevronIcon, FileIcon } from './treeIcons';

/**
 * One row of a contributed tree (PRD Phase 5 §4).
 *
 * Everything drawn here came out of `TreeItem`, so everything here is text the extension chose:
 * label, description, tooltip, checkbox and icon. None of it is inserted as markup — a label with
 * `<script>` in it is a label with `<script>` in it — and the row's only powers are the intents
 * its parent passes in.
 */
export interface TreeItemRowProps {
  row: TreeRowSnapshot;
  rowHeight: number;
  total: number;
  canSelectMany: boolean;
  onToggle: (row: TreeRowSnapshot) => void;
  onActivate: (row: TreeRowSnapshot) => void;
  onSelect: (row: TreeRowSnapshot, additive: boolean, range: boolean) => void;
  onCheckbox: (row: TreeRowSnapshot) => void;
  onContext: (row: TreeRowSnapshot, x: number, y: number) => void;
  onHover: (row: TreeRowSnapshot) => void;
}

/** `TreeItemLabel.highlights` — the ranges upstream emphasises, e.g. a search match. */
function renderLabel(label: string, highlights: Array<[number, number]> | null) {
  if (highlights === null || highlights.length === 0) return label;
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of highlights) {
    const from = Math.max(cursor, Math.min(start, label.length));
    const to = Math.max(from, Math.min(end, label.length));
    if (from > cursor) parts.push({ text: label.slice(cursor, from), hit: false });
    if (to > from) parts.push({ text: label.slice(from, to), hit: true });
    cursor = to;
  }
  if (cursor < label.length) parts.push({ text: label.slice(cursor), hit: false });
  return parts.map((part, index) =>
    part.hit ? (
      <mark key={index} className="view-row-hit">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

function fileNameOf(resourceUri: string | null): string | undefined {
  if (resourceUri === null) return undefined;
  const withoutQuery = resourceUri.split(/[?#]/)[0] ?? '';
  const segments = withoutQuery.split('/');
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function RowIcon({ row }: { row: TreeRowSnapshot }) {
  const icon = row.item.icon;
  if (icon !== null && icon.kind === 'theme') {
    return <Codicon id={icon.id} color={icon.color} size={16} />;
  }
  if (icon !== null && icon.kind === 'path') {
    // `<img src>` of a `data:` URL: SVG loaded this way renders in the browser's static mode, so
    // third-party icon bytes cannot script. Main already refused anything outside the package.
    const src = icon.dark.length > 0 ? icon.dark : icon.light;
    if (src.length === 0) return null;
    return <img className="view-row-img" src={src} alt="" aria-hidden="true" draggable={false} />;
  }
  const name = fileNameOf(row.item.resourceUri);
  if (name !== undefined && row.item.collapsibleState === 'none') {
    return <FileIcon name={name} size={16} />;
  }
  return null;
}

export function TreeItemRow({
  row,
  rowHeight,
  total,
  canSelectMany,
  onToggle,
  onActivate,
  onSelect,
  onCheckbox,
  onContext,
  onHover,
}: TreeItemRowProps) {
  const style: CSSProperties = { height: rowHeight, paddingLeft: 4 + row.depth * 10 };
  const tooltip = row.item.tooltip ?? row.item.label;
  const stop = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className={`view-row${row.selected ? ' selected' : ''}${row.focused ? ' focused' : ''}`}
      style={style}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.index + 1}
      aria-setsize={total}
      aria-selected={row.selected}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-label={row.ariaLabel}
      aria-checked={
        row.item.checkboxState === null ? undefined : row.item.checkboxState === 'checked'
      }
      aria-busy={row.loading || undefined}
      title={tooltip}
      tabIndex={-1}
      data-handle={row.handle}
      onMouseEnter={() => onHover(row)}
      onClick={(event) => {
        onSelect(
          row,
          canSelectMany && (event.ctrlKey || event.metaKey),
          canSelectMany && event.shiftKey,
        );
        onActivate(row);
      }}
      onDoubleClick={() => {
        if (row.expandable) onToggle(row);
      }}
      onContextMenu={(event) => {
        stop(event);
        onSelect(row, false, false);
        onContext(row, event.clientX, event.clientY);
      }}
    >
      {row.expandable ? (
        <button
          type="button"
          className="tree-twisty"
          tabIndex={-1}
          aria-label={row.expanded ? 'Collapse' : 'Expand'}
          onClick={(event) => {
            stop(event);
            onToggle(row);
          }}
        >
          <ChevronIcon open={row.expanded} size={14} />
        </button>
      ) : (
        <span className="tree-twisty tree-twisty-empty" aria-hidden="true" />
      )}
      {row.item.checkboxState === null ? null : (
        <input
          type="checkbox"
          className="view-row-checkbox"
          tabIndex={-1}
          checked={row.item.checkboxState === 'checked'}
          title={row.item.checkboxTooltip ?? undefined}
          aria-label={`${row.item.label} checkbox`}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onCheckbox(row)}
        />
      )}
      <span className="view-row-icon">
        <RowIcon row={row} />
      </span>
      <span className="view-row-label">{renderLabel(row.item.label, row.item.highlights)}</span>
      {row.item.description === null ? null : (
        <span className="view-row-description">{row.item.description}</span>
      )}
      {row.loading ? <span className="view-row-spinner" aria-hidden="true" /> : null}
    </div>
  );
}
