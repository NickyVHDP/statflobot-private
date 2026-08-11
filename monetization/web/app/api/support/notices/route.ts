import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import {
  CUSTOMER_NOTICE_COLUMNS,
  getPublicAppVersion,
  toCustomerNotice,
  type CustomerNoticeRow,
} from '@/lib/supportReports';

/**
 * GET /api/support/notices
 *
 * The authenticated customer's own support reports, reduced to the safe
 * customer-facing fields. Used by the desktop app at startup to decide whether
 * to show a resolution notice, and by the Account screen to list past reports.
 *
 * Ownership comes from the verified session only. The service-role client is
 * used because the table has no `authenticated` grants at all — there is no
 * direct PostgREST path to these rows, so `.eq('user_id', user.id)` here is the
 * one and only scope check, and it is not optional.
 *
 * `installedVersion` is a query param rather than a stored value: it changes
 * nothing but which button this user sees on their own notice, so an
 * unverifiable client value is harmless. The decision that could mislead them —
 * whether the fix is actually downloadable — is made server-side.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOTICE_LIMIT = 25;

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const installedVersion = req.nextUrl.searchParams.get('installedVersion');

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('support_reports')
    .select(CUSTOMER_NOTICE_COLUMNS)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(NOTICE_LIMIT);

  if (error) {
    console.error(`[api/support/notices] query failed userId=${user.id}: ${error.message}`);
    return NextResponse.json({ ok: false, error: 'Could not load your support reports.' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as CustomerNoticeRow[];
  const reports = rows.map((row) => toCustomerNotice(row, installedVersion));

  // Oldest first so a customer with a backlog is told about the earliest issue
  // they reported, not the most recent one.
  const pending = reports
    .filter((r) => r.status === 'resolved' && !r.acknowledgedAt && r.resolutionMessage)
    .sort((a, b) => String(a.resolvedAt ?? '').localeCompare(String(b.resolvedAt ?? '')));

  return NextResponse.json({
    ok: true,
    publicAppVersion: getPublicAppVersion(),
    pendingNotice: pending[0] ?? null,
    pendingCount: pending.length,
    reports,
  });
}
