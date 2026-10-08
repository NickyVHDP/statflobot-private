import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getAuthUser } from '@/lib/supabase/server';
import { isAdminEmail, isOwnerEmail } from '@/lib/admin';
import {
  getPayoutThresholdCents,
  arePayoutsEnabled,
  REFERRAL_ACCRUAL_CENTS,
  REFERRAL_HOLD_DAYS,
  getReferralRewardTiers,
} from '@/lib/referrals';
import { reconcileProcessingPayouts } from '@/lib/referralPayouts';
import { getPricingWindow } from '@/lib/pricing';
import {
  AUTOMATIC_PAYOUT_APPROVER,
  AUTO_PAYOUT_RUN_UTC_HOUR,
  AUTO_PAYOUT_RUN_UTC_MINUTE,
  getAutoPayoutConfig,
} from '@/lib/referralAutoPayouts';
import { nextDailyRunAt } from '@/lib/referralAutoPayoutPolicy';
import { availableUsdCents, retrieveGlobalFinancialAccount } from '@/lib/stripeGlobalPayouts';

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

  const [{ data: codes }, { data: attributions }, { data: ledger }, { data: payouts }, { data: accounts }, { data: earlyApprovals }] =
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
        .select('referrer_user_id, stripe_recipient_id, onboarding_status, payouts_enabled, details_submitted, payout_method_ready, payout_method_type, provider, auto_payouts_blocked_at, auto_payouts_blocked_reason'),
      svc.from('referral_early_payout_approvals')
        .select('attribution_id, referrer_user_id, approved_at'),
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
  const earlyApprovedAttributions = new Set(
    (earlyApprovals ?? []).map((approval: any) => approval.attribution_id as string)
  );
  const matured = (entry: any) =>
    new Date(entry.eligible_at).getTime() <= now ||
    earlyApprovedAttributions.has(entry.attribution_id);
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
  const standardTiers = getReferralRewardTiers('lifetime_standard');
  const auto = getAutoPayoutConfig();
  let financialAccountAvailableCents: number | null = null;
  if (auto.financialAccountConfigured) {
    try {
      financialAccountAvailableCents = availableUsdCents(
        await retrieveGlobalFinancialAccount(process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID!)
      );
    } catch (err: any) {
      console.warn('[ADMIN_REFERRAL_FINANCIAL_BALANCE_UNAVAILABLE]', String(err?.message ?? err));
    }
  }
  const { data: lastAutoRun } = await svc
    .from('referral_auto_payout_runs')
    .select('run_date, status, started_at, completed_at, summary')
    .order('run_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Annual totals for tax readiness. Counted from January 1 UTC over money that
  // left or is leaving the account — processing included, because a payout in
  // transit is still this year's outflow.
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
  const { data: yearPayouts } = await svc
    .from('referral_payouts')
    .select('amount_cents, approved_by_email')
    .gte('created_at', yearStart)
    .in('status', ['processing', 'paid']);
  let annualPaidCents = 0;
  let annualAutomaticPaidCents = 0;
  for (const payout of yearPayouts ?? []) {
    const amount = Number(payout.amount_cents) || 0;
    annualPaidCents += amount;
    if (payout.approved_by_email === AUTOMATIC_PAYOUT_APPROVER) annualAutomaticPaidCents += amount;
  }

  const reserveCents = auto.limits?.reserveCents ?? null;
  const attributionById = new Map<string, any>(
    (attributions ?? []).map((attribution: any) => [attribution.id as string, attribution])
  );
  const accrualByAttributionId = new Map<string, any>(
    (ledger ?? [])
      .filter((entry: any) => entry.entry_type === 'accrual' && entry.attribution_id)
      .map((entry: any) => [entry.attribution_id as string, entry])
  );

  const pendingRewardsByReferrer = new Map<string, Array<{
    attributionId: string;
    amountCents: number;
    purchasedAt: string;
    eligibleAt: string;
  }>>();
  for (const entry of ledger ?? []) {
    if (
      entry.entry_type !== 'accrual' ||
      !entry.attribution_id ||
      reversedAttributions.has(entry.attribution_id) ||
      matured(entry)
    ) continue;
    const attribution = attributionById.get(entry.attribution_id);
    if (!attribution) continue;
    const rewards = pendingRewardsByReferrer.get(entry.referrer_user_id) ?? [];
    rewards.push({
      attributionId: entry.attribution_id,
      amountCents: entry.amount_cents,
      purchasedAt: attribution.created_at,
      eligibleAt: entry.eligible_at,
    });
    pendingRewardsByReferrer.set(entry.referrer_user_id, rewards);
  }

  const queue = (codes ?? []).map((c: any) => {
    const b = balances.get(c.referrer_user_id) ?? { pending: 0, eligible: 0, processing: 0, paid: 0, reversed: 0 };
    const account = accountByUser.get(c.referrer_user_id);
    return {
      referrerUserId:  c.referrer_user_id,
      code:            c.code,
      codeStatus:      c.status,
      awaitingPayment: awaitingByReferrer.get(c.referrer_user_id) ?? 0,
      pendingCents:    b.pending,
      pendingRewards:  pendingRewardsByReferrer.get(c.referrer_user_id) ?? [],
      eligibleCents:   b.eligible,
      processingCents: b.processing,
      paidCents:       b.paid,
      reversedCents:   b.reversed,
      isNegative:      b.eligible < 0,
      connectStatus:   account?.onboarding_status ?? 'none',
      payoutsEnabled:  !!account?.payout_method_ready,
      meetsThreshold:  thresholdCents !== null && b.eligible >= thresholdCents,
      autoPayoutsBlocked: !!account?.auto_payouts_blocked_at,
      autoPayoutsBlockedReason: account?.auto_payouts_blocked_reason ?? null,
      // The same refusal ladder the daily run walks, in the same order, so the
      // dashboard never claims a payout is coming that the run would refuse.
      automaticNextStep: !auto.enabled
        ? 'Automatic payouts disabled'
        : auto.invalidSettings.length > 0 || reserveCents === null
          ? 'Automatic payout limits not configured'
          : account?.auto_payouts_blocked_at
            ? 'Paused after a failed payout — owner review'
            : !account?.payout_method_ready
              ? 'Waiting for bank setup'
              : b.eligible < 0
                ? 'Blocked: negative balance'
                : thresholdCents === null || b.eligible < thresholdCents
                  ? 'Waiting for an eligible reward'
                  : financialAccountAvailableCents === null
                    ? 'Funding balance unavailable'
                    : financialAccountAvailableCents < b.eligible + auto.feeCents + reserveCents
                      ? `Waiting for $${((b.eligible + auto.feeCents + reserveCents - financialAccountAvailableCents) / 100).toFixed(2)} funding`
                      : 'Scheduled for the next daily run',
    };
  });

  const config = {
    accrualCents:    REFERRAL_ACCRUAL_CENTS,
    holdDays:        REFERRAL_HOLD_DAYS,
    lifetimePriceCents: pricing.lifetime_price_cents,
    earlyLifetimePriceCents: pricing.early_lifetime_price_cents,
    standardLifetimePriceCents: pricing.standard_lifetime_price_cents,
    pricePhase: pricing.lifetime_plan_code,
    tiers: activeTiers.map((tier) => ({
      min: tier.min,
      max: Number.isFinite(tier.max) ? tier.max : null,
      cents: tier.cents,
    })),
    standardTiers: standardTiers.map((tier) => ({
      min: tier.min,
      max: Number.isFinite(tier.max) ? tier.max : null,
      cents: tier.cents,
    })),
    earlyPricing: {
      active: pricing.isEarlyAdopter,
      daysRemaining: pricing.daysRemaining,
      cap: pricing.earlyBird.cap,
      sold: pricing.earlyBird.sold,
      remaining: pricing.earlyBird.remaining,
    },
    rewardMinCents: activeTiers[0].cents,
    rewardMaxCents: activeTiers[activeTiers.length - 1].cents,
    thresholdCents,                       // null → owner has not configured it
    payoutsEnabled:  arePayoutsEnabled(), // false → outbound payments feature-flagged closed
    automaticPayoutsEnabled: auto.enabled,
    // Non-empty → every automatic payout is refused until these are set.
    automaticSettingsInvalid: auto.invalidSettings,
    financialAccountConfigured: auto.financialAccountConfigured,
    financialAccountAvailableCents,
    reserveCents,                                              // null → not configured
    bankFeeCents: auto.feeCents,
    recipientDailyCapCents: auto.limits?.recipientDailyCapCents ?? null,
    globalDailyCapCents: auto.limits?.globalDailyCapCents ?? null,
    taxReviewCeilingCents: auto.limits?.taxReviewCeilingCents ?? null,
    annualPaidCents,
    annualAutomaticPaidCents,
    nextAutomaticRunAt: nextDailyRunAt(Date.now(), AUTO_PAYOUT_RUN_UTC_HOUR, AUTO_PAYOUT_RUN_UTC_MINUTE),
    lastAutomaticRun: lastAutoRun ?? null,
  };

  // The desktop Admin tab needs only the aggregate owner queue. Do not send
  // raw attribution, buyer, ledger, or approval history fields to that surface.
  // The full audit remains available on the separately guarded web admin page.
  if (req.nextUrl.searchParams.get('view') === 'overview') {
    return NextResponse.json({ config, queue });
  }

  // The desktop Owner Command Center may show buyer identities and perform
  // payout actions, but only for the single authenticated business owner.
  // General admins continue to receive the identity-free overview above or
  // use the separately guarded web audit page.
  if (req.nextUrl.searchParams.get('view') === 'owner-desktop') {
    if (!isOwnerEmail(user.email)) {
      return NextResponse.json({ error: 'Only the StatfloBot owner can view the referral ledger.' }, { status: 403 });
    }

    const referrerIds: string[] = [...new Set<string>(
      (codes ?? []).map((code: any) => String(code.referrer_user_id)).filter(Boolean)
    )];
    const { data: profiles, error: profilesError } = referrerIds.length > 0
      ? await svc.from('profiles').select('id, email, full_name').in('id', referrerIds)
      : { data: [] as any[], error: null };
    if (profilesError) {
      console.warn(`[ADMIN_REFERRAL_PROFILE_LOOKUP_FAILED] ${profilesError.message}`);
    }
    const profileById = new Map<string, any>(
      (profiles ?? []).map((profile: any) => [profile.id as string, profile])
    );
    const authEmailById = new Map<string, string>();
    await Promise.all(referrerIds.map(async (referrerId) => {
      if (profileById.get(referrerId)?.email) return;
      const { data: authData } = await svc.auth.admin.getUserById(referrerId);
      if (authData?.user?.email) authEmailById.set(referrerId, authData.user.email);
    }));

    const ownerQueue = queue.map((row: any) => {
      const profile = profileById.get(row.referrerUserId);
      return {
        ...row,
        referrerEmail: profile?.email ?? authEmailById.get(row.referrerUserId) ?? null,
        referrerName: profile?.full_name ?? null,
      };
    });

    const referralActivity = (attributions ?? []).map((attribution: any) => {
      const accrual = accrualByAttributionId.get(attribution.id);
      const profile = profileById.get(attribution.referrer_user_id);
      const reversed = reversedAttributions.has(attribution.id);
      const earlyApproved = earlyApprovedAttributions.has(attribution.id);
      const eligibleAt = accrual?.eligible_at ?? null;
      const eligible = !!accrual && (
        earlyApproved || (eligibleAt && new Date(eligibleAt).getTime() <= now)
      );
      return {
        attributionId: attribution.id,
        referrerUserId: attribution.referrer_user_id,
        referrerEmail: profile?.email ?? authEmailById.get(attribution.referrer_user_id) ?? null,
        referrerName: profile?.full_name ?? null,
        referralCode: attribution.referral_code,
        referredUserId: attribution.referred_user_id,
        referredEmail: attribution.referred_email,
        purchasedAt: attribution.created_at,
        eligibleAt,
        amountCents: Number(attribution.reward_cents) || Number(accrual?.amount_cents) || 0,
        qualifiedPosition: attribution.qualified_position,
        status: reversed ? 'reversed' : eligible ? 'eligible' : 'clearing',
        earlyApproved,
      };
    });

    return NextResponse.json({
      config,
      queue: ownerQueue,
      referralActivity,
      payouts: payouts ?? [],
    });
  }

  return NextResponse.json({
    config,
    queue,
    codes:        codes ?? [],
    attributions: attributions ?? [],
    ledger:       ledger ?? [],
    payouts:      payouts ?? [],
  });
}
