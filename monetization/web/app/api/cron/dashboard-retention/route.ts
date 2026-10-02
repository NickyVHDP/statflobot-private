import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { cleanDashboardHistory, DASHBOARD_RETENTION_DAYS } from '@/lib/dashboardRetention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(req.headers.get('authorization') ?? '');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Daily automatic cleanup. Unresolved support reports and all money records remain. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const result = await cleanDashboardHistory();
    console.log(
      `[DASHBOARD_RETENTION_COMPLETE] cutoff=${result.cutoff} runs=${result.deletedRuns} reports=${result.deletedReports}`,
    );
    return NextResponse.json({ ok: true, retentionDays: DASHBOARD_RETENTION_DAYS, ...result });
  } catch (err: any) {
    console.error('[DASHBOARD_RETENTION_FAILED]', String(err?.message ?? err));
    return NextResponse.json({ error: 'Dashboard retention cleanup failed.' }, { status: 500 });
  }
}
