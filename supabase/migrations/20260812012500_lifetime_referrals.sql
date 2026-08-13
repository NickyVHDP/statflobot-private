-- ============================================================
-- Migration: add_referrals
--
-- Lifetime-only referral program: ledger, attribution, payouts,
-- Stripe Connect account state, and webhook event idempotency.
--
-- DESIGN NOTES (read before editing):
--
--   1. ADDITIVE ONLY. This migration creates new tables and does not ALTER
--      any existing table. `schema.sql` has drifted from the live database
--      (it declares `licenses.plan_code`; the live column is `licenses.plan`),
--      so touching existing tables from a migration written against
--      schema.sql would be unsafe. Nothing here depends on that column.
--
--   2. ATTRIBUTION IS IMMUTABLE. `referral_attributions` is written exactly
--      once per Stripe Checkout Session and never updated except to backfill
--      `referred_user_id` on guest reconciliation. `stripe_session_id` is the
--      idempotency key — same pattern as `early_bird_sales`.
--
--   3. THE LEDGER IS APPEND-ONLY. Refunds, chargebacks and payouts are new
--      rows with negative `amount_cents`, never UPDATEs or DELETEs of an
--      existing accrual. Balances are always SUM() over this table, which is
--      what makes the admin audit trail trustworthy.
--
--   4. SERVICE ROLE ONLY. No client-side reads. The dashboard and admin views
--      go through server routes that scope by the authenticated user.
--
--   5. `referral_reservations` IS NOT MONEY. It records that a code was applied
--      to a Checkout Session so the referrer sees a pending entry before the
--      payment lands. Nothing reads it to compute a balance.
--
-- Apply with the Supabase SQL editor or `supabase db push`.
-- NOT APPLIED BY THIS BRANCH.
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── stripe_events ─────────────────────────────────────────────
-- Webhook idempotency claim. A row is inserted BEFORE the event is dispatched;
-- a duplicate-key result means the event was already processed and the handler
-- short-circuits. Without this, a replayed checkout.session.completed re-enters
-- the whole handler — survivable for upserts, not survivable for money.
create table if not exists stripe_events (
  event_id     text        primary key,
  event_type   text        not null,
  received_at  timestamptz not null default now(),
  handled_at   timestamptz,
  status       text        not null default 'processing'
                 check (status in ('processing','handled','failed')),
  error_detail text
);

alter table stripe_events enable row level security;

create policy "service_role_all_stripe_events" on stripe_events
  for all to service_role using (true) with check (true);

create index if not exists idx_stripe_events_received on stripe_events(received_at desc);
create index if not exists idx_stripe_events_type     on stripe_events(event_type);

-- ── referral_codes ────────────────────────────────────────────
-- Exactly one code per referrer, enforced by the unique constraint on
-- referrer_user_id (not by application logic).
create table if not exists referral_codes (
  id                uuid        primary key default gen_random_uuid(),
  code              text        not null unique,
  referrer_user_id  uuid        not null unique references auth.users(id) on delete cascade,
  status            text        not null default 'active'
                      check (status in ('active','disabled')),
  created_at        timestamptz not null default now(),
  disabled_at       timestamptz,
  disabled_reason   text,
  -- A code may only be disabled with a reason, and only with a timestamp.
  constraint referral_codes_disabled_consistent check (
    (status = 'active'   and disabled_at is null) or
    (status = 'disabled' and disabled_at is not null)
  ),
  -- Codes are generated from an unambiguous alphabet; reject anything else.
  constraint referral_codes_format check (code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{10}$')
);

alter table referral_codes enable row level security;

create policy "service_role_all_referral_codes" on referral_codes
  for all to service_role using (true) with check (true);

create index if not exists idx_referral_codes_referrer on referral_codes(referrer_user_id);
create index if not exists idx_referral_codes_status   on referral_codes(status);

-- ── referral_attributions ─────────────────────────────────────
-- Immutable record that a specific paid lifetime Checkout Session was
-- attributed to a specific referrer. Written once, keyed on the Stripe session.
--
-- referrer_user_id is a FROZEN SNAPSHOT taken at Checkout Session creation.
-- It is deliberately NOT derived from referral_codes at read time: if the code
-- is later rotated, disabled, or the referrer's own license changes, the
-- attribution of an already-paid purchase must not move.
create table if not exists referral_attributions (
  id                        uuid        primary key default gen_random_uuid(),
  stripe_session_id         text        not null unique,
  stripe_payment_intent_id  text,
  referral_code_id          uuid        not null references referral_codes(id) on delete restrict,
  referral_code             text        not null,   -- denormalized snapshot
  referrer_user_id          uuid        not null references auth.users(id) on delete restrict,
  referred_user_id          uuid        references auth.users(id) on delete set null,
  referred_email            text        not null,
  plan_code                 text        not null,
  terms_version             text,
  terms_accepted_at         timestamptz,
  created_at                timestamptz not null default now(),
  -- Referrals are lifetime-only. This is the structural guarantee; the
  -- application enforces it independently at two other layers.
  constraint referral_attributions_lifetime_only check (plan_code like 'lifetime%')
);

alter table referral_attributions enable row level security;

create policy "service_role_all_referral_attributions" on referral_attributions
  for all to service_role using (true) with check (true);

create index if not exists idx_referral_attr_referrer on referral_attributions(referrer_user_id);
create index if not exists idx_referral_attr_referred on referral_attributions(referred_user_id);
create index if not exists idx_referral_attr_pi       on referral_attributions(stripe_payment_intent_id);
create index if not exists idx_referral_attr_email    on referral_attributions(referred_email);

-- ── referral_reservations ─────────────────────────────────────
-- NON-MONETARY. One row per lifetime Checkout Session that carried a valid
-- referral code, written at Session creation — i.e. the moment a new buyer
-- APPLIES the code, before any payment exists.
--
-- This table exists solely so a referrer can see "someone used your code and
-- is partway through checkout" instead of silence until the payment lands. It
-- never grants, holds or implies money: the ledger is still the only source of
-- balance, and an accrual is still only written by accrueReferral() after a
-- paid session provisions a license.
--
-- Rows settle to 'converted' (payment completed), 'expired' (Stripe expired
-- the session, or our TTL passed), or 'canceled'. They are never deleted, so
-- the admin can see abandoned-checkout patterns.
create table if not exists referral_reservations (
  id                uuid        primary key default gen_random_uuid(),
  stripe_session_id text        not null unique,
  referral_code_id  uuid        not null references referral_codes(id) on delete restrict,
  referral_code     text        not null,
  referrer_user_id  uuid        not null references auth.users(id) on delete cascade,
  -- Nullable on purpose: a guest has not entered an email yet when the Session
  -- is created. It is never exposed to the referrer either way.
  referred_email    text,
  plan_code         text        not null,
  status            text        not null default 'reserved'
                      check (status in ('reserved','converted','expired','canceled')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  settled_at        timestamptz,
  -- Same lifetime-only guarantee as attributions.
  constraint referral_reservations_lifetime_only check (plan_code like 'lifetime%')
);

alter table referral_reservations enable row level security;

create policy "service_role_all_referral_reservations" on referral_reservations
  for all to service_role using (true) with check (true);

create index if not exists idx_referral_res_referrer on referral_reservations(referrer_user_id);
create index if not exists idx_referral_res_status   on referral_reservations(status);
create index if not exists idx_referral_res_expires  on referral_reservations(expires_at);

-- ── referral_ledger ───────────────────────────────────────────
-- Append-only. Balance is always SUM(amount_cents) over this table.
--
--   accrual  → positive, becomes spendable at eligible_at (purchase + 30 days)
--   reversal → negative, refund or chargeback on the referred purchase
--   payout   → negative, admin-approved transfer to the referrer
--
-- A reversal AFTER a payout legitimately drives the balance negative. That is
-- intended: the debt offsets future rewards and is surfaced in the admin UI.
create table if not exists referral_ledger (
  id                uuid        primary key default gen_random_uuid(),
  referrer_user_id  uuid        not null references auth.users(id) on delete restrict,
  attribution_id    uuid        references referral_attributions(id) on delete restrict,
  payout_id         uuid,       -- FK added after referral_payouts exists
  entry_type        text        not null check (entry_type in ('accrual','reversal','payout')),
  amount_cents      int         not null,
  eligible_at       timestamptz not null,
  stripe_event_id   text,
  notes             text,
  created_at        timestamptz not null default now(),
  -- Sign discipline: accruals credit, reversals and payouts debit.
  constraint referral_ledger_sign check (
    (entry_type = 'accrual'  and amount_cents > 0) or
    (entry_type in ('reversal','payout') and amount_cents < 0)
  ),
  -- Accruals and reversals must reference the purchase they came from.
  constraint referral_ledger_attribution_required check (
    (entry_type in ('accrual','reversal') and attribution_id is not null) or
    (entry_type = 'payout' and attribution_id is null)
  )
);

alter table referral_ledger enable row level security;

create policy "service_role_all_referral_ledger" on referral_ledger
  for all to service_role using (true) with check (true);

-- Exactly one accrual per attributed purchase. This is the constraint that
-- makes webhook replay safe, together with the stripe_events claim row.
create unique index if not exists uniq_referral_ledger_accrual
  on referral_ledger(attribution_id) where entry_type = 'accrual';

-- Exactly one reversal per attributed purchase — a refund followed by a
-- dispute on the same charge must not debit the referrer twice.
create unique index if not exists uniq_referral_ledger_reversal
  on referral_ledger(attribution_id) where entry_type = 'reversal';

create index if not exists idx_referral_ledger_referrer on referral_ledger(referrer_user_id);
create index if not exists idx_referral_ledger_eligible on referral_ledger(eligible_at);
create index if not exists idx_referral_ledger_type     on referral_ledger(entry_type);

-- ── referral_payouts ──────────────────────────────────────────
-- One row per admin-approved payout attempt. Money never moves without an
-- explicit admin action; there is no scheduled or automatic payout path.
create table if not exists referral_payouts (
  id                  uuid        primary key default gen_random_uuid(),
  referrer_user_id    uuid        not null references auth.users(id) on delete restrict,
  amount_cents        int         not null check (amount_cents > 0),
  status              text        not null default 'pending'
                        check (status in ('pending','processing','paid','failed','canceled')),
  method              text        not null default 'stripe_connect'
                        check (method in ('stripe_connect','manual')),
  stripe_transfer_id  text        unique,
  stripe_account_id   text,
  idempotency_key     text        not null unique,
  approved_by_email   text        not null,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

alter table referral_payouts enable row level security;

create policy "service_role_all_referral_payouts" on referral_payouts
  for all to service_role using (true) with check (true);

create index if not exists idx_referral_payouts_referrer on referral_payouts(referrer_user_id);
create index if not exists idx_referral_payouts_status   on referral_payouts(status);

-- Link ledger payout rows back to the payout record.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'referral_ledger_payout_fk'
  ) then
    alter table referral_ledger
      add constraint referral_ledger_payout_fk
      foreign key (payout_id) references referral_payouts(id) on delete restrict;
  end if;
end $$;

-- ── referral_payout_accounts ──────────────────────────────────
-- Stripe Connect state only. We never collect, transmit or store bank
-- details ourselves — onboarding is entirely Stripe-hosted and this table
-- holds nothing more than the account id and its capability flags.
create table if not exists referral_payout_accounts (
  referrer_user_id     uuid        primary key references auth.users(id) on delete cascade,
  stripe_account_id    text        not null unique,
  onboarding_status    text        not null default 'created'
                         check (onboarding_status in ('created','pending','complete','restricted')),
  payouts_enabled      boolean     not null default false,
  details_submitted    boolean     not null default false,
  requirements_summary jsonb       not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table referral_payout_accounts enable row level security;

create policy "service_role_all_referral_payout_accounts" on referral_payout_accounts
  for all to service_role using (true) with check (true);

create index if not exists idx_referral_payout_accounts_stripe
  on referral_payout_accounts(stripe_account_id);

-- Reload the PostgREST schema cache so the new tables are immediately visible.
-- If this errors, restart the project from Dashboard > Project settings > Restart.
notify pgrst, 'reload schema';

-- Defense in depth: every customer/admin read and write goes through a
-- server route using the service role. Do not leave direct PostgREST table
-- privileges available to browser sessions even though RLS is also enabled.
revoke all on table
  stripe_events,
  referral_codes,
  referral_attributions,
  referral_reservations,
  referral_ledger,
  referral_payouts,
  referral_payout_accounts
from anon, authenticated;
