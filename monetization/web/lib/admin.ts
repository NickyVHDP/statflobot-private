/**
 * lib/admin.ts
 *
 * Admin bypass helpers.
 *
 * Set ADMIN_EMAILS as a comma-separated list in the server environment:
 *   ADMIN_EMAILS=you@example.com,partner@example.com
 *
 * Any email in that list is treated as having an active lifetime subscription
 * and a valid license, bypassing all subscription/license gates.
 */

const ADMIN_EMAILS: Set<string> = (() => {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
})();

/** Returns true if the given email belongs to an admin. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase());
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
