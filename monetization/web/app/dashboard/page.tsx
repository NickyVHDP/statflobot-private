import { createClient, createServiceClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import DashboardClient from './DashboardClient';
import { isAdminEmail, ADMIN_LICENSE, ADMIN_SUBSCRIPTION } from '@/lib/admin';
import { reconcilePendingPurchase } from '@/lib/license';

// Build fingerprint — VERCEL_GIT_COMMIT_SHA is injected automatically by Vercel at deploy time.
// Falls back to 'local' in dev.
const BUILD_COMMIT = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? 'local';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  console.log(`[DASHBOARD_FETCH_START] commit=${BUILD_COMMIT} time=${new Date().toISOString()}`);

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/auth/sign-in?redirect=/dashboard');

  const svc = createServiceClient();

  if (user.email) {
    await reconcilePendingPurchase(user.id, user.email).catch((err) => {
      console.warn('[dashboard] reconciliation failed non-fatally:', err.message);
    });
  }

  const { data: profile } = await svc.from('profiles').select('*').eq('id', user.id).single();

  // ── Unified device fetch — reads from `devices` table by user_id ──────────
  // No license dependency. Works for both admin and regular users.
  async function getDevices() {
    console.log(`[DASHBOARD_DEVICES_SOURCE] table=devices user_id=${user.id}`);
    const now = Date.now();
    const { data, error } = await svc
      .from('devices')
      .select('id, device_fingerprint, device_name, last_seen_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[dashboard] devices query error:', error.message, '— DB may need migration');
      return [];
    }

    const rows = (data ?? []).map((dev: any) => {
      const daysOld = (now - new Date(dev.created_at).getTime()) / (1000 * 60 * 60 * 24);
      return { ...dev, days_old: Math.floor(daysOld) };
    });

    console.log(`[DASHBOARD_DEVICES_COUNT] count=${rows.length} user_id=${user.id}`);
    return rows;
  }

  // ── Admin path ────────────────────────────────────────────────────────────
  if (isAdminEmail(user.email)) {
    const devices = await getDevices();

    return (
      <DashboardClient
        profile={{ ...profile, is_admin: true }}
        license={ADMIN_LICENSE}
        subscription={ADMIN_SUBSCRIPTION}
        devices={devices}
        swapStatus={null}
        justPurchased={false}
        buildCommit={BUILD_COMMIT}
      />
    );
  }

  // ── Regular user path ─────────────────────────────────────────────────────
  const [licenseRes, subRes] = await Promise.all([
    svc.from('licenses')
       .select('id, license_key, status, plan, max_devices, created_at')
       .eq('user_id', user.id).neq('status', 'revoked')
       .order('created_at', { ascending: false }).limit(1).single(),
    svc.from('subscriptions').select('*')
       .eq('user_id', user.id)
       .order('created_at', { ascending: false }).limit(1).single(),
  ]);

  const devices = await getDevices();

  const justPurchased =
    searchParams.checkout === 'success' || searchParams.checkout === 'pending';

  return (
    <DashboardClient
      profile={profile}
      license={licenseRes.data}
      subscription={subRes.data}
      devices={devices}
      swapStatus={null}
      justPurchased={justPurchased}
      buildCommit={BUILD_COMMIT}
    />
  );
}
