# Supabase — cross-device preferences sync setup

Axiom's preferences sync (Epoch E §55) keeps a **local mirror + offline write queue**
on device, and — when you're signed in — pushes/pulls those records through **your
own Supabase project** (the same one used for Google sign-in). The client is already
wired (`main/services/sync.ts` → `flushQueue`); it stays a safe local backup until you
run the one-time SQL below. Nothing is uploaded until the table + policies exist.

## One-time setup (Supabase dashboard → SQL editor)

Run this against the project configured in `apps/desktop/src/main/config.ts`
(`bmdprpuehhalabhtndmf.supabase.co`):

```sql
-- 1) The table Axiom upserts preference records into.
create table if not exists public.user_settings (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null,
  body       jsonb,
  updated_at timestamptz not null default now(),
  device     text,
  deleted    boolean     not null default false,
  primary key (user_id, key)
);

-- Keep queries per-user fast.
create index if not exists user_settings_user_idx on public.user_settings (user_id);

-- 2) Row-Level Security: a user may only read/write their OWN rows.
alter table public.user_settings enable row level security;

create policy "user_settings_select_own"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_settings_delete_own"
  on public.user_settings for delete
  using (auth.uid() = user_id);
```

The client upserts on the `(user_id, key)` primary key, so re-syncs are idempotent.

## How it behaves

- **Signed out / table missing:** `flushQueue` is a no-op that keeps the queue intact
  and returns a reason (e.g. _"Not signed in"_ or _"Sync deferred (is the setup SQL
  applied?)"_). No data is lost.
- **Signed in + table present:** clicking **Back up preferences for sync** (AI panel →
  Your data) snapshots the current settings, **pushes** the coalesced queue via
  `user_settings.upsert(..., { onConflict: 'user_id,key' })`, then **pulls** the user's
  rows and merges them last-writer-wins into the local mirror.
- Each row is tagged with a stable per-install `device` id (`userData/sync-device.json`).

## Security notes

- RLS makes every row user-scoped; the anon key alone cannot read another user's data.
- Access tokens live only in the OS-encrypted store in Main (INV-3); the renderer never
  sees them, and the sync client runs entirely in the Main process.
- `body` is your settings JSON — avoid syncing secrets (API keys already live only in
  the OS vault and are never enqueued).

## Status

Client + protocol shipped and unit-tested (`common/syncProtocol.ts`). The live
round-trip can only be verified once the SQL above is applied on the project, so this
phase is tracked as **partial** until then.
