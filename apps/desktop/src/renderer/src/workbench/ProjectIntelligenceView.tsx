import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { DependenciesView } from './DependenciesView';
import { CallHierarchyView } from './CallHierarchyView';
import { HierarchyView } from './HierarchyView';
import { RepoTourView } from './RepoTourView';
import { MemoryView } from './MemoryView';
import { RulesView } from './RulesView';
import { PromptsView } from './PromptsView';
import { TasksView } from './TasksView';
import { WorkflowsView } from './WorkflowsView';
import { McpView } from './McpView';
import { ExperimentsView } from './ExperimentsView';
import { ReviewView } from './ReviewView';
import { AuditView } from './AuditView';
import { PerformanceView } from './PerformanceView';
import { SecurityView } from './SecurityView';
import { A11yAuditView } from './A11yAuditView';
import { CheckpointsView } from './CheckpointsView';
import {
  setProjectIntelligenceListener,
  type ProjectIntelligenceCategory,
} from './projectIntelligenceBus';

interface CategoryDefinition {
  id: ProjectIntelligenceCategory;
  label: string;
  description: string;
  tools: string;
  render: () => ReactNode;
}

const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'understand',
    label: 'Understand',
    description: 'Architecture and impact',
    tools: 'Dependencies · Call Hierarchy · Type Hierarchy · Repo Tour',
    render: () => (
      <>
        <DependenciesView />
        <CallHierarchyView />
        <HierarchyView />
        <RepoTourView />
      </>
    ),
  },
  {
    id: 'context',
    label: 'Context',
    description: 'Ground AI behavior',
    tools: 'Memory · Rules · Prompts',
    render: () => (
      <>
        <MemoryView />
        <RulesView />
        <PromptsView />
      </>
    ),
  },
  {
    id: 'automate',
    label: 'Automate',
    description: 'Runs and integrations',
    tools: 'Tasks · Workflows · MCP · Experiments',
    render: () => (
      <>
        <TasksView />
        <WorkflowsView />
        <McpView />
        <ExperimentsView />
      </>
    ),
  },
  {
    id: 'assure',
    label: 'Assure',
    description: 'Review and quality',
    tools: 'Review · Audit · Performance · Security · Accessibility',
    render: () => (
      <>
        <ReviewView />
        <AuditView />
        <PerformanceView />
        <SecurityView />
        <A11yAuditView />
      </>
    ),
  },
  {
    id: 'recover',
    label: 'Recover',
    description: 'Inspect and restore',
    tools: 'Checkpoints · Hunk restore',
    render: () => <CheckpointsView />,
  },
];

/**
 * Stable home for advanced project tools. Categories mount on first activation,
 * then remain mounted while hidden so state is preserved without eagerly starting
 * every listener, index read, and history renderer at sidebar startup.
 */
export function ProjectIntelligenceView() {
  const [active, setActive] = useState<ProjectIntelligenceCategory>('understand');
  const [mountedCategories, setMountedCategories] = useState<
    ReadonlySet<ProjectIntelligenceCategory>
  >(() => new Set(['understand']));
  const panelPrefix = useId();

  const activateCategory = useCallback((category: ProjectIntelligenceCategory): void => {
    setMountedCategories((current) => {
      if (current.has(category)) return current;
      const next = new Set(current);
      next.add(category);
      return next;
    });
    setActive(category);
  }, []);

  useEffect(() => setProjectIntelligenceListener(activateCategory), [activateCategory]);

  const focusCategory = (index: number): void => {
    const category = CATEGORIES[index];
    if (!category) return;
    activateCategory(category.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`${panelPrefix}-tab-${category.id}`)?.focus();
    });
  };

  const current = CATEGORIES.find((category) => category.id === active) ?? CATEGORIES[0];

  return (
    <div className="project-intelligence">
      <div className="pi-intro">
        <span className="pi-eyebrow">Local project intelligence</span>
        <p>Understand, automate, assure, and recover without cluttering Explorer.</p>
      </div>
      <div className="pi-category-list" role="tablist" aria-label="Project Intelligence category">
        {CATEGORIES.map((category, index) => {
          const selected = category.id === active;
          const tabId = `${panelPrefix}-tab-${category.id}`;
          const panelId = `${panelPrefix}-panel-${category.id}`;
          return (
            <button
              key={category.id}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={`pi-category-button ${selected ? 'active' : ''}`}
              onClick={() => activateCategory(category.id)}
              onKeyDown={(event) => {
                let nextIndex: number;
                switch (event.key) {
                  case 'ArrowLeft':
                  case 'ArrowUp':
                    nextIndex = (index - 1 + CATEGORIES.length) % CATEGORIES.length;
                    break;
                  case 'ArrowRight':
                  case 'ArrowDown':
                    nextIndex = (index + 1) % CATEGORIES.length;
                    break;
                  case 'Home':
                    nextIndex = 0;
                    break;
                  case 'End':
                    nextIndex = CATEGORIES.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                focusCategory(nextIndex);
              }}
            >
              <span className="pi-category-label">{category.label}</span>
              <span className="pi-category-description">{category.description}</span>
            </button>
          );
        })}
      </div>
      {current ? (
        <div className="pi-current-summary" aria-live="polite">
          <span>{current.label}</span>
          <small>{current.tools}</small>
        </div>
      ) : null}
      <div className="pi-category-panels">
        {CATEGORIES.map((category) => (
          <section
            key={category.id}
            id={`${panelPrefix}-panel-${category.id}`}
            role="tabpanel"
            aria-labelledby={`${panelPrefix}-tab-${category.id}`}
            hidden={category.id !== active}
            className="pi-category-panel"
          >
            {mountedCategories.has(category.id) ? category.render() : null}
          </section>
        ))}
      </div>
    </div>
  );
}
