-- Axiom God Mode collaboration: owner-controlled sessions with explicit members.
-- Session bodies contain redacted evidence bundles; credentials and absolute roots are forbidden by clients.

create table if not exists public.collaboration_sessions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  root_fingerprint text not null check (root_fingerprint ~ '^[0-9a-f]{64}$'),
  body jsonb not null default '{}'::jsonb check (
    jsonb_typeof(body) = 'object' and octet_length(body::text) <= 5242880
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collaboration_members (
  session_id uuid not null references public.collaboration_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor', 'reviewer', 'viewer')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index if not exists collaboration_sessions_owner_idx
  on public.collaboration_sessions(owner_id, updated_at desc);
create index if not exists collaboration_members_user_idx
  on public.collaboration_members(user_id, session_id);

alter table public.collaboration_sessions enable row level security;
alter table public.collaboration_members enable row level security;

create or replace function public.is_collaboration_owner(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.collaboration_sessions s
    where s.id = target_session and s.owner_id = auth.uid()
  );
$$;

create or replace function public.is_collaboration_member(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_collaboration_owner(target_session) or exists (
    select 1 from public.collaboration_members m
    where m.session_id = target_session and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_collaboration_owner(uuid) from public;
revoke all on function public.is_collaboration_member(uuid) from public;
grant execute on function public.is_collaboration_owner(uuid) to authenticated;
grant execute on function public.is_collaboration_member(uuid) to authenticated;

drop policy if exists collaboration_sessions_select on public.collaboration_sessions;
create policy collaboration_sessions_select on public.collaboration_sessions
for select to authenticated
using (public.is_collaboration_member(id));

drop policy if exists collaboration_sessions_insert on public.collaboration_sessions;
create policy collaboration_sessions_insert on public.collaboration_sessions
for insert to authenticated
with check (owner_id = auth.uid());

drop policy if exists collaboration_sessions_update on public.collaboration_sessions;
create policy collaboration_sessions_update on public.collaboration_sessions
for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists collaboration_sessions_delete on public.collaboration_sessions;
create policy collaboration_sessions_delete on public.collaboration_sessions
for delete to authenticated
using (owner_id = auth.uid());

drop policy if exists collaboration_members_select on public.collaboration_members;
create policy collaboration_members_select on public.collaboration_members
for select to authenticated
using (public.is_collaboration_member(session_id));

drop policy if exists collaboration_members_insert on public.collaboration_members;
create policy collaboration_members_insert on public.collaboration_members
for insert to authenticated
with check (public.is_collaboration_owner(session_id) and invited_by = auth.uid() and user_id <> auth.uid());

drop policy if exists collaboration_members_update on public.collaboration_members;
create policy collaboration_members_update on public.collaboration_members
for update to authenticated
using (public.is_collaboration_owner(session_id))
with check (
  public.is_collaboration_owner(session_id)
  and invited_by = auth.uid()
  and user_id <> auth.uid()
);

drop policy if exists collaboration_members_delete on public.collaboration_members;
create policy collaboration_members_delete on public.collaboration_members
for delete to authenticated
using (public.is_collaboration_owner(session_id) or user_id = auth.uid());



-- Desktop clients require this exact, catalog-checked migration attestation before
-- they may describe a cloud write as synced. The function exposes no row data.
create or replace function public.attest_god_mode_collaboration()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rls_table_count integer;
  policy_count integer;
  semantic_policy_count integer;
begin
  select count(*) into rls_table_count
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('collaboration_sessions', 'collaboration_members')
    and c.relkind = 'r'
    and c.relrowsecurity;

  select count(*) into policy_count
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
    and p.policyname in (
      'collaboration_sessions_select',
      'collaboration_sessions_insert',
      'collaboration_sessions_update',
      'collaboration_sessions_delete',
      'collaboration_members_select',
      'collaboration_members_insert',
      'collaboration_members_update',
      'collaboration_members_delete'
    )
    and p.tablename in ('collaboration_sessions', 'collaboration_members');

  select count(*) into semantic_policy_count
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
    end;

  if rls_table_count <> 2 or policy_count <> 8 or semantic_policy_count <> 8 then
    raise exception 'collaboration schema/RLS attestation failed'
      using errcode = '42501';
  end if;

  return 'axiom-god-mode-collaboration-v1-rls';
end;
$$;

revoke all on function public.attest_god_mode_collaboration() from public;
grant execute on function public.attest_god_mode_collaboration() to authenticated;
