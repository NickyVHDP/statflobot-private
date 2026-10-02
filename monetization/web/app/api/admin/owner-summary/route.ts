import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_MS = 5 * 60 * 1000;
let cached: { key: string; summary: string; expiresAt: number } | null = null;

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
      topFailingVersion: typeof body?.reliability?.topVersion?.version === 'string'
        ? body.reliability.topVersion.version.slice(0, 40)
        : null,
      topFailingVersionShare: number(body?.reliability?.topVersion?.share, 1),
    },
    payouts: {
      outstandingCents: number(body?.referrals?.outstandingCents, 100_000_000),
      negativeBalances: number(body?.referrals?.negativeBalances, 100_000),
      unconvertedApplications: number(body?.referrals?.unconvertedApplications, 100_000),
      payoutsEnabled: body?.referrals?.payoutsEnabled === true,
    },
  };
}

function responseText(payload: any): string {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();
  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
    }
  }
  return '';
}

/** Owner-only AI briefing generated exclusively from aggregate business metrics. */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'Owner AI briefing is not configured.' }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body was not valid JSON.' }, { status: 400 });
  }
  const metrics = normalizeMetrics(body);
  const cacheKey = createHash('sha256').update(JSON.stringify(metrics)).digest('hex');
  if (cached?.key === cacheKey && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, summary: cached.summary, cached: true });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OWNER_SUMMARY_MODEL || 'gpt-5.6-luna',
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 450,
        text: { verbosity: 'low' },
        instructions:
          'You are the StatfloBot owner operations assistant. Give a concise, practical owner briefing from aggregate metrics only. ' +
          'Start with one plain sentence, followed by at most four short bullet points ordered by urgency. ' +
          'Prioritize unhappy customers, failed communications, payout risk, run failures, and adoption. ' +
          'Do not invent causes, identities, or actions not supported by the numbers. ' +
          'Do not recommend automatic money movement or contacting a customer without owner review. ' +
          'If nothing needs action, say so and mention one useful positive trend.',
        input: `Current owner metrics:\n${JSON.stringify(metrics, null, 2)}`,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[admin/owner-summary] OpenAI request failed status=${response.status} code=${payload?.error?.code ?? 'unknown'}`);
      return NextResponse.json({ ok: false, error: 'The AI owner briefing is temporarily unavailable.' }, { status: 502 });
    }
    const summary = responseText(payload).slice(0, 2_500);
    if (!summary) {
      return NextResponse.json({ ok: false, error: 'The AI owner briefing returned no summary.' }, { status: 502 });
    }
    cached = { key: cacheKey, summary, expiresAt: Date.now() + CACHE_MS };
    return NextResponse.json({ ok: true, summary, cached: false });
  } catch (error) {
    console.error(`[admin/owner-summary] request error: ${error instanceof Error ? error.message : 'unknown error'}`);
    return NextResponse.json({ ok: false, error: 'The AI owner briefing is temporarily unavailable.' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
