import { rootLogger } from '@axiom/shared';
import { getSupabase } from './supabase';
import { parseReleaseConfig, type ReleaseConfig } from '../../common/updateConfig';

/**
 * ReleaseService (UPDATEFEATURE §4 — Supabase-controlled update config).
 *
 * Fetches the backend-controlled release configuration from the public,
 * RLS-readable `app_releases` table (see supabase/migrations/0003_app_releases.sql).
 * The newest valid row for the requested channel wins. No version info is
 * hard-coded; missing/invalid rows or network failures are handled gracefully
 * (returns null → the caller treats it as "up to date / offline" and retries with
 * backoff). Payloads are validated + sanitized by the pure `parseReleaseConfig`
 * before any download.
 */
const log = rootLogger.child('release');

export async function fetchReleaseConfig(channel = 'stable'): Promise<ReleaseConfig | null> {
  try {
    const supabase = getSupabase();
    const pageSize = 50;
    let from = 0;
    let skipped = 0;

    for (;;) {
      const { data, error } = await supabase
        .from('app_releases')
        .select('*')
        .eq('channel', channel)
        .order('release_date', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        log.warn('release config fetch failed', { message: error.message });
        return null;
      }

      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        const config = parseReleaseConfig(row);
        if (config) {
          if (skipped > 0) {
            log.warn('ignored malformed newer release configs', { channel, count: skipped });
          }
          log.info('release config fetched', { channel, latest: config.latestVersion });
          return config;
        }
        skipped += 1;
      }
      if (rows.length < pageSize) break;
      from += pageSize;
    }

    log.info('no valid release config for channel', { channel, rejected: skipped });
    return null;
  } catch (e) {
    log.warn('release config error', { message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
