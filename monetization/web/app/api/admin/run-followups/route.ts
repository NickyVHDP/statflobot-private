import { NextRequest, NextResponse } from 'next/server';
import { isAdminEmail } from '@/lib/admin';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

const MAX_BODY = 2000;

export async function GET(req: NextRequest) {
  const owner = await getAuthUser(req);
  if (!owner) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(owner.email)) return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });

  const runId = new URL(req.url).searchParams.get('runId')?.trim();
  if (!runId) return NextResponse.json({ ok: false, error: 'runId is required' }, { status: 400 });

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('run_followup_messages')
    .select('id, bot_run_id, sender_role, body, read_at, created_at')
    .eq('bot_run_id', runId)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return NextResponse.json({ ok: false, error: 'Could not load this conversation' }, { status: 500 });

  await svc.from('run_followup_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('bot_run_id', runId)
    .eq('sender_role', 'customer')
    .is('read_at', null);

  return NextResponse.json({ ok: true, messages: data ?? [] });
}

export async function POST(req: NextRequest) {
  const owner = await getAuthUser(req);
  if (!owner) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(owner.email)) return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 });

  const payload = await req.json().catch(() => ({}));
  const runId = String(payload?.runId ?? '').trim();
  const body = String(payload?.body ?? '').trim();
  if (!runId || !body) return NextResponse.json({ ok: false, error: 'Run and message are required' }, { status: 400 });
  if (body.length > MAX_BODY) return NextResponse.json({ ok: false, error: 'Message is too long' }, { status: 400 });

  const svc = createServiceClient();
  const { data: run, error: runError } = await svc.from('bot_runs').select('id, user_id').eq('id', runId).maybeSingle();
  if (runError || !run?.user_id) return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });

  const { data, error } = await svc.from('run_followup_messages').insert({
    bot_run_id: run.id,
    user_id: run.user_id,
    sender_user_id: owner.id,
    sender_role: 'owner',
    body,
  }).select('id, bot_run_id, sender_role, body, read_at, created_at').single();
  if (error) return NextResponse.json({ ok: false, error: 'Message could not be sent' }, { status: 500 });
  return NextResponse.json({ ok: true, message: data });
}
