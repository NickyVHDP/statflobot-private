/**
 * Human-readable messages for Supabase Auth errors.
 *
 * Supabase surfaces rate limiting as an opaque "email rate limit exceeded" or a
 * "for security purposes..." string. Users read those as a bug and retry, which
 * burns the remaining quota — so they get an explicit wait instruction instead.
 */

export type AuthErrorLike = { message?: string; code?: string; status?: number } | null | undefined;

export const RATE_LIMIT_MESSAGE =
  'Too many verification emails were requested. Please wait about an hour before trying again.';

/** True when the error is Supabase throttling email sends. */
export function isEmailRateLimit(err: AuthErrorLike): boolean {
  if (!err) return false;
  const code = (err.code ?? '').toLowerCase();
  const msg  = (err.message ?? '').toLowerCase();
  return (
    err.status === 429 ||
    code.includes('over_email_send_rate_limit') ||
    code.includes('over_request_rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('for security purposes, you can only request this after')
  );
}

/** Seconds Supabase asks the caller to wait, when it tells us. */
export function retryAfterSeconds(err: AuthErrorLike): number | null {
  const m = (err?.message ?? '').match(/after (\d+) seconds?/i);
  return m ? parseInt(m[1], 10) : null;
}

export function friendlyAuthError(err: AuthErrorLike): string {
  if (!err) return 'Something went wrong. Please try again.';

  if (isEmailRateLimit(err)) {
    const wait = retryAfterSeconds(err);
    // Short cooldowns are Supabase's per-request spacing, not the hourly cap.
    if (wait && wait < 300) return `Please wait ${wait} seconds before requesting another email.`;
    return RATE_LIMIT_MESSAGE;
  }

  const msg = (err.message ?? '').toLowerCase();

  if (msg.includes('invalid login credentials')) {
    return 'That email or password is incorrect.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Your email is not verified yet. Check your inbox for the verification link or code.';
  }
  if (msg.includes('user already registered') || msg.includes('already been registered')) {
    return 'An account with this email already exists. Try signing in instead.';
  }
  if (msg.includes('token has expired') || msg.includes('invalid or has expired')) {
    return 'That link or code has expired. Request a new one below.';
  }
  if (msg.includes('invalid token') || msg.includes('token not found')) {
    return 'That code is not valid. Check the digits and try again.';
  }
  if (msg.includes('password should be at least')) {
    return 'Please choose a password of at least 8 characters.';
  }

  return err.message ?? 'Something went wrong. Please try again.';
}

/**
 * Constrain a ?next= value to a same-site relative path.
 *
 * /auth/callback redirects to this after a successful exchange, so an
 * unvalidated value would let a crafted link bounce a freshly authenticated
 * user to an attacker's site.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw) return fallback;
  // Reject absolute URLs, protocol-relative URLs, and backslash tricks.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (/^\/+[\\/]/.test(raw)) return fallback;
  return raw;
}

/** Messages for the ?authError= values set by /auth/callback. */
export const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  link_expired:
    'That verification link has expired or was already used. Request a new one, or use the verification code from the email instead.',
  link_invalid:
    'That verification link is not valid. Request a new one, or use the verification code from the email instead.',
};
