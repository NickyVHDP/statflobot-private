import { createServiceClient } from './supabase/server';
import { auditLog } from './license';
import {
  arePayoutsEnabled,
  getPayoutThresholdCents,
  getReferralBalance,
} from './referrals';
import {
  StripeGlobalPayoutsError,
  createGlobalOutboundPayment,
  createGlobalRecipient,
  createGlobalRecipientLink,
  listEligibleGlobalPayoutMethods,
  retrieveGlobalRecipient,
  retrieveGlobalOutboundPayment,
} from './stripeGlobalPayouts';

/**
 * Stripe Global Payouts recipient onboarding + explicit admin payouts.
 *
 * No scheduled or webhook-triggered send exists. Money can move only after an
 * authenticated admin approves it and REFERRAL_PAYOUTS_ENABLED is exactly
 * "true". Bank details are collected and stored only by Stripe.
 */

export interface PayoutPreflight {
  ok: boolean;
  reason?:
    | 'payouts-disabled'
    | 'threshold-not-configured'
    | 'financial-account-not-configured'
    | 'below-threshold'
    | 'no-global-recipient'
    | 'payout-method-not-ready'
    | 'negative-balance';
  detail?: string;
  eligibleCents?: number;
  thresholdCents?: number;
  stripeRecipientId?: string;
  stripePayoutMethodId?: string;
}

export async function preflightPayout(referrerUserId: string): Promise<PayoutPreflight> {
  if (!arePayoutsEnabled()) {
    return {
      ok: false,
      reason: 'payouts-disabled',
      detail: 'Referral payouts are feature-flagged closed.',
    };
  }

  const thresholdCents = getPayoutThresholdCents();
  if (thresholdCents === null) {
    return {
      ok: false,
      reason: 'threshold-not-configured',
      detail: 'The payout threshold must be configured at $10.00 or higher.',
    };
  }

  if (!process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID) {
    return {
      ok: false,
      reason: 'financial-account-not-configured',
      detail: 'The Global Payouts financial account is not configured.',
      thresholdCents,
    };
  }

  const balance = await getReferralBalance(referrerUserId);
  if (balance.eligibleCents < 0) {
    return {
      ok: false,
      reason: 'negative-balance',
      detail: 'Referrer carries a negative balance from a post-payout reversal.',
      eligibleCents: balance.eligibleCents,
      thresholdCents,
    };
  }
  if (balance.eligibleCents < thresholdCents) {
    return {
      ok: false,
      reason: 'below-threshold',
      eligibleCents: balance.eligibleCents,
      thresholdCents,
    };
  }

  const svc = createServiceClient();
  const { data: account } = await svc
    .from('referral_payout_accounts')
    .select('stripe_recipient_id, stripe_payout_method_id, payout_method_ready')
    .eq('referrer_user_id', referrerUserId)
    .maybeSingle();

  if (!account?.stripe_recipient_id) {
    return {
      ok: false,
      reason: 'no-global-recipient',
      eligibleCents: balance.eligibleCents,
      thresholdCents,
    };
  }
  if (!account.payout_method_ready || !account.stripe_payout_method_id) {
    return {
      ok: false,
      reason: 'payout-method-not-ready',
      detail: 'Stripe-hosted payout enrollment is incomplete for this referrer.',
      eligibleCents: balance.eligibleCents,
      thresholdCents,
      stripeRecipientId: account.stripe_recipient_id,
    };
  }

  return {
    ok: true,
    eligibleCents: balance.eligibleCents,
    thresholdCents,
    stripeRecipientId: account.stripe_recipient_id,
    stripePayoutMethodId: account.stripe_payout_method_id,
  };
}

/** Refresh privacy-safe readiness state from Stripe API v2. */
export async function syncGlobalPayoutAccount(referrerUserId: string): Promise<void> {
  const svc = createServiceClient();
  const { data: existing } = await svc
    .from('referral_payout_accounts')
    .select('stripe_recipient_id')
    .eq('referrer_user_id', referrerUserId)
    .maybeSingle();
  if (!existing?.stripe_recipient_id) return;

  const recipient = await retrieveGlobalRecipient(existing.stripe_recipient_id);
  const methods = await listEligibleGlobalPayoutMethods(existing.stripe_recipient_id);
  const method = methods.find((item) => item.type === 'bank_account') ?? methods[0] ?? null;
  const capabilityStatus =
    recipient.configuration?.recipient?.capabilities?.bank_accounts?.local?.status ?? 'pending';
  const ready = capabilityStatus === 'active' && !!method?.id;

  const { error } = await svc
    .from('referral_payout_accounts')
    .update({
      stripe_payout_method_id: method?.id ?? null,
      payout_method_type: method?.type ?? null,
      payout_method_ready: ready,
      payouts_enabled: ready,
      details_submitted: capabilityStatus === 'active',
      onboarding_status: ready ? 'complete' : 'pending',
      requirements_summary: {
        capabilityStatus,
        eligiblePayoutMethodCount: methods.length,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('referrer_user_id', referrerUserId);

  if (error) throw new Error(`Could not persist Global Payout readiness: ${error.message}`);
}

/**
 * Create a fresh, single-use Stripe-hosted bank enrollment link.
 *
 * A NEW link is minted on every call — none is ever cached or reused. That is
 * what makes an expired or already-used link a non-issue: the customer simply
 * clicks "Connect bank securely" / "Finish bank setup" again and gets a brand
 * new URL, with no special "expired" handling required anywhere else.
 */
export async function createOnboardingLink(
  referrerUserId: string,
  email: string | null | undefined,
  displayName?: string | null
): Promise<{ url: string } | { error: string; status: number }> {
  const svc = createServiceClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return { error: 'NEXT_PUBLIC_APP_URL is not configured.', status: 503 };
  if (!email) return { error: 'An account email is required for payout enrollment.', status: 400 };

  const { data: existing } = await svc
    .from('referral_payout_accounts')
    .select('stripe_recipient_id, onboarding_status')
    .eq('referrer_user_id', referrerUserId)
    .maybeSingle();

  let recipientId = existing?.stripe_recipient_id as string | undefined;
  let newlyCreated = false;

  try {
    if (!recipientId) {
      const recipient = await createGlobalRecipient({
        referrerUserId,
        email,
        displayName: displayName?.trim() || email.split('@')[0] || 'StatfloBot recipient',
      });
      recipientId = recipient.id;
      newlyCreated = true;

      const { error } = await svc.from('referral_payout_accounts').upsert({
        referrer_user_id: referrerUserId,
        stripe_recipient_id: recipientId,
        provider: 'stripe_global_payouts',
        onboarding_status: 'created',
        payouts_enabled: false,
        payout_method_ready: false,
      }, { onConflict: 'referrer_user_id' });
      if (error) throw new Error(`Could not save payout recipient state: ${error.message}`);

      await auditLog(referrerUserId, 'referral_global_recipient_created', {
        stripe_recipient_id: recipientId,
      });
    }

    const link = await createGlobalRecipientLink({
      recipientId: recipientId!,
      referrerUserId,
      returnUrl: `${appUrl}/dashboard?referralPayout=complete`,
      refreshUrl: `${appUrl}/dashboard?referralPayout=refresh`,
      update: !newlyCreated && existing?.onboarding_status !== 'created',
    });
    return { url: link.url };
  } catch (err: any) {
    const msg = String(err?.message ?? '');
    console.error('[REFERRAL_GLOBAL_ONBOARD_FAILED]', msg);
    return {
      error: err instanceof StripeGlobalPayoutsError && err.status === 403
        ? 'Bank setup is not available for this account yet.'
        : 'Could not start bank setup. Please try again.',
      status: err instanceof StripeGlobalPayoutsError && err.status < 500 ? err.status : 502,
    };
  }
}

type ReservedPayout = {
  payout_id: string;
  amount_cents: number;
  idempotency_key: string;
  stripe_recipient_id: string;
  stripe_payout_method_id: string;
  resumed: boolean;
  /**
   * Set only when Stripe has ALREADY accepted an outbound payment for this
   * payout. Its presence means the money is in flight and a second
   * createGlobalOutboundPayment() call must never be made for this row.
   */
  stripe_outbound_payment_id?: string | null;
};

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'returned', 'canceled']);

async function applyOutboundStatus(
  reserved: ReservedPayout,
  outbound: { id: string; status?: string }
): Promise<'processing' | 'paid' | 'failed'> {
  const svc = createServiceClient();
  const status = String(outbound.status ?? 'processing');
  const { data: recorded, error: recordError } = await svc.rpc(
    'record_global_referral_payout_submission',
    {
      p_payout_id: reserved.payout_id,
      p_stripe_outbound_payment_id: outbound.id,
      p_provider_status: status,
    }
  );
  if (recordError || recorded !== true) {
    throw new Error(`Could not record Stripe outbound payment state: ${recordError?.message ?? 'not recorded'}`);
  }

  if (status === 'posted') {
    const { data, error } = await svc.rpc('finalize_global_referral_payout', {
      p_payout_id: reserved.payout_id,
      p_succeeded: true,
      p_stripe_outbound_payment_id: outbound.id,
      p_failure_reason: null,
    });
    if (error || data !== true) throw new Error(`Could not finalize posted payout: ${error?.message ?? 'not finalized'}`);
    return 'paid';
  }

  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    const { data, error } = await svc.rpc('finalize_global_referral_payout', {
      p_payout_id: reserved.payout_id,
      p_succeeded: false,
      p_stripe_outbound_payment_id: outbound.id,
      p_failure_reason: `Stripe outbound payment ${status}`,
    });
    if (error || data !== true) throw new Error(`Could not restore failed payout: ${error?.message ?? 'not finalized'}`);
    return 'failed';
  }

  return 'processing';
}

const RETURN_RECONCILIATION_WINDOW_DAYS = 90;

/**
 * Poll in-flight payouts and recently posted payouts.
 *
 * Stripe can report an outbound payment as `posted` before the receiving bank
 * later returns it. Recent paid rows therefore remain under reconciliation so
 * a post-posted return restores the reserved referral balance.
 */
export async function reconcileProcessingPayouts(referrerUserId?: string): Promise<void> {
  const svc = createServiceClient();
  let processingQuery = svc
    .from('referral_payouts')
    .select('id, referrer_user_id, amount_cents, idempotency_key, stripe_recipient_id, stripe_payout_method_id, stripe_outbound_payment_id')
    .eq('status', 'processing')
    .not('stripe_outbound_payment_id', 'is', null)
    .limit(25);
  let paidQuery = svc
    .from('referral_payouts')
    .select('id, referrer_user_id, amount_cents, idempotency_key, stripe_recipient_id, stripe_payout_method_id, stripe_outbound_payment_id')
    .eq('status', 'paid')
    .not('stripe_outbound_payment_id', 'is', null)
    .gte('completed_at', new Date(Date.now() - RETURN_RECONCILIATION_WINDOW_DAYS * 86_400_000).toISOString())
    .order('completed_at', { ascending: false })
    .limit(25);
  if (referrerUserId) {
    processingQuery = processingQuery.eq('referrer_user_id', referrerUserId);
    paidQuery = paidQuery.eq('referrer_user_id', referrerUserId);
  }
  const [processingResult, paidResult] = await Promise.all([processingQuery, paidQuery]);
  if (processingResult.error) {
    throw new Error(`Could not read processing payouts: ${processingResult.error.message}`);
  }
  if (paidResult.error) {
    throw new Error(`Could not read recent paid payouts: ${paidResult.error.message}`);
  }
  const rows = [...(processingResult.data ?? []), ...(paidResult.data ?? [])];

  for (const row of rows ?? []) {
    try {
      const outbound = await retrieveGlobalOutboundPayment(row.stripe_outbound_payment_id);
      const result = await applyOutboundStatus({
        payout_id: row.id,
        amount_cents: row.amount_cents,
        idempotency_key: row.idempotency_key,
        stripe_recipient_id: row.stripe_recipient_id,
        stripe_payout_method_id: row.stripe_payout_method_id,
        resumed: true,
        stripe_outbound_payment_id: row.stripe_outbound_payment_id,
      }, outbound);
      if (result !== 'processing') {
        console.log(`[REFERRAL_PAYOUT_RECONCILED] payout=${row.id} status=${result}`);
      }
    } catch (err: any) {
      console.warn(`[REFERRAL_PAYOUT_RECONCILE_DEFERRED] payout=${row.id} error=${String(err?.message ?? err)}`);
    }
  }
}

/** Execute or safely resume one explicit admin-approved Global Payout. */
export async function executeApprovedPayout(opts: {
  referrerUserId: string;
  approvedByEmail: string;
}): Promise<{ ok: true; payoutId: string; amountCents: number; providerStatus: 'processing' | 'paid' } | { ok: false; error: string; status: number }> {
  if (!arePayoutsEnabled()) {
    return { ok: false, error: 'Referral payouts are feature-flagged closed.', status: 503 };
  }
  const thresholdCents = getPayoutThresholdCents();
  if (thresholdCents === null) {
    return { ok: false, error: 'The payout threshold is not configured.', status: 503 };
  }
  const financialAccountId = process.env.STRIPE_GLOBAL_PAYOUTS_FINANCIAL_ACCOUNT_ID;
  if (!financialAccountId) {
    return { ok: false, error: 'The Global Payouts financial account is not configured.', status: 503 };
  }

  const svc = createServiceClient();
  const { data: inFlight } = await svc
    .from('referral_payouts')
    .select('id, amount_cents, idempotency_key, stripe_recipient_id, stripe_payout_method_id, stripe_outbound_payment_id')
    .eq('referrer_user_id', opts.referrerUserId)
    .eq('status', 'processing')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  let reserved: ReservedPayout | null = inFlight ? {
    payout_id: inFlight.id,
    amount_cents: inFlight.amount_cents,
    idempotency_key: inFlight.idempotency_key,
    stripe_recipient_id: inFlight.stripe_recipient_id,
    stripe_payout_method_id: inFlight.stripe_payout_method_id,
    resumed: true,
    stripe_outbound_payment_id: inFlight.stripe_outbound_payment_id ?? null,
  } : null;

  if (!reserved) {
    const pre = await preflightPayout(opts.referrerUserId);
    if (!pre.ok) {
      return {
        ok: false,
        status: pre.reason === 'payouts-disabled' ||
          pre.reason === 'threshold-not-configured' ||
          pre.reason === 'financial-account-not-configured' ? 503 : 409,
        error: pre.detail ?? `Payout not permitted: ${pre.reason}`,
      };
    }

    const { data, error } = await svc.rpc('reserve_global_referral_payout', {
      p_referrer_user_id: opts.referrerUserId,
      p_approved_by_email: opts.approvedByEmail,
      p_stripe_recipient_id: pre.stripeRecipientId,
      p_stripe_payout_method_id: pre.stripePayoutMethodId,
      p_threshold_cents: thresholdCents,
    });
    if (error) {
      console.error('[REFERRAL_PAYOUT_RESERVE_FAILED]', error.code, error.message);
      return { ok: false, error: 'Could not reserve the referral payout.', status: 409 };
    }
    reserved = (Array.isArray(data) ? data[0] : data) as ReservedPayout | null;
  }

  if (!reserved?.payout_id || !reserved.stripe_recipient_id || !reserved.stripe_payout_method_id) {
    return { ok: false, error: 'The reserved payout is incomplete.', status: 500 };
  }

  // A resumed payout may already have an accepted Stripe outbound payment.
  // reserve_global_referral_payout() does not return that column, so read it
  // back before deciding whether anything still needs to be sent.
  if (reserved.resumed && !reserved.stripe_outbound_payment_id) {
    const { data: existingRow, error: existingErr } = await svc
      .from('referral_payouts')
      .select('stripe_outbound_payment_id')
      .eq('id', reserved.payout_id)
      .maybeSingle();
    if (existingErr) {
      console.error('[REFERRAL_PAYOUT_OUTBOUND_LOOKUP_FAILED]', reserved.payout_id, existingErr.message);
      return {
        ok: false,
        status: 502,
        error: 'Could not confirm whether this payout was already sent to Stripe. Do not approve another payout; retry this approval.',
      };
    }
    reserved.stripe_outbound_payment_id = existingRow?.stripe_outbound_payment_id ?? null;
  }

  // NEVER submit a second outbound payment for a payout Stripe has already
  // accepted. The provider idempotency key only protects a bounded replay
  // window, so once it lapses a retry would create a genuine duplicate
  // payment. Retrieve and reconcile the existing payment instead.
  if (reserved.stripe_outbound_payment_id) {
    const outboundId = reserved.stripe_outbound_payment_id;
    try {
      const existingOutbound = await retrieveGlobalOutboundPayment(outboundId);
      const reconciled = await applyOutboundStatus(reserved, existingOutbound);
      if (reconciled === 'failed') {
        return {
          ok: false,
          status: 409,
          error: 'Stripe did not complete the payout. The referral balance was restored.',
        };
      }
      await auditLog(opts.referrerUserId, 'referral_payout_reconciled', {
        payout_id: reserved.payout_id,
        amount_cents: reserved.amount_cents,
        stripe_outbound_payment_id: outboundId,
        provider_status: existingOutbound.status ?? 'processing',
        approved_by: opts.approvedByEmail,
      });
      return {
        ok: true,
        payoutId: reserved.payout_id,
        amountCents: reserved.amount_cents,
        providerStatus: reconciled,
      };
    } catch (err: any) {
      console.error('[REFERRAL_PAYOUT_RECONCILE_FAILED]', reserved.payout_id, String(err?.message ?? err));
      return {
        ok: false,
        status: 502,
        error: 'This payout was already sent to Stripe and its status could not be confirmed. Do not create another payout; retry this approval to reconcile the same payment.',
      };
    }
  }

  try {
    const outbound = await createGlobalOutboundPayment({
      financialAccountId,
      recipientId: reserved.stripe_recipient_id,
      payoutMethodId: reserved.stripe_payout_method_id,
      amountCents: reserved.amount_cents,
      payoutId: reserved.payout_id,
      referrerUserId: opts.referrerUserId,
      idempotencyKey: reserved.idempotency_key,
    });

    const providerResult = await applyOutboundStatus(reserved, outbound);
    if (providerResult === 'failed') {
      return { ok: false, status: 409, error: 'Stripe did not complete the payout. The referral balance was restored.' };
    }

    await auditLog(opts.referrerUserId, providerResult === 'paid' ? 'referral_payout_sent' : 'referral_payout_submitted', {
      payout_id: reserved.payout_id,
      amount_cents: reserved.amount_cents,
      stripe_outbound_payment_id: outbound.id,
      provider_status: outbound.status ?? 'processing',
      approved_by: opts.approvedByEmail,
    });
    return {
      ok: true,
      payoutId: reserved.payout_id,
      amountCents: reserved.amount_cents,
      providerStatus: providerResult,
    };
  } catch (err: any) {
    const definiteRejection = err instanceof StripeGlobalPayoutsError &&
      err.status >= 400 && err.status < 500 && err.status !== 409;
    const msg = String(err?.message ?? 'Stripe Global Payouts request failed');

    if (definiteRejection) {
      const { data: restored, error: restoreError } = await svc.rpc('finalize_global_referral_payout', {
        p_payout_id: reserved.payout_id,
        p_succeeded: false,
        p_stripe_outbound_payment_id: null,
        p_failure_reason: msg.slice(0, 300),
      });
      if (restoreError || restored !== true) {
        console.error('[REFERRAL_PAYOUT_RESTORE_FAILED]', restoreError?.code, restoreError?.message);
        return {
          ok: false,
          status: 502,
          error: 'Stripe rejected the payout, but balance restoration still needs reconciliation. Do not approve another payout.',
        };
      }
      await auditLog(opts.referrerUserId, 'referral_payout_failed', {
        payout_id: reserved.payout_id,
        amount_cents: reserved.amount_cents,
        reason: err.code ?? 'provider-rejected',
      });
      return { ok: false, status: 409, error: 'Stripe rejected the payout. The referral balance was restored; no money moved.' };
    }

    // A timeout, network failure, 5xx or idempotency conflict is ambiguous.
    // Keep the debit and processing row intact. Retrying uses the same Stripe
    // idempotency key and cannot create a second outbound payment.
    console.error('[REFERRAL_PAYOUT_STATUS_UNCERTAIN]', reserved.payout_id, msg);
    return {
      ok: false,
      status: 502,
      error: 'Payout status is still being confirmed. Do not create another payout; retry this approval to reconcile the same payment safely.',
    };
  }
}
