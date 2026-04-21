import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

/**
 * POST /api/billing/portal
 * Returns a Stripe Billing Portal URL for the authenticated user.
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 */
export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data: sub } = await svc
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!sub?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
  }

  const returnUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   sub.stripe_customer_id,
      return_url: returnUrl,
    });
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[billing/portal]', err.message);
    return NextResponse.json({ error: 'Failed to open billing portal' }, { status: 500 });
  }
}
