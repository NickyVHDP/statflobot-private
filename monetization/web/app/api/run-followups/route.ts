import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

const MAX_BODY = 2000;

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('run_followup_messages')
    .select('id, bot_run_id, sender_role, body, read_at, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return NextResponse.json({ ok: false, error: 'Could not load follow-up messages' }, { status: 500 });

  await svc.from('run_followup_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('sender_role', 'owner')
    .is('read_at', null);

  return NextResponse.json({ ok: true, messages: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  const payload = await req.json().catch(() => ({}));
  const runId = String(payload?.runId ?? '').trim();
  const body = String(payload?.body ?? '').trim();
  if (!runId || !body) return NextResponse.json({ ok: false, error: 'Run and reply are required' }, { status: 400 });
  if (body.length > MAX_BODY) return NextResponse.json({ ok: false, error: 'Reply is too long' }, { status: 400 });

  const svc = createServiceClient();
  const { data: prior, error: priorError } = await svc.from('run_followup_messages')
    .select('bot_run_id')
    .eq('bot_run_id', runId)
    .eq('user_id', user.id)
    .eq('sender_role', 'owner')
    .limit(1)
    .maybeSingle();
  if (priorError || !prior) return NextResponse.json({ ok: false, error: 'No owner follow-up exists for this run' }, { status: 403 });

  const { data, error } = await svc.from('run_followup_messages').insert({
    bot_run_id: runId,
    user_id: user.id,
    sender_user_id: user.id,
    sender_role: 'customer',
    body,
  }).select('id, bot_run_id, sender_role, body, read_at, created_at').single();
  if (error) return NextResponse.json({ ok: false, error: 'Reply could not be sent' }, { status: 500 });
  return NextResponse.json({ ok: true, message: data });
}
