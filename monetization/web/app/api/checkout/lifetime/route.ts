import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { getStripe, PRICE_IDS } from '@/lib/stripe';
import { getPricingWindow } from '@/lib/pricing';
import Stripe from 'stripe';

/**
 * POST /api/checkout/lifetime
 *
 * Works for both logged-in and guest (purchase-first) users.
 *
 * Logged-in  → user_id + email embedded in metadata; success → /dashboard?checkout=success
 * Guest      → email only; success → /auth/sign-in?checkout=pending
 *              Webhook stores a pending_purchases row; reconciled on next sign-in.
 */
export async function POST(req: NextRequest) {
  console.log('[CHECKOUT_API_START] plan=lifetime');

  // Validate required env vars before hitting Stripe.
  const missingEnv = [
    !process.env.STRIPE_SECRET_KEY                && 'STRIPE_SECRET_KEY',
    !process.env.STRIPE_PRICE_LIFETIME_EARLY      && 'STRIPE_PRICE_LIFETIME_EARLY',
    !process.env.STRIPE_PRICE_LIFETIME_STANDARD   && 'STRIPE_PRICE_LIFETIME_STANDARD',
    !process.env.NEXT_PUBLIC_APP_URL              && 'NEXT_PUBLIC_APP_URL',
  ].filter(Boolean);

  if (missingEnv.length > 0) {
    console.error('[CHECKOUT_API_ERROR] plan=lifetime missing env vars:', missingEnv.join(', '));
    return NextResponse.json(
      { error: 'Payment is temporarily unavailable. Please try again or contact support.', detail: `Missing config: ${missingEnv.join(', ')}` },
      { status: 503 }
    );
  }

  const stripe  = getStripe();
  const user    = await getAuthUser(req);
  const pricing = await getPricingWindow();

  const priceId  = pricing.isEarlyAdopter ? PRICE_IDS.lifetime_early : PRICE_IDS.lifetime_standard;
  const planCode = pricing.lifetime_plan_code;
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL!;

  try {
    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (user) {
      sessionParams = {
        mode:                'payment',
        line_items:          [{ price: priceId, quantity: 1 }],
        customer_email:      user.email ?? undefined,
        client_reference_id: user.id,
        success_url:         `${appUrl}/dashboard?checkout=success`,
        cancel_url:          `${appUrl}/?checkout=canceled`,
        metadata:            { plan_code: planCode, user_id: user.id },
        payment_intent_data: { metadata: { plan_code: planCode, user_id: user.id } },
      };
    } else {
      sessionParams = {
        mode:                'payment',
        line_items:          [{ price: priceId, quantity: 1 }],
        success_url:         `${appUrl}/auth/sign-in?checkout=pending`,
        cancel_url:          `${appUrl}/?checkout=canceled`,
        metadata:            { plan_code: planCode, unlinked: 'true' },
        payment_intent_data: { metadata: { plan_code: planCode, unlinked: 'true' } },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log(`[CHECKOUT_API_SUCCESS] plan=lifetime session=${session.id} user=${user?.id ?? 'guest'}`);
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('[CHECKOUT_API_ERROR] plan=lifetime', err.message);
    return NextResponse.json(
      { error: 'Payment is temporarily unavailable. Please try again or contact support.' },
      { status: 500 }
    );
  }
}
