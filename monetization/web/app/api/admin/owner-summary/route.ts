import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const number = (value: unknown, max = 10_000_000) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : 0;
};

function normalizeMetrics(body: any) {
  return {
    support: {
      openReports: number(body?.support?.openCount, 10_000),
      emailFailures: number(body?.support?.emailFailures, 10_000),
      oldestOpenAt: typeof body?.support?.oldestOpenAt === 'string'
        ? body.support.oldestOpenAt.slice(0, 40)
        : null,
    },
    runs: {
      retainedRuns: number(body?.reliability?.totalRuns, 1_000_000),
      runsLast24h: number(body?.reliability?.runsLast24h, 1_000_000),
      activeUsers7d: number(body?.reliability?.activeUsers7d, 1_000_000),
      messagesSentLast24h: number(body?.reliability?.sentLast24h, 10_000_000),
      failuresLast24h: number(body?.reliability?.last24h, 1_000_000),
      priorDailyFailureAverage: number(body?.reliability?.priorDailyAverage, 1_000_000),
      unclassifiedFailures: number(body?.reliability?.unclassified, 1_000_000),
      publicAppVersion: typeof body?.reliability?.publicAppVersion === 'string'
        ? body.reliability.publicAppVersion.slice(0, 40)
        : null,
      outdatedUsers: number(body?.reliability?.outdatedUsers, 1_000_000),
    },
    payouts: {
      outstandingCents: number(body?.referrals?.outstandingCents, 100_000_000),
      negativeBalances: number(body?.referrals?.negativeBalances, 100_000),
      unconvertedApplications: number(body?.referrals?.unconvertedApplications, 100_000),
      payoutsEnabled: body?.referrals?.payoutsEnabled === true,
    },
  };
}

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * A small deterministic briefing engine is a better fit than a remote language
 * model here: the input is already structured, the possible owner actions are
 * known, and this stays free, private, fast, and testable.
 */
function buildBriefing(metrics: ReturnType<typeof normalizeMetrics>) {
  const bullets: string[] = [];
  const { support, runs, payouts } = metrics;

  if (support.emailFailures > 0) {
    bullets.push(`Check ${support.emailFailures} failed support email${support.emailFailures === 1 ? '' : 's'} first so customers receive your replies.`);
  }
  if (support.openReports > 0) {
    bullets.push(`Review ${support.openReports} open support report${support.openReports === 1 ? '' : 's'}${support.oldestOpenAt ? `; the oldest was opened ${support.oldestOpenAt.slice(0, 10)}` : ''}.`);
  }
  if (payouts.negativeBalances > 0) {
    bullets.push(`Hold payout approval for ${payouts.negativeBalances} negative referral balance${payouts.negativeBalances === 1 ? '' : 's'} until reviewed.`);
  } else if (payouts.outstandingCents > 0) {
    bullets.push(`${dollars(payouts.outstandingCents)} in referral rewards is still clearing, eligible, or in transit.`);
  }
  if (runs.outdatedUsers > 0) {
    bullets.push(`${runs.outdatedUsers} user${runs.outdatedUsers === 1 ? '' : 's'} most recently ran an older build${runs.publicAppVersion ? `; the current release is ${runs.publicAppVersion}` : ''}.`);
  }
  if (runs.failuresLast24h > 0) {
    bullets.push(`Inspect ${runs.failuresLast24h} failed run${runs.failuresLast24h === 1 ? '' : 's'} from the last 24 hours.`);
  }
  if (bullets.length === 0) {
    bullets.push(`${runs.activeUsers7d} active user${runs.activeUsers7d === 1 ? '' : 's'} ran StatfloBot in the last 7 days with no urgent owner action detected.`);
  }

  const headline = bullets.length === 1 && support.openReports === 0 && support.emailFailures === 0
    ? 'Nothing urgent needs your attention right now.'
    : 'Here is what deserves your attention right now.';
  return `${headline}\n${bullets.slice(0, 4).map(item => `• ${item}`).join('\n')}`;
}

/** Owner-only, free briefing generated exclusively from aggregate business metrics. */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body was not valid JSON.' }, { status: 400 });
  }
  const metrics = normalizeMetrics(body);
  return NextResponse.json({ ok: true, summary: buildBriefing(metrics), engine: 'built-in' });
}
