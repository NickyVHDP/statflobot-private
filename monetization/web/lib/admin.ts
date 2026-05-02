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

// ── Env-var admin list — add extra admins without redeploying code ────────────
const ENV_ADMIN_EMAILS: Set<string> = (() => {
  const raw = process.env.ADMIN_EMAILS ?? '';
  const parsed = new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  if (parsed.size === 0) {
    console.warn('[admin] ADMIN_EMAILS env var not set — relying on hardcoded fallback only');
  }
  // Always log what was loaded so Vercel logs make it obvious what the gate sees.
  const allAdmins = Array.from(HARDCODED_ADMIN_EMAILS).concat(Array.from(parsed));
  console.log(`[ADMIN_EMAILS_LOADED] count=${allAdmins.length} values=${allAdmins.join(',')}`);
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
