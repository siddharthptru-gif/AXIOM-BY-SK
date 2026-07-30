-- ============================================================================
-- Axiom — Complete account-deletion cascades
-- ============================================================================
-- Existing deployments created telemetry/crash foreign keys with ON DELETE SET
-- NULL. Account deletion promises removal, so authenticated-user rows must be
-- deleted with auth.users rather than retained as anonymous records.
-- ============================================================================

alter table public.telemetry_events
  drop constraint if exists telemetry_events_user_id_fkey,
  add constraint telemetry_events_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.crash_reports
  drop constraint if exists crash_reports_user_id_fkey,
  add constraint crash_reports_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;
