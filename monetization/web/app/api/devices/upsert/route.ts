import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';

/**
 * POST /api/devices/upsert
 *
 * Called by the desktop server after every successful subscription check.
 * Inserts a new device row or refreshes last_seen_at for a known fingerprint.
 *
 * Uses the `devices` table (user_id + device_fingerprint unique) — no license
 * dependency, so registration works regardless of license state.
 *
 * Body: { deviceFingerprint: string, deviceName?: string }
 * Auth: Bearer JWT (Supabase access token)
 *
 * Response: { ok: true, action: 'created' | 'updated' }
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    console.log('[device-upsert] 401 — no authenticated user');
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  console.log(`[device-upsert] userId=${user.id}`);

  let body: any;
  try { body = await req.json(); }
  catch {
    console.log('[device-upsert] 400 — invalid JSON body');
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { deviceFingerprint, deviceName } = body;
  console.log(`[device-upsert] fingerprint=${deviceFingerprint?.slice(0, 8) ?? '(missing)'}… name="${deviceName ?? '(none)'}"`);

  if (!deviceFingerprint || typeof deviceFingerprint !== 'string' || deviceFingerprint.length < 8) {
    console.log('[device-upsert] 400 — deviceFingerprint missing or too short');
    return NextResponse.json({ error: 'deviceFingerprint required (min 8 chars)' }, { status: 400 });
  }

  const svc = createServiceClient();

  // Check for existing row
  const { data: existing, error: selectErr } = await svc
    .from('devices')
    .select('id')
    .eq('user_id', user.id)
    .eq('device_fingerprint', deviceFingerprint)
    .single();

  if (selectErr && selectErr.code !== 'PGRST116') {
    // PGRST116 = "no rows" — anything else is a real DB error
    console.error('[device-upsert] select error:', selectErr.message);
    return NextResponse.json({ error: 'Database error', detail: selectErr.message }, { status: 500 });
  }

  if (existing) {
    const { error: updateErr } = await svc
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (updateErr) {
      console.error('[device-upsert] update error:', updateErr.message);
      return NextResponse.json({ error: 'Database error', detail: updateErr.message }, { status: 500 });
    }

    console.log(`[device-upsert] updated last_seen_at for existing device id=${existing.id}`);
    return NextResponse.json({ ok: true, action: 'updated' });
  }

  // New device — insert
  const { error: insertErr } = await svc
    .from('devices')
    .insert({
      user_id:            user.id,
      device_fingerprint: deviceFingerprint,
      device_name:        deviceName ?? `Machine (${new Date().toLocaleDateString()})`,
      last_seen_at:       new Date().toISOString(),
    });

  if (insertErr) {
    console.error('[device-upsert] insert error:', insertErr.message, insertErr.code);
    return NextResponse.json({ error: 'Database error', detail: insertErr.message }, { status: 500 });
  }

  console.log(`[device-upsert] created new device row for userId=${user.id}`);
  return NextResponse.json({ ok: true, action: 'created' });
}
