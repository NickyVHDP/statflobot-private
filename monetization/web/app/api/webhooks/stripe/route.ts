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

          await supabase.from('subscriptions').upsert({
            user_id:               userId,
            stripe_customer_id:    customerId,
            stripe_subscription_id: subId,
            stripe_price_id:       stripeSub.items.data[0]?.price.id,
            status:                stripeSub.status,
            current_period_end:    new Date(stripeSub.current_period_end * 1000).toISOString(),
            cancel_at_period_end:  stripeSub.cancel_at_period_end,
            updated_at:            new Date().toISOString(),
          }, { onConflict: 'stripe_subscription_id' });

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
            await supabase.from('early_bird_sales').upsert({
              stripe_session_id: session.id,
              user_id:           userId,
              created_at:        new Date().toISOString(),
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });
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
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;

        await supabase.from('subscriptions')
          .update({
            status:               sub.status,
            current_period_end:   new Date(sub.current_period_end * 1000).toISOString(),
            cancel_at_period_end: sub.cancel_at_period_end,
            updated_at:           new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        // Re-activate license if subscription went back to active
        if (sub.status === 'active' && userId) {
          await supabase.from('licenses')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('plan', 'monthly');
        }

        if (userId) await auditLog(userId, 'subscription_updated', { status: sub.status });
        break;
      }

      // ── Subscription deleted / fully canceled ─────────────────────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;

        await supabase.from('subscriptions')
          .update({ status: 'canceled', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        if (userId) {
          await deactivateLicense(userId);
          await auditLog(userId, 'subscription_canceled', {});
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
        break;
      }

      // ── Invoice payment failed ────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId   = invoice.subscription as string | null;
        if (!subId) break;

        await supabase.from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);

        // NOTE: we don't immediately deactivate on first failure.
        // Stripe will retry; final deletion event triggers deactivation.
        break;
      }
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
