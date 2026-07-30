import type { PrimaryViewId } from '../state/layout';
import { useWorkspace } from '../state/workspace';
import { FileTree } from './FileTree';
import { OpenEditors } from './OpenEditors';
import { OutlineView } from './OutlineView';
import { SearchView } from './SearchView';
import { SemanticSearchView } from './SemanticSearchView';
import { ScmView } from './ScmView';
import { RunView } from './RunView';
import { LanguagesView } from './LanguagesView';
import { ExtensionsView } from './ExtensionsView';
import { ProjectIntelligenceView } from './ProjectIntelligenceView';
import { GodModeView } from './GodModeView';
import { ContributedSections } from './ContributedViews';

const TITLES: Record<PrimaryViewId, string> = {
  explorer: 'Explorer',
  search: 'Search',
  semantic: 'Semantic Search',
  scm: 'Source Control',
  run: 'Run and Debug',
  languages: 'Languages',
  extensions: 'Extensions',
  intelligence: 'Project Intelligence',
  godmode: 'God Mode',
};

function ExplorerView() {
  const { rootPath, rootName, openFolder } = useWorkspace();
  return (
    <div className="explorer">
      <OpenEditors />
      {rootPath ? (
        <FileTree rootPath={rootPath} rootName={rootName ?? rootPath} />
      ) : (
        <div className="empty-state explorer-empty">
          <span className="empty-state-eyebrow">Workspace</span>
          <strong>No folder open</strong>
          <p>Open a local project to browse files, search code, and use project intelligence.</p>
          <button className="btn btn-primary" type="button" onClick={() => void openFolder()}>
            Open Folder
          </button>
        </div>
      )}
      <OutlineView />
    </div>
  );
}

export function PrimarySidebar({ view, width }: { view: PrimaryViewId; width?: number }) {
  const title = TITLES[view];
  return (
    <aside
      className={`sidebar sidebar-${view}`}
      aria-label={title}
      style={width ? { width } : undefined}
    >
      <div className="sidebar-header">
        <span>{title}</span>
      </div>
      <div className="sidebar-body">
        {view === 'explorer' ? (
          <ExplorerView />
        ) : view === 'search' ? (
          <SearchView />
        ) : view === 'semantic' ? (
          <SemanticSearchView />
        ) : view === 'scm' ? (
          <ScmView />
        ) : view === 'run' ? (
          <RunView />
        ) : view === 'languages' ? (
          <LanguagesView />
        ) : view === 'extensions' ? (
          <ExtensionsView />
        ) : view === 'intelligence' ? (
          <ProjectIntelligenceView />
        ) : (
          <GodModeView />
        )}
        {/*
          Views an extension contributed into this built-in container (PRD Phase 5 §2). Appended
          below the existing content, so nothing above it moves and a sidebar nobody contributed to
          renders nothing at all.
        */}
        <ContributedSections sidebar={view} />
      </div>
    </aside>
  );
}
