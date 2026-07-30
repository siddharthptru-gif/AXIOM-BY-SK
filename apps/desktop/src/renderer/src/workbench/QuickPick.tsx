import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fuzzyMatch } from '../commands/fuzzy';

export interface QuickPickItem {
  id: string;
  label: string;
  description?: string | undefined;
  keybinding?: string | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  /** Which field to fuzzy-match against and highlight. Defaults to `label`. */
  matchField?: 'label' | 'description' | undefined;
}

interface QuickPickProps {
  placeholder: string;
  items: QuickPickItem[];
  loading?: boolean;
  emptyMessage?: string;
  /** Seed the input (e.g. text carried over from a Quick Open prefix). */
  initialQuery?: string;
  /** Notified on every input change (used for prefix routing). */
  onQueryChange?: (query: string) => void;
  onAccept: (item: QuickPickItem) => void;
  onClose: () => void;
}

const MAX_RESULTS = 200;

interface Scored {
  item: QuickPickItem;
  matches: number[];
}

function nextEnabledIndex(results: Scored[], current: number, direction: 1 | -1): number {
  if (results.length === 0) return 0;
  for (let offset = 1; offset <= results.length; offset += 1) {
    const index = (current + direction * offset + results.length) % results.length;
    if (!results[index]?.item.disabled) return index;
  }
  return Math.max(0, Math.min(current, results.length - 1));
}

function highlight(text: string, matches: number[]): ReactNode {
  if (matches.length === 0) return text;
  const set = new Set(matches);
  const out: ReactNode[] = [];
  let run = '';
  let runHi = false;
  const flush = (): void => {
    if (run.length === 0) return;
    const key = out.length;
    out.push(
      runHi ? (
        <mark key={key} className="qp-hi">
          {run}
        </mark>
      ) : (
        <span key={key}>{run}</span>
      ),
    );
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hi = set.has(i);
    if (hi !== runHi) flush();
    runHi = hi;
    run += text[i] ?? '';
  }
  flush();
  return out;
}

/**
 * Generic filterable command/file palette (PRD Part VII §105). Fuzzy-filters the
 * supplied items, supports full keyboard navigation, and highlights matches.
 */
export function QuickPick({
  placeholder,
  items,
  loading,
  emptyMessage,
  initialQuery,
  onQueryChange,
  onAccept,
  onClose,
}: QuickPickProps) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<Scored[]>(() => {
    const q = query.trim();
    if (q.length === 0) return items.slice(0, MAX_RESULTS).map((item) => ({ item, matches: [] }));
    const scored: { item: QuickPickItem; matches: number[]; score: number }[] = [];
    for (const item of items) {
      const field = item.matchField ?? 'label';
      const text = (field === 'description' ? item.description : item.label) ?? '';
      const res = fuzzyMatch(q, text);
      if (res) scored.push({ item, matches: res.matches, score: res.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [items, query]);

  useEffect(() => {
    const firstEnabled = results.findIndex(({ item }) => !item.disabled);
    setActiveIndex(firstEnabled < 0 ? 0 : firstEnabled);
  }, [query, items, results]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);

  const accept = (index: number): void => {
    const chosen = results[index];
    if (chosen && !chosen.item.disabled) onAccept(chosen.item);
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            onQueryChange?.(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => nextEnabledIndex(results, i, 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => nextEnabledIndex(results, i, -1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              accept(activeIndex);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {loading ? (
            <div className="palette-empty">Loading…</div>
          ) : results.length === 0 ? (
            <div className="palette-empty">{emptyMessage ?? 'No matching results'}</div>
          ) : (
            results.map(({ item, matches }, index) => {
              const field = item.matchField ?? 'label';
              const active = index === activeIndex;
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={active}
                  aria-disabled={item.disabled === true}
                  title={item.disabled ? item.disabledReason : undefined}
                  data-active={active}
                  className={`palette-item ${active ? 'active' : ''}${item.disabled ? ' disabled' : ''}`}
                  onMouseMove={() => {
                    if (!item.disabled) setActiveIndex(index);
                  }}
                  onClick={() => {
                    if (!item.disabled) onAccept(item);
                  }}
                >
                  <span className="palette-item-label">
                    {field === 'label' ? highlight(item.label, matches) : item.label}
                  </span>
                  {item.description ? (
                    <span className="palette-item-desc">
                      {field === 'description'
                        ? highlight(item.description, matches)
                        : item.description}
                    </span>
                  ) : null}
                  {item.keybinding ? (
                    <span className="palette-item-kbd">{item.keybinding}</span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
