import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Verify an emailed verification code without making the user care which kind it is.
 *
 * Supabase types the same digits differently depending on which template sent
 * them: 'signup' for a Confirm-signup email, 'email'/'magiclink' for a sign-in
 * code. Users cannot tell these apart, so we try the plausible types in order
 * and return the first success.
 *
 * Verification attempts do not send email, so this costs no send quota.
 */
const CODE_TYPES = ['email', 'signup', 'magiclink'] as const;

export async function verifyEmailCode(
  supabase: SupabaseClient,
  email: string,
  token: string,
) {
  let lastError: any = null;

  for (const type of CODE_TYPES) {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: type as any });
    if (!error && data?.session) return { data, error: null };
    lastError = error;

    // A wrong/expired code fails the same way for every type — stop early
    // rather than retrying three times on a genuinely bad code.
    const msg = (error?.message ?? '').toLowerCase();
    if (msg.includes('expired')) break;
  }

  return { data: null, error: lastError };
}
