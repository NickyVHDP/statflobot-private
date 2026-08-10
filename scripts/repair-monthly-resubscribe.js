#!/usr/bin/env node
/**
 * scripts/repair-monthly-resubscribe.js
 *
 * Repair tool for users who paid for a monthly re-subscription but whose
 * Supabase subscription row and/or license were not updated (usually because
 * the webhook fired but the onConflict:'stripe_subscription_id' upsert failed
 * silently against the user_id unique constraint).
 *
 * What it does:
 *   1. Resolves the user by email in Supabase.
 *   2. Looks up all Stripe subscriptions for the user's known customer IDs.
 *   3. Finds any active/trialing monthly subscription in Stripe.
 *   4. Updates (or inserts) the Supabase subscriptions row.
 *   5. Reactivates the monthly license (status → active).
 *   6. Prints before/after state for confirmation.
 *
 * Run from repo root:
 *   node scripts/repair-monthly-resubscribe.js --email user@example.com [--dry-run]
 *
 * Required env (loaded from monetization/web/.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL  (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Load env
const envPath = path.join(__dirname, '../monetization/web/.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log(`[REPAIR] loaded env from ${envPath}`);
} else {
  console.warn(`[REPAIR] .env.local not found — relying on shell env`);
}

const DRY_RUN = process.argv.includes('--dry-run');
const emailArg = (() => {
  const idx = process.argv.indexOf('--email');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const userIdArg = (() => {
  const idx = process.argv.indexOf('--user-id');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

if (!emailArg && !userIdArg) {
  console.error('[REPAIR] Usage: node scripts/repair-monthly-resubscribe.js --email user@example.com [--user-id uuid] [--dry-run]');
  process.exit(1);
}

if (DRY_RUN) console.log('[REPAIR] DRY RUN MODE — no writes will be made');

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY         = process.env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('[REPAIR] Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY');
  process.exit(1);
}

const webModules = path.join(__dirname, '../monetization/web/node_modules');
const { createClient } = require(path.join(webModules, '@supabase/supabase-js'));
const Stripe = require(path.join(webModules, 'stripe'));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

async function main() {
  const email = emailArg.toLowerCase();
  console.log(`\n[REPAIR] ── Starting repair for ${email} ──────────────────────────`);

  // ── 1. Resolve user by email or --user-id flag ─────────────────────────────
  let userId = userIdArg ?? null;
  let userEmail = email;

  if (!userId) {
    // Try profiles table first (email column may exist)
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('email', email)
      .maybeSingle();

    if (profile?.id) {
      userId = profile.id;
      console.log(`[REPAIR] Found user via profiles: id=${userId} email=${profile.email} name=${profile.full_name ?? '(none)'}`);
    } else {
      // Fallback: auth admin lookup
      const { data: { users } } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const match = users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (match) {
        userId = match.id;
        console.log(`[REPAIR] Found user via auth admin: id=${userId} email=${match.email}`);
      }
    }
  }

  if (!userId) {
    console.error(`[REPAIR] Could not resolve user for email: ${email}. Try --user-id <uuid> to bypass lookup.`);
    process.exit(1);
  }

  console.log(`[REPAIR] Target userId=${userId} email=${userEmail}`);

  // ── 2. Current Supabase state ───────────────────────────────────────────────
  const { data: allSubs } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const { data: license } = await supabase
    .from('licenses')
    .select('id, plan, status, license_key')
    .eq('user_id', userId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log(`\n[BEFORE] Supabase subscriptions (${(allSubs ?? []).length} rows):`);
  for (const s of allSubs ?? []) {
    console.log(`  sub_id=${s.stripe_subscription_id ?? 'none'} status=${s.status} periodEnd=${s.current_period_end ?? 'none'} customer=${s.stripe_customer_id ?? 'none'}`);
  }
  console.log(`[BEFORE] License: plan=${license?.plan ?? 'none'} status=${license?.status ?? 'none'} id=${license?.id ?? 'none'}`);

  // ── 3. Collect all known Stripe customer IDs for this user ─────────────────
  const customerIds = [...new Set(
    (allSubs ?? [])
      .map((s) => s.stripe_customer_id)
      .filter(Boolean)
  )];

  // Also search Stripe by email to catch purchases with new customers
  const stripeCustomerSearch = await stripe.customers.search({ query: `email:"${email}"`, limit: 10 });
  const emailCustomerIds = stripeCustomerSearch.data.map((c) => c.id);
  const allCustomerIds = [...new Set([...customerIds, ...emailCustomerIds])];

  console.log(`\n[REPAIR] Stripe customers to check: ${allCustomerIds.join(', ') || '(none found)'}`);

  // ── 4. Find active monthly Stripe subscriptions ────────────────────────────
  let activeMonthlySub = null;

  for (const custId of allCustomerIds) {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'active', limit: 10 });
    for (const sub of subs.data) {
      console.log(`[REPAIR] Stripe sub found: id=${sub.id} status=${sub.status} customer=${custId} periodEnd=${new Date(sub.current_period_end * 1000).toISOString()}`);
      if (!activeMonthlySub) activeMonthlySub = { sub, customerId: custId };
    }
    // Trialing subscriptions are deliberately NOT repaired into a license.
    // StatfloBot is paid-only: an unpaid trial must not end up holding an
    // active license row, which the access check treats as an entitlement.
    const trialSubs = await stripe.subscriptions.list({ customer: custId, status: 'trialing', limit: 10 });
    for (const sub of trialSubs.data) {
      console.log(`[REPAIR] Stripe trialing sub found but SKIPPED (paid-only): id=${sub.id} customer=${custId}`);
    }
  }

  if (!activeMonthlySub) {
    console.error('[REPAIR] No active Stripe subscription found for this user. Nothing to repair.');
    console.error('         If Stripe shows active, double-check the customer email matches exactly.');
    process.exit(1);
  }

  const { sub: stripeSub, customerId } = activeMonthlySub;
  const newPeriodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();
  const newSubId     = stripeSub.id;
  const newStatus    = stripeSub.status;

  console.log(`\n[REPAIR] Will sync Stripe sub: id=${newSubId} status=${newStatus} customer=${customerId} periodEnd=${newPeriodEnd}`);

  if (DRY_RUN) {
    console.log('[DRY_RUN] Would update subscription row for userId=' + userId);
    console.log('[DRY_RUN] Would set license status=active for userId=' + userId);
    console.log('\n[REPAIR] ── DRY RUN COMPLETE — no changes written ─────────────────────\n');
    return;
  }

  // ── 5. Update subscription row ─────────────────────────────────────────────
  // Find existing non-lifetime row; update it. Insert if none exists.
  const existingSubRow = (allSubs ?? []).find((s) => s.status !== 'lifetime');

  const subFields = {
    stripe_customer_id:     customerId,
    stripe_subscription_id: newSubId,
    status:                 newStatus,
    current_period_end:     newPeriodEnd,
    cancel_at_period_end:   stripeSub.cancel_at_period_end,
    updated_at:             new Date().toISOString(),
  };

  if (existingSubRow) {
    const { error: updateErr } = await supabase
      .from('subscriptions')
      .update(subFields)
      .eq('id', existingSubRow.id);

    if (updateErr) {
      console.error(`[REPAIR] Subscription update failed: ${updateErr.message}`);
      process.exit(1);
    }
    console.log(`[REPAIR] ✓ Subscription row updated: id=${existingSubRow.id} → subId=${newSubId} status=${newStatus} periodEnd=${newPeriodEnd}`);
  } else {
    const { error: insertErr } = await supabase.from('subscriptions').insert({
      user_id: userId,
      ...subFields,
      created_at: new Date().toISOString(),
    });

    if (insertErr) {
      console.error(`[REPAIR] Subscription insert failed: ${insertErr.message}`);
      process.exit(1);
    }
    console.log(`[REPAIR] ✓ Subscription row inserted: subId=${newSubId} status=${newStatus} periodEnd=${newPeriodEnd}`);
  }

  // ── 6. Reactivate monthly license ──────────────────────────────────────────
  if (license?.id && license.plan === 'monthly') {
    const { error: licErr } = await supabase
      .from('licenses')
      .update({ status: 'active' })
      .eq('id', license.id);

    if (licErr) {
      console.error(`[REPAIR] License reactivation failed: ${licErr.message}`);
    } else {
      console.log(`[REPAIR] ✓ License reactivated: id=${license.id} plan=monthly status=active`);
    }
  } else if (!license) {
    // No license row — insert one
    const licenseKey = `STATFLO-${Math.random().toString(36).toUpperCase().slice(2,7)}-${Math.random().toString(36).toUpperCase().slice(2,7)}-${Math.random().toString(36).toUpperCase().slice(2,7)}`;
    const { error: licInsertErr } = await supabase.from('licenses').insert({
      user_id:     userId,
      license_key: licenseKey,
      status:      'active',
      plan:        'monthly',
      max_devices: 2,
      created_at:  new Date().toISOString(),
    });
    if (licInsertErr) {
      console.error(`[REPAIR] License insert failed: ${licInsertErr.message}`);
    } else {
      console.log(`[REPAIR] ✓ New monthly license created: key=${licenseKey}`);
    }
  } else {
    console.log(`[REPAIR] License plan=${license.plan} — skipping (non-monthly or already active)`);
  }

  // ── 7. Print after state ────────────────────────────────────────────────────
  const { data: afterSubs } = await supabase
    .from('subscriptions')
    .select('stripe_subscription_id, status, current_period_end, stripe_customer_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const { data: afterLicense } = await supabase
    .from('licenses')
    .select('plan, status, license_key')
    .eq('user_id', userId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log(`\n[AFTER] Supabase subscriptions:`);
  for (const s of afterSubs ?? []) {
    console.log(`  sub_id=${s.stripe_subscription_id ?? 'none'} status=${s.status} periodEnd=${s.current_period_end ?? 'none'}`);
  }
  console.log(`[AFTER] License: plan=${afterLicense?.plan ?? 'none'} status=${afterLicense?.status ?? 'none'}`);

  // Only an 'active' subscription counts as repaired. A trialing subscription
  // grants no access under the paid-only rules, so reporting it as "access
  // should now be active" would send the operator away believing a customer was
  // fixed when they are still locked out.
  const isFixed = afterLicense?.status === 'active' &&
    (afterSubs ?? []).some((s) => s.status === 'active');

  console.log(`\n[REPAIR] ── ${isFixed ? '✓ REPAIR COMPLETE — access should now be active' : '✗ CHECK STATE — something may still be wrong'} ──`);
  console.log('[REPAIR] Run "Refresh Status" in the desktop app or restart it to pick up new state.\n');
}

main().catch((err) => {
  console.error('[REPAIR] Fatal:', err.message);
  process.exit(1);
});
