import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail, ADMIN_SUBSCRIPTION, ADMIN_LICENSE } from '@/lib/admin';
import { deactivateLicense, syncStripeSubscriptionForUser } from '@/lib/license';
import { evaluateMonthlyAccess } from '@/lib/stripe';

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

  console.log(`[AUTH_USER_EMAIL] email=${user.email ?? 'undefined'} id=${user.id}`);

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
      console.log(`[ACCOUNT_DEVICES_FETCH] userId=${user.id} count=0 error=${error.message}`);
      return [];
    }

    const now = Date.now();
    const rows = (data ?? []).map((dev: any) => {
      const daysOld = (now - new Date(dev.created_at).getTime()) / (1000 * 60 * 60 * 24);
      return { ...dev, days_old: Math.floor(daysOld) };
    });
    console.log(`[ACCOUNT_DEVICES_FETCH] userId=${user.id} count=${rows.length}`);
    return rows;
  }

  // ── Admin path ────────────────────────────────────────────────────────────
  if (isAdminEmail(user.email)) {
    console.log(`[ADMIN_BYPASS_ACTIVE] user=${user.email} — returning ADMIN_LICENSE and ADMIN_SUBSCRIPTION`);
    const { data: profile } = await svc.from('profiles').select('*').eq('id', user.id).single();
    const devices = await getDevices();

    console.log(`[ACCOUNT_ACCESS_RESULT] userId=${user.id} isAdmin=true hasAccess=true licenseSource=admin-bypass`);
    return NextResponse.json({
      profile:      { ...profile, is_admin: true },
      license:      ADMIN_LICENSE,
      subscription: ADMIN_SUBSCRIPTION,
      devices,
      swapStatus:   null,
      hasAccess:    true,
      isAdmin:      true,
    });
  }

  // ── Regular user path ─────────────────────────────────────────────────────
  const [profileRes, licenseRes, allSubsRes] = await Promise.all([
    svc.from('profiles').select('*').eq('id', user.id).single(),
    svc.from('licenses')
       .select('id, license_key, status, plan, max_devices, created_at')
       .eq('user_id', user.id)
       .neq('status', 'revoked')
       .order('created_at', { ascending: false })
       .limit(1)
       .single(),
    // Fetch up to 5 subscriptions — pick the best one below rather than blindly
    // trusting latest created_at (re-subscription may have failed to insert a new row).
    svc.from('subscriptions').select('*')
       .eq('user_id', user.id)
       .order('created_at', { ascending: false })
       .limit(5),
  ]);

  const devices = await getDevices();

  // Pick the best subscription: prefer active/trialing with future period_end,
  // then lifetime, then most recent by created_at.
  const now = new Date();
  const subs: any[] = allSubsRes.data ?? [];
  const bestSub = subs.find((s: any) =>
    (s.status === 'active' || s.status === 'trialing') &&
    s.current_period_end && new Date(s.current_period_end) > now
  ) ?? subs.find((s: any) => s.status === 'lifetime') ?? subs[0] ?? null;

  console.log(`[ACCOUNT_LATEST_SUB_SELECTED] userId=${user.id} totalSubs=${subs.length} selectedStatus=${bestSub?.status ?? 'none'} selectedSubId=${bestSub?.stripe_subscription_id ?? 'none'} periodEnd=${bestSub?.current_period_end ?? 'none'}`);

  // Sync monthly subscription from Stripe before evaluating access
  let activeSub = bestSub;
  if (activeSub?.stripe_subscription_id && activeSub.status !== 'lifetime') {
    const synced = await syncStripeSubscriptionForUser(user.id, activeSub.stripe_subscription_id).catch(() => null);
    if (synced) activeSub = synced;
  }

  const hasLicense  = !!(licenseRes.data && licenseRes.data.status === 'active');
  const isLifetime  = activeSub?.status === 'lifetime' || licenseRes.data?.plan === 'lifetime';
  const monthlyAllowed = !isLifetime && evaluateMonthlyAccess(activeSub);
  const hasSub      = isLifetime || monthlyAllowed;
  const hasAccess   = hasLicense || hasSub;
  const licSrc      = licenseRes.data ? 'license-db' : activeSub ? 'subscription-db' : 'none';

  // Fire-and-forget: mark stale monthly license inactive when subscription has expired
  if (hasLicense && licenseRes.data?.plan === 'monthly' && !monthlyAllowed && !isLifetime) {
    deactivateLicense(user.id).catch(() => {});
    console.log(`[MONTHLY_ACCESS_REVOKED_EXPIRED] userId=${user.id} periodEnd=${activeSub?.current_period_end ?? 'none'}`);
  }

  console.log(`[ACCOUNT_SUBSCRIPTION_FETCH] userId=${user.id} found=${!!activeSub} status=${activeSub?.status ?? 'none'} licStatus=${licenseRes.data?.status ?? 'none'} licPlan=${licenseRes.data?.plan ?? 'none'}`);
  console.log(`[ACCOUNT_ACCESS_RESULT] userId=${user.id} hasAccess=${hasAccess} hasLicense=${hasLicense} hasSub=${hasSub} isLifetime=${isLifetime} monthlyAllowed=${monthlyAllowed} licenseSource=${licSrc} subStatus=${activeSub?.status ?? 'none'} periodEnd=${activeSub?.current_period_end ?? 'none'}`);

  return NextResponse.json({
    profile:      { ...profileRes.data, is_admin: false }, // never trust DB is_admin for non-admin users
    license:      licenseRes.data,
    subscription: activeSub,
    devices,
    swapStatus:   null,
    hasAccess,
    isAdmin:      false,
  });
}
