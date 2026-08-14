import { NextRequest, NextResponse } from 'next/server';
import { runAutomaticReferralPayouts } from '@/lib/referralAutoPayouts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Daily Vercel cron. Authentication and every money-moving flag fail closed. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runAutomaticReferralPayouts();
    return NextResponse.json({ ok: true, summary });
  } catch (err: any) {
    console.error('[REFERRAL_AUTO_PAYOUT_CRON_FAILED]', String(err?.message ?? err));
    return NextResponse.json({ error: 'Automatic payout run failed closed.' }, { status: 500 });
  }
}
