import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runAutomaticReferralPayouts } from '@/lib/referralAutoPayouts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/referral-payouts
 *
 * The only scheduled money-moving entry point. Vercel Cron calls it once a day
 * with `Authorization: Bearer $CRON_SECRET`; the schedule lives in vercel.json.
 *
 * Everything about it fails closed: an unset CRON_SECRET rejects every request,
 * a wrong secret is rejected in constant time, and the run itself refuses to pay
 * unless both feature flags, every configured limit, the recipient's bank and
 * the Financial Account balance all agree. A duplicate delivery loses the daily
 * lease and pays nothing.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[REFERRAL_AUTO_PAYOUT_CRON_UNCONFIGURED] CRON_SECRET is not set');
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(req.headers.get('authorization') ?? '');
  // Length must be compared separately — timingSafeEqual throws on a mismatch.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runAutomaticReferralPayouts();
    console.log(
      `[REFERRAL_AUTO_PAYOUT_RUN] date=${summary.runDate} skipped=${summary.skipped ?? 'no'} ` +
      `results=${summary.results.length} reminders=${summary.remindersSent}`
    );
    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    // The detail stays in the server log: this response is reachable by anyone
    // holding the cron secret, and it should never narrate account internals.
    console.error('[REFERRAL_AUTO_PAYOUT_CRON_FAILED]', String(err?.message ?? err));
    return NextResponse.json({ error: 'Automatic payout run failed closed.' }, { status: 500 });
  }
}
