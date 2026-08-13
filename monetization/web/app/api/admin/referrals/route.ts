import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { getPayoutThresholdCents, arePayoutsEnabled, REFERRAL_ACCRUAL_CENTS, getReferralRewardTiers } from '@/lib/referrals';
import { reconcileProcessingPayouts } from '@/lib/referralPayouts';
import { getPricingWindow } from '@/lib/pricing';

/**
 * GET /api/admin/referrals
 *
 * Full referral audit: every code, every attribution, the complete ledger, and
 * the payout queue with per-referrer balances.
 *
 * Gated exclusively through isAdminEmail() — the normalized allowlist that also
 * honours the hardcoded owner fallback. Do not reimplement the check inline.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    console.warn(`[ADMIN_REFERRALS_DENIED] email=${user.email ?? 'unknown'}`);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const svc = createServiceClient();
  const now = Date.now();

  await reconcileProcessingPayouts().catch((err: any) => {
    console.warn('[ADMIN_REFERRAL_PAYOUT_RECONCILE_SKIPPED]', String(err?.message ?? err));
  });

  const [{ data: codes }, { data: attributions }, { data: ledger }, { data: payouts }, { data: accounts }] =
    await Promise.all([
      svc.from('referral_codes')
        .select('id, code, referrer_user_id, status, created_at, disabled_at, disabled_reason')
        .order('created_at', { ascending: false }),
      svc.from('referral_attributions')
        .select('id, stripe_session_id, referral_code, referrer_user_id, referred_user_id, referred_email, plan_code, reward_cents, reward_tier_cents, qualified_position, sale_amount_cents, reward_basis_cents, terms_version, created_at')
        .order('created_at', { ascending: false })
        .limit(500),
      svc.from('referral_ledger')
        .select('id, referrer_user_id, attribution_id, payout_id, entry_type, amount_cents, eligible_at, notes, created_at')
        .order('created_at', { ascending: false })
        .limit(1000),
      svc.from('referral_payouts')
        .select('id, referrer_user_id, amount_cents, status, method, stripe_transfer_id, stripe_outbound_payment_id, approved_by_email, failure_reason, created_at, completed_at')
        .order('created_at', { ascending: false })
        .limit(200),
      svc.from('referral_payout_accounts')
        .select('referrer_user_id, stripe_recipient_id, onboarding_status, payouts_enabled, details_submitted, payout_method_ready, payout_method_type, provider'),
    ]);

  // Applied-but-unpaid checkouts. Non-monetary, but a referrer generating many
  // of these without conversions is the clearest early signal of someone
  // gaming the program, so the admin sees the count next to the balances.
  const { data: reservations } = await svc
    .from('referral_reservations')
    .select('referrer_user_id, status, expires_at')
    .eq('status', 'reserved');

  const awaitingByReferrer = new Map<string, number>();
  for (const r of reservations ?? []) {
    if (new Date(r.expires_at).getTime() <= now) continue; // stale, treat as abandoned
    awaitingByReferrer.set(r.referrer_user_id, (awaitingByReferrer.get(r.referrer_user_id) ?? 0) + 1);
  }

  // Per-referrer balances rolled up from the ledger. Same arithmetic as
  // getReferralBalance() but computed once across all referrers rather than
  // issuing one query per person.
  const reversedAttributions = new Set(
    (ledger ?? []).filter((e: any) => e.entry_type === 'reversal').map((e: any) => e.attribution_id)
  );

  const balances = new Map<string, { pending: number; eligible: number; processing: number; paid: number; reversed: number }>();
  const bump = (id: string) => {
    if (!balances.has(id)) balances.set(id, { pending: 0, eligible: 0, processing: 0, paid: 0, reversed: 0 });
    return balances.get(id)!;
  };

  // Reversed accrual pairs are both-counted or both-skipped — see the note in
  // getReferralBalance(). Counting one without the other double-debits.
  const accrualByAttribution = new Map<string, any>();
  for (const e of ledger ?? []) {
    if (e.entry_type === 'accrual' && e.attribution_id) {
      accrualByAttribution.set(e.attribution_id, e);
    }
  }
  const matured = (entry: any) => new Date(entry.eligible_at).getTime() <= now;
  const payoutStatusById = new Map((payouts ?? []).map((p: any) => [p.id, p.status]));

  for (const e of ledger ?? []) {
    const b = bump(e.referrer_user_id);

    if (e.entry_type === 'accrual') {
      if (reversedAttributions.has(e.attribution_id) && !matured(e)) continue;
      if (matured(e)) b.eligible += e.amount_cents;
      else b.pending += e.amount_cents;
    } else if (e.entry_type === 'reversal') {
      b.reversed += Math.abs(e.amount_cents);
      const accrual = e.attribution_id ? accrualByAttribution.get(e.attribution_id) : null;
      if (accrual && !matured(accrual)) continue;
      b.eligible += e.amount_cents;
    } else if (e.entry_type === 'payout') {
      const payoutStatus = payoutStatusById.get(e.payout_id);
      if (payoutStatus === 'paid') b.paid += Math.abs(e.amount_cents);
      if (payoutStatus === 'processing') b.processing += Math.abs(e.amount_cents);
      b.eligible += e.amount_cents;
    }
  }

  const accountByUser = new Map<string, any>(
    (accounts ?? []).map((a: any) => [a.referrer_user_id as string, a])
  );
  const thresholdCents = getPayoutThresholdCents();
  const pricing = await getPricingWindow();
  const activeTiers = getReferralRewardTiers(pricing.lifetime_plan_code);

  const queue = (codes ?? []).map((c: any) => {
    const b = balances.get(c.referrer_user_id) ?? { pending: 0, eligible: 0, processing: 0, paid: 0, reversed: 0 };
    const account = accountByUser.get(c.referrer_user_id);
    return {
      referrerUserId:  c.referrer_user_id,
      code:            c.code,
      codeStatus:      c.status,
      awaitingPayment: awaitingByReferrer.get(c.referrer_user_id) ?? 0,
      pendingCents:    b.pending,
      eligibleCents:   b.eligible,
      processingCents: b.processing,
      paidCents:       b.paid,
      reversedCents:   b.reversed,
      isNegative:      b.eligible < 0,
      connectStatus:   account?.onboarding_status ?? 'none',
      payoutsEnabled:  !!account?.payout_method_ready,
      meetsThreshold:  thresholdCents !== null && b.eligible >= thresholdCents,
    };
  });

  return NextResponse.json({
    config: {
      accrualCents:    REFERRAL_ACCRUAL_CENTS,
      lifetimePriceCents: pricing.lifetime_price_cents,
      pricePhase: pricing.lifetime_plan_code,
      rewardMinCents: activeTiers[0].cents,
      rewardMaxCents: activeTiers[activeTiers.length - 1].cents,
      thresholdCents,                       // null → owner has not configured it
      payoutsEnabled:  arePayoutsEnabled(), // false → outbound payments feature-flagged closed
    },
    queue,
    codes:        codes ?? [],
    attributions: attributions ?? [],
    ledger:       ledger ?? [],
    payouts:      payouts ?? [],
  });
}
