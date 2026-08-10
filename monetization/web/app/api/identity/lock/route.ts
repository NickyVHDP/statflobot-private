import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

function normalizeIdentity(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/@cellularsales\.com$/, '');
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const rawInput: string = body.identityKey ?? body.statfloEmail ?? body.detectedRaw ?? '';
  const rawValue: string = body.detectedRaw ?? rawInput;
  const identityKey = normalizeIdentity(rawInput);

  if (!identityKey || identityKey.length < 3) {
    return NextResponse.json({ error: 'identityKey required' }, { status: 400 });
  }

  const svc = createServiceClient();

  const { data: licenses, error: licenseErr } = await svc
    .from('licenses')
    .select('id, user_id, statflo_identity, statflo_identity_raw')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (licenseErr) {
    if (
      licenseErr.message?.includes('statflo_identity') ||
      licenseErr.message?.includes('statflo_identity_raw') ||
      licenseErr.code === '42703'
    ) {
      console.warn(`[identity-lock] column missing — migration required userId=${user.id}`);
      return NextResponse.json({ ok: true, action: 'column-missing', identityKey });
    }

    console.error(`[identity-lock] license fetch error userId=${user.id}:`, licenseErr.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (!licenses?.length) {
    console.warn(`[identity-lock] no license row found for userId=${user.id}`);
    return NextResponse.json({ error: 'License not found' }, { status: 404 });
  }

  const lockedLicense = licenses.find((row: any) => normalizeIdentity(row.statflo_identity));
  const currentKey = normalizeIdentity((lockedLicense as any)?.statflo_identity ?? '');

  if (currentKey && currentKey !== identityKey) {
    console.log(`[IDENTITY_MISMATCH] userId=${user.id} locked=${currentKey} attempted=${identityKey}`);
    return NextResponse.json(
      { ok: false, reason: 'mismatch', lockedKey: currentKey },
      { status: 409 }
    );
  }

  if (currentKey === identityKey && currentKey.length > 0) {
    console.log(`[IDENTITY_MATCHED] userId=${user.id} key=${identityKey}`);
    return NextResponse.json({ ok: true, action: 'matched', identityKey });
  }

  const updatePayload: Record<string, string> = {
    statflo_identity: identityKey,
  };

  if (rawValue) {
    updatePayload.statflo_identity_raw = rawValue;
  }

  const { error: updateErr } = await svc
    .from('licenses')
    .update(updatePayload)
    .eq('user_id', user.id);

  if (updateErr) {
    if (
      updateErr.message?.includes('statflo_identity_raw') ||
      updateErr.code === '42703'
    ) {
      const { error: retryErr } = await svc
        .from('licenses')
        .update({ statflo_identity: identityKey })
        .eq('user_id', user.id);

      if (retryErr) {
        if (
          retryErr.message?.includes('statflo_identity') ||
          retryErr.code === '42703'
        ) {
          console.warn('[identity-lock] statflo_identity column missing — migration required');
          return NextResponse.json({ ok: true, action: 'column-missing', identityKey });
        }

        console.error(`[identity-lock] retry update error userId=${user.id}:`, retryErr.message);
        return NextResponse.json({ error: 'Database error' }, { status: 500 });
      }
    } else {
      console.error(`[identity-lock] update error userId=${user.id}:`, updateErr.message);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }
  }

  console.log(`[IDENTITY_LOCKED] userId=${user.id} key=${identityKey} raw=${rawValue}`);
  return NextResponse.json({ ok: true, action: 'locked', identityKey });
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();

  const { data: licenses, error } = await svc
    .from('licenses')
    .select('statflo_identity, statflo_identity_raw')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    if (
      error.message?.includes('statflo_identity') ||
      error.message?.includes('statflo_identity_raw') ||
      error.code === '42703'
    ) {
      return NextResponse.json({ identityKey: null, rawValue: null, note: 'column-missing' });
    }

    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const license = licenses?.find((row: any) => normalizeIdentity(row.statflo_identity)) ?? licenses?.[0] ?? null;

  return NextResponse.json({
    identityKey: (license as any)?.statflo_identity ?? null,
    rawValue: (license as any)?.statflo_identity_raw ?? null,
  });
}
