import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { getOrCreateReferralCode } from '@/lib/referrals';

/**
 * POST /api/referrals/code
 *
 * Returns the caller's single referral code, minting it on first request.
 *
 * Eligibility is a REAL active lifetime entitlement — the admin bypass account
 * is excluded, because lib/admin.ts hands admins a synthetic lifetime license
 * that does not correspond to a purchase.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const result = await getOrCreateReferralCode(user.id, user.email);

  if (!result.ok) {
    const status = result.reason === 'error' ? 500 : 403;
    const message =
      result.reason === 'not-lifetime'
        ? 'Referral codes are available to lifetime customers only.'
        : result.reason === 'admin-excluded'
          ? 'Administrator accounts cannot hold a referral code.'
          : result.reason === 'disabled'
            ? 'Your referral code has been disabled. Contact support if you believe this is an error.'
            : 'Could not issue a referral code right now. Please try again.';

    console.warn(`[REFERRAL_CODE_DENIED] userId=${user.id} reason=${result.reason}`);
    return NextResponse.json({ error: message, code: result.reason }, { status });
  }

  return NextResponse.json({ code: result.code });
}
