import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

// Max length for the sanitized log field (matches the reporter's MAX_LOG_CHARS)
const MAX_LOG_BYTES = 10_000;

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

  const { error } = await svc.from('bot_runs').insert({
    user_id:           user.id,
    list_name:         list_name  ? String(list_name).slice(0, 200)  : null,
    mode:              mode       ? String(mode).slice(0, 50)        : null,
    status:            String(status ?? 'completed').slice(0, 50),
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
    console.error('[api/runs] insert error:', error.message);
    return NextResponse.json({ error: 'Failed to save run' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
