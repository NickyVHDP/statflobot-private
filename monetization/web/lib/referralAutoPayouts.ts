import { randomUUID } from 'crypto';
import { createServiceClient } from './supabase/server';
import { auditLog } from './license';
import { arePayoutsEnabled, getPayoutThresholdCents, hasRealLifetimeEntitlement } from './referrals';
import { executeApprovedPayout, preflightPayout, reconcileProcessingPayouts } from './referralPayouts';
import {
  availableUsdCents,
  retrieveGlobalFinancialAccount,
} from './stripeGlobalPayouts';

export const AUTOMATIC_PAYOUT_APPROVER = 'automatic@statflobot.system';
const DEFAULT_BANK_FEE_CENTS = 150;
const DEFAULT_RESERVE_CENTS = 2500;
const DEFAULT_RECIPIENT_DAILY_CAP_CENTS = 10_000;
const DEFAULT_GLOBAL_DAILY_CAP_CENTS = 25_000;
const DEFAULT_ANNUAL_REVIEW_CENTS = 150_000;

function configuredCents(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

export function getAutoPayoutConfig() {
  return {
    enabled: process.env.REFERRAL_AUTO_PAYOUTS_ENABLED === 'true',
    manualPayoutsEnabled: arePayoutsEnabled(),
    thresholdCents: getPayoutThresholdCents(),
    reserveCents: configuredCents('REFERRAL_AUTO_PAYOUT_RESERVE_CENTS', DEFAULT_RESERVE_CENTS),
    bankFeeCents: configuredCents('REFERRAL_AUTO_PAYOUT_BANK_FEE_CENTS', DEFAULT_BANK_FEE_CENTS),
    recipientDailyCapCents: configuredCents(
      'REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS',
      DEFAULT_RECIPIENT_DAILY_CAP_CENTS,
      1000
    ),
    globalDailyCapCents: configuredCents(
      'REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS',
      DEFAULT_GLOBAL_DAILY_CAP_CENTS,
      1000
    ),
    annualReviewCents: configuredCents(
      'REFERRAL_AUTO_PAYOUT_ANNUAL_REVIEW_CENTS',
      DEFAULT_ANNUAL_REVIEW_CENTS,
      1000
    ),
    financialAccountConfigured: !!process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID,
  };
}

type AutoResult = {
  referrerUserId: string;
  outcome: 'paid' | 'submitted' | 'waiting' | 'blocked' | 'error';
  amountCents?: number;
  reason?: string;
  shortfallCents?: number;
};

export type AutoPayoutRunSummary = {
  runDate: string;
  skipped?: string;
  availableBeforeCents?: number;
  availableAfterReservedCents?: number;
  results: AutoResult[];
};

function utcBoundary(kind: 'day' | 'year'): string {
  const now = new Date();
  return kind === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
}

/**
 * Run one globally leased, fail-closed automatic payout pass.
 *
 * This never funds the Stripe Financial Account. A shortage leaves the reward
 * untouched for the next daily run and records the exact shortfall for the
 * owner dashboard.
 */
export async function runAutomaticReferralPayouts(): Promise<AutoPayoutRunSummary> {
  const svc = createServiceClient();
  const config = getAutoPayoutConfig();
  const runDate = new Date().toISOString().slice(0, 10);
  const summary: AutoPayoutRunSummary = { runDate, results: [] };

  if (!config.enabled || !config.manualPayoutsEnabled) {
    summary.skipped = 'automatic-payouts-disabled';
    return summary;
  }
  if (config.thresholdCents === null || !config.financialAccountConfigured) {
    summary.skipped = 'payout-configuration-incomplete';
    return summary;
  }

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

  await reconcileProcessingPayouts();

  const financialAccountId = process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID!;
  const financialAccount = await retrieveGlobalFinancialAccount(financialAccountId);
  let availableCents = availableUsdCents(financialAccount);
  summary.availableBeforeCents = availableCents;

  const [{ data: accounts, error: accountsError }, { data: recent, error: recentError }] = await Promise.all([
      svc.from('referral_payout_accounts')
        .select('referrer_user_id')
        .eq('payout_method_ready', true)
        .eq('payouts_enabled', true),
      svc.from('referral_payouts')
        .select('referrer_user_id, amount_cents, status, created_at')
        .eq('approved_by_email', AUTOMATIC_PAYOUT_APPROVER)
        .gte('created_at', utcBoundary('year'))
        .in('status', ['processing', 'paid']),
  ]);
  if (accountsError) throw new Error(`Could not read payout accounts: ${accountsError.message}`);
  if (recentError) throw new Error(`Could not read automatic payout history: ${recentError.message}`);

  const dayStart = utcBoundary('day');
  let globalToday = 0;
  const todayByUser = new Map<string, number>();
  const yearByUser = new Map<string, number>();
  for (const payout of recent ?? []) {
      const amount = Number(payout.amount_cents) || 0;
      yearByUser.set(payout.referrer_user_id, (yearByUser.get(payout.referrer_user_id) ?? 0) + amount);
      if (String(payout.created_at) >= dayStart) {
        globalToday += amount;
        todayByUser.set(payout.referrer_user_id, (todayByUser.get(payout.referrer_user_id) ?? 0) + amount);
      }
  }

  for (const account of accounts ?? []) {
      const referrerUserId = String(account.referrer_user_id);
      try {
        if (!(await hasRealLifetimeEntitlement(referrerUserId))) {
          summary.results.push({ referrerUserId, outcome: 'blocked', reason: 'not-a-current-lifetime-user' });
          continue;
        }
        const preflight = await preflightPayout(referrerUserId);
        if (!preflight.ok || !preflight.eligibleCents) {
          summary.results.push({
            referrerUserId,
            outcome: 'waiting',
            reason: preflight.reason ?? 'not-payable',
          });
          continue;
        }

        const amount = preflight.eligibleCents;
        const recipientToday = todayByUser.get(referrerUserId) ?? 0;
        const recipientYear = yearByUser.get(referrerUserId) ?? 0;
        if (recipientToday + amount > config.recipientDailyCapCents) {
          summary.results.push({ referrerUserId, outcome: 'blocked', amountCents: amount, reason: 'recipient-daily-cap' });
          continue;
        }
        if (globalToday + amount > config.globalDailyCapCents) {
          summary.results.push({ referrerUserId, outcome: 'blocked', amountCents: amount, reason: 'global-daily-cap' });
          continue;
        }
        if (recipientYear + amount > config.annualReviewCents) {
          summary.results.push({ referrerUserId, outcome: 'blocked', amountCents: amount, reason: 'annual-tax-review' });
          continue;
        }

        const required = amount + config.bankFeeCents + config.reserveCents;
        if (availableCents < required) {
          summary.results.push({
            referrerUserId,
            outcome: 'waiting',
            amountCents: amount,
            reason: 'insufficient-financial-account-funds',
            shortfallCents: required - availableCents,
          });
          continue;
        }

        const result = await executeApprovedPayout({
          referrerUserId,
          approvedByEmail: AUTOMATIC_PAYOUT_APPROVER,
          maximumAmountCents: amount,
        });
        if (!result.ok) {
          summary.results.push({ referrerUserId, outcome: 'error', amountCents: amount, reason: result.error });
          continue;
        }
        availableCents -= amount + config.bankFeeCents;
        globalToday += amount;
        todayByUser.set(referrerUserId, recipientToday + amount);
        yearByUser.set(referrerUserId, recipientYear + amount);
        summary.results.push({
          referrerUserId,
          outcome: result.providerStatus === 'paid' ? 'paid' : 'submitted',
          amountCents: result.amountCents,
        });
        await auditLog(referrerUserId, 'referral_payout_automatically_approved', {
          payout_id: result.payoutId,
          amount_cents: result.amountCents,
          run_date: runDate,
        });
      } catch (err: any) {
        summary.results.push({ referrerUserId, outcome: 'error', reason: String(err?.message ?? err).slice(0, 300) });
      }
  }
  summary.availableAfterReservedCents = availableCents;

  // Only a normally completed pass is finalized. If setup, Stripe, or the
  // database throws unexpectedly, the lease expires and a later invocation
  // may safely retry instead of suppressing payouts for the rest of the day.
  const { error: finishError } = await svc.rpc('finish_referral_auto_payout_run', {
    p_run_date: runDate,
    p_run_token: runToken,
    p_summary: summary,
  });
  if (finishError) throw new Error(`Could not finalize automatic payout run: ${finishError.message}`);
  return summary;
}
