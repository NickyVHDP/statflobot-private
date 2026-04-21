'use strict';

/**
 * monetization/local-gate/auth-gate.js
 *
 * Pre-run license gate for the Ruflo Bot.
 *
 * Called from src/main.js BEFORE any browser is launched.
 * Returns { valid: true, plan, user } or { valid: false, message }.
 *
 * Environment variables read:
 *   LICENSE_API_URL   — URL of the deployed dashboard (e.g. https://ruflo.vercel.app)
 *   RUFLO_LICENSE_KEY — the customer's license key (RUFLO-XXXX-XXXX-XXXX-XXXX)
 *   LICENSE_SKIP      — set to "true" to bypass gate for local dev (NEVER in prod)
 *
 * If neither env var is set, the gate is treated as disabled (safe for
 * customers who haven't configured it yet — shows a friendly setup notice).
 */

const tokenStore    = require('./token-store');
const licenseClient = require('./license-client');

const PLAN_LABELS = {
  monthly:           'Monthly ($10/mo)',
  lifetime_early:    'Lifetime Early Adopter',
  lifetime_standard: 'Lifetime Standard',
};

/**
 * Verify the license.
 *
 * 1. If LICENSE_SKIP=true → bypass (dev only)
 * 2. If gate is not configured → show setup notice, still allow run
 * 3. Check disk cache first (respects recheckSeconds from last server response)
 * 4. If cache miss / expired → hit the API
 * 5. Return result
 */
async function verify() {
  // ── Dev bypass ───────────────────────────────────────────────────────────
  if (process.env.LICENSE_SKIP === 'true') {
    return { valid: true, plan: 'dev', message: 'License gate bypassed (LICENSE_SKIP=true)' };
  }

  const apiUrl    = process.env.LICENSE_API_URL;
  const licenseKey = process.env.RUFLO_LICENSE_KEY;

  // ── Gate not configured — show setup notice ───────────────────────────────
  if (!apiUrl || !licenseKey) {
    const missing = [
      !apiUrl     && 'LICENSE_API_URL',
      !licenseKey && 'RUFLO_LICENSE_KEY',
    ].filter(Boolean).join(', ');

    console.log('\n' + '─'.repeat(56));
    console.log('  Ruflo Bot — License Setup Required');
    console.log('─'.repeat(56));
    console.log(`  Missing .env variables: ${missing}`);
    console.log('  1. Get your license key at: https://ruflo.vercel.app');
    console.log('  2. Add to your .env file:');
    if (!apiUrl)     console.log('     LICENSE_API_URL=https://ruflo.vercel.app');
    if (!licenseKey) console.log('     RUFLO_LICENSE_KEY=RUFLO-XXXX-XXXX-XXXX-XXXX');
    console.log('─'.repeat(56) + '\n');

    // Allow the run so existing users aren't blocked before setup
    return { valid: true, plan: 'unconfigured', message: 'License gate not configured — add env vars to enable.' };
  }

  // ── Check disk cache ──────────────────────────────────────────────────────
  const cached = tokenStore.read();
  if (cached && cached.valid) {
    return {
      valid:   true,
      plan:    cached.plan,
      message: `License valid (${PLAN_LABELS[cached.plan] ?? cached.plan}) — cached`,
      user:    cached.user,
    };
  }

  // ── Hit the API ───────────────────────────────────────────────────────────
  let result;
  try {
    result = await licenseClient.verifyLicense(apiUrl, licenseKey);
  } catch (netErr) {
    // Network failure — if we have a stale cached valid result, allow the run
    // with a warning. Otherwise block.
    const stale = tokenStore.read();
    if (stale && stale.valid) {
      console.warn(`[License] Network error — using stale cache: ${netErr.message}`);
      return { valid: true, plan: stale.plan, message: 'License cache used (network error)', user: stale.user };
    }
    return {
      valid:   false,
      message: `Could not reach license server: ${netErr.message}\nCheck your internet connection or try again.`,
    };
  }

  if (result.valid) {
    tokenStore.write(result);
    return {
      valid:   true,
      plan:    result.plan,
      message: `License verified — ${PLAN_LABELS[result.plan] ?? result.plan}`,
      user:    result.user,
    };
  }

  // Invalid — clear cache and return detailed reason
  tokenStore.clear();

  const reasons = {
    'License not found':           'Your license key was not found. Check RUFLO_LICENSE_KEY in your .env file.',
    'License has been revoked':    'Your license has been revoked. Contact support.',
    'License is inactive':         'Your license is inactive. Check your billing at https://ruflo.vercel.app/dashboard',
    'Subscription is not active':  'Your subscription is not active. Renew at https://ruflo.vercel.app/dashboard',
  };

  const friendlyReason = Object.entries(reasons).find(([k]) =>
    result.reason?.includes(k)
  )?.[1] ?? result.reason ?? 'License verification failed.';

  const deviceLimitMsg = result.reason?.includes('Device limit')
    ? '\nRemove an old device at https://ruflo.vercel.app/dashboard'
    : '';

  return {
    valid:   false,
    message: friendlyReason + deviceLimitMsg,
  };
}

module.exports = { verify };
