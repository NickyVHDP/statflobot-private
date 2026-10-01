/**
 * lib/referralAutoPayoutPolicy.ts
 *
 * Every automatic-payout decision, expressed as pure arithmetic.
 *
 * This module has NO imports on purpose — like lib/referralStatus.ts — so the
 * test suite loads and exercises the real shipped rules rather than a
 * re-implementation. Nothing here reads process.env, touches the database,
 * calls Stripe, or reads a clock: the caller injects all of it.
 *
 * THE FAIL-CLOSED RULE
 *
 * Every limit below is an owner money decision. A missing or malformed value is
 * NOT substituted with a default — it returns null and the caller must refuse to
 * pay. The DESIRED_* constants document the values the owner asked for so the
 * setup checklist and the admin UI can state them; they are never used as
 * fallbacks. A typo'd REFERRAL_AUTO_PAYOUT_RESERVE_CENTS must stop payouts, not
 * silently pay with a reserve nobody chose.
 */

// ── Program constants ────────────────────────────────────────────────────────

/**
 * Estimated Stripe fee for one US local-bank outbound payment, held back on top
 * of the reward and the reserve so a payout can never leave the Financial
 * Account short. Deliberately not configurable: it models Stripe's price, not an
 * owner preference, and an owner-tunable fee estimate is just a way to
 * under-reserve by accident.
 */
export const REFERRAL_AUTO_PAYOUT_FEE_CENTS = 150;

/** Owner's chosen values, for documentation and UI copy. NEVER fallbacks. */
export const DESIRED_RESERVE_CENTS = 2500;
export const DESIRED_RECIPIENT_DAILY_CAP_CENTS = 10_000;
export const DESIRED_GLOBAL_DAILY_CAP_CENTS = 25_000;
export const DESIRED_TAX_REVIEW_CEILING_CENTS = 150_000;

/** Owner's window to fund the Financial Account after a reward is recorded. */
export const AUTO_PAYOUT_FUNDING_WINDOW_DAYS = 30;

/** Reminder points inside that window, in days remaining before maturity. */
export const FUNDING_REMINDER_DAYS = [7, 1] as const;

/**
 * How long an unchanged owner notice stays silent before repeating.
 *
 * The payout attempt itself retries daily; the EMAIL does not. A shortfall that
 * has not changed is not news, so the same message repeats only every three
 * days. Any change of state (a different shortfall, a new blocker) sends
 * immediately — see claim_referral_owner_notice() in the migration.
 */
export const OWNER_NOTICE_REMINDER_HOURS = 72;

/** Identity recorded as the approver on an automatically approved payout. */
export const AUTOMATIC_PAYOUT_APPROVER = 'automatic@statflobot.system';

// ── Configuration ────────────────────────────────────────────────────────────

export interface AutoPayoutLimits {
  reserveCents: number;
  recipientDailyCapCents: number;
  globalDailyCapCents: number;
  taxReviewCeilingCents: number;
}

export interface AutoPayoutLimitsResult {
  /** null whenever ANY limit is missing or malformed — fail closed as a unit. */
  limits: AutoPayoutLimits | null;
  /** Env var names that are unset or unusable, for the owner-facing notice. */
  invalid: string[];
}

/**
 * Parse a required integer-cents setting.
 *
 * Returns null for unset, non-numeric, fractional, negative, out-of-range or
 * below-minimum input. There is no default: null means "the owner has not made
 * this decision", and no money may move until they do.
 */
export function parseRequiredCents(
  raw: string | undefined | null,
  minimum: number
): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  // Reject "12.5", "1e3", "12abc", "+12" and whitespace-only up front: a
  // permissive parse of a money limit is how a typo becomes a payment.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value)) return null;
  if (value < minimum) return null;
  return value;
}

/** Lowest sane value for each limit. A cap under $10 could never pay a reward. */
const MIN_RESERVE_CENTS = 0;
const MIN_CAP_CENTS = 1000;
const MIN_CEILING_CENTS = 1000;

/**
 * Read every automatic-payout limit from an env-shaped object.
 *
 * All-or-nothing: one bad value invalidates the whole set, because a run with a
 * valid cap and an unusable reserve is exactly the state that pays out money the
 * owner meant to protect.
 */
export function readAutoPayoutLimits(
  env: Record<string, string | undefined>
): AutoPayoutLimitsResult {
  const reserveCents = parseRequiredCents(env.REFERRAL_AUTO_PAYOUT_RESERVE_CENTS, MIN_RESERVE_CENTS);
  const recipientDailyCapCents = parseRequiredCents(
    env.REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS, MIN_CAP_CENTS);
  const globalDailyCapCents = parseRequiredCents(
    env.REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS, MIN_CAP_CENTS);
  const taxReviewCeilingCents = parseRequiredCents(
    env.REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS, MIN_CEILING_CENTS);

  const invalid: string[] = [];
  if (reserveCents === null) invalid.push('REFERRAL_AUTO_PAYOUT_RESERVE_CENTS');
  if (recipientDailyCapCents === null) invalid.push('REFERRAL_AUTO_PAYOUT_RECIPIENT_DAILY_CAP_CENTS');
  if (globalDailyCapCents === null) invalid.push('REFERRAL_AUTO_PAYOUT_GLOBAL_DAILY_CAP_CENTS');
  if (taxReviewCeilingCents === null) invalid.push('REFERRAL_AUTO_TAX_REVIEW_CEILING_CENTS');

  if (invalid.length > 0) return { limits: null, invalid };

  return {
    limits: {
      reserveCents: reserveCents!,
      recipientDailyCapCents: recipientDailyCapCents!,
      globalDailyCapCents: globalDailyCapCents!,
      taxReviewCeilingCents: taxReviewCeilingCents!,
    },
    invalid: [],
  };
}

// ── Candidate evaluation ─────────────────────────────────────────────────────

export type AutoPayoutBlockReason =
  | 'limits-not-configured'
  | 'manual-payouts-disabled'
  | 'auto-payouts-disabled'
  | 'threshold-not-configured'
  | 'auto-payouts-blocked'
  | 'payout-in-flight'
  | 'not-lifetime'
  | 'negative-balance'
  | 'no-matured-balance'
  | 'below-threshold'
  | 'bank-not-ready'
  | 'recipient-daily-cap'
  | 'global-daily-cap'
  | 'tax-review-ceiling'
  | 'financial-account-unavailable'
  | 'insufficient-funds';

export interface AutoPayoutGuardInput {
  manualPayoutsEnabled: boolean;
  autoPayoutsEnabled: boolean;
  /** null when REFERRAL_PAYOUT_THRESHOLD_CENTS is unset or below $10.00. */
  thresholdCents: number | null;
  limits: AutoPayoutLimits | null;
  /** Matured, unpaid balance from the append-only ledger. */
  eligibleCents: number;
  hasRealLifetimeEntitlement: boolean;
  bankReady: boolean;
  /** True once a failed or returned automatic payout has locked this recipient. */
  autoPayoutsBlocked: boolean;
  /** True while an earlier payout is still processing — reconcile, never resend. */
  payoutInFlight: boolean;
  recipientPaidTodayCents: number;
  globalPaidTodayCents: number;
  recipientPaidThisYearCents: number;
}

export type AutoPayoutGuardResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: AutoPayoutBlockReason; detail: string };

/**
 * Every non-funding guard, in the order the owner specified.
 *
 * Runs before the Stripe Financial Account is ever read, which is what lets a
 * fully blocked run make no Stripe call at all.
 */
export function evaluateAutoPayoutGuards(input: AutoPayoutGuardInput): AutoPayoutGuardResult {
  if (!input.limits) {
    return {
      ok: false,
      reason: 'limits-not-configured',
      detail: 'Automatic payout limits are unset or malformed.',
    };
  }
  if (!input.manualPayoutsEnabled) {
    return {
      ok: false,
      reason: 'manual-payouts-disabled',
      detail: 'REFERRAL_PAYOUTS_ENABLED is not exactly "true".',
    };
  }
  if (!input.autoPayoutsEnabled) {
    return {
      ok: false,
      reason: 'auto-payouts-disabled',
      detail: 'REFERRAL_AUTO_PAYOUTS_ENABLED is not exactly "true".',
    };
  }
  if (input.thresholdCents === null || input.thresholdCents < 1000) {
    return {
      ok: false,
      reason: 'threshold-not-configured',
      detail: 'REFERRAL_PAYOUT_THRESHOLD_CENTS must be configured at $10.00 or higher.',
    };
  }
  if (input.autoPayoutsBlocked) {
    return {
      ok: false,
      reason: 'auto-payouts-blocked',
      detail: 'A previous automatic payout failed or was returned. Owner review is required.',
    };
  }
  if (input.payoutInFlight) {
    return {
      ok: false,
      reason: 'payout-in-flight',
      detail: 'An earlier payout is still in transit and must be reconciled first.',
    };
  }
  if (!input.hasRealLifetimeEntitlement) {
    return {
      ok: false,
      reason: 'not-lifetime',
      detail: 'The referrer no longer holds a real lifetime entitlement.',
    };
  }
  if (input.eligibleCents < 0) {
    return {
      ok: false,
      reason: 'negative-balance',
      detail: 'A reversal after payout left this referrer with a negative balance.',
    };
  }
  if (input.eligibleCents === 0) {
    return { ok: false, reason: 'no-matured-balance', detail: 'No reward has matured past the 30-day hold.' };
  }
  if (input.eligibleCents < input.thresholdCents) {
    return {
      ok: false,
      reason: 'below-threshold',
      detail: `Matured balance is below the ${formatCents(input.thresholdCents)} payout threshold.`,
    };
  }
  if (!input.bankReady) {
    return {
      ok: false,
      reason: 'bank-not-ready',
      detail: 'Stripe-hosted bank enrollment is not complete and active.',
    };
  }

  const amountCents = input.eligibleCents;

  // Caps are refusals, never partial payments. Reserving less than the full
  // matured balance would need a second reservation primitive, and splitting a
  // reward is a worse failure mode than paying it a day later.
  if (input.recipientPaidTodayCents + amountCents > input.limits.recipientDailyCapCents) {
    return {
      ok: false,
      reason: 'recipient-daily-cap',
      detail: `${formatCents(amountCents)} would pass the ${formatCents(input.limits.recipientDailyCapCents)} daily limit for one recipient.`,
    };
  }
  if (input.globalPaidTodayCents + amountCents > input.limits.globalDailyCapCents) {
    return {
      ok: false,
      reason: 'global-daily-cap',
      detail: `${formatCents(amountCents)} would pass the ${formatCents(input.limits.globalDailyCapCents)} total automatic payouts for today.`,
    };
  }
  // At OR above the ceiling, automatic payment stops. The owner pays the rest by
  // hand once the year's tax paperwork for that recipient is settled.
  if (input.recipientPaidThisYearCents + amountCents >= input.limits.taxReviewCeilingCents) {
    return {
      ok: false,
      reason: 'tax-review-ceiling',
      detail: `This recipient would reach the ${formatCents(input.limits.taxReviewCeilingCents)} annual tax-review ceiling.`,
    };
  }

  return { ok: true, amountCents };
}

export interface FundingCheckInput {
  amountCents: number;
  reserveCents: number;
  /** null when the Financial Account balance could not be read. */
  availableCents: number | null;
}

export type FundingCheckResult =
  | { ok: true; requiredCents: number }
  | {
      ok: false;
      reason: 'financial-account-unavailable' | 'insufficient-funds';
      detail: string;
      requiredCents: number;
      shortfallCents: number;
    };

/**
 * The funding guard: reward + estimated bank fee + protected reserve.
 *
 * An unreadable balance is treated exactly like an empty one. Guessing that the
 * money is probably there is the one assumption that cannot be walked back.
 */
export function evaluateFunding(input: FundingCheckInput): FundingCheckResult {
  const requiredCents = input.amountCents + REFERRAL_AUTO_PAYOUT_FEE_CENTS + input.reserveCents;

  if (input.availableCents === null) {
    return {
      ok: false,
      reason: 'financial-account-unavailable',
      detail: 'The Global Payouts Financial Account balance could not be read.',
      requiredCents,
      shortfallCents: requiredCents,
    };
  }
  if (input.availableCents < requiredCents) {
    return {
      ok: false,
      reason: 'insufficient-funds',
      detail: `Add ${formatCents(requiredCents - input.availableCents)} to the Financial Account.`,
      requiredCents,
      shortfallCents: requiredCents - input.availableCents,
    };
  }
  return { ok: true, requiredCents };
}

/**
 * Guards and funding together. The orchestrator runs the two halves separately
 * so it can skip Stripe entirely; tests and the admin UI use this composition.
 */
export function evaluateAutoPayoutCandidate(
  input: AutoPayoutGuardInput & { availableCents: number | null }
): AutoPayoutGuardResult | FundingCheckResult {
  const guards = evaluateAutoPayoutGuards(input);
  if (!guards.ok) return guards;
  return evaluateFunding({
    amountCents: guards.amountCents,
    reserveCents: input.limits!.reserveCents,
    availableCents: input.availableCents,
  });
}

// ── Funding reminders ────────────────────────────────────────────────────────

export type FundingReminderKind = 'seven-day' | 'one-day';

/**
 * Which reminder, if any, a not-yet-matured reward is due.
 *
 * Bucketed rather than exact-day matched: a cron that slips an hour, or a run
 * that fails and retries tomorrow, must not skip the reminder entirely. Notice
 * dedupe (one row per reward per kind) is what stops the bucket from repeating.
 */
export function dueFundingReminder(daysUntilEligible: number): FundingReminderKind | null {
  if (!Number.isFinite(daysUntilEligible) || daysUntilEligible < 0) return null;
  if (daysUntilEligible <= 1) return 'one-day';
  if (daysUntilEligible <= 7) return 'seven-day';
  return null;
}

/** Whole days from now until an eligibility timestamp, rounded up. */
export function daysUntil(eligibleAtMs: number, nowMs: number): number {
  return Math.ceil((eligibleAtMs - nowMs) / 86_400_000);
}

/**
 * Next daily cron firing, for the owner dashboard.
 *
 * Vercel Hobby crons are guaranteed once per day but not to the minute, so this
 * is the scheduled time, not a promise.
 */
export function nextDailyRunAt(nowMs: number, utcHour: number, utcMinute: number): string {
  const now = new Date(nowMs);
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, utcMinute, 0, 0
  ));
  if (next.getTime() <= nowMs) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Money for owner-facing copy. Cents in, "$12.34" out. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
