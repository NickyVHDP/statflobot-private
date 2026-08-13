import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/supabase/server';
import { normalizeReferralCode, validateReferralCode } from '@/lib/referrals';

/**
 * POST /api/referrals/validate
 *
 * Pre-checkout convenience check so a buyer gets fast feedback instead of
 * discovering a bad code at the payment step. NOT authoritative — the binding
 * validation runs again inside POST /api/checkout/lifetime.
 *
 * RESPONSE IS DELIBERATELY GENERIC. Codes are guessable-length secrets, so the
 * response never distinguishes "no such code" from "code exists but you are not
 * eligible", and never reveals anything about the referrer. Distinguishing them
 * would turn this endpoint into a code-enumeration oracle.
 *
 * The only exceptions are the two states the BUYER can act on — using their own
 * code, and not being a first-time buyer — where a generic message would leave
 * them stuck with no idea what to change.
 */

// ── Rate limiting ────────────────────────────────────────────────────────────
// In-memory fixed window, per IP. Deliberately simple: this is a speed bump
// against casual enumeration, not a distributed rate limiter. Serverless
// instances each keep their own counter, so treat the effective limit as
// approximate; the real protection is the generic response above.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;

  // Opportunistic cleanup so the map cannot grow without bound on a warm instance.
  if (hits.size > 5_000) {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }

  return entry.count > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';

  if (rateLimited(ip)) {
    console.warn('[REFERRAL_VALIDATE_RATE_LIMITED]');
    return NextResponse.json(
      { valid: false, message: 'Too many attempts. Please wait a moment and try again.' },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const raw = typeof body?.referralCode === 'string' ? body.referralCode : '';
  if (!raw.trim()) {
    return NextResponse.json({ valid: false, message: 'Enter a referral code.' }, { status: 400 });
  }

  const user = await getAuthUser(req);
  const result = await validateReferralCode(raw, {
    userId: user?.id ?? null,
    email:  user?.email ?? null,
  });

  console.log(`[REFERRAL_VALIDATE] normalized=${normalizeReferralCode(raw)} valid=${result.valid} reason=${result.reason ?? 'ok'}`);

  if (result.valid) {
    return NextResponse.json({ valid: true, message: 'Referral code applied.' });
  }

  const message =
    result.reason === 'self-referral'
      ? 'You cannot use your own referral code.'
      : result.reason === 'not-new-user'
        ? 'Referral codes apply to first-time purchases only.'
        : "That code isn't valid.";

  return NextResponse.json({ valid: false, message });
}
