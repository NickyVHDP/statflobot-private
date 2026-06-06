#!/usr/bin/env node
/**
 * scripts/backfill-stripe-subscriptions.js
 *
 * One-time script: fetches every monthly subscription's current state from
 * Stripe and writes it back to the Supabase subscriptions table, ensuring
 * status, current_period_end, and cancel_at_period_end are accurate.
 *
 * Run from the repo root (reads env from monetization/web/.env.local):
 *
 *   node scripts/backfill-stripe-subscriptions.js [--dry-run]
 *
 * Required env (loaded automatically from monetization/web/.env.local):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Load env from monetization/web/.env.local
const envPath = path.join(__dirname, '../monetization/web/.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log(`[BACKFILL] loaded env from ${envPath}`);
} else {
  console.warn(`[BACKFILL] .env.local not found at ${envPath} — relying on shell env`);
}

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('[BACKFILL] DRY RUN MODE — no writes will be made');

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY         = process.env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error('[BACKFILL] Missing required env. Need: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY');
  process.exit(1);
}

// Require packages from monetization/web/node_modules
const webModules = path.join(__dirname, '../monetization/web/node_modules');
const { createClient } = require(path.join(webModules, '@supabase/supabase-js'));
const Stripe = require(path.join(webModules, 'stripe'));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

async function main() {
  console.log('[BACKFILL] fetching all monthly subscriptions from DB...');

  // Fetch all subscriptions that have a stripe_subscription_id (monthly users)
  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('id, user_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end')
    .not('stripe_subscription_id', 'is', null)
    .neq('status', 'lifetime');

  if (error) {
    console.error('[BACKFILL] DB fetch failed:', error.message);
    process.exit(1);
  }

  console.log(`[BACKFILL] found ${rows.length} subscriptions to check`);

  let deactivated = 0;
  let updated     = 0;
  let unchanged   = 0;
  let failed      = 0;
  const now       = new Date();

  for (const row of rows) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const newPeriodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();
      const periodEndInFuture = new Date(newPeriodEnd) > now;

      // Normalize period_end strings for comparison (DB may store +00:00, Stripe returns .000Z)
      const dbPeriodEndNormalized = row.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null;
      const statusChanged     = stripeSub.status !== row.status;
      const periodEndChanged  = newPeriodEnd !== dbPeriodEndNormalized;
      const cancelFlagChanged = stripeSub.cancel_at_period_end !== row.cancel_at_period_end;

      // Access is denied when period_end is past for any sub status except lifetime
      const accessGranted = periodEndInFuture &&
        ['active', 'trialing', 'canceled'].includes(stripeSub.status);
      const accessShouldBeDenied = !accessGranted;

      console.log(`[BACKFILL] userId=${row.user_id} sub=${row.stripe_subscription_id} ` +
        `dbStatus=${row.status} stripeStatus=${stripeSub.status} ` +
        `periodEnd=${newPeriodEnd} periodEndInFuture=${periodEndInFuture} ` +
        `cancelAtEnd=${stripeSub.cancel_at_period_end} accessShouldBeDenied=${accessShouldBeDenied}`);

      // Check whether the monthly license is still active
      const { data: activeLicense } = await supabase
        .from('licenses')
        .select('id')
        .eq('user_id', row.user_id)
        .eq('plan', 'monthly')
        .eq('status', 'active')
        .maybeSingle();

      const licenseNeedsDeactivation = accessShouldBeDenied && !!activeLicense;

      if (licenseNeedsDeactivation) {
        console.log(`[BACKFILL_LICENSE_WILL_DEACTIVATE] userId=${row.user_id} ` +
          `— subscription expired (periodEnd=${newPeriodEnd}, in_past) but license is still active`);
      }

      if (!statusChanged && !periodEndChanged && !cancelFlagChanged && !licenseNeedsDeactivation) {
        unchanged++;
        continue;
      }

      if (!DRY_RUN) {
        // Always update the subscription row to the canonical Stripe state
        const { error: updateErr } = await supabase
          .from('subscriptions')
          .update({
            status:               stripeSub.status,
            current_period_end:   newPeriodEnd,
            cancel_at_period_end: stripeSub.cancel_at_period_end,
            updated_at:           new Date().toISOString(),
          })
          .eq('id', row.id);

        if (updateErr) {
          console.error(`[BACKFILL_UPDATE_FAILED] userId=${row.user_id} error=${updateErr.message}`);
          failed++;
          continue;
        }

        // Deactivate the license if the subscription is expired (regardless of what it was before)
        if (licenseNeedsDeactivation) {
          const { error: licErr } = await supabase
            .from('licenses')
            .update({ status: 'inactive' })
            .eq('user_id', row.user_id)
            .eq('plan', 'monthly');

          if (licErr) {
            console.error(`[BACKFILL_LICENSE_DEACTIVATE_FAILED] userId=${row.user_id} error=${licErr.message}`);
          } else {
            console.log(`[BACKFILL_LICENSE_DEACTIVATED] userId=${row.user_id} — subscription expired, license deactivated`);
            deactivated++;
          }
        }
      } else {
        if (statusChanged || periodEndChanged || cancelFlagChanged) {
          console.log(`[DRY_RUN] would sync sub userId=${row.user_id} ` +
            `status=${row.status}→${stripeSub.status} ` +
            `periodEnd=${row.current_period_end}→${newPeriodEnd}`);
        }
        if (licenseNeedsDeactivation) {
          console.log(`[DRY_RUN] would deactivate license userId=${row.user_id} ` +
            `— sub expired (periodEnd=${newPeriodEnd}), license still active`);
        }
      }

      updated++;
    } catch (err) {
      console.error(`[BACKFILL_ERROR] userId=${row.user_id} sub=${row.stripe_subscription_id} error=${err.message}`);
      failed++;
    }
  }

  console.log('\n[BACKFILL] ── COMPLETE ──────────────────────────────────────');
  console.log(`  Checked  : ${rows.length}`);
  console.log(`  Updated  : ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Licenses deactivated: ${deactivated}`);
  console.log(`  Failed   : ${failed}`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes written)');
  console.log('[BACKFILL] ─────────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('[BACKFILL] fatal:', err.message);
  process.exit(1);
});
