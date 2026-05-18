import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

/**
 * POST /api/billing/portal
 * Returns a Stripe Billing Portal URL for the authenticated user.
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 *
 * If stripe_customer_id is missing from the subscription row, falls back to
 * a Stripe customer search by email and backfills the row so future requests
 * skip the lookup.
 */
export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data: sub } = await svc
    .from('subscriptions')
    .select('id, stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  let customerId: string | null = sub?.stripe_customer_id ?? null;

  // If stripe_customer_id is missing, try to recover it via Stripe customer search.
  // Covers edge cases where the webhook or reconcile left the column null.
  if (!customerId && user.email) {
    try {
      const customers = await stripe.customers.list({ email: user.email, limit: 5 });
      if (customers.data.length > 0) {
        // Prefer a customer that has an active subscription
        let found: string | null = null;
        for (const customer of customers.data) {
          const activeSubs = await stripe.subscriptions.list({
            customer: customer.id,
            status:   'active',
            limit:    1,
          });
          if (activeSubs.data.length) { found = customer.id; break; }
        }
        customerId = found ?? customers.data[0].id;

        // Backfill the row so future portal opens don't need this lookup
        if (sub?.id && customerId) {
          await svc.from('subscriptions')
            .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
            .eq('id', sub.id);
          console.log(`[billing/portal] repaired stripe_customer_id=${customerId} sub=${sub.id}`);
        }
      }
    } catch (err: any) {
      console.warn('[billing/portal] stripe customer lookup failed:', err.message);
    }
  }

  if (!customerId) {
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
    console.error('[billing/portal]', err.message);
    return NextResponse.json({ error: 'Failed to open billing portal' }, { status: 500 });
  }
}
