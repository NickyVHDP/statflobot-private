import { createServiceClient } from './supabase/server';

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
  const { data: existing } = await supabase
    .from('licenses')
    .select('id, license_key')
    .eq('user_id', userId)
    .eq('plan', planCode)
    .neq('status', 'revoked')
    .single();

  if (existing) {
    await supabase
      .from('licenses')
      .update({ status: 'active', updated_at: new Date().toISOString() })
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
    .update({ status: 'inactive', updated_at: new Date().toISOString() })
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
        // Monthly — upsert subscription row
        await supabase.from('subscriptions').upsert({
          user_id:                userId,
          stripe_customer_id:     row.stripe_customer_id,
          stripe_subscription_id: row.stripe_subscription_id,
          status:                 'active',
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'stripe_subscription_id' });
      } else {
        // Lifetime one-time payment
        await supabase.from('subscriptions').upsert({
          user_id:            userId,
          stripe_customer_id: row.stripe_customer_id,
          status:             'lifetime',
          updated_at:         new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }

      await provisionLicense(userId, licensePlan);

      await supabase
        .from('pending_purchases')
        .update({ status: 'reconciled', reconciled_at: new Date().toISOString() })
        .eq('id', row.id);

      await auditLog(userId, 'pending_purchase_reconciled', {
        stripe_session_id: row.stripe_session_id,
        plan_code:         row.plan_code,
        email,
      });
    } catch (err: any) {
      console.error('[reconcile] failed for pending_purchase', row.id, err.message);
    }
  }

  return true;
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
