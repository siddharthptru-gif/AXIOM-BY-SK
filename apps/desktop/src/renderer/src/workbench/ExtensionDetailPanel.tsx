import { useEffect, useState } from 'react';
import type {
  RegistryExtensionDetail,
  RegistryReview,
  RegistryVersionRef,
} from '../../../common/openVsx';
import type { InstalledExtensionSummary } from '../../../common/marketplace';
import { DialogFrame } from './Modal';
import { friendlyPoint } from './ExtensionsView';
import {
  VerifiedBadge,
  ExtensionIconImage,
  ExtensionAuthModal,
} from './ExtensionComponents';

/**
 * The extension details panel.
 */
type Tab = 'details' | 'changelog' | 'versions' | 'reviews' | 'contributions';

export function ExtensionDetailPanel({
  id,
  detail,
  reviews,
  installed,
  busy,
  onClose,
  onInstall,
  onUninstall,
}: {
  id: string;
  detail: RegistryExtensionDetail | null;
  reviews: RegistryReview[];
  installed: InstalledExtensionSummary | null;
  busy: 'installing' | 'removing' | 'updating' | null;
  onClose: () => void;
  onInstall: (version?: string) => void;
  onUninstall: () => void;
}) {
  const [tab, setTab] = useState<Tab>('details');
  const [readme, setReadme] = useState<string | null>(null);
  const [changelog, setChangelog] = useState<string | null>(null);
  const [versions, setVersions] = useState<RegistryVersionRef[]>([]);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);

  useEffect(() => {
    setTab('details');
    setReadme(null);
    setChangelog(null);
    setVersions([]);
    setDocumentError(null);
    setShowAuthModal(false);
  }, [id]);

  useEffect(() => {
    if (detail === null) return undefined;
    let cancelled = false;
    if (tab === 'details' && readme === null && detail.files.readme !== null) {
      void window.axiom.market
        .document(detail.files.readme)
        .then((text) => {
          if (!cancelled) setReadme(text);
        })
        .catch((error: unknown) => {
          if (!cancelled) setDocumentError(error instanceof Error ? error.message : String(error));
        });
    }
    if (tab === 'changelog' && changelog === null && detail.files.changelog !== null) {
      void window.axiom.market
        .document(detail.files.changelog)
        .then((text) => {
          if (!cancelled) setChangelog(text);
        })
        .catch((error: unknown) => {
          if (!cancelled) setDocumentError(error instanceof Error ? error.message : String(error));
        });
    }
    if (tab === 'versions' && versions.length === 0) {
      void window.axiom.market
        .versions(id, 0, 25)
        .then((page) => {
          if (!cancelled) setVersions(page.versions);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [tab, detail, id, readme, changelog, versions.length]);

  const title = detail?.displayName ?? installed?.displayName ?? id;
  const publisherName = detail?.publisher?.loginName ?? installed?.publisher ?? '';

  return (
    <DialogFrame
      onClose={onClose}
      overlayClassName="ext-detail-overlay"
      cardClassName="ext-detail-card"
      ariaLabel={`${title} details`}
    >
      <header className="ext-detail-head">
        <span className="ext-detail-icon" aria-hidden="true">
          <ExtensionIconImage
            src={detail?.iconUrl ?? installed?.iconDataUrl}
            name={title}
            id={id}
            size={54}
          />
        </span>
        <div className="ext-detail-identity">
          <strong className="ext-detail-title">{title}</strong>
          <span className="ext-detail-sub">
            {publisherName}
            <VerifiedBadge publisher={publisherName} isVerified={detail?.verified ?? false} />
            {detail !== null ? <span className="ext-version">{detail.version}</span> : null}
            {installed !== null ? (
              <span className={`ext-status-pill ${installed.enabled ? 'is-enabled' : 'is-disabled'}`}>
                {installed.enabled ? '✓ Enabled' : '○ Disabled'}
              </span>
            ) : null}
          </span>
          {detail?.description ? <p className="ext-detail-desc">{detail.description}</p> : null}
        </div>
        <button type="button" className="icon-btn ext-detail-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="ext-detail-actions">
        {installed === null ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null || detail === null || !detail.downloadable}
            onClick={() => onInstall()}
          >
            {busy === 'installing' ? 'Installing…' : 'Install'}
          </button>
        ) : (
          <>
            <span className="ext-detail-installed">Installed {installed.version}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                void window.axiom.market.setEnabled(installed.id, !installed.enabled, 'global', null);
              }}
            >
              {installed.enabled ? 'Disable' : 'Enable'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={onUninstall}>
              {busy === 'removing' ? 'Removing…' : 'Uninstall'}
            </button>
          </>
        )}
        <button
          type="button"
          className="ext-auth-btn"
          onClick={() => setShowAuthModal(true)}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >
          🔐 Extension Sign In / Auth
        </button>
        {detail?.homepage ? (
          <a className="ext-detail-link" href={detail.homepage} target="_blank" rel="noreferrer noopener">
            Homepage
          </a>
        ) : null}
        {detail?.repository ? (
          <a className="ext-detail-link" href={detail.repository} target="_blank" rel="noreferrer noopener">
            Repository
          </a>
        ) : null}
      </div>

      {showAuthModal ? (
        <ExtensionAuthModal
          extensionName={title}
          extensionId={id}
          onClose={() => setShowAuthModal(false)}
        />
      ) : null}

      {installed !== null ? <CapabilitySummary installed={installed} /> : null}

      <div className="ext-detail-tabs" role="tablist" aria-label="Extension information">
        {(
          [
            ['details', 'Details'],
            ['contributions', 'What it adds'],
            ['changelog', 'Changelog'],
            ['versions', 'Versions'],
            ['reviews', `Reviews${reviews.length > 0 ? ` (${reviews.length})` : ''}`],
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`ext-detail-tab ${tab === value ? 'is-active' : ''}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="ext-detail-body">
        {detail === null ? (
          <p className="ext-empty">Loading details…</p>
        ) : tab === 'details' ? (
          <DetailsTab detail={detail} readme={readme} documentError={documentError} />
        ) : tab === 'contributions' ? (
          <ContributionsTab detail={detail} installed={installed} />
        ) : tab === 'changelog' ? (
          <DocumentTab
            text={changelog}
            missing={detail.files.changelog === null}
            documentError={documentError}
            emptyLabel="This extension does not publish a changelog."
          />
        ) : tab === 'versions' ? (
          <VersionsTab
            versions={versions}
            installedVersion={installed?.version ?? null}
            busy={busy !== null}
            onInstall={onInstall}
          />
        ) : (
          <ReviewsTab reviews={reviews} />
        )}
      </div>
    </DialogFrame>
  );
}

/**
 * What this extension actually does in AXIOM.
 *
 * Shown only once installed, because before that it is a claim; afterwards it is a fact
 * read from the package on disk.
 */
function CapabilitySummary({ installed }: { installed: InstalledExtensionSummary }) {
  const { capabilities, integrity, compatibility } = installed;
  return (
    <section className="ext-capability" aria-label="What this extension does here">
      <div className="ext-capability-row">
        <strong>Working</strong>
        <span>
          {capabilities.supported.length === 0
            ? 'Nothing AXIOM can apply yet.'
            : capabilities.supported
                .map((point) => `${point.count} ${friendlyPoint(point.point)}`)
                .join(' · ')}
        </span>
      </div>
      {capabilities.inert.length > 0 ? (
        <div className="ext-capability-row">
          <strong>Inactive</strong>
          <span>
            {capabilities.inert.map((point) => friendlyPoint(point.point)).join(' · ')} — these need
            an extension host, which this build does not run.
          </span>
        </div>
      ) : null}
      <div className="ext-capability-row">
        <strong>Integrity</strong>
        <span>
          {integrity.digestVerified
            ? 'Matched the checksum the registry published.'
            : 'No publisher checksum was available; the package structure was validated.'}
          {integrity.signature === 'present-unverified'
            ? ' A publisher signature is present; AXIOM does not verify its envelope format.'
            : ''}
        </span>
      </div>
      {compatibility.engineSatisfied === null ? (
        <div className="ext-capability-row">
          <strong>Compatibility</strong>
          <span>{compatibility.summary}</span>
        </div>
      ) : null}
    </section>
  );
}

function DetailsTab({
  detail,
  readme,
  documentError,
}: {
  detail: RegistryExtensionDetail;
  readme: string | null;
  documentError: string | null;
}) {
  return (
    <>
      <dl className="ext-facts">
        <div>
          <dt>Publisher</dt>
          <dd>{detail.publisher?.fullName ?? detail.namespace}</dd>
        </div>
        <div>
          <dt>Installs</dt>
          <dd>{detail.downloadCount.toLocaleString()}</dd>
        </div>
        {detail.averageRating !== null && detail.reviewCount > 0 ? (
          <div>
            <dt>Rating</dt>
            <dd>
              {detail.averageRating.toFixed(1)} / 5 · {detail.reviewCount} reviews
            </dd>
          </div>
        ) : null}
        {detail.license !== null ? (
          <div>
            <dt>License</dt>
            <dd>{detail.license}</dd>
          </div>
        ) : null}
        {detail.publishedAt !== null ? (
          <div>
            <dt>Published</dt>
            <dd>{new Date(detail.publishedAt).toLocaleDateString()}</dd>
          </div>
        ) : null}
        {detail.engines.vscode !== undefined ? (
          <div>
            <dt>Editor API</dt>
            <dd>
              <code>{detail.engines.vscode}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      {detail.categories.length > 0 ? (
        <div className="ext-chips" aria-label="Categories">
          {detail.categories.map((category) => (
            <span key={category} className="ext-chip">
              {category}
            </span>
          ))}
        </div>
      ) : null}
      {detail.dependencies.length > 0 ? (
        <p className="ext-detail-note">
          Requires {detail.dependencies.join(', ')} — AXIOM installs these automatically.
        </p>
      ) : null}
      {detail.deprecated ? (
        <p className="ext-detail-note ext-detail-warn">
          The publisher has marked this extension deprecated
          {detail.replacementId !== null ? `, replaced by ${detail.replacementId}` : ''}.
        </p>
      ) : null}
      <DocumentTab
        text={readme}
        missing={detail.files.readme === null}
        documentError={documentError}
        emptyLabel="This extension does not publish a readme."
      />
    </>
  );
}

/**
 * Registry markdown, rendered as preformatted text.
 *
 * Not converted to HTML on purpose: this is untrusted third-party content, and the
 * formatting gained is not worth giving every publisher in the registry a path into the
 * renderer's DOM.
 */
function DocumentTab({
  text,
  missing,
  documentError,
  emptyLabel,
}: {
  text: string | null;
  missing: boolean;
  documentError: string | null;
  emptyLabel: string;
}) {
  if (missing) return <p className="ext-empty">{emptyLabel}</p>;
  if (documentError !== null) return <p className="ext-empty">Could not load: {documentError}</p>;
  if (text === null) return <p className="ext-empty">Loading…</p>;
  return <pre className="ext-document">{text}</pre>;
}

function ContributionsTab({
  detail,
  installed,
}: {
  detail: RegistryExtensionDetail;
  installed: InstalledExtensionSummary | null;
}) {
  if (installed === null) {
    return (
      <p className="ext-empty">
        Install {detail.displayName} to see exactly what it contributes. AXIOM reads that from the
        package itself rather than from the registry listing.
      </p>
    );
  }
  return (
    <div className="ext-contributions">
      <h4>Applied by AXIOM</h4>
      {installed.capabilities.supported.length === 0 ? (
        <p className="ext-empty">Nothing this build can apply.</p>
      ) : (
        <ul>
          {installed.capabilities.supported.map((point) => (
            <li key={point.point}>
              <strong>{point.count}</strong> {friendlyPoint(point.point)}
            </li>
          ))}
        </ul>
      )}
      <h4>Declared but not active</h4>
      {installed.capabilities.inert.length === 0 ? (
        <p className="ext-empty">Nothing — everything this extension declares is applied.</p>
      ) : (
        <>
          <ul>
            {installed.capabilities.inert.map((point) => (
              <li key={point.point}>{friendlyPoint(point.point)}</li>
            ))}
          </ul>
          <p className="ext-detail-note">
            {installed.capabilities.activation === 'requires-host'
              ? 'This extension ships code. AXIOM installs and reads its declarative contributions but never runs that code, so anything driven by it stays inactive.'
              : 'These contribution points are not modelled by this build.'}
          </p>
        </>
      )}
    </div>
  );
}

function VersionsTab({
  versions,
  installedVersion,
  busy,
  onInstall,
}: {
  versions: RegistryVersionRef[];
  installedVersion: string | null;
  busy: boolean;
  onInstall: (version: string) => void;
}) {
  if (versions.length === 0) return <p className="ext-empty">Loading version history…</p>;
  return (
    <table className="ext-versions">
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">Editor API</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {versions.map((version) => (
          <tr key={`${version.version}-${version.targetPlatform ?? 'universal'}`}>
            <td>
              <code>{version.version}</code>
              {version.version === installedVersion ? (
                <span className="ext-flag ext-flag-quiet">installed</span>
              ) : null}
            </td>
            <td>{version.engines.vscode ?? '—'}</td>
            <td>
              <button
                type="button"
                className="btn btn-ghost ext-btn ext-btn-quiet"
                disabled={busy || version.version === installedVersion}
                onClick={() => onInstall(version.version)}
              >
                Install
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReviewsTab({ reviews }: { reviews: RegistryReview[] }) {
  if (reviews.length === 0) {
    return <p className="ext-empty">No reviews have been published for this extension.</p>;
  }
  return (
    <ul className="ext-reviews">
      {reviews.map((review, index) => (
        <li key={`${review.author}-${index}`} className="ext-review">
          <div className="ext-review-head">
            <strong>{review.author}</strong>
            <span className="ext-review-stars" aria-label={`${review.rating} of 5`}>
              {'★'.repeat(Math.round(review.rating))}
              <span className="ext-review-dim">{'★'.repeat(5 - Math.round(review.rating))}</span>
            </span>
            {review.postedAt !== null ? (
              <span className="ext-review-date">
                {new Date(review.postedAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>
          {review.comment !== null ? <p className="ext-review-body">{review.comment}</p> : null}
        </li>
      ))}
    </ul>
  );
}
