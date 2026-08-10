/**
 * Human-readable messages for Supabase Auth errors (desktop client).
 *
 * Mirrors monetization/web/lib/authErrors.ts — keep the two in sync.
 *
 * Supabase reports throttling as an opaque "email rate limit exceeded", which
 * users read as a bug and retry, burning the remaining hourly quota. They get
 * an explicit wait instruction instead.
 */

export const RATE_LIMIT_MESSAGE =
  'Too many verification emails were requested. Please wait about an hour before trying again.';

export function isEmailRateLimit(err) {
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

export function retryAfterSeconds(err) {
  const m = (err?.message ?? '').match(/after (\d+) seconds?/i);
  return m ? parseInt(m[1], 10) : null;
}

export function friendlyAuthError(err) {
  if (!err) return 'Something went wrong. Please try again.';

  if (isEmailRateLimit(err)) {
    const wait = retryAfterSeconds(err);
    if (wait && wait < 300) return `Please wait ${wait} seconds before requesting another email.`;
    return RATE_LIMIT_MESSAGE;
  }

  const msg = (err.message ?? '').toLowerCase();

  if (msg.includes('invalid login credentials')) return 'That email or password is incorrect.';
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
 * Verify an emailed verification code without making the user identify its type.
 *
 * Supabase types the same digits as 'signup' (Confirm-signup email) or
 * 'email'/'magiclink' (sign-in code). Try each; verification sends no email,
 * so this costs no quota.
 */
export async function verifyEmailCode(supabase, email, token) {
  let lastError = null;
  for (const type of ['email', 'signup', 'magiclink']) {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type });
    if (!error && data?.session) return { data, error: null };
    lastError = error;
    if ((error?.message ?? '').toLowerCase().includes('expired')) break;
  }
  return { data: null, error: lastError };
}
