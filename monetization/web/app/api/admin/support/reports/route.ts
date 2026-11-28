import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { ADMIN_REPORT_COLUMNS, DESKTOP_REPORT_COLUMNS, getPublicAppVersion } from '@/lib/supportReports';
import { supportReportWindow } from '@/lib/supportReportWindow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-only support queue. This projection is intentionally never customer-facing. */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  // The desktop app gets the narrowed projection; the web admin keeps the full
  // one. Anything other than the explicit `desktop` opt-in falls back to the
  // web projection, so a typo cannot silently widen the desktop response.
  const columns = req.nextUrl.searchParams.get('view') === 'desktop'
    ? DESKTOP_REPORT_COLUMNS
    : ADMIN_REPORT_COLUMNS;

  const svc = createServiceClient();
  const window = supportReportWindow(req.nextUrl.searchParams.get('range'));
  let query = svc
    .from('support_reports')
    .select(columns);
  query = window.range === 'older'
    ? query.lt('created_at', window.cutoff)
    : query.gte('created_at', window.cutoff);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error(`[api/admin/support/reports] query failed: ${error.message}`);
    return NextResponse.json({ ok: false, error: 'Could not load support reports.' }, { status: 500 });
  }

  const publicAppVersion = await getPublicAppVersion();
  return NextResponse.json({ ok: true, publicAppVersion, reports: data ?? [], range: window.range, cutoff: window.cutoff });
}
