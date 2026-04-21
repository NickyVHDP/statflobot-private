-- ============================================================
-- Migration: standalone devices table for desktop app tracking
--
-- This table is user-scoped (no license_id dependency) so device
-- registration works even before a license row exists.  It replaces
-- license_devices for the dashboard device-count feature.
--
-- Run in the Supabase SQL editor or via: supabase db push
-- ============================================================

create table if not exists devices (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users on delete cascade,
  device_fingerprint text        not null,
  device_name        text,
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  unique(user_id, device_fingerprint)
);

alter table devices enable row level security;

-- Users can read their own devices (Account screen)
create policy "users can read own devices"
  on devices for select
  using (auth.uid() = user_id);

-- Service role only for insert/update — desktop server uses service key
