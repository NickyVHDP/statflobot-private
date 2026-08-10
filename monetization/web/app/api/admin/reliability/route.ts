import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { classifyReliabilityLog, isReportableFailure } from '@/lib/reliability';

const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 500;

type ReliabilityRunRow = {
  id: string;
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
 * Fleet-wide, owner-only reliability review. Customer identifiers are never
 * selected or returned. Diagnostic text was sanitized before bot_runs insert.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const svc = createServiceClient();
  const projection = 'id, created_at, list_name, mode, status, sent_count, skipped_count, failed_count, raw_log_sanitized, app_version, platform';
  const { data, error, count } = await svc
    .from('bot_runs')
    .select(projection, { count: 'exact' })
    .gte('created_at', cutoff)
    .or('failed_count.gt.0,status.in.(failed,error,completed_with_errors,browser_closed)')
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error('[api/admin/reliability] query failed:', error.message);
    return NextResponse.json({ ok: false, error: 'Failed to load reliability review' }, { status: 500 });
  }

  // Apply the same predicate in-process as a defensive check if database
  // status values evolve. Never include user_id, email, profile, or license.
  const rows = (data ?? []) as ReliabilityRunRow[];
  const runs = rows.filter(isReportableFailure).map((run) => ({
    ...run,
    ...classifyReliabilityLog(run.raw_log_sanitized),
  }));

  const categories: Record<string, number> = runs.reduce((summary: Record<string, number>, run) => {
    summary[run.category] = (summary[run.category] ?? 0) + 1;
    return summary;
  }, {});
  const versions: Record<string, number> = runs.reduce((summary: Record<string, number>, run) => {
    const version = run.app_version || 'unknown';
    summary[version] = (summary[version] ?? 0) + 1;
    return summary;
  }, {});

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    retentionDays: HISTORY_DAYS,
    totalCount: count ?? runs.length,
    truncated: (count ?? runs.length) > runs.length,
    privacy: 'owner-only; customer identities omitted; diagnostics sanitized',
    categories,
    versions,
    runs,
  });
}
