import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';
import Stripe from 'stripe';

/**
 * POST /api/billing/portal
 * Returns a Stripe Billing Portal URL for the authenticated user.
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 *
 * Recovery strategy when stripe_customer_id is missing:
 *   Path A — retrieve Stripe subscription by stripe_subscription_id (precise, no email ambiguity)
 *   Path B — search Stripe customers by email (fallback; also creates subscription row if missing)
 *
 * On any successful repair, the subscriptions row is backfilled so future
 * requests skip the lookup entirely.
 */
export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data: sub } = await svc
    .from('subscriptions')
    .select('id, stripe_customer_id, stripe_subscription_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  console.log(
    `[billing/portal] user=${user.id} email=${user.email} ` +
    `sub.id=${sub?.id ?? 'none'} ` +
    `sub.stripe_subscription_id=${sub?.stripe_subscription_id ?? 'none'} ` +
    `sub.stripe_customer_id=${sub?.stripe_customer_id ?? 'none'}`
  );

  let customerId: string | null = sub?.stripe_customer_id ?? null;

  // ── Path A: recover from stripe_subscription_id ───────────────────────────
  // Most precise — avoids email-search ambiguity when a user has multiple
  // Stripe customer records (e.g. different purchase emails, test mode records).
  if (!customerId && sub?.stripe_subscription_id) {
    try {
      const retrieved = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const c = retrieved.customer;
      const recovered: string | null =
        typeof c === 'string' ? c : (c as { id: string } | null)?.id ?? null;

      console.log(`[billing/portal] path-A: sub=${sub.stripe_subscription_id} customer=${recovered ?? 'null'}`);

      if (recovered) {
        customerId = recovered;
        await svc.from('subscriptions')
          .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
          .eq('id', sub.id);
        console.log(`[billing/portal] path-A: backfilled stripe_customer_id=${customerId} sub=${sub.id}`);
      }
    } catch (err: any) {
      console.warn(`[billing/portal] path-A: subscription retrieve failed: ${err.message}`);
    }
  }

  // ── Path B: email search (fallback) ──────────────────────────────────────
  // Used when no stripe_subscription_id is available, OR when path A failed.
  // Also creates the subscription row from scratch when none exists at all.
  if (!customerId && user.email) {
    try {
      const customers = await stripe.customers.list({ email: user.email, limit: 5 });
      console.log(`[billing/portal] path-B: email search found ${customers.data.length} customer(s) for ${user.email}`);

      if (customers.data.length > 0) {
        // Prefer a customer that currently has an active subscription
        let found: string | null = null;
        for (const customer of customers.data) {
          const activeSubs = await stripe.subscriptions.list({
            customer: customer.id,
            status:   'active',
            limit:    1,
          });
          console.log(`[billing/portal] path-B: customer=${customer.id} active_subs=${activeSubs.data.length}`);
          if (activeSubs.data.length) { found = customer.id; break; }
        }
        customerId = found ?? customers.data[0].id;

        if (customerId) {
          if (sub?.id) {
            // Backfill existing row
            await svc.from('subscriptions')
              .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
              .eq('id', sub.id);
            console.log(`[billing/portal] path-B: backfilled stripe_customer_id=${customerId} sub=${sub.id}`);
          } else {
            // No subscription row — create one from live Stripe data so the
            // dashboard shows "Manage / cancel subscription" on next load.
            await createMissingSubscriptionRow(svc, stripe, user.id, customerId);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[billing/portal] path-B: email customer lookup failed: ${err.message}`);
    }
  }

  if (!customerId) {
    console.warn(`[billing/portal] no Stripe customer found for user=${user.id}`);
    return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
  }

  const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: returnUrl,
    });
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[billing/portal] portal session create failed:', err.message);
    return NextResponse.json({ error: 'Failed to open billing portal' }, { status: 500 });
  }
}

/**
 * Create a subscription row from live Stripe data when none exists.
 * Called from path B when we found a Stripe customer but no DB row.
 * Non-fatal — logs and continues if the insert fails.
 */
async function createMissingSubscriptionRow(
  svc: ReturnType<typeof createServiceClient>,
  stripe: Stripe,
  userId: string,
  customerId: string,
) {
  try {
    const activeSubs = await stripe.subscriptions.list({
      customer: customerId,
      status:   'active',
      limit:    1,
    });
    const stripeSub = activeSubs.data[0] ?? null;
    const now = new Date().toISOString();

    const { error } = await svc.from('subscriptions').insert({
      user_id:                userId,
      stripe_customer_id:     customerId,
      stripe_subscription_id: stripeSub?.id ?? null,
      stripe_price_id:        stripeSub?.items.data[0]?.price.id ?? null,
      status:                 stripeSub?.status ?? 'active',
      current_period_end:     stripeSub
        ? new Date(stripeSub.current_period_end * 1000).toISOString()
        : null,
      cancel_at_period_end:   stripeSub?.cancel_at_period_end ?? false,
      created_at:             now,
      updated_at:             now,
    });

    if (error) {
      console.warn(`[billing/portal] could not create subscription row: ${error.message}`);
    } else {
      console.log(`[billing/portal] created subscription row for user=${userId} customer=${customerId} sub=${stripeSub?.id ?? 'none'}`);
    }
  } catch (err: any) {
    console.warn(`[billing/portal] createMissingSubscriptionRow failed: ${err.message}`);
  }
}
