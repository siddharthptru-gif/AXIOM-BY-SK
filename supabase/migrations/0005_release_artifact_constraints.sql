-- ============================================================================
-- Axiom — Require usable update artifacts for future release publications
-- ============================================================================
-- Existing malformed rows are intentionally left in place so this migration is
-- non-destructive; stabilized clients skip them and select the newest valid row.
-- NOT VALID avoids blocking deployment on legacy rows while still enforcing each
-- new or updated release immediately.
-- ============================================================================

alter table public.app_releases
  alter column download_url drop default,
  alter column checksum drop default;

alter table public.app_releases
  drop constraint if exists app_releases_download_url_https;
alter table public.app_releases
  add constraint app_releases_download_url_https
  check (download_url ~ '^https://[^[:space:]]+$') not valid;

alter table public.app_releases
  drop constraint if exists app_releases_checksum_sha256;
alter table public.app_releases
  add constraint app_releases_checksum_sha256
  check (checksum ~* '^[0-9a-f]{64}$') not valid;
