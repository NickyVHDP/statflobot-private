-- Preserve privacy-safe outcome counts so customers and the owner can tell why
-- a run skipped contacts without exposing Statflo names or message content.
alter table public.bot_runs
  add column if not exists dnc_count integer not null default 0,
  add column if not exists duplicate_skipped_count integer not null default 0,
  add column if not exists skip_reasons jsonb not null default '{}'::jsonb;

alter table public.bot_runs
  drop constraint if exists bot_runs_dnc_count_nonnegative,
  add constraint bot_runs_dnc_count_nonnegative check (dnc_count >= 0),
  drop constraint if exists bot_runs_duplicate_skipped_count_nonnegative,
  add constraint bot_runs_duplicate_skipped_count_nonnegative check (duplicate_skipped_count >= 0),
  drop constraint if exists bot_runs_skip_reasons_object,
  add constraint bot_runs_skip_reasons_object check (jsonb_typeof(skip_reasons) = 'object');

-- Keep direct authenticated access limited to summary fields. API routes still
-- scope rows by account and diagnostics remain service-role only.
grant select (
  id, user_id, created_at, list_name, mode, status,
  sent_count, skipped_count, failed_count,
  dnc_count, duplicate_skipped_count, skip_reasons,
  app_version, platform
) on table public.bot_runs to authenticated;
