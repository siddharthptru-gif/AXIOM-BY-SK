/**
 * Roving focus-order model (PRD Epoch I §116 / Phase 254). Pure keyboard-navigation
 * logic for a roving-tabindex list/grid: given the current focus index, the item
 * count, and a key, return the next index to focus (or -1 when the key isn't a
 * navigation key, so the caller leaves the event alone). No DOM — a renderer list
 * applies the result via element refs + roving tabIndex. Smoke-tested.
 */

export type FocusOrientation = 'vertical' | 'horizontal';

export interface FocusNavOptions {
  /** Which arrow keys advance/retreat (default 'vertical' → Up/Down). */
  orientation?: FocusOrientation;
  /** Wrap around the ends (default true). Home/End/Page never wrap. */
  wrap?: boolean;
  /** Rows moved by PageUp/PageDown (default 10). */
  pageSize?: number;
}

/**
 * Compute the next focus index for a roving list. Returns a valid index [0,count)
 * for a handled navigation key, or -1 when the key is not a navigation key or the
 * list is empty (so the caller does not preventDefault).
 */
export function nextFocusIndex(
  current: number,
  count: number,
  key: string,
  options: FocusNavOptions = {},
): number {
  if (count <= 0) return -1;
  const orientation = options.orientation ?? 'vertical';
  const wrap = options.wrap ?? true;
  const pageSize = options.pageSize && options.pageSize > 0 ? Math.floor(options.pageSize) : 10;
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const clamp = (i: number): number => Math.max(0, Math.min(count - 1, i));

  // No valid current focus yet → land on an edge for the first navigation.
  if (current < 0 || current >= count) {
    switch (key) {
      case nextKey:
      case 'Home':
      case 'PageDown':
        return 0;
      case prevKey:
      case 'End':
      case 'PageUp':
        return count - 1;
      default:
        return -1;
    }
  }

  const step = (delta: number): number => {
    const raw = current + delta;
    if (wrap) return ((raw % count) + count) % count;
    return clamp(raw);
  };

  switch (key) {
    case nextKey:
      return step(1);
    case prevKey:
      return step(-1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clamp(current + pageSize);
    case 'PageUp':
      return clamp(current - pageSize);
    default:
      return -1;
  }
}

/** Roving tabIndex for an item: 0 for the focused item, -1 for the rest. */
export function rovingTabIndex(index: number, focusIndex: number): 0 | -1 {
  return index === focusIndex ? 0 : -1;
}
