import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

/**
 * Normalize a raw Statflo identity to a comparable key.
 *
 * Rules:
 *   1. lowercase
 *   2. trim whitespace
 *   3. strip @cellularsales.com domain if present
 *   4. compare final first.last key
 *
 * Examples:
 *   John.Smith@cellularsales.com  →  john.smith
 *   JOHN.SMITH                    →  john.smith
 */
function normalizeIdentity(raw: string): string {
  return raw.trim().toLowerCase().replace(/@cellularsales\.com$/, '');
}

/**
 * POST /api/identity/lock
 * Called by the desktop server to lock or verify the Statflo username.
 *
 * - First call: locks the normalized identity key in profiles.statflo_identity
 *   and the raw value in profiles.statflo_identity_raw.
 * - Subsequent calls: verifies normalized key matches.
 * - Mismatch: 409.
 *
 * Body: { identityKey: string, detectedRaw?: string }
 *   (also accepts legacy { statfloEmail } for backwards compat)
 * Auth: Bearer JWT
 *
 * Responses:
 *   200 { ok: true,  action: 'locked'|'matched'|'column-missing', identityKey }
 *   409 { ok: false, reason: 'mismatch', lockedKey }
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  // Accept identityKey (new) or statfloEmail (legacy v1.0.33)
  const rawInput: string = body.identityKey ?? body.statfloEmail ?? '';
  const rawValue: string = body.detectedRaw  ?? rawInput;

  if (!rawInput || rawInput.trim().length < 3) {
    return NextResponse.json({ error: 'identityKey required (min 3 chars)' }, { status: 400 });
  }

  const identityKey = normalizeIdentity(rawInput);
  const svc = createServiceClient();

  // Read current locked identity key
  const { data: profile, error: profileErr } = await svc
    .from('profiles')
    .select('statflo_identity, statflo_identity_raw')
    .eq('id', user.id)
    .single();

  if (profileErr && profileErr.code !== 'PGRST116') {
    if (profileErr.message?.includes('statflo_identity') || profileErr.code === '42703') {
      console.warn(`[identity-lock] column missing — migration required (userId=${user.id})`);
      return NextResponse.json({ ok: true, action: 'column-missing', identityKey });
    }
    console.error(`[identity-lock] profile fetch error userId=${user.id}:`, profileErr.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const currentKey = normalizeIdentity((profile as any)?.statflo_identity ?? '');

  // Mismatch — block
  if (currentKey && currentKey !== identityKey) {
    console.log(`[IDENTITY_MISMATCH] userId=${user.id} locked=${currentKey} attempted=${identityKey}`);
    return NextResponse.json({ ok: false, reason: 'mismatch', lockedKey: currentKey }, { status: 409 });
  }

  // Already locked to the same key — allow
  if (currentKey === identityKey && currentKey.length > 0) {
    console.log(`[IDENTITY_MATCHED] userId=${user.id} key=${identityKey}`);
    return NextResponse.json({ ok: true, action: 'matched', identityKey });
  }

  // First time — lock
  const updatePayload: Record<string, string> = { statflo_identity: identityKey };
  // statflo_identity_raw is optional — handle gracefully if column doesn't exist yet
  if (rawValue) updatePayload.statflo_identity_raw = rawValue;

  const { error: updateErr } = await svc
    .from('profiles')
    .update(updatePayload)
    .eq('id', user.id);

  if (updateErr) {
    // If raw column doesn't exist yet, retry without it
    if (updateErr.message?.includes('statflo_identity_raw') || updateErr.code === '42703') {
      const { error: retryErr } = await svc
        .from('profiles')
        .update({ statflo_identity: identityKey })
        .eq('id', user.id);
      if (retryErr) {
        if (retryErr.message?.includes('statflo_identity') || retryErr.code === '42703') {
          console.warn(`[identity-lock] statflo_identity column missing — migration required`);
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

/**
 * GET /api/identity/lock
 * Returns the locked Statflo identity key for the authenticated user.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data: profile, error } = await svc
    .from('profiles')
    .select('statflo_identity, statflo_identity_raw')
    .eq('id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    if (error.message?.includes('statflo_identity') || error.code === '42703') {
      return NextResponse.json({ identityKey: null, note: 'column-missing' });
    }
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  return NextResponse.json({
    identityKey: (profile as any)?.statflo_identity     ?? null,
    rawValue:    (profile as any)?.statflo_identity_raw ?? null,
  });
}
