import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { isValidReportReference, sanitizeSupportDiagnosticText } from '@/lib/supportReports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Owner-only, on-demand support diagnostics.
 *
 * The ordinary desktop queue remains metadata-only. This separately guarded
 * route resolves one sanitized bot_runs excerpt only after an owner asks for a
 * specific report, so neither customers nor the broad queue receive logs.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ reference: string }> },
) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  const { reference: rawReference } = await context.params;
  const reference = String(rawReference ?? '').trim().toUpperCase();
  if (!isValidReportReference(reference)) {
    return NextResponse.json({ ok: false, error: 'Invalid report reference' }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: report, error: reportError } = await svc
    .from('support_reports')
    .select('reference, user_id, bot_run_id, created_at, run_status, app_version, platform, log_attached, log_reference, log_unavailable_reason')
    .eq('reference', reference)
    .maybeSingle();

  if (reportError) {
    console.error(`[admin/support/diagnostics] report query failed ref=${reference}: ${reportError.message}`);
    return NextResponse.json({ ok: false, error: 'Could not load report diagnostics.' }, { status: 500 });
  }
  if (!report) return NextResponse.json({ ok: false, error: 'Support report not found' }, { status: 404 });

  let run: any = null;
  let source: 'linked-run' | 'nearby-run' = 'linked-run';
  if (report.bot_run_id) {
    const { data, error } = await svc
      .from('bot_runs')
      .select('id, created_at, status, app_version, platform, raw_log_sanitized')
      .eq('id', report.bot_run_id)
      .eq('user_id', report.user_id)
      .maybeSingle();
    if (error) console.warn(`[admin/support/diagnostics] linked run query failed ref=${reference}: ${error.message}`);
    run = data;
  }

  // Backward compatibility for reports created before automatic run linking.
  // Match only this account, a tight time window, the same status/platform, and
  // choose the nearest timestamp. This recovers historical logs without ever
  // returning a different customer's run.
  if (!run?.raw_log_sanitized) {
    source = 'nearby-run';
    const reportMs = new Date(report.created_at).getTime();
    const windowStart = new Date(reportMs - 30 * 60 * 1000).toISOString();
    const windowEnd = new Date(reportMs + 5 * 60 * 1000).toISOString();
    let query = svc
      .from('bot_runs')
      .select('id, created_at, status, app_version, platform, raw_log_sanitized')
      .eq('user_id', report.user_id)
      .gte('created_at', windowStart)
      .lte('created_at', windowEnd)
      .not('raw_log_sanitized', 'is', null);
    if (report.run_status) query = query.eq('status', report.run_status);
    if (report.platform) query = query.eq('platform', report.platform);
    const { data: candidates, error } = await query.order('created_at', { ascending: false }).limit(10);
    if (error) {
      console.error(`[admin/support/diagnostics] nearby run query failed ref=${reference}: ${error.message}`);
      return NextResponse.json({ ok: false, error: 'Could not load report diagnostics.' }, { status: 500 });
    }
    run = (candidates ?? []).sort((a: any, b: any) =>
      Math.abs(new Date(a.created_at).getTime() - reportMs) -
      Math.abs(new Date(b.created_at).getTime() - reportMs)
    )[0] ?? null;
  }

  if (!run?.raw_log_sanitized) {
    return NextResponse.json({
      ok: false,
      error: report.log_unavailable_reason || 'No retained sanitized diagnostics were found for this report.',
      reason: 'diagnostics-unavailable',
    }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    reference,
    source,
    runCreatedAt: run.created_at,
    runStatus: run.status,
    appVersion: run.app_version,
    platform: run.platform,
    log: sanitizeSupportDiagnosticText(run.raw_log_sanitized),
  });
}
