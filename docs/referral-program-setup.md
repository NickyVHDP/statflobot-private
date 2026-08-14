# Lifetime Referral Program — Configuration Checklist

Branch: `feat/lifetime-referrals-final-sale`

Nothing in this checklist has been done by the implementation branch. No migration was
applied, no Stripe setting was changed, no environment variable was set, and no money can
move until the steps below are completed deliberately.

The code ships **fail-closed**: with none of this configured, attribution and the ledger
work, the admin queue renders, and payout execution refuses to run.

---

## 1. Tiered reward schedule

While the early-adopter lifetime price is active, qualified referrals 1–3 earn
`$10.00`, 4–5 earn `$15.00`, and 6+ earn `$20.00`. At the standard lifetime
price, referrals 1–3 earn `$15.00`, 4–5 earn `$20.00`, and 6+ earn `$25.00`.
The applicable schedule is frozen from the verified Stripe plan at purchase
time. Each reward is capped at 40% of net product revenue after discounts and
excluding tax/shipping, and no reward can exceed `$25.00`. The minimum eligible payout is
`$10.00`, but the threshold has **no default in code** — `REFERRAL_PAYOUT_THRESHOLD_CENTS`
must be explicitly set to `1000` or higher before any payout can be approved. Unset, malformed,
or below-`$10.00` values all fail closed (see §4).

## 2. Database migration

```
supabase/migrations/20260812012500_lifetime_referrals.sql
supabase/migrations/20260812211500_tiered_referral_rewards.sql
supabase/migrations/20260813100000_global_referral_payouts.sql
```

Apply in timestamp order via `supabase db push` (or run the same three files in
the Supabase SQL editor). The base migration creates seven tables:
`stripe_events`, `referral_codes`, `referral_attributions`, `referral_reservations`,
`referral_ledger`, `referral_payouts`, `referral_payout_accounts`. The second
second migration adds immutable reward snapshots and atomic accrual/reversal
functions. The third adds separate Global Payout recipient/method identifiers
and atomic payout reservation/finalization functions. It deliberately does not
reinterpret any legacy Connect account id as a Global Payout recipient.

`referral_reservations` is the only non-monetary one. It records that a code was applied to
a Checkout Session so the referrer sees a pending entry before the payment lands. No balance
reads it. If it is missing, checkout still works (the write is best-effort) and rewards still
accrue — the referrer simply sees nothing until the purchase completes.

It is **additive only** — it does not ALTER any existing table. This matters because
`schema.sql` has drifted from the live database (it declares `licenses.plan_code`; the
live column is `licenses.plan`, verified by read-only probe on 2026-08-11). That drift is
pre-existing and untouched by this branch, but it means any future migration written
against `schema.sql` needs the same care.

After applying, confirm PostgREST picked up the new tables (`notify pgrst, 'reload schema'`
is included; otherwise restart the project).

> **Ordering note.** The Stripe webhook now requires the `stripe_events` table for its
> idempotency claim and returns 500 if it is missing. Apply the migration **before**
> deploying the web app, or Stripe deliveries will fail and retry until it exists.

## 3. Stripe Dashboard

- [ ] **Terms of Service URL** — Settings → Checkout and Payment Links → set to
      `https://statflobot.store/terms`.
      Required: lifetime checkout sends `consent_collection.terms_of_service: 'required'`,
      and Stripe rejects session creation without a configured URL. The route detects this
      specific failure and returns `stripe-tos-url-missing` with the fix in the message
      rather than a generic payment error.
- [ ] **Webhook events** — add to the existing endpoint:
      `charge.refunded`, `charge.dispute.created`,
      `checkout.session.expired`.
      Without the first two, refunds and chargebacks will not reverse referral rewards.
      Without `checkout.session.expired`, an abandoned checkout stays visible to the referrer
      as "code applied" until its 24-hour TTL lapses — cosmetic only, no money effect.
- [x] **Stripe Global Payouts account activation** — activated in the live Dashboard on
      2026-08-12. No recipient, funding, or payout has been created.
- [x] **Global Payouts API v2 integration (local code)** — uses Stripe-hosted recipient
      onboarding and API-v2 Outbound Payments. Readiness is refreshed from Stripe when the
      Rewards Hub loads, so enabling a thin-event destination is not required for launch.
      The migration and sandbox flow still must pass before production deployment.

## 4. Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `REFERRAL_PAYOUT_THRESHOLD_CENTS` | payout approval | **Required to move money.** No default — unset fails closed. Must be `1000` ($10.00) or higher; anything lower also fails closed. |
| `REFERRAL_PAYOUTS_ENABLED` | payout execution | Must be exactly `true`. Defaults closed. |
| `STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID` | payout execution | Required. The `fa_…` storage FinancialAccount Stripe created during activation. |
| `STRIPE_GLOBAL_PAYOUTS_API_VERSION` | Stripe API v2 | Optional; defaults to `2026-02-25.preview`. Pin deliberately when Stripe updates the preview. |

All are read at request time, so they can be set without a code change. Leave
`REFERRAL_PAYOUTS_ENABLED` and `REFERRAL_PAYOUT_THRESHOLD_CENTS` unset until an end-to-end
test-mode run has passed — with either unset, the admin queue and bank enrollment work
normally, but `preflightPayout()` reports `threshold-not-configured` / `payouts-disabled` and
no money can move.

## 5. End-to-end verification (Stripe test mode)

The automated referral tests are structural — they prove the
guard rails exist and are wired in the right order. They do **not** exercise Stripe. Before
enabling payouts, run these against test mode with the CLI forwarding webhooks:

- [ ] Apply a valid code and start checkout WITHOUT paying → the referrer's dashboard shows
      "Code applied — not paid yet"; `referral_ledger` has no new row.
- [ ] Abandon that checkout → after `checkout.session.expired` (or 24h) it reads
      "Checkout not completed"; still no ledger row.
- [ ] Logged-in lifetime purchase with a valid code → the pending entry flips to
      "Purchased — clearing", one attribution, one accrual, `eligible_at` ≈ 30 days out.
- [ ] Guest self-referral: referrer's own code, own email, no session → rejected in the
      webhook guest path (the only place a guest's email is knowable).
- [ ] Approve the same payout twice in quick succession → both requests reuse one database
      reservation and one Stripe idempotency key; exactly one Outbound Payment exists.
- [ ] Guest purchase with a code, then sign in → exactly one attribution and one accrual;
      `referred_user_id` backfilled. Sign in again → still one.
- [ ] `stripe events resend` the same `checkout.session.completed` 5× → balance unchanged.
- [ ] Monthly checkout with a referral code in the body → 400, no attribution.
- [ ] Self-referral (own code) → rejected at checkout.
- [ ] Refund a referred purchase → reversal row appears, accrual untouched.
- [ ] Chargeback on a referred purchase → same, and a second reversal is not created.
- [ ] Stripe-hosted Global Payouts recipient onboarding completes; refreshing the Rewards
      Hub marks the recipient ready only after the local-bank capability is active and an
      eligible Payout Method exists.
- [ ] Payout below threshold → blocked. Above threshold with `REFERRAL_PAYOUTS_ENABLED`
      unset → blocked with a config reason.
- [ ] `REFERRAL_PAYOUT_THRESHOLD_CENTS` unset entirely → preflight reports
      `threshold-not-configured` even with a large eligible balance; no payout can be approved.
- [ ] Bank setup: connect a test bank account via Stripe-hosted enrollment, close the tab
      before finishing → the dashboard shows the "wasn't finished" state; clicking
      "Connect bank securely" again issues a brand-new link with no error.

Reconcile after each: `select entry_type, sum(amount_cents) from referral_ledger group by 1;`
should match the admin UI exactly.

## 6. Tax

Referral rewards may be taxable income and reporting duties depend on the facts and current
law. Confirm recipient tax-information collection, reporting thresholds, and recordkeeping
with an accountant or tax attorney before the first real payout.
