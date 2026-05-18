-- bot_runs: stores sanitized run summaries from the desktop app
-- The desktop app writes rows via service role; users read only their own.

create table if not exists bot_runs (
  id                  uuid        primary key default uuid_generate_v4(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  list_name           text,
  mode                text,
  status              text        not null default 'completed',
  sent_count          int         not null default 0,
  skipped_count       int         not null default 0,
  failed_count        int         not null default 0,
  raw_log_sanitized   text,       -- sanitized before write; no tokens/keys/cookies
  app_version         text,
  platform            text
);

alter table bot_runs enable row level security;

-- Users read only their own rows; service role has full access for writes
create policy "users_read_own" on bot_runs
  for select to authenticated using (auth.uid() = user_id);

create policy "service_role_all" on bot_runs
  for all to service_role using (true) with check (true);

-- Efficient per-user chronological lookups (used by the dashboard)
create index if not exists idx_bot_runs_user_created on bot_runs(user_id, created_at desc);

-- Prune to last 50 rows per user with a trigger (optional — apply after confirming table exists)
-- create or replace function prune_bot_runs() returns trigger language plpgsql as $$
-- begin
--   delete from bot_runs
--   where user_id = NEW.user_id
--     and id not in (
--       select id from bot_runs
--       where user_id = NEW.user_id
--       order by created_at desc
--       limit 50
--     );
--   return NEW;
-- end;
-- $$;
-- create trigger trg_prune_bot_runs after insert on bot_runs
--   for each row execute procedure prune_bot_runs();
