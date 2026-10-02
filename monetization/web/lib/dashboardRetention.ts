import { createServiceClient } from '@/lib/supabase/server';

export const DASHBOARD_RETENTION_DAYS = 30;

export type DashboardRetentionResult = {
  cutoff: string;
  deletedRuns: number;
  deletedReports: number;
};

/**
 * Remove dashboard-only operational history after 30 days.
 *
 * Run rows (including their sanitized diagnostic excerpts) always expire.
 * Support reports expire only after they are resolved or closed so an old,
 * unanswered customer request can never disappear from the owner's queue.
 * Billing, subscriptions, referrals and payout records live in separate tables
 * and are deliberately outside this cleanup.
 */
export async function cleanDashboardHistory(now = Date.now()): Promise<DashboardRetentionResult> {
  const cutoff = new Date(now - DASHBOARD_RETENTION_DAYS * 86_400_000).toISOString();
  const svc = createServiceClient();

  const { data: deletedRuns, error: runsError } = await svc
    .from('bot_runs')
    .delete()
    .lt('created_at', cutoff)
    .select('id');
  if (runsError) throw new Error(`Run history cleanup failed: ${runsError.message}`);

  const { data: deletedReports, error: reportsError } = await svc
    .from('support_reports')
    .delete()
    .lt('created_at', cutoff)
    .in('status', ['resolved', 'closed'])
    .select('id');
  if (reportsError) throw new Error(`Support history cleanup failed: ${reportsError.message}`);

  return {
    cutoff,
    deletedRuns: deletedRuns?.length ?? 0,
    deletedReports: deletedReports?.length ?? 0,
  };
}
