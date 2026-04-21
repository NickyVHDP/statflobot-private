-- ── Migration: add pending_purchases table ───────────────────────────────────
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: all statements use "if not exists".
--
-- Purpose: stores Stripe checkout sessions completed by users who had no
-- account at payment time. Reconciled automatically when they sign up/in.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists pending_purchases (
  id                      uuid        primary key default uuid_generate_v4(),
  stripe_session_id       text        not null unique,          -- idempotency key
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
create index if not exists idx_pending_email_status
  on pending_purchases(email, status);
