import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { getStripe, PRICE_IDS } from '@/lib/stripe';
import { getPricingWindow } from '@/lib/pricing';
import { TERMS_VERSION, reserveReferral, validateReferralCode } from '@/lib/referrals';
import Stripe from 'stripe';

/**
 * POST /api/checkout/lifetime
 *
 * Works for both logged-in and guest (purchase-first) users.
 *
 * Logged-in  → user_id + email embedded in metadata; success → /dashboard?checkout=success
 * Guest      → email only; success → /auth/sign-in?checkout=pending
 *              Webhook stores a pending_purchases row; reconciled on next sign-in.
 *
 * LIFETIME SALES ARE FINAL. Two independent acceptance records are captured:
 *
 *   1. Stripe Checkout's own `consent_collection.terms_of_service: 'required'`
 *      checkbox, which requires a Terms URL configured in the Stripe Dashboard
 *      and lands on the completed session as `consent.terms_of_service`.
 *   2. Our own versioned acceptance, re-recorded server-side into session
 *      metadata. The client checkbox alone is never treated as evidence.
 *
 * REFERRALS are lifetime-only and must be applied BEFORE the session exists.
 * The resolved referrer is frozen into metadata here; there is no code path
 * anywhere that attaches a referrer to an already-created session.
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
  const requestBody = await req.json().catch(() => ({} as any));
  const desktopCheckout = requestBody?.source === 'desktop';

  // ── Final-sale acknowledgment (required on every lifetime path) ───────────
  // Enforced server-side so the desktop app cannot become a bypass for the
  // web checkbox, and vice versa.
  if (requestBody?.termsAccepted !== true) {
    console.warn(`[LIFETIME_TERMS_NOT_ACCEPTED] source=${desktopCheckout ? 'desktop' : 'web'}`);
    return NextResponse.json(
      {
        error:
          'You must acknowledge that lifetime purchases are final and non-refundable before continuing.',
        code: 'terms-required',
      },
      { status: 400 }
    );
  }
  const termsAcceptedAt = new Date().toISOString();

  // ── Referral code (optional, lifetime-only, must precede the session) ─────
  let referral: { codeId: string; code: string; referrerUserId: string } | null = null;
  const rawReferral = typeof requestBody?.referralCode === 'string' ? requestBody.referralCode : '';

  if (rawReferral.trim()) {
    const result = await validateReferralCode(rawReferral, {
      userId: user?.id ?? null,
      email:  user?.email ?? null,
    });

    if (!result.valid) {
      // Fail the request rather than proceeding silently. A buyer who believes
      // they used a code and did not will contact support, and the referrer
      // will never be creditable for this purchase afterwards.
      console.warn(`[REFERRAL_REJECTED_AT_CHECKOUT] reason=${result.reason} user=${user?.id ?? 'guest'}`);
      const message =
        result.reason === 'self-referral'
          ? 'You cannot use your own referral code.'
          : result.reason === 'not-new-user'
            ? 'Referral codes apply to first-time purchases only.'
            : 'That referral code is not valid. Remove it to continue, or check the code and try again.';
      return NextResponse.json({ error: message, code: `referral-${result.reason}` }, { status: 400 });
    }

    referral = {
      codeId:         result.codeId!,
      code:           result.code!,
      referrerUserId: result.referrerUserId!,
    };
    console.log(`[REFERRAL_ACCEPTED_AT_CHECKOUT] code=${referral.code} referrer=${referral.referrerUserId}`);
  }

  // Frozen snapshot written into both Checkout and PaymentIntent metadata.
  // Stripe metadata values must be strings.
  const referralMetadata: Record<string, string> = referral
    ? {
        referral_code:            referral.code,
        referral_code_id:         referral.codeId,
        referrer_user_id:         referral.referrerUserId,
      }
    : {};

  const termsMetadata: Record<string, string> = {
    terms_version:     TERMS_VERSION,
    terms_accepted_at: termsAcceptedAt,
    final_sale:        'true',
  };

  // Stripe's own Terms-of-Service consent checkbox. Requires a Terms URL set in
  // Dashboard → Settings → Checkout and Payment Links. If it is missing, Stripe
  // rejects session creation and we surface that as a configuration error
  // rather than a generic payment failure (see the catch block).
  const consentCollection: Stripe.Checkout.SessionCreateParams.ConsentCollection = {
    terms_of_service: 'required',
  };

  try {
    let sessionParams: Stripe.Checkout.SessionCreateParams;

    if (user) {
      const supabase = createServiceClient();
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: lifetimeLicense } = await supabase
        .from('licenses')
        .select('id')
        .eq('user_id', user.id)
        .eq('plan', 'lifetime')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (existingSub?.status === 'lifetime' || lifetimeLicense) {
        return NextResponse.json({ error: 'Your account already has lifetime access.' }, { status: 409 });
      }

      sessionParams = {
        mode:                'payment',
        line_items:          [{ price: priceId, quantity: 1 }],
        consent_collection:  consentCollection,
        ...(existingSub?.stripe_customer_id
          ? { customer: existingSub.stripe_customer_id }
          : { customer_email: user.email ?? undefined }),
        client_reference_id: user.id,
        success_url:         desktopCheckout
          ? `${appUrl}/checkout/success?source=desktop&plan=lifetime`
          : `${appUrl}/dashboard?checkout=success`,
        cancel_url:          `${appUrl}/?checkout=canceled`,
        metadata:            { plan_code: planCode, user_id: user.id, ...termsMetadata, ...referralMetadata },
        payment_intent_data: {
          metadata: { plan_code: planCode, user_id: user.id, ...termsMetadata, ...referralMetadata },
        },
      };
    } else {
      sessionParams = {
        mode:                'payment',
        line_items:          [{ price: priceId, quantity: 1 }],
        consent_collection:  consentCollection,
        success_url:         `${appUrl}/auth/sign-in?checkout=pending`,
        cancel_url:          `${appUrl}/?checkout=canceled`,
        metadata:            { plan_code: planCode, unlinked: 'true', ...termsMetadata, ...referralMetadata },
        payment_intent_data: {
          metadata: { plan_code: planCode, unlinked: 'true', ...termsMetadata, ...referralMetadata },
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // ── Show the referrer a pending entry immediately ─────────────────────
    // Records "this code was applied to this session" so the referrer sees it
    // before the payment lands. Non-monetary and BEST EFFORT: a failure here
    // must never fail a checkout, and the accrual path does not read it — the
    // reward is driven entirely by the Stripe metadata frozen above.
    if (referral) {
      try {
        await reserveReferral({
          stripeSessionId: session.id,
          referralCodeId:  referral.codeId,
          referralCode:    referral.code,
          referrerUserId:  referral.referrerUserId,
          referredEmail:   user?.email ?? null,
          planCode,
        });
      } catch (reserveErr: any) {
        console.warn('[REFERRAL_RESERVATION_SKIPPED]', reserveErr?.message ?? reserveErr);
      }
    }

    console.log(
      `[CHECKOUT_API_SUCCESS] plan=lifetime session=${session.id} user=${user?.id ?? 'guest'} ` +
      `referral=${referral?.code ?? 'none'} termsVersion=${TERMS_VERSION}`
    );
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    const message = String(err?.message ?? '');

    // Stripe rejects consent_collection when no Terms of Service URL is set in
    // the Dashboard. That is a one-time configuration step, not a transient
    // payment problem, so it gets its own actionable error instead of the
    // generic "temporarily unavailable" message.
    if (/terms.of.service/i.test(message) || /consent_collection/i.test(message)) {
      console.error(
        '[CHECKOUT_TOS_URL_MISSING] Stripe rejected consent_collection.terms_of_service. ' +
        'Set the Terms of Service URL in Stripe Dashboard → Settings → Checkout and Payment Links ' +
        `(use ${appUrl}/terms), then retry. Stripe said: ${message}`
      );
      return NextResponse.json(
        {
          error:
            'Checkout is not fully configured yet. Please contact support — no charge was made.',
          code: 'stripe-tos-url-missing',
          detail:
            'Stripe requires a Terms of Service URL in Dashboard → Settings → Checkout and Payment ' +
            `Links before the required terms checkbox can be shown. Set it to ${appUrl}/terms.`,
        },
        { status: 503 }
      );
    }

    console.error('[CHECKOUT_API_ERROR] plan=lifetime', message);
    return NextResponse.json(
      { error: 'Payment is temporarily unavailable. Please try again or contact support.' },
      { status: 500 }
    );
  }
}
