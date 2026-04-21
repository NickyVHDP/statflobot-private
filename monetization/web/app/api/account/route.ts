import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail, ADMIN_SUBSCRIPTION, ADMIN_LICENSE } from '@/lib/admin';

const DEVICE_MIN_AGE_DAYS = 7;
const SWAP_PERIOD_DAYS    = 30;

/**
 * GET /api/account
 * Returns the full account snapshot for the authenticated user:
 * profile, license, devices (enriched), subscription, swapStatus.
 *
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();

  // ── Shared helper: enrich raw devices with anti-abuse metadata ────────────
  async function enrichDevices(rawDevices: any[], licenseId: string | null) {
    const now = Date.now();
    const enriched = (rawDevices ?? []).map((dev) => {
      const addedAt     = new Date(dev.created_at);
      const daysOld     = (now - addedAt.getTime()) / (1000 * 60 * 60 * 24);
      return { ...dev, days_old: Math.floor(daysOld), can_remove: daysOld >= DEVICE_MIN_AGE_DAYS };
    });

    let swapStatus = null;
    if (licenseId) {
      const windowStart = new Date(now - SWAP_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSwaps } = await svc
        .from('device_swap_log')
        .select('removed_at, can_replace_after')
        .eq('license_id', licenseId)
        .gte('removed_at', windowStart)
        .order('removed_at', { ascending: false });

      const swapsUsed = recentSwaps?.length ?? 0;
      const nextSwapAt = swapsUsed > 0
        ? new Date(new Date((recentSwaps![recentSwaps!.length - 1] as any).removed_at).getTime()
            + SWAP_PERIOD_DAYS * 24 * 60 * 60 * 1000)
        : null;

      const { data: cooldowns } = await svc
        .from('device_swap_log')
        .select('can_replace_after, device_name')
        .eq('license_id', licenseId)
        .gt('can_replace_after', new Date().toISOString());

      swapStatus = {
        canSwapNow:           swapsUsed === 0,
        swapsUsedLast30Days:  swapsUsed,
        nextSwapAt:           nextSwapAt?.toISOString() ?? null,
        pendingCooldowns:     (cooldowns ?? []).map((c: any) => ({
          deviceName:        c.device_name,
          canReplaceAfter:   c.can_replace_after,
          hoursRemaining:    Math.ceil((new Date(c.can_replace_after).getTime() - now) / (1000 * 60 * 60)),
        })),
      };
    }

    return { enriched, swapStatus };
  }

  // ── Admin: real data, no synthetic counts ─────────────────────────────────
  if (isAdminEmail(user.email)) {
    const { data: profile } = await svc.from('profiles').select('*').eq('id', user.id).single();

    const { data: licenses } = await svc
      .from('licenses')
      .select('id')
      .eq('user_id', user.id);

    let adminDevices: any[] = [];
    let adminLicenseId: string | null = null;
    if (licenses?.length) {
      adminLicenseId = (licenses[0] as any).id;
      for (const lic of licenses as any[]) {
        const { data: devs } = await svc
          .from('license_devices')
          .select('id, device_fingerprint, device_name, last_seen_at, created_at')
          .eq('license_id', lic.id);
        if (devs) adminDevices.push(...devs);
      }
    }

    const { enriched, swapStatus } = await enrichDevices(adminDevices, adminLicenseId);

    return NextResponse.json({
      profile:      { ...profile, is_admin: true },
      license:      ADMIN_LICENSE,
      subscription: ADMIN_SUBSCRIPTION,
      devices:      enriched,
      swapStatus,
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  const [profileRes, licenseRes, subRes] = await Promise.all([
    svc.from('profiles').select('*').eq('id', user.id).single(),
    svc.from('licenses').select('id, license_key, status, plan, max_devices, created_at')
       .eq('user_id', user.id).neq('status', 'revoked').order('created_at', { ascending: false }).limit(1).single(),
    svc.from('subscriptions').select('*')
       .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).single(),
  ]);

  let rawDevices: any[] = [];
  if (licenseRes.data?.id) {
    const { data: devs } = await svc
      .from('license_devices')
      .select('id, device_fingerprint, device_name, last_seen_at, created_at')
      .eq('license_id', licenseRes.data.id);
    rawDevices = devs ?? [];
  }

  const { enriched, swapStatus } = await enrichDevices(rawDevices, licenseRes.data?.id ?? null);

  return NextResponse.json({
    profile:      profileRes.data,
    license:      licenseRes.data,
    subscription: subRes.data,
    devices:      enriched,
    swapStatus,
  });
}
