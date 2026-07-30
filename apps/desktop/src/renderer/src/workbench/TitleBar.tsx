import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Logo, CommandIcon } from './icons';
import { useCommandRegistry, type Command } from '../commands/registry';

/**
 * Custom draggable title bar. PRD Part IX §160. Native window controls are
 * drawn by Electron's titleBarOverlay on the right; interactive elements here
 * are marked no-drag.
 *
 * The menu bar is data-driven: each top-level menu maps to one or more command
 * *categories*, and its items are the live commands registered under those
 * categories (so a menu always reflects what the workbench can actually do).
 * Clicking an item runs the command via the registry.
 */
interface MenuDef {
  label: string;
  categories: string[];
}

const MENUS: MenuDef[] = [
  { label: 'File', categories: ['File'] },
  { label: 'Edit', categories: ['Edit', 'Editor'] },
  { label: 'Selection', categories: ['Selection'] },
  { label: 'View', categories: ['View', 'Search', 'Explorer', 'Preferences'] },
  { label: 'Go', categories: ['Go'] },
  { label: 'Run', categories: ['Run'] },
  { label: 'Terminal', categories: ['Terminal'] },
  { label: 'Help', categories: ['Help', 'Application', 'Account'] },
];

export function TitleBar() {
  const { getCommands, runCommand } = useCommandRegistry();
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  // Close the open menu on outside click or Escape.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Commands for a menu, ordered by the menu's category order then title.
  const itemsFor = useCallback(
    (menu: MenuDef): Command[] => {
      const all = getCommands();
      return all
        .filter(
          (c) =>
            c.visible?.() !== false &&
            c.category !== undefined &&
            menu.categories.includes(c.category),
        )
        .sort((a, b) => {
          const ca = menu.categories.indexOf(a.category ?? '');
          const cb = menu.categories.indexOf(b.category ?? '');
          return ca - cb || a.title.localeCompare(b.title);
        });
    },
    [getCommands],
  );

  const onItem = useCallback(
    (id: string): void => {
      runCommand(id);
      setOpen(null);
    },
    [runCommand],
  );

  const menuButtons = (): HTMLButtonElement[] =>
    barRef.current
      ? Array.from(barRef.current.querySelectorAll<HTMLButtonElement>('.menu-root > button'))
      : [];

  const focusFirstItem = (menuIndex: number): void => {
    requestAnimationFrame(() => {
      const root = barRef.current?.querySelectorAll<HTMLElement>('.menu-root')[menuIndex];
      root?.querySelector<HTMLButtonElement>('.menu-cmd:not(:disabled)')?.focus();
    });
  };

  const activateMenu = (menuIndex: number, focusItem: boolean): void => {
    const normalized = (menuIndex + MENUS.length) % MENUS.length;
    const menu = MENUS[normalized];
    if (!menu) return;
    setOpen(menu.label);
    if (focusItem) focusFirstItem(normalized);
    else requestAnimationFrame(() => menuButtons()[normalized]?.focus());
  };

  const onMenuButtonKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    menuIndex: number,
  ): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activateMenu(menuIndex, true);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = menuIndex + (event.key === 'ArrowRight' ? 1 : -1);
      if (open === null) {
        const normalized = (next + MENUS.length) % MENUS.length;
        menuButtons()[normalized]?.focus();
      } else {
        activateMenu(next, false);
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : MENUS.length - 1;
      menuButtons()[target]?.focus();
    }
  };

  const onMenuItemKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    menuIndex: number,
  ): void => {
    const popover = event.currentTarget.closest('.menu-popover');
    const items = popover
      ? Array.from(popover.querySelectorAll<HTMLButtonElement>('.menu-cmd:not(:disabled)'))
      : [];
    const current = items.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      activateMenu(menuIndex + (event.key === 'ArrowRight' ? 1 : -1), true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(null);
      requestAnimationFrame(() => menuButtons()[menuIndex]?.focus());
    }
  };

  return (
    <header className="titlebar">
      <div className="brand no-drag">
        <Logo size={18} />
        <span className="brand-name">Axiom</span>
        <span className="brand-tag">Think. Build. Ship.</span>
      </div>
      <nav className="titlebar-menu no-drag" aria-label="Application menu" ref={barRef}>
        {MENUS.map((menu, menuIndex) => {
          const isOpen = open === menu.label;
          const items = isOpen ? itemsFor(menu) : [];
          return (
            <div key={menu.label} className="menu-root">
              <button
                type="button"
                className={isOpen ? 'is-open' : ''}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={isOpen ? `titlebar-menu-${menuIndex}` : undefined}
                onClick={() => setOpen(isOpen ? null : menu.label)}
                onKeyDown={(event) => onMenuButtonKeyDown(event, menuIndex)}
                onMouseEnter={() => setOpen((cur) => (cur !== null ? menu.label : cur))}
              >
                {menu.label}
              </button>
              {isOpen ? (
                <div
                  id={`titlebar-menu-${menuIndex}`}
                  className="menu-popover"
                  role="menu"
                  aria-label={menu.label}
                >
                  {items.length === 0 ? (
                    <div className="menu-empty">No actions available</div>
                  ) : (
                    items.map((c, i) => {
                      const prev = items[i - 1];
                      const sep = prev !== undefined && prev.category !== c.category;
                      return (
                        <Fragment key={c.id}>
                          {sep ? <div className="menu-sep" role="separator" /> : null}
                          <button
                            type="button"
                            className="menu-cmd"
                            role="menuitem"
                            disabled={c.enabled?.() === false}
                            title={c.enabled?.() === false ? c.disabledReason?.() : undefined}
                            onClick={() => onItem(c.id)}
                            onKeyDown={(event) => onMenuItemKeyDown(event, menuIndex)}
                          >
                            <span>{c.title}</span>
                            {c.enabled?.() === false && (
                              <span className="menu-cmd-reason">
                                {c.disabledReason?.() ?? 'Unavailable'}
                              </span>
                            )}
                          </button>
                        </Fragment>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
      <div className="titlebar-command-wrap no-drag">
        <button
          type="button"
          className="titlebar-command"
          aria-label="Open Quick Open"
          title="Go to File (Ctrl+P)"
          onClick={() => runCommand('workbench.action.quickOpen')}
        >
          <CommandIcon size={14} />
          <span>Search files by name</span>
          <kbd>Ctrl P</kbd>
        </button>
      </div>
    </header>
  );
}
