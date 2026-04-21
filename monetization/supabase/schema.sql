-- ============================================================
-- Ruflo Bot — Supabase Schema
-- Run this in the Supabase SQL editor or via supabase db push
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── profiles ─────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "users can read own profile"
  on profiles for select using (auth.uid() = id);
create policy "users can update own profile"
  on profiles for update using (auth.uid() = id);

-- auto-create profile on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── plans ─────────────────────────────────────────────────────
create table if not exists plans (
  id                  uuid primary key default uuid_generate_v4(),
  code                text not null unique,          -- 'monthly' | 'lifetime_early' | 'lifetime_standard'
  name                text not null,
  billing_type        text not null check (billing_type in ('monthly','lifetime')),
  price_cents         int  not null,
  active              boolean not null default true,
  visible             boolean not null default true,
  launch_phase        text check (launch_phase in ('early','standard','all')),
  stripe_price_id     text,                          -- filled in after Stripe setup
  created_at          timestamptz not null default now()
);

alter table plans enable row level security;
create policy "plans are publicly readable"
  on plans for select using (true);

-- seed plans
insert into plans (code, name, billing_type, price_cents, launch_phase, active, visible)
values
  ('monthly',          'Monthly',               'monthly',  1000, 'all',      true, true),
  ('lifetime_early',   'Lifetime Early Adopter','lifetime',  5000, 'early',    true, true),
  ('lifetime_standard','Lifetime Standard',     'lifetime', 10000, 'standard', true, true)
on conflict (code) do nothing;

-- ── pricing_config ────────────────────────────────────────────
-- Single-row table; backend reads this to enforce 90-day window.
create table if not exists pricing_config (
  id                          int  primary key default 1 check (id = 1),  -- singleton
  launch_date                 date not null default current_date,
  early_adopter_days          int  not null default 90,
  early_lifetime_price_cents  int  not null default 5000,
  standard_lifetime_price_cents int not null default 10000,
  monthly_price_cents         int  not null default 1000,
  updated_at                  timestamptz not null default now()
);

alter table pricing_config enable row level security;
create policy "pricing_config is publicly readable"
  on pricing_config for select using (true);

insert into pricing_config (id) values (1) on conflict (id) do nothing;

-- ── licenses ──────────────────────────────────────────────────
create table if not exists licenses (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  license_key  text not null unique,
  status       text not null default 'inactive'
                 check (status in ('active','inactive','revoked')),
  plan_code    text not null references plans(code),
  max_devices  int  not null default 2,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table licenses enable row level security;
create policy "users can read own licenses"
  on licenses for select using (auth.uid() = user_id);

create index idx_licenses_user_id    on licenses(user_id);
create index idx_licenses_key_status on licenses(license_key, status);

-- ── license_devices ───────────────────────────────────────────
create table if not exists license_devices (
  id                 uuid primary key default uuid_generate_v4(),
  license_id         uuid not null references licenses(id) on delete cascade,
  device_fingerprint text not null,
  device_name        text,
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (license_id, device_fingerprint)
);

alter table license_devices enable row level security;
create policy "users can read own devices"
  on license_devices for select
  using (
    exists (
      select 1 from licenses l
      where l.id = license_id and l.user_id = auth.uid()
    )
  );

-- ── subscriptions ─────────────────────────────────────────────
create table if not exists subscriptions (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id      text,
  stripe_subscription_id  text unique,
  stripe_price_id         text,
  status                  text not null default 'inactive'
                            check (status in
                              ('active','trialing','past_due','canceled','inactive','lifetime')),
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table subscriptions enable row level security;
create policy "users can read own subscriptions"
  on subscriptions for select using (auth.uid() = user_id);

create index idx_subs_user_id        on subscriptions(user_id);
create index idx_subs_stripe_sub_id  on subscriptions(stripe_subscription_id);
create index idx_subs_stripe_cust_id on subscriptions(stripe_customer_id);

-- ── audit_logs ────────────────────────────────────────────────
create table if not exists audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete set null,
  event_type  text not null,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

alter table audit_logs enable row level security;
-- Only service role can insert; users can read their own
create policy "users can read own audit logs"
  on audit_logs for select using (auth.uid() = user_id);

create index idx_audit_user_id    on audit_logs(user_id);
create index idx_audit_event_type on audit_logs(event_type);
create index idx_audit_created_at on audit_logs(created_at desc);

-- ── pending_purchases ─────────────────────────────────────────
-- Stores purchases made before an account exists (purchase-first / guest checkout).
-- Reconciled automatically when the user signs in with a matching email.
-- stripe_session_id unique constraint prevents double-provisioning on webhook replay.
create table if not exists pending_purchases (
  id                      uuid        primary key default uuid_generate_v4(),
  stripe_session_id       text        not null unique,
  email                   text        not null,
  plan_code               text        not null,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  status                  text        not null default 'pending'
                            check (status in ('pending', 'reconciled', 'expired')),
  metadata                jsonb       not null default '{}',
  created_at              timestamptz not null default now(),
  reconciled_at           timestamptz
);

alter table pending_purchases enable row level security;
-- Service role only — users never query this table directly
create index idx_pending_email_status on pending_purchases(email, status);
