/**
 * lib/admin.ts
 *
 * Server-side admin allowlist.  NEVER expose via NEXT_PUBLIC_ — this module
 * must only be imported by server-side code (API routes, Server Components).
 *
 * Priority order:
 *   1. HARDCODED_ADMIN_EMAILS — always active, survives missing env vars.
 *   2. ADMIN_EMAILS env var   — comma-separated, add extra admins at deploy time.
 *
 * Security rules enforced here:
 *   - Only authenticated email (from JWT/Supabase) is checked — never profile DB fields.
 *   - No wildcards.
 *   - Normalized to lowercase + trim before comparison.
 */

// ── Hardcoded owner/creator fallback — active regardless of env vars ──────────
// This ensures the creator retains lifetime access even if ADMIN_EMAILS is
// accidentally unset after a Vercel redeploy.
const HARDCODED_ADMIN_EMAILS: ReadonlySet<string> = new Set([
  'nickymccracken159@gmail.com', // owner / creator
]);

// Money movement is deliberately narrower than general administration.
// ADMIN_EMAILS may grant support/review access, but it must never grant the
// ability to approve referral payouts. Only these owner identities can do so.
const OWNER_EMAILS: ReadonlySet<string> = new Set([
  'nickymccracken159@gmail.com',
]);

// ── Env-var admin list — add extra admins without redeploying code ────────────
const ENV_ADMIN_EMAILS: Set<string> = (() => {
  const raw = process.env.ADMIN_EMAILS ?? '';
  const parsed = new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  if (parsed.size === 0) {
    console.warn('[admin] ADMIN_EMAILS env var not set — relying on hardcoded fallback only');
  }
  // Log the COUNT only. This previously printed every admin address on each
  // cold start, which put the full privileged-account list into Vercel logs for
  // anyone with log access — an unnecessary disclosure given the count alone
  // answers the "is my env var loaded?" question it existed for.
  console.log(`[ADMIN_EMAILS_LOADED] count=${HARDCODED_ADMIN_EMAILS.size + parsed.size}`);
  return parsed;
})();

/**
 * Returns true if the given email is an allowlisted admin.
 * Checks hardcoded list first, then env-var list.
 * Input is normalized (trim + toLowerCase) before comparison.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return HARDCODED_ADMIN_EMAILS.has(normalized) || ENV_ADMIN_EMAILS.has(normalized);
}

/** True only for the authenticated business owner, never an added admin. */
export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return OWNER_EMAILS.has(email.trim().toLowerCase());
}

/** Synthetic subscription object returned for admin users. */
export const ADMIN_SUBSCRIPTION = {
  status:      'lifetime' as const,
  plan:        'lifetime' as const,
  is_admin:    true,
} as const;

/** Synthetic license object returned for admin users. */
export const ADMIN_LICENSE = {
  id:          'admin',
  license_key: 'ADMIN',
  status:      'active' as const,
  plan:        'lifetime' as const,
  max_devices: 999,
  created_at:  null,
} as const;
