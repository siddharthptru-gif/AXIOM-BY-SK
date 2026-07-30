-- ============================================================================
-- Axiom — Core data model & migrations (PRD Epoch E / Phase 115)
-- ============================================================================
-- Idempotent schema for the Axiom cloud backend on Supabase (Postgres). Covers
-- preferences sync, prompt/rule/agent sync, telemetry, crash reports, feature
-- flags, and device registry. Auth is handled by Supabase (`auth.users`); this
-- file only defines the application schema. Apply via the Supabase CLI
-- (`supabase db push`) or the dashboard SQL editor.
--
-- HONEST STATUS: authored + structurally reviewed, but NOT yet verified against a
-- live Supabase project (that needs the project's credentials + the `supabase`
-- CLI). Tracked as PARTIAL until a live migration + policy-test run passes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared helper: keep `updated_at` current on every row update.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) Profiles — one row per authenticated user (PRD Phase 122).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid        primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2) user_settings — preferences sync mirror (PRD Phase 121).
--    Shape MUST match the shipped client (common/syncProtocol.ts upserts on the
--    (user_id, key) primary key). See docs/SUPABASE_SYNC_SETUP.md.
-- ---------------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null,
  body       jsonb,
  updated_at timestamptz not null default now(),
  device     text,
  deleted    boolean     not null default false,
  primary key (user_id, key)
);

create index if not exists user_settings_user_idx on public.user_settings (user_id);

-- ---------------------------------------------------------------------------
-- 3) sync_records — prompt / rule / agent cloud sync (PRD Phase 125 / C2).
--    Generic last-writer-wins record store keyed by (user_id, kind, id).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_records (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('prompt', 'rule', 'agent')),
  id         text        not null,
  body       jsonb,
  updated_at timestamptz not null default now(),
  device     text,
  deleted    boolean     not null default false,
  primary key (user_id, kind, id)
);

create index if not exists sync_records_user_kind_idx on public.sync_records (user_id, kind);

-- ---------------------------------------------------------------------------
-- 4) telemetry_events — opt-in usage analytics (PRD Phases 126/127).
-- ---------------------------------------------------------------------------
create table if not exists public.telemetry_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete cascade,
  session_id  text        not null,
  event       text        not null,
  props       jsonb       not null default '{}'::jsonb,
  app_version text,
  platform    text,
  ts          timestamptz not null default now()
);

create index if not exists telemetry_events_user_ts_idx on public.telemetry_events (user_id, ts);
create index if not exists telemetry_events_event_idx on public.telemetry_events (event);

-- ---------------------------------------------------------------------------
-- 5) crash_reports — opt-in crash pipeline (PRD Phase 128).
-- ---------------------------------------------------------------------------
create table if not exists public.crash_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete cascade,
  app_version text,
  platform    text,
  kind        text,
  message     text,
  stack       text,
  fingerprint text,
  ts          timestamptz not null default now()
);

create index if not exists crash_reports_fingerprint_idx on public.crash_reports (fingerprint);

-- ---------------------------------------------------------------------------
-- 6) feature_flags — remote flags with staged rollout (PRD Phase 129).
--    Publicly readable to authenticated users; writes are admin-only (service
--    role / dashboard). Realtime is enabled below for live delivery.
-- ---------------------------------------------------------------------------
create table if not exists public.feature_flags (
  key         text        primary key,
  enabled     boolean     not null default false,
  -- Percentage rollout 0..100 (stable hash of user id decides inclusion).
  rollout     integer     not null default 100 check (rollout between 0 and 100),
  description text,
  audience    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

drop trigger if exists feature_flags_set_updated_at on public.feature_flags;
create trigger feature_flags_set_updated_at
  before update on public.feature_flags
  for each row execute function public.set_updated_at();

-- Live flag delivery over Supabase Realtime.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feature_flags'
  ) then
    alter publication supabase_realtime add table public.feature_flags;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) devices — registered installs per user (PRD Phase 123).
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  user_id   uuid        not null references auth.users (id) on delete cascade,
  device_id text        not null,
  name      text,
  platform  text,
  last_seen timestamptz not null default now(),
  primary key (user_id, device_id)
);
