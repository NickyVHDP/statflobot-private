import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { getStripe, PRICE_IDS } from '@/lib/stripe';
import Stripe from 'stripe';

/**
 * POST /api/checkout/monthly
 *
 * Works for both logged-in and guest (purchase-first) users.
 *
 * Logged-in  → user_id + email embedded in metadata; success → /dashboard?checkout=success
 * Guest      → email only; success → /auth/sign-in?checkout=pending
 *              Webhook stores a pending_purchases row; reconciled on next sign-in.
 */
export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const user   = await getAuthUser(req);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  try {
    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (user) {
      sessionParams = {
        mode:                'subscription',
        line_items:          [{ price: PRICE_IDS.monthly, quantity: 1 }],
        customer_email:      user.email ?? undefined,
        client_reference_id: user.id,
        success_url:         `${appUrl}/dashboard?checkout=success`,
        cancel_url:          `${appUrl}/?checkout=canceled`,
        metadata:            { plan_code: 'monthly', user_id: user.id },
        subscription_data:   { metadata: { plan_code: 'monthly', user_id: user.id } },
      };
    } else {
      sessionParams = {
        mode:              'subscription',
        line_items:        [{ price: PRICE_IDS.monthly, quantity: 1 }],
        success_url:       `${appUrl}/auth/sign-in?checkout=pending`,
        cancel_url:        `${appUrl}/?checkout=canceled`,
        metadata:          { plan_code: 'monthly', unlinked: 'true' },
        subscription_data: { metadata: { plan_code: 'monthly', unlinked: 'true' } },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[checkout/monthly]', err.message);
    return NextResponse.json({ error: 'Checkout failed' }, { status: 500 });
  }
}
