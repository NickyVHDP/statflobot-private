import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { ADMIN_REPORT_COLUMNS } from '@/lib/supportReports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-only support queue. This projection is intentionally never customer-facing. */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('support_reports')
    .select(ADMIN_REPORT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error(`[api/admin/support/reports] query failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: 'Could not load support reports.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reports: data ?? [] });
}
