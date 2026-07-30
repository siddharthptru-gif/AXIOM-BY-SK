/**
 * Update decision core (Phase 17 / UPDATEFEATURE — Supabase-driven auto-update).
 *
 * PURE module (no I/O, no Electron). It validates backend release metadata and
 * applies downgrade, minimum-version, and mandatory-update policy.
 */

import { compareVersions } from './extensionRegistryIndex';
import { isAllowedUpdateSize, validateUpdateDownloadUrl } from './updateNetwork';

export type UpdateType = 'optional' | 'mandatory';

export interface ReleaseConfig {
  latestVersion: string;
  minimumSupportedVersion: string;
  updateType: UpdateType;
  releaseNotes: string;
  downloadURL: string;
  checksum: string;
  releaseDate: string;
  channel: string;
  sizeBytes?: number;
}

export type UpdateStatus = 'up-to-date' | 'optional' | 'mandatory';

export interface UpdatePlan {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  updateType: UpdateType | null;
  mustBlock: boolean;
  downloadURL: string | null;
  checksum: string | null;
  sizeBytes: number | null;
  releaseNotes: string;
  reason: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function isValidSemver(v: string): boolean {
  return typeof v === 'string' && SEMVER_RE.test(v.trim());
}

function str(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v.trim();
  }
  return '';
}

/**
 * Parse and validate an untrusted release-config payload. A malformed mandatory
 * row cannot place the client into an undownloadable blocking state.
 */
export function parseReleaseConfig(raw: unknown): ReleaseConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const latestVersion = str(o, 'latestVersion', 'latest_version', 'version');
  if (!isValidSemver(latestVersion)) return null;

  const rawDownloadURL = str(o, 'downloadURL', 'download_url', 'url');
  const downloadURL = validateUpdateDownloadUrl(rawDownloadURL);
  const checksum = str(o, 'checksum', 'sha256', 'sha_256').toLowerCase();
  if (!downloadURL || !SHA256_RE.test(checksum)) return null;

  const minRaw = str(o, 'minimumSupportedVersion', 'minimum_supported_version', 'min_version');
  const minimumSupportedVersion = isValidSemver(minRaw) ? minRaw : '0.0.0';
  const typeRaw = str(o, 'updateType', 'update_type').toLowerCase();
  const updateType: UpdateType = typeRaw === 'mandatory' ? 'mandatory' : 'optional';
  const sizeRaw = o['sizeBytes'] ?? o['size_bytes'];
  if (sizeRaw !== undefined && !isAllowedUpdateSize(sizeRaw)) return null;
  const notes = str(o, 'releaseNotes', 'release_notes', 'notes');

  return {
    latestVersion,
    minimumSupportedVersion,
    updateType,
    releaseNotes: notes.slice(0, 8000),
    downloadURL,
    checksum,
    releaseDate: str(o, 'releaseDate', 'release_date'),
    channel: str(o, 'channel') || 'stable',
    ...(sizeRaw !== undefined ? { sizeBytes: sizeRaw } : {}),
  };
}

function upToDate(
  currentVersion: string,
  latestVersion: string | null,
  reason: string,
): UpdatePlan {
  return {
    status: 'up-to-date',
    currentVersion,
    latestVersion,
    updateType: null,
    mustBlock: false,
    downloadURL: null,
    checksum: null,
    sizeBytes: null,
    releaseNotes: '',
    reason,
  };
}

export function decideUpdate(currentVersion: string, config: ReleaseConfig): UpdatePlan {
  const cur = currentVersion.trim();
  if (!isValidSemver(cur)) {
    return upToDate(currentVersion, config.latestVersion, 'Current version is not valid semver.');
  }
  if (compareVersions(config.latestVersion, cur) <= 0) {
    return upToDate(
      cur,
      config.latestVersion,
      `Up to date (current ${cur} ≥ latest ${config.latestVersion}).`,
    );
  }
  const belowMinimum = compareVersions(cur, config.minimumSupportedVersion) < 0;
  const mandatory = config.updateType === 'mandatory' || belowMinimum;
  return {
    status: mandatory ? 'mandatory' : 'optional',
    currentVersion: cur,
    latestVersion: config.latestVersion,
    updateType: mandatory ? 'mandatory' : 'optional',
    mustBlock: mandatory,
    downloadURL: config.downloadURL || null,
    checksum: config.checksum || null,
    sizeBytes: config.sizeBytes ?? null,
    releaseNotes: config.releaseNotes,
    reason: belowMinimum
      ? `Mandatory: ${cur} is below the minimum supported ${config.minimumSupportedVersion}.`
      : mandatory
        ? `Mandatory update ${cur} → ${config.latestVersion}.`
        : `Update available: ${cur} → ${config.latestVersion}.`,
  };
}

export function isDowngrade(currentVersion: string, targetVersion: string): boolean {
  if (!isValidSemver(currentVersion) || !isValidSemver(targetVersion)) return false;
  return compareVersions(targetVersion, currentVersion) <= 0;
}

/** One-line log/telemetry summary of a plan (no URLs or secrets). */
export function describePlan(plan: UpdatePlan): string {
  return `[update] ${plan.status}${plan.mustBlock ? ' (blocking)' : ''} — ${plan.reason}`;
}
