import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, createServiceClient } from '@/lib/supabase/server';
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
  const requestBody = await req.json().catch(() => ({} as any));
  const desktopCheckout = requestBody?.source === 'desktop';

  // ── Referrals are lifetime-only, structurally ─────────────────────────────
  // This route never accepts a referral code. Rejecting outright (rather than
  // ignoring the field) means a client that wrongly sends one fails loudly in
  // testing instead of silently promising a reward that will never accrue.
  // This is one of four independent layers enforcing the lifetime-only rule;
  // see lib/referrals.ts.
  if (requestBody?.referralCode) {
    console.warn('[REFERRAL_REJECTED_ON_MONTHLY] referral codes are lifetime-only');
    return NextResponse.json(
      { error: 'Referral codes apply to lifetime purchases only.', code: 'referral-lifetime-only' },
      { status: 400 }
    );
  }

  // SAFEGUARD: monthly plan MUST use mode='subscription' (recurring billing).
  // Never change this to 'payment' — that would create a one-time charge.
  const CHECKOUT_MODE = 'subscription' as const;
  console.log(`[CHECKOUT_RECURRING_VERIFIED] mode=${CHECKOUT_MODE} price=${PRICE_IDS.monthly} — recurring monthly billing confirmed`);

  try {
    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (user) {
      // For returning subscribers, reuse their existing Stripe customer ID to avoid
      // creating duplicate customers and ensure the webhook can always resolve userId.
      const supabase = createServiceClient();
      const { data: existingSub, error: existingSubError } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, stripe_subscription_id, status, current_period_end')
        .eq('user_id', user.id)
        .not('stripe_customer_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingSubError) throw new Error(`Subscription lookup failed: ${existingSubError.message}`);

      const { data: lifetimeLicense, error: lifetimeLicenseError } = await supabase
        .from('licenses')
        .select('id')
        .eq('user_id', user.id)
        .eq('plan', 'lifetime')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (lifetimeLicenseError) throw new Error(`Lifetime license lookup failed: ${lifetimeLicenseError.message}`);

      const existingCustomerId = existingSub?.stripe_customer_id ?? null;
      const periodStillOpen = existingSub?.current_period_end
        ? new Date(existingSub.current_period_end) > new Date()
        : false;
      const existingNeedsPortal = !!lifetimeLicense || existingSub?.status === 'lifetime' ||
        (!!existingSub?.stripe_subscription_id && existingSub.status !== 'canceled') ||
        (!!existingSub?.stripe_subscription_id && periodStillOpen);
      if (existingNeedsPortal) {
        return NextResponse.json({
          error: lifetimeLicense || existingSub?.status === 'lifetime'
            ? 'Your account already has lifetime access.'
            : 'A monthly subscription already exists for this account. Manage or restore it from Billing instead of creating a duplicate.',
          action: 'billing',
        }, { status: 409 });
      }
      console.log(`[MONTHLY_CHECKOUT_CREATED] userId=${user.id} email=${user.email ?? 'none'} existingCustomer=${existingCustomerId ?? 'none (new)'}`);

      sessionParams = {
        mode:                CHECKOUT_MODE,
        line_items:          [{ price: PRICE_IDS.monthly, quantity: 1 }],
        ...(existingCustomerId
          ? { customer: existingCustomerId }              // reuse existing Stripe customer
          : { customer_email: user.email ?? undefined }), // new customer
        client_reference_id: user.id,
        success_url:         desktopCheckout
          ? `${appUrl}/checkout/success?source=desktop&plan=monthly`
          : `${appUrl}/dashboard?checkout=success`,
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
