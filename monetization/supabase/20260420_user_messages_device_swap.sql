-- ============================================================
-- Migration: per-user message storage + device swap anti-abuse
-- Run in the Supabase SQL editor or via: supabase db push
-- ============================================================

-- ── user_messages ─────────────────────────────────────────────
-- Stores per-user outreach messages (2nd / 3rd Attempt).
-- One row per user; upserted on save.
create table if not exists user_messages (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  second_attempt_message   text not null default '',
  third_attempt_message    text not null default '',
  updated_at               timestamptz not null default now()
);

alter table user_messages enable row level security;

create policy "users can read own messages"
  on user_messages for select
  using (auth.uid() = user_id);

create policy "users can upsert own messages"
  on user_messages for insert
  with check (auth.uid() = user_id);

create policy "users can update own messages"
  on user_messages for update
  using (auth.uid() = user_id);

-- ── device_swap_log ───────────────────────────────────────────
-- Tracks device removals for anti-abuse enforcement:
--   - max 1 removal per 30 days per license
--   - 48-hour cooling period before removed slot can be reused
--   - new devices cannot be removed for 7 days
create table if not exists device_swap_log (
  id                    uuid primary key default gen_random_uuid(),
  license_id            uuid not null references licenses(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  device_fingerprint    text not null,
  device_name           text,
  removed_at            timestamptz not null default now(),
  can_replace_after     timestamptz not null  -- removed_at + 48 hours
);

create index if not exists idx_device_swap_log_license_removed
  on device_swap_log (license_id, removed_at);

-- service role only — no user-facing RLS reads needed
alter table device_swap_log enable row level security;
