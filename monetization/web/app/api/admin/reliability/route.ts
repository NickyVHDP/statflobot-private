import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { classifyReliabilityLog, isReportableFailure } from '@/lib/reliability';

const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 500;

type ReliabilityRunRow = {
  id: string;
  user_id: string;
  created_at: string;
  list_name: string | null;
  mode: string | null;
  status: string;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  raw_log_sanitized: string | null;
  app_version: string | null;
  platform: string | null;
};

/**
 * GET /api/admin/reliability
 * Fleet-wide, owner-only run activity and reliability review. Account identity
 * is returned only to the verified owner so they can tell who is actively using
 * the product; customer/contact data from Statflo and message content remain
 * excluded. Diagnostic text was sanitized before bot_runs insert.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const svc = createServiceClient();
  const projection = 'id, user_id, created_at, list_name, mode, status, sent_count, skipped_count, failed_count, raw_log_sanitized, app_version, platform';
  const { data, error, count } = await svc
    .from('bot_runs')
    .select(projection, { count: 'exact' })
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error('[api/admin/reliability] query failed:', error.message);
    return NextResponse.json({ ok: false, error: 'Failed to load reliability review' }, { status: 500 });
  }

  const rows = (data ?? []) as ReliabilityRunRow[];
  const userIds = [...new Set(rows.map((run) => run.user_id).filter(Boolean))];
  const { data: profiles, error: profilesError } = userIds.length
    ? await svc.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [], error: null };
  if (profilesError) {
    console.warn(`[api/admin/reliability] profile lookup failed: ${profilesError.message}`);
  }
  const profilesById = new Map((profiles ?? []).map((profile: any) => [profile.id, profile]));

  const runs = rows.map((run) => {
    const reportableFailure = isReportableFailure(run);
    const classification = reportableFailure
      ? classifyReliabilityLog(run.raw_log_sanitized)
      : { category: 'successful', categoryLabel: 'Completed run', markers: [] };
    const profile: any = profilesById.get(run.user_id);
    const { user_id: _userId, raw_log_sanitized, ...safeRun } = run;
    return {
      ...safeRun,
      ...classification,
      reportableFailure,
      actorEmail: profile?.email ?? 'Unknown account',
      actorName: profile?.full_name || null,
      raw_log_sanitized: reportableFailure ? raw_log_sanitized : null,
    };
  });
  const failureRuns = runs.filter((run) => run.reportableFailure);

  const categories: Record<string, number> = failureRuns.reduce((summary: Record<string, number>, run) => {
    summary[run.category] = (summary[run.category] ?? 0) + 1;
    return summary;
  }, {});
  const versions: Record<string, number> = failureRuns.reduce((summary: Record<string, number>, run) => {
    const version = run.app_version || 'unknown';
    summary[version] = (summary[version] ?? 0) + 1;
    return summary;
  }, {});

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    retentionDays: HISTORY_DAYS,
    totalCount: count ?? runs.length,
    failureCount: failureRuns.length,
    truncated: (count ?? runs.length) > runs.length,
    privacy: 'owner-only account identity; Statflo customer identities and message content omitted; diagnostics sanitized',
    categories,
    versions,
    runs,
  });
}
