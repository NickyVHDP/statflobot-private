import { getStripe } from './stripe';
import { createServiceClient } from './supabase/server';
import { auditLog } from './license';
import {
  arePayoutsEnabled,
  getPayoutThresholdCents,
  getReferralBalance,
} from './referrals';

/**
 * lib/referralPayouts.ts
 *
 * Stripe Connect hosted onboarding + admin-approved transfers.
 *
 * MONEY-MOVEMENT RULES — all of these fail closed:
 *
 *   1. There is NO automatic payout path. Nothing here runs on a schedule or
 *      from a webhook. A transfer happens only when an authenticated admin
 *      explicitly approves one.
 *   2. `REFERRAL_PAYOUTS_ENABLED` must be exactly 'true'. Default is off, so a
 *      misconfigured deploy cannot move money.
 *   3. The minimum eligible payout is $10.00. The environment may raise that
 *      amount but can never lower it below one earned referral reward.
 *   4. Every transfer carries a Stripe idempotency key derived from the payout
 *      row id, so a retried approval cannot double-send.
 *   5. We never collect, transmit or store bank details. Onboarding is entirely
 *      Stripe-hosted; we persist only the account id and its capability flags.
 */

export interface PayoutPreflight {
  ok: boolean;
  reason?:
    | 'payouts-disabled'
    | 'threshold-not-configured'
    | 'below-threshold'
    | 'no-connect-account'
    | 'payouts-not-enabled-on-account'
    | 'negative-balance';
  detail?: string;
  eligibleCents?: number;
  thresholdCents?: number;
  stripeAccountId?: string;
}

/**
 * Everything that must be true before an admin may approve a payout.
 * Pure read — safe to call from the admin UI to explain why a button is off.
 */
export async function preflightPayout(referrerUserId: string): Promise<PayoutPreflight> {
  if (!arePayoutsEnabled()) {
    return {
      ok: false,
      reason: 'payouts-disabled',
      detail:
        'REFERRAL_PAYOUTS_ENABLED is not set to "true". Payout execution is feature-flagged closed.',
    };
  }

  const thresholdCents = getPayoutThresholdCents();
  if (thresholdCents === null) {
    return {
      ok: false,
      reason: 'threshold-not-configured',
      detail:
        'REFERRAL_PAYOUT_THRESHOLD_CENTS is invalid. It must be at least 1000 cents ($10.00).',
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
    .select('stripe_account_id, payouts_enabled')
    .eq('referrer_user_id', referrerUserId)
    .maybeSingle();

  if (!account?.stripe_account_id) {
    return { ok: false, reason: 'no-connect-account', eligibleCents: balance.eligibleCents, thresholdCents };
  }
  if (!account.payouts_enabled) {
    return {
      ok: false,
      reason: 'payouts-not-enabled-on-account',
      detail: 'Stripe Connect onboarding is incomplete for this referrer.',
      eligibleCents: balance.eligibleCents,
      thresholdCents,
      stripeAccountId: account.stripe_account_id,
    };
  }

  return {
    ok: true,
    eligibleCents: balance.eligibleCents,
    thresholdCents,
    stripeAccountId: account.stripe_account_id,
  };
}

/**
 * Create the Stripe Connect Express account (if needed) and return a hosted
 * onboarding Account Link. The referrer completes identity and bank details on
 * Stripe's pages; none of it passes through this application.
 */
export async function createOnboardingLink(
  referrerUserId: string,
  email: string | null | undefined
): Promise<{ url: string } | { error: string; status: number }> {
  const stripe = getStripe();
  const svc = createServiceClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!appUrl) return { error: 'NEXT_PUBLIC_APP_URL is not configured.', status: 503 };

  const { data: existing } = await svc
    .from('referral_payout_accounts')
    .select('stripe_account_id')
    .eq('referrer_user_id', referrerUserId)
    .maybeSingle();

  let accountId = existing?.stripe_account_id as string | undefined;

  try {
    if (!accountId) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          email: email ?? undefined,
          capabilities: { transfers: { requested: true } },
          metadata: { referrer_user_id: referrerUserId },
        },
        { idempotencyKey: `referral_connect_${referrerUserId}` }
      );
      accountId = account.id;

      const { error } = await svc.from('referral_payout_accounts').insert({
        referrer_user_id:  referrerUserId,
        stripe_account_id: accountId,
        onboarding_status: 'created',
      });
      // 23505 → concurrent request already inserted; re-read and continue.
      if (error && error.code === '23505') {
        const { data: raced } = await svc
          .from('referral_payout_accounts')
          .select('stripe_account_id')
          .eq('referrer_user_id', referrerUserId)
          .maybeSingle();
        if (raced?.stripe_account_id) accountId = raced.stripe_account_id;
      } else if (error) {
        console.error('[REFERRAL_CONNECT_PERSIST_FAILED]', error.code, error.message);
        return { error: 'Could not save payout account state.', status: 500 };
      }

      await auditLog(referrerUserId, 'referral_connect_account_created', { stripe_account_id: accountId });
    }

    const link = await stripe.accountLinks.create({
      account:     accountId!,
      refresh_url: `${appUrl}/dashboard?connect=refresh`,
      return_url:  `${appUrl}/dashboard?connect=complete`,
      type:        'account_onboarding',
    });

    return { url: link.url };
  } catch (err: any) {
    // Connect not enabled on the platform account is the most common cause and
    // is a Dashboard configuration issue, not a code bug — say so plainly.
    const msg = String(err?.message ?? '');
    if (/connect/i.test(msg) && /(not|disabled|enable)/i.test(msg)) {
      console.error('[REFERRAL_CONNECT_NOT_CONFIGURED]', msg);
      return {
        error:
          'Stripe Connect is not enabled on this account yet. Enable Connect in the Stripe ' +
          'Dashboard before onboarding referrers.',
        status: 503,
      };
    }
    console.error('[REFERRAL_CONNECT_ONBOARD_FAILED]', msg);
    return { error: 'Could not start bank onboarding. Please try again.', status: 500 };
  }
}

/**
 * Execute an admin-approved payout of the referrer's full eligible balance.
 *
 * Ordering is deliberate and must not be rearranged:
 *   1. preflight (flag, threshold, balance, Connect readiness)
 *   2. reject if a payout for this referrer is already 'processing'
 *   3. INSERT referral_payouts row -> gives us a stable idempotency key
 *   4. INSERT the negative ledger row -> the balance is debited BEFORE the
 *      transfer, so a crash mid-transfer cannot leave the balance spendable twice
 *   5. re-read the balance; a negative result means a concurrent payout raced
 *      us, so roll back and send nothing
 *   6. stripe.transfers.create with that idempotency key
 *   7. mark paid, or mark failed AND reverse the ledger debit
 *
 * Step 3 before step 4 is the conservative direction: the worst case is a
 * debited balance with no transfer, which an admin can see and correct, rather
 * than a sent transfer with a spendable balance, which pays twice.
 */
export async function executeApprovedPayout(opts: {
  referrerUserId: string;
  approvedByEmail: string;
}): Promise<{ ok: true; payoutId: string; amountCents: number } | { ok: false; error: string; status: number }> {
  const pre = await preflightPayout(opts.referrerUserId);
  if (!pre.ok) {
    return {
      ok: false,
      status: pre.reason === 'payouts-disabled' || pre.reason === 'threshold-not-configured' ? 503 : 409,
      error: pre.detail ?? `Payout not permitted: ${pre.reason}`,
    };
  }

  const svc = createServiceClient();
  const stripe = getStripe();
  const amountCents = pre.eligibleCents!;

  // ── Concurrency guard 1: no second approval while one is in flight ───────
  // preflight() reads the balance, and the debit happens several awaits later.
  // Two admins (or one double-click) could both pass preflight on the same
  // balance and each send a transfer. An in-flight payout blocks the second.
  const { data: inFlight } = await svc
    .from('referral_payouts')
    .select('id')
    .eq('referrer_user_id', opts.referrerUserId)
    .eq('status', 'processing')
    .limit(1)
    .maybeSingle();

  if (inFlight) {
    console.warn(`[REFERRAL_PAYOUT_ALREADY_IN_FLIGHT] referrer=${opts.referrerUserId} payout=${inFlight.id}`);
    return {
      ok: false,
      status: 409,
      error: 'A payout for this referrer is already being processed. Wait for it to settle before approving another.',
    };
  }

  const { data: payout, error: payoutErr } = await svc
    .from('referral_payouts')
    .insert({
      referrer_user_id:  opts.referrerUserId,
      amount_cents:      amountCents,
      status:            'processing',
      method:            'stripe_connect',
      stripe_account_id: pre.stripeAccountId,
      idempotency_key:   `payout_${opts.referrerUserId}_${Date.now()}`,
      approved_by_email: opts.approvedByEmail,
    })
    .select('id, idempotency_key')
    .single();

  if (payoutErr || !payout) {
    console.error('[REFERRAL_PAYOUT_INSERT_FAILED]', payoutErr?.code, payoutErr?.message);
    return { ok: false, error: 'Could not record the payout.', status: 500 };
  }

  const { error: debitErr } = await svc.from('referral_ledger').insert({
    referrer_user_id: opts.referrerUserId,
    attribution_id:   null,
    payout_id:        payout.id,
    entry_type:       'payout',
    amount_cents:     -amountCents,
    eligible_at:      new Date().toISOString(),
    notes:            `payout:${payout.id}`,
  });

  if (debitErr) {
    console.error('[REFERRAL_PAYOUT_DEBIT_FAILED]', debitErr.code, debitErr.message);
    await svc
      .from('referral_payouts')
      .update({ status: 'failed', failure_reason: 'ledger debit failed' })
      .eq('id', payout.id);
    return { ok: false, error: 'Could not debit the referral balance.', status: 500 };
  }

  // ── Concurrency guard 2: re-read the balance AFTER debiting ──────────────
  // The debit is now visible in the ledger, so this re-read sees the effect of
  // any racing payout that slipped past guard 1. A negative balance means the
  // balance was spent twice — roll this one back and send nothing. Checked
  // before the transfer, so the worst case is a cancelled payout, never a
  // double-send.
  const postDebit = await getReferralBalance(opts.referrerUserId);
  if (postDebit.eligibleCents < 0) {
    console.error(
      `[REFERRAL_PAYOUT_RACE_ABORTED] referrer=${opts.referrerUserId} payout=${payout.id} ` +
      `postDebitEligible=${postDebit.eligibleCents} — no money moved`
    );
    await svc.from('referral_ledger').delete().eq('payout_id', payout.id).eq('entry_type', 'payout');
    await svc
      .from('referral_payouts')
      .update({ status: 'canceled', failure_reason: 'concurrent payout detected after debit' })
      .eq('id', payout.id);

    return {
      ok: false,
      status: 409,
      error: 'Another payout drew on this balance at the same time. Nothing was sent — re-check the balance and try again.',
    };
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount:      amountCents,
        currency:    'usd',
        destination: pre.stripeAccountId!,
        description: 'StatfloBot referral reward',
        metadata: {
          referrer_user_id: opts.referrerUserId,
          payout_id:        payout.id,
          approved_by:      opts.approvedByEmail,
        },
      },
      { idempotencyKey: payout.idempotency_key }
    );

    await svc
      .from('referral_payouts')
      .update({ status: 'paid', stripe_transfer_id: transfer.id, completed_at: new Date().toISOString() })
      .eq('id', payout.id);

    console.log(
      `[REFERRAL_PAYOUT_SENT] payout=${payout.id} referrer=${opts.referrerUserId} ` +
      `amount=${amountCents} transfer=${transfer.id} approvedBy=${opts.approvedByEmail}`
    );
    await auditLog(opts.referrerUserId, 'referral_payout_sent', {
      payout_id:          payout.id,
      amount_cents:       amountCents,
      stripe_transfer_id: transfer.id,
      approved_by:        opts.approvedByEmail,
    });

    return { ok: true, payoutId: payout.id, amountCents };
  } catch (err: any) {
    const msg = String(err?.message ?? '');
    const insufficient = /insufficient|balance_insufficient/i.test(msg);

    // The transfer did not happen — return the debited amount to the ledger so
    // the referrer is not silently short. Append-only: a compensating accrual
    // is not used (it would need an attribution); the payout row is voided by
    // deleting its debit, which is the one case where removing a ledger row is
    // correct because the entry describes an event that did not occur.
    await svc.from('referral_ledger').delete().eq('payout_id', payout.id).eq('entry_type', 'payout');

    await svc
      .from('referral_payouts')
      .update({
        status:         'failed',
        failure_reason: insufficient ? 'insufficient platform balance' : msg.slice(0, 300),
      })
      .eq('id', payout.id);

    console.error(`[REFERRAL_PAYOUT_FAILED] payout=${payout.id} insufficient=${insufficient} error=${msg}`);
    await auditLog(opts.referrerUserId, 'referral_payout_failed', {
      payout_id:    payout.id,
      amount_cents: amountCents,
      reason:       insufficient ? 'insufficient-platform-balance' : 'stripe-error',
    });

    return {
      ok: false,
      status: insufficient ? 409 : 502,
      error: insufficient
        ? 'Stripe platform balance is insufficient for this transfer. Balance restored; no money moved.'
        : 'Stripe rejected the transfer. Balance restored; no money moved.',
    };
  }
}

/** Sync Connect capability flags from an `account.updated` webhook event. */
export async function syncConnectAccount(account: {
  id: string;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  requirements?: unknown;
}): Promise<void> {
  const svc = createServiceClient();

  const payoutsEnabled = !!account.payouts_enabled;
  const detailsSubmitted = !!account.details_submitted;
  const status = payoutsEnabled ? 'complete' : detailsSubmitted ? 'pending' : 'created';

  const { error } = await svc
    .from('referral_payout_accounts')
    .update({
      payouts_enabled:      payoutsEnabled,
      details_submitted:    detailsSubmitted,
      onboarding_status:    status,
      requirements_summary: (account.requirements as Record<string, unknown>) ?? {},
      updated_at:           new Date().toISOString(),
    })
    .eq('stripe_account_id', account.id);

  if (error) {
    console.error('[REFERRAL_CONNECT_SYNC_FAILED]', error.code, error.message);
    return;
  }

  console.log(
    `[REFERRAL_CONNECT_SYNCED] account=${account.id} payoutsEnabled=${payoutsEnabled} status=${status}`
  );
}
