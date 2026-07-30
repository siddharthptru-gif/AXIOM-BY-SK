# Axiom — Supabase backend (Epoch E)

Real, reviewable backend code for Axiom's cloud tier: Postgres schema + Row-Level
Security + Edge Functions. It complements the already-shipped, unit-tested **client**
(`main/services/{sync,supabase,auth,...}.ts`, `common/syncProtocol.ts`) and the auth
setup in `docs/SUPABASE_AUTH_SETUP.md`.

> **Honest status.** This backend is **authored + structurally reviewed but not yet
> verified against a live Supabase project.** A live pass needs the project's
> credentials + the `supabase` CLI (neither available in the build sandbox). The
> corresponding PRD phases (115 schema, 116 RLS + policy tests, 118 Edge/DB functions,
> 129 feature flags) are therefore tracked as **partial**, not done, until the steps
> below run green on the live project.

## Layout

```
supabase/
  migrations/
    0001_core_schema.sql              # Phase 115 — tables, indexes, triggers, Realtime
    0002_rls_policies.sql             # Phase 116 — RLS enable + per-user policies
    0003_app_releases.sql             # public-read, service-role-written release metadata
    0004_account_deletion_cascade.sql # deletion cascade hardening
    0005_release_artifact_constraints.sql # update artifact constraints
    0006_god_mode_collaboration.sql   # owner/member collaboration RLS
  functions/
    _shared/cors.ts          # shared CORS + JSON helper
    telemetry-ingest/        # Phase 126/118 — batched, RLS-scoped event ingest
    delete-account/          # Phase 124/118 — service-role account deletion (cascade)
    feature-flags/           # Phase 129 — per-user flag evaluation (staged rollout)
  tests/
    rls_policies_test.sql    # Phase 116 — pgTAP: RLS enabled + policies present
```

## Schema summary

| Table                    | Purpose                                        | Key                     |
| ------------------------ | ---------------------------------------------- | ----------------------- |
| `profiles`               | one row per auth user (Phase 122)              | `id` → `auth.users`     |
| `user_settings`          | preferences sync (Phase 121)                   | `(user_id, key)`        |
| `sync_records`           | prompt/rule/agent sync (Phase 125)             | `(user_id, kind, id)`   |
| `telemetry_events`       | opt-in analytics (Phase 126/127)               | identity                |
| `crash_reports`          | opt-in crash pipeline (Phase 128)              | identity                |
| `feature_flags`          | remote flags + rollout (Phase 129)             | `key` (Realtime)        |
| `devices`                | per-user installs (Phase 123)                  | `(user_id, device_id)`  |
| `collaboration_sessions` | optional evidence-rich God Mode handoffs       | `id`, owner-controlled  |
| `collaboration_members`  | explicit editor/reviewer/viewer session access | `(session_id, user_id)` |

`user_settings` matches `docs/SUPABASE_SYNC_SETUP.md` exactly so the shipped sync
client keeps working unchanged.

## Deploy (one-time, on your project)

```bash
# from the repo root, against the project in apps/desktop/src/main/config.ts
supabase link --project-ref bmdprpuehhalabhtndmf

# 1) schema + RLS
supabase db push               # applies migrations/*.sql in order

# 2) RLS policy tests (pgTAP)
supabase test db               # expects 28 passing assertions

# 3) Edge Functions
supabase functions deploy telemetry-ingest
supabase functions deploy feature-flags
supabase functions deploy delete-account
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # delete-account only
```

## Security notes

- Every user-scoped table is RLS-locked to `auth.uid() = user_id`; the anon key
  cannot read another user's rows.
- `telemetry-ingest` inserts under the **caller's** JWT (RLS-enforced) — no service
  role needed. `delete-account` is the only function that uses the service role, and
  only to delete the auth user (app rows cascade via `on delete cascade`).
- `feature_flags` is world-readable to authenticated users but never client-writable
  (writes happen in the dashboard / via the service role).
- God Mode collaboration is local-only by default. Optional sharing writes bounded, redacted
  session documents identified by an opaque session binding that is not derived from the local
  workspace path; owners control mutation and membership, while explicit members can read. The
  nonrecursive security-definer helpers use an empty `search_path`. Desktop sharing requires the
  exact result of `attest_god_mode_collaboration()`, which checks both collaboration tables have
  RLS enabled and all eight policies retain their expected commands, authenticated role, and
  owner/member predicates before local state can become `synced`.
  Migration `0006` and its pgTAP assertions remain **authored and structurally reviewed, not
  claimed as live**, until `supabase db push` and `supabase test db` pass against
  the configured project.
- Never commit the service-role key or the Google client secret; they live only in
  Supabase (see `docs/SUPABASE_AUTH_SETUP.md`).

## Auto-update config (`app_releases`, migration 0003)

The desktop app checks for updates on startup by reading the public, RLS-readable
`public.app_releases` table (migration `0003_app_releases.sql`). It is world-readable
(anon) so every installed copy can fetch it, and is never client-writable — only the
service role / dashboard publishes releases.

To publish a new version so installed apps can update:

1. Complete `docs/release-hardening.md`; build, CA-sign, timestamp, and independently
   verify the x64 app/native executables and final installer.
2. Upload the final installer and checksum sidecar through an approved authenticated
   channel. `electron-builder.yml` deliberately has no publisher or upload destination.
3. Insert a row (dashboard SQL editor or service role). This row—not `latest.yml`—is
   the hardened desktop updater's authoritative artifact record:

   ```sql
   insert into public.app_releases
     (channel, latest_version, minimum_supported_version, update_type,
      release_notes, download_url, checksum, size_bytes)
   values
     ('stable', '1.1.0', '1.0.0', 'optional',
      'What''s new …',
      'https://YOUR-RELEASE-HOST/updates/AxiomSetup-1.1.0.exe',
      '<sha256-of-installer>', 78123456);
   ```

`download_url` must be a credential-free HTTPS URL directly to the signed installer;
`checksum` and `size_bytes` must match its final bytes. Clients pick the newest valid row
for their channel, verify size and SHA-256, and prompt (optional) or block (mandatory)
accordingly. A checksum is not a signature. Never make a row mandatory until the artifact,
trusted signature/timestamp, URL, size, and digest have been verified after upload.
