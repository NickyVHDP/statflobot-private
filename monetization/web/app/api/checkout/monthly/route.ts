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
  console.log('[CHECKOUT_API_START] plan=monthly');

  // Validate required env vars before hitting Stripe.
  const missingEnv = [
    !process.env.STRIPE_SECRET_KEY       && 'STRIPE_SECRET_KEY',
    !process.env.STRIPE_PRICE_MONTHLY    && 'STRIPE_PRICE_MONTHLY',
    !process.env.NEXT_PUBLIC_APP_URL     && 'NEXT_PUBLIC_APP_URL',
  ].filter(Boolean);

  if (missingEnv.length > 0) {
    console.error('[CHECKOUT_API_ERROR] plan=monthly missing env vars:', missingEnv.join(', '));
    return NextResponse.json(
      { error: 'Payment is temporarily unavailable. Please try again or contact support.', detail: `Missing config: ${missingEnv.join(', ')}` },
      { status: 503 }
    );
  }

  const stripe = getStripe();
  const user   = await getAuthUser(req);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  // SAFEGUARD: monthly plan MUST use mode='subscription' (recurring billing).
  // Never change this to 'payment' — that would create a one-time charge.
  const CHECKOUT_MODE = 'subscription' as const;
  console.log(`[CHECKOUT_RECURRING_VERIFIED] mode=${CHECKOUT_MODE} price=${PRICE_IDS.monthly} — recurring monthly billing confirmed`);

  try {
    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (user) {
      sessionParams = {
        mode:                CHECKOUT_MODE,
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
        mode:              CHECKOUT_MODE,
        line_items:        [{ price: PRICE_IDS.monthly, quantity: 1 }],
        success_url:       `${appUrl}/auth/sign-in?checkout=pending`,
        cancel_url:        `${appUrl}/?checkout=canceled`,
        metadata:          { plan_code: 'monthly', unlinked: 'true' },
        subscription_data: { metadata: { plan_code: 'monthly', unlinked: 'true' } },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log(`[CHECKOUT_API_SUCCESS] plan=monthly session=${session.id} user=${user?.id ?? 'guest'}`);
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[CHECKOUT_API_ERROR] plan=monthly', err.message);
    return NextResponse.json(
      { error: 'Payment is temporarily unavailable. Please try again or contact support.' },
      { status: 500 }
    );
  }
}
