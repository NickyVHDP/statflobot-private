import { createServiceClient } from './supabase/server';
import { getStripe } from './stripe';

/** Generate a license key in the format STATFLO-XXXXX-XXXXX-XXXXX */
export function generateLicenseKey(): string {
  const segment = () =>
    Math.random().toString(36).toUpperCase().substring(2, 7).padEnd(5, '0');
  return `STATFLO-${segment()}-${segment()}-${segment()}`;
}

/**
 * Create (or return existing) license for a user.
 * Called after a successful Stripe payment.
 * planCode must be normalized to 'monthly' or 'lifetime' before calling.
 */
export async function provisionLicense(
  userId: string,
  planCode: string
): Promise<{ licenseKey: string; licenseId: string }> {
  const supabase = createServiceClient();

  // If user already has a non-revoked license for this plan, reactivate and return it
  const { data: existing, error: existingError } = await supabase
    .from('licenses')
    .select('id, license_key')
    .eq('user_id', userId)
    .eq('plan', planCode)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new Error(`License lookup failed: ${existingError.message}`);
  }

  if (existing) {
    await supabase
      .from('licenses')
      .update({ status: 'active' })
      .eq('id', existing.id);
    return { licenseKey: existing.license_key, licenseId: existing.id };
  }

  // Create new license
  const licenseKey = generateLicenseKey();
  const insertPayload = {
    user_id:     userId,
    license_key: licenseKey,
    status:      'active',
    plan:        planCode,
    max_devices: 2,
    created_at:  new Date().toISOString(),
  };

  console.log('[license] inserting', { userId, plan: planCode, licenseKey });

  const { data: newLicense, error } = await supabase
    .from('licenses')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error || !newLicense) {
    console.error('[license] insert failed', {
      code:    error?.code,
      message: error?.message,
      details: error?.details,
      hint:    error?.hint,
      payload: { userId, plan: planCode },
    });
    throw new Error(
      `License provisioning failed: [${error?.code}] ${error?.message} — hint: ${error?.hint}`
    );
  }

  return { licenseKey, licenseId: newLicense.id };
}

/** Deactivate all non-lifetime licenses for a user (subscription canceled). */
export async function deactivateLicense(userId: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from('licenses')
    .update({ status: 'inactive' })
    .eq('user_id', userId)
    .eq('plan', 'monthly');
}

/**
 * Reconcile any pending (purchase-first) purchases for a newly-signed-in user.
 *
 * Called server-side on every dashboard load. Idempotent — safe to call repeatedly.
 * Finds `pending_purchases` rows matching the user's email, provisions the
 * subscription + license, then marks the row `reconciled` so it is never
 * replayed. Uses a unique constraint on `stripe_session_id` as a second guard.
 */
export async function reconcilePendingPurchase(
  userId: string,
  email: string,
): Promise<boolean> {
  const supabase = createServiceClient();
  const stripe = getStripe();

  const { data: pending } = await supabase
    .from('pending_purchases')
    .select('*')
    .eq('email', email.toLowerCase())
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (!pending?.length) return false;

  for (const row of pending) {
    try {
      const licensePlan = (row.plan_code as string).startsWith('lifetime') ? 'lifetime' : 'monthly';

      if (row.stripe_subscription_id) {
        // Monthly — Stripe is authoritative. Persist the paid-through date so
        // the desktop can grant access even if the next Stripe sync is briefly
        // unavailable.
        const stripeSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        const subFields = {
          stripe_customer_id:     row.stripe_customer_id,
          stripe_subscription_id: row.stripe_subscription_id,
          stripe_price_id:        stripeSub.items.data[0]?.price.id ?? null,
          status:                 stripeSub.status,
          current_period_end:     new Date(stripeSub.current_period_end * 1000).toISOString(),
          cancel_at_period_end:   stripeSub.cancel_at_period_end,
          updated_at:             new Date().toISOString(),
        };

        const { data: existingSub, error: existingErr } = await supabase
          .from('subscriptions')
          .select('id, stripe_subscription_id, status')
          .eq('user_id', userId)
          .neq('status', 'lifetime')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingErr) throw new Error(`Subscription lookup failed: ${existingErr.message}`);

        const writeResult = existingSub?.id
          ? await supabase.from('subscriptions').update(subFields).eq('id', existingSub.id)
          : await supabase.from('subscriptions').insert({
              user_id: userId,
              ...subFields,
              created_at: new Date().toISOString(),
            });
        if (writeResult.error) throw new Error(`Subscription save failed: ${writeResult.error.message}`);
      } else {
        // Lifetime one-time payment
        const { data: existingSub, error: existingErr } = await supabase
          .from('subscriptions')
          .select('id, stripe_subscription_id, status')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingErr) throw new Error(`Lifetime subscription lookup failed: ${existingErr.message}`);

        if (existingSub?.stripe_subscription_id && existingSub.status !== 'lifetime') {
          const currentStripeSub = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id);
          if (currentStripeSub.status !== 'canceled') {
            await stripe.subscriptions.cancel(existingSub.stripe_subscription_id);
            console.log(`[RECONCILE_LIFETIME_MONTHLY_CANCELED] userId=${userId} subId=${existingSub.stripe_subscription_id}`);
          }
        }

        const lifetimeFields = {
          stripe_customer_id:     row.stripe_customer_id,
          stripe_subscription_id: null,
          stripe_price_id:        null,
          status:                 'lifetime',
          current_period_end:     null,
          cancel_at_period_end:   false,
          updated_at:             new Date().toISOString(),
        };
        const writeResult = existingSub?.id
          ? await supabase.from('subscriptions').update(lifetimeFields).eq('id', existingSub.id)
          : await supabase.from('subscriptions').insert({
              user_id: userId,
              ...lifetimeFields,
              created_at: new Date().toISOString(),
            });
        if (writeResult.error) throw new Error(`Lifetime subscription save failed: ${writeResult.error.message}`);

        // Guest purchase-first: record early-bird claim if the plan was lifetime_early.
        // The webhook couldn't do this at purchase time because userId wasn't known yet.
        // stripe_session_id unique constraint prevents double-counting on repeated reconcile.
        if (row.plan_code === 'lifetime_early' && row.stripe_session_id) {
          const { error: ebErr } = await supabase.from('early_bird_sales').upsert({
            stripe_session_id: row.stripe_session_id,
            user_id:           userId,
            created_at:        new Date().toISOString(),
          }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });
          if (ebErr) {
            console.error('[reconcile] early_bird_sales upsert failed', row.id, ebErr.message);
          } else {
            console.log(`[RECONCILE_EARLY_BIRD_RECORDED] userId=${userId} sessionId=${row.stripe_session_id}`);
          }
        }
      }

      await provisionLicense(userId, licensePlan);

      // ── Guest referral accrual ────────────────────────────────────────────
      // Mirrors the early-bird block above and the logged-in path in the Stripe
      // webhook. Runs AFTER provisionLicense so a reward never exists for a
      // purchase that failed to grant access, and is idempotent via the unique
      // stripe_session_id on referral_attributions plus the one-accrual-per-
      // attribution index — so repeated reconciles credit exactly once.
      //
      // The "new buyer" gate already ran in the webhook before this row was
      // written; the frozen snapshot in metadata is authoritative and is
      // deliberately not re-evaluated here (a license now exists, so every
      // buyer would look like a returning one).
      //
      // Imported lazily: lib/referrals.ts imports auditLog from this module, and
      // a static import here would create a module cycle.
      const referrerUserId = (row.metadata as any)?.referrer_user_id;
      const referralCodeId = (row.metadata as any)?.referral_code_id;

      if (licensePlan === 'lifetime' && referrerUserId && referralCodeId) {
        const { accrueReferral } = await import('./referrals');
        let saleAmountCents = Number((row.metadata as any)?.sale_amount_cents ?? 0);
        let rewardBasisCents = Number((row.metadata as any)?.reward_basis_cents ?? 0);
        let currency = (row.metadata as any)?.currency ?? '';
        let purchasedAt = (row.metadata as any)?.purchased_at ?? row.created_at ?? null;

        // Compatibility for a guest checkout completed shortly before the
        // tiered snapshot fields were deployed. Stripe remains authoritative;
        // never guess a purchase amount for a cash reward.
        if (saleAmountCents <= 0 || rewardBasisCents <= 0 || !currency) {
          const checkout = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
          saleAmountCents = checkout.amount_total ?? 0;
          rewardBasisCents = Math.max(
            0,
            (checkout.amount_subtotal ?? 0) - (checkout.total_details?.amount_discount ?? 0)
          );
          currency = checkout.currency ?? '';
          purchasedAt = new Date(checkout.created * 1000).toISOString();
        }

        await accrueReferral({
          stripeSessionId:       row.stripe_session_id,
          stripePaymentIntentId: (row.metadata as any)?.payment_intent ?? null,
          referrerUserId,
          referralCodeId,
          referralCode:          (row.metadata as any)?.referral_code ?? '',
          referredUserId:        userId,
          referredEmail:         email,
          planCode:              row.plan_code,
          termsVersion:          (row.metadata as any)?.terms_version ?? null,
          termsAcceptedAt:       (row.metadata as any)?.terms_accepted_at ?? null,
          saleAmountCents,
          rewardBasisCents,
          currency,
          purchasedAt,
        });
      }

      const { error: reconcileErr } = await supabase
        .from('pending_purchases')
        .update({ status: 'reconciled', reconciled_at: new Date().toISOString() })
        .eq('id', row.id);
      if (reconcileErr) throw new Error(`Pending purchase finalization failed: ${reconcileErr.message}`);

      await auditLog(userId, 'pending_purchase_reconciled', {
        stripe_session_id: row.stripe_session_id,
        plan_code:         row.plan_code,
        email,
        referral_accrued:  !!(licensePlan === 'lifetime' && referrerUserId),
      });
    } catch (err: any) {
      console.error('[reconcile] failed for pending_purchase', row.id, err.message);
    }
  }

  return true;
}

/**
 * Fetch the latest subscription state from Stripe and update Supabase.
 * Called before access checks to ensure DB reflects Stripe's ground truth.
 * Returns the updated DB row on success, or null on any failure (callers
 * must treat null as "data unavailable" — not as "no subscription").
 */
export async function syncStripeSubscriptionForUser(
  userId: string,
  stripeSubscriptionId: string
): Promise<Record<string, any> | null> {
  console.log(`[STRIPE_SYNC_START] userId=${userId} subId=${stripeSubscriptionId}`);
  try {
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const periodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('subscriptions')
      .update({
        status:               stripeSub.status,
        current_period_end:   periodEnd,
        cancel_at_period_end: stripeSub.cancel_at_period_end,
        updated_at:           new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .select()
      .single();

    if (error) {
      console.error(`[STRIPE_SYNC_ERROR] userId=${userId} subId=${stripeSubscriptionId} error=${error.message}`);
      return null;
    }

    console.log(`[STRIPE_SYNC_RESULT] userId=${userId} subId=${stripeSubscriptionId} status=${stripeSub.status} periodEnd=${periodEnd} cancelAtPeriodEnd=${stripeSub.cancel_at_period_end}`);
    return data;
  } catch (err: any) {
    console.error(`[STRIPE_SYNC_EXCEPTION] userId=${userId} subId=${stripeSubscriptionId} error=${err.message}`);
    return null;
  }
}

/** Write an entry to audit_logs. Never throws. */
export async function auditLog(
  userId: string | null,
  eventType: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    const supabase = createServiceClient();
    await supabase.from('audit_logs').insert({ user_id: userId, event_type: eventType, metadata });
  } catch {
    // Non-fatal
  }
}
