import { NextRequest, NextResponse } from 'next/server';
import { isAdminEmail } from '@/lib/admin';
import { cleanDashboardHistory, DASHBOARD_RETENTION_DAYS } from '@/lib/dashboardRetention';
import { getAuthUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-triggered cleanup from the desktop command center. */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  try {
    const result = await cleanDashboardHistory();
    return NextResponse.json({ ok: true, retentionDays: DASHBOARD_RETENTION_DAYS, ...result });
  } catch (err: any) {
    console.error('[ADMIN_DASHBOARD_RETENTION_FAILED]', String(err?.message ?? err));
    return NextResponse.json({ ok: false, error: 'Dashboard cleanup failed.' }, { status: 500 });
  }
}
