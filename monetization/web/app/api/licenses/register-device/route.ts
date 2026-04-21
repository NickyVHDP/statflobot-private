import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { auditLog } from '@/lib/license';

const DEVICE_MIN_AGE_DAYS   = 7;   // device must be this old before it can be removed
const SWAP_COOLDOWN_HOURS   = 48;  // how long before a removed slot frees up
const SWAPS_PER_PERIOD      = 1;   // max removals allowed per rolling window
const SWAP_PERIOD_DAYS      = 30;  // the rolling window length

/**
 * POST /api/licenses/register-device
 * Authenticated route — manages device removal with anti-abuse enforcement.
 * Accepts both cookie-based auth (web) and Bearer token (desktop proxy).
 *
 * Body: { action: 'remove', deviceId: string }
 *
 * Anti-abuse rules:
 *   1. Device must be ≥ DEVICE_MIN_AGE_DAYS old to be removed.
 *   2. Max SWAPS_PER_PERIOD removals per SWAP_PERIOD_DAYS rolling window per license.
 *   3. Removed slot is not available for SWAP_COOLDOWN_HOURS after removal.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, deviceId } = body;

  if (action !== 'remove') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId required' }, { status: 400 });
  }

  const svc = createServiceClient();

  // ── Confirm device belongs to this user's license ─────────────────────────
  const { data: device } = await svc
    .from('license_devices')
    .select('id, license_id, device_fingerprint, device_name, created_at, licenses!inner(user_id)')
    .eq('id', deviceId)
    .single();

  const ownerUserId = (device as any)?.licenses?.user_id;
  if (!device || ownerUserId !== user.id) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }

  const licenseId = (device as any).license_id;

  // ── Anti-abuse check 1: device minimum age ────────────────────────────────
  const addedAt     = new Date((device as any).created_at);
  const deviceAgeDays = (Date.now() - addedAt.getTime()) / (1000 * 60 * 60 * 24);

  if (deviceAgeDays < DEVICE_MIN_AGE_DAYS) {
    const daysRemaining = Math.ceil(DEVICE_MIN_AGE_DAYS - deviceAgeDays);
    await auditLog(user.id, 'device_removal_denied_too_new', {
      deviceId, deviceAgeDays: Math.floor(deviceAgeDays), daysRemaining,
    });
    return NextResponse.json({
      error:         `Cannot remove a device added less than ${DEVICE_MIN_AGE_DAYS} days ago. Wait ${daysRemaining} more day(s).`,
      reason:        'too_new',
      daysRemaining,
    }, { status: 403 });
  }

  // ── Anti-abuse check 2: swap quota (max 1 per 30 days) ───────────────────
  const windowStart = new Date(Date.now() - SWAP_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentSwaps } = await svc
    .from('device_swap_log')
    .select('removed_at')
    .eq('license_id', licenseId)
    .gte('removed_at', windowStart)
    .order('removed_at', { ascending: false });

  if ((recentSwaps?.length ?? 0) >= SWAPS_PER_PERIOD) {
    const oldestSwapAt  = new Date((recentSwaps![recentSwaps!.length - 1] as any).removed_at);
    const nextSwapAt    = new Date(oldestSwapAt.getTime() + SWAP_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const daysUntilSwap = Math.ceil((nextSwapAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    await auditLog(user.id, 'device_removal_denied_quota', {
      deviceId, swapsUsed: recentSwaps!.length, nextSwapAt: nextSwapAt.toISOString(),
    });
    return NextResponse.json({
      error:       `Device replacement quota reached (${SWAPS_PER_PERIOD} per ${SWAP_PERIOD_DAYS} days). Next swap available in ${daysUntilSwap} day(s).`,
      reason:      'quota_exceeded',
      nextSwapAt:  nextSwapAt.toISOString(),
      daysUntilSwap,
    }, { status: 403 });
  }

  // ── Perform the removal ───────────────────────────────────────────────────
  const now              = new Date();
  const canReplaceAfter  = new Date(now.getTime() + SWAP_COOLDOWN_HOURS * 60 * 60 * 1000);

  await svc.from('license_devices').delete().eq('id', deviceId);

  await svc.from('device_swap_log').insert({
    license_id:         licenseId,
    user_id:            user.id,
    device_fingerprint: (device as any).device_fingerprint,
    device_name:        (device as any).device_name,
    removed_at:         now.toISOString(),
    can_replace_after:  canReplaceAfter.toISOString(),
  });

  await auditLog(user.id, 'device_removed', {
    deviceId,
    deviceFingerprint: (device as any).device_fingerprint,
    deviceName:        (device as any).device_name,
    canReplaceAfter:   canReplaceAfter.toISOString(),
  });

  return NextResponse.json({
    ok:               true,
    canReplaceAfter:  canReplaceAfter.toISOString(),
    message:          `Device removed. A replacement slot will be available after ${canReplaceAfter.toLocaleString()}.`,
  });
}
