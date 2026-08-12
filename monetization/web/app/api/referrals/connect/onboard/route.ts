import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { hasRealLifetimeEntitlement } from '@/lib/referrals';
import { createOnboardingLink } from '@/lib/referralPayouts';
import { isAdminEmail } from '@/lib/admin';

/**
 * POST /api/referrals/connect/onboard
 *
 * Returns a Stripe-hosted Connect onboarding link so a referrer can connect a
 * bank account. Identity and bank details are collected entirely by Stripe —
 * this application never sees, transmits or stores them.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  if (isAdminEmail(user.email)) {
    return NextResponse.json(
      { error: 'Administrator accounts do not participate in the referral program.' },
      { status: 403 }
    );
  }

  if (!(await hasRealLifetimeEntitlement(user.id))) {
    return NextResponse.json(
      { error: 'Bank onboarding is available to lifetime customers in the referral program.' },
      { status: 403 }
    );
  }

  const result = await createOnboardingLink(user.id, user.email);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  console.log(`[REFERRAL_CONNECT_LINK_ISSUED] userId=${user.id}`);
  return NextResponse.json({ url: result.url });
}
