import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

/**
 * POST /api/identity/lock
 * Called by the desktop server to lock or verify the Statflo username.
 *
 * - First call for a user: sets the locked Statflo email in profiles.statflo_identity.
 * - Subsequent calls: verifies the detected email matches the locked one.
 *
 * Body: { statfloEmail: string }
 * Auth: Bearer JWT (Supabase access token)
 *
 * Responses:
 *   200 { ok: true,  action: 'locked' | 'matched' | 'column-missing', statfloEmail }
 *   409 { ok: false, reason: 'mismatch', lockedEmail }
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const { statfloEmail } = body;
  if (!statfloEmail || typeof statfloEmail !== 'string' || !statfloEmail.includes('@')) {
    return NextResponse.json({ error: 'statfloEmail required and must be a valid email' }, { status: 400 });
  }

  const normalized = statfloEmail.trim().toLowerCase();
  const svc = createServiceClient();

  // Read current locked identity from the profiles row
  const { data: profile, error: profileErr } = await svc
    .from('profiles')
    .select('statflo_identity')
    .eq('id', user.id)
    .single();

  if (profileErr && profileErr.code !== 'PGRST116') {
    // Column does not exist yet — migration pending; degrade gracefully so the run is not blocked
    if (profileErr.message?.includes('statflo_identity') || profileErr.code === '42703') {
      console.warn(`[identity-lock] statflo_identity column missing — migration required (userId=${user.id})`);
      return NextResponse.json({ ok: true, action: 'column-missing', statfloEmail: normalized });
    }
    console.error(`[identity-lock] profile fetch error userId=${user.id}:`, profileErr.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const currentLocked = ((profile as any)?.statflo_identity || '').trim().toLowerCase() || null;

  // Mismatch — block
  if (currentLocked && currentLocked !== normalized) {
    console.log(`[IDENTITY_MISMATCH] userId=${user.id} locked=${currentLocked} attempted=${normalized}`);
    return NextResponse.json({ ok: false, reason: 'mismatch', lockedEmail: currentLocked }, { status: 409 });
  }

  // Already locked to the same email — allow
  if (currentLocked === normalized) {
    console.log(`[IDENTITY_MATCHED] userId=${user.id} email=${normalized}`);
    return NextResponse.json({ ok: true, action: 'matched', statfloEmail: normalized });
  }

  // First time — lock the identity
  const { error: updateErr } = await svc
    .from('profiles')
    .update({ statflo_identity: normalized })
    .eq('id', user.id);

  if (updateErr) {
    if (updateErr.message?.includes('statflo_identity') || updateErr.code === '42703') {
      console.warn(`[identity-lock] statflo_identity column missing (update) — migration required (userId=${user.id})`);
      return NextResponse.json({ ok: true, action: 'column-missing', statfloEmail: normalized });
    }
    console.error(`[identity-lock] update error userId=${user.id}:`, updateErr.message);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  console.log(`[IDENTITY_LOCKED] userId=${user.id} email=${normalized}`);
  return NextResponse.json({ ok: true, action: 'locked', statfloEmail: normalized });
}

/**
 * GET /api/identity/lock
 * Returns the currently locked Statflo identity for the authenticated user.
 * Used by admin panel / account screen to display "Locked Statflo User".
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();
  const { data: profile, error } = await svc
    .from('profiles')
    .select('statflo_identity')
    .eq('id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    if (error.message?.includes('statflo_identity') || error.code === '42703') {
      return NextResponse.json({ statfloIdentity: null, note: 'column-missing' });
    }
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  return NextResponse.json({ statfloIdentity: (profile as any)?.statflo_identity ?? null });
}
