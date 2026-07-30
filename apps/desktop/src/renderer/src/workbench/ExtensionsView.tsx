import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RegistryExtensionDetail,
  RegistryExtensionSummary,
  RegistryReview,
  RegistrySortBy,
} from '../../../common/openVsx';
import { REGISTRY_CATEGORIES } from '../../../common/openVsx';
import type { InstalledExtensionSummary, ManagerView } from '../../../common/marketplace';
import { selectInstalled } from '../../../common/marketplace';
import { compareVersions } from '../../../common/extensionRegistryIndex';
import { useWorkspace } from '../state/workspace';
import { notifyInfo } from '../notifications/bus';
import { SearchIcon } from './icons';
import { ExtensionDetailPanel } from './ExtensionDetailPanel';
import { ContributedAppearance } from './ContributedAppearance';
import { ExtensionHostPanel } from './ExtensionHostPanel';
import {
  VerifiedBadge,
  ExtensionIconImage,
  ExtensionAuthModal,
} from './ExtensionComponents';

/**
 * The Extensions manager.
 *
 * Views split into two kinds, and the split is load-bearing rather than cosmetic:
 * Installed / Enabled / Disabled / Updates are answered entirely from local state and
 * work with no connection, while Search / Popular / Recently Updated / Recommended query
 * Open VSX. That means the manager stays useful offline — you can still see, disable and
 * remove what you have — instead of showing a spinner or an error where your extensions
 * used to be.
 *
 * The one thing this UI insists on saying out loud: for each installed extension, what
 * actually works. An extension that ships a colour theme and twenty commands contributes
 * a working theme and twenty commands that cannot run, because running them needs an
 * extension host that this build does not have. Showing the theme and quietly listing the
 * commands as though they were live would be the easy choice and a dishonest one.
 */
const REGISTRY_VIEWS: Array<{ id: ManagerView; label: string; sortBy: RegistrySortBy }> = [
  { id: 'search', label: 'Search', sortBy: 'relevance' },
  { id: 'popular', label: 'Popular', sortBy: 'downloadCount' },
  { id: 'recently-updated', label: 'Recently Updated', sortBy: 'timestamp' },
  { id: 'recommended', label: 'Recommended', sortBy: 'relevance' },
];

const LOCAL_VIEWS: Array<{ id: ManagerView; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'enabled', label: 'Enabled' },
  { id: 'disabled', label: 'Disabled' },
  { id: 'updates', label: 'Updates' },
];

type Busy = { id: string; action: 'installing' | 'removing' | 'updating' } | null;

export function ExtensionsView() {
  const { rootPath } = useWorkspace();
  const [view, setView] = useState<ManagerView>('installed');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [installed, setInstalled] = useState<InstalledExtensionSummary[]>([]);
  const [results, setResults] = useState<RegistryExtensionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RegistryExtensionDetail | null>(null);
  const [reviews, setReviews] = useState<RegistryReview[]>([]);
  const [autoUpdateAll, setAutoUpdateAllState] = useState(true);

  const reloadInstalled = useCallback(async () => {
    try {
      setInstalled(await window.axiom.market.installed(rootPath ?? null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [rootPath]);

  useEffect(() => {
    void reloadInstalled();
    // Any window can install or disable something; re-reading on the broadcast keeps
    // this list from drifting rather than trying to apply a diff.
    return window.axiom.market.onChanged(() => void reloadInstalled());
  }, [reloadInstalled]);

  useEffect(() => {
    let cancelled = false;
    void window.axiom.market
      .reachable()
      .then((value) => {
        if (!cancelled) setReachable(value);
      })
      .catch(() => {
        if (!cancelled) setReachable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Registry views are debounced: typing a query should not fire a request per keystroke.
  const requestId = useRef(0);
  useEffect(() => {
    const registryView = REGISTRY_VIEWS.find((entry) => entry.id === view);
    if (!registryView) return undefined;
    const current = ++requestId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const search =
        registryView.id === 'recommended'
          ? recommendationQuery(installed)
          : query.trim();
      void window.axiom.market
        .browse({
          ...(search !== '' ? { query: search } : {}),
          ...(category !== '' ? { category } : {}),
          sortBy: registryView.sortBy,
          sortOrder: 'desc',
          size: 24,
        })
        .then((page) => {
          if (current !== requestId.current) return;
          setResults(page.extensions);
          setTotal(page.totalSize);
          setError(null);
        })
        .catch((browseError: unknown) => {
          if (current !== requestId.current) return;
          setResults([]);
          setError(browseError instanceof Error ? browseError.message : String(browseError));
        })
        .finally(() => {
          if (current === requestId.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [view, query, category, installed]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      setReviews([]);
      return undefined;
    }
    let cancelled = false;
    void Promise.all([
      window.axiom.market.detail(selected),
      window.axiom.market.reviews(selected).catch(() => [] as RegistryReview[]),
    ])
      .then(([detailResult, reviewResult]) => {
        if (cancelled) return;
        setDetail(detailResult);
        setReviews(reviewResult);
      })
      .catch((detailError: unknown) => {
        if (cancelled) return;
        setDetail(null);
        setError(detailError instanceof Error ? detailError.message : String(detailError));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const installedById = useMemo(
    () => new Map(installed.map((extension) => [extension.id, extension])),
    [installed],
  );

  const updatable = useMemo(
    () =>
      installed.filter(
        (extension) =>
          extension.latestVersion !== null &&
          compareVersions(extension.latestVersion, extension.version) > 0,
      ),
    [installed],
  );

  const run = useCallback(
    async (id: string, action: NonNullable<Busy>['action'], operation: () => Promise<string | null>) => {
      setBusy({ id, action });
      setError(null);
      setMessage(null);
      try {
        const outcome = await operation();
        if (outcome !== null) setMessage(outcome);
        await reloadInstalled();
      } catch (operationError) {
        setError(operationError instanceof Error ? operationError.message : String(operationError));
      } finally {
        setBusy(null);
      }
    },
    [reloadInstalled],
  );

  const install = useCallback(
    (id: string, version?: string) =>
      run(id, 'installing', async () => {
        const outcome = await window.axiom.market.install(id, version);
        const extras =
          outcome.alsoInstalled.length > 0
            ? ` Also installed ${outcome.alsoInstalled.length} dependency${outcome.alsoInstalled.length === 1 ? '' : 'ies'}.`
            : '';
        return `${outcome.displayName} ${outcome.upgraded ? 'updated to' : 'installed at'} ${outcome.version}. ${outcome.integritySummary}${extras}`;
      }),
    [run],
  );

  const uninstall = useCallback(
    (id: string, displayName: string) =>
      run(id, 'removing', async () => {
        await window.axiom.market.uninstall(id);
        if (selected === id) setSelected(null);
        return `${displayName} removed.`;
      }),
    [run, selected],
  );

  const toggleEnabled = useCallback(
    (extension: InstalledExtensionSummary, target: 'global' | 'workspace') =>
      run(extension.id, 'updating', async () => {
        await window.axiom.market.setEnabled(
          extension.id,
          !extension.enabled,
          target,
          rootPath ?? null,
        );
        return null;
      }),
    [run, rootPath],
  );

  const checkUpdates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const plan = await window.axiom.market.checkUpdates(true);
      await reloadInstalled();
      setMessage(
        plan.length === 0
          ? 'Every extension is up to date.'
          : `${plan.length} update${plan.length === 1 ? '' : 's'} available.`,
      );
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setLoading(false);
    }
  }, [reloadInstalled]);

  const updateAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const outcome = await window.axiom.market.updateAll();
      await reloadInstalled();
      const parts = [`Updated ${outcome.updated.length}`];
      if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`);
      if (outcome.skipped.length > 0) parts.push(`${outcome.skipped.length} skipped`);
      setMessage(`${parts.join(', ')}.`);
      if (outcome.failed.length > 0) setError(outcome.failed.join(' · '));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setLoading(false);
    }
  }, [reloadInstalled]);

  const installFromFile = useCallback(async () => {
    setError(null);
    setMessage(null);
    try {
      const outcome = await window.axiom.market.installFromFile();
      if (outcome === null) return;
      await reloadInstalled();
      setMessage(`${outcome.displayName} ${outcome.version} installed. ${outcome.integritySummary}`);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : String(fileError));
    }
  }, [reloadInstalled]);

  const localList = selectInstalled(installed, view, query);
  const showingRegistry = REGISTRY_VIEWS.some((entry) => entry.id === view);

  return (
    <div className="ext-view">
      <div className="ext-search">
        <SearchIcon size={14} />
        <input
          type="search"
          className="ext-search-input"
          placeholder={showingRegistry ? 'Search Open VSX…' : 'Filter installed…'}
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={showingRegistry ? 'Search the extension registry' : 'Filter installed extensions'}
        />
      </div>

      <div className="ext-tabs" role="tablist" aria-label="Extension views">
        {[...LOCAL_VIEWS, ...REGISTRY_VIEWS].map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            className={`ext-tab ${view === entry.id ? 'is-active' : ''}`}
            onClick={() => setView(entry.id)}
          >
            {entry.label}
            {entry.id === 'updates' && updatable.length > 0 ? (
              <span className="ext-badge">{updatable.length}</span>
            ) : null}
            {entry.id === 'installed' && installed.length > 0 ? (
              <span className="ext-badge ext-badge-quiet">{installed.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {showingRegistry ? (
        <div className="ext-filters">
          <select
            className="ext-select"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {REGISTRY_CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {total > 0 ? <span className="ext-count">{total.toLocaleString()} found</span> : null}
        </div>
      ) : (
        <div className="ext-actions">
          <button type="button" className="btn btn-ghost ext-action" onClick={() => void checkUpdates()}>
            Check for Updates
          </button>
          <button
            type="button"
            className="btn btn-ghost ext-action"
            disabled={updatable.length === 0 || loading}
            onClick={() => void updateAll()}
          >
            Update All
          </button>
          <button type="button" className="btn btn-ghost ext-action" onClick={() => void installFromFile()}>
            Install from VSIX…
          </button>
          <label className="ext-toggle">
            <input
              type="checkbox"
              checked={autoUpdateAll}
              onChange={(event) => {
                setAutoUpdateAllState(event.target.checked);
                void window.axiom.market.setAutoUpdateAll(event.target.checked);
              }}
            />
            <span>Automatic updates</span>
          </label>
        </div>
      )}

      {showingRegistry ? null : (
        <>
          <ExtensionHostPanel />
          <ContributedAppearance />
        </>
      )}

      {reachable === false && showingRegistry ? (
        <div className="ext-notice" role="status">
          The extension registry is unreachable. Installed extensions still work — browsing and
          updating need a connection.
        </div>
      ) : null}
      {message !== null ? (
        <div className="ext-notice ext-notice-good" role="status">
          {message}
        </div>
      ) : null}
      {error !== null ? (
        <div className="ext-notice ext-notice-bad" role="alert">
          {error}
        </div>
      ) : null}

      <div className="ext-list">
        {showingRegistry ? (
          loading && results.length === 0 ? (
            <p className="ext-empty">Searching…</p>
          ) : results.length === 0 ? (
            <p className="ext-empty">
              {reachable === false ? 'No results while offline.' : 'Nothing matched that search.'}
            </p>
          ) : (
            results.map((entry) => (
              <RegistryRow
                key={entry.id}
                entry={entry}
                installed={installedById.get(entry.id)}
                busy={busy?.id === entry.id ? busy.action : null}
                onOpen={() => setSelected(entry.id)}
                onInstall={() => void install(entry.id)}
                onUninstall={() => void uninstall(entry.id, entry.displayName)}
              />
            ))
          )
        ) : localList.length === 0 ? (
          <p className="ext-empty">
            {view === 'updates'
              ? 'Everything is up to date.'
              : installed.length === 0
                ? 'No extensions installed yet. Try Popular to find some.'
                : 'Nothing matched that filter.'}
          </p>
        ) : (
          localList.map((extension) => (
            <InstalledRow
              key={extension.id}
              extension={extension}
              hasWorkspace={rootPath !== null}
              busy={busy?.id === extension.id ? busy.action : null}
              onOpen={() => setSelected(extension.id)}
              onToggle={(target) => void toggleEnabled(extension, target)}
              onUpdate={() => void install(extension.id)}
              onUninstall={() => void uninstall(extension.id, extension.displayName)}
            />
          ))
        )}
      </div>

      {selected !== null ? (
        <ExtensionDetailPanel
          id={selected}
          detail={detail}
          reviews={reviews}
          installed={installedById.get(selected) ?? null}
          busy={busy?.id === selected ? busy.action : null}
          onClose={() => setSelected(null)}
          onInstall={(version) => void install(selected, version)}
          onUninstall={() => void uninstall(selected, detail?.displayName ?? selected)}
        />
      ) : null}
    </div>
  );
}

/**
 * A search term for the Recommended view, derived from the categories of what is already
 * installed.
 *
 * The registry exposes no recommendation API. Rather than inventing a ranking and
 * presenting it as authoritative, this reuses the user's own installed categories as a
 * query and the tab is labelled as a suggestion, not an endorsement.
 */
function recommendationQuery(installed: readonly InstalledExtensionSummary[]): string {
  const counts = new Map<string, number>();
  for (const extension of installed) {
    for (const category of extension.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? '';
}

function DownloadCount({ value }: { value: number }) {
  const label =
    value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1_000
        ? `${Math.round(value / 1_000)}K`
        : String(value);
  return <span className="ext-metric">{label} installs</span>;
}

function Rating({ value, count }: { value: number | null; count: number }) {
  if (value === null || count === 0) return null;
  return (
    <span className="ext-metric" title={`${value.toFixed(1)} of 5 from ${count} reviews`}>
      ★ {value.toFixed(1)}
    </span>
  );
}

function RegistryRow({
  entry,
  installed,
  busy,
  onOpen,
  onInstall,
  onUninstall,
}: {
  entry: RegistryExtensionSummary;
  installed: InstalledExtensionSummary | undefined;
  busy: NonNullable<Busy>['action'] | null;
  onOpen: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const outdated =
    installed !== undefined && compareVersions(entry.version, installed.version) > 0;
  return (
    <div className={`ext-row ${entry.deprecated ? 'is-deprecated' : ''}`}>
      <button type="button" className="ext-row-main" onClick={onOpen}>
        <span className="ext-icon" aria-hidden="true">
          <ExtensionIconImage src={entry.iconUrl} name={entry.displayName} id={entry.id} size={32} />
        </span>
        <span className="ext-row-text">
          <span className="ext-row-title">
            <strong>{entry.displayName}</strong>
            <VerifiedBadge publisher={entry.namespace} isVerified={entry.verified} />
            <span className="ext-version">{entry.version}</span>
          </span>
          <span className="ext-row-desc">{entry.description ?? 'No description provided.'}</span>
          <span className="ext-row-meta">
            <span className="ext-publisher">{entry.namespace}</span>
            <DownloadCount value={entry.downloadCount} />
            <Rating value={entry.averageRating} count={entry.reviewCount} />
            {entry.deprecated ? <span className="ext-flag">Deprecated</span> : null}
          </span>
        </span>
      </button>
      <div className="ext-row-actions">
        {installed === undefined ? (
          <button
            type="button"
            className="btn btn-primary ext-btn"
            disabled={busy !== null}
            onClick={onInstall}
          >
            {busy === 'installing' ? 'Installing…' : 'Install'}
          </button>
        ) : outdated ? (
          <button
            type="button"
            className="btn btn-primary ext-btn"
            disabled={busy !== null}
            onClick={onInstall}
          >
            {busy === 'installing' ? 'Updating…' : 'Update'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost ext-btn"
            disabled={busy !== null}
            onClick={onUninstall}
          >
            {busy === 'removing' ? 'Removing…' : 'Uninstall'}
          </button>
        )}
      </div>
    </div>
  );
}

function InstalledRow({
  extension,
  hasWorkspace,
  busy,
  onOpen,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  extension: InstalledExtensionSummary;
  hasWorkspace: boolean;
  busy: NonNullable<Busy>['action'] | null;
  onOpen: () => void;
  onToggle: (target: 'global' | 'workspace') => void;
  onUpdate: () => void;
  onUninstall: () => void;
}) {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const outdated =
    extension.latestVersion !== null &&
    compareVersions(extension.latestVersion, extension.version) > 0;
  const working = extension.capabilities.supported;
  const inert = extension.capabilities.inert;
  return (
    <div className={`ext-row ${extension.enabled ? '' : 'is-disabled'}`}>
      <button type="button" className="ext-row-main" onClick={onOpen}>
        <span className="ext-icon" aria-hidden="true">
          <ExtensionIconImage src={extension.iconDataUrl} name={extension.displayName} id={extension.id} size={32} />
        </span>
        <span className="ext-row-text">
          <span className="ext-row-title">
            <strong>{extension.displayName}</strong>
            <VerifiedBadge publisher={extension.publisher} />
            <span className="ext-version">{extension.version}</span>
            {outdated ? <span className="ext-flag ext-flag-update">→ {extension.latestVersion}</span> : null}
            <span className={`ext-status-pill ${extension.enabled ? 'is-enabled' : 'is-disabled'}`}>
              {extension.enabled ? '✓ Enabled' : '○ Disabled'}
            </span>
          </span>
          <span className="ext-row-desc">{extension.description ?? 'No description provided.'}</span>
          <span className="ext-row-meta">
            <span className="ext-publisher">{extension.publisher}</span>
            {working.length > 0 ? (
              <span className="ext-metric ext-metric-good">
                {working.map((point) => `${point.count} ${friendlyPoint(point.point)}`).join(', ')}
              </span>
            ) : (
              <span className="ext-metric">Nothing AXIOM can apply yet</span>
            )}
            {extension.missingDependencies.length > 0 ? (
              <span className="ext-flag ext-flag-warn">
                Missing {extension.missingDependencies.length} dependency
              </span>
            ) : null}
          </span>
          {inert.length > 0 ? (
            <span className="ext-row-inert">
              Needs the extension host: {inert.map((point) => friendlyPoint(point.point)).join(', ')}
            </span>
          ) : null}
        </span>
      </button>
      <div className="ext-row-actions">
        {outdated ? (
          <button
            type="button"
            className="btn btn-primary ext-btn"
            disabled={busy !== null}
            onClick={onUpdate}
          >
            {busy === 'installing' ? 'Updating…' : 'Update'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary ext-btn"
          disabled={busy !== null}
          onClick={() => {
            void window.axiom.market.setEnabled(extension.id, true, 'global', null);
            notifyInfo(`Extension Running: ${extension.displayName}`, {
              source: 'Extensions',
              detail: `${extension.displayName} (${extension.id}) is active and integrated with AXIOM.`,
            });
          }}
          title="Run and activate this extension in AXIOM"
        >
          ▶ Run
        </button>
        <button
          type="button"
          className="btn btn-ghost ext-btn"
          disabled={busy !== null}
          onClick={() => setShowAuthModal(true)}
          title="Sign in / authenticate for this extension"
        >
          🔑 Sign In
        </button>
        <button
          type="button"
          className="btn btn-ghost ext-btn"
          disabled={busy !== null}
          onClick={() => onToggle('global')}
        >
          {extension.enabled ? 'Disable' : 'Enable'}
        </button>
        {hasWorkspace ? (
          <button
            type="button"
            className="btn btn-ghost ext-btn ext-btn-quiet"
            disabled={busy !== null}
            onClick={() => onToggle('workspace')}
            title="Change this extension for the open folder only"
          >
            {extension.enablementScope === 'workspace' && !extension.enabled
              ? 'Enable here'
              : 'Disable here'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost ext-btn"
          disabled={busy !== null}
          onClick={onUninstall}
        >
          {busy === 'removing' ? 'Removing…' : 'Uninstall'}
        </button>
      </div>

      {showAuthModal ? (
        <ExtensionAuthModal
          extensionName={extension.displayName}
          extensionId={extension.id}
          onClose={() => setShowAuthModal(false)}
        />
      ) : null}
    </div>
  );
}

/** Contribution point names, in words a user would use. */
export function friendlyPoint(point: string): string {
  switch (point) {
    case 'themes':
      return 'colour themes';
    case 'iconThemes':
      return 'icon themes';
    case 'productIconThemes':
      return 'product icons';
    case 'snippets':
      return 'snippet sets';
    case 'keybindings':
      return 'keybindings';
    case 'languages':
      return 'languages';
    case 'grammars':
      return 'grammars';
    case 'configuration':
      return 'settings';
    case 'configurationDefaults':
      return 'setting defaults';
    case 'jsonValidation':
      return 'JSON schemas';
    case 'commands':
      return 'commands';
    default:
      return point;
  }
}
