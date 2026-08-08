import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { safeNextPath } from '@/lib/authErrors';

/**
 * GET /auth/callback
 *
 * Completes email confirmation, magic-link sign-in, and password recovery.
 *
 * This route did not exist, which is why verification links appeared to do
 * nothing: `@supabase/ssr` uses the PKCE flow, so Supabase redirects here with
 * `?code=…` that must be exchanged for a session. With no handler, the code was
 * dropped and the user was never signed in.
 *
 * Handles three link shapes:
 *   ?code=…                  PKCE (web sign-up / reset via @supabase/ssr)
 *   ?token_hash=…&type=…     email OTP links ({{ .TokenHash }} templates)
 *   #access_token=…          implicit flow (desktop supabase-js) — the fragment
 *                            is never sent to the server, but Supabase has
 *                            already confirmed the account by this point, so we
 *                            land the user on a friendly "verified" page.
 *
 * Never dead-ends: every failure path redirects to sign-in with a readable
 * reason rather than leaving a blank screen.
 */

export const dynamic = 'force-dynamic';

function failure(origin: string, reason: string, detail?: string | null) {
  const url = new URL('/auth/sign-in', origin);
  url.searchParams.set('authError', reason);
  if (detail) url.searchParams.set('detail', detail.slice(0, 200));
  console.warn(`[AUTH_CALLBACK_FAILED] reason=${reason} detail=${detail ?? 'none'}`);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);

  const code        = searchParams.get('code');
  const tokenHash   = searchParams.get('token_hash');
  const type        = searchParams.get('type');
  const next        = safeNextPath(searchParams.get('next'));
  // Supabase sends BOTH `error=access_denied` and `error_code=otp_expired` for a
  // spent link. Reading them with ?? short-circuited on the generic `error` and
  // never saw `otp_expired`, so expired links were reported as merely invalid.
  // Inspect all three fields.
  const errorParam  = searchParams.get('error');
  const errorCode   = searchParams.get('error_code');
  const errorDesc   = searchParams.get('error_description');
  const anyError    = errorParam || errorCode || errorDesc;

  if (anyError) {
    const haystack = `${errorParam ?? ''} ${errorCode ?? ''} ${errorDesc ?? ''}`;
    const reason = /expired|otp_expired|already/i.test(haystack) ? 'link_expired' : 'link_invalid';
    return failure(origin, reason, errorDesc ?? errorCode ?? errorParam);
  }

  const supabase = createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn(`[AUTH_CALLBACK_EXCHANGE_FAILED] ${error.message}`);
      return failure(origin, 'link_expired', error.message);
    }
    console.log(`[AUTH_CALLBACK_SUCCESS] method=pkce next=${next}`);
    return NextResponse.redirect(new URL(next, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as any,
    });
    if (error) {
      console.warn(`[AUTH_CALLBACK_VERIFY_FAILED] ${error.message}`);
      return failure(origin, 'link_expired', error.message);
    }
    console.log(`[AUTH_CALLBACK_SUCCESS] method=token_hash type=${type} next=${next}`);
    return NextResponse.redirect(new URL(next, origin));
  }

  // No server-readable credential. This is the implicit-flow case used by the
  // desktop app: Supabase already confirmed the account before redirecting, and
  // the tokens live in the URL fragment. Send them somewhere that explains what
  // to do next instead of failing.
  console.log('[AUTH_CALLBACK_NO_CODE] no code/token_hash — treating as implicit-flow confirmation');
  return NextResponse.redirect(new URL('/auth/verified', origin));
}
