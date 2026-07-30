import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { PrimaryViewId } from '../state/layout';
import type { ContainerSnapshot } from '../../../common/vscodeViews';
import {
  ExplorerIcon,
  SearchIcon,
  SemanticSearchIcon,
  SourceControlIcon,
  RunIcon,
  PackageIcon,
  ExtensionsIcon,
  IntelligenceIcon,
  GodModeIcon,
  AiIcon,
  SettingsIcon,
} from './icons';
import { AccountButton } from './AccountButton';
import { ContainerButton } from './ContributedViews';

interface ActivityItem {
  id: PrimaryViewId;
  label: string;
  icon: ReactNode;
}

const TOP_ITEMS: ActivityItem[] = [
  { id: 'explorer', label: 'Explorer', icon: <ExplorerIcon /> },
  { id: 'search', label: 'Search', icon: <SearchIcon /> },
  { id: 'semantic', label: 'Semantic Search', icon: <SemanticSearchIcon /> },
  { id: 'scm', label: 'Source Control', icon: <SourceControlIcon /> },
  { id: 'run', label: 'Run and Debug', icon: <RunIcon /> },
  { id: 'languages', label: 'Languages', icon: <PackageIcon size={20} /> },
  { id: 'extensions', label: 'Extensions', icon: <ExtensionsIcon size={20} /> },
  { id: 'intelligence', label: 'Project Intelligence', icon: <IntelligenceIcon /> },
  { id: 'godmode', label: 'God Mode', icon: <GodModeIcon /> },
];

interface ActivityBarProps {
  active: PrimaryViewId | '';
  onChange: (id: PrimaryViewId) => void;
  onOpenSettings: () => void;
  aiPanelVisible: boolean;
  onToggleAi: () => void;
  /**
   * Contributed view containers (PRD Phase 5 §1). Drawn after AXIOM's own entries, in contribution
   * order, so an installed extension appears where VS Code would put it without any of the fixed
   * `PrimaryViewId` list having to change.
   */
  containers?: readonly ContainerSnapshot[];
  activeContainer?: string | null;
  onSelectContainer?: (containerId: string) => void;
}

export function ActivityBar({
  active,
  onChange,
  onOpenSettings,
  aiPanelVisible,
  onToggleAi,
  containers = [],
  activeContainer = null,
  onSelectContainer,
}: ActivityBarProps) {
  const navRef = useRef<HTMLElement | null>(null);

  /**
   * Arrow-key navigation across the whole bar (PRD Phase 5 §12).
   *
   * The buttons are natively focusable, so this only adds the roving movement a toolbar is
   * expected to have: Up/Down step, Home/End jump. Tab still leaves the bar in one press.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const nav = navRef.current;
    if (nav === null) return;
    const items = [...nav.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : current < 0
            ? 0
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  const renderItem = (item: ActivityItem) => (
    <button
      key={item.id}
      type="button"
      className={`activity-item ${active === item.id ? 'active' : ''}`}
      title={item.label}
      aria-label={item.label}
      aria-pressed={active === item.id}
      onClick={() => onChange(item.id)}
    >
      {item.icon}
    </button>
  );

  return (
    <nav className="activitybar" aria-label="Primary activity" ref={navRef} onKeyDown={onKeyDown}>
      {TOP_ITEMS.map(renderItem)}
      {containers.map((container) => (
        <ContainerButton
          key={container.id}
          container={container}
          active={activeContainer === container.id}
          onSelect={() => onSelectContainer?.(container.id)}
        />
      ))}
      <div className="spacer" />
      <button
        type="button"
        className={`activity-item activity-ai ${aiPanelVisible ? 'active' : ''}`}
        title="Toggle Axiom AI"
        aria-label="Toggle Axiom AI dock"
        aria-pressed={aiPanelVisible}
        onClick={onToggleAi}
      >
        <AiIcon />
      </button>
      <AccountButton />
      <button
        type="button"
        className="activity-item"
        title="Settings"
        aria-label="Open Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </button>
    </nav>
  );
}
