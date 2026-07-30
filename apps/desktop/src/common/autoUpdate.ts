import { compareVersions } from './extensionRegistryIndex';

/**
 * Auto-update client core (PRD Epoch A §86 / Phase 17 — dev feed). Pure, I/O-free
 * update logic: given the current version + release channel and a release feed,
 * decide whether an update is available (channel-aware), verify a downloaded
 * artifact against its expected sha256 + size before applying (INV — never apply
 * an unverified update), decide the restart plan, and back off the periodic check
 * on repeated failures. Smoke-tested; the Main service reads the dev feed +
 * app version and performs the download/apply. Honest scope: staged rollout,
 * rollback, and delta updates are deferred to Epoch J; the download/apply +
 * signing happen on a real machine with a real feed.
 */

export type UpdateChannel = 'stable' | 'beta' | 'alpha' | 'dev';

/** Stability rank — a user accepts releases at their rank or more stable. */
const CHANNEL_RANK: Record<UpdateChannel, number> = { stable: 0, beta: 1, alpha: 2, dev: 3 };

export interface ReleaseInfo {
  version: string;
  channel: UpdateChannel;
  url: string;
  /** Expected SHA-256 of the artifact (hex). */
  sha256: string;
  sizeBytes?: number;
  notes?: string;
  /** A mandatory update is applied + restarted rather than prompted. */
  mandatory?: boolean;
}

export type UpdateStatus = 'up-to-date' | 'available' | 'mandatory';

export interface UpdateDecision {
  status: UpdateStatus;
  targetVersion: string | null;
  channel: UpdateChannel;
  url: string | null;
  mandatory: boolean;
  reason: string;
}

/** A user on `userChannel` accepts a release on `releaseChannel` (same or stabler). */
function accepts(userChannel: UpdateChannel, releaseChannel: UpdateChannel): boolean {
  return CHANNEL_RANK[releaseChannel] <= CHANNEL_RANK[userChannel];
}

/**
 * Decide whether an update is available for the current version + channel: pick the
 * highest-version release the channel accepts and compare it to the current version.
 * Never offers a downgrade or a same-version "update".
 */
export function evaluateUpdate(
  currentVersion: string,
  currentChannel: UpdateChannel,
  releases: readonly ReleaseInfo[],
): UpdateDecision {
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    if (!accepts(currentChannel, r.channel)) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = r;
  }
  if (!best) {
    return {
      status: 'up-to-date',
      targetVersion: null,
      channel: currentChannel,
      url: null,
      mandatory: false,
      reason: 'No release available for this channel.',
    };
  }
  if (compareVersions(best.version, currentVersion) <= 0) {
    return {
      status: 'up-to-date',
      targetVersion: best.version,
      channel: currentChannel,
      url: null,
      mandatory: false,
      reason: `Up to date (current ${currentVersion} \u2265 latest ${best.version}).`,
    };
  }
  const mandatory = best.mandatory === true;
  return {
    status: mandatory ? 'mandatory' : 'available',
    targetVersion: best.version,
    channel: best.channel,
    url: best.url,
    mandatory,
    reason: mandatory
      ? `Mandatory update ${currentVersion} \u2192 ${best.version}.`
      : `Update available: ${currentVersion} \u2192 ${best.version}.`,
  };
}

export interface DownloadArtifact {
  /** Computed SHA-256 of the downloaded file (hex). */
  sha256: string;
  sizeBytes: number;
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
}

/**
 * Verify a downloaded artifact against the release's expected hash + size BEFORE
 * applying it. A missing/mismatched hash is a hard refusal (supply-chain safety).
 */
export function verifyDownload(release: ReleaseInfo, artifact: DownloadArtifact): VerifyResult {
  const expected = release.sha256.trim().toLowerCase();
  const actual = artifact.sha256.trim().toLowerCase();
  if (expected.length === 0) {
    return { ok: false, reason: 'No expected hash on the release \u2014 refusing to apply.' };
  }
  if (expected !== actual) {
    return { ok: false, reason: 'Hash mismatch \u2014 refusing to apply the update.' };
  }
  if (release.sizeBytes !== undefined && release.sizeBytes !== artifact.sizeBytes) {
    return {
      ok: false,
      reason: `Size mismatch (${artifact.sizeBytes} \u2260 ${release.sizeBytes}).`,
    };
  }
  return { ok: true, reason: 'Verified (sha256 match).' };
}

export type RestartPlan = 'apply-and-restart' | 'prompt-restart' | 'none';

/**
 * Decide how to apply a verified update: a mandatory update applies + restarts; an
 * optional one prompts; an unverified or up-to-date state does nothing.
 */
export function restartPlan(decision: UpdateDecision, verified: boolean): RestartPlan {
  if (!verified || decision.status === 'up-to-date') return 'none';
  return decision.status === 'mandatory' ? 'apply-and-restart' : 'prompt-restart';
}

/** Default periodic update-check interval (6h). */
export const BASE_CHECK_MS = 6 * 3_600_000;

/**
 * Exponential backoff for the periodic update check after consecutive failures
 * (base → 2× per failure), capped at 24h so a broken feed never spins.
 */
export function nextCheckDelayMs(
  consecutiveFailures: number,
  baseMs: number = BASE_CHECK_MS,
): number {
  const n =
    Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
      ? Math.floor(consecutiveFailures)
      : 0;
  const max = 24 * 3_600_000;
  if (n === 0) return Math.min(baseMs, max);
  return Math.min(baseMs * Math.pow(2, Math.min(n, 4)), max);
}

/** One-line status for a notification / status bar. */
export function summarizeUpdate(d: UpdateDecision): string {
  return d.status === 'up-to-date' ? 'You are on the latest version.' : d.reason;
}
