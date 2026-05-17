import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { provisionLicense, deactivateLicense, auditLog } from '@/lib/license';
import Stripe from 'stripe';

/**
 * POST /api/webhooks/stripe
 *
 * Handles all Stripe lifecycle events. Signature-verified via webhook secret.
 *
 * Events handled:
 *   checkout.session.completed        → provision license + subscription row
 *   customer.subscription.updated     → sync status, period_end
 *   customer.subscription.deleted     → cancel + deactivate
 *   invoice.paid                      → keep subscription active
 *   invoice.payment_failed            → mark past_due
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

  try {
    switch (event.type) {

      // ── Checkout completed ────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.Checkout.Session;
        console.log(`[CHECKOUT_SESSION_COMPLETED] session=${session.id} mode=${session.mode} planCode=${session.metadata?.plan_code ?? 'none'} userId=${session.metadata?.user_id ?? session.client_reference_id ?? 'unknown'}`);
        let   userId     = session.metadata?.user_id || session.client_reference_id || '';
        const planCode   = session.metadata?.plan_code;
        const customerId = session.customer as string | null;

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
          await supabase.from('pending_purchases').upsert({
            stripe_session_id:       session.id,
            email:                   pendingEmail,
            plan_code:                planCode,
            stripe_customer_id:      customerId,
            stripe_subscription_id:  session.mode === 'subscription'
              ? (session.subscription as string | null)
              : null,
            status:    'pending',
            metadata:  { mode: session.mode },
            created_at: new Date().toISOString(),
          }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });

          console.warn('[webhook] no userId — stored pending_purchase for', pendingEmail);
          await auditLog(null, 'pending_purchase_stored', {
            stripe_session_id: session.id,
            email:             pendingEmail,
            plan_code:         planCode,
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
          const subId  = session.subscription as string;
          const stripeSub = await stripe.subscriptions.retrieve(subId);

          console.log(`[MONTHLY_SUB_UPSERT_ATTEMPT] userId=${userId} subId=${subId} status=${stripeSub.status}`);
          const { error: subUpsertError } = await supabase.from('subscriptions').upsert({
            user_id:                userId,
            stripe_customer_id:     customerId,
            stripe_subscription_id: subId,
            stripe_price_id:        stripeSub.items.data[0]?.price.id,
            status:                 stripeSub.status,
            current_period_end:     new Date(stripeSub.current_period_end * 1000).toISOString(),
            cancel_at_period_end:   stripeSub.cancel_at_period_end,
            created_at:             new Date().toISOString(),
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'stripe_subscription_id' });

          if (subUpsertError) {
            console.error(`[MONTHLY_SUB_UPSERT_FAILED] userId=${userId} subId=${subId} error=${subUpsertError.message}`);
          } else {
            console.log(`[MONTHLY_SUB_UPSERT_SUCCESS] userId=${userId} subId=${subId} status=${stripeSub.status}`);
          }

        } else if (session.mode === 'payment') {
          // ── Lifetime one-time payment ─────────────────────────────────────
          await supabase.from('subscriptions').upsert({
            user_id:            userId,
            stripe_customer_id: customerId,
            status:             'lifetime',
            updated_at:         new Date().toISOString(),
          }, { onConflict: 'user_id' });

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
        await auditLog(userId, 'checkout_completed', { planCode, licensePlan, licenseKey });
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
            .update({ status: 'active', updated_at: new Date().toISOString() })
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

        await supabase.from('subscriptions')
          .update({ status: 'active', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        console.log(`[INVOICE_PAID_SUB_ACTIVE] subId=${subId}`);
        break;
      }

      // ── Invoice payment failed → mark past_due ────────────────────────────
      // Subscription status is set to past_due. The license verify endpoint
      // only allows 'active' and 'trialing' subscriptions, so bot access is
      // denied during past_due. Access is restored when Stripe retries
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

      // Note: past_due / unpaid / incomplete_expired statuses are synced via
      // customer.subscription.updated (status field mirrors the Stripe sub status).
      // Access is retained until customer.subscription.deleted fires.
    }
  } catch (err: any) {
    console.error(`[webhook] handler error for ${event.type}:`, {
      message: err.message,
      cause:   err.cause,
      stack:   err.stack?.split('\n').slice(0, 4).join(' | '),
    });
    // Return 200 so Stripe doesn't retry — investigate via server logs.
  }

  return NextResponse.json({ received: true });
}
