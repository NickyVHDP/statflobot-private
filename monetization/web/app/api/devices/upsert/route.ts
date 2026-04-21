import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';

/**
 * POST /api/devices/upsert
 *
 * Called by the desktop server after every successful subscription verification.
 * Registers a new device or refreshes last_seen_at for an existing one.
 *
 * Body: { deviceFingerprint: string, deviceName?: string }
 * Auth: Bearer JWT (Supabase access token)
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const { deviceFingerprint, deviceName } = body;
  if (!deviceFingerprint || typeof deviceFingerprint !== 'string' || deviceFingerprint.length < 8) {
    return NextResponse.json({ error: 'deviceFingerprint required (min 8 chars)' }, { status: 400 });
  }

  const svc = createServiceClient();

  // Admin bypass — admin accounts don't need device tracking
  const { data: profile } = await svc.from('profiles').select('email').eq('id', user.id).single();
  if (isAdminEmail(profile?.email)) {
    return NextResponse.json({ ok: true, action: 'admin-bypass' });
  }

  // Find user's active license
  const { data: license } = await svc
    .from('licenses')
    .select('id, max_devices, plan, status')
    .eq('user_id', user.id)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!license) {
    return NextResponse.json({ error: 'No active license found' }, { status: 404 });
  }

  // Check if device already registered
  const { data: existing } = await svc
    .from('license_devices')
    .select('id')
    .eq('license_id', license.id)
    .eq('device_fingerprint', deviceFingerprint)
    .single();

  if (existing) {
    await svc
      .from('license_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);
    return NextResponse.json({ ok: true, action: 'updated' });
  }

  // New device — check effective slot count (active + cooldown)
  const { data: activeDevices } = await svc
    .from('license_devices')
    .select('id')
    .eq('license_id', license.id);

  const now = new Date().toISOString();
  const { count: cooldownCount } = await svc
    .from('device_swap_log')
    .select('id', { count: 'exact', head: true })
    .eq('license_id', license.id)
    .gt('can_replace_after', now);

  const effectiveUsed = (activeDevices?.length ?? 0) + (cooldownCount ?? 0);

  if (effectiveUsed >= license.max_devices) {
    return NextResponse.json({
      error:  `Device limit reached (${license.max_devices} max). Remove an existing device first.`,
      reason: 'limit_reached',
      effectiveUsed,
      maxDevices: license.max_devices,
    }, { status: 403 });
  }

  // Register new device
  await svc.from('license_devices').insert({
    license_id:         license.id,
    device_fingerprint: deviceFingerprint,
    device_name:        deviceName ?? `Machine (${new Date().toLocaleDateString()})`,
    last_seen_at:       new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, action: 'registered' });
}
