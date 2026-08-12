import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { provisionLicense, deactivateLicense, auditLog } from '@/lib/license';
import {
  accrueReferral,
  getUserEmail,
  isNewBuyer,
  reverseReferralForCharge,
  settleReservation,
} from '@/lib/referrals';
import { syncConnectAccount } from '@/lib/referralPayouts';
import Stripe from 'stripe';

/**
 * POST /api/webhooks/stripe
 *
 * Handles all Stripe lifecycle events. Signature-verified via webhook secret.
 *
 * Events handled:
 *   checkout.session.completed        → provision license + subscription row (+ referral accrual)
 *   customer.subscription.updated     → sync status, period_end
 *   customer.subscription.deleted     → cancel + deactivate
 *   invoice.paid                      → keep subscription active
 *   invoice.payment_failed            → mark past_due
 *   charge.refunded                   → reverse any referral accrual
 *   charge.dispute.created            → reverse any referral accrual
 *   account.updated                   → sync Connect payout capability
 *
 * IDEMPOTENCY
 * -----------
 * Every event claims a `stripe_events` row before dispatch. A duplicate event
 * id short-circuits immediately, which is what makes replay safe now that a
 * replayed checkout can create a monetary accrual.
 *
 * RETRY SEMANTICS
 * ---------------
 * This handler used to catch everything and return 200 explicitly so Stripe
 * would never retry. That is safe for idempotent upserts and unsafe for money:
 * a transient failure lost the write permanently. Failures now return 500 so
 * Stripe's backoff retries, and the claim row is released first so the retry
 * can actually re-run.
 */
export async function POST(req: NextRequest) {
  console.log('[STRIPE_WEBHOOK_RECEIVED]');

  const stripe = getStripe();
  const body = await req.text();
  const sig  = req.headers.get('stripe-signature');

  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error('[webhook] signature verification failed:', err.message);
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  const supabase = createServiceClient();

  // ── Idempotency claim ─────────────────────────────────────────────────────
  // Insert-before-dispatch. A unique violation (23505) means this event id has
  // already been claimed, so we acknowledge and do nothing.
  const { error: claimErr } = await supabase
    .from('stripe_events')
    .insert({ event_id: event.id, event_type: event.type, status: 'processing' });

  if (claimErr) {
    if (claimErr.code === '23505') {
      console.log(`[WEBHOOK_DUPLICATE_IGNORED] event=${event.id} type=${event.type}`);
      return NextResponse.json({ received: true, duplicate: true });
    }
    // The table is missing (migration not applied) or the DB is unreachable.
    // Fail loudly: without the claim we cannot guarantee replay safety, and
    // Stripe retrying is far better than silently double-processing.
    console.error(`[WEBHOOK_CLAIM_FAILED] event=${event.id} code=${claimErr.code} msg=${claimErr.message}`);
    return NextResponse.json(
      { error: 'Webhook idempotency store unavailable', code: claimErr.code },
      { status: 500 }
    );
  }

  try {
    switch (event.type) {

      // ── Checkout completed ────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.Checkout.Session;
        console.log(`[CHECKOUT_SESSION_COMPLETED] session=${session.id} mode=${session.mode} planCode=${session.metadata?.plan_code ?? 'none'} userId=${session.metadata?.user_id ?? session.client_reference_id ?? 'unknown'}`);
        let   userId     = session.metadata?.user_id || session.client_reference_id || '';
        const planCode   = session.metadata?.plan_code;
        const customerId = session.customer as string | null;

        // The "code applied, not paid yet" entry for this session has served its
        // purpose — the purchase itself now represents it. Settled before any
        // provisioning so an abandoned-looking entry cannot outlive the payment.
        if (session.metadata?.referrer_user_id) {
          await settleReservation(session.id, 'converted');
        }

        // Fallback: resolve user by email if metadata/client_reference_id was not set.
        // Covers edge cases where checkout was initiated outside the normal flow.
        if (!userId && session.customer_details?.email) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', session.customer_details.email)
            .single();
          if (profile?.id) {
            userId = profile.id;
            console.warn('[webhook] userId resolved via email fallback', {
              email: session.customer_details.email,
            });
          }
        }

        if (!userId && planCode && session.customer_details?.email) {
          // Purchase-first flow: no account yet — store for reconciliation on sign-in.
          // stripe_session_id unique constraint prevents duplicate inserts on webhook replay.
          const pendingEmail = session.customer_details.email.toLowerCase();

          // ── Guest referral snapshot ───────────────────────────────────────
          // This is the FIRST moment a guest buyer's email is knowable, and the
          // last moment before any purchase artifact exists for them — so it is
          // where the "new buyer" gate must run for this path. The outcome is
          // frozen into pending_purchases.metadata; reconciliation trusts it and
          // does not re-evaluate (by then a license exists and every buyer would
          // look like a returning one).
          const guestReferral: Record<string, unknown> = {};
          if (session.metadata?.referrer_user_id && planCode.startsWith('lifetime')) {
            // Self-referral by email cannot be checked at Session creation on
            // this path — a guest has no account and has not typed an email yet,
            // so validateReferralCode() saw `email: null` and could only check
            // the code itself. This is the first point the buyer's email exists,
            // and therefore the only place the guest self-referral check can run.
            const referrerEmail = await getUserEmail(session.metadata.referrer_user_id);
            const selfReferral  = !!referrerEmail && referrerEmail === pendingEmail;

            const newBuyer = selfReferral
              ? { isNew: false, reason: 'self-referral' }
              : await isNewBuyer({ email: pendingEmail });

            if (newBuyer.isNew) {
              guestReferral.referrer_user_id = session.metadata.referrer_user_id;
              guestReferral.referral_code_id = session.metadata.referral_code_id;
              guestReferral.referral_code    = session.metadata.referral_code;
              console.log(`[REFERRAL_GUEST_SNAPSHOT_STORED] session=${session.id} code=${session.metadata.referral_code}`);
            } else {
              console.warn(
                `[REFERRAL_GUEST_REJECTED] session=${session.id} reason=${newBuyer.reason} ` +
                `— referral dropped, purchase unaffected`
              );
            }
          }

          const { error: pendingPurchaseErr } = await supabase.from('pending_purchases').upsert({
            stripe_session_id:       session.id,
            email:                   pendingEmail,
            plan_code:                planCode,
            stripe_customer_id:      customerId,
            stripe_subscription_id:  session.mode === 'subscription'
              ? (session.subscription as string | null)
              : null,
            status:    'pending',
            metadata:  {
              mode: session.mode,
              payment_intent:    typeof session.payment_intent === 'string' ? session.payment_intent : null,
              terms_version:     session.metadata?.terms_version ?? null,
              terms_accepted_at: session.metadata?.terms_accepted_at ?? null,
              ...guestReferral,
            },
            created_at: new Date().toISOString(),
          }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });

          if (pendingPurchaseErr) {
            throw new Error(`Pending purchase save failed: ${pendingPurchaseErr.message}`);
          }

          console.warn('[webhook] no userId — stored pending_purchase for', pendingEmail);
          await auditLog(null, 'pending_purchase_stored', {
            stripe_session_id: session.id,
            email:             pendingEmail,
            plan_code:         planCode,
            has_referral:      !!guestReferral.referrer_user_id,
          });
          break;
        }

        if (!userId || !planCode) {
          console.error('[webhook] missing userId or planCode', {
            sessionId:    session.id,
            hasMetaUser:  !!session.metadata?.user_id,
            hasClientRef: !!session.client_reference_id,
            hasEmail:     !!session.customer_details?.email,
            planCode,
          });
          break;
        }

        if (session.mode === 'subscription') {
          // ── Monthly subscription ──────────────────────────────────────────
          const subId     = session.subscription as string;
          const stripeSub = await stripe.subscriptions.retrieve(subId);
          const newPeriodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();

          console.log(`[WEBHOOK_CHECKOUT_COMPLETED] session=${session.id} mode=subscription userId=${userId} customerId=${customerId ?? 'none'} subId=${subId} stripeStatus=${stripeSub.status} periodEnd=${newPeriodEnd}`);

          // Re-subscription guard: users have UNIQUE(user_id) on subscriptions.
          // Upserting on stripe_subscription_id inserts a new row, but the user_id
          // constraint fires a duplicate-key error for returning subscribers.
          // Fix: find the existing non-lifetime row and UPDATE it in place; INSERT only
          // when no prior monthly row exists (true first-time subscriber).
          const { data: existingSub } = await supabase
            .from('subscriptions')
            .select('id, stripe_subscription_id')
            .eq('user_id', userId)
            .neq('status', 'lifetime')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const subFields = {
            stripe_customer_id:     customerId,
            stripe_subscription_id: subId,
            stripe_price_id:        stripeSub.items.data[0]?.price.id,
            status:                 stripeSub.status,
            current_period_end:     newPeriodEnd,
            cancel_at_period_end:   stripeSub.cancel_at_period_end,
            updated_at:             new Date().toISOString(),
          };

          if (existingSub?.id) {
            // Re-subscribe: update existing row (avoids user_id unique constraint violation)
            const { error: updateErr } = await supabase
              .from('subscriptions')
              .update(subFields)
              .eq('id', existingSub.id);

            if (updateErr) {
              console.error(`[MONTHLY_SUB_UPSERT_FAILED] method=update userId=${userId} subId=${subId} error=${updateErr.message}`);
            } else {
              console.log(`[SUBSCRIPTION_UPSERTED] method=update userId=${userId} subId=${subId} status=${stripeSub.status} periodEnd=${newPeriodEnd} prevSubId=${existingSub.stripe_subscription_id}`);
            }
          } else {
            // First-time subscriber: insert new row
            const { error: insertErr } = await supabase.from('subscriptions').insert({
              user_id: userId,
              ...subFields,
              created_at: new Date().toISOString(),
            });

            if (insertErr) {
              console.error(`[MONTHLY_SUB_UPSERT_FAILED] method=insert userId=${userId} subId=${subId} error=${insertErr.message}`);
            } else {
              console.log(`[SUBSCRIPTION_UPSERTED] method=insert userId=${userId} subId=${subId} status=${stripeSub.status} periodEnd=${newPeriodEnd}`);
            }
          }

        } else if (session.mode === 'payment') {
          // ── Lifetime one-time payment ─────────────────────────────────────
          // A lifetime upgrade must stop recurring billing. Cancel any prior
          // monthly Stripe subscription before recording lifetime access.
          const { data: priorSubs, error: priorLookupErr } = await supabase
            .from('subscriptions')
            .select('id, stripe_subscription_id, status')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
          if (priorLookupErr) throw new Error(`Lifetime upgrade lookup failed: ${priorLookupErr.message}`);

          for (const prior of priorSubs ?? []) {
            if (!prior.stripe_subscription_id || prior.status === 'lifetime') continue;
            const currentStripeSub = await stripe.subscriptions.retrieve(prior.stripe_subscription_id);
            if (currentStripeSub.status !== 'canceled') {
              await stripe.subscriptions.cancel(prior.stripe_subscription_id);
              console.log(`[LIFETIME_UPGRADE_MONTHLY_CANCELED] userId=${userId} subId=${prior.stripe_subscription_id}`);
            }
          }

          const lifetimeFields = {
            stripe_customer_id:     customerId,
            stripe_subscription_id: null,
            stripe_price_id:        null,
            status:                 'lifetime',
            current_period_end:     null,
            cancel_at_period_end:   false,
            updated_at:             new Date().toISOString(),
          };
          const primaryRow = priorSubs?.[0] ?? null;
          const lifetimeWrite = primaryRow?.id
            ? await supabase.from('subscriptions').update(lifetimeFields).eq('id', primaryRow.id)
            : await supabase.from('subscriptions').insert({
                user_id: userId,
                ...lifetimeFields,
                created_at: new Date().toISOString(),
              });
          if (lifetimeWrite.error) throw new Error(`Lifetime subscription save failed: ${lifetimeWrite.error.message}`);

          if ((priorSubs?.length ?? 0) > 1) {
            const duplicateIds = priorSubs!.slice(1).map((row: any) => row.id);
            const { error: cleanupErr } = await supabase.from('subscriptions').delete().in('id', duplicateIds);
            if (cleanupErr) throw new Error(`Duplicate subscription cleanup failed: ${cleanupErr.message}`);
          }

          // Record early-bird claim — only for early price, never monthly/standard.
          // stripe_session_id unique constraint prevents duplicate inserts on retry.
          if (planCode === 'lifetime_early') {
            const { error: ebErr } = await supabase.from('early_bird_sales').upsert({
              stripe_session_id: session.id,
              user_id:           userId,
              created_at:        new Date().toISOString(),
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });
            if (ebErr) {
              console.error(`[EARLY_BIRD_SALES_INSERT_FAILED] sessionId=${session.id} userId=${userId} error=${ebErr.message}`);
            } else {
              console.log(`[EARLY_BIRD_SALES_RECORDED] sessionId=${session.id} userId=${userId}`);
            }
          }
        }

        // Normalize to 'monthly' or 'lifetime' — the licenses.plan column uses these values.
        const licensePlan = planCode.startsWith('lifetime') ? 'lifetime' : 'monthly';
        const { licenseKey } = await provisionLicense(userId, licensePlan);
        if (licensePlan === 'monthly') {
          console.log(`[LICENSE_REACTIVATED_AFTER_MONTHLY_RESUME] userId=${userId} licenseKey=${licenseKey}`);
        }
        await auditLog(userId, 'checkout_completed', { planCode, licensePlan, licenseKey });

        // ── Referral accrual ──────────────────────────────────────────────
        // Deliberately AFTER provisionLicense: a reward must never exist for a
        // purchase that failed to grant access. Only reached on the logged-in
        // path; the guest path accrues during reconciliation instead.
        //
        // The "new buyer" gate for this path already ran at Checkout Session
        // creation — see the note in lib/referrals.ts accrueReferral().
        if (
          session.mode === 'payment' &&
          licensePlan === 'lifetime' &&
          session.metadata?.referrer_user_id &&
          session.metadata?.referral_code_id
        ) {
          await accrueReferral({
            stripeSessionId:        session.id,
            stripePaymentIntentId:  typeof session.payment_intent === 'string' ? session.payment_intent : null,
            referrerUserId:         session.metadata.referrer_user_id,
            referralCodeId:         session.metadata.referral_code_id,
            referralCode:           session.metadata.referral_code ?? '',
            referredUserId:         userId,
            referredEmail:          session.customer_details?.email ?? '',
            planCode,
            termsVersion:           session.metadata.terms_version ?? null,
            termsAcceptedAt:        session.metadata.terms_accepted_at ?? null,
            stripeEventId:          event.id,
          });
        }
        break;
      }

      // ── Subscription updated (renewal, plan change, cancel scheduled) ─────
      case 'customer.subscription.updated': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

        if (sub.cancel_at_period_end) {
          console.log(`[SUB_CANCEL_SCHEDULED] subId=${sub.id} userId=${userId ?? 'unknown'} status=${sub.status} periodEnd=${periodEnd} — access kept until period ends`);
        }

        await supabase.from('subscriptions')
          .update({
            status:               sub.status,
            current_period_end:   periodEnd,
            cancel_at_period_end: sub.cancel_at_period_end,
            updated_at:           new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        // Re-activate license if subscription went back to active (e.g. payment recovered)
        if (sub.status === 'active' && userId) {
          await supabase.from('licenses')
            .update({ status: 'active' })
            .eq('user_id', userId).eq('plan', 'monthly');
          console.log(`[LICENSE_REACTIVATED] userId=${userId} reason=subscription_back_to_active`);
        }

        if (userId) await auditLog(userId, 'subscription_updated', {
          status:             sub.status,
          cancel_at_period_end: sub.cancel_at_period_end,
          period_end:         periodEnd,
        });
        break;
      }

      // ── Subscription deleted / fully canceled (period has ended) ──────────
      // This fires AFTER the billing period ends for cancel_at_period_end subs,
      // and immediately for instant-cancel. Either way, revoke access now.
      case 'customer.subscription.deleted': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

        console.log(`[SUB_DELETED_ACCESS_REVOKED] subId=${sub.id} userId=${userId ?? 'unknown'} periodEnd=${periodEnd} — deactivating license`);

        await supabase.from('subscriptions')
          .update({ status: 'canceled', cancel_at_period_end: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        if (userId) {
          await deactivateLicense(userId);
          await auditLog(userId, 'subscription_canceled', { periodEnd });
        }
        break;
      }

      // ── Invoice paid (renewal confirmed) ─────────────────────────────────
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId   = invoice.subscription as string | null;
        if (!subId) break;

        // Retrieve the subscription to get the updated current_period_end
        const renewedSub = await stripe.subscriptions.retrieve(subId);
        const periodEnd  = new Date(renewedSub.current_period_end * 1000).toISOString();

        await supabase.from('subscriptions')
          .update({ status: 'active', current_period_end: periodEnd, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        console.log(`[INVOICE_PAID_SUB_ACTIVE] subId=${subId} periodEnd=${periodEnd}`);
        break;
      }

      // ── Invoice payment failed → mark past_due ────────────────────────────
      // Subscription status is set to past_due. The license verify endpoint
      // only allows 'active' subscriptions (paid-only — 'trialing' is denied),
      // so bot access is denied during past_due. Access is restored when Stripe retries
      // successfully and fires invoice.paid (which resets status to 'active').
      // We do NOT call deactivateLicense here — that only happens on subscription.deleted.
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId   = invoice.subscription as string | null;
        if (!subId) break;

        await supabase.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        console.warn(`[INVOICE_PAYMENT_FAILED] subId=${subId} — marked past_due; access retained during Stripe retry window`);
        break;
      }

      // ── Refund → reverse any referral accrual ─────────────────────────────
      // Lifetime sales are final, but refunds still occur (goodwill, error,
      // legal requirement). The referrer must not keep a reward for a purchase
      // that was returned. Append-only: a negative ledger row, never an edit.
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;

        const result = await reverseReferralForCharge({
          paymentIntentId,
          stripeEventId: event.id,
          cause:         'refund',
        });
        console.log(
          `[CHARGE_REFUNDED] charge=${charge.id} pi=${paymentIntentId ?? 'none'} ` +
          `referralReversed=${result.reversed} reason=${result.reason ?? 'ok'}`
        );
        break;
      }

      // ── Chargeback → reverse any referral accrual ────────────────────────
      // A dispute is outside our control regardless of what the Terms say, so
      // this path must exist for the program to be safe.
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null;

        const result = await reverseReferralForCharge({
          paymentIntentId,
          stripeEventId: event.id,
          cause:         'dispute',
        });
        console.warn(
          `[CHARGE_DISPUTE_CREATED] dispute=${dispute.id} pi=${paymentIntentId ?? 'none'} ` +
          `referralReversed=${result.reversed} reason=${result.reason ?? 'ok'}`
        );
        break;
      }

      // ── Abandoned checkout → close out the referrer's pending entry ───────
      // Purely cosmetic bookkeeping: it moves a "code applied" row to "checkout
      // not completed" so a referrer is not left staring at an entry that will
      // never pay. No ledger involvement whatsoever.
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.referrer_user_id) {
          await settleReservation(session.id, 'expired');
          console.log(`[CHECKOUT_SESSION_EXPIRED] session=${session.id} referralReservationClosed=true`);
        }
        break;
      }

      // ── Connect account state (referral payouts) ──────────────────────────
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        await syncConnectAccount({
          id:                account.id,
          payouts_enabled:   account.payouts_enabled,
          details_submitted: account.details_submitted,
          requirements:      account.requirements,
        });
        break;
      }

      // Note: past_due / unpaid / incomplete_expired statuses are synced via
      // customer.subscription.updated (status field mirrors the Stripe sub status).
      // Access is retained until customer.subscription.deleted fires.
    }

    await supabase
      .from('stripe_events')
      .update({ status: 'handled', handled_at: new Date().toISOString() })
      .eq('event_id', event.id);

  } catch (err: any) {
    console.error(`[webhook] handler error for ${event.type}:`, {
      message: err.message,
      cause:   err.cause,
      stack:   err.stack?.split('\n').slice(0, 4).join(' | '),
    });

    // Release the idempotency claim so Stripe's retry can actually re-run the
    // handler. Without this the retry would short-circuit as a duplicate and
    // the failure would be permanent — the exact silent-loss failure mode this
    // rewrite exists to remove.
    await supabase.from('stripe_events').delete().eq('event_id', event.id);

    // Return 500 so Stripe retries with backoff. Previously this returned 200
    // unconditionally, which suppressed all retries.
    return NextResponse.json(
      { error: 'Webhook handler failed', event_type: event.type },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}
