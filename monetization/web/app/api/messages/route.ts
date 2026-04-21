import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

/**
 * GET /api/messages
 * Returns the authenticated user's saved 2nd/3rd attempt messages.
 * Returns empty strings if no messages have been saved yet.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data } = await svc
    .from('user_messages')
    .select('second_attempt_message, third_attempt_message')
    .eq('user_id', user.id)
    .single();

  return NextResponse.json({
    secondAttemptMessage: data?.second_attempt_message ?? '',
    thirdAttemptMessage:  data?.third_attempt_message  ?? '',
  });
}

/**
 * POST /api/messages
 * Saves the authenticated user's 2nd/3rd attempt messages.
 * Body: { secondAttemptMessage: string, thirdAttemptMessage: string }
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { secondAttemptMessage, thirdAttemptMessage } = body;
  if (typeof secondAttemptMessage !== 'string' || typeof thirdAttemptMessage !== 'string') {
    return NextResponse.json({ error: 'secondAttemptMessage and thirdAttemptMessage must be strings' }, { status: 400 });
  }

  const svc = createServiceClient();
  await svc.from('user_messages').upsert({
    user_id:                 user.id,
    second_attempt_message:  secondAttemptMessage.trim(),
    third_attempt_message:   thirdAttemptMessage.trim(),
    updated_at:              new Date().toISOString(),
  }, { onConflict: 'user_id' });

  return NextResponse.json({
    ok: true,
    secondAttemptMessage: secondAttemptMessage.trim(),
    thirdAttemptMessage:  thirdAttemptMessage.trim(),
  });
}
