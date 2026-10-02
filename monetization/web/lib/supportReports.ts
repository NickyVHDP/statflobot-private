/**
 * lib/supportReports.ts
 *
 * Shared, server-only helpers for the support report lifecycle.
 *
 * Never import this from a Client Component: it decides what a customer is
 * allowed to see, and the projection below is the single place that decision is
 * made. Every route selects CUSTOMER_NOTICE_COLUMNS (or the admin projection)
 * explicitly — `select('*')` would leak internal provider errors and the
 * resolving admin's identity into a customer response the first time a column
 * is added.
 */

import { randomBytes } from 'crypto';

/** Crockford Base32 — no I, L, O, U, so a reference can be read down a phone. */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_CHARS = 16; // 16 × 5 bits = 80 bits of randomness

export const REPORT_REFERENCE_PREFIX = 'SR-';
export const REPORT_REFERENCE_RE = /^SR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/**
 * Customer-facing report reference.
 *
 * This is an identifier, never a capability: every route that accepts one still
 * requires a verified session and still filters on `user_id`, so knowing a
 * reference grants nothing. The 80 bits exist for collision resistance, not
 * secrecy.
 */
export function generateReportReference(): string {
  const bytes = randomBytes(REFERENCE_CHARS);
  let out = '';
  for (let i = 0; i < REFERENCE_CHARS; i++) {
    out += BASE32_ALPHABET[bytes[i] % 32];
  }
  return REPORT_REFERENCE_PREFIX + out;
}

export function isValidReportReference(value: unknown): boolean {
  return typeof value === 'string' && REPORT_REFERENCE_RE.test(value.trim());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Defense-in-depth redaction for owner-visible support diagnostics.
 *
 * Run history is already sanitized by the desktop reporter, but historical
 * versions used narrower name patterns. Apply the same protection again at the
 * cloud boundary so the on-demand owner endpoint cannot surface customer
 * names, contact data, account ids, filesystem paths, or credential material.
 */
export function sanitizeSupportDiagnosticText(value: unknown): string {
  const sensitive = /\b(cookie|bearer|password|secret|api[_\s-]?key|access_?token|refresh_?token|supabase.*key)\b/i;
  const contentMarker = /\b(DEBUG_VISIBLE_TEXT|DEBUG_COMPOSER_STATE|DEBUG_CLICKABLE_SMS_LINES)\b/i;
  return String(value ?? '')
    .split('\n')
    .filter((line) => !sensitive.test(line) && !contentMarker.test(line))
    .map((line) => line
      .replace(/\bclient=(['"])[\s\S]*?\1/gi, 'client="[REDACTED]"')
      .replace(/\bclient=[^\s].*?\s+key=\S+/gi, 'client=[REDACTED] key=[REDACTED]')
      .replace(/\bname=(['"])[\s\S]*?\1/gi, 'name="[REDACTED]"')
      .replace(/\bctx=client-.*?-line\d+\b/gi, 'ctx=client-[REDACTED]-line')
      .replace(/(Opening client:\s*)[^\n]+/gi, '$1[REDACTED]')
      .replace(/(\[[A-Z]+\]\s+)[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)+:/g, '$1[REDACTED]:')
      .replace(/([?&]client=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[REDACTED_PHONE]')
      .replace(/(?<!\d)(?:\+?1)?\d{10}(?!\d)/g, '[REDACTED_PHONE]')
      .replace(/(?:\/[^\s"'\\]+){3,}\/([^/\s"'\\]+)/g, '[.../$1]')
      .replace(/(?:[A-Z]:\\[^\s"'\\]+\\){2,}([^\\\s"']+)/g, '[...\\$1]'))
    .join('\n')
    .slice(-250_000);
}

// ── Versions ────────────────────────────────────────────────────────────────

const VERSION_RE = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/;

export function isValidVersion(value: unknown): boolean {
  return typeof value === 'string' && VERSION_RE.test(value.trim());
}

export function normalizeVersion(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || !VERSION_RE.test(raw)) return null;
  return raw.replace(/^v/i, '');
}

/**
 * Compare two dotted versions. Returns -1, 0 or 1.
 *
 * Missing segments count as 0 so `1.5` === `1.5.0`, and a pre-release suffix
 * sorts below the same release version (`1.6.0-beta.1` < `1.6.0`). Returns null
 * when either side is not a recognisable version, so callers must decide what
 * an unknown version means rather than getting a silent `0`.
 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (left === null || right === null) return null;

  const [leftCore, leftPre] = left.split('-', 2);
  const [rightCore, rightPre] = right.split('-', 2);
  const leftParts = leftCore.split('.').map(Number);
  const rightParts = rightCore.split('.').map(Number);

  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }

  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  if (leftPre && rightPre && leftPre !== rightPre) return leftPre > rightPre ? 1 : -1;
  return 0;
}

const PUBLIC_VERSION_CACHE_MS = 5 * 60 * 1000;
const UPDATE_FEEDS = [
  'https://github.com/NickyVHDP/statflobot-private/releases/latest/download/latest.yml',
  'https://github.com/NickyVHDP/statflobot-private/releases/latest/download/latest-mac.yml',
] as const;

let publicVersionCache: { value: string | null; expiresAt: number } | null = null;

async function readUpdaterFeedVersion(url: string): Promise<string | null> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'text/yaml, text/plain;q=0.9' },
    next: { revalidate: 300 },
  });
  if (!response.ok) return null;
  const text = (await response.text()).slice(0, 20_000);
  return normalizeVersion(text.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]);
}

/**
 * The newest version that is actually downloadable by customers.
 *
 * The release workflow publishes Windows and both Mac update feeds only after
 * every signed artifact passes its guards. Reading those two public feeds is
 * therefore stronger (and much less error-prone) than asking the owner to keep
 * PUBLIC_APP_VERSION in sync by hand. Both feeds must agree. The environment
 * value remains a fail-safe only when GitHub is temporarily unavailable.
 */
export async function getPublicAppVersion(): Promise<string | null> {
  if (publicVersionCache && publicVersionCache.expiresAt > Date.now()) {
    return publicVersionCache.value;
  }

  let value: string | null = null;
  try {
    const [windowsVersion, macVersion] = await Promise.all(UPDATE_FEEDS.map(readUpdaterFeedVersion));
    if (windowsVersion && macVersion && compareVersions(windowsVersion, macVersion) === 0) {
      value = windowsVersion;
    } else {
      console.warn(`[PUBLIC_APP_VERSION_FEEDS_MISMATCH] windows=${windowsVersion ?? 'missing'} mac=${macVersion ?? 'missing'}`);
    }
  } catch (error) {
    console.warn(`[PUBLIC_APP_VERSION_FEEDS_UNAVAILABLE] ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  value ??= normalizeVersion(process.env.PUBLIC_APP_VERSION);
  publicVersionCache = { value, expiresAt: Date.now() + PUBLIC_VERSION_CACHE_MS };
  return value;
}

export type FixDelivery =
  | 'no-fix-version'   // resolved without tying it to a release
  | 'pending-release'  // fix exists but is not public yet — never prompt to update
  | 'update-available' // published, and this install is older
  | 'already-current'; // published, and this install already has it

/**
 * Decide what the customer should be told about a resolved report.
 *
 * `installedVersion` only affects which button this user sees on their own
 * notice, so an unverifiable client value is acceptable here; the publish gate
 * that could mislead them is derived server-side.
 */
export function deriveFixDelivery(args: {
  fixedInVersion?: unknown;
  publicVersion?: unknown;
  installedVersion?: unknown;
}): FixDelivery {
  const fixed = normalizeVersion(args.fixedInVersion);
  if (!fixed) return 'no-fix-version';

  const publicVersion = normalizeVersion(args.publicVersion);
  // Unknown public version fails safe: assume the fix has not shipped.
  if (!publicVersion) return 'pending-release';
  const published = compareVersions(publicVersion, fixed);
  if (published === null || published < 0) return 'pending-release';

  const installed = normalizeVersion(args.installedVersion);
  if (!installed) return 'already-current';
  const behind = compareVersions(installed, fixed);
  if (behind === null) return 'already-current';
  return behind < 0 ? 'update-available' : 'already-current';
}

// ── Projections ─────────────────────────────────────────────────────────────

/**
 * Everything a customer may see about their own report.
 *
 * Excluded on purpose: description/contact echoes are fine but provider ids,
 * provider errors, the resolving admin, bot_run_id and log_reference are not —
 * they are internal handling detail and, in the case of the run/log fields, a
 * pointer at diagnostics customers are never given.
 */
export const CUSTOMER_NOTICE_COLUMNS =
  'reference, status, subject, created_at, resolved_at, fixed_in_version, resolution_message, acknowledged_at';

export const ADMIN_REPORT_COLUMNS =
  'id, reference, user_id, bot_run_id, status, subject, description, contact_email, app_version, platform, ' +
  'run_status, log_attached, log_reference, log_unavailable_reason, support_email_status, support_email_error, ' +
  'support_email_sent_at, resolution_message, fixed_in_version, resolved_at, resolved_by_email, ' +
  'resolution_email_status, resolution_email_error, resolution_email_attempted_at, resolution_email_sent_at, ' +
  'resolution_email_provider_id, resolution_email_attempts, ' +
  'acknowledged_at, created_at, updated_at';

/**
 * What the desktop Owner Command Center needs to triage and resolve a report.
 *
 * Deliberately narrower than ADMIN_REPORT_COLUMNS: the desktop app renders on
 * an owner's laptop rather than the hardened web admin, so it never receives
 * the reporter's `user_id`/`contact_email`, the `bot_run_id`/`log_reference`
 * pointers into diagnostics, provider ids, or raw provider error strings. It
 * keeps the delivery *statuses*, because "email failed" is exactly the signal
 * the attention summary is built from. The full projection stays available to
 * the web admin, which is the only place a report is investigated in depth.
 */
export const DESKTOP_REPORT_COLUMNS =
  'id, reference, status, subject, description, app_version, platform, run_status, ' +
  'log_attached, support_email_status, support_email_sent_at, ' +
  'resolution_message, fixed_in_version, resolved_at, resolution_email_status, ' +
  'created_at, updated_at';

export type CustomerNoticeRow = {
  reference: string;
  status: string;
  subject: string | null;
  created_at: string;
  resolved_at: string | null;
  fixed_in_version: string | null;
  resolution_message: string | null;
  acknowledged_at: string | null;
};

/** Shape a stored row into the payload the desktop app renders. */
export function toCustomerNotice(
  row: CustomerNoticeRow,
  installedVersion?: unknown,
  publicVersion?: unknown,
) {
  const fixDelivery = row.status === 'resolved'
    ? deriveFixDelivery({ fixedInVersion: row.fixed_in_version, publicVersion, installedVersion })
    : 'no-fix-version';

  return {
    reference: row.reference,
    status: row.status,
    subject: row.subject,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolutionMessage: row.resolution_message,
    // Only surfaced once the build is actually downloadable, so the desktop app
    // cannot render "update to v1.6.0" for a version nobody can install.
    fixedInVersion: fixDelivery === 'pending-release' ? null : row.fixed_in_version,
    fixDelivery,
    acknowledgedAt: row.acknowledged_at,
  };
}

// ── Field limits ────────────────────────────────────────────────────────────

export const MAX_RESOLUTION_MESSAGE_CHARS = 1000;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 5000;

export function clampText(value: unknown, max: number): string | null {
  const str = String(value ?? '').trim();
  if (!str) return null;
  return str.slice(0, max);
}

/**
 * Reduce a log pointer to something that cannot leak a customer's filesystem.
 * A full path names the account on the machine; a bare filename does not.
 */
export function safeLogReference(value: unknown): string | null {
  const str = String(value ?? '').trim();
  if (!str) return null;
  const basename = str.split(/[\\/]/).pop() ?? '';
  return basename ? basename.slice(0, 200) : null;
}
