import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { auditLog } from '@/lib/license';
import { executeApprovedPayout, preflightPayout } from '@/lib/referralPayouts';

/**
 * POST /api/admin/referrals/payout
 *
 * Two actions, both admin-only and both explicit. There is no automatic or
 * scheduled payout path anywhere in the codebase.
 *
 *   { action: 'preflight', referrerUserId }  → dry run; explains why a payout
 *                                              is or is not currently permitted
 *   { action: 'approve',   referrerUserId }  → transfers the full eligible
 *                                              balance via Stripe Connect
 *
 * Also handles code disable/enable, which is the admin's fraud lever:
 *   { action: 'disable-code', referrerUserId, reason }
 *   { action: 'enable-code',  referrerUserId }
 *
 * Money movement additionally requires REFERRAL_PAYOUTS_ENABLED === 'true' and
 * a configured REFERRAL_PAYOUT_THRESHOLD_CENTS; both fail closed.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    console.warn(`[ADMIN_PAYOUT_DENIED] email=${user.email ?? 'unknown'}`);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action ?? '');
  const referrerUserId = String(body?.referrerUserId ?? '');

  if (!referrerUserId) {
    return NextResponse.json({ error: 'referrerUserId is required' }, { status: 400 });
  }

  const svc = createServiceClient();

  switch (action) {
    case 'preflight': {
      const pre = await preflightPayout(referrerUserId);
      return NextResponse.json(pre);
    }

    case 'approve': {
      console.log(`[ADMIN_PAYOUT_APPROVED] referrer=${referrerUserId} by=${user.email}`);
      const result = await executeApprovedPayout({
        referrerUserId,
        approvedByEmail: user.email!,
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      return NextResponse.json({
        ok: true,
        payoutId:    result.payoutId,
        amountCents: result.amountCents,
      });
    }

    case 'disable-code': {
      const reason = String(body?.reason ?? '').trim();
      if (!reason) {
        return NextResponse.json({ error: 'A reason is required to disable a code.' }, { status: 400 });
      }

      const { error } = await svc
        .from('referral_codes')
        .update({
          status:          'disabled',
          disabled_at:     new Date().toISOString(),
          disabled_reason: reason,
        })
        .eq('referrer_user_id', referrerUserId);

      if (error) {
        console.error('[ADMIN_CODE_DISABLE_FAILED]', error.code, error.message);
        return NextResponse.json({ error: 'Could not disable the code.' }, { status: 500 });
      }

      // Disabling stops FUTURE use. Attributions already written keep their
      // frozen referrer and remain payable — the referrer earned those.
      console.warn(`[ADMIN_CODE_DISABLED] referrer=${referrerUserId} by=${user.email} reason=${reason}`);
      await auditLog(referrerUserId, 'referral_code_disabled', { reason, by: user.email });
      return NextResponse.json({ ok: true });
    }

    case 'enable-code': {
      const { error } = await svc
        .from('referral_codes')
        .update({ status: 'active', disabled_at: null, disabled_reason: null })
        .eq('referrer_user_id', referrerUserId);

      if (error) {
        console.error('[ADMIN_CODE_ENABLE_FAILED]', error.code, error.message);
        return NextResponse.json({ error: 'Could not re-enable the code.' }, { status: 500 });
      }

      console.log(`[ADMIN_CODE_ENABLED] referrer=${referrerUserId} by=${user.email}`);
      await auditLog(referrerUserId, 'referral_code_enabled', { by: user.email });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
