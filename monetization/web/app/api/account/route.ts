import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail, ADMIN_SUBSCRIPTION, ADMIN_LICENSE } from '@/lib/admin';

/**
 * GET /api/account
 * Returns the full account snapshot for the authenticated user:
 * profile, license, devices (from `devices` table), subscription.
 *
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();

  // Fetch devices from the user-scoped `devices` table (no license dependency).
  async function getDevices() {
    const { data, error } = await svc
      .from('devices')
      .select('id, device_fingerprint, device_name, last_seen_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[account] devices query error:', error.message);
      return [];
    }

    const now = Date.now();
    return (data ?? []).map((dev: any) => {
      const daysOld = (now - new Date(dev.created_at).getTime()) / (1000 * 60 * 60 * 24);
      return { ...dev, days_old: Math.floor(daysOld) };
    });
  }

  // ── Admin path ────────────────────────────────────────────────────────────
  if (isAdminEmail(user.email)) {
    const { data: profile } = await svc.from('profiles').select('*').eq('id', user.id).single();
    const devices = await getDevices();

    return NextResponse.json({
      profile:      { ...profile, is_admin: true },
      license:      ADMIN_LICENSE,
      subscription: ADMIN_SUBSCRIPTION,
      devices,
      swapStatus:   null,
    });
  }

  // ── Regular user path ─────────────────────────────────────────────────────
  const [profileRes, licenseRes, subRes] = await Promise.all([
    svc.from('profiles').select('*').eq('id', user.id).single(),
    svc.from('licenses')
       .select('id, license_key, status, plan, max_devices, created_at')
       .eq('user_id', user.id)
       .neq('status', 'revoked')
       .order('created_at', { ascending: false })
       .limit(1)
       .single(),
    svc.from('subscriptions').select('*')
       .eq('user_id', user.id)
       .order('created_at', { ascending: false })
       .limit(1)
       .single(),
  ]);

  const devices = await getDevices();

  return NextResponse.json({
    profile:      profileRes.data,
    license:      licenseRes.data,
    subscription: subRes.data,
    devices,
    swapStatus:   null,
  });
}
