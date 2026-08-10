import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

// Max length for the sanitized log field (matches the reporter's MAX_LOG_CHARS)
const MAX_LOG_BYTES = 10_000;
const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 100;

function normalizeStatus(value: unknown): string {
  const requested = String(value ?? 'completed');
  return /^[a-z][a-z0-9_-]{0,49}$/.test(requested) ? requested : 'recorded';
}

/**
 * GET /api/runs
 * Returns this authenticated user's sanitized cloud run history. The desktop
 * app uses this account-scoped endpoint so history survives restarts and is
 * consistent across the customer's registered computers.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const svc = createServiceClient();
  const { data, error, count } = await svc
    .from('bot_runs')
    .select('id, created_at, list_name, mode, status, sent_count, skipped_count, failed_count, raw_log_sanitized, app_version, platform', { count: 'exact' })
    .eq('user_id', user.id)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    console.error(`[api/runs] history error userId=${user.id}:`, error.message);
    return NextResponse.json({ ok: false, error: 'Failed to load run history' }, { status: 500 });
  }

  const runs = data ?? [];
  return NextResponse.json({
    ok: true,
    retentionDays: HISTORY_DAYS,
    totalCount: count ?? runs.length,
    truncated: (count ?? runs.length) > runs.length,
    runs,
  });
}

/**
 * POST /api/runs
 * Called by the desktop bot after every completed/failed/stopped run.
 * Authenticated via Bearer JWT (the user's Supabase access token).
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    list_name,
    mode,
    status         = 'completed',
    sent_count     = 0,
    skipped_count  = 0,
    failed_count   = 0,
    raw_log_sanitized,
    app_version,
    platform,
  } = body;

  const svc = createServiceClient();
  const normalizedStatus = normalizeStatus(status);

  const { error } = await svc.from('bot_runs').insert({
    user_id:           user.id,
    list_name:         list_name  ? String(list_name).slice(0, 200)  : null,
    mode:              mode       ? String(mode).slice(0, 50)        : null,
    status:            normalizedStatus,
    sent_count:        Math.max(0, Number(sent_count)    || 0),
    skipped_count:     Math.max(0, Number(skipped_count) || 0),
    failed_count:      Math.max(0, Number(failed_count)  || 0),
    raw_log_sanitized: raw_log_sanitized
      ? String(raw_log_sanitized).slice(0, MAX_LOG_BYTES)
      : null,
    app_version: app_version ? String(app_version).slice(0, 50) : null,
    platform:    platform    ? String(platform).slice(0, 50)    : null,
  });

  if (error) {
    console.error(`[api/runs] insert error userId=${user.id}:`, error.message);
    return NextResponse.json({ error: 'Failed to save run' }, { status: 500 });
  }

  console.log(`[api/runs] saved userId=${user.id} status=${String(status).slice(0, 50)} sent=${Number(sent_count) || 0}`);
  return NextResponse.json({ ok: true });
}
