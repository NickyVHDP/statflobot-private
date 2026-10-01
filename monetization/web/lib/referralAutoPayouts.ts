import { randomUUID } from 'crypto';
import { createServiceClient } from './supabase/server';
import { auditLog } from './license';
import {
  arePayoutsEnabled,
  getPayoutThresholdCents,
  getReferralBalance,
  hasRealLifetimeEntitlement,
} from './referrals';
import { executeApprovedPayout, reconcileProcessingPayouts } from './referralPayouts';
import { availableUsdCents, retrieveGlobalFinancialAccount } from './stripeGlobalPayouts';
import {
  AUTOMATIC_PAYOUT_APPROVER,
  REFERRAL_AUTO_PAYOUT_FEE_CENTS,
  type AutoPayoutBlockReason,
  type AutoPayoutLimits,
  daysUntil,
  dueFundingReminder,
  evaluateAutoPayoutGuards,
  evaluateFunding,
  readAutoPayoutLimits,
} from './referralAutoPayoutPolicy';
import {
  noticeAutoPayoutsBlocked,
  noticeAwaitingFunding,
  noticeBankNotReady,
  noticeDailyCap,
  noticeFundingReminder,
  noticeLimitsNotConfigured,
  noticeTaxReviewCeiling,
  sendOwnerNotice,
} from './referralOwnerNotices';

/**
 * lib/referralAutoPayouts.ts
 *
 * The daily automatic referral payout run.
 *
 * Money moves here only through the same primitives the owner's manual approval
 * uses — reserve_global_referral_payout, the Stripe idempotency key, and
 * finalize_global_referral_payout. This module adds no new way to pay; it adds
 * a set of refusals and an audited lease around the existing one.
 *
 * FOUR THINGS THIS RUN NEVER DOES
 *   1. Fund itself. It reads the Financial Account balance and nothing more —
 *      there is no pull, no transfer, no top-up anywhere in this path.
 *   2. Pay part of a balance. Every cap is a refusal, never a partial payment.
 *   3. Call Stripe when the answer is already no. Configuration, bank and cap
 *      refusals are decided from local state before any Stripe request.
 *   4. Retry into a failure. A failed or returned automatic payout pauses that
 *      recipient until the owner clears it.
 */

export { AUTOMATIC_PAYOUT_APPROVER };

/** Scheduled cron time, mirrored from vercel.json for the owner dashboard. */
export const AUTO_PAYOUT_RUN_UTC_HOUR = 15;
export const AUTO_PAYOUT_RUN_UTC_MINUTE = 17;

/** How far ahead the run looks for rewards that will need funding soon. */
const REMINDER_HORIZON_DAYS = 7;

export interface AutoPayoutConfig {
  enabled: boolean;
  manualPayoutsEnabled: boolean;
  thresholdCents: number | null;
  financialAccountConfigured: boolean;
  feeCents: number;
  /** null whenever any limit is unset or malformed — nothing may pay. */
  limits: AutoPayoutLimits | null;
  /** Env var names the owner still has to set correctly. */
  invalidSettings: string[];
}

/**
 * Read every switch and limit that governs automatic payouts.
 *
 * REFERRAL_AUTO_PAYOUTS_ENABLED is a SEPARATE switch from the manual
 * REFERRAL_PAYOUTS_ENABLED master flag, and both must be exactly "true". Turning
 * on manual payouts must never turn on automation as a side effect.
 */
export function getAutoPayoutConfig(): AutoPayoutConfig {
  const { limits, invalid } = readAutoPayoutLimits(process.env as Record<string, string | undefined>);
  const thresholdCents = getPayoutThresholdCents();
  const financialAccountConfigured = !!process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID;

  const invalidSettings = [...invalid];
  if (thresholdCents === null) invalidSettings.push('REFERRAL_PAYOUT_THRESHOLD_CENTS');
  if (!financialAccountConfigured) invalidSettings.push('STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID');

  return {
    enabled: process.env.REFERRAL_AUTO_PAYOUTS_ENABLED === 'true',
    manualPayoutsEnabled: arePayoutsEnabled(),
    thresholdCents,
    financialAccountConfigured,
    feeCents: REFERRAL_AUTO_PAYOUT_FEE_CENTS,
    limits,
    invalidSettings,
  };
}

type AutoResult = {
  referrerUserId: string;
  outcome: 'paid' | 'submitted' | 'waiting' | 'blocked' | 'error';
  amountCents?: number;
  reason?: AutoPayoutBlockReason | string;
  shortfallCents?: number;
};

export type AutoPayoutRunSummary = {
  runDate: string;
  skipped?: string;
  stripeQueried: boolean;
  availableBeforeCents?: number;
  availableAfterReservedCents?: number;
  blockedAfterFailure: number;
  remindersSent: number;
  results: AutoResult[];
};

function utcBoundary(kind: 'day' | 'year', now: Date): string {
  return kind === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
}

/**
 * Pause automation for every recipient whose AUTOMATIC payout ended in failure.
 *
 * The reward was already restored to the ledger by
 * finalize_global_referral_payout(); this decides only who may try again without
 * a human. block_referral_auto_payouts_for_payout() is exactly-once per payout,
 * so calling this repeatedly is safe and cannot double-count a failure.
 */
async function applyFailureBlocks(): Promise<number> {
  const svc = createServiceClient();
  const { data: failures, error } = await svc
    .from('referral_payouts')
    .select('id, referrer_user_id, amount_cents, failure_reason')
    .eq('approved_by_email', AUTOMATIC_PAYOUT_APPROVER)
    .eq('status', 'failed')
    .eq('auto_block_applied', false)
    .limit(50);
  if (error) {
    console.warn('[REFERRAL_AUTO_PAYOUT_FAILURE_SCAN_FAILED]', error.message);
    return 0;
  }

  let blocked = 0;
  for (const payout of failures ?? []) {
    const reason = String(payout.failure_reason ?? 'Stripe did not complete the payout');
    const { data: applied, error: blockError } = await svc.rpc('block_referral_auto_payouts_for_payout', {
      p_payout_id: payout.id,
      p_auto_approver: AUTOMATIC_PAYOUT_APPROVER,
      p_reason: reason,
    });
    if (blockError) {
      console.error('[REFERRAL_AUTO_PAYOUT_BLOCK_FAILED]', payout.id, blockError.message);
      continue;
    }
    if (applied !== true) continue;

    blocked += 1;
    console.warn(`[REFERRAL_AUTO_PAYOUT_BLOCKED] payout=${payout.id} referrer=${payout.referrer_user_id}`);
    await auditLog(payout.referrer_user_id, 'referral_auto_payouts_blocked', {
      payout_id: payout.id,
      amount_cents: payout.amount_cents,
      reason,
    });
    await sendOwnerNotice(noticeAutoPayoutsBlocked({
      referrerUserId: payout.referrer_user_id,
      payoutId: payout.id,
      amountCents: payout.amount_cents,
      reason,
    }));
  }
  return blocked;
}

/** One referrer's local state, gathered before any Stripe call. */
type Candidate = {
  referrerUserId: string;
  eligibleCents: number;
  bankReady: boolean;
  blocked: boolean;
  payoutInFlight: boolean;
};

/**
 * Run one leased, fail-closed automatic payout pass.
 *
 * A shortage never becomes a smaller payout, a borrowed payout, or a funded
 * account. It becomes an unpaid reward, an exact shortfall in the owner's inbox,
 * and another attempt tomorrow.
 */
export async function runAutomaticReferralPayouts(): Promise<AutoPayoutRunSummary> {
  const svc = createServiceClient();
  const config = getAutoPayoutConfig();
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const summary: AutoPayoutRunSummary = {
    runDate,
    stripeQueried: false,
    blockedAfterFailure: 0,
    remindersSent: 0,
    results: [],
  };

  // Both switches are deliberate owner decisions. Off is not an error, so it
  // raises no alarm — it just does nothing at all.
  if (!config.enabled || !config.manualPayoutsEnabled) {
    summary.skipped = 'automatic-payouts-disabled';
    return summary;
  }

  // Fail closed on configuration BEFORE Stripe is contacted or a lease is
  // taken: an unusable limit is not a run that found nothing to do, it is a run
  // that must not happen.
  if (!config.limits || config.invalidSettings.length > 0) {
    summary.skipped = 'payout-configuration-incomplete';
    console.error(`[REFERRAL_AUTO_PAYOUT_CONFIG_INVALID] settings=${config.invalidSettings.join(',')}`);
    await sendOwnerNotice(noticeLimitsNotConfigured({ invalid: config.invalidSettings }));
    return summary;
  }
  const limits = config.limits;

  // One winner per UTC day. A duplicate cron delivery, a manual re-trigger and a
  // retry after a timeout all lose this race and return without paying.
  const runToken = randomUUID();
  const { data: leased, error: leaseError } = await svc.rpc('claim_referral_auto_payout_run', {
    p_run_date: runDate,
    p_run_token: runToken,
    p_lease_seconds: 900,
  });
  if (leaseError) throw new Error(`Could not acquire automatic payout lease: ${leaseError.message}`);
  if (leased !== true) {
    summary.skipped = 'already-run-or-running';
    return summary;
  }

  // In-flight money is reconciled first, so a payout that posted, failed or was
  // returned since yesterday is settled before anything new is considered.
  await reconcileProcessingPayouts();
  summary.blockedAfterFailure = await applyFailureBlocks();

  const [{ data: referrers, error: referrersError }, { data: accounts, error: accountsError },
         { data: history, error: historyError }, { data: inFlight, error: inFlightError }] =
    await Promise.all([
      svc.from('referral_codes').select('referrer_user_id'),
      svc.from('referral_payout_accounts')
        .select('referrer_user_id, payout_method_ready, auto_payouts_blocked_at'),
      svc.from('referral_payouts')
        .select('referrer_user_id, amount_cents, created_at')
        .eq('approved_by_email', AUTOMATIC_PAYOUT_APPROVER)
        .gte('created_at', utcBoundary('year', now))
        .in('status', ['processing', 'paid']),
      svc.from('referral_payouts')
        .select('referrer_user_id')
        .eq('status', 'processing'),
    ]);
  if (referrersError) throw new Error(`Could not read referrers: ${referrersError.message}`);
  if (accountsError) throw new Error(`Could not read payout accounts: ${accountsError.message}`);
  if (historyError) throw new Error(`Could not read automatic payout history: ${historyError.message}`);
  if (inFlightError) throw new Error(`Could not read in-flight payouts: ${inFlightError.message}`);

  const accountByUser = new Map<string, any>(
    (accounts ?? []).map((a: any) => [String(a.referrer_user_id), a])
  );
  const inFlightUsers = new Set((inFlight ?? []).map((p: any) => String(p.referrer_user_id)));

  const dayStart = utcBoundary('day', now);
  let globalPaidTodayCents = 0;
  const paidTodayByUser = new Map<string, number>();
  const paidThisYearByUser = new Map<string, number>();
  for (const payout of history ?? []) {
    const id = String(payout.referrer_user_id);
    const amount = Number(payout.amount_cents) || 0;
    paidThisYearByUser.set(id, (paidThisYearByUser.get(id) ?? 0) + amount);
    if (String(payout.created_at) >= dayStart) {
      globalPaidTodayCents += amount;
      paidTodayByUser.set(id, (paidTodayByUser.get(id) ?? 0) + amount);
    }
  }

  // ── Local evaluation: every refusal that needs no Stripe call ──────────────
  const candidates: Candidate[] = [];
  let totalMaturedCents = 0;

  // Every candidate accepted so far in THIS run also spends the global daily
  // cap. Without this, three recipients evaluated against an empty day would
  // each pass a $250 cap independently and then pay out $300 between them.
  // Counting a planned payout that later fails its funding check only makes the
  // cap stricter for the rest of the run, which is the safe direction.
  let plannedGlobalCents = 0;

  for (const row of referrers ?? []) {
    const referrerUserId = String(row.referrer_user_id);
    try {
      const balance = await getReferralBalance(referrerUserId);
      const account = accountByUser.get(referrerUserId);

      // A zero or negative balance is the overwhelmingly common case. Skip it
      // here rather than paying for an entitlement lookup that cannot change
      // the outcome.
      if (balance.eligibleCents <= 0) {
        summary.results.push({
          referrerUserId,
          outcome: 'waiting',
          reason: balance.eligibleCents < 0 ? 'negative-balance' : 'no-matured-balance',
        });
        continue;
      }
      totalMaturedCents += balance.eligibleCents;

      const guards = evaluateAutoPayoutGuards({
        manualPayoutsEnabled: config.manualPayoutsEnabled,
        autoPayoutsEnabled: config.enabled,
        thresholdCents: config.thresholdCents,
        limits,
        eligibleCents: balance.eligibleCents,
        hasRealLifetimeEntitlement: await hasRealLifetimeEntitlement(referrerUserId),
        bankReady: !!account?.payout_method_ready,
        autoPayoutsBlocked: !!account?.auto_payouts_blocked_at,
        payoutInFlight: inFlightUsers.has(referrerUserId),
        recipientPaidTodayCents: paidTodayByUser.get(referrerUserId) ?? 0,
        globalPaidTodayCents: globalPaidTodayCents + plannedGlobalCents,
        recipientPaidThisYearCents: paidThisYearByUser.get(referrerUserId) ?? 0,
      });

      if (!guards.ok) {
        summary.results.push({
          referrerUserId,
          outcome: guards.reason === 'below-threshold' || guards.reason === 'no-matured-balance'
            ? 'waiting'
            : 'blocked',
          amountCents: balance.eligibleCents,
          reason: guards.reason,
        });
        await notifyGuardRefusal(guards.reason, {
          referrerUserId,
          amountCents: balance.eligibleCents,
          detail: guards.detail,
          limits,
          paidThisYearCents: paidThisYearByUser.get(referrerUserId) ?? 0,
          runDate,
          year: now.getUTCFullYear(),
        });
        continue;
      }

      plannedGlobalCents += guards.amountCents;
      candidates.push({
        referrerUserId,
        eligibleCents: guards.amountCents,
        bankReady: true,
        blocked: false,
        payoutInFlight: false,
      });
    } catch (err: any) {
      summary.results.push({
        referrerUserId,
        outcome: 'error',
        reason: String(err?.message ?? err).slice(0, 300),
      });
    }
  }

  // Rewards that will mature within the reminder horizon, so the funding
  // warnings can be sent from the same balance read.
  const upcoming = await readUpcomingRewards(now);

  // ── Stripe ────────────────────────────────────────────────────────────────
  // Read the Financial Account balance only when something depends on it. A run
  // in which every recipient was already refused makes no Stripe call at all.
  let availableCents: number | null = null;
  if (candidates.length > 0 || upcoming.length > 0) {
    summary.stripeQueried = true;
    try {
      availableCents = availableUsdCents(
        await retrieveGlobalFinancialAccount(process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID!)
      );
      summary.availableBeforeCents = availableCents;
    } catch (err: any) {
      // An unreadable balance is treated as no balance. Nothing is sent.
      console.error('[REFERRAL_AUTO_PAYOUT_BALANCE_UNAVAILABLE]', String(err?.message ?? err));
    }
  }

  for (const candidate of candidates) {
    const funding = evaluateFunding({
      amountCents: candidate.eligibleCents,
      reserveCents: limits.reserveCents,
      availableCents,
    });

    if (!funding.ok) {
      summary.results.push({
        referrerUserId: candidate.referrerUserId,
        outcome: 'waiting',
        amountCents: candidate.eligibleCents,
        reason: funding.reason,
        shortfallCents: funding.shortfallCents,
      });
      await sendOwnerNotice(noticeAwaitingFunding({
        referrerUserId: candidate.referrerUserId,
        amountCents: candidate.eligibleCents,
        requiredCents: funding.requiredCents,
        availableCents: availableCents ?? 0,
        shortfallCents: funding.shortfallCents,
      }));
      continue;
    }

    try {
      const result = await executeApprovedPayout({
        referrerUserId: candidate.referrerUserId,
        approvedByEmail: AUTOMATIC_PAYOUT_APPROVER,
        maximumAmountCents: candidate.eligibleCents,
      });
      if (!result.ok) {
        summary.results.push({
          referrerUserId: candidate.referrerUserId,
          outcome: 'error',
          amountCents: candidate.eligibleCents,
          reason: result.error,
        });
        continue;
      }

      // Reserve the fee alongside the payout so a second recipient in the same
      // run cannot be paid out of money this one already needs.
      availableCents = (availableCents ?? 0) - result.amountCents - config.feeCents;
      globalPaidTodayCents += result.amountCents;
      paidTodayByUser.set(
        candidate.referrerUserId,
        (paidTodayByUser.get(candidate.referrerUserId) ?? 0) + result.amountCents
      );
      paidThisYearByUser.set(
        candidate.referrerUserId,
        (paidThisYearByUser.get(candidate.referrerUserId) ?? 0) + result.amountCents
      );
      summary.results.push({
        referrerUserId: candidate.referrerUserId,
        outcome: result.providerStatus === 'paid' ? 'paid' : 'submitted',
        amountCents: result.amountCents,
      });
      await auditLog(candidate.referrerUserId, 'referral_payout_automatically_approved', {
        payout_id: result.payoutId,
        amount_cents: result.amountCents,
        run_date: runDate,
      });
    } catch (err: any) {
      summary.results.push({
        referrerUserId: candidate.referrerUserId,
        outcome: 'error',
        amountCents: candidate.eligibleCents,
        reason: String(err?.message ?? err).slice(0, 300),
      });
    }
  }

  // A payout that Stripe rejected outright has already restored its balance;
  // pause that recipient now rather than a day from now.
  summary.blockedAfterFailure += await applyFailureBlocks();

  summary.availableAfterReservedCents = availableCents ?? undefined;
  summary.remindersSent = await sendFundingReminders({
    upcoming,
    availableCents,
    reserveCents: limits.reserveCents,
    committedCents: totalMaturedCents,
    now,
  });

  // Only a normally completed pass is finalized. If Stripe or the database
  // throws, the lease expires and a later invocation may safely retry rather
  // than suppressing payouts for the rest of the day.
  const { error: finishError } = await svc.rpc('finish_referral_auto_payout_run', {
    p_run_date: runDate,
    p_run_token: runToken,
    p_summary: summary,
  });
  if (finishError) throw new Error(`Could not finalize automatic payout run: ${finishError.message}`);
  return summary;
}

/** Owner email for a refusal that money alone cannot fix. */
async function notifyGuardRefusal(
  reason: AutoPayoutBlockReason,
  ctx: {
    referrerUserId: string;
    amountCents: number;
    detail: string;
    limits: AutoPayoutLimits;
    paidThisYearCents: number;
    runDate: string;
    year: number;
  }
): Promise<void> {
  if (reason === 'bank-not-ready') {
    await sendOwnerNotice(noticeBankNotReady({
      referrerUserId: ctx.referrerUserId,
      amountCents: ctx.amountCents,
      detail: ctx.detail,
    }));
    return;
  }
  if (reason === 'recipient-daily-cap' || reason === 'global-daily-cap') {
    await sendOwnerNotice(noticeDailyCap({
      referrerUserId: ctx.referrerUserId,
      scope: reason === 'global-daily-cap' ? 'global' : 'recipient',
      amountCents: ctx.amountCents,
      capCents: reason === 'global-daily-cap'
        ? ctx.limits.globalDailyCapCents
        : ctx.limits.recipientDailyCapCents,
      runDate: ctx.runDate,
    }));
    return;
  }
  if (reason === 'tax-review-ceiling') {
    await sendOwnerNotice(noticeTaxReviewCeiling({
      referrerUserId: ctx.referrerUserId,
      amountCents: ctx.amountCents,
      paidThisYearCents: ctx.paidThisYearCents,
      ceilingCents: ctx.limits.taxReviewCeilingCents,
      year: ctx.year,
    }));
  }
  // Every other refusal is either an owner decision already made (flags off),
  // an ordinary waiting state, or the separately-notified failure pause.
}

type UpcomingReward = {
  attributionId: string;
  referrerUserId: string;
  amountCents: number;
  eligibleAt: string;
};

/** Not-yet-matured rewards inside the reminder horizon, reversals excluded. */
async function readUpcomingRewards(now: Date): Promise<UpcomingReward[]> {
  const svc = createServiceClient();
  const horizon = new Date(now.getTime() + REMINDER_HORIZON_DAYS * 86_400_000).toISOString();

  const { data: accruals, error } = await svc
    .from('referral_ledger')
    .select('attribution_id, referrer_user_id, amount_cents, eligible_at')
    .eq('entry_type', 'accrual')
    .gt('eligible_at', now.toISOString())
    .lte('eligible_at', horizon)
    .limit(200);
  if (error) {
    console.warn('[REFERRAL_AUTO_PAYOUT_UPCOMING_SCAN_FAILED]', error.message);
    return [];
  }
  const rows = (accruals ?? []).filter((r: any) => r.attribution_id);
  if (rows.length === 0) return [];

  const { data: reversals } = await svc
    .from('referral_ledger')
    .select('attribution_id')
    .eq('entry_type', 'reversal')
    .in('attribution_id', rows.map((r: any) => r.attribution_id));
  const reversed = new Set((reversals ?? []).map((r: any) => String(r.attribution_id)));

  return rows
    .filter((r: any) => !reversed.has(String(r.attribution_id)))
    .map((r: any) => ({
      attributionId: String(r.attribution_id),
      referrerUserId: String(r.referrer_user_id),
      amountCents: Number(r.amount_cents) || 0,
      eligibleAt: String(r.eligible_at),
    }));
}

/**
 * 7-day and 1-day funding warnings.
 *
 * Sent only when the projected requirement — everything already matured, plus
 * this reward, plus the fee and the reserve — exceeds what is in the account
 * today. A reward that is already funded generates no mail.
 */
async function sendFundingReminders(input: {
  upcoming: UpcomingReward[];
  availableCents: number | null;
  reserveCents: number;
  committedCents: number;
  now: Date;
}): Promise<number> {
  let sent = 0;
  for (const reward of input.upcoming) {
    const reminder = dueFundingReminder(daysUntil(Date.parse(reward.eligibleAt), input.now.getTime()));
    if (!reminder) continue;

    const funding = evaluateFunding({
      amountCents: input.committedCents + reward.amountCents,
      reserveCents: input.reserveCents,
      availableCents: input.availableCents,
    });
    if (funding.ok) continue;

    const result = await sendOwnerNotice(noticeFundingReminder({
      attributionId: reward.attributionId,
      referrerUserId: reward.referrerUserId,
      reminder,
      rewardCents: reward.amountCents,
      eligibleAt: reward.eligibleAt,
      shortfallCents: funding.shortfallCents,
      requiredCents: funding.requiredCents,
      availableCents: input.availableCents ?? 0,
    }));
    if (result === 'sent') sent += 1;
  }
  return sent;
}
