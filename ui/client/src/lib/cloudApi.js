/**
 * lib/cloudApi.js
 *
 * All cloud API calls are routed through the local Express server proxy (/api/proxy/*).
 * This avoids CORS entirely — the browser only ever talks to localhost, and Express
 * forwards requests server-to-server to the cloud backend (statflobot.store).
 *
 * The proxy is configured in ui/server/index.js.
 * In Vite dev mode, /api/* is proxied to localhost:3001 via vite.config.js.
 */

import { supabase } from './supabase';

async function authHeaders() {
  if (!supabase) return {};
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

const FETCH_TIMEOUT_MS = 12_000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function post(path, body = {}) {
  const headers = await authHeaders();
  console.log(`[cloudApi] POST ${path}`);
  try {
    const res = await fetchWithTimeout(path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify(body),
    });
    console.log(`[cloudApi] POST ${path} → ${res.status}`);
    return res.json();
  } catch (err) {
    console.warn(`[cloudApi] POST ${path} failed:`, err.message);
    throw err;
  }
}

async function get(path) {
  const headers = await authHeaders();
  console.log(`[cloudApi] GET ${path}`);
  try {
    const res = await fetchWithTimeout(path, { headers });
    console.log(`[cloudApi] GET ${path} → ${res.status}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      err.reason = body.reason;
      throw err;
    }
    return res.json();
  } catch (err) {
    console.warn(`[cloudApi] GET ${path} failed:`, err.message);
    throw err;
  }
}

/** Open a URL in the system browser (Electron) or a new tab (web). */
function openExternal(url) {
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Returns the current Supabase access token (empty string if unauthenticated). */
export async function getAccessToken() {
  if (!supabase) return '';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

/**
 * Fetch full account snapshot (profile + license + subscription + devices).
 * Returns null when the cloud API is unreachable so the UI can degrade gracefully.
 */
export async function fetchAccount() {
  try {
    return await get('/api/proxy/account');
  } catch (err) {
    console.warn('[cloudApi] fetchAccount unavailable:', err.message);
    if (err.status === 401) return { _authExpired: true };
    return null;
  }
}

/** Owner-only fleet reliability review. Customer identities are omitted. */
export async function fetchReliabilityReview() {
  return get('/api/proxy/admin/reliability');
}

/** Owner-only referral audit summary. Payout approval is intentionally web-only. */
export async function fetchAdminReferrals() {
  return get('/api/proxy/admin/referrals');
}

/** Safe support metadata for the signed-in account; never includes diagnostic logs. */
export async function fetchSupportNotices(installedVersion) {
  return get(`/api/proxy/support/notices?installedVersion=${encodeURIComponent(installedVersion ?? '')}`);
}

/** Acknowledge a private resolution notice across all of this account's devices. */
export async function acknowledgeSupportNotice(reference) {
  return post('/api/proxy/support/notices/ack', { reference });
}

/** Owner-only support queue. */
export async function fetchAdminSupportReports() {
  return get('/api/proxy/admin/support/reports');
}

/** Owner-only, explicit resolution + customer email action. */
export async function resolveAdminSupportReport(reference, resolutionMessage, fixedInVersion) {
  return post('/api/proxy/admin/support/resolve', { reference, resolutionMessage, fixedInVersion });
}

/** Open Stripe Billing Portal in the system browser. */
export async function openBillingPortal() {
  const data = await post('/api/proxy/billing/portal');
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open billing portal');
}

/**
 * Open the lifetime upgrade checkout in the system browser.
 *
 * `termsAccepted` is REQUIRED by the cloud route. The desktop app must collect
 * the same final-sale acknowledgment the website does — otherwise the desktop
 * becomes a way to buy without accepting the terms, which would undermine the
 * enforceability of the final-sale policy itself.
 *
 * @param {{ termsAccepted: boolean, referralCode?: string }} opts
 */
export async function openLifetimeCheckout(opts = {}) {
  if (opts.termsAccepted !== true) {
    throw new Error('Please confirm you understand this purchase is final before continuing.');
  }
  const data = await post('/api/proxy/checkout/lifetime', {
    source:        'desktop',
    termsAccepted: true,
    ...(opts.referralCode ? { referralCode: opts.referralCode } : {}),
  });
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open checkout');
}

/** Validate a referral code before starting a lifetime checkout. */
export async function validateReferralCode(referralCode) {
  return post('/api/proxy/referrals/validate', { referralCode });
}

/** The signed-in account's referral code, balances and payout status. */
export async function fetchReferralSummary() {
  return get('/api/proxy/referrals/summary');
}

/** Issue (or fetch) this account's single referral code. */
export async function createReferralCode() {
  return post('/api/proxy/referrals/code');
}

/** Open Stripe-hosted Global Payouts enrollment to connect a payout method. */
export async function openReferralBankOnboarding() {
  const data = await post('/api/proxy/referrals/connect/onboard');
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not start bank onboarding');
}

/** Open the monthly checkout in the system browser (for new subscribers). */
export async function openMonthlyCheckout() {
  const data = await post('/api/proxy/checkout/monthly', { source: 'desktop' });
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open checkout');
}

/** Fetch server-authoritative prices so desktop CTAs always match Stripe. */
export async function fetchPricing() {
  return get('/api/proxy/pricing');
}

/** Remove a device from the license. */
export async function removeDevice(deviceId) {
  return post('/api/proxy/licenses/register-device', { action: 'remove', deviceId });
}

/**
 * Get a short-lived signed download URL for the specified platform.
 * @param {'mac'|'windows'} platform
 * @returns {Promise<string>} Signed URL valid for ~60 seconds
 */
export async function fetchDownloadUrl(platform) {
  const data = await get(`/api/proxy/download?platform=${encodeURIComponent(platform)}`);
  if (!data.url) throw new Error(data.error ?? 'Could not generate download link');
  return data.url;
}
