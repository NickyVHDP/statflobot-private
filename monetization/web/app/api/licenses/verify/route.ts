import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { auditLog } from '@/lib/license';
import { isAdminEmail } from '@/lib/admin';

const RECHECK_MONTHLY = 60 * 60 * 6; // 6 hours in seconds
const RECHECK_LIFETIME = 60 * 60 * 24 * 7; // 7 days

type LicenseDevice = {
  id: string;
  device_fingerprint: string;
};

/**
 * POST /api/licenses/verify
 *
 * Body: { licenseKey, deviceFingerprint, appVersion? }
 *
 * Returns:
 *   { valid: boolean, plan?, status?, reason?, recheckSeconds?, user? }
 *
 * This is the primary gate the local bot calls before starting a run.
 * Everything is authoritative server-side — no client bypass possible.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ valid: false, reason: 'Invalid request body' }, { status: 400 });
  }

  const { licenseKey, deviceFingerprint, appVersion } = body;

  if (!licenseKey || !deviceFingerprint) {
    return NextResponse.json(
      { valid: false, reason: 'licenseKey and deviceFingerprint are required' },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // ── Admin bypass — resolve license key owner and grant if admin email ────
  {
    const { data: lic } = await supabase
      .from('licenses')
      .select('user_id')
      .eq('license_key', licenseKey)
      .single();
    if (lic?.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', lic.user_id)
        .single();
      if (isAdminEmail(profile?.email)) {
        return NextResponse.json({
          valid: true,
          plan: 'lifetime',
          status: 'active',
          recheckSeconds: RECHECK_LIFETIME,
          user: { email: profile?.email, fullName: null },
        });
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── 1. Look up the license ──────────────────────────────────────────────
  const { data: license, error: licErr } = await supabase
    .from('licenses')
    .select('id, user_id, status, plan, max_devices')
    .eq('license_key', licenseKey)
    .single();

  if (licErr || !license) {
    await auditLog(null, 'verify_failed', { licenseKey, reason: 'not_found' });
    return NextResponse.json({ valid: false, reason: 'License not found' });
  }

  if (license.status === 'revoked') {
    await auditLog(license.user_id, 'verify_failed', { licenseKey, reason: 'revoked' });
    return NextResponse.json({ valid: false, reason: 'License has been revoked' });
  }

  if (license.status !== 'active') {
    await auditLog(license.user_id, 'verify_failed', { licenseKey, reason: 'inactive' });
    return NextResponse.json({ valid: false, reason: 'License is inactive' });
  }

  // ── 2. For monthly plans, verify subscription is still paying ───────────
  if (license.plan === 'monthly') {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', license.user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const validSubStatus = ['active', 'trialing'];
    if (!sub || !validSubStatus.includes(sub.status)) {
      await auditLog(license.user_id, 'verify_failed', {
        licenseKey,
        reason: 'subscription_inactive',
        subStatus: sub?.status,
      });
      return NextResponse.json({
        valid: false,
        reason: 'Subscription is not active',
        status: sub?.status ?? 'unknown',
      });
    }
  }

  // ── 3. Device registration / limit check ───────────────────────────────
  const { data: devices } = await supabase
    .from('license_devices')
    .select('id, device_fingerprint')
    .eq('license_id', license.id);

  const deviceList: LicenseDevice[] = (devices ?? []) as LicenseDevice[];
  const knownDevice = deviceList.find(
    (d: LicenseDevice) => d.device_fingerprint === deviceFingerprint
  );

  if (!knownDevice) {
    // ── Effective slot count = active devices + slots still in 48h removal cooldown ──
    // A removed device's slot is locked for 48h after removal.  The device row is
    // already deleted from license_devices, so we must count pending cooldown entries
    // separately.  Without this, a user could remove Device A and immediately register
    // Device C, bypassing the cooling period entirely.
    const now = new Date().toISOString();
    const { count: cooldownCount } = await supabase
      .from('device_swap_log')
      .select('id', { count: 'exact', head: true })
      .eq('license_id', license.id)
      .gt('can_replace_after', now);

    const activeCount        = deviceList.length;
    const effectiveUsedSlots = activeCount + (cooldownCount ?? 0);

    if (effectiveUsedSlots >= license.max_devices) {
      // Fetch the soonest-freeing cooldown slot for a helpful message
      const { data: soonestCooldown } = await supabase
        .from('device_swap_log')
        .select('can_replace_after')
        .eq('license_id', license.id)
        .gt('can_replace_after', now)
        .order('can_replace_after', { ascending: true })
        .limit(1);

      let reason: string;
      if (activeCount < license.max_devices && soonestCooldown?.length) {
        // Slots exist physically but are in cooling period — this is the enforced case
        const freeAt    = new Date((soonestCooldown[0] as any).can_replace_after);
        const hoursLeft = Math.ceil((freeAt.getTime() - Date.now()) / (1000 * 60 * 60));
        reason = `Device slot is in a 48-hour removal cooldown. Available in ${hoursLeft} hour(s).`;
      } else {
        reason = `Device limit reached (${license.max_devices} max). Remove an existing device from your dashboard.`;
      }

      await auditLog(license.user_id, 'verify_failed', {
        licenseKey,
        reason:             'device_limit',
        activeDevices:      activeCount,
        cooldownSlots:      cooldownCount ?? 0,
        effectiveUsedSlots,
        maxDevices:         license.max_devices,
      });
      return NextResponse.json({ valid: false, reason });
    }

    // Register the new device
    await supabase.from('license_devices').insert({
      license_id:         license.id,
      device_fingerprint: deviceFingerprint,
      device_name:        body.deviceName ?? 'Unknown Device',
      last_seen_at:       new Date().toISOString(),
    });

    await auditLog(license.user_id, 'device_registered', {
      licenseKey, deviceFingerprint, deviceName: body.deviceName, appVersion,
    });
  } else {
    // Update last_seen_at for known device
    await supabase
      .from('license_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', knownDevice.id);

    await auditLog(license.user_id, 'device_verified', {
      licenseKey, deviceFingerprint, appVersion,
    });
  }

  // ── 4. Fetch user profile for response ──────────────────────────────────
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', license.user_id)
    .single();

  await auditLog(license.user_id, 'verify_success', {
    licenseKey,
    plan: license.plan,
    appVersion,
  });

  const isLifetime = license.plan !== 'monthly';
  return NextResponse.json({
    valid: true,
    plan: license.plan,
    status: license.status,
    recheckSeconds: isLifetime ? RECHECK_LIFETIME : RECHECK_MONTHLY,
    user: {
      email: profile?.email,
      fullName: profile?.full_name,
    },
  });
}