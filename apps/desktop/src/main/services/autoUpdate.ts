import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@axiom/shared';
import {
  evaluateUpdate,
  type ReleaseInfo,
  type UpdateChannel,
  type UpdateDecision,
} from '../../common/autoUpdate';

/**
 * Auto-update service (PRD Epoch A / Phase 17 — dev feed). Reads the current app
 * version + a LOCAL dev release feed (`userData/updates/feed.json`, optional) and
 * evaluates whether an update is available via the pure `common/autoUpdate` core.
 * No network is contacted and nothing is downloaded/applied here — that (and a
 * real remote feed + signing + staged rollout) belongs to a real build machine +
 * Epoch J. Absent feed → "up to date".
 */
const log = rootLogger.child('autoUpdate');

const CHANNELS: readonly UpdateChannel[] = ['stable', 'beta', 'alpha', 'dev'];

function toChannel(v: unknown): UpdateChannel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
    ? (v as UpdateChannel)
    : 'stable';
}

function sanitizeReleases(raw: unknown): ReleaseInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { releases?: unknown }).releases)
      ? ((raw as { releases: unknown[] }).releases as unknown[])
      : [];
  const out: ReleaseInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const version = typeof o.version === 'string' ? o.version.trim() : '';
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const sha256 = typeof o.sha256 === 'string' ? o.sha256.trim() : '';
    if (!version || !url || !sha256) continue;
    out.push({
      version,
      channel: toChannel(o.channel),
      url,
      sha256,
      ...(typeof o.sizeBytes === 'number' ? { sizeBytes: o.sizeBytes } : {}),
      ...(typeof o.notes === 'string' ? { notes: o.notes.slice(0, 2000) } : {}),
      ...(o.mandatory === true ? { mandatory: true } : {}),
    });
  }
  return out;
}

/** Check the local dev feed for an available update (no network, never applies). */
export async function checkForUpdates(channel: UpdateChannel = 'stable'): Promise<UpdateDecision> {
  const current = app.getVersion();
  let releases: ReleaseInfo[] = [];
  try {
    const feedPath = join(app.getPath('userData'), 'updates', 'feed.json');
    releases = sanitizeReleases(JSON.parse(await readFile(feedPath, 'utf-8')));
  } catch {
    releases = []; // no dev feed configured → up to date
  }
  const decision = evaluateUpdate(current, channel, releases);
  log.info('update check', { status: decision.status, target: decision.targetVersion ?? '' });
  return decision;
}
