import { createClient, createServiceClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import DashboardClient from './DashboardClient';
import { isAdminEmail, ADMIN_LICENSE, ADMIN_SUBSCRIPTION } from '@/lib/admin';
import { reconcilePendingPurchase } from '@/lib/license';

const DEVICE_MIN_AGE_DAYS = 7;
const SWAP_PERIOD_DAYS    = 30;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?redirect=/dashboard');

  const svc = createServiceClient();

  // Auto-reconcile any purchase-first (guest checkout) purchases for this email.
  if (user.email) {
    await reconcilePendingPurchase(user.id, user.email).catch((err) => {
      console.warn('[dashboard] reconciliation failed non-fatally:', err.message);
    });
  }

  const { data: profile } = await svc.from('profiles').select('*').eq('id', user.id).single();

  // ── Shared: enrich devices and compute swap status ──────────────────────
  async function getEnrichedDevices(licenseId: string | null) {
    const now = Date.now();
    let rawDevices: any[] = [];
    if (licenseId) {
      const { data: devs } = await svc
        .from('license_devices')
        .select('id, device_fingerprint, device_name, last_seen_at, created_at')
        .eq('license_id', licenseId);
      rawDevices = devs ?? [];
    }

    const enriched = rawDevices.map((dev) => {
      const daysOld = (now - new Date(dev.created_at).getTime()) / (1000 * 60 * 60 * 24);
      return { ...dev, days_old: Math.floor(daysOld), can_remove: daysOld >= DEVICE_MIN_AGE_DAYS };
    });

    let swapStatus = null;
    if (licenseId) {
      const windowStart = new Date(now - SWAP_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSwaps } = await svc
        .from('device_swap_log')
        .select('removed_at')
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
        canSwapNow:          swapsUsed === 0,
        swapsUsedLast30Days: swapsUsed,
        nextSwapAt:          nextSwapAt?.toISOString() ?? null,
        pendingCooldowns:    (cooldowns ?? []).map((c: any) => ({
          deviceName:       c.device_name,
          canReplaceAfter:  c.can_replace_after,
          hoursRemaining:   Math.ceil((new Date(c.can_replace_after).getTime() - now) / (1000 * 60 * 60)),
        })),
      };
    }

    return { enriched, swapStatus };
  }

  // ── Admin bypass — real device data, synthetic license ──────────────────
  if (isAdminEmail(user.email)) {
    const { data: licenses } = await svc.from('licenses').select('id').eq('user_id', user.id);
    const adminLicenseId = (licenses as any)?.[0]?.id ?? null;
    const { enriched, swapStatus } = await getEnrichedDevices(adminLicenseId);

    return (
      <DashboardClient
        profile={{ ...profile, is_admin: true }}
        license={ADMIN_LICENSE}
        subscription={ADMIN_SUBSCRIPTION}
        devices={enriched}
        swapStatus={swapStatus}
        justPurchased={false}
      />
    );
  }
  // ────────────────────────────────────────────────────────────────────────

  const [licenseRes, subRes] = await Promise.all([
    svc.from('licenses')
       .select('id, license_key, status, plan, max_devices, created_at')
       .eq('user_id', user.id).neq('status', 'revoked')
       .order('created_at', { ascending: false }).limit(1).single(),
    svc.from('subscriptions').select('*')
       .eq('user_id', user.id)
       .order('created_at', { ascending: false }).limit(1).single(),
  ]);

  const { enriched, swapStatus } = await getEnrichedDevices(licenseRes.data?.id ?? null);

  const justPurchased =
    searchParams.checkout === 'success' || searchParams.checkout === 'pending';

  return (
    <DashboardClient
      profile={profile}
      license={licenseRes.data}
      subscription={subRes.data}
      devices={enriched}
      swapStatus={swapStatus}
      justPurchased={justPurchased}
    />
  );
}
