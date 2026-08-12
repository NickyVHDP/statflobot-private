# Lifetime Referral Program — Configuration Checklist

Branch: `feat/lifetime-referrals-final-sale`

Nothing in this checklist has been done by the implementation branch. No migration was
applied, no Stripe setting was changed, no environment variable was set, and no money can
move until the steps below are completed deliberately.

The code ships **fail-closed**: with none of this configured, attribution and the ledger
work, the admin queue renders, and payout execution refuses to run.

---

## 1. Owner-set payout amount

Each eligible referral earns `$10.00`, and the minimum eligible payout is also `$10.00`.
The code defaults to 1000 cents. `REFERRAL_PAYOUT_THRESHOLD_CENTS` may raise that threshold,
but values below 1000 are rejected.

## 2. Database migration

```
monetization/supabase/add_referrals.sql
```

Apply via the Supabase SQL editor or `supabase db push`. Creates seven tables:
`stripe_events`, `referral_codes`, `referral_attributions`, `referral_reservations`,
`referral_ledger`, `referral_payouts`, `referral_payout_accounts`.

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
      `charge.refunded`, `charge.dispute.created`, `account.updated`,
      `checkout.session.expired`.
      Without the first two, refunds and chargebacks will not reverse referral rewards.
      Without `checkout.session.expired`, an abandoned checkout stays visible to the referrer
      as "code applied" until its 24-hour TTL lapses — cosmetic only, no money effect.
- [ ] **Stripe Connect** — enable on the platform account before onboarding any referrer.
      Confirm with Stripe support that paying non-selling referrers through Connect is
      acceptable for this account; it is a supported but non-standard use, and an account
      review mid-program would be disruptive.

## 4. Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `REFERRAL_PAYOUT_THRESHOLD_CENTS` | payout approval | Optional; defaults to `1000` ($10.00) and cannot be lower. |
| `REFERRAL_PAYOUTS_ENABLED` | payout execution | Must be exactly `true`. Defaults closed. |

Both are read at request time, so they can be set without a code change. Leave
`REFERRAL_PAYOUTS_ENABLED` unset until an end-to-end test-mode run has passed.

## 5. End-to-end verification (Stripe test mode)

The automated tests (`tests/referrals.test.js`, 51 cases) are structural — they prove the
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
- [ ] Approve the same payout twice in quick succession → the second is refused
      (`already being processed` / `concurrent payout detected`), and exactly one transfer
      exists in Stripe.
- [ ] Guest purchase with a code, then sign in → exactly one attribution and one accrual;
      `referred_user_id` backfilled. Sign in again → still one.
- [ ] `stripe events resend` the same `checkout.session.completed` 5× → balance unchanged.
- [ ] Monthly checkout with a referral code in the body → 400, no attribution.
- [ ] Self-referral (own code) → rejected at checkout.
- [ ] Refund a referred purchase → reversal row appears, accrual untouched.
- [ ] Chargeback on a referred purchase → same, and a second reversal is not created.
- [ ] Connect onboarding completes → `account.updated` flips `payouts_enabled`.
- [ ] Payout below threshold → blocked. Above threshold with `REFERRAL_PAYOUTS_ENABLED`
      unset → blocked with a config reason.

Reconcile after each: `select entry_type, sum(amount_cents) from referral_ledger group by 1;`
should match the admin UI exactly.

## 6. Tax

Referral rewards are commission income, not discounts. Connect Express onboarding collects
W-9 information, and 1099-NEC reporting applies at $600/year per referrer. Confirm handling
with an accountant before the first payout.
