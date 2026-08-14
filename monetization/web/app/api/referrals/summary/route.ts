import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import {
  REFERRAL_ACCRUAL_CENTS,
  REFERRAL_HOLD_DAYS,
  REFERRAL_REWARD_CAP_PERCENT,
  REFERRAL_STATUS_DESCRIPTIONS,
  arePayoutsEnabled,
  deriveReferralTimeline,
  getPayoutThresholdCents,
  getReferralRewardTiers,
  getNextReferralMilestone,
  getReferralBalance,
  hasRealLifetimeEntitlement,
} from '@/lib/referrals';
import { reconcileProcessingPayouts, syncGlobalPayoutAccount } from '@/lib/referralPayouts';
import { getPricingWindow } from '@/lib/pricing';
import { getAutoPayoutConfig } from '@/lib/referralAutoPayouts';

/**
 * GET /api/referrals/summary
 *
 * The caller's own referral state: code, balances, payout/Connect status, and
 * a privacy-safe list of their referred purchases.
 *
 * PRIVACY: referred buyers are never identified to the referrer. Only a date
 * and a status are returned — no email, no name, no user id. That applies to
 * "code applied, not paid yet" entries too: the referrer learns that someone
 * started a checkout, never who. A referrer knowing exactly who bought and when
 * is a real disclosure, and it is not needed for them to trust the balance.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const svc = createServiceClient();

  const [{ data: codeRow }, balance, isLifetime, pricing] = await Promise.all([
    svc.from('referral_codes')
      .select('code, status, created_at')
      .eq('referrer_user_id', user.id)
      .maybeSingle(),
    getReferralBalance(user.id),
    hasRealLifetimeEntitlement(user.id),
    getPricingWindow(),
  ]);

  // Stripe-hosted onboarding returns to the dashboard. Refreshing here makes
  // readiness visible even if a thin-event destination has not been enabled
  // yet. Failure is non-fatal: rewards and balances must remain available.
  if (isLifetime) {
    await Promise.all([
      syncGlobalPayoutAccount(user.id),
      reconcileProcessingPayouts(user.id),
    ]).catch((err: any) => {
      console.warn('[REFERRAL_GLOBAL_PAYOUT_SYNC_SKIPPED]', String(err?.message ?? err));
    });
  }

  const [{ data: attributions }, { data: account }, { data: payouts }, { data: reservations }] = await Promise.all([
    svc.from('referral_attributions')
      .select('id, created_at, plan_code, reward_cents, reward_tier_cents, qualified_position, lifetime_sequence')
      .eq('referrer_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    svc.from('referral_payout_accounts')
      .select('onboarding_status, payouts_enabled, details_submitted, payout_method_ready, payout_method_type, provider')
      .eq('referrer_user_id', user.id)
      .maybeSingle(),
    svc.from('referral_payouts')
      .select('id, amount_cents, status, created_at, completed_at')
      .eq('referrer_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
    // "Code applied, not paid yet" entries. Capped so a burst of abandoned
    // checkouts cannot flood the referrer's list.
    svc.from('referral_reservations')
      .select('created_at, expires_at, status')
      .eq('referrer_user_id', user.id)
      .neq('status', 'converted')
      .order('created_at', { ascending: false })
      .limit(25),
  ]);

  // Which attributions have been reversed — shown to the referrer as "reversed"
  // without disclosing why (refund vs chargeback is the buyer's business).
  const { data: reversals } = await svc
    .from('referral_ledger')
    .select('attribution_id')
    .eq('referrer_user_id', user.id)
    .eq('entry_type', 'reversal');
  const reversedIds = new Set((reversals ?? []).map((r: any) => r.attribution_id));

  const { data: accruals } = await svc
    .from('referral_ledger')
    .select('attribution_id, eligible_at, amount_cents')
    .eq('referrer_user_id', user.id)
    .eq('entry_type', 'accrual');

  // The whole status machine is a pure function so it can be tested without
  // Supabase — see deriveReferralTimeline() in lib/referrals.ts. Nothing here
  // computes money; `balance` above remains the only authority on amounts.
  const referrals = deriveReferralTimeline({
    reservations: (reservations ?? []).map((r: any) => ({
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      status:    r.status,
    })),
    attributions: (attributions ?? []).map((a: any) => ({ id: a.id, createdAt: a.created_at })),
    accruals: (accruals ?? []).map((a: any) => ({
      attributionId: a.attribution_id,
      eligibleAt:    a.eligible_at,
      amountCents:   a.amount_cents,
    })),
    reversedAttributionIds: Array.from(reversedIds) as string[],
    paidCents: balance.paidCents,
  });

  const thresholdCents = getPayoutThresholdCents();
  const rewardPlanCode = pricing.lifetime_plan_code;
  const activeTiers = getReferralRewardTiers(rewardPlanCode);
  const milestone = getNextReferralMilestone(balance.referredCount, rewardPlanCode);
  const automaticPayoutsEnabled = getAutoPayoutConfig().enabled && arePayoutsEnabled();

  return NextResponse.json({
    eligible:      isLifetime,
    code:          codeRow?.code ?? null,
    codeStatus:    codeRow?.status ?? null,
    accrualCents:  REFERRAL_ACCRUAL_CENTS,
    rewards: {
      tiers: activeTiers.map((tier) => ({
        min: tier.min,
        max: Number.isFinite(tier.max) ? tier.max : null,
        cents: tier.cents,
      })),
      capPercent: REFERRAL_REWARD_CAP_PERCENT,
      pricePhase: rewardPlanCode,
      lifetimePriceCents: pricing.lifetime_price_cents,
      netQualifiedCount: balance.referredCount,
      lifetimeCompletedCount: balance.lifetimeReferredCount,
      currentRateCents: milestone.currentRateCents,
      nextRateCents: milestone.nextRateCents,
      nextUnlockAt: milestone.nextUnlockAt,
      referralsToUnlock: milestone.referralsToUnlock,
    },
    holdDays:      REFERRAL_HOLD_DAYS,
    thresholdCents,                       // null when the owner has not set it
    balance,
    referrals,
    statusDescriptions: REFERRAL_STATUS_DESCRIPTIONS,
    // False means no transfer can be sent at all yet — the UI must not imply
    // money is on its way when the program's money-movement flag is closed.
    payoutsConfigured:  arePayoutsEnabled(),
    automaticPayoutsEnabled,
    payouts:       payouts ?? [],
    payoutAccount: {
      status:          account?.onboarding_status ?? 'none',
      payoutsEnabled:  !!account?.payout_method_ready,
      detailsSubmitted: !!account?.details_submitted,
      methodType:      account?.payout_method_type ?? null,
      provider:        account?.provider ?? 'stripe_global_payouts',
    },
    // Temporary response alias for installed desktop versions that still read
    // `connect`. It contains no Connect identifier and can be removed after
    // those versions age out.
    connect: {
      status:          account?.onboarding_status ?? 'none',
      payoutsEnabled:  !!account?.payout_method_ready,
      detailsSubmitted: !!account?.details_submitted,
    },
  });
}
