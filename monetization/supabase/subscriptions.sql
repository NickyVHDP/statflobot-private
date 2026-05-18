-- ============================================================
-- Migration: create subscriptions table
-- Run this in the Supabase SQL editor if the table is missing.
-- Safe to run on a database that already has the table (IF NOT EXISTS).
--
-- After running, refresh the PostgREST schema cache:
--   NOTIFY pgrst, 'reload schema';
-- Or restart the Supabase project from the dashboard if the
-- NOTIFY command is not available in your plan.
-- ============================================================

-- Extension needed for uuid_generate_v4() — already present on most projects.
create extension if not exists "uuid-ossp";

create table if not exists subscriptions (
  id                      uuid        primary key default uuid_generate_v4(),
  user_id                 uuid        not null references auth.users(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text        unique,
  stripe_price_id         text,
  status                  text        not null default 'active'
                            check (status in
                              ('active','trialing','past_due','canceled','inactive','lifetime')),
  current_period_end      timestamptz,
  cancel_at_period_end    boolean     not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Row-level security
alter table subscriptions enable row level security;

-- Authenticated users may only read their own rows
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'subscriptions'
      and policyname = 'users_read_own_subscriptions'
  ) then
    create policy "users_read_own_subscriptions"
      on subscriptions for select
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

-- Service role has unrestricted access (used by webhook + billing portal repair)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'subscriptions'
      and policyname = 'service_role_all_subscriptions'
  ) then
    create policy "service_role_all_subscriptions"
      on subscriptions for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

-- Indexes (IF NOT EXISTS guards make this idempotent)
create index if not exists idx_subscriptions_user_created
  on subscriptions(user_id, created_at desc);

create index if not exists idx_subscriptions_customer_id
  on subscriptions(stripe_customer_id);

create index if not exists idx_subscriptions_subscription_id
  on subscriptions(stripe_subscription_id);

-- Reload the PostgREST schema cache so the new table is immediately visible.
-- If this errors ("permission denied" or "pg_notify not available"), skip it —
-- instead restart the Supabase project from Dashboard > Project settings > Restart.
notify pgrst, 'reload schema';
