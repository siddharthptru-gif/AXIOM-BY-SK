-- ============================================================================
-- Axiom — RLS policy tests (PRD Epoch E / Phase 116)  [pgTAP]
-- ============================================================================
-- Verifies that Row-Level Security is ENABLED on every user-scoped table and that
-- the expected policies exist. Run with the Supabase CLI:
--   supabase test db
-- (pgTAP ships in Supabase's test database.) Wrap in a transaction + rollback so
-- the checks never mutate data.
--
-- HONEST STATUS: authored + structurally reviewed; the live pass requires a
-- Supabase project with pgTAP. Phase 116 stays PARTIAL until this suite is green
-- against the live database.
-- ============================================================================
begin;

select plan(28);

-- --- RLS enabled on each table ---------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'RLS enabled on profiles'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_settings'::regclass),
  'RLS enabled on user_settings'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sync_records'::regclass),
  'RLS enabled on sync_records'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.telemetry_events'::regclass),
  'RLS enabled on telemetry_events'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.crash_reports'::regclass),
  'RLS enabled on crash_reports'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.feature_flags'::regclass),
  'RLS enabled on feature_flags'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.devices'::regclass),
  'RLS enabled on devices'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.collaboration_sessions'::regclass),
  'RLS enabled on collaboration_sessions'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.collaboration_members'::regclass),
  'RLS enabled on collaboration_members'
);

-- --- Expected policies exist (per table) -----------------------------------
select policies_are(
  'public', 'user_settings',
  ARRAY[
    'user_settings_select_own',
    'user_settings_insert_own',
    'user_settings_update_own',
    'user_settings_delete_own'
  ],
  'user_settings has the four own-row CRUD policies'
);

select policies_are(
  'public', 'sync_records',
  ARRAY[
    'sync_records_select_own',
    'sync_records_insert_own',
    'sync_records_update_own',
    'sync_records_delete_own'
  ],
  'sync_records has the four own-row CRUD policies'
);

select policies_are(
  'public', 'profiles',
  ARRAY['profiles_select_own', 'profiles_update_own', 'profiles_insert_own'],
  'profiles has select/update/insert own policies'
);

select policies_are(
  'public', 'telemetry_events',
  ARRAY['telemetry_insert_own', 'telemetry_select_own'],
  'telemetry_events has insert/select own policies'
);

select policies_are(
  'public', 'crash_reports',
  ARRAY['crash_insert_own', 'crash_select_own'],
  'crash_reports has insert/select own policies'
);

select policies_are(
  'public', 'feature_flags',
  ARRAY['feature_flags_read_all'],
  'feature_flags has the authenticated-read policy'
);

select policies_are(
  'public', 'devices',
  ARRAY['devices_all_own'],
  'devices has the own-row ALL policy'
);

select policies_are(
  'public', 'collaboration_sessions',
  ARRAY[
    'collaboration_sessions_select',
    'collaboration_sessions_insert',
    'collaboration_sessions_update',
    'collaboration_sessions_delete'
  ],
  'collaboration_sessions has explicit owner/member policies'
);

select policies_are(
  'public', 'collaboration_members',
  ARRAY[
    'collaboration_members_select',
    'collaboration_members_insert',
    'collaboration_members_update',
    'collaboration_members_delete'
  ],
  'collaboration_members has explicit owner/member policies'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies p
    where p.schemaname = 'public'
      and p.permissive = 'PERMISSIVE'
      and p.roles = array['authenticated']::name[]
      and case p.policyname
        when 'collaboration_sessions_select' then
          p.tablename = 'collaboration_sessions' and p.cmd = 'SELECT'
          and coalesce(p.qual, '') like '%is_collaboration_member(id)%'
        when 'collaboration_sessions_insert' then
          p.tablename = 'collaboration_sessions' and p.cmd = 'INSERT'
          and coalesce(p.with_check, '') like '%owner_id = auth.uid()%'
        when 'collaboration_sessions_update' then
          p.tablename = 'collaboration_sessions' and p.cmd = 'UPDATE'
          and coalesce(p.qual, '') like '%owner_id = auth.uid()%'
          and coalesce(p.with_check, '') like '%owner_id = auth.uid()%'
        when 'collaboration_sessions_delete' then
          p.tablename = 'collaboration_sessions' and p.cmd = 'DELETE'
          and coalesce(p.qual, '') like '%owner_id = auth.uid()%'
        when 'collaboration_members_select' then
          p.tablename = 'collaboration_members' and p.cmd = 'SELECT'
          and coalesce(p.qual, '') like '%is_collaboration_member(session_id)%'
        when 'collaboration_members_insert' then
          p.tablename = 'collaboration_members' and p.cmd = 'INSERT'
          and coalesce(p.with_check, '') like '%is_collaboration_owner(session_id)%'
          and coalesce(p.with_check, '') like '%invited_by = auth.uid()%'
          and coalesce(p.with_check, '') like '%user_id <> auth.uid()%'
        when 'collaboration_members_update' then
          p.tablename = 'collaboration_members' and p.cmd = 'UPDATE'
          and coalesce(p.qual, '') like '%is_collaboration_owner(session_id)%'
          and coalesce(p.with_check, '') like '%is_collaboration_owner(session_id)%'
          and coalesce(p.with_check, '') like '%invited_by = auth.uid()%'
          and coalesce(p.with_check, '') like '%user_id <> auth.uid()%'
        when 'collaboration_members_delete' then
          p.tablename = 'collaboration_members' and p.cmd = 'DELETE'
          and coalesce(p.qual, '') like '%is_collaboration_owner(session_id)%'
          and coalesce(p.qual, '') like '%user_id = auth.uid()%'
        else false
      end
  ),
  8::bigint,
  'collaboration policies retain authenticated owner/member semantics'
);

-- --- Column-shape guards (the sync client depends on these) -----------------
select has_column('public', 'user_settings', 'user_id', 'user_settings.user_id exists');
select has_column('public', 'user_settings', 'key', 'user_settings.key exists');
select has_column('public', 'user_settings', 'body', 'user_settings.body exists');
select col_is_pk(
  'public', 'user_settings', ARRAY['user_id', 'key'],
  'user_settings PK is (user_id, key)'
);

-- --- Helper functions present ----------------------------------------------
select has_function('public', 'set_updated_at', 'updated_at trigger fn exists');
select has_function('public', 'handle_new_user', 'new-user profile trigger fn exists');
select has_function(
  'public', 'is_collaboration_owner', ARRAY['uuid'],
  'collaboration owner helper exists'
);
select has_function(
  'public', 'is_collaboration_member', ARRAY['uuid'],
  'collaboration member helper exists'
);
select has_function(
  'public', 'attest_god_mode_collaboration', ARRAY[]::text[],
  'collaboration schema/RLS attestation helper exists'
);

select * from finish();
rollback;
