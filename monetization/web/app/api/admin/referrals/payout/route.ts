import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail, isOwnerEmail } from '@/lib/admin';
import { auditLog } from '@/lib/license';
import { executeApprovedPayout, preflightPayout } from '@/lib/referralPayouts';
import { arePayoutsEnabled, getPayoutThresholdCents, getReferralBalance } from '@/lib/referrals';

/**
 * POST /api/admin/referrals/payout
 *
 * Payout actions are admin-only and explicit. This route is the
 * MANUAL path and is preserved in full: it never depends on the automatic
 * switch, so the owner can always pay by hand — including the cases the daily
 * run deliberately refuses, such as a paused recipient or a balance held back
 * by the annual tax-review ceiling.
 *
 * The scheduled path lives in app/api/cron/referral-payouts and shares these
 * same DB primitives; neither can pay a balance the other already reserved.
 *
 *   { action: 'preflight', referrerUserId }  → dry run; explains why a payout
 *                                              is or is not currently permitted
 *   { action: 'approve',   referrerUserId }  → transfers the full eligible
 *                                              balance via Stripe Global Payouts
 *   { action: 'approve-early', referrerUserId, attributionId }
 *                                           → owner releases one held reward,
 *                                             then transfers the full available balance
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
      if (!isOwnerEmail(user.email)) {
        console.warn(`[OWNER_PAYOUT_DENIED] email=${user.email ?? 'unknown'}`);
        return NextResponse.json(
          { error: 'Only the StatfloBot owner can approve referral payouts.' },
          { status: 403 }
        );
      }

      const { data: codeRow } = await svc
        .from('referral_codes')
        .select('code')
        .eq('referrer_user_id', referrerUserId)
        .maybeSingle();
      const expectedConfirmation = codeRow?.code ? `PAY ${codeRow.code}` : '';
      if (!expectedConfirmation || String(body?.confirmation ?? '').trim().toUpperCase() !== expectedConfirmation) {
        return NextResponse.json(
          { error: `Type ${expectedConfirmation || 'the payout confirmation'} to approve this payout.` },
          { status: 400 }
        );
      }

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
        providerStatus: result.providerStatus,
      });
    }

    case 'approve-early': {
      if (!isOwnerEmail(user.email)) {
        console.warn(`[OWNER_EARLY_PAYOUT_DENIED] email=${user.email ?? 'unknown'}`);
        return NextResponse.json(
          { error: 'Only the StatfloBot owner can release a referral reward early.' },
          { status: 403 }
        );
      }

      const attributionId = String(body?.attributionId ?? '');
      if (!attributionId) {
        return NextResponse.json({ error: 'attributionId is required' }, { status: 400 });
      }

      const [{ data: codeRow }, { data: accrual }, { data: payoutAccount }, balance] = await Promise.all([
        svc.from('referral_codes')
          .select('code')
          .eq('referrer_user_id', referrerUserId)
          .maybeSingle(),
        svc.from('referral_ledger')
          .select('amount_cents, eligible_at')
          .eq('referrer_user_id', referrerUserId)
          .eq('attribution_id', attributionId)
          .eq('entry_type', 'accrual')
          .maybeSingle(),
        svc.from('referral_payout_accounts')
          .select('stripe_recipient_id, stripe_payout_method_id, payout_method_ready')
          .eq('referrer_user_id', referrerUserId)
          .maybeSingle(),
        getReferralBalance(referrerUserId),
      ]);

      if (!codeRow?.code || !accrual) {
        return NextResponse.json({ error: 'Pending referral reward not found.' }, { status: 404 });
      }
      if (new Date(accrual.eligible_at).getTime() <= Date.now()) {
        return NextResponse.json({ error: 'This reward has already cleared the 30-day hold.' }, { status: 409 });
      }

      const expectedAmountCents = balance.eligibleCents + Number(accrual.amount_cents);
      const thresholdCents = getPayoutThresholdCents();
      if (!arePayoutsEnabled()) {
        return NextResponse.json({ error: 'Referral payout sending is disabled.' }, { status: 409 });
      }
      if (thresholdCents === null || expectedAmountCents < thresholdCents) {
        return NextResponse.json({ error: 'The released balance would still be below the payout threshold.' }, { status: 409 });
      }
      if (balance.eligibleCents < 0) {
        return NextResponse.json({ error: 'This referrer has a negative balance that needs owner review.' }, { status: 409 });
      }
      if (!process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID) {
        return NextResponse.json({ error: 'The payout Financial Account is not configured.' }, { status: 409 });
      }
      if (!payoutAccount?.stripe_recipient_id || !payoutAccount?.stripe_payout_method_id || !payoutAccount?.payout_method_ready) {
        return NextResponse.json({ error: 'The referrer must finish bank setup before an early payout.' }, { status: 409 });
      }

      const expectedAmount = `$${(expectedAmountCents / 100).toFixed(2)}`;
      const expectedConfirmation = `PAY NOW ${codeRow.code} ${expectedAmount}`.toUpperCase();
      if (String(body?.confirmation ?? '').trim().toUpperCase() !== expectedConfirmation) {
        return NextResponse.json(
          { error: `Type ${expectedConfirmation} to release this reward and approve the available payout.` },
          { status: 400 }
        );
      }

      const { data: released, error: releaseError } = await svc.rpc('approve_referral_reward_early', {
        p_attribution_id: attributionId,
        p_referrer_user_id: referrerUserId,
        p_approved_by_email: user.email!,
      });
      if (releaseError) {
        console.error('[ADMIN_EARLY_PAYOUT_RELEASE_FAILED]', releaseError.code, releaseError.message);
        const conflict = releaseError.code === '23505' || /already|cleared|reversed/i.test(releaseError.message);
        return NextResponse.json(
          { error: conflict ? 'This reward is no longer pending or was already released.' : 'Could not release this reward early.' },
          { status: conflict ? 409 : 500 }
        );
      }

      console.warn(`[ADMIN_EARLY_PAYOUT_RELEASED] attribution=${attributionId} referrer=${referrerUserId} by=${user.email}`);
      await auditLog(referrerUserId, 'referral_reward_released_early', {
        attribution_id: attributionId,
        amount_cents: Number(accrual.amount_cents),
        original_eligible_at: accrual.eligible_at,
        approved_by: user.email,
        release_result: released,
      });

      const result = await executeApprovedPayout({
        referrerUserId,
        approvedByEmail: user.email!,
      });
      if (!result.ok) {
        return NextResponse.json(
          {
            error: `The reward was released from its hold, but the bank payout did not complete: ${result.error}`,
            releasedEarly: true,
          },
          { status: result.status }
        );
      }
      return NextResponse.json({
        ok: true,
        releasedEarly: true,
        payoutId: result.payoutId,
        amountCents: result.amountCents,
        providerStatus: result.providerStatus,
      });
    }

    case 'clear-auto-block': {
      // Owner-only, like approving a payout: this decides that money may start
      // moving to this recipient again without a human in the loop. It pays
      // nothing by itself — the next daily run re-checks every guard.
      if (!isOwnerEmail(user.email)) {
        console.warn(`[OWNER_AUTO_BLOCK_CLEAR_DENIED] email=${user.email ?? 'unknown'}`);
        return NextResponse.json(
          { error: 'Only the StatfloBot owner can resume automatic payouts.' },
          { status: 403 }
        );
      }

      const { data: cleared, error } = await svc.rpc('clear_referral_auto_payout_block', {
        p_referrer_user_id: referrerUserId,
        p_cleared_by: user.email!,
      });
      if (error) {
        console.error('[ADMIN_AUTO_BLOCK_CLEAR_FAILED]', error.code, error.message);
        return NextResponse.json({ error: 'Could not resume automatic payouts.' }, { status: 500 });
      }
      if (cleared !== true) {
        return NextResponse.json({ error: 'Automatic payouts are not paused for this referrer.' }, { status: 409 });
      }

      console.warn(`[ADMIN_AUTO_BLOCK_CLEARED] referrer=${referrerUserId} by=${user.email}`);
      await auditLog(referrerUserId, 'referral_auto_payouts_resumed', { by: user.email });
      return NextResponse.json({ ok: true });
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
