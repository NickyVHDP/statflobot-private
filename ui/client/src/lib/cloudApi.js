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

async function post(path, body = {}) {
  const headers = await authHeaders();
  const res = await fetch(path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const headers = await authHeaders();
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
    return null;
  }
}

/** Open Stripe Billing Portal in the system browser. */
export async function openBillingPortal() {
  const data = await post('/api/proxy/billing/portal');
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open billing portal');
}

/** Open the lifetime upgrade checkout in the system browser. */
export async function openLifetimeCheckout() {
  const data = await post('/api/proxy/checkout/lifetime');
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open checkout');
}

/** Open the monthly checkout in the system browser (for new subscribers). */
export async function openMonthlyCheckout() {
  const data = await post('/api/proxy/checkout/monthly');
  if (data.url) openExternal(data.url);
  else throw new Error(data.error ?? 'Could not open checkout');
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
