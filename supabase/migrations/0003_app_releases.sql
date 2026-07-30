-- ============================================================================
-- Axiom — App releases / auto-update config (UPDATEFEATURE / Phase 17)
-- ============================================================================
-- Backend-controlled release configuration read by every installed client on
-- startup to decide whether an (optional / mandatory) update is available. The
-- table is PUBLIC-READABLE (anon) so unauthenticated installs can fetch it, and is
-- NEVER client-writable — only the service role / dashboard publishes releases.
-- Apply AFTER 0001/0002 via `supabase db push` or the dashboard SQL editor.
-- ============================================================================

create table if not exists public.app_releases (
  id                         uuid        primary key default gen_random_uuid(),
  channel                    text        not null default 'stable',
  latest_version             text        not null,
  minimum_supported_version  text        not null default '0.0.0',
  update_type                text        not null default 'optional'
                                            check (update_type in ('optional', 'mandatory')),
  release_notes              text        not null default '',
  download_url               text        not null
                                            constraint app_releases_download_url_https
                                            check (download_url ~ '^https://[^[:space:]]+$'),
  checksum                   text        not null
                                            constraint app_releases_checksum_sha256
                                            check (checksum ~* '^[0-9a-f]{64}$'),
  size_bytes                 bigint,
  release_date               timestamptz not null default now(),
  created_at                 timestamptz not null default now()
);

-- Clients fetch the newest row for their channel.
create index if not exists app_releases_channel_date_idx
  on public.app_releases (channel, release_date desc);

-- ---------------------------------------------------------------------------
-- RLS: world-readable (anon + authenticated); no client writes. Only the service
-- role (dashboard / a trusted CI publish step) can insert/update, since it
-- bypasses RLS. No insert/update/delete policies are defined ⇒ clients cannot
-- write, so the update feed cannot be spoofed via the public anon key.
-- ---------------------------------------------------------------------------
alter table public.app_releases enable row level security;

drop policy if exists app_releases_public_read on public.app_releases;
create policy app_releases_public_read
  on public.app_releases for select
  to anon, authenticated
  using (true);

grant select on public.app_releases to anon, authenticated;

-- ============================================================================
-- Publish a release (run once per version, as the service role / in the SQL
-- editor). Clients pick the NEWEST row for their channel:
--
--   insert into public.app_releases
--     (channel, latest_version, minimum_supported_version, update_type,
--      release_notes, download_url, checksum, size_bytes)
--   values
--     ('stable', '1.1.0', '1.0.0', 'optional',
--      'What''s new in 1.1.0 …',
--      'https://YOUR-RELEASE-HOST/updates/AxiomSetup-1.1.0.exe',
--      '<sha256-hex-of-the-installer>', 78123456);
--
-- Force a MANDATORY (blocking) update by setting update_type = 'mandatory', or by
-- raising minimum_supported_version above the versions you want to retire.
-- ============================================================================
