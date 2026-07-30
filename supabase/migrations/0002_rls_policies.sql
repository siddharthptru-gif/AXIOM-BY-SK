-- ============================================================================
-- Axiom — Row-Level Security policies (PRD Epoch E / Phase 116)
-- ============================================================================
-- Every user-scoped table is locked down so a user can only read/write their OWN
-- rows (auth.uid() = user_id). The anon key alone cannot read another user's
-- data. Telemetry + crash inserts are allowed for the owning user (the Edge
-- Functions use the service role, which bypasses RLS for server-side batching).
-- feature_flags is world-readable to authenticated users but never client-writable.
--
-- Depends on 0001_core_schema.sql. Idempotent (drop policy if exists first).
-- HONEST STATUS: authored + reviewed; verified by the pgTAP suite in
-- supabase/tests/rls_policies_test.sql once run against a live project. PARTIAL
-- until that live run passes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: a user reads/updates only their own profile row.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- user_settings (matches docs/SUPABASE_SYNC_SETUP.md exactly).
-- ---------------------------------------------------------------------------
alter table public.user_settings enable row level security;

drop policy if exists user_settings_select_own on public.user_settings;
create policy user_settings_select_own
  on public.user_settings for select
  using (auth.uid() = user_id);

drop policy if exists user_settings_insert_own on public.user_settings;
create policy user_settings_insert_own
  on public.user_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists user_settings_update_own on public.user_settings;
create policy user_settings_update_own
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists user_settings_delete_own on public.user_settings;
create policy user_settings_delete_own
  on public.user_settings for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- sync_records — prompt/rule/agent sync, user-scoped (full CRUD on own rows).
-- ---------------------------------------------------------------------------
alter table public.sync_records enable row level security;

drop policy if exists sync_records_select_own on public.sync_records;
create policy sync_records_select_own
  on public.sync_records for select
  using (auth.uid() = user_id);

drop policy if exists sync_records_insert_own on public.sync_records;
create policy sync_records_insert_own
  on public.sync_records for insert
  with check (auth.uid() = user_id);

drop policy if exists sync_records_update_own on public.sync_records;
create policy sync_records_update_own
  on public.sync_records for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists sync_records_delete_own on public.sync_records;
create policy sync_records_delete_own
  on public.sync_records for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- telemetry_events — a user may insert + read their OWN events. Server-side
-- batch ingest uses the service role (bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.telemetry_events enable row level security;

drop policy if exists telemetry_insert_own on public.telemetry_events;
create policy telemetry_insert_own
  on public.telemetry_events for insert
  with check (auth.uid() = user_id);

drop policy if exists telemetry_select_own on public.telemetry_events;
create policy telemetry_select_own
  on public.telemetry_events for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- crash_reports — same shape as telemetry (insert + read own).
-- ---------------------------------------------------------------------------
alter table public.crash_reports enable row level security;

drop policy if exists crash_insert_own on public.crash_reports;
create policy crash_insert_own
  on public.crash_reports for insert
  with check (auth.uid() = user_id);

drop policy if exists crash_select_own on public.crash_reports;
create policy crash_select_own
  on public.crash_reports for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- feature_flags — readable by any authenticated user; never client-writable
-- (writes happen via the dashboard / service role only).
-- ---------------------------------------------------------------------------
alter table public.feature_flags enable row level security;

drop policy if exists feature_flags_read_all on public.feature_flags;
create policy feature_flags_read_all
  on public.feature_flags for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- devices — a user manages only their own device rows.
-- ---------------------------------------------------------------------------
alter table public.devices enable row level security;

drop policy if exists devices_all_own on public.devices;
create policy devices_all_own
  on public.devices for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
